import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { buildGraph } from '../graph/compile.js';
import type { CompiledSddGraph } from '../graph/compile.js';
import type { GraphState } from '../graph/state.js';
import { actionOf } from '../nodes/bootstrap.js';
import { ArtifactStore } from '../persistence/artifact-store.js';
import { createCheckpointer } from '../persistence/checkpoint.js';
import { forceUnlock, releaseLock, validateLockOwnership } from '../runtime/branch-lock.js';
import { getCheckpointPath, getDocsDir, getLockFilePath } from '../runtime/paths.js';
import { normalizeTaskName } from '../runtime/task-name.js';
import { cleanupTaskWorkspace } from '../runtime/task-workspace.js';
import { ReviewResultSchema } from '../state/schema.js';
import type { SddState } from '../state/types.js';
import { envelope } from './envelope.js';
import {
  isRejectionAware,
  rejectionMarker,
  WorkerResultSchema,
  WorkOrderSchema,
  WorkOrderShapeSchema,
} from './protocol.js';
import type { RejectionReason, WorkOrder } from './protocol.js';

/**
 * The CLI contract between the graph and the Claude Code session.
 *
 * ```
 * sdd-graph start   --task <n> --repo <url>
 * sdd-graph resume  --task <n>
 * sdd-graph complete --task <n> --result <json|@file>
 * sdd-graph approve  --task <n> --payload <json|@file>
 * sdd-graph status   --task <n>
 * sdd-graph stop     --task <n> [--force]
 * sdd-graph change   --task <n>          （v1 只預留：回 1 not_implemented）
 * ```
 *
 * **Exit codes** are the contract; the JSON envelope only says what
 * happened:
 *
 * | exit | meaning                                            | stdout        |
 * |------|----------------------------------------------------|---------------|
 * | 0    | the graph reached `completed`, nothing was pending | result        |
 * | 2    | there is a pending interrupt                       | interrupt     |
 * | 1    | bad arguments, no such thread, contract violation  | - (stderr)    |
 *
 * The two interrupt audiences are kept strictly apart: a `user` interrupt
 * (ask a human) may only be advanced by `approve`, a `host` interrupt (work
 * an order) only by `complete`. Crossing the two is an error, not a
 * convenience.
 *
 * The error codes the host may see on stderr: `invalid_arguments`,
 * `no_checkpoint`, `audience_mismatch`, `invalid_result`, `invalid_payload`,
 * `invalid_order`, `already_completed`, `lock_not_owned`, `not_implemented`,
 * `internal_error`.
 */

/** The command finished; nothing is pending. */
const EXIT_OK = 0;
/** The command failed (bad arguments, no such thread, contract violation). */
const EXIT_ERROR = 1;
/** The command parked the run on a pending interrupt. */
const EXIT_INTERRUPT = 2;

/** Options of {@link runCli}. */
export interface RunCliOptions {
  /** Use this graph instead of building one (tests inject their own nodes). */
  graph?: CompiledSddGraph;
  /** Checkpoint database to use instead of the plugin-root default. */
  checkpointPath?: string;
  /** Branch lock file to use instead of the plugin-root default. */
  lockPath?: string;
}

/**
 * The wire form of a worker result.
 *
 * `review` is deliberately loose here: a review that is **present but
 * malformed** must not fail the whole result - rule 4 of `complete` re-issues
 * the order instead of killing the run. `WorkerResultSchema` (the contract
 * the later tasks build on) stays strict.
 */
const WireWorkerResultSchema = WorkerResultSchema.extend({
  review: z.unknown().optional(),
});

/** A worker result as it arrives over the wire. */
type WireWorkerResult = z.infer<typeof WireWorkerResultSchema>;

/** An error the CLI reports as `{"kind":"error","code":...}`. */
class CliError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** The parts of a LangGraph state snapshot the CLI reads. */
interface Snapshot {
  values: Record<string, unknown>;
  tasks: Array<{ id?: string; interrupts?: Array<{ id: string; value: unknown }> }>;
  next: string[];
}

/** A pending interrupt, as the CLI sees it. */
interface PendingInterrupt {
  id: string;
  value: unknown;
}

/** Flags that carry no value. */
const BOOLEAN_FLAGS = new Set(['force']);

/** Run the CLI and return the exit code. */
export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<number> {
  try {
    const args = parseArgs(argv);
    switch (args.command) {
      case 'start':
        return await cmdStart(args, opts);
      case 'resume':
        return await cmdResume(args, opts);
      case 'complete':
        return await cmdComplete(args, opts);
      case 'approve':
        return await cmdApprove(args, opts);
      case 'status':
        return await cmdStatus(args, opts);
      case 'stop':
        return await cmdStop(args, opts);
      case 'change':
        return cmdChange();
      default:
        throw new CliError('invalid_arguments', `unknown command: ${args.command || '<none>'}`);
    }
  } catch (err) {
    if (err instanceof CliError) {
      writeErr(envelope('error', { code: err.code, message: err.message }));
      return EXIT_ERROR;
    }
    writeErr(
      envelope('error', {
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      })
    );
    return EXIT_ERROR;
  }
}

/**
 * Entry point of the `sdd-graph` executable.
 *
 * `process.exit` is called only after stdout has been flushed: the host
 * reads stdout through a pipe, and exiting with a pending pipe write would
 * truncate the envelope.
 */
export async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2));
  await flushStdout();
  process.exit(code);
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

/** `start --task <n> --repo <url>`: begin a run (or hand back what is pending). */
async function cmdStart(args: ParsedArgs, opts: RunCliOptions): Promise<number> {
  const threadId = threadIdOf(requireFlag(args, 'task'));
  const repoUrl = requireFlag(args, 'repo');
  const config = configOf(threadId);

  return withGraph(opts, async (graph) => {
    const state = await readState(graph, config);
    const pending = firstInterrupt(state);
    if (pending) {
      // The thread already has work in flight: hand the same order back
      // instead of starting a second run on top of it.
      return emitInterrupt(pending, threadId, stageOfSnapshot(state));
    }
    await graph.invoke({ requirementName: threadId, repoUrl } as GraphState, config);
    return reportOutcome(graph, config, threadId);
  });
}

/** `resume --task <n>`: re-issue whatever the thread is parked on. */
async function cmdResume(args: ParsedArgs, opts: RunCliOptions): Promise<number> {
  const threadId = threadIdOf(requireFlag(args, 'task'));
  const config = configOf(threadId);

  return withGraph(opts, async (graph) => {
    const state = await readState(graph, config);
    if (isEmptyState(state)) {
      throw new CliError('no_checkpoint', `no checkpoint for thread ${threadId}`);
    }
    const pending = firstInterrupt(state);
    if (pending) {
      // The run is parked: the same order is re-issued, unchanged.
      return emitInterrupt(pending, threadId, stageOfSnapshot(state));
    }
    if (state.next.length === 0) {
      // The graph already ran to its end.
      emitResult({ stage: stageOfSnapshot(state), threadId });
      return EXIT_OK;
    }
    await graph.invoke(null as unknown as GraphState, config);
    return reportOutcome(graph, config, threadId);
  });
}

/**
 * `complete --task <n> --result <json|@file>`: hand a finished work order
 * back to the graph.
 *
 * The validation order matters - it is what keeps a half-finished worker
 * from being counted as a failed attempt:
 *
 * 1. The pending interrupt has to be a `host` order. A `user` gate is never
 *    advanced by `complete` (that would answer a question meant for a human
 *    with a worker's result).
 * 2. The result has to be a worker result at all: a status, a summary and
 *    the changed files. The `review` field is *not* checked here - a broken
 *    review re-issues the order (rule 4) instead of killing the run.
 * 3. Every file the order asked for has to be on disk. A missing file means
 *    the worker simply did not finish - the same order is re-issued and
 *    **no** failure counter moves.
 * 4. A review order has to carry a valid `ReviewResult`; a review that is
 *    present but malformed is never accepted either. Both re-issue the order.
 *
 * **Rules 3 and 4 do not re-issue the order on their own.** The CLI is
 * stateless, so the count of the rejections only exists in the graph's state:
 * the CLI resumes the graph with a rejection marker, and the node that owns
 * the order counts it and decides (the same order again, or the escalation).
 * The observable contract is the same - the run stays parked on the same work
 * order and the stage does not advance.
 */
async function cmdComplete(args: ParsedArgs, opts: RunCliOptions): Promise<number> {
  const threadId = threadIdOf(requireFlag(args, 'task'));
  const rawResult = requireFlag(args, 'result');
  const config = configOf(threadId);

  return withGraph(opts, async (graph) => {
    const state = await readState(graph, config);
    if (isEmptyState(state)) {
      throw new CliError('no_checkpoint', `no checkpoint for thread ${threadId}`);
    }
    const pending = firstInterrupt(state);
    if (!pending) {
      // Rules 1-4 below all need a pending interrupt. Without one the order
      // is not pending any more: it was already completed (or the run is
      // over). Completing it again would advance the stage a second time.
      throw new CliError('already_completed', `no pending work order for thread ${threadId}`);
    }
    if (audienceOf(pending.value) !== 'host') {
      throw new CliError(
        'audience_mismatch',
        `pending interrupt is not a host work order (audience: ${audienceOf(pending.value) ?? 'none'})`
      );
    }

    const parsed = WireWorkerResultSchema.safeParse(
      readJsonArgument(rawResult, 'invalid_result', '--result')
    );
    if (!parsed.success) {
      throw new CliError('invalid_result', describeIssues(parsed.error));
    }
    const result: WireWorkerResult = parsed.data;

    const order = workOrderOf(pending.value);
    if (order) {
      const missing = order.outputs.filter((file) => !fs.existsSync(file));
      if (missing.length > 0) {
        // The worker did not finish. The rejection goes to the graph: the
        // CLI cannot count, the graph can.
        return await rejectOrder(graph, config, threadId, pending, order, 'missing_outputs');
      }
      // Rule 4: a review order has to come back with a valid ReviewResult,
      // and a review that is present but malformed is never accepted either
      // (a prose "PASS" is a failed review, not a passed one).
      //
      // A worker that says it did not finish (`status: 'failed'`) is not a
      // broken review - the result goes to the graph as it is.
      const hasReview = result.review !== undefined;
      const reviewOk = ReviewResultSchema.safeParse(result.review).success;
      const expectsReview = order.resultSchema === 'review' && result.status === 'ok';
      if (!reviewOk && (hasReview || expectsReview)) {
        return await rejectOrder(graph, config, threadId, pending, order, 'invalid_review');
      }
    }

    await graph.invoke(new Command({ resume: result }), config);
    return reportOutcome(graph, config, threadId);
  });
}

/**
 * Hand a rejected result back to the graph.
 *
 * **The CLI does not count - the graph does.** The CLI is stateless: the
 * number of times a worker got the order wrong only exists in the graph's
 * state, so the CLI resumes the graph with the rejection marker and lets the
 * node that owns the order count it. The node re-issues the same order (the
 * first rejection) or escalates (the second one).
 *
 * The observable contract does not change: the run is parked on the same
 * work order and the stage does not advance.
 *
 * A node that does not know the marker (the stages that have no rejection
 * ledger yet) gets the pending interrupt back unchanged - the order is
 * re-issued as it was.
 *
 * @param graph - The graph of the run.
 * @param config - The LangGraph config of the thread.
 * @param threadId - The thread of the run.
 * @param pending - The interrupt the run is parked on.
 * @param order - The work order of that interrupt.
 * @param reason - Why the result was rejected.
 */
async function rejectOrder(
  graph: CompiledSddGraph,
  config: { configurable: { thread_id: string } },
  threadId: string,
  pending: PendingInterrupt,
  order: WorkOrder,
  reason: RejectionReason
): Promise<number> {
  if (!isRejectionAware(order.role)) {
    return emitInterrupt(pending, threadId, stageOfSnapshot(await readState(graph, config)));
  }

  await graph.invoke(new Command({ resume: rejectionMarker(reason) }), config);
  return reportOutcome(graph, config, threadId);
}

/** `approve --task <n> --payload <json|@file>`: answer a `user` gate. */
async function cmdApprove(args: ParsedArgs, opts: RunCliOptions): Promise<number> {
  const threadId = threadIdOf(requireFlag(args, 'task'));
  const rawPayload = requireFlag(args, 'payload');
  const config = configOf(threadId);

  return withGraph(opts, async (graph) => {
    const state = await readState(graph, config);
    if (isEmptyState(state)) {
      throw new CliError('no_checkpoint', `no checkpoint for thread ${threadId}`);
    }
    const pending = firstInterrupt(state);
    if (!pending) {
      throw new CliError('already_completed', `no pending interrupt for thread ${threadId}`);
    }
    if (audienceOf(pending.value) !== 'user') {
      throw new CliError(
        'audience_mismatch',
        `pending interrupt is not a user gate (audience: ${audienceOf(pending.value) ?? 'none'})`
      );
    }

    const payload = readJsonArgument(rawPayload, 'invalid_payload', '--payload');
    if (isResetAnswer(pending.value, payload)) {
      // `reset` throws the whole old run away - the run is not resumed.
      return await resetThread(graph, threadId, lockPathOf(opts, graph));
    }
    await graph.invoke(new Command({ resume: payload }), config);
    return reportOutcome(graph, config, threadId);
  });
}

/**
 * `reset`: throw the old run away.
 *
 * The contract (实现方案.md §6): "reset deletes the thread's checkpoint and
 * handles the workspace by the existing rules". The checkpoint is only
 * reachable here - the node has no checkpointer - so the CLI deletes it and
 * cleans the workspace. The next `start` then begins from scratch.
 *
 * **The order of the steps.** The lock goes first: a lock that is still held
 * by a task whose workspace no longer exists would keep every other task out,
 * and releasing it first means that no later failure can leave the lock
 * behind. The workspace goes last: it is the step that can fail on a
 * read-only disk, and by then the checkpoint is already gone.
 *
 * Every failure raises a `CliError` and names the state it leaves behind. A
 * reset that did not fully happen is never reported as `reset: true`.
 *
 * @throws CliError when a step fails - the message says what is left.
 */
async function resetThread(
  graph: CompiledSddGraph,
  threadId: string,
  lockPath: string
): Promise<number> {
  const saver = graph.checkpointer;
  if (!saver || typeof saver === 'boolean' || typeof saver.deleteThread !== 'function') {
    throw new CliError(
      'internal_error',
      `cannot reset thread ${threadId}: the checkpointer cannot delete threads, ` +
        'so the checkpoint would survive the reset'
    );
  }

  // Step 1: the lock goes with the run. Only this task's own lock - the lock
  // is global, releasing somebody else's would let a third task work on the
  // same branch.
  let releasedLock = false;
  const ownership = validateLockOwnership(threadId, lockPath);
  if (ownership.isLocked && ownership.isHolder) {
    const released = releaseLock(lockPath);
    if (!released.success) {
      throw new CliError(
        'internal_error',
        `cannot reset thread ${threadId}: the branch lock could not be released ` +
          `(${released.error ?? 'unknown error'}). Nothing was deleted - the thread, ` +
          'its checkpoint and its workspace are untouched.'
      );
    }
    releasedLock = true;
  }

  // Step 2: the checkpoint is the resume truth - it has to go.
  try {
    await saver.deleteThread(threadId);
  } catch (err) {
    throw new CliError(
      'internal_error',
      `cannot reset thread ${threadId}: the checkpoint could not be deleted ` +
        `(${errorMessage(err)}). ${lockClause(releasedLock)} The thread and its ` +
        'workspace are untouched.'
    );
  }

  // Step 3: the workspace goes last.
  try {
    cleanupTaskWorkspace(threadId);
  } catch (err) {
    throw new CliError(
      'internal_error',
      `cannot reset thread ${threadId}: the checkpoint was deleted but the workspace ` +
        `could not be removed (${errorMessage(err)}). ${lockClause(releasedLock)} ` +
        'The leftover workspace directory has to be removed by hand.'
    );
  }

  emitResult({ threadId, reset: true });
  return EXIT_OK;
}

/**
 * What the reset did to the branch lock.
 *
 * The lock is only released when **this** task held it - the lock is global,
 * another task's lock stays where it is. The message has to say which of the
 * two happened, instead of always claiming that the lock was released.
 */
function lockClause(releasedLock: boolean): string {
  return releasedLock
    ? 'The lock this task held was released.'
    : 'This task held no lock, so the reset did not touch the lock.';
}

/**
 * Is this answer a `reset` of an `already_exists` gate?
 *
 * Only that gate has a `reset`: every other answer resumes the run.
 */
function isResetAnswer(pendingValue: unknown, payload: unknown): boolean {
  return typeOf(pendingValue) === 'already_exists' && actionOf(payload) === 'reset';
}

/**
 * The lock file the CLI and the graph both work with.
 *
 * An explicit `lockPath` wins; otherwise the lock the graph's bootstrap node
 * uses is taken - a reset must release the very lock that was taken, not the
 * default one.
 */
function lockPathOf(opts: RunCliOptions, graph: CompiledSddGraph): string {
  return opts.lockPath ?? graph.lockPath ?? getLockFilePath();
}

/** `status --task <n>`: report the state without advancing anything. */
async function cmdStatus(args: ParsedArgs, opts: RunCliOptions): Promise<number> {
  const threadId = threadIdOf(requireFlag(args, 'task'));
  const config = configOf(threadId);

  return withGraph(opts, async (graph) => {
    const state = await readState(graph, config);
    if (isEmptyState(state)) {
      throw new CliError('no_checkpoint', `no checkpoint for thread ${threadId}`);
    }
    const pending = firstInterrupt(state);
    emitResult({
      stage: stageOfSnapshot(state),
      threadId,
      pending: pending
        ? { audience: audienceOf(pending.value) ?? 'user', type: typeOf(pending.value) }
        : null,
    });
    return EXIT_OK;
  });
}

/** `stop --task <n> [--force]`: release the branch lock, keep everything else. */
async function cmdStop(args: ParsedArgs, opts: RunCliOptions): Promise<number> {
  const threadId = threadIdOf(requireFlag(args, 'task'));
  const force = args.flags.has('force');
  const lockPath = opts.lockPath ?? getLockFilePath();

  // The lock is global: releasing a lock another task holds would let a
  // third task work on the same branch.
  const ownership = validateLockOwnership(threadId, lockPath);
  if (ownership.isLocked && !ownership.isHolder && !force) {
    throw new CliError(
      'lock_not_owned',
      `the branch lock is held by ${ownership.holderTaskName ?? 'another task'}`
    );
  }

  const result = force ? forceUnlock(lockPath) : releaseLock(lockPath);
  if (!result.success) {
    throw new CliError('internal_error', result.error ?? 'failed to release the lock');
  }

  // The checkpoint and the workspace are kept on purpose: the run can be
  // resumed with `resume`.
  emitResult({ threadId, stopped: true });
  return EXIT_OK;
}

/**
 * `change --task <n>`: the entry point of v1, and nothing else.
 *
 * **The command does not exist yet, and it says so.** The old
 * `/sdd-agent:change` was a one-way tape: it rewrote the documents of a
 * finished run and moved on. In this architecture the graph owns the routing,
 * so a change has to be able to send the run **back** to an earlier stage -
 * and that means the graph has to be able to change course from its
 * checkpoint, not to be restarted by hand.
 *
 * Until that exists, the command reports that it is not implemented and
 * exits with 1: a request that is silently ignored is a request the user
 * believes was handled.
 *
 * @throws CliError always - with the code `not_implemented`.
 */
function cmdChange(): never {
  throw new CliError(
    'not_implemented',
    '/sdd-graph:change 尚未實作：v1 只預留入口，圖狀態仍由階段路由推進。'
  );
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Parsed command line. */
interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
}

/** Parse `argv` into a command and its flags. */
function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      throw new CliError('invalid_arguments', `unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, 'true');
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliError('invalid_arguments', `--${name} needs a value`);
    }
    flags.set(name, value);
    i += 1;
  }
  return { command, flags };
}

/** Read a flag that the command cannot work without. */
function requireFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name);
  if (value === undefined || value === '') {
    throw new CliError('invalid_arguments', `--${name} is required`);
  }
  return value;
}

/**
 * Read a JSON argument.
 *
 * The value is either the JSON document itself or `@path` pointing at a file
 * that holds it.
 */
function readJsonArgument(raw: string, code: string, what: string): unknown {
  let text = raw;
  if (raw.startsWith('@')) {
    const file = raw.slice(1);
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      throw new CliError(code, `cannot read ${what} from ${file}: ${errorMessage(err)}`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(code, `${what} is not valid JSON`);
  }
}

/** Turn the graph the caller wants into a graph to work with. */
async function withGraph<T>(opts: RunCliOptions, fn: (graph: CompiledSddGraph) => Promise<T>): Promise<T> {
  if (opts.graph) {
    return fn(opts.graph);
  }
  const saver = createCheckpointer(opts.checkpointPath ?? getCheckpointPath());
  // The lock path has to reach the bootstrap node: `start` takes the lock
  // and `stop` releases it - they have to be the same lock.
  return fn(buildGraph({ checkpointer: saver, lockPath: opts.lockPath }));
}

/** The thread id of a task (= the normalized task name). */
function threadIdOf(task: string): string {
  return normalizeTaskName(task);
}

/** LangGraph config of a thread. */
function configOf(threadId: string): { configurable: { thread_id: string } } {
  return { configurable: { thread_id: threadId } };
}

/** Read the state snapshot of a thread. */
async function readState(
  graph: CompiledSddGraph,
  config: { configurable: { thread_id: string } }
): Promise<Snapshot> {
  const state = (await graph.getState(config)) as unknown as Snapshot;
  return {
    values: state.values ?? {},
    tasks: state.tasks ?? [],
    next: state.next ?? [],
  };
}

/**
 * A thread without a checkpoint has no state at all.
 *
 * `resume` has to check this before it invokes the graph: resuming a thread
 * that never ran throws `EmptyInputError`.
 */
function isEmptyState(state: Snapshot): boolean {
  return Object.keys(state.values).length === 0;
}

/** The pending interrupt of a snapshot, if there is one. */
function firstInterrupt(state: Snapshot): PendingInterrupt | null {
  for (const task of state.tasks) {
    const interrupts = task.interrupts ?? [];
    if (interrupts.length > 0) {
      return { id: interrupts[0].id, value: interrupts[0].value };
    }
  }
  return null;
}

/** The stage a snapshot is in. */
function stageOfSnapshot(state: Snapshot): string {
  const stage = state.values.currentStage;
  return typeof stage === 'string' ? stage : 'bootstrap';
}

/** The audience of an interrupt payload. */
function audienceOf(payload: unknown): 'user' | 'host' | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const audience = (payload as { audience?: unknown }).audience;
  return audience === 'user' || audience === 'host' ? audience : undefined;
}

/** The type of an interrupt payload. */
function typeOf(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return 'unknown';
  const type = (payload as { type?: unknown }).type;
  return typeof type === 'string' ? type : 'unknown';
}

/**
 * The work order a host interrupt carries, if it carries one.
 *
 * The payload of a work order interrupt is the work order itself (plus the
 * `type` that marks it as an interrupt); a node may also nest it under
 * `order`.
 *
 * A payload that has the shape of a work order but breaks the contract (a
 * relative path, say) is **refused** rather than ignored: checking a
 * relative path would judge it against whatever directory the CLI runs in.
 *
 * @throws CliError when the payload is a work order that breaks the contract.
 */
function workOrderOf(payload: unknown): WorkOrder | null {
  const candidate = orderCandidate(payload);
  if (!WorkOrderShapeSchema.safeParse(candidate).success) {
    // Not a work order at all (e.g. a host interrupt that only returns a
    // result): there is nothing to check.
    return null;
  }
  const order = WorkOrderSchema.safeParse(candidate);
  if (!order.success) {
    throw new CliError('invalid_order', describeIssues(order.error));
  }
  return order.data;
}

/** The object that may hold the work order of an interrupt payload. */
function orderCandidate(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const nested = payload as { order?: unknown; workOrder?: unknown };
  if (nested.order !== undefined) return nested.order;
  if (nested.workOrder !== undefined) return nested.workOrder;
  return payload;
}

/** Describe the issues of a failed zod parse. */
function describeIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

/** The message of an unknown error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Report the outcome of a graph run.
 *
 * The final state is always read from `getState()`: `invoke()` returns
 * `undefined` when the last node wrote nothing, so its return value is not a
 * reliable source for the state.
 */
async function reportOutcome(
  graph: CompiledSddGraph,
  config: { configurable: { thread_id: string } },
  threadId: string
): Promise<number> {
  const state = await readState(graph, config);
  // The mirror is refreshed on every step that moved the run.
  syncMirror(state.values);
  const pending = firstInterrupt(state);
  if (pending) {
    return emitInterrupt(pending, threadId, stageOfSnapshot(state));
  }
  emitResult({ stage: stageOfSnapshot(state), threadId });
  return EXIT_OK;
}

/**
 * Write the human-facing mirror of the state.
 *
 * **The mirror is for people, not for the run.** The truth of a run is the
 * checkpoint; the mirror is a copy that can be read (and committed) without
 * knowing anything about the plugin runtime - it is what `sdd-graph status`
 * points at, and what a reviewer reads in the repository.
 *
 * It is written **from the graph's own state**, read back from the
 * checkpointer: a host that hand-edits the file has its edit replaced on the
 * next command. The graph is the only writer.
 *
 * The write happens here rather than inside a node because a node cannot see
 * the state the graph merged *after* it returned - the CLI reads that merged
 * state back from the checkpointer, which is the same truth the next resume
 * will see.
 *
 * @throws CliError when the mirror cannot be written. A mirror that silently
 *   fails is worse than one that says so: the run would go on while the file
 *   everybody reads stays stale.
 */
function syncMirror(values: Record<string, unknown>): void {
  const requirementName = typeof values.requirementName === 'string' ? values.requirementName : '';
  const repoPath = typeof values.repoPath === 'string' ? values.repoPath : '';
  // Before the bootstrap there is no workspace to write the mirror into.
  if (requirementName === '' || repoPath === '') return;

  try {
    new ArtifactStore(requirementName, repoPath).sync(values as unknown as SddState);
  } catch (err) {
    throw new CliError(
      'internal_error',
      `cannot write the workflow state mirror ` +
        `(${path.join(getDocsDir(requirementName, repoPath), 'workflow-state.json')}): ` +
        errorMessage(err)
    );
  }
}

/** Print an interrupt envelope and return the exit code. */
function emitInterrupt(pending: PendingInterrupt, threadId: string, stage: string): number {
  const audience = audienceOf(pending.value);
  if (!audience) {
    // Every interrupt payload has to carry an audience. A payload without one
    // is a contract violation - guessing would turn a work order into a
    // question the host may answer with `approve`.
    throw new CliError('audience_mismatch', 'the pending interrupt carries no audience');
  }
  writeOut(
    envelope('interrupt', {
      audience,
      type: typeOf(pending.value),
      threadId,
      stage,
      payload: pending.value,
      interruptId: pending.id,
    })
  );
  return EXIT_INTERRUPT;
}

/** Print a result envelope. */
function emitResult(body: Record<string, unknown>): void {
  writeOut(envelope('result', body));
}

/** Write one line to stdout. */
function writeOut(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** Write one line to stderr. */
function writeErr(text: string): void {
  process.stderr.write(`${text}\n`);
}

/** Wait until the pending stdout writes have been handed to the OS. */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdout.writableLength === 0) {
      resolve();
      return;
    }
    process.stdout.once('drain', () => resolve());
  });
}

/* ------------------------------------------------------------------ */
/* executable                                                          */
/* ------------------------------------------------------------------ */

/** True when this module is the process entry point (`bin/sdd-graph`). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  void main();
}
