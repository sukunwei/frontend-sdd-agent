import * as fs from 'fs';
import * as path from 'path';
import { workerQuestion } from '../cli/protocol.js';
import type { WorkerQuestion, WorkOrder } from '../cli/protocol.js';
import type { GraphState } from '../graph/state.js';
import { readStageStep, recordStageStep } from '../graph/state.js';
import { renderWorkOrder } from '../prompts/loader.js';
import { getDocsDir } from '../runtime/paths.js';
import type { ReviewResult, Task } from '../state/types.js';
import { readAnswer } from './answers.js';

/**
 * The developer half of the TDD loop.
 *
 * The graph owns the routing; the developer is a worker of the session: it
 * gets a work order and reports back. This module builds that order and reads
 * the answer - the loop that decides what happens next lives in
 * `src/subgraphs/tdd.ts`.
 *
 * **The order names the files the task is about.** `outputs` is what the
 * CLI checks when the worker reports back (`complete` refuses an order whose
 * outputs are not on disk), so it has to be the very list the task splitter
 * wrote into `tasks.md` - a different list would make the CLI re-issue the
 * order forever.
 *
 * **The list also names the test file.** The developer prompt demands the
 * TDD flow (the test comes first) and tells the worker to write only the
 * paths of `outputs`. Without the test file in that list the two rules
 * contradict each other, and the worker that obeys the scope rule writes an
 * implementation without a single test.
 */

/** The stage the TDD node keeps its ledger in. */
export const TDD_STAGE = 'tdd';

/** The step that holds the question the developer asked. */
export const QUESTION_STEP = 'developer-question';

/** The step that holds the answer of the user to that question. */
export const ANSWER_STEP = 'developer-answer';

/** The step that holds what the developer reported about the task. */
export const REPORT_STEP = 'developer-report';

/** The step that holds why the last attempt did not finish. */
export const FAILURE_STEP = 'developer-failure';

/** A question the developer could not decide on its own. */
export type DeveloperQuestion = WorkerQuestion;

/** What the developer reported back. */
export type DeveloperOutcome =
  /** The task is implemented. */
  | { kind: 'ok'; summary: string; changedFiles: string[] }
  /** The worker did not finish the task. */
  | { kind: 'failed'; summary: string }
  /** The worker hit a decision it is not allowed to make. */
  | { kind: 'needs_human'; question: DeveloperQuestion };

/** What the developer reported about the task it worked. */
export interface DeveloperReport {
  /** The one-line summary of the worker. */
  summary: string;
  /** The files the worker says it wrote. */
  changedFiles: string[];
}

/** The developer half of the TDD node. */
export interface TddNode {
  /** The work order that asks the session to implement a task. */
  developerWorkOrder(state: GraphState, task: Task): WorkOrder;
  /** Read the answer of the developer work order. */
  readDeveloperResult(answer: unknown): DeveloperOutcome;
}

/** The developer half of the TDD node. */
export const tddNode: TddNode = {
  developerWorkOrder,
  readDeveloperResult,
};

/**
 * The scope of a task: the files the worker has to write.
 *
 * The test file is part of it - the TDD flow starts with the test, and the
 * CLI checks that every path of `outputs` is on disk when the worker reports
 * back.
 */
export interface TaskScope {
  /** The absolute paths the worker has to write. */
  outputs: string[];
  /** The absolute path of the test file of the task. */
  testPath: string;
  /** The file list of the task could not be read from `tasks.md`. */
  listMissing: boolean;
}

/**
 * The work order that asks the session to implement a task.
 *
 * `inputs` are the two documents the worker needs to know what to build
 * (`tasks.md` for the task, `spec.md` for the context); `outputs` are the
 * files the task is about - the implementation files **and** the test file.
 *
 * @param state - The graph state (`repoPath`, `requirementName`).
 * @param task - The task to implement.
 */
export function developerWorkOrder(state: GraphState, task: Task): WorkOrder {
  const repoDir = state.repoPath;
  const docsDir = getDocsDir(state.requirementName, repoDir);
  const scope = taskScope(repoDir, docsDir, task);

  return {
    audience: 'host',
    role: 'developer',
    prompt: developerPrompt(state, task, scope),
    cwd: repoDir,
    inputs: [path.join(docsDir, 'tasks.md'), path.join(docsDir, 'spec.md')],
    outputs: scope.outputs,
    resultSchema: 'none',
  };
}

/**
 * The body of the developer work order.
 *
 * The static part is the prompt template; the task itself and whatever the
 * last attempt got wrong are appended - a session that resumes in a different
 * conversation has to be able to work the order from the document alone.
 *
 * @param state - The graph state (`lastReview` and the ledger of the loop).
 * @param task - The task to implement.
 * @param scope - The files the task is about (the outputs of the order).
 */
export function developerPrompt(state: GraphState, task: Task, scope: TaskScope): string {
  const repoDir = state.repoPath;
  const docsDir = getDocsDir(state.requirementName, repoDir);
  const sections: string[] = [
    renderWorkOrder('developer', {
      goal: `實作 task ${task.id}（${task.title}），用嚴格的 TDD 流程：先寫測試，再寫實作，最後整理。`,
      cwd: repoDir,
      inputs: [path.join(docsDir, 'tasks.md'), path.join(docsDir, 'spec.md')],
      outputs: scope.outputs,
      outputFormat:
        '專案慣例的原始碼與測試檔（見 tasks.md 這個 task 的 Files 清單），' +
        '外加下面「Developer Output」的回報格式。',
    }),
  ];
  sections.push(taskSection(task));
  sections.push(scopeSection(scope));

  const review = state.lastReview;
  if (review) {
    sections.push(reviewSection(review));
  }

  const failure = readDeveloperFailure(state);
  if (failure !== undefined) {
    sections.push(`## 上一次為什麼沒有完成\n\n${failure}\n`);
  }

  const answer = readUserAnswer(state);
  if (answer !== undefined) {
    sections.push(`## 使用者的回覆\n\n${answer}\n`);
  }

  return `${sections.join('\n\n')}\n`;
}

/**
 * Read the answer of the developer work order.
 *
 * The three statuses of the worker protocol mean three different things for
 * the loop: the task is done, the worker did not finish, or the worker hit a
 * decision that is not its to make.
 *
 * **A `needs_human` without a question is a failure, not a question.** The
 * graph cannot ask the user something the worker did not write down, so the
 * attempt counts as failed - with the summary the worker did send, so that
 * the next order can say what went wrong.
 *
 * @param answer - The value the work order was completed with.
 */
export function readDeveloperResult(answer: unknown): DeveloperOutcome {
  const status = (answer as { status?: unknown } | undefined)?.status;
  const summary = (answer as { summary?: unknown } | undefined)?.summary;
  const text = typeof summary === 'string' ? summary : '';

  if (status === 'ok') {
    const changed = (answer as { changedFiles?: unknown } | undefined)?.changedFiles;
    return {
      kind: 'ok',
      summary: text,
      changedFiles: Array.isArray(changed)
        ? changed.filter((file): file is string => typeof file === 'string')
        : [],
    };
  }

  if (status === 'needs_human') {
    const question = workerQuestion(answer);
    if (question) {
      return { kind: 'needs_human', question };
    }
    // The worker says it needs a decision but does not say which one.
    return {
      kind: 'failed',
      summary:
        text !== ''
          ? text
          : 'the worker asked for a decision but did not state the question',
    };
  }

  // The worker did not finish the task: that is a failed attempt too.
  return { kind: 'failed', summary: text };
}

/* ------------------------------------------------------------------ */
/* the question the developer asked                                    */
/* ------------------------------------------------------------------ */

/** The question the developer asked, if it is still open. */
export function readQuestion(state: GraphState): DeveloperQuestion | undefined {
  const raw = readStageStep(state, TDD_STAGE, QUESTION_STEP);
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as DeveloperQuestion;
    if (typeof parsed?.question !== 'string') return undefined;
    return {
      type: typeof parsed.type === 'string' ? parsed.type : 'needs_human',
      question: parsed.question,
      options: Array.isArray(parsed.options) ? parsed.options : [],
    };
  } catch {
    return undefined;
  }
}

/**
 * Record the question the developer asked.
 *
 * The old answer goes with it: an answer to an earlier question must not
 * make the graph believe that this question has been answered too.
 */
export function recordQuestion(question: DeveloperQuestion): Partial<GraphState> {
  return {
    stageSteps: {
      ...recordStageStep(TDD_STAGE, QUESTION_STEP, JSON.stringify(question)).stageSteps,
      ...recordStageStep(TDD_STAGE, ANSWER_STEP, '').stageSteps,
    },
  };
}

/** Close the question and its answer - the developer order is on its way again. */
export function clearQuestion(): Partial<GraphState> {
  return {
    stageSteps: {
      ...recordStageStep(TDD_STAGE, QUESTION_STEP, '').stageSteps,
      ...recordStageStep(TDD_STAGE, ANSWER_STEP, '').stageSteps,
    },
  };
}

/** The answer of the user to the question of the developer. */
export function readUserAnswer(state: GraphState): string | undefined {
  const raw = readStageStep(state, TDD_STAGE, ANSWER_STEP);
  return raw === undefined || raw === '' ? undefined : raw;
}

/**
 * Record the answer of the user to the question of the developer.
 *
 * **The answer is read with the shared reader** (`src/nodes/answers.ts`): the
 * host answers a gate with `{action: ...}` as often as with `{answer: ...}`,
 * and a gate that only understands one of the two throws the answer of the
 * user away - the question is then asked again and again, and the answer is
 * lost.
 *
 * @param answer - The value the question was answered with.
 */
export function recordUserAnswer(answer: unknown): Partial<GraphState> {
  return recordStageStep(TDD_STAGE, ANSWER_STEP, readAnswer(answer).value);
}

/* ------------------------------------------------------------------ */
/* what the developer reported                                         */
/* ------------------------------------------------------------------ */

/** What the developer reported about the task, if it reported anything. */
export function readDeveloperReport(state: GraphState): DeveloperReport | undefined {
  const raw = readStageStep(state, TDD_STAGE, REPORT_STEP);
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as DeveloperReport;
    if (typeof parsed?.summary !== 'string') return undefined;
    const files = Array.isArray(parsed.changedFiles)
      ? parsed.changedFiles.filter((file): file is string => typeof file === 'string')
      : [];
    // An empty report is no report: the ledger is cleared with it.
    if (parsed.summary === '' && files.length === 0) return undefined;
    return {
      summary: parsed.summary,
      changedFiles: Array.isArray(parsed.changedFiles)
        ? parsed.changedFiles.filter((file): file is string => typeof file === 'string')
        : [],
    };
  } catch {
    return undefined;
  }
}

/** Record what the developer reported about the task. */
export function recordDeveloperReport(report: DeveloperReport): Partial<GraphState> {
  return recordStageStep(TDD_STAGE, REPORT_STEP, JSON.stringify(report));
}

/** Why the last attempt did not finish, if it did not finish. */
export function readDeveloperFailure(state: GraphState): string | undefined {
  const raw = readStageStep(state, TDD_STAGE, FAILURE_STEP);
  return raw === undefined || raw === '' ? undefined : raw;
}

/** Record why the last attempt did not finish. */
export function recordDeveloperFailure(summary: string): Partial<GraphState> {
  return recordStageStep(TDD_STAGE, FAILURE_STEP, summary);
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** The task the work order is about. */
export function taskSection(task: Task): string {
  const lines: string[] = [`## 這次要做的 task：${task.id}（${task.title}）`];
  if (task.description) {
    lines.push('', task.description);
  }
  lines.push('', '**Acceptance Criteria**:');
  for (const criterion of task.acceptanceCriteria) {
    lines.push(`- ${criterion}`);
  }
  lines.push('', `**AC Refs**: ${task.acRefs.join(', ')}`);
  lines.push('', `**複雜度**: ${task.complexity}　**優先度**: ${task.priority}`);
  return lines.join('\n');
}

/** What the last review complained about. */
function reviewSection(review: ReviewResult): string {
  const lines: string[] = ['## 上一次評審的結果'];
  lines.push('');
  lines.push(`評審結論：${review.verdict}`);
  if (review.issues.length > 0) {
    lines.push('');
    lines.push('**必須修掉的問題**:');
    for (const issue of review.issues) {
      const where = issue.line === undefined ? issue.file : `${issue.file}:${issue.line}`;
      lines.push(`- [${issue.severity}] ${where} —— ${issue.message}`);
    }
  }
  lines.push('');
  lines.push('這一輪必須把上面每一條都修掉；修不掉就在結果裡回 `status: "needs_human"` 說明。');
  return lines.join('\n');
}

/**
 * The files the task is about.
 *
 * They are read from the `**Files**:` list of the task in `tasks.md` - the
 * same list the worker reads, so that the CLI (which checks the outputs of
 * the order when the worker reports back) and the worker agree on what the
 * task is.
 *
 * **The test file is part of the scope.** The developer prompt demands the
 * TDD flow (the test comes first) and restricts the worker to the paths of
 * `outputs`; the two rules can only be satisfied together when the test file
 * is one of them. A task whose file list already carries a test file keeps
 * that one - the list of `tasks.md` is the truth about the file.
 *
 * @param repoDir - The repository of the run.
 * @param docsDir - The documents of the run.
 * @param task - The task to work.
 */
export function taskScope(repoDir: string, docsDir: string, task: Task): TaskScope {
  const tasksMd = path.join(docsDir, 'tasks.md');
  const listed = taskFiles(tasksMd, task.id);
  const testPath = taskTestPath(task);
  const files = listed.some(isTestPath) ? listed : [...listed, testPath];

  return {
    outputs: files.map((file) => path.resolve(repoDir, file)),
    testPath: path.resolve(repoDir, testPath),
    listMissing: listed.length === 0,
  };
}

/**
 * The test file of a task.
 *
 * The developer prompt puts the unit tests in `src/__tests__`, and the path
 * has to be the same in every session that works the task - so it is derived
 * from the task id, not from the title of the task.
 *
 * @param task - The task to work.
 */
export function taskTestPath(task: Task): string {
  const slug = task.id.replace(/^TASK-/, '');
  return `src/__tests__/${slug}.test.tsx`;
}

/** Is this path a test file? */
function isTestPath(file: string): boolean {
  return /(^|\/)__tests__\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/**
 * The scope of the task, as the worker reads it.
 *
 * The section says which file is the test file (the RED phase writes it
 * first) and says it out loud when the file list of the task could not be
 * read - an order whose scope silently reads "write nothing" would let the
 * worker do nothing at all.
 *
 * @param scope - The scope of the task.
 */
function scopeSection(scope: TaskScope): string {
  const lines = ['## 這個 task 的檔案範圍'];
  lines.push('');
  lines.push(`**測試檔（RED 階段要先寫的那一個）**：\`${scope.testPath}\``);
  lines.push('');
  lines.push('必交輸出（這些路徑都要真的寫出來）：');
  for (const file of scope.outputs) {
    lines.push(`- \`${file}\``);
  }
  if (scope.listMissing) {
    lines.push('');
    lines.push(
      '> ⚠️ 讀不到 `tasks.md` 裡這個 task 的 **Files** 清單 —— 以 `tasks.md` 的內容為準，' +
        '並且一定要寫出上面那個測試檔。'
    );
  }
  return lines.join('\n');
}

/** The files of a task, as `tasks.md` lists them. */
function taskFiles(tasksMdPath: string, taskId: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(tasksMdPath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const heading = /^#{2,6}\s+(TASK-[A-Za-z0-9_-]+)/.exec(line);
    return heading !== null && heading[1] === taskId;
  });
  if (start === -1) return [];

  const files: string[] = [];
  let inFiles = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,6}\s+/.test(line)) break;
    if (/^\*\*Files\*\*\s*:/.test(line)) {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      const file = bullet[1].trim().replace(/`/g, '').trim();
      if (file !== '') files.push(file);
      continue;
    }
    if (line.trim() === '') continue;
    // Another marker ends the list of files.
    if (/^\*\*[^*]+\*\*\s*:/.test(line)) break;
  }

  return files;
}
