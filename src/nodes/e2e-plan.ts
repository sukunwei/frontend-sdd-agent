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
import { parseE2eIds } from '../parsers/ids.js';
import { renderWorkOrder } from '../prompts/loader.js';
import { getDocsDir, readDoc } from '../runtime/paths.js';
import type { TBCItem } from '../state/types.js';
import { askWorkerQuestion, recordWorkerQuestion, workerFailedTbc } from './stage-gates.js';

/**
 * The e2e plan stage: a host work order writes the plan, the graph checks it.
 *
 * The worker writes `e2e-plan.csv` - one row per scenario, each row naming
 * the acceptance criteria it covers. The graph parses the plan with the
 * deterministic parser of Task 7 and asks the user when the plan is not
 * usable: a plan without a single test case is a plan that cannot be run.
 *
 * **Why the stage reads the plan in its own execution.** LangGraph
 * re-executes the whole node when the run is resumed, and the worker writes
 * the plan *between* the execution that parks and the one that resumes it. A
 * node that decided what to ask by reading the plan again would take a
 * different branch on the second run - and the answer of the user would be
 * handed to the wrong interrupt. So the stage reads the plan once, puts the
 * reading into the ledger, and decides from there.
 */

/** The stage this node owns (the name of the stage in the state). */
const STAGE = 'e2ePlan';

/**
 * The name of the node.
 *
 * A node routes with `Command({ goto })`, and LangGraph only accepts the
 * name of a node of the graph - not the name of the stage in the state.
 */
const NODE = STAGE_NODE_NAMES.e2ePlan;

/** The steps that record the e2e work orders. */
const STEP_ORDER_1 = 'order-1';
const STEP_ORDER_2 = 'order-2';

/** The step that holds the question a worker raised. */
const STEP_QUESTION = 'worker-question';

/** The step that records that the user answered the question. */
const STEP_ANSWERED = 'worker-answered';

/**
 * What the e2e stage found in the plan.
 */
export interface E2eExit {
  /** The plan has test cases. */
  ok: boolean;
  /** The test ids of the plan, in document order. */
  testIds: string[];
  /** Why the plan could not be read (empty when it could). */
  error?: string;
}

/** The e2e node and its exit. */
export interface E2eNode {
  (state: GraphState): Promise<NodeOutcome>;
  /** What the plan of the run says. */
  exit(state: GraphState, docsDir: string): E2eExit;
}

/**
 * Read the plan of the run.
 *
 * A plan that cannot be parsed is not a crash: the stage re-issues the work
 * order, and the user is told what was wrong.
 *
 * @param _state - The graph state (the plan does not depend on it; the
 *   parameter keeps the shape of the exit the same in every stage).
 * @param docsDir - The requirement documents of the run.
 */
export function e2eExit(_state: GraphState, docsDir: string): E2eExit {
  try {
    const testIds = parseE2eIds(readDoc(path.join(docsDir, 'e2e-plan.csv')));
    return { ok: testIds.length > 0, testIds };
  } catch (err) {
    return { ok: false, testIds: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The e2e node, with its exit.
 */
export const e2eNode: E2eNode = Object.assign(e2eNodeImpl, { exit: e2eExit });

/** The implementation of the node. */
async function e2eNodeImpl(state: GraphState): Promise<NodeOutcome> {
  const docsDir = getDocsDir(state.requirementName, state.repoPath);
  const repoDir = state.repoPath;
  const gen = stageGeneration(state, STAGE);

  // ---- Step 1: the e2e work order ---------------------------------------
  if (!hasStageStep(state, STAGE, STEP_ORDER_1)) {
    const result = interrupt(e2eWorkOrder(docsDir, repoDir));
    const update = withNextGeneration(STAGE, gen, recordStageStep(STAGE, STEP_ORDER_1));
    if (isUnfinishedResult(result)) {
      // The worker did not finish: the reason belongs to the user.
      update.tbcItems = [e2eFailedTbc(result)];
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
    tbcId: 'TBC-E2E-ANSWER',
  });
  if (gate !== undefined) return gate;

  // ---- Step 3: read the plan ---------------------------------------------
  const exit = readStageReading<E2eExit>(state, STAGE, gen);
  if (exit === undefined) {
    return {
      kind: 'advance',
      update: recordStageReading(STAGE, gen, e2eExit(state, docsDir)),
      goto: NODE,
    };
  }

  // ---- Step 4: a plan without test cases ---------------------------------
  if (!exit.ok) {
    if (!hasStageStep(state, STAGE, STEP_ORDER_2)) {
      // One re-issue: the worker gets a second chance before the user is
      // asked.
      const result = interrupt(e2eWorkOrder(docsDir, repoDir));
      const update = withNextGeneration(STAGE, gen, recordStageStep(STAGE, STEP_ORDER_2));
      if (isUnfinishedResult(result)) {
        update.tbcItems = [e2eFailedTbc(result)];
      }
      // The question of the worker reaches the user, even on the re-issue.
      const question = recordWorkerQuestion(result, { stage: STAGE, step: STEP_QUESTION });
      if (question !== undefined) {
        update.stageSteps = { ...(update.stageSteps ?? {}), ...(question.stageSteps ?? {}) };
      }
      return { kind: 'advance', update, goto: NODE };
    }

    // The user decides: they may fix the plan themselves and answer.
    interrupt({
      audience: 'user',
      type: 'e2e_plan_failed',
      reason: 'no_test_ids',
      ...(exit.error ? { message: exit.error } : {}),
    });
    // The plan is read again: the user may have fixed it.
    return { kind: 'advance', update: withNextGeneration(STAGE, gen, {}), goto: NODE };
  }

  // ---- Step 5: the confirmation -------------------------------------------
  const answer = interrupt({ audience: 'user', type: 'confirm_e2e' });
  if (!isApproved(answer)) {
    // The plan is read again: the user may have changed it.
    return { kind: 'advance', update: withNextGeneration(STAGE, gen, {}), goto: NODE };
  }

  return {
    kind: 'advance',
    update: {
      currentStage: 'taskSplit',
      approvals: { e2ePlan: new Date().toISOString() },
    },
    goto: STAGE_NODE_NAMES.taskSplit,
  };
}

/**
 * The e2e work order.
 *
 * The worker reads the spec (it holds the acceptance criteria the scenarios
 * have to cover) and writes the plan.
 */
export function e2eWorkOrder(docsDir: string, repoDir: string): InterruptPayload {
  const inputs = [path.join(docsDir, 'spec.md')];
  const outputs = [path.join(docsDir, 'e2e-plan.csv')];

  return {
    audience: 'host',
    type: 'work_order',
    role: 'e2e_planner',
    prompt: renderWorkOrder('e2e-planner', {
      goal: '把 spec 的驗收條件寫成一份可執行的 E2E 測試計畫。',
      cwd: repoDir,
      inputs,
      outputs,
      outputFormat:
        'CSV：第一行表頭固定為 `test_id,feature,scenario,steps,expected_result,priority`，' +
        '`test_id` 從 `E2E-001` 起算、`scenario` 要標出涵蓋的 `AC-xxx`。',
    }),
    cwd: repoDir,
    inputs,
    outputs,
    resultSchema: 'none',
  };
}

/** The TBC that says the e2e worker did not finish. */
function e2eFailedTbc(result: unknown): TBCItem {
  return workerFailedTbc('TBC-E2E-ORDER', 'e2e planner', result);
}
