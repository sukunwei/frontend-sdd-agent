import { interrupt } from '@langchain/langgraph';
import * as fs from 'fs';
import { isRejectionMarker } from '../cli/protocol.js';
import type { RejectionReason, WorkerResult, WorkOrder } from '../cli/protocol.js';
import { STAGE_NODE_NAMES } from '../graph/node-names.js';
import type { GraphState, InterruptPayload, NodeOutcome } from '../graph/state.js';
import {
  clearGate,
  escalate,
  invalidReviewCount,
  readGate,
  readGateAnswer,
  readUnparsedGateAnswers,
  recordGate,
  recordGateAnswer,
  recordInvalidReviews,
  recordMissingOutputs,
  recordRejection,
  rejectionCount,
  REJECTION_LIMIT,
  reviewWorkOrder,
  validateCompletion,
} from '../nodes/review.js';
import { tddNode } from '../nodes/tdd.js';
import {
  clearQuestion,
  readQuestion,
  readUserAnswer,
  recordDeveloperFailure,
  recordDeveloperReport,
  recordQuestion,
  recordUserAnswer,
} from '../nodes/tdd.js';
import { isGitRepository, resetToTaskStart, tagTaskStart } from '../runtime/git-tags.js';
import { ReviewResultSchema } from '../state/schema.js';
import type { Blocker, ReviewResult, Task } from '../state/types.js';

/**
 * The TDD loop: one task at a time, in the order of `state.tasks`.
 *
 * The loop of a task:
 *
 * ```
 * git tag sdd/task/<id>/start   （確定性，圖內執行；已存在則跳過）
 *   → interrupt WorkOrder developer      （audience: host）
 *   → interrupt WorkOrder spec_review    （audience: host，resultSchema: review）
 *   → interrupt WorkOrder quality_review （audience: host，resultSchema: review）
 *   → mark_complete → 下一個 task 或交棒給驗證階段
 * ```
 *
 * **The sub-stage in the state is the ledger.** `tddSubStage` says which step
 * of the task the run is on, so a session that resumes in a different
 * conversation knows what is still open. It is written *after* the interrupt
 * that finished the step - the same pattern the other stage nodes use.
 *
 * **One interrupt per execution.** LangGraph re-executes the whole node when
 * the run is resumed, so everything a node does before its `interrupt()`
 * happens twice. The only side effect before an interrupt here is the git
 * tag, and it is idempotent on purpose: a tag that exists is never moved.
 *
 * **The tasks are serial.** One task is worked at a time - the state holds
 * the index of the task that is in flight (`currentTaskIndex`).
 *
 * **A task that keeps failing is escalated** (see `escalate`): the developer
 * gets the review and another turn, then the code is rolled back to the start
 * of the task, and finally the user is asked what should happen to the run.
 */
export async function tddSubgraph(state: GraphState): Promise<NodeOutcome> {
  const tasks = state.tasks ?? [];
  const index = state.currentTaskIndex ?? 0;
  const task = tasks[index];

  // Nothing left to work on: the run goes to the verification stage.
  if (!task) {
    return { kind: 'advance', update: { currentStage: 'verification' }, goto: STAGE_NODE_NAMES.verification };
  }

  // A task that keeps failing was escalated: the user decides what happens.
  const gate = readGate(state);
  if (gate) {
    // What the rollback did rides along with the gate: the user has to know
    // whether the broken code is still on disk before answering.
    const rollback = gate.rollback !== undefined ? { rollback: gate.rollback } : {};
    const given = readGateAnswer(state);
    if (given === undefined) {
      const answer = interrupt({
        audience: 'user',
        type: gate.type,
        options: gate.options,
        taskId: gate.taskId,
        ...rollback,
      });
      return { kind: 'advance', update: recordGateAnswer(answer), goto: STAGE_NODE_NAMES.tdd };
    }
    if (given.unparsed) {
      // The user answered, but the graph did not understand the answer.
      // The gate is asked again - with the raw answer in the payload, so
      // that the user sees what was not understood. The answer is not lost:
      // it is on record in the ledger, and the ledger is what the payload
      // is built from.
      const answer = interrupt({
        audience: 'user',
        type: gate.type,
        options: gate.options,
        taskId: gate.taskId,
        ...rollback,
        previousAnswer: readUnparsedGateAnswers(state) ?? given.raw,
        note:
          'the previous answer could not be read; answer with one of the options ' +
          '(or with a plain string)',
      });
      return { kind: 'advance', update: recordGateAnswer(answer), goto: STAGE_NODE_NAMES.tdd };
    }
    return settleGate(state, task, given.value);
  }

  // The developer asked something the graph cannot answer: the user decides.
  const question = readQuestion(state);
  if (question && readUserAnswer(state) === undefined) {
    const answer = interrupt({
      audience: 'user',
      type: question.type,
      question: question.question,
      options: question.options,
    });
    return { kind: 'advance', update: recordUserAnswer(answer), goto: STAGE_NODE_NAMES.tdd };
  }

  switch (state.tddSubStage ?? 'pending') {
    case 'pending':
      return developerStep(state, task);
    case 'developer_done':
      return reviewStep(state, task);
    case 'review_done':
      return finishTask(state, tasks.length);
    case 'completed':
      return startCycle();
    default:
      // **A checkpoint of an older version.** The sub-stage values changed
      // when the two reviews were merged. A run that was parked between the
      // two reviews has to go on: the combined review still has to happen,
      // because the quality half of it never ran.
      return reviewStep(state, task);
  }
}

/* ------------------------------------------------------------------ */
/* the steps of a task                                                 */
/* ------------------------------------------------------------------ */

/**
 * The developer step.
 *
 * The tag comes first: it is the point a rollback goes back to, and it has
 * to exist before the developer writes anything.
 */
async function developerStep(state: GraphState, task: Task): Promise<NodeOutcome> {
  const repoDir = state.repoPath;
  // A workspace that was never cloned is not a repository: there is no tag
  // to create and nothing to roll back to.
  if (isGitRepository(repoDir)) {
    tagTaskStart(repoDir, task.id);
  }

  const order = tddNode.developerWorkOrder(state, task);
  const answer = interrupt(workOrderPayload(order));

  if (isRejectionMarker(answer)) {
    // The host rejected the result: the order goes out again (or the task
    // escalates). The node itself does not know what the host disliked.
    return handleRejection(state, task, answer.reason);
  }

  const outcome = tddNode.readDeveloperResult(answer);
  if (outcome.kind === 'ok') {
    const missing = order.outputs.filter((file) => !fs.existsSync(file));
    if (missing.length > 0) {
      // The worker says it is done, but the files are not on disk: the
      // worker did not finish. The order goes out again (and the second
      // time the task escalates) - the same thing the CLI does when it
      // rejects the result.
      return handleRejection(state, task, 'missing_outputs');
    }
    return {
      kind: 'advance',
      update: {
        tddSubStage: 'developer_done',
        ...clearQuestion(),
        ...recordInvalidReviews(0),
        // What the developer did is part of the review order: the reviewers
        // have to know what was implemented.
        ...recordDeveloperReport({
          summary: outcome.summary,
          changedFiles: outcome.changedFiles,
        }),
        ...recordDeveloperFailure(''),
      },
      goto: STAGE_NODE_NAMES.tdd,
    };
  }

  if (outcome.kind === 'needs_human') {
    // The worker is not allowed to ask the user itself: it hands the
    // question to the graph, and the graph asks it (the next execution).
    return {
      kind: 'advance',
      update: recordQuestion(outcome.question),
      goto: STAGE_NODE_NAMES.tdd,
    };
  }

  // The worker did not finish the task: that is a failed attempt too. The
  // reason goes into the ledger, so that the next order says what went
  // wrong.
  return escalateTask(state, task, [], outcome.summary);
}

/** The review step of a task. */
async function reviewStep(state: GraphState, task: Task): Promise<NodeOutcome> {
  const order = reviewWorkOrder(state, task);
  const answer = interrupt(workOrderPayload(order));

  if (isRejectionMarker(answer)) {
    // The host rejected the review: the same order goes out again, or the
    // task escalates. The count lives in the ledger of the stage.
    return handleRejection(state, task, answer.reason);
  }

  const invalidCount = invalidReviewCount(state);
  const check = validateCompletion(order, answer as WorkerResult, invalidCount);

  if (!check.ok) {
    if (check.reason === 'missing_outputs') {
      // The worker did not finish: the very same order goes out again. This
      // is not a quality failure, so no attempt is consumed.
      return { kind: 'advance', update: {}, goto: STAGE_NODE_NAMES.tdd };
    }

    if (check.reason === 'invalid_review' || check.reason === 'unfinished') {
      // The first broken review: the very same order goes out again. The
      // second one in a row escalates the task.
      //
      // **A worker that says it did not finish counts like a broken
      // review.** The reviewer that never delivers a review must not be
      // able to keep the order alive for ever: the ladder of the task is
      // the same one a malformed review climbs.
      return handleRejection(state, task, 'invalid_review');
    }

    // The result is not a worker result at all: the CLI has to send a legal
    // one. The order stays open.
    return { kind: 'advance', update: {}, goto: STAGE_NODE_NAMES.tdd };
  }

  // **The reviewer answers two questions in one order.** Both verdicts are
  // kept: the developer of the next attempt has to see the spec verdict
  // (the task was not done) and the quality verdict (the task was done
  // badly) - the old loop overwrote the first one with the second.
  const reviews = [readReview(answer, 'spec'), readReview(answer, 'quality')].filter(
    (review): review is ReviewResult => review !== undefined
  );
  if (reviews.length === 0) {
    // `validateCompletion` accepted the review, so this cannot happen - but
    // the order must not be answered with a step that was never checked.
    return { kind: 'advance', update: {}, goto: STAGE_NODE_NAMES.tdd };
  }

  const failed = reviews.find((review) => review.verdict === 'fail');
  if (failed !== undefined) {
    // **Both verdicts go back with the failure.** The developer of the next
    // attempt has to see the spec complaint ("the task was not done") and
    // the quality complaint ("the task was done badly") - they are two
    // different kinds of work.
    return escalateTask(state, task, reviews);
  }

  return {
    kind: 'advance',
    update: {
      tddSubStage: 'review_done',
      lastReviews: reviews,
      ...recordInvalidReviews(0),
    },
    goto: STAGE_NODE_NAMES.tdd,
  };
}

/**
 * The host rejected the result of the order.
 *
 * **The CLI cannot count - the graph can.** The CLI is stateless, so the
 * number of rejections lives in the ledger of the stage (`stageSteps`). The
 * node counts the rejection and decides:
 *
 * - the first rejection: the very same order goes out again. The advance
 *   **self-loops** (`goto` the same node) and raises **no** interrupt - the
 *   next execution issues the order again (one `interrupt()` per execution).
 * - the second rejection of the same kind: the task escalates (the ladder of
 *   the task takes over).
 *
 * @param state - The graph state.
 * @param task - The task the order is about.
 * @param reason - Why the host rejected the result.
 */
function handleRejection(
  state: GraphState,
  task: Task,
  reason: RejectionReason
): NodeOutcome {
  const count = rejectionCount(state, reason) + 1;
  if (count >= REJECTION_LIMIT) {
    // The second rejection of the same kind: the task escalates.
    return escalateTask(state, task, []);
  }
  return {
    kind: 'advance',
    update: recordRejection(reason, count),
    goto: STAGE_NODE_NAMES.tdd,
  };
}

/**
 * Escalate a task that failed.
 *
 * The three levels of the ladder (see `escalate`):
 *
 * 1. the developer gets the review and another turn,
 * 2. the code goes back to the start of the task (the git tag) and the user
 *    is asked,
 * 3. the task is given up and the user is asked what happens to the run.
 *
 * **The rollback happens before the gate is raised.** The rollback is
 * idempotent (the tag does not move), so it may run again without harm -
 * and a gate must never be preceded by a side effect that cannot be
 * repeated.
 *
 * @param state - The graph state.
 * @param task - The task that failed.
 * @param review - The review that failed, if there was one.
 * @param failure - Why the attempt failed, if the worker said so.
 */
function escalateTask(
  state: GraphState,
  task: Task,
  reviews: ReviewResult[],
  failure?: string
): NodeOutcome {
  const attempts = (state.tddAttempts ?? 0) + 1;
  const escalation = escalate(state, task, attempts);
  const reason = failure !== undefined && failure !== '' ? recordDeveloperFailure(failure) : {};

  switch (escalation.kind) {
    case 'retry_developer':
      return {
        kind: 'advance',
        update: {
          tddAttempts: attempts,
          tddSubStage: 'pending',
          ...(reviews.length > 0 ? { lastReviews: reviews } : {}),
          ...recordInvalidReviews(0),
          // The order goes out again from the start: the rejections of the
          // last attempt are counted from zero.
          ...recordMissingOutputs(0),
          ...reason,
        },
        goto: STAGE_NODE_NAMES.tdd,
      };

    case 'rollback': {
      // A workspace that was never cloned has no tag to roll back to: the
      // rollback is skipped, and the user is asked what happens to the run
      // anyway. A `git reset` against a directory without a repository
      // would fail the node - and the run would die at the very moment the
      // user should have been asked.
      //
      // **What the rollback did goes into the gate.** A rollback that was
      // skipped or that failed leaves the broken code on disk: the user has
      // to know that before answering `wait` (work on top of it) or `skip`
      // (carry it on).
      const rollback = rollbackOutcome(state.repoPath, task.id);
      return {
        kind: 'advance',
        update: {
          tddAttempts: attempts,
          ...(reviews.length > 0 ? { lastReviews: reviews } : {}),
          ...reason,
          ...recordGate({
            type: escalation.interrupt.type,
            options: ['wait', 'skip', 'abort'],
            taskId: task.id,
            rollback,
          }),
        },
        goto: STAGE_NODE_NAMES.tdd,
      };
    }

    case 'blocked':
      return {
        kind: 'advance',
        update: {
          tddAttempts: attempts,
          ...(reviews.length > 0 ? { lastReviews: reviews } : {}),
          ...reason,
          blockers: [blockerFor(task, 'the task failed too often to be worked', 'blocked')],
          ...recordGate({
            type: escalation.interrupt.type,
            options: escalation.interrupt.options,
            taskId: task.id,
          }),
        },
        goto: STAGE_NODE_NAMES.tdd,
      };
  }
}

/**
 * The user answered the gate of an escalation.
 *
 * - `skip`: the task is given up and the run goes on with the next one.
 * - `abort`: the run ends, with a blocker on record.
 * - `wait`: the task gets another turn (the developer order goes out again).
 */
function settleGate(state: GraphState, task: Task, answer: string): NodeOutcome {
  const tasks = state.tasks ?? [];
  const index = state.currentTaskIndex ?? 0;
  const clear = clearGate();

  if (answer === 'skip') {
    if (index + 1 < tasks.length) {
      return {
        kind: 'advance',
        update: { ...clear, tddSubStage: 'completed', currentTaskIndex: index + 1 },
        goto: STAGE_NODE_NAMES.tdd,
      };
    }
    return {
      kind: 'advance',
      update: { ...clear, tddSubStage: 'completed', currentStage: 'verification' },
      goto: STAGE_NODE_NAMES.verification,
    };
  }

  if (answer === 'abort') {
    return {
      kind: 'advance',
      update: {
        ...clear,
        currentStage: 'completed',
        blockers: [blockerFor(task, 'the user aborted the task', 'aborted')],
      },
      goto: STAGE_NODE_NAMES.completed,
    };
  }

  // 'wait': the task gets another turn. The counter of the attempts stays
  // where it is - the user decides how many rounds the task gets. The
  // blocker of the task is taken back: the task is running again, and a
  // "failed too often" blocker would be a lie.
  return {
    kind: 'advance',
    update: {
      ...clear,
      tddSubStage: 'pending',
      blockers: [blockerFor(task, 'the user let this task run again', 'blocked', true)],
    },
    goto: STAGE_NODE_NAMES.tdd,
  };
}

/**
 * The task is done.
 *
 * With a next task, the index moves on and the next cycle starts. Without
 * one, the run hands over to the verification stage - and the index stays on
 * the last task, so that the verification stage may send the run back to
 * this node to have that task worked on again.
 */
function finishTask(state: GraphState, taskCount: number): NodeOutcome {
  const index = state.currentTaskIndex ?? 0;
  if (index + 1 < taskCount) {
    return {
      kind: 'advance',
      update: { tddSubStage: 'completed', currentTaskIndex: index + 1 },
      goto: STAGE_NODE_NAMES.tdd,
    };
  }
  return {
    kind: 'advance',
    update: { tddSubStage: 'completed', currentStage: 'verification' },
    goto: STAGE_NODE_NAMES.verification,
  };
}

/**
 * The start of a task cycle.
 *
 * The failure counter and the last review belong to the task that is done -
 * the next task starts with a clean slate. So does the report of the
 * developer: the reviewers of the next task must not read the report of the
 * task before.
 */
function startCycle(): NodeOutcome {
  return {
    kind: 'advance',
    update: {
      tddSubStage: 'pending',
      tddAttempts: 0,
      lastReviews: [],
      ...recordInvalidReviews(0),
      ...recordMissingOutputs(0),
      ...recordDeveloperReport({ summary: '', changedFiles: [] }),
      ...recordDeveloperFailure(''),
    },
    goto: STAGE_NODE_NAMES.tdd,
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** The payload of a work order interrupt. */
function workOrderPayload(order: WorkOrder): InterruptPayload {
  return { type: 'work_order', ...order };
}

/**
 * The review of the worker.
 *
 * A review that is not a valid `ReviewResult` is not a review: the worker
 * has to be asked again.
 */
function readReview(answer: unknown, role: 'spec' | 'quality'): ReviewResult | undefined {
  const result = answer as { review?: unknown; reviews?: unknown } | undefined;
  // The combined reviewer answers with a list; a worker that only did one
  // of the two answers with a single review.
  const list = Array.isArray(result?.reviews) ? result.reviews : [];
  for (const item of list) {
    const parsed = ReviewResultSchema.safeParse(item);
    if (parsed.success && parsed.data.role === role) return parsed.data;
  }
  const single = ReviewResultSchema.safeParse(result?.review);
  if (!single.success) return undefined;
  if (single.data.role !== role) return undefined;
  return single.data;
}

/**
 * What a rollback did.
 *
 * - `done` — the code went back to the start of the task.
 * - `skipped` — there was nothing to roll back to (the workspace was never
 *   cloned, so there is no repository and no tag).
 * - `failed` — the repository is there, but the reset did not work (the tag
 *   does not exist).
 *
 * In the last two cases **the broken code is still on disk**, and the user
 * has to know it before answering the gate.
 *
 * @param repoDir - The repository of the run.
 * @param taskId - The task that is rolled back.
 */
function rollbackOutcome(repoDir: string, taskId: string): 'done' | 'skipped' | 'failed' {
  if (!isGitRepository(repoDir)) return 'skipped';
  return resetToTaskStart(repoDir, taskId) ? 'done' : 'failed';
}

/**
 * The blocker of a task that was given up.
 *
 * **The id is derived from the task and the kind of the blocker**, not from
 * the clock: the blockers of a state are merged by their id, so an id that
 * changes on every call would pile up blockers instead of replacing them,
 * and an id that depends on `Date.now()` is not reproducible when the
 * checkpoint is replayed.
 *
 * The same id is used to take a blocker back: the user who answers `wait`
 * resolves the blocker of the task, and the state drops it.
 *
 * @param task - The task the blocker is about.
 * @param reason - Why the task was given up.
 * @param kind - Which blocker it is (`blocked`, `aborted`).
 * @param resolved - Is the blocker resolved (and therefore dropped)?
 */
function blockerFor(
  task: Task,
  reason: string,
  kind: 'blocked' | 'aborted',
  resolved = false
): Blocker {
  return {
    id: `tdd-${task.id}-${kind}`,
    taskId: task.id,
    reason,
    createdAt: new Date().toISOString(),
    ...(resolved ? { resolved: true } : {}),
  };
}
