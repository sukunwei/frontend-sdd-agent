import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { WorkerResultSchema } from '../cli/protocol.js';
import type { RejectionReason, WorkerResult, WorkOrder } from '../cli/protocol.js';
import type { GraphState } from '../graph/state.js';
import { readStageStep, recordStageStep } from '../graph/state.js';
import { renderWorkOrder } from '../prompts/loader.js';
import { getDocsDir } from '../runtime/paths.js';
import { ReviewResultSchema } from '../state/schema.js';
import type { Task } from '../state/types.js';
import { readAnswer } from './answers.js';
import type { GateAnswer } from './answers.js';
import { readDeveloperReport, taskSection } from './tdd.js';

/**
 * The review of the TDD loop.
 *
 * One reviewer looks at the work of the developer and answers two
 * questions: whether the task was done ("實作了嗎？" - the `spec` verdict)
 * and whether it was done well ("寫得好嗎？" - the `quality` verdict). The
 * correctness and security checklist lives in the quality half.
 *
 * **One work order, two verdicts.** The reviewer used to be two work
 * orders - the spec reviewer and the quality reviewer - and every task paid
 * for three round trips (developer, spec review, quality review). The
 * second round trip bought little: the same reader, the same files, the
 * same diff. Now one order asks both questions, and the two verdicts come
 * back together.
 *
 * **A review is a JSON document, not a sentence.** The worker answers with
 * the `ReviewResult` of the protocol, and the graph reads the verdict from
 * it. A prose "PASS" is not a review: it is a worker that did not do the
 * job, and the order goes out again.
 */

/** The stage the TDD node keeps its ledger in. */
const STAGE = 'tdd';

/** The step that holds the pending gate of an escalation. */
const GATE_STEP = 'escalation-gate';

/** The step that holds the answer of the user to that gate. */
const GATE_ANSWER_STEP = 'escalation-answer';

/** The step that holds the answers the graph could not read. */
const GATE_UNPARSED_STEP = 'escalation-unparsed';

/** The step that holds the number of invalid reviews in a row. */
const INVALID_REVIEWS_STEP = 'invalid-reviews';

/** The step that holds the number of orders that came back without their files. */
const MISSING_OUTPUTS_STEP = 'missing-outputs';

/**
 * How many rejections of the same kind the graph tolerates.
 *
 * The first rejection re-issues the very same order; the second one
 * escalates (the ladder of the task). **The CLI cannot count** - it is
 * stateless - so the count lives here, in the ledger of the stage.
 */
export const REJECTION_LIMIT = 2;

/**
 * The worker result as the graph sees it.
 *
 * The `review` is loose on purpose: a review that is present but malformed
 * must be reported as an invalid review (the order goes out again), not as
 * an invalid result (the whole result is thrown away).
 */
const LooseWorkerResultSchema = WorkerResultSchema.extend({
  review: z.unknown().optional(),
  reviews: z.unknown().optional(),
});

/** The verdict of a completed work order. */
export interface CompletionCheck {
  /** May the run go on with this answer? */
  ok: boolean;
  /** Why not. */
  reason?: 'missing_outputs' | 'invalid_review' | 'invalid_result' | 'unfinished';
  /**
   * Does this answer count as a failed attempt of the task?
   *
   * **A worker that did not finish is not a quality failure.** The order is
   * issued again and no attempt is consumed - only a review that says the
   * work is not good enough (or a review that is not a review at all, twice)
   * counts.
   */
  countsAsFailure: boolean;
}

/** The gate the user is asked when a task keeps failing. */
export interface EscalationGate {
  /** The type of the gate (the host routes on it). */
  type: string;
  /** The answers the user may pick. */
  options: string[];
  /** The task the escalation is about. */
  taskId: string;
  /**
   * What the rollback did, when the gate is about a rollback.
   *
   * **The user must know whether the code was really put back.** A rollback
   * that was skipped (the workspace was never cloned) or that failed (the
   * tag does not exist) leaves the broken code on disk: answering `wait`
   * then works on top of it, and answering `skip` carries it on. The gate
   * says what happened, so that the answer is an informed one.
   */
  rollback?: 'done' | 'skipped' | 'failed';
}

/**
 * What a task that keeps failing leads to.
 *
 * The escalation is a **discriminated union, not a command**: the node
 * decides what to do with it, and a test can assert the level without
 * running a graph.
 */
export type Escalation =
  /** The developer gets the review and another turn. */
  | { kind: 'retry_developer' }
  /** The code goes back to the start of the task, and the user decides. */
  | { kind: 'rollback'; interrupt: { audience: 'user'; type: 'tdd_rollback' } }
  /** The task is given up, and the user decides what happens to the run. */
  | {
      kind: 'blocked';
      interrupt: { audience: 'user'; type: 'tdd_blocked'; options: string[] };
    };

/**
 * Check whether a work order was really finished.
 *
 * The four reasons are the four ways a worker can let the graph down:
 *
 * 1. `missing_outputs` — the files of the order are not on disk: the worker
 *    simply did not finish. The order goes out again, and **no attempt is
 *    consumed** - a worker that ran out of time is not a quality failure.
 * 2. `invalid_review` — a review order has to come back with a valid
 *    `ReviewResult`. The first invalid review goes out again; the second one
 *    in a row is a failed review (`invalidCount` counts them).
 * 3. `invalid_result` — the result is not a worker result at all: the CLI
 *    has to send a legal one.
 * 4. `unfinished` — the worker says it did not finish (`status: 'failed'`):
 *    the order goes out again, but it counts like a broken review, so that
 *    a worker that never delivers a review cannot keep the order alive for
 *    ever.
 *
 * @param workOrder - The order the worker was given.
 * @param result - The value the order was completed with.
 * @param invalidCount - How many invalid reviews came in a row before. The
 *   parameter is part of the ladder of the caller: the same `(workOrder,
 *   result)` pair is a different verdict when the caller has seen an invalid
 *   review before (the second one counts as a failure). The caller owns the
 *   counter - the graph keeps it in the stage ledger.
 */
export function validateCompletion(
  workOrder: WorkOrder,
  result: WorkerResult,
  invalidCount = 0
): CompletionCheck {
  const missing = (workOrder.outputs ?? []).filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    return { ok: false, reason: 'missing_outputs', countsAsFailure: false };
  }

  const parsed = LooseWorkerResultSchema.safeParse(result);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_result', countsAsFailure: false };
  }

  if (parsed.data.status !== 'ok') {
    // The worker did not finish the order.
    return { ok: false, reason: 'unfinished', countsAsFailure: invalidCount >= 1 };
  }

  if (workOrder.resultSchema === 'review') {
    // **The combined reviewer has to answer both questions.** A review that
    // only says whether the task was done, or only whether it was done
    // well, is half a review - and the half that is missing is exactly the
    // half nobody would have noticed.
    const roles = reviewRoles(parsed.data.reviews, parsed.data.review);
    if (!roles.has('spec') || !roles.has('quality')) {
      return { ok: false, reason: 'invalid_review', countsAsFailure: invalidCount >= 1 };
    }
  }

  return { ok: true, countsAsFailure: false };
}

/**
 * The work order that asks the session to review the work of the developer.
 *
 * The reviewer writes no file: what it has to report is the review itself.
 *
 * **The order says what was implemented.** A reviewer that only gets the
 * task and the documents has to guess what the developer actually did; the
 * report of the developer (its summary and the files it wrote) and the
 * reviews that came before it are part of the order.
 *
 * @param state - The graph state (`repoPath`, `requirementName`).
 * @param task - The task that was worked.
 */
export function reviewWorkOrder(state: GraphState, task: Task): WorkOrder {
  const repoDir = state.repoPath;
  const docsDir = getDocsDir(state.requirementName, repoDir);
  const inputs = [path.join(docsDir, 'tasks.md'), path.join(docsDir, 'spec.md')];
  const body = renderWorkOrder('reviewer', {
    goal:
      '審查這次實作：做到 task 的驗收條件了嗎（spec），而且寫得好、又是對的嗎（quality）。',
    cwd: repoDir,
    inputs,
    outputs: [],
    outputFormat:
      '不寫任何檔案：只回報兩段 ReviewResult JSON（spec 與 quality，格式見下方「完成時」）。',
  });

  const sections = [body, taskSection(task)];
  const context = reviewContext(state);
  if (context !== '') {
    sections.push(context);
  }

  return {
    audience: 'host',
    role: 'reviewer',
    prompt: `${sections.join('\n\n')}\n`,
    cwd: repoDir,
    inputs,
    outputs: [],
    resultSchema: 'review',
  };
}

/**
 * What the reviewer has to know about the work it reviews.
 *
 * Two things: what the developer reported (its summary and the files it
 * wrote) and the reviews that came before (the history of the task).
 *
 * @param state - The graph state (`lastReviews` and the ledger of the loop).
 */
function reviewContext(state: GraphState): string {
  const sections: string[] = [];

  const report = readDeveloperReport(state);
  if (report) {
    const lines = ['## 這次實作的回報（開發者自己寫的）'];
    lines.push('');
    lines.push(report.summary !== '' ? report.summary : '（沒有寫摘要）');
    if (report.changedFiles.length > 0) {
      lines.push('');
      lines.push('**改到的檔案**：');
      for (const file of report.changedFiles) {
        lines.push(`- \`${file}\``);
      }
    }
    sections.push(lines.join('\n'));
  }

  const previous = state.lastReviews ?? [];
  if (previous.length > 0) {
    const lines = ['## 之前的評審（這個 task 的歷史）'];
    for (const review of previous) {
      lines.push('');
      lines.push(`- 角色：${review.role}`);
      lines.push(`- 結論：${review.verdict}`);
      for (const issue of review.issues) {
        const where = issue.line === undefined ? issue.file : `${issue.file}:${issue.line}`;
        lines.push(`- [${issue.severity}] ${where} —— ${issue.message}`);
      }
    }
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * What a task that failed for the `attempts`-th time leads to.
 *
 * | attempts | escalation                                          |
 * |----------|-----------------------------------------------------|
 * | 1        | the developer gets the review and another turn         |
 * | 2        | the code is rolled back to the start of the task       |
 * | 3        | the task is given up, the user decides                 |
 *
 * @param state - The graph state (the attempt counter of the run). It is
 *   the fallback of the level: a caller that does not know how many
 *   attempts there were gets the counter of the state (and at least the
 *   first attempt).
 * @param task - The task that keeps failing. The escalation is about this
 *   task, so the task is part of the contract of the call.
 * @param attempts - How many times the task has failed.
 */
export function escalate(state: GraphState, task: Task, attempts: number): Escalation {
  const level = attempts > 0 ? attempts : Math.max(state.tddAttempts ?? 0, 1);

  if (level <= 1) {
    return { kind: 'retry_developer' };
  }

  if (level === 2) {
    return { kind: 'rollback', interrupt: { audience: 'user', type: 'tdd_rollback' } };
  }

  return {
    kind: 'blocked',
    interrupt: { audience: 'user', type: 'tdd_blocked', options: ['wait', 'skip', 'abort'] },
  };
}

/* ------------------------------------------------------------------ */
/* the ledger of the reviews                                          */
/* ------------------------------------------------------------------ */

/** The gate that is waiting for the user, if there is one. */
export function readGate(state: GraphState): EscalationGate | undefined {
  const raw = readStageStep(state, STAGE, GATE_STEP);
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as EscalationGate;
    if (typeof parsed?.type !== 'string') return undefined;
    return {
      type: parsed.type,
      options: Array.isArray(parsed.options) ? parsed.options : [],
      taskId: typeof parsed.taskId === 'string' ? parsed.taskId : '',
      ...(parsed.rollback !== undefined ? { rollback: parsed.rollback } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Record the gate that waits for the user. */
export function recordGate(gate: EscalationGate): Partial<GraphState> {
  return recordStageStep(STAGE, GATE_STEP, JSON.stringify(gate));
}

/**
 * Close the gate, its answer and the record of the answers the graph could
 * not read.
 *
 * The record of an unreadable answer belongs to the gate that was open: once
 * the gate is settled, the diagnostic has done its job - and keeping it
 * would let every later unreadable answer overwrite the previous one.
 */
export function clearGate(): Partial<GraphState> {
  return {
    stageSteps: {
      ...recordStageStep(STAGE, GATE_STEP, '').stageSteps,
      ...recordStageStep(STAGE, GATE_ANSWER_STEP, '').stageSteps,
      ...recordStageStep(STAGE, GATE_UNPARSED_STEP, '').stageSteps,
    },
  };
}

/**
 * The answer of the user to the gate.
 *
 * `undefined` means the user has not answered yet. An answer that the graph
 * could **not read** is a different thing: it comes back with
 * `unparsed: true` and the raw payload, so that the gate can be asked again
 * with a diagnostic instead of silently treating the answer as missing.
 */
export function readGateAnswer(state: GraphState): GateAnswer | undefined {
  const raw = readStageStep(state, STAGE, GATE_ANSWER_STEP);
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as GateAnswer;
    if (typeof parsed?.value !== 'string') return undefined;
    return {
      value: parsed.value,
      unparsed: parsed.unparsed === true,
      raw: typeof parsed.raw === 'string' ? parsed.raw : '',
    };
  } catch {
    // **The legacy format: the answer was a plain string.** The checkpoint
    // lives in a sqlite file that outlives the plugin, so an answer written
    // by an older version has to stay readable: a run parked at the gate
    // must not lose the answer of the user because the plugin was upgraded
    // in between. The old value is the answer itself.
    const value = raw.trim();
    return value === '' ? undefined : { value, unparsed: false, raw };
  }
}

/**
 * Record the answer of the user to the gate.
 *
 * @param answer - The value the gate was answered with.
 */
export function recordGateAnswer(answer: unknown): Partial<GraphState> {
  const read = readAnswer(answer);
  const update = recordStageStep(
    STAGE,
    GATE_ANSWER_STEP,
    JSON.stringify({ value: read.value, unparsed: read.unparsed, raw: read.raw })
  );
  if (!read.unparsed) return update;
  // The answer the graph could not read goes on record: it must not be lost.
  const unparsed = recordStageStep(STAGE, GATE_UNPARSED_STEP, read.raw);
  return { stageSteps: { ...(update.stageSteps ?? {}), ...(unparsed.stageSteps ?? {}) } };
}

/**
 * The answers the graph could not read, if there are any.
 *
 * The raw payloads are the diagnostic of the gate that is asked again.
 */
export function readUnparsedGateAnswers(state: GraphState): string | undefined {
  const raw = readStageStep(state, STAGE, GATE_UNPARSED_STEP);
  return raw === undefined || raw === '' ? undefined : raw;
}

/** How many invalid reviews came in a row. */
export function invalidReviewCount(state: GraphState): number {
  return countOf(state, INVALID_REVIEWS_STEP);
}

/** Record how many invalid reviews came in a row. */
export function recordInvalidReviews(count: number): Partial<GraphState> {
  return recordStageStep(STAGE, INVALID_REVIEWS_STEP, String(count));
}

/** How many times the order came back without the files it asked for. */
export function missingOutputCount(state: GraphState): number {
  return countOf(state, MISSING_OUTPUTS_STEP);
}

/** Record how many times the order came back without the files it asked for. */
export function recordMissingOutputs(count: number): Partial<GraphState> {
  return recordStageStep(STAGE, MISSING_OUTPUTS_STEP, String(count));
}

/**
 * How many times the order was rejected for this reason.
 *
 * The two reasons have their own counters: a broken review and a missing
 * file are two different mistakes, and one of them does not excuse the
 * other.
 *
 * @param state - The graph state.
 * @param reason - Why the result was rejected.
 */
export function rejectionCount(state: GraphState, reason: RejectionReason): number {
  return reason === 'invalid_review'
    ? invalidReviewCount(state)
    : missingOutputCount(state);
}

/**
 * Record how many times the order was rejected for this reason.
 *
 * @param reason - Why the result was rejected.
 * @param count - The new count.
 */
export function recordRejection(reason: RejectionReason, count: number): Partial<GraphState> {
  return reason === 'invalid_review'
    ? recordInvalidReviews(count)
    : recordMissingOutputs(count);
}

/** The number a ledger step holds. */
function countOf(state: GraphState, step: string): number {
  const raw = readStageStep(state, STAGE, step);
  const count = Number(raw);
  return Number.isFinite(count) ? count : 0;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * The review role a work order asks for.
 *
 * `undefined` means the order is not a review order at all - a review order
 * that does not name a reviewer cannot be checked against a review.
 */
/**
 * The roles a review answer covers.
 *
 * The answer may carry the reviews in `reviews` (the combined reviewer) or
 * in `review` (a worker that only did one of them).
 *
 * @param reviews - The `reviews` field of the answer.
 * @param review - The `review` field of the answer.
 * @returns The roles that are covered.
 */
export function reviewRoles(reviews: unknown, review: unknown): Set<string> {
  const roles = new Set<string>();
  const list = Array.isArray(reviews) ? reviews : [];
  for (const item of list) {
    const parsed = ReviewResultSchema.safeParse(item);
    if (parsed.success) roles.add(parsed.data.role);
  }
  const single = ReviewResultSchema.safeParse(review);
  if (single.success) roles.add(single.data.role);
  return roles;
}
