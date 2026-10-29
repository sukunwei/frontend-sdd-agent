import * as path from 'path';
import { interrupt } from '@langchain/langgraph';
import { isApproved, isUnfinishedResult } from '../cli/protocol.js';
import { STAGE_NODE_NAMES } from '../graph/node-names.js';
import {
  hasStageStep,
  readStageReading,
  recordStageReading,
  recordStageStep,
  stageGeneration,
  withNextGeneration,
} from '../graph/state.js';
import type { GraphState, InterruptPayload, NodeOutcome } from '../graph/state.js';
import { ArtifactStore } from '../persistence/artifact-store.js';
import { parseAcIds, parseE2eRows, parseTasks, slugifyTaskId } from '../parsers/ids.js';
import type { E2eRow, ParsedTask } from '../parsers/ids.js';
import { renderWorkOrder } from '../prompts/loader.js';
import { getDocsDir, readDoc } from '../runtime/paths.js';
import type { Complexity, Task, TBCItem } from '../state/types.js';
import { askWorkerQuestion, recordWorkerQuestion, workerFailedTbc } from './stage-gates.js';

/**
 * The task split stage: a host work order writes the tasks, the graph keeps
 * the gate.
 *
 * The worker writes `tasks.md`: a table of tasks and one detail block per
 * task. The graph parses it with the deterministic parser of Task 7 and
 * refuses the plans that would break the workflow:
 *
 * 1. **Complexity.** A task of complexity `L` is too big to be worked in
 *    one TDD round: the work order is issued once more ("split it into S/M
 *    tasks"), and a plan that still has one is reported to the user.
 * 2. **Ids.** Two tasks with the same id, or an id that does not follow
 *    from its title, would break the traceability links: the ids have to be
 *    the stable slugs (`TASK-<slug of the title>`), so that re-splitting the
 *    plan does not renumber the tasks.
 * 3. **Coverage.** An acceptance criterion no task covers is a hole in the
 *    plan, and a task that covers nothing is work nobody asked for. Both are
 *    recorded as **non-blocking** TBCs and marked in the timeline: they are
 *    worth telling the user about, but they do not stop the run.
 *
 * **Why the stage reads the documents in its own execution.** LangGraph
 * re-executes the whole node when the run is resumed, and the worker writes
 * `tasks.md` *between* the execution that parks and the one that resumes it.
 * A node that decided what to ask by reading the file again would take a
 * different branch on the second run - and the answer of the user would be
 * handed to the wrong interrupt. So the stage reads the documents once, puts
 * the reading into the artifacts, and decides from there.
 */

/** The stage this node owns (the name of the stage in the state). */
const STAGE = 'taskSplit';

/**
 * The name of the node.
 *
 * A node routes with `Command({ goto })`, and LangGraph only accepts the
 * name of a node of the graph - not the name of the stage in the state.
 */
const NODE = STAGE_NODE_NAMES.taskSplit;

/** The steps that record the task work orders. */
const STEP_ORDER_1 = 'order-1';
const STEP_ORDER_2 = 'order-2';

/** The step that records that the orphans have been reported. */
const STEP_ORPHANS = 'orphans-reported';

/** The step that holds the question a worker raised. */
const STEP_QUESTION = 'worker-question';

/** The step that records that the user answered the question. */
const STEP_ANSWERED = 'worker-answered';

/**
 * What the task split stage found in the documents.
 *
 * `tasks` holds the tasks that may enter the state - a task of complexity
 * `L` is **not** among them: the state only knows `S` and `M`, and `L` is
 * reported through `hasComplexL`.
 */
export interface TaskSplitExit {
  /** The plan may be worked. */
  ok: boolean;
  /** The tasks of the plan, without the ones of complexity `L`. */
  tasks: Task[];
  /** The plan has a task of complexity `L`. */
  hasComplexL: boolean;
  /** The task ids that appear more than once. */
  duplicateIds: string[];
  /** The acceptance criteria no task covers. */
  orphanAcs: string[];
  /** The tasks that cover no acceptance criterion. */
  orphanTasks: string[];
  /** The tasks whose id does not follow from their title. */
  slugDrift: string[];
  /** The e2e cases that cover no acceptance criterion. */
  orphanTests: string[];
  /** Why the documents could not be read (empty when they could). */
  error?: string;
}

/** The task split node and its exit. */
export interface TaskSplitNode {
  (state: GraphState): Promise<NodeOutcome>;
  /** What the documents of the run say. */
  exit(state: GraphState, docsDir: string): TaskSplitExit;
}

/**
 * The traceability matrix of a plan.
 *
 * The comparison is a **pure id comparison**: an acceptance criterion is
 * covered by the tasks and the test cases that name it. There is no semantic
 * matching - a plan that means the same thing with other words is a plan the
 * worker has to write more carefully.
 */
export interface TraceabilityMatrix {
  /** One row per acceptance criterion. */
  rows: Array<{ acId: string; taskIds: string[]; testIds: string[] }>;
  /** The tasks that cover none of the acceptance criteria. */
  orphanTasks: string[];
  /** The test cases that cover none of the acceptance criteria. */
  orphanTests: string[];
}

/**
 * Build the traceability matrix.
 *
 * @param acIds - The acceptance criteria of the requirement.
 * @param tasks - The tasks of the plan.
 * @param e2e - The test cases of the plan.
 */
export function buildTraceabilityMatrix(
  acIds: string[],
  tasks: Array<{ id: string; acRefs: string[] }>,
  e2e: Array<{ testId: string; acRefs: string[] }>
): TraceabilityMatrix {
  const rows = acIds.map((acId) => ({
    acId,
    taskIds: tasks.filter((task) => task.acRefs.includes(acId)).map((task) => task.id),
    testIds: e2e.filter((test) => test.acRefs.includes(acId)).map((test) => test.testId),
  }));

  return {
    rows,
    orphanTasks: tasks
      .filter((task) => !task.acRefs.some((ref) => acIds.includes(ref)))
      .map((task) => task.id),
    orphanTests: e2e
      .filter((test) => !test.acRefs.some((ref) => acIds.includes(ref)))
      .map((test) => test.testId),
  };
}

/**
 * Read the documents of the run and say whether the plan may be worked.
 *
 * @param _state - The graph state (the plan does not depend on it; the
 *   parameter keeps the shape of the exit the same in every stage).
 * @param docsDir - The requirement documents of the run.
 */
export function taskSplitExit(_state: GraphState, docsDir: string): TaskSplitExit {
  const empty: TaskSplitExit = {
    ok: false,
    tasks: [],
    hasComplexL: false,
    duplicateIds: [],
    orphanAcs: [],
    orphanTasks: [],
    slugDrift: [],
    orphanTests: [],
  };

  let parsed: ParsedTask[];
  let acIds: string[];
  try {
    parsed = parseTasks(readDoc(path.join(docsDir, 'tasks.md')));
    // The spec is read inside the guard as well: a spec that exists but
    // cannot be read is a broken document, not an empty one.
    acIds = parseAcIds(readDoc(path.join(docsDir, 'spec.md')));
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }

  const matrix = buildTraceabilityMatrix(acIds, parsed, readE2eRows(docsDir));
  const hasComplexL = parsed.some((task) => task.complexity === 'L');

  return {
    // An empty plan must never pass the gate. The parser throws for an
    // empty document today, but the gate may not depend on that.
    ok: parsed.length > 0 && !hasComplexL && duplicateIdsOf(parsed).length === 0,
    tasks: parsed.filter(isWorkable).map(toStateTask),
    hasComplexL,
    duplicateIds: duplicateIdsOf(parsed),
    orphanAcs: matrix.rows.filter((row) => row.taskIds.length === 0).map((row) => row.acId),
    orphanTasks: matrix.orphanTasks,
    slugDrift: parsed
      .filter((task) => task.id !== `TASK-${slugifyTaskId(task.title)}`)
      .map((task) => task.id),
    orphanTests: matrix.orphanTests,
  };
}

/**
 * The task split node, with its exit.
 */
export const taskSplitNode: TaskSplitNode = Object.assign(taskSplitNodeImpl, { exit: taskSplitExit });

/** The implementation of the node. */
async function taskSplitNodeImpl(state: GraphState): Promise<NodeOutcome> {
  const docsDir = getDocsDir(state.requirementName, state.repoPath);
  const repoDir = state.repoPath;
  const gen = stageGeneration(state, STAGE);

  // ---- Step 1: the task work order ---------------------------------------
  if (!hasStageStep(state, STAGE, STEP_ORDER_1)) {
    const result = interrupt(taskSplitWorkOrder(docsDir, repoDir));
    const update = withNextGeneration(STAGE, gen, recordStageStep(STAGE, STEP_ORDER_1));
    if (isUnfinishedResult(result)) {
      // The worker did not finish: the reason belongs to the user.
      update.tbcItems = [splitFailedTbc(result)];
    }
    const question = recordWorkerQuestion(result, { stage: STAGE, step: STEP_QUESTION });
    if (question !== undefined) {
      update.stageSteps = { ...(update.stageSteps ?? {}), ...(question.stageSteps ?? {}) };
    }
    return { kind: 'advance', update, goto: NODE };
  }

  // ---- Step 2: the question the worker raised ----------------------------
  const gate = askWorkerQuestion(state, {
    stage: STAGE,
    step: STEP_QUESTION,
    answeredStep: STEP_ANSWERED,
    type: 'worker_needs_human',
    goto: NODE,
    tbcId: 'TBC-TASKS-ANSWER',
  });
  if (gate !== undefined) return gate;

  // ---- Step 2: read the documents -----------------------------------------
  const exit = readStageReading<TaskSplitExit>(state, STAGE, gen);
  if (exit === undefined) {
    return {
      kind: 'advance',
      update: recordStageReading(STAGE, gen, taskSplitExit(state, docsDir)),
      goto: NODE,
    };
  }

  // ---- Step 3: the gates that stop the stage ------------------------------
  if (!exit.ok) {
    if (!hasStageStep(state, STAGE, STEP_ORDER_2)) {
      // One re-issue: the worker gets a second chance, and the order tells
      // it what was wrong.
      const result = interrupt(taskSplitWorkOrder(docsDir, repoDir, noteFor(exit)));
      const update = withNextGeneration(STAGE, gen, recordStageStep(STAGE, STEP_ORDER_2));
      if (isUnfinishedResult(result)) {
        update.tbcItems = [splitFailedTbc(result)];
      }
      // The question of the worker reaches the user, even on the re-issue.
      const question = recordWorkerQuestion(result, { stage: STAGE, step: STEP_QUESTION });
      if (question !== undefined) {
        update.stageSteps = { ...(update.stageSteps ?? {}), ...(question.stageSteps ?? {}) };
      }
      return { kind: 'advance', update, goto: NODE };
    }

    // The user decides: they may split the plan themselves and answer.
    interrupt({
      audience: 'user',
      type: 'task_split_failed',
      reason: reasonFor(exit),
      ...(exit.error ? { message: exit.error } : {}),
    });
    // The documents are read again: the user may have fixed them.
    return {
      kind: 'advance',
      update: withNextGeneration(STAGE, gen, {}),
      goto: NODE,
    };
  }

  // ---- Step 4: the orphans (they do not block) ---------------------------
  if (!hasStageStep(state, STAGE, STEP_ORPHANS)) {
    const store = new ArtifactStore(state.requirementName, state.repoPath);
    const update = recordStageStep(STAGE, STEP_ORPHANS);
    const tbcs = orphanTbcs(exit);
    if (tbcs.length > 0) {
      update.tbcItems = tbcs;
      for (const tbc of tbcs) store.appendTimeline(tbc.description);
    }
    return { kind: 'advance', update, goto: NODE };
  }

  // ---- Step 5: the confirmation -------------------------------------------
  const answer = interrupt({ audience: 'user', type: 'confirm_tasks' });
  if (!isApproved(answer)) {
    // The plan is read again: the user may have changed it.
    return { kind: 'advance', update: withNextGeneration(STAGE, gen, {}), goto: NODE };
  }

  return {
    kind: 'advance',
    update: {
      currentStage: 'tdd',
      tasks: exit.tasks,
      approvals: { taskSplit: new Date().toISOString() },
    },
    goto: STAGE_NODE_NAMES.tdd,
  };
}

/**
 * The task split work order.
 *
 * The worker reads the spec (the acceptance criteria the tasks have to
 * cover) and the e2e plan (the tasks that write the tests), and writes the
 * tasks.
 *
 * @param docsDir - The requirement documents of the run.
 * @param repoDir - The cloned repository (the working directory of the order).
 * @param note - What the last attempt got wrong (the re-issue).
 */
export function taskSplitWorkOrder(
  docsDir: string,
  repoDir: string,
  note?: string
): InterruptPayload {
  const inputs = [path.join(docsDir, 'spec.md'), path.join(docsDir, 'e2e-plan.csv')];
  const outputs = [path.join(docsDir, 'tasks.md')];
  const body = renderWorkOrder('task-splitter', {
    goal: '把 spec 與 e2e 計畫拆成一張張可以在一次 TDD 回合裡做完的 task。',
    cwd: repoDir,
    inputs,
    outputs,
    outputFormat:
      'Markdown：先一個 task 表（Task ID / Title / Complexity / Priority / AC Refs），' +
      '再每個 task 一個明細區塊（Description、Acceptance Criteria、AC Refs、Files）。',
  });
  const prompt = note === undefined ? body : `${body}\n\n## What the last attempt got wrong\n\n${note}\n`;

  return {
    audience: 'host',
    type: 'work_order',
    role: 'task_splitter',
    prompt,
    cwd: repoDir,
    inputs,
    outputs,
    resultSchema: 'none',
  };
}

/** The ids that appear more than once. */
function duplicateIdsOf(tasks: ParsedTask[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) duplicates.add(task.id);
    else seen.add(task.id);
  }
  return [...duplicates];
}

/** May this task enter the state? (the state knows `S` and `M` only) */
function isWorkable(task: ParsedTask): task is ParsedTask & { complexity: Complexity } {
  return task.complexity !== 'L';
}

/** The state shape of a task. */
function toStateTask(task: ParsedTask & { complexity: Complexity }): Task {
  return {
    id: task.id,
    title: task.title,
    ...(task.description !== undefined ? { description: task.description } : {}),
    acceptanceCriteria: task.acceptanceCriteria,
    acRefs: task.acRefs,
    complexity: task.complexity,
    priority: task.priority,
  };
}

/** The TBC that says the task splitter did not finish. */
function splitFailedTbc(result: unknown): TBCItem {
  return workerFailedTbc('TBC-TASKS-ORDER', 'task splitter', result);
}

/** Why the plan was refused. */
function reasonFor(exit: TaskSplitExit): string {
  if (exit.hasComplexL) return 'complexity_L';
  if (exit.duplicateIds.length > 0) return 'duplicate_ids';
  return 'invalid_tasks';
}

/** What the worker has to fix in the re-issue. */
function noteFor(exit: TaskSplitExit): string {
  const notes: string[] = [];
  if (exit.hasComplexL) {
    notes.push(
      'A task of complexity `L` is too big: split it into tasks of complexity S or M (S/M only).'
    );
  }
  if (exit.duplicateIds.length > 0) {
    notes.push(
      `The task id(s) ${exit.duplicateIds.join(', ')} appear more than once: every task needs its own id.`
    );
  }
  if (exit.slugDrift.length > 0) {
    notes.push(
      `The id(s) ${exit.slugDrift.join(', ')} do not follow from their title: the id of a task is \`TASK-\` plus the slug of its title.`
    );
  }
  if (exit.error !== undefined) {
    notes.push(`The tasks could not be read: ${exit.error}`);
  }
  return notes.join('\n');
}

/**
 * The TBCs of the holes in the plan.
 *
 * They are not blocking: the plan is worth telling the user about, but a
 * missing link in the traceability is not a reason to stop the run.
 */
function orphanTbcs(exit: TaskSplitExit): TBCItem[] {
  const createdAt = new Date().toISOString();
  const tbcs: TBCItem[] = [];

  if (exit.orphanAcs.length > 0) {
    tbcs.push({
      id: 'TBC-ORPHAN-AC',
      description: `task split: no task covers the acceptance criteria ${exit.orphanAcs.join(', ')}`,
      blocking: false,
      resolved: false,
      createdAt,
    });
  }
  if (exit.orphanTasks.length > 0) {
    tbcs.push({
      id: 'TBC-ORPHAN-TASK',
      description: `task split: the task(s) ${exit.orphanTasks.join(', ')} cover no acceptance criterion`,
      blocking: false,
      resolved: false,
      createdAt,
    });
  }
  if (exit.orphanTests.length > 0) {
    tbcs.push({
      id: 'TBC-ORPHAN-TEST',
      description: `task split: the e2e case(s) ${exit.orphanTests.join(', ')} cover no acceptance criterion`,
      blocking: false,
      resolved: false,
      createdAt,
    });
  }
  if (exit.slugDrift.length > 0) {
    tbcs.push({
      id: 'TBC-SLUG-DRIFT',
      description: `task split: the id(s) ${exit.slugDrift.join(', ')} do not follow from their title`,
      blocking: false,
      resolved: false,
      createdAt,
    });
  }

  return tbcs;
}

/** Read the e2e plan of a run. */
function readE2eRows(docsDir: string): E2eRow[] {
  try {
    return parseE2eRows(readDoc(path.join(docsDir, 'e2e-plan.csv')));
  } catch {
    return [];
  }
}
