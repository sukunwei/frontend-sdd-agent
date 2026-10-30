import * as path from 'path';
import { z } from 'zod';
import { ReviewResultSchema } from '../state/schema.js';
import type { InterruptPayload as GraphInterruptPayload } from '../graph/state.js';

/**
 * The wire contract between the graph and the Claude Code session.
 *
 * The graph owns the stage routing; the session works the orders. The two
 * sides only ever talk through the schemas in this file:
 *
 * - A **work order** is what the graph hands to the session (`audience:
 *   'host'`): the role to play, the prompt to follow, and the absolute paths
 *   to read and to write.
 * - A **worker result** is what the session hands back (`complete --result`).
 * - An **interrupt payload** is what the graph parks with. Every payload
 *   carries an `audience` (`'user'` = ask a human, `'host'` = work an order)
 *   and a `type`.
 *
 * The schemas are the contract the later tasks (the stage nodes, the
 * prompts, the slash commands) build on, so their names and shapes must not
 * drift.
 */

/** Roles a host work order can ask the session to play. */
export const WORK_ORDER_ROLES = [
  'spec_writer',
  'e2e_planner',
  'task_splitter',
  'developer',
  'reviewer',
  'figma_fetch',
  'figma_prototype',
  'figma_polish',
] as const;

/** Role of a host work order. */
export type WorkOrderRole = (typeof WORK_ORDER_ROLES)[number];

/**
 * An absolute path.
 *
 * Work orders always name files absolutely: a session that resumes in a
 * different conversation re-reads the files it needs from disk alone, and the
 * CLI checks the paths against the file system - a relative path would be
 * resolved against whatever directory the CLI happens to run in.
 */
export const AbsolutePathSchema = z.string().refine((value) => path.isAbsolute(value), {
  message: 'path must be absolute',
});

/**
 * The shape of a work order, without the path rules.
 *
 * The CLI needs it to tell a work order that breaks the contract apart from
 * a host interrupt that is not a work order at all.
 */
export const WorkOrderShapeSchema = z.object({
  audience: z.literal('host'),
  role: z.enum(WORK_ORDER_ROLES),
  prompt: z.string(),
  cwd: z.string(),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  resultSchema: z.enum(['review', 'none']).optional(),
});

/**
 * A unit of work the graph hands to the Claude Code session.
 *
 * `inputs` and `outputs` are **absolute paths**: a session that resumes in a
 * different conversation must be able to re-read the files it needs from disk
 * alone - it may not rely on anything that was said in the previous session.
 */
export const WorkOrderSchema = WorkOrderShapeSchema.extend({
  inputs: z.array(AbsolutePathSchema),
  outputs: z.array(AbsolutePathSchema),
});

/** A unit of work the graph hands to the Claude Code session. */
export type WorkOrder = z.infer<typeof WorkOrderSchema>;

/**
 * What the session reports back after working an order.
 *
 * `status: 'needs_human'` is the escape hatch for a worker that hit a
 * decision it is not allowed to make: it states the question in `interrupt`
 * and the graph turns it into an `audience: 'user'` gate.
 */
export const WorkerResultSchema = z.object({
  status: z.enum(['ok', 'failed', 'needs_human']),
  summary: z.string(),
  changedFiles: z.array(z.string()),
  review: ReviewResultSchema.optional(),
  /**
   * The reviews of a combined review.
   *
   * The reviewer answers with one result per role (`spec` and `quality`);
   * a single review keeps working for a worker that only does one of them.
   */
  reviews: z.array(ReviewResultSchema).optional(),
  interrupt: z
    .object({
      type: z.string(),
      question: z.string(),
      options: z.array(z.string()).optional(),
    })
    .optional(),
});

/** What the session reports back after working an order. */
export type WorkerResult = z.infer<typeof WorkerResultSchema>;

/**
 * The text of a field of an answer.
 *
 * An answer is whatever the host handed to `approve` / `complete`: the graph
 * never assumes a shape it has not agreed on, so every field is read
 * defensively.
 *
 * @param answer - The value a gate was answered with.
 * @param key - Name of the field.
 */
export function answerText(answer: unknown, key: string): string {
  if (typeof answer === 'object' && answer !== null) {
    const value = (answer as Record<string, unknown>)[key];
    if (typeof value === 'string') return value.trim();
  }
  return '';
}

/**
 * Did the user approve?
 *
 * The confirmation gates are answered with `{ approved, comment? }`. Only an
 * explicit "yes" approves: an answer that does not say so (a typo, another
 * field, an empty payload) must not send the run past the gate - it asks
 * again, which is the safe side of the mistake.
 *
 * @param answer - The value a gate was answered with.
 */
export function isApproved(answer: unknown): boolean {
  if (typeof answer !== 'object' || answer === null) return false;
  return (answer as { approved?: unknown }).approved === true;
}

/**
 * Why the host rejected the result of a work order.
 *
 * - `missing_outputs`: the files the order asked for are not on disk - the
 *   worker simply did not finish.
 * - `invalid_review`: a review order came back with something that is not a
 *   valid `ReviewResult`.
 */
export type RejectionReason = 'missing_outputs' | 'invalid_review';

/**
 * The marker the CLI hands to the graph when it rejects a result.
 *
 * **The CLI cannot count.** It is stateless: every invocation starts from
 * scratch, so the number of times a worker got an order wrong only exists in
 * the graph's state. The CLI therefore does not re-issue the order on its own
 * - it resumes the graph with this marker, and the node that owns the order
 * counts the rejection in the stage ledger and decides what happens next
 * (the same order again, or the escalation).
 */
export interface RejectionMarker {
  /** The marker is addressed to the graph, not to a worker. */
  __rejected: true;
  /** Why the result was rejected. */
  reason: RejectionReason;
}

/**
 * Is this value the rejection marker?
 *
 * The marker travels through the same channel as a worker result, so the
 * node has to be able to tell the two apart: a marker is not a result, and
 * a result is not a marker.
 *
 * @param value - The value the order was completed with.
 */
export function isRejectionMarker(value: unknown): value is RejectionMarker {
  if (typeof value !== 'object' || value === null) return false;
  const marker = value as Partial<RejectionMarker>;
  if (marker.__rejected !== true) return false;
  return marker.reason === 'missing_outputs' || marker.reason === 'invalid_review';
}

/**
 * Build the rejection marker.
 *
 * @param reason - Why the result was rejected.
 */
export function rejectionMarker(reason: RejectionReason): RejectionMarker {
  return { __rejected: true, reason };
}

/**
 * The roles whose node knows the rejection marker.
 *
 * **The marker is only forwarded to the nodes that implement the protocol.**
 * The TDD loop counts the rejections in its ledger; a node that does not know
 * the marker would read it as a worker result that is not there, and the
 * order would be lost instead of re-issued.
 */
export const REJECTION_AWARE_ROLES = ['developer', 'reviewer'] as const;

/**
 * Does the node that owns this order know the rejection marker?
 *
 * @param role - The role of the work order.
 */
export function isRejectionAware(role: string | undefined): boolean {
  return (REJECTION_AWARE_ROLES as readonly string[]).includes(role ?? '');
}

/** A question a worker raised and may not answer itself. */
export interface WorkerQuestion {
  /** What kind of question it is. */
  type: string;
  /** The question itself. */
  question: string;
  /** The answers the worker can offer (may be empty). */
  options: string[];
}

/**
 * The question a worker raised.
 *
 * A worker that hit a decision it may not make answers with
 * `status: 'needs_human'` and states the question in the `interrupt`
 * field. The graph turns it into an `audience: 'user'` gate - the worker
 * may not ask the user itself.
 *
 * @param result - The value a work order was completed with.
 */
export function workerQuestion(result: unknown): WorkerQuestion | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  if ((result as { status?: unknown }).status !== 'needs_human') return undefined;

  const raised = (result as { interrupt?: unknown }).interrupt;
  if (typeof raised !== 'object' || raised === null) return undefined;

  const question = (raised as { question?: unknown }).question;
  if (typeof question !== 'string' || question.trim() === '') return undefined;

  const type = (raised as { type?: unknown }).type;
  const options = (raised as { options?: unknown }).options;

  return {
    type: typeof type === 'string' && type !== '' ? type : 'needs_human',
    question,
    options: Array.isArray(options) ? options.filter((option) => typeof option === 'string') : [],
  };
}

/**
 * Did the worker report that it could not finish the order?
 *
 * A worker that ran into a decision it may not make answers with
 * `status: 'needs_human'`; one that failed answers with `status: 'failed'`.
 * Both are unfinished orders.
 *
 * @param result - The value a work order was completed with.
 */
export function isUnfinishedResult(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const status = (result as { status?: unknown }).status;
  return status === 'failed' || status === 'needs_human';
}

/**
 * Payload of a pending interrupt.
 *
 * Every payload carries a `type` and an `audience` (`'user'` = ask a human,
 * `'host'` = work an order); everything else depends on the type, so unknown
 * keys are kept (`looseObject`) instead of being stripped.
 */
export const InterruptPayloadSchema = z.looseObject({
  type: z.string(),
  audience: z.enum(['user', 'host']),
});

/** Payload of a pending interrupt. */
export type InterruptPayload = z.infer<typeof InterruptPayloadSchema>;

/**
 * Compile-time proof that the zod schema and the graph's own interrupt
 * payload type describe the same document.
 */
type Assert<T extends true> = T;

export type InterruptPayloadMatchesGraph = Assert<
  [InterruptPayload] extends [GraphInterruptPayload]
    ? [GraphInterruptPayload] extends [InterruptPayload]
      ? true
      : false
    : false
>;
