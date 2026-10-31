import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { listLegacyThreads, migrateState } from '../commands/migrate-state.js';
import { buildGraph } from '../graph/compile.js';
import type { CompiledSddGraph } from '../graph/compile.js';
import { measureFidelity } from '../figma/fidelity.js';
import type { GraphState } from '../graph/state.js';
import { actionOf } from '../nodes/bootstrap.js';
import { reviewRoles } from '../nodes/review.js';
import { ArtifactStore } from '../persistence/artifact-store.js';
import { createCheckpointer } from '../persistence/checkpoint.js';
import {
  forceUnlock,
  getLock,
  releaseLock,
  validateLockOwnership,
} from '../runtime/branch-lock.js';
import { createError, SddAbortError } from '../runtime/errors.js';
import {
  canonicalRepoRoot,
  getCheckpointPath,
  getDocsDir,
  getLockFilePath,
  getPluginRoot,
  getWorkspaceBase,
} from '../runtime/paths.js';
import { defaultSddHome, setRunContext } from '../runtime/run-context.js';
import type { RepoMode, RunContext } from '../runtime/run-context.js';
import { gitTopLevel, RepoResolutionError, resolveRepo } from '../runtime/repo-resolver.js';
import type { ResolvedRepo } from '../runtime/repo-resolver.js';
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
 * sdd-graph start   --task <n> [--repo <path|url>]
 * sdd-graph resume  --task <n>
 * sdd-graph complete --task <n> --result <json|@file>
 * sdd-graph approve  --task <n> --payload <json|@file>
 * sdd-graph status   --task <n>
 * sdd-graph stop     --task <n> [--force]
 * sdd-graph migrate  [--repo <path>]     （把舊的全域 checkpoint 搬進 .sdd/）
 * sdd-graph change   --task <n>          （v1 只預留：回 1 not_implemented）
 * sdd-graph figma-diff --docs <dir> [--repo <dir>]
 * ```
 *
 * **`--repo` 缺省就是目前的工作目錄**（就地工作）：程式碼直接寫在使用者的
 * 業務倉庫裡。給了 URL 的舊用法不變——那是把倉庫複製一份到外掛目錄裡工作。
 * 兩種模式由 `--repo` 的形態決定，解析規則見 `src/runtime/repo-resolver.ts`。
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
 * **`figma-diff` is the exception**: it does not touch the graph, and its
 * caller has to tell "the prototype does not match the design" apart from
 * "the command could not run". It therefore has its own exit codes:
 *
 * | exit | meaning                                              |
 * |------|------------------------------------------------------|
 * | 0    | measured, no hard failure                            |
 * | 1    | measured, at least one hard failure                   |
 * | 2    | the command could not run (bad arguments)             |
 *
 * The error codes the host may see on stderr: `invalid_arguments`,
 * `no_checkpoint`, `audience_mismatch`, `invalid_result`, `invalid_payload`,
 * `invalid_order`, `already_completed`, `lock_not_owned`, `not_implemented`,
 * `validation_error`, `aborted`, `internal_error`.
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
  /**
   * 舊的全域 checkpoint 庫（`migrate` 用）。
   *
   * 預設是外掛根底下的那一份；測試指向臨時目錄——否則測試會動到開發者
   * 自己正在用的舊庫。
   */
  legacyCheckpointPath?: string;
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
  reviews: z.unknown().optional(),
});

/** A worker result as it arrives over the wire. */
type WireWorkerResult = z.infer<typeof WireWorkerResultSchema>;

/** An error the CLI reports as `{"kind":"error","code":...}`. */
class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /**
     * 機器可讀的補充資料（會一起放進 error 信封）。
     *
     * **部分成功也要結構化**：命令做了一半才失敗時，使用者拿得到
     * 「已經搬了哪些、還有哪些沒搬」，不必從訊息裡的字句猜。
     */
    readonly details?: Record<string, unknown>
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
      case 'migrate':
        return await cmdMigrate(args, opts);
      case 'change':
        return cmdChange();
      case 'figma-diff':
        return await cmdFigmaDiff(args);
      default:
        throw new CliError('invalid_arguments', `unknown command: ${args.command || '<none>'}`);
    }
  } catch (err) {
    if (err instanceof CliError) {
      writeErr(
        envelope('error', {
          code: err.code,
          message: err.message,
          ...(err.details ?? {}),
        })
      );
      return EXIT_ERROR;
    }
    if (err instanceof SddAbortError) {
      // **使用者喊停不是插件壞了**：這是使用者自己的決定，退出碼與錯誤碼
      // 都得跟「內部錯誤」分開，宿主才知道這不是要重試的故障。
      writeErr(envelope('error', { code: err.code, message: err.message }));
      return EXIT_ERROR;
    }
    if (err instanceof RepoResolutionError) {
      // 路徑寫錯、不是 git 倉庫——那是使用者要改的事，不是內部錯誤。
      // 復用既有的結構化錯誤機制（`createError`）決定錯誤碼與分類，
      // 不再長出第四種錯誤形態。
      //
      // **`validation_error` 的 recoveryHint 講的是 task 名稱格式**，
      // 對「`--repo` 的路徑寫錯」是誤導；而 `RepoResolutionError` 的訊息裡
      // 已經把該怎麼改講清楚了，所以訊息以它為準。
      const structured = createError(err.code, err.message);
      writeErr(envelope('error', { code: structured.code, message: structured.message }));
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

/**
 * `start --task <n> [--repo <path|url>]`: begin a run (or hand back what is pending).
 *
 * **`--repo` 缺省就是目前的工作目錄**（就地工作）：程式碼直接寫在使用者的
 * 業務倉庫裡，運行時狀態寫在 `<repoRoot>/.sdd/` 之下。給了 URL 的舊用法不變——
 * 那是把倉庫複製一份到外掛目錄裡工作。
 *
 * **解析必須在建圖之前**：節點要靠運行上下文知道自己在哪個倉庫裡工作，
 * 而上下文是模組級單例——晚一步設定，節點就已經用錯的路徑了。
 */
async function cmdStart(args: ParsedArgs, opts: RunCliOptions): Promise<number> {
  const threadId = threadIdOf(requireFlag(args, 'task'));
  const repoSpec = args.flags.get('repo') ?? process.cwd();
  const config = configOf(threadId);

  const resolved = resolveRepo(repoSpec, process.cwd());
  // **就地模式只認目前目錄所在的倉庫**：整個設計的前提是「命令在哪個業務
  // 倉庫目錄裡執行，就操作那個倉庫的同名 task」。允許 `--repo` 指向另一個
  // 倉庫會造出兩種壞掉的 run：之後在任何地方都找不到它，而且「在 repo A
  // 啟動、在 repo B 裡 resume」會把 run 綁到 B 的同名 task 上——模式與
  // `start` 設的不一樣。
  if (resolved.mode === 'local') {
    assertSameRepoAsCwd(resolved.repoRoot);
  }
  setRunContext(contextOf(resolved));

  // 就地模式不該把本機絕對路徑寫進要進版本庫的 `workflow-state.json` 鏡像：
  // 寫遠端地址，寫不出來就寫 `local:<目錄名>`。
  const repoUrl =
    resolved.mode === 'local' ? localRepoUrl(resolved.repoRoot) : resolved.remoteUrl ?? repoSpec;
  // `.sdd` 沒被 git 忽略時提醒使用者一句（只提示，不改他的 .gitignore）。
  const notice = resolved.mode === 'local' ? gitignoreNotice(resolved.repoRoot) : undefined;

  return withGraph(opts, async (graph) => {
    const state = await readState(graph, config);
    const pending = firstInterrupt(state);
    if (pending) {
      // The thread already has work in flight: hand the same order back
      // instead of starting a second run on top of it.
      return emitInterrupt(pending, threadId, stageOfSnapshot(state), notice);
    }
    await graph.invoke({ requirementName: threadId, repoUrl } as GraphState, config);
    return reportOutcome(graph, config, threadId, notice);
  });
}

/** `resume --task <n>`: re-issue whatever the thread is parked on. */
async function cmdResume(args: ParsedArgs, opts: RunCliOptions): Promise<number> {
  const threadId = threadIdOf(requireFlag(args, 'task'));
  const config = configOf(threadId);

  return withGraphForThread(threadId, opts, async (graph) => {
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

  return withGraphForThread(threadId, opts, async (graph) => {
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
      //
      // **The combined reviewer answers two questions in one order.** The
      // answer may carry the reviews in `reviews` or in `review`; either
      // way both roles have to be there.
      const roles = reviewRoles(result.reviews, result.review);
      const hasReview = result.review !== undefined || result.reviews !== undefined;
      const reviewOk = roles.has('spec') && roles.has('quality');
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

  return withGraphForThread(threadId, opts, async (graph) => {
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

  return withGraphForThread(threadId, opts, async (graph) => {
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
  const lockPath = opts.lockPath ?? resolveLockPath(threadId);

  // The lock is global: releasing a lock another task holds would let a
  // third task work on the same branch.
  //
  // **`--force` 也不越界（行為變更）**：以前 `--force` 會把別的 task 握著的
  // 鎖直接刪掉，那等於替別人中止了他正在跑的那一輪——而且刪掉的是**所有倉庫
  // 共用的全域鎖**，別的倉庫正在跑的 run 會因此失去保護。
  // 現在 `--force` 只處理「沒有活著的持有者」的鎖（自己的、壞掉的、已停的）；
  // 別的 task 還握著就報錯，讓使用者先 `stop --task <那個 task>`。
  const ownership = validateLockOwnership(threadId, lockPath);
  if (ownership.isLocked && !ownership.isHolder) {
    throw new CliError(
      'lock_not_owned',
      `the branch lock is held by ${ownership.holderTaskName ?? 'another task'}` +
        '；請先 stop 那個 task，或等它跑完'
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
 * `migrate [--repo <path>]`：把舊的全域 checkpoint 搬進業務倉庫的 `.sdd/` 之下。
 *
 * **搬運是逐個 thread 判歸屬的，不是整庫複製**：舊庫裡可能躺著好幾個倉庫的
 * run，整庫複製會把別的倉庫的 run 也搬過來——那正是這次改造要修的問題。
 * 判準只有一個：舊 thread 的 `repoUrl` 是不是等於這個倉庫的
 * `remote.origin.url`。
 *
 * **沒有遠端地址就一條都不搬**：沒有判準就沒有歸屬，硬搬就是把別的倉庫的 run
 * 搬過來。舊庫原封不動留著（搬運前會備份一份 `.bak`），剩下的由使用者確認
 * 後自己清理。
 *
 * @throws CliError `validation_error` —— `--repo` 不是一個本機倉庫。
 */
async function cmdMigrate(args: ParsedArgs, opts: RunCliOptions): Promise<number> {
  const repoSpec = args.flags.get('repo') ?? process.cwd();
  const resolved = resolveRepo(repoSpec, process.cwd());
  if (resolved.mode !== 'local') {
    throw new CliError(
      'validation_error',
      'migrate 需要一個本機倉庫（狀態要搬進那個倉庫的 .sdd/ 之下）；' +
        `--repo 給的是遠端網址（${resolved.remoteUrl ?? repoSpec}），請改成倉庫路徑`
    );
  }
  const repoRoot = canonicalRepoRoot(resolved.repoRoot);
  const legacyDbPath =
    opts.legacyCheckpointPath ?? path.join(getPluginRoot(), 'runtime', 'checkpoints.sqlite');
  const targetDbPath = path.join(defaultSddHome(repoRoot), 'checkpoints.sqlite');
  const remoteUrl = readRemoteOriginUrl(repoRoot);

  const notices: string[] = [];

  // **舊鎖不遷**：那把鎖是全域單例，可能握在別的倉庫的 task 手上——動它就是
  // 動到別人正在跑的那一輪。只提示，不碰。
  const legacyLock = getLock(path.join(path.dirname(legacyDbPath), 'branch-runtime-lock.json'));
  if (legacyLock?.running) {
    notices.push(
      `舊的分支鎖仍指向 ${legacyLock.taskName}，請先 stop 那個 task（遷移不會動鎖）`
    );
  }

  if (remoteUrl === undefined) {
    // **沒有遠端地址就無法判定歸屬**：一條都不搬，只把還在舊庫的 thread 報出來。
    const skipped = await listLegacyThreads(legacyDbPath);
    notices.unshift('這個倉庫沒有 remote.origin.url，無法判定歸屬，所以一條都沒搬');
    emitResult({
      command: 'migrate',
      migrated: [],
      skipped,
      skippedReasons: Object.fromEntries(
        skipped.map((threadId) => [threadId, '這個倉庫沒有 remote.origin.url，無法判定歸屬'])
      ),
      mixed: [],
      target: targetDbPath,
      notice: notices.join('；'),
    });
    return EXIT_OK;
  }

  const result = await migrateState({ legacyDbPath, targetDbPath, matchUrl: remoteUrl });
  if (result.error !== undefined) {
    // **部分成功也要結構化**：使用者拿得到「已經搬了哪些、還有哪些沒搬」，
    // 不必從訊息裡的字句猜。
    throw new CliError('internal_error', result.error, {
      migrated: result.migrated,
      skipped: result.skipped,
      skippedReasons: result.skippedReasons ?? {},
      mixed: result.mixed ?? [],
    });
  }

  if (result.migrated.length === 0) {
    notices.push('沒有可搬的 thread（都已經搬過了，或剩下的不屬於這個倉庫）');
  }
  if ((result.mixed ?? []).length > 0) {
    notices.push(
      `有 ${(result.mixed ?? []).length} 條 thread 混了兩個倉庫的 checkpoint，沒有搬（請手動處理）`
    );
  }

  emitResult({
    command: 'migrate',
    migrated: result.migrated,
    skipped: result.skipped,
    skippedReasons: result.skippedReasons ?? {},
    mixed: result.mixed ?? [],
    target: targetDbPath,
    ...(result.backupPath === undefined ? {} : { backup: result.backupPath }),
    notice: notices.join('；'),
  });
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

/**
 * `figma-diff --docs <dir> [--repo <dir>]`: measure the prototype against
 * the Figma screenshots.
 *
 * The worker calls this to iterate on the prototype, the graph calls it to
 * produce the report that goes into the requirement documents. Both get the
 * same numbers, because both call the same code.
 *
 * **The exit codes are the contract**:
 *
 * | exit | meaning                                              |
 * |------|------------------------------------------------------|
 * | 0    | measured, no hard failure                            |
 * | 1    | measured, at least one hard failure                   |
 * | 2    | the command could not run (bad arguments)             |
 *
 * A hard failure is a frame that could not be measured at all - no
 * prototype page, a page that does not render, a screenshot of a different
 * size. A frame that was measured and differs a little is **not** a hard
 * failure: the pixel ratio is a hint, not a verdict.
 */
async function cmdFigmaDiff(args: ParsedArgs): Promise<number> {
  const docsDir = args.flags.get('docs');
  if (docsDir === undefined || docsDir === '') {
    writeErr(envelope('error', { code: 'invalid_arguments', message: '--docs is required' }));
    return 2;
  }
  if (!fs.existsSync(docsDir)) {
    writeErr(
      envelope('error', {
        code: 'invalid_arguments',
        message: `no such docs directory: ${docsDir}`,
      })
    );
    return 2;
  }

  const repoDir = args.flags.get('repo') ?? process.cwd();
  const report = await measureFidelity({ docsDir, repoDir });

  emitResult({
    command: 'figma-diff',
    frames: report.frames,
    hardFailures: report.hardFailures,
    report: report.mdPath,
  });

  return report.hardFailures > 0 ? 1 : 0;
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

/**
 * 一個 checkpoint 候選位置。
 *
 * **候選不只是「一個路徑」**：命中哪一個，就照哪一個的模式設定運行上下文
 * （就地 = 使用者的業務倉庫，遠端 = 外掛根）——兩邊的狀態不能互相污染。
 */
interface CheckpointCandidate {
  /** 就地 = 使用者的業務倉庫；遠端 = 外掛的舊位置。 */
  mode: RepoMode;
  /** local: 業務倉庫根；remote: 外掛根。 */
  repoRoot: string;
  /** 運行時狀態根（checkpoint 與分支鎖都住在它底下）。 */
  sddHome: string;
  /** checkpoint 資料庫。 */
  checkpointPath: string;
  /** 分支鎖檔。 */
  lockPath: string;
  /**
   * 這個位置為什麼查不了（有的話）。
   *
   * **被跳過的位置也要寫進錯誤訊息**：使用者最需要知道的就是
   * 「你的 task 可能在某個業務倉庫的 `.sdd` 裡，請 cd 到那裡再試」。
   */
  unavailable?: string;
}

/**
 * 這輪運行的 checkpoint 可能在哪裡。
 *
 * **順序有意義**：就地的位置先查，外掛的舊位置後查。
 *
 * - 先查就地：同一個倉庫裡的兩輪 run 不該看見對方的 checkpoint，
 *   而且使用者最可能就是在自己的專案目錄裡下指令。
 * - 後查舊位置：遠端模式的用法（`--repo <url>` + 之後的 `resume`）不能被
 *   這次改動打斷——查不到就地位置時必須往回落。
 *
 * **cwd 不在 git 倉庫裡時就地位置查不了，但還是列在清單裡**：
 * 錯誤訊息要告訴使用者「就地的那一份存在哪裡、為什麼沒查」。
 *
 * @param cwd - 使用者目前所在的目錄
 */
function resolveCheckpointCandidates(cwd: string): CheckpointCandidate[] {
  const candidates: CheckpointCandidate[] = [];

  const top = gitTopLevel(cwd);
  if (top !== undefined) {
    const repoRoot = canonicalRepoRoot(top);
    // **不是 `<repoRoot>/.sdd` 寫死**：`SDD_GRAPH_SDD_HOME` 要能覆寫狀態根。
    const sddHome = defaultSddHome(repoRoot);
    candidates.push({
      mode: 'local',
      repoRoot,
      sddHome,
      checkpointPath: path.join(sddHome, 'checkpoints.sqlite'),
      lockPath: path.join(sddHome, 'branch-lock.json'),
    });
  } else {
    // **查不了就地位置，但使用者最需要知道它**：這裡的檔案路徑只是給
    // 錯誤訊息看的（猜測：倉庫就在 cwd 底下），不是真的會去開它。
    candidates.push({
      mode: 'local',
      repoRoot: '',
      sddHome: '',
      checkpointPath: path.join(cwd, '.sdd', 'checkpoints.sqlite'),
      lockPath: '',
      unavailable: '目前目錄不在 git 倉庫裡，沒有就地工作的位置可查',
    });
  }

  const pluginRoot = getPluginRoot();
  candidates.push({
    mode: 'remote',
    repoRoot: pluginRoot,
    sddHome: path.join(pluginRoot, 'runtime'),
    checkpointPath: path.join(pluginRoot, 'runtime', 'checkpoints.sqlite'),
    lockPath: path.join(pluginRoot, 'runtime', 'branch-runtime-lock.json'),
  });

  return candidates;
}

/**
 * 這個候選位置在錯誤訊息裡怎麼說。
 *
 * **被跳過的位置也要列出來**：使用者要知道插件去哪裡找過、為什麼沒查。
 */
function describeCandidate(candidate: CheckpointCandidate): string {
  if (candidate.unavailable) {
    return `${candidate.checkpointPath}（${candidate.unavailable}）`;
  }
  if (!fs.existsSync(candidate.checkpointPath)) {
    return `${candidate.checkpointPath}（檔案不存在）`;
  }
  return candidate.checkpointPath;
}

/**
 * 用命中那個候選的運行上下文工作。
 *
 * **查不到就拋 `no_checkpoint`，訊息裡列出查過的位置**：使用者要知道插件
 * 到底去哪裡找過，才好知道要往哪裡放東西。
 *
 * @throws CliError `no_checkpoint` —— 兩個位置都沒有這個 thread。
 */
async function withGraphForThread<T>(
  threadId: string,
  opts: RunCliOptions,
  fn: (graph: CompiledSddGraph) => Promise<T>
): Promise<T> {
  // 測試注入的路徑優先：既有行為（`opts.graph` / `opts.checkpointPath`）不改。
  if (opts.graph) {
    return fn(opts.graph);
  }
  if (opts.checkpointPath) {
    return withGraph(opts, fn);
  }

  const candidates = resolveCheckpointCandidates(process.cwd());
  const config = configOf(threadId);

  for (const candidate of candidates) {
    // 這個位置根本查不了（cwd 不在 git 倉庫裡）。
    if (candidate.unavailable) {
      continue;
    }
    // 沒有檔案就沒有 thread：**不開資料庫**，免得在使用者的倉庫裡憑空造出
    // 一個 `.sdd/checkpoints.sqlite`。
    if (!fs.existsSync(candidate.checkpointPath)) {
      continue;
    }
    setRunContext(contextOfCandidate(candidate));
    const saver = createCheckpointer(candidate.checkpointPath);
    const graph = buildGraph({ checkpointer: saver, lockPath: opts.lockPath ?? candidate.lockPath });
    const state = await readState(graph, config);
    if (!isEmptyState(state)) {
      return fn(graph);
    }
  }

  // 兩個位置都沒有這一輪：上下文回到預設（外掛根的遠端模式），
  // 別讓剛才探過就地位置留下的上下文留在原地。
  setRunContext(remoteContext());
  throw new CliError(
    'no_checkpoint',
    `no checkpoint for thread ${threadId} (searched: ${candidates
      .map((candidate) => describeCandidate(candidate))
      .join(', ')})`
  );
}

/**
 * 候選位置對應的運行上下文。
 *
 * **兩邊不能互相污染**：就地候選用的是業務倉庫的 `.sdd`，遠端候選用的是
 * 外掛根的 `runtime/`——查到哪一個就照哪一個設。
 */
function contextOfCandidate(candidate: CheckpointCandidate): RunContext {
  if (candidate.mode === 'remote') {
    return remoteContext();
  }
  return {
    mode: 'local',
    repoRoot: candidate.repoRoot,
    sddHome: candidate.sddHome,
    workspaceBase: getWorkspaceBase(),
  };
}

/**
 * 解析後的倉庫對應的運行上下文。
 *
 * **就地與遠端的路徑來自不同的家**：就地模式的狀態在使用者的業務倉庫裡，
 * 遠端模式的一律在外掛根底下——兩邊不能互相污染。
 */
function contextOf(resolved: ResolvedRepo): RunContext {
  if (resolved.mode === 'local') {
    // **正規化過的路徑**：鎖檔、run-metadata、回報的 repoPath 必須指向
    // 同一個物理路徑（macOS 的 `/var` 是 `/private/var` 的符號連結）。
    const repoRoot = canonicalRepoRoot(resolved.repoRoot);
    return {
      mode: 'local',
      repoRoot,
      // **必須是 `defaultSddHome()` 的結果**：`getSddHome()` 原樣返回上下文裡的
      // 值，自己不套 `SDD_GRAPH_SDD_HOME`——不傳等於那個環境變數失效。
      sddHome: defaultSddHome(repoRoot),
      workspaceBase: getWorkspaceBase(),
    };
  }
  return remoteContext();
}

/**
 * 外掛根的遠端模式上下文（未設置上下文時的預設值）。
 *
 * **遠端模式的 `repoRoot` 是外掛根**：真正被複製出來的倉庫還不存在，
 * 它要等複製完才知道——但節點要的是「這輪運行在哪裡工作」，所以先給外掛根。
 */
function remoteContext(): RunContext {
  const pluginRoot = getPluginRoot();
  return {
    mode: 'remote',
    repoRoot: pluginRoot,
    sddHome: path.join(pluginRoot, 'runtime'),
    workspaceBase: getWorkspaceBase(),
  };
}

/**
 * 就地模式的目標倉庫必須就是目前目錄所在的倉庫。
 *
 * **兩個路徑正規化後要一樣**：正規化（`canonicalRepoRoot`）讓 macOS 的
 * `/var` 與 `/private/var` 不會被當成兩個倉庫；比較的是**倉庫根**，
 * 所以倉庫裡的子目錄（`--repo .`、cwd 在 `src/` 底下）都算同一個倉庫。
 *
 * @param repoRoot - `--repo` 解析出來的倉庫根
 * @throws CliError `validation_error` —— 目標不是目前目錄所在的倉庫。
 */
function assertSameRepoAsCwd(repoRoot: string): void {
  const cwdTop = gitTopLevel(process.cwd());
  if (cwdTop !== undefined && canonicalRepoRoot(cwdTop) === canonicalRepoRoot(repoRoot)) {
    return;
  }
  throw new CliError(
    'validation_error',
    '就地模式要求在業務倉庫目錄裡執行；請 cd 到那個倉庫後省略 --repo' +
      `（--repo 指向 ${repoRoot}，與目前目錄的倉庫不同）`
  );
}

/**
 * 這輪運行的分支鎖在哪裡。
 *
 * **鎖在哪裡，決定了這輪 run 是哪一種**：就地模式的鎖在自己的 `.sdd/` 之下，
 * 遠端模式的鎖在外掛根的 `runtime/` 之下。`stop` 不接收 `--repo`，所以只能
 * 靠候選的歸屬判斷。
 *
 * **三段規則，順序有意義**：
 * 1. 握著這個 task 的鎖 → 就是它；
 * 2. 否則取**第一個鎖檔存在**的候選 → 錯誤訊息講的是「你現在這個倉庫」
 *    的那把鎖，而不是別的倉庫的；
 * 3. 一個都不存在 → 取第一個可用的候選（回報「沒有鎖」用）。
 *
 * **絕不無條件回落到全域鎖**：全域鎖是所有倉庫共用的，動它就是動到別的
 * 倉庫正在跑的那一輪——使用者只是在自己的專案目錄裡下了 `stop`。
 */
function resolveLockPath(threadId: string): string {
  const candidates = resolveCheckpointCandidates(process.cwd());
  const usable = candidates.filter((candidate) => !candidate.unavailable);

  for (const candidate of usable) {
    const lock = getLock(candidate.lockPath);
    if (lock?.running && lock.taskName === threadId) {
      return candidate.lockPath;
    }
  }
  for (const candidate of usable) {
    if (fs.existsSync(candidate.lockPath)) {
      return candidate.lockPath;
    }
  }
  return (usable[0] ?? candidates[candidates.length - 1]).lockPath;
}

/**
 * 這個倉庫的遠端網址（`remote.origin.url`）。
 *
 * **沒有遠端就回傳 undefined**：遷移靠它判定歸屬，沒有判準就不能搬
 * （見 `cmdMigrate`）。
 *
 * @param repoRoot - 業務倉庫根
 * @returns 遠端網址；倉庫沒有遠端（或 git 失敗）時是 undefined
 */
function readRemoteOriginUrl(repoRoot: string): string | undefined {
  try {
    const url = execFileSync('git', ['-C', repoRoot, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    return url === '' ? undefined : url;
  } catch {
    // 沒有遠端（或 git 失敗）。
    return undefined;
  }
}

/**
 * 就地模式寫進 state 的倉庫標記。
 *
 * **不能是本機絕對路徑**：那份鏡像要進版本庫，寫進去的是每台機器都不一樣的
 * 路徑。寫遠端地址；沒有遠端（或遠端本身就是一個本機路徑）就寫
 * `local:<目錄名>`——至少看得出是哪個專案。
 *
 * @param repoRoot - 業務倉庫根
 */
function localRepoUrl(repoRoot: string): string {
  const url = readRemoteOriginUrl(repoRoot);
  if (url !== undefined && !looksLikeLocalPath(url)) {
    return url;
  }
  return `local:${path.basename(repoRoot)}`;
}

/**
 * 這個 remote url 是不是一個本機檔案系統路徑？
 *
 * **`remote.origin.url` 也可能指著本機的一個目錄**（`/Users/x/repos/foo`、
 * `file:///Users/x/repos/foo`、相對路徑……）。那樣的絕對路徑一樣不該進
 * 版本庫——這正是這個函式要避免的事。
 *
 * 認得的三種形狀：`file://`、Windows 磁碟路徑（`C:\...`）、以及沒有 scheme
 * 也沒有 scp 語法（`git@host:path` 之外）的路徑。
 */
function looksLikeLocalPath(url: string): boolean {
  if (url.startsWith('file://')) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/.test(url)) {
    return true;
  }
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
    return true;
  }
  // 沒有 `:` = 沒有 scheme、也不是 `git@host:path` → 是檔案系統路徑。
  return !url.includes(':');
}

/**
 * `.sdd` 沒被 git 忽略時給使用者的提示。
 *
 * **只提示，不代勞**：`.gitignore` 是受版本控制的檔案，插件偷偷改它會污染
 * 使用者的 commit。要不要忽略 `.sdd/` 是使用者自己的決定。
 *
 * @param repoRoot - 業務倉庫根
 * @returns 提示文字；已經被忽略時為 undefined。
 */
function gitignoreNotice(repoRoot: string): string | undefined {
  // **問的是目錄**（`.sdd/`）：忽略規則裡的 `/.sdd/` 只匹配目錄，
  // 用檔案的路徑去問，git 會說「沒被忽略」——那是錯的。
  return isIgnoredByGit(repoRoot, '.sdd/') ? undefined : '請把 /.sdd/ 加進 .gitignore';
}

/**
 * 這個路徑有沒有被 git 的忽略規則蓋到？
 *
 * **問 git，不要自己解析 `.gitignore`**：忽略規則可以寫在好幾個檔案裡，
 * 還有 `.git/info/exclude` 與全域的 `core.excludesFile`——自己解析一定漏。
 *
 * **路徑要不要帶斜線有語意**：只匹配目錄的規則（`/.sdd/`）配的是目錄，
 * 拿檔案的路徑去問，git 會說「沒被忽略」。要問目錄就給它一個尾斜線。
 *
 * `git check-ignore` 對「沒被忽略」回傳退出碼 1（不是錯誤），所以退出碼
 * 1 與其他失敗都當成「沒被忽略」：多一句提示無害，少一句才會漏掉真正的問題。
 *
 * **「git 失敗」也落在同一邊**：git 不在 PATH、目錄不是倉庫、逾時——
 * 全都回 false（當成沒被忽略），因為使用者寧可多看到一句提醒，
 * 也不要以為 `.sdd/` 已經被忽略而把它 commit 進去。
 *
 * @param repoRoot - 倉庫根
 * @param relativePath - 相對於倉庫根的路徑
 */
function isIgnoredByGit(repoRoot: string, relativePath: string): boolean {
  try {
    execFileSync('git', ['-C', repoRoot, 'check-ignore', relativePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    return true;
  } catch {
    return false;
  }
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
 *
 * @param notice - 要附在信封上的提示（例如 `.sdd` 沒被 git 忽略）。
 */
async function reportOutcome(
  graph: CompiledSddGraph,
  config: { configurable: { thread_id: string } },
  threadId: string,
  notice?: string
): Promise<number> {
  const state = await readState(graph, config);
  // The mirror is refreshed on every step that moved the run.
  syncMirror(state.values);
  const pending = firstInterrupt(state);
  const stage = stageOfSnapshot(state);
  if (pending) {
    return emitInterrupt(pending, threadId, stage, notice);
  }
  emitResult(notice === undefined ? { stage, threadId } : { stage, threadId, notice });
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

/**
 * Print an interrupt envelope and return the exit code.
 *
 * @param notice - 要附在信封上的提示（例如 `.sdd` 沒被 git 忽略）。
 */
function emitInterrupt(
  pending: PendingInterrupt,
  threadId: string,
  stage: string,
  notice?: string
): number {
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
      ...(notice === undefined ? {} : { notice }),
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
