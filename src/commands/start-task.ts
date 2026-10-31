import * as fs from 'fs';
import * as path from 'path';
import { acquireLock, getLock, releaseLock } from '../runtime/branch-lock.js';
import type { ErrorCode } from '../runtime/errors.js';
import {
  applyLocalBranch,
  cloneBranch,
  DIRTY_WORKTREE_MESSAGE,
  planLocalBranch,
} from '../runtime/git-branch-manager.js';
import { isGitRepository } from '../runtime/git-tags.js';
import {
  canonicalRepoRoot,
  getLockFilePath,
  getRepoDir,
  getRunMetadataPath,
  getTaskDir,
} from '../runtime/paths.js';
import { getRunContext, isLocalMode, setRunContext } from '../runtime/run-context.js';
import type { RunContext } from '../runtime/run-context.js';
import { generateBranchName, generateRunId, validateTaskName } from '../runtime/task-name.js';
import { initTaskWorkspace, taskWorkspaceExists } from '../runtime/task-workspace.js';

/**
 * The deterministic setup of a run: workspace, branch lock, clone.
 *
 * It is a plain function, not a graph node: the bootstrap node
 * (`src/nodes/bootstrap.ts`) is the only caller in the graph.
 *
 * **The order of the steps matters.** Everything that can fail has to fail
 * *before* the first side effect, because the bootstrap node turns a failure
 * into an `interrupt()`: a side effect that happened before the interrupt
 * would run a second time when the node is executed again on resume.
 *
 * **兩種模式**（由運行上下文決定，見 `src/runtime/run-context.ts`）：
 * - `remote`：舊的行為——把倉庫 clone 一份到外掛的 workspace 目錄裡；
 * - `local`（就地工作）：不 clone，程式碼直接寫在使用者的業務倉庫裡，
 *   運行時狀態寫在 `<repoRoot>/.sdd` 之下。
 */

/** The outcome of a start attempt. */
export interface StartTaskResult {
  success: boolean;
  taskName: string;
  normalizedTaskName: string;
  branch: string;
  repoPath: string;
  runId: string;
  error?: string;
  errorCode?: ErrorCode;
  /** Who holds the branch lock - only set for a `lock_conflict`. */
  holderTaskName?: string;
}

/** Options of {@link startTask}. */
export interface StartTaskOptions {
  /** Branch lock file. Defaults to the plugin-root lock. */
  lockPath?: string;
  /** 運行上下文；缺省讀 run-context 單例 */
  context?: RunContext;
  /** local 模式且使用者已批准在當前分支工作時為 true */
  skipBranchSwitch?: boolean;
  /**
   * 就地模式：沿用既有的那一輪（resume），不當成「已經跑過」的阻擋。
   *
   * **只有使用者明確選了 resume 才會是 true**：那一輪的運行時狀態
   * （run-metadata、runId）要留著，分支歸屬照同一條規則重算一次。
   */
  adoptExisting?: boolean;
}

/**
 * What keeps a task from starting right now.
 *
 * `lock_conflict` - another task holds the global branch lock.
 * `already_exists` - the workspace of this task is already on disk.
 *
 * The lock conflict carries a `message`: the gate the user sees has to say
 * what is going on, not only offer two buttons.
 */
export type StartTaskBlocker =
  | { kind: 'lock_conflict'; holderTaskName: string; message?: string }
  | { kind: 'already_exists'; taskDir: string };

/**
 * Characters a repository URL must not contain.
 *
 * Whitespace and shell metacharacters have no legitimate use in a git URL,
 * and glob characters only ever mean "the user typed something that looks
 * like a pattern".
 */
const FORBIDDEN_URL_CHARS = /[\s;|&$`<>()"'\\*?[\]{}!#]/;

/**
 * Validate a repository URL.
 *
 * The URL is user input that ends up in `git clone <url> <dir>`. The argv
 * array keeps the shell out of it, but git itself still reads a leading `-`
 * as an option - `git clone --upload-pack=<cmd> <url>` runs `<cmd>` - so a
 * URL that starts with a dash has to be refused before it reaches git.
 *
 * @returns `{ valid: true }` or the reason the URL was refused.
 */
export function validateRepoUrl(repoUrl: string): { valid: boolean; error?: string } {
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
    return { valid: false, error: 'Repository URL is required' };
  }
  if (repoUrl.startsWith('-')) {
    return {
      valid: false,
      error: 'Repository URL must not start with "-" - git would read it as an option',
    };
  }
  if (FORBIDDEN_URL_CHARS.test(repoUrl)) {
    return {
      valid: false,
      error: 'Repository URL must not contain whitespace or shell metacharacters',
    };
  }
  return { valid: true };
}

/**
 * What would stop the task from starting right now?
 *
 * **Read-only**: it never touches the lock and never touches the workspace,
 * so the bootstrap node can ask the user *before* it starts doing anything.
 *
 * The lock wins over the workspace: while another task holds the global lock
 * nothing may run, no matter how ready this task is.
 *
 * A lock held by **this** task is not a conflict - it is the lock of this
 * task's own previous run (which crashed and left it behind). `startTask`
 * takes such a lock over instead of failing, so the two agree on what
 * "the lock is held" means.
 */
export function detectStartBlocker(
  normalizedTaskName: string,
  lockPath?: string
): StartTaskBlocker | null {
  const lock = getLock(lockPath ?? getLockFilePath());
  if (lock?.running && lock.taskName !== normalizedTaskName) {
    return {
      kind: 'lock_conflict',
      holderTaskName: lock.taskName,
      message:
        `The branch lock is held by "${lock.taskName}". Release it with ` +
        `\`sdd-graph stop --task ${lock.taskName}\` or take it away with the ` +
        '`stop_other` option of this gate.',
    };
  }
  if (isLocalMode()) {
    return detectLocalBlocker(normalizedTaskName);
  }
  if (taskWorkspaceExists(normalizedTaskName)) {
    return { kind: 'already_exists', taskDir: getTaskDir(normalizedTaskName) };
  }
  return null;
}

/**
 * 就地模式下擋住這次啟動的東西。
 *
 * **判據只能來自檔案系統**：節點拿不到 checkpointer（checkpoint 只能由 CLI 側刪），
 * 所以「這個 task 之前跑過嗎」只能用讀得到的訊號回答：**run-metadata 檔存在**
 * 就是之前跑過。
 *
 * **分支存在不算阻塞**：分支 `task/<name>` 是插件自己的工作分支，而 reset
 * 只清插件自己的運行時狀態（`.sdd/tasks/<task>`、`.sdd/runs/<task>`）、
 * 不刪分支（刪使用者的東西是硬紅線）。所以 reset 之後分支還在，
 * 若把它算成阻塞，使用者就永遠起不來這個 task，而且訊息會指向一條
 * 走不通的恢復路徑。重新開始時**複用既有的分支**才是自然的——
 * `prepareLocalBranch()` 會切過去。
 *
 * 髒工作區不在這裡判斷：它是「這一次能不能動手」的狀態，由 `startTask()`
 * 在動手之前自己判斷（見 {@link planLocalBranch}）。
 */
function detectLocalBlocker(normalizedTaskName: string): StartTaskBlocker | null {
  if (fs.existsSync(getRunMetadataPath(normalizedTaskName))) {
    return { kind: 'already_exists', taskDir: getTaskDir(normalizedTaskName) };
  }
  return null;
}

/**
 * Start a new task: prepare the workspace, take the branch lock, clone the
 * repository.
 *
 * **就地模式（local）走另一條路**：不 clone、不建 workspace 目錄，
 * 改為在業務倉庫裡準備好分支、把 run-metadata 寫進 `.sdd/`。
 *
 * @param taskNameRaw - Raw task name from the user.
 * @param repoUrl - Repository to clone（local 模式不使用）。
 * @param opts - Options (the lock file the run uses, the run context, ...).
 */
export async function startTask(
  taskNameRaw: string,
  repoUrl: string,
  opts: StartTaskOptions = {}
): Promise<StartTaskResult> {
  const context = opts.context ?? getRunContext();
  // 明確帶進來的上下文必須成為生效的上下文：路徑函式（`paths.ts`）讀的是
  // 單例，不同步的話 task 目錄與 run-metadata 會落在兩個不同的家目錄。
  if (opts.context) {
    setRunContext(opts.context);
  }

  // Step 1: validate the task name
  const validation = validateTaskName(taskNameRaw);
  if (!validation.valid) {
    return failure(
      { taskName: taskNameRaw, normalizedTaskName: validation.normalized, branch: '', repoPath: '', runId: '' },
      `Invalid task name: ${validation.warnings.join(', ')}`,
      'validation_error'
    );
  }
  const normalizedTaskName = validation.normalized;
  const branchName = generateBranchName(normalizedTaskName);
  // **沿用既有的那一輪時，runId 要沿用**：那是那一輪的識別碼，
  // 換一個新的會讓 resume 之後的紀錄對不上前一段。
  const runId = opts.adoptExisting ? readRunId(normalizedTaskName) : generateRunId();

  // 就地模式：程式碼直接寫在使用者的業務倉庫裡，流程整條不一樣。
  if (context.mode === 'local') {
    return startLocalTask({
      taskNameRaw,
      normalizedTaskName,
      branchName,
      runId,
      repoUrl,
      context,
      opts,
    });
  }

  const lockPath = opts.lockPath ?? getLockFilePath();
  const base = {
    taskName: taskNameRaw,
    normalizedTaskName,
    branch: branchName,
    repoPath: getRepoDir(normalizedTaskName),
    runId,
  };

  // Step 2: validate the repository URL before it can reach git
  const urlCheck = validateRepoUrl(repoUrl);
  if (!urlCheck.valid) {
    return failure(base, urlCheck.error ?? 'Invalid repository URL', 'validation_error');
  }

  // Step 3: what is in the way? (read-only - nothing has been touched yet)
  const blocker = detectStartBlocker(normalizedTaskName, lockPath);
  if (blocker?.kind === 'lock_conflict') {
    return failure(
      base,
      lockConflictMessage(blocker.holderTaskName, normalizedTaskName),
      'lock_conflict',
      blocker.holderTaskName
    );
  }
  if (blocker?.kind === 'already_exists') {
    return failure(
      base,
      `Task workspace already exists at ${blocker.taskDir}. Use resume or delete first.`,
      'workspace_error'
    );
  }

  // Step 4: take the lock BEFORE the workspace is created - a lock conflict
  // must not leave a half prepared workspace behind.
  const repoPath = getRepoDir(normalizedTaskName);
  const lockOutcome = takeBranchLock(normalizedTaskName, branchName, repoPath, runId, lockPath);
  if (!lockOutcome.ok) {
    return failure(base, lockOutcome.error, 'lock_conflict', lockOutcome.holderTaskName);
  }

  // Step 5: workspace
  const workspaceResult = initTaskWorkspace(normalizedTaskName);
  if (!workspaceResult.success) {
    const released = releaseLock(lockPath);
    if (!released.success) {
      // The workspace could not be created *and* the lock could not be given
      // back: the lock stays with this task, which the next `start` can take
      // over. The message has to say so.
      return failure(
        base,
        `${workspaceResult.error ?? 'Failed to initialize workspace'}. The branch lock ` +
          `could not be released either (${released.error ?? 'unknown error'}) - the lock ` +
          'is still held by this task.',
        'workspace_error'
      );
    }
    return failure(base, workspaceResult.error ?? 'Failed to initialize workspace', 'workspace_error');
  }

  // Step 6: clone
  const cloneResult = cloneBranch(repoUrl, branchName, normalizedTaskName);
  if (!cloneResult.success) {
    // The clone rolls its own workspace back; the lock is ours to give back.
    releaseLock(lockPath);
    return failure(base, cloneResult.error ?? 'Git operation failed', cloneResult.errorCode ?? 'git_error');
  }

  // Step 7: run metadata (nice to have - a missing file must not fail the run)
  writeRunMetadata({
    runId,
    taskName: normalizedTaskName,
    branch: branchName,
    repoPath: cloneResult.repoPath,
    repoUrl,
    startedAt: new Date().toISOString(),
    status: 'running',
  });

  return {
    success: true,
    taskName: taskNameRaw,
    normalizedTaskName,
    branch: branchName,
    repoPath: cloneResult.repoPath,
    runId,
  };
}

/**
 * 就地模式的啟動流程。
 *
 * **不 clone、不建 workspace 目錄**：程式碼直接寫在使用者的業務倉庫裡，
 * 運行時狀態寫在 `<sdd-home>/`（= `<repoRoot>/.sdd`）之下。
 *
 * **順序與 remote 模式一樣遵守「先失敗、後動手」**：所有會失敗的檢查
 * （不是 git 倉庫、鎖、既有 task、髒工作區）都在拿鎖與切分支之前做完。
 *
 * @param params - 這次啟動的各項資料
 */
async function startLocalTask(params: {
  taskNameRaw: string;
  normalizedTaskName: string;
  branchName: string;
  runId: string;
  repoUrl: string;
  context: RunContext;
  opts: StartTaskOptions;
}): Promise<StartTaskResult> {
  const { taskNameRaw, normalizedTaskName, branchName, runId, repoUrl, context, opts } = params;
  const lockPath = opts.lockPath ?? getLockFilePath();
  const repoRoot = canonicalRepoRoot(context.repoRoot);
  const base = {
    taskName: taskNameRaw,
    normalizedTaskName,
    branch: branchName,
    repoPath: repoRoot,
    runId,
  };

  // Step 1: 必須是 git 倉庫——就地模式要在使用者的倉庫裡工作。
  if (!isGitRepository(repoRoot)) {
    return failure(
      base,
      `${repoRoot} is not a git repository - local mode works inside the user's own repository`,
      'validation_error'
    );
  }

  // Step 2: 什麼擋著？（唯讀——動手之前先看清楚）
  const blocker = detectStartBlocker(normalizedTaskName, lockPath);
  if (blocker?.kind === 'lock_conflict') {
    return failure(
      base,
      lockConflictMessage(blocker.holderTaskName, normalizedTaskName),
      'lock_conflict',
      blocker.holderTaskName
    );
  }
  if (blocker?.kind === 'already_exists' && !opts.adoptExisting) {
    return failure(
      base,
      `Task "${normalizedTaskName}" already exists in this repository (its run metadata ` +
        'is already there). Use resume or reset first.',
      'already_exists'
    );
  }

  // Step 3: 分支歸屬（唯讀的計畫）
  //
  // **唯一規則**（見 `planLocalBranch`）：就地模式的一輪 run 屬於
  // `task/<name>`；使用者明確說「留在當前分支」時才例外，而且那個例外
  // 必須是記錄下來的決定（`skipBranchSwitch`）。
  //
  // 工作區髒不髒也在這裡判：已跟蹤文件的改動會被帶到新分支上，
  // 那是使用者自己正在寫的東西——插件不替他 stash，也不替他帶走。
  const plan = planLocalBranch(repoRoot, branchName, {
    stayOnCurrentBranch: opts.skipBranchSwitch,
  });
  if (plan.kind === 'dirty') {
    return failure(base, DIRTY_WORKTREE_MESSAGE, 'dirty_worktree');
  }
  if (plan.kind === 'failed') {
    return failure(base, plan.error, plan.errorCode);
  }

  // Step 4: take the lock - 與 remote 模式同一套規則
  // **鎖裡記的是這一輪真的會在的分支**：留在當前分支時記當前分支，
  // 記一條沒去過的分支名會誤導後續流程。
  const plannedBranch = plan.kind === 'stay' ? plan.branch : branchName;
  const lockOutcome = takeBranchLock(normalizedTaskName, plannedBranch, repoRoot, runId, lockPath);
  if (!lockOutcome.ok) {
    return failure(base, lockOutcome.error, 'lock_conflict', lockOutcome.holderTaskName);
  }

  // Step 5: 執行分支歸屬計畫（就地模式的「clone」）
  // **已存在的 `task/<name>` 分支會被複用**（切過去），
  // 不會另外開一條：reset 之後分支還在，那是同一個 task 的工作分支。
  const applied = applyLocalBranch(repoRoot, plan);
  if (!applied.ok) {
    // 分支沒準備好，鎖要還回去——否則這個倉庫會一直被鎖住。
    const released = releaseLock(lockPath);
    if (!released.success) {
      // 鎖沒還回去：使用者必須知道這個倉庫還被鎖著，
      // 否則他會以為重跑一次就能繼續。
      return failure(
        base,
        `${applied.error}. The branch lock could not be released either ` +
          `(${released.error ?? 'unknown error'}) - the lock is still held by this task.`,
        applied.errorCode
      );
    }
    return failure(base, applied.error, applied.errorCode);
  }
  const preparedBranch = applied.branch;

  // Step 6: 運行時狀態目錄（只建 .sdd/tasks/<task>，不建 repo/）
  const workspaceResult = initTaskWorkspace(normalizedTaskName);
  if (!workspaceResult.success) {
    const released = releaseLock(lockPath);
    if (!released.success) {
      return failure(
        base,
        `${workspaceResult.error ?? 'Failed to initialize workspace'}. The branch lock ` +
          `could not be released either (${released.error ?? 'unknown error'}) - the lock ` +
          'is still held by this task.',
        'workspace_error'
      );
    }
    return failure(base, workspaceResult.error ?? 'Failed to initialize workspace', 'workspace_error');
  }

  // Step 7: run metadata（寫在 .sdd/runs/<task>/ 之下）
  // **沿用既有的那一輪時，開始時間不重算**：那是同一輪的開始時間。
  const adopted = opts.adoptExisting ? readRunMetadata(normalizedTaskName) : undefined;
  writeRunMetadata({
    runId,
    taskName: normalizedTaskName,
    branch: preparedBranch,
    repoPath: repoRoot,
    repoUrl,
    startedAt: adopted?.startedAt ?? new Date().toISOString(),
    status: 'running',
  });

  return {
    success: true,
    taskName: taskNameRaw,
    normalizedTaskName,
    branch: preparedBranch,
    repoPath: repoRoot,
    runId,
  };
}

/**
 * 拿下這次運行的分支鎖。
 *
 * **鎖被「自己」拿著不算衝突**：那是這個 task 上一次跑崩了留下的鎖，
 * `detectStartBlocker` 也是同一個判準，兩邊要一致——先釋放再重拿，
 * 而不是永遠失敗。
 *
 * @param taskName - 正規化的 task 名
 * @param branchName - 這次運行的分支
 * @param repoPath - 這次運行的倉庫路徑（寫進鎖裡）
 * @param runId - 這次運行的 id
 * @param lockPath - 鎖檔路徑
 */
function takeBranchLock(
  taskName: string,
  branchName: string,
  repoPath: string,
  runId: string,
  lockPath: string
): { ok: true } | { ok: false; error: string; holderTaskName?: string } {
  let lockResult = acquireLock(taskName, branchName, repoPath, runId, lockPath);
  if (!lockResult.success && lockResult.holderTaskName === taskName) {
    // The lock is **ours**: the previous run of this task crashed and left it
    // behind. `detectStartBlocker` does not call that a conflict, so the two
    // have to agree - take the lock over instead of failing forever.
    const released = releaseLock(lockPath);
    if (!released.success) {
      // The lock file could not be rewritten: the takeover is impossible and
      // the lock is still held. Say so instead of pretending.
      return {
        ok: false,
        holderTaskName: taskName,
        error:
          `Cannot acquire lock: the lock is held by "${taskName}" (this task's own ` +
          `previous run) and the lock file could not be rewritten ` +
          `(${released.error ?? 'unknown error'}). Fix the lock file's permissions, ` +
          'or take the lock away with the `stop_other` option of the lock gate.',
      };
    }
    lockResult = acquireLock(taskName, branchName, repoPath, runId, lockPath);
  }
  if (!lockResult.success) {
    return {
      ok: false,
      holderTaskName: lockResult.holderTaskName,
      error: lockConflictMessage(lockResult.holderTaskName, taskName),
    };
  }
  return { ok: true };
}

/**
 * The message of a lock conflict.
 *
 * It has to name the way out: the lock is global, so whoever holds it has to
 * release it (`sdd-graph stop --task <name>`) - or take it away from the
 * other task (the `stop_other` option of the `lock_conflict` gate).
 *
 * **Only advice the user can act on.** Every lock conflict - the pre-check
 * and the acquisition inside `startTask` alike - opens the same `lock_conflict`
 * gate, so the user can always pick `stop_other` there.
 */
function lockConflictMessage(holderTaskName: string | undefined, taskName: string): string {
  const holder = holderTaskName && holderTaskName.trim() !== '' ? holderTaskName : null;

  if (holder === null) {
    return (
      'Cannot acquire the branch lock: the lock could not be taken. ' +
      'Check that the lock file is writable, or take the lock away with the ' +
      '`stop_other` option of the lock gate.'
    );
  }

  if (holder === taskName) {
    return (
      `Cannot acquire lock: the lock is still held by "${holder}" - this task's own ` +
      `previous run. Release it with \`sdd-graph stop --task ${holder}\` or take it away ` +
      'with the `stop_other` option of the lock gate.'
    );
  }
  return (
    `Cannot acquire lock: another task "${holder}" is currently running. ` +
    `Release it with \`sdd-graph stop --task ${holder}\` or take it away with ` +
    'the `stop_other` option of the lock gate.'
  );
}

/** Build a failed result. */
function failure(
  base: Omit<StartTaskResult, 'success' | 'error' | 'errorCode' | 'holderTaskName'>,
  error: string,
  errorCode: ErrorCode,
  holderTaskName?: string
): StartTaskResult {
  return { success: false, ...base, error, errorCode, holderTaskName };
}

/** The metadata of a running task. */
interface RunMetadata {
  runId: string;
  taskName: string;
  branch: string;
  repoPath: string;
  repoUrl: string;
  startedAt: string;
  status: string;
}

/** Write `run-metadata.json` - a missing file must not fail the run. */
function writeRunMetadata(metadata: RunMetadata): void {
  try {
    const target = getRunMetadataPath(metadata.taskName);
    // 就地模式的 metadata 在 `.sdd/runs/<task>/` 之下，那個目錄還不存在——
    // 父目錄要先建起來（remote 模式裡它早就有了，mkdir 是空的）。
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, JSON.stringify(metadata, null, 2), {
      mode: 0o644,
    });
  } catch (err) {
    console.warn('Failed to write run-metadata.json:', err);
  }
}

/**
 * The run id of an existing task, read from its `run-metadata.json`.
 * A task without metadata (an interrupted run) gets a fresh id.
 */
export function readRunId(normalizedTaskName: string): string {
  const parsed = readRunMetadata(normalizedTaskName);
  return parsed?.runId ?? generateRunId();
}

/**
 * 既有那一輪的 run-metadata（沒有就回 undefined）。
 *
 * **讀不到不是錯**：中斷的 run 沒有 metadata 很正常，那種情況下呼叫端
 * 會自己補一個新的 runId。
 */
function readRunMetadata(
  normalizedTaskName: string
): { runId?: string; startedAt?: string } | undefined {
  try {
    const raw = fs.readFileSync(getRunMetadataPath(normalizedTaskName), 'utf-8');
    const parsed = JSON.parse(raw) as { runId?: unknown; startedAt?: unknown };
    return {
      ...(typeof parsed.runId === 'string' && parsed.runId !== '' ? { runId: parsed.runId } : {}),
      ...(typeof parsed.startedAt === 'string' && parsed.startedAt !== ''
        ? { startedAt: parsed.startedAt }
        : {}),
    };
  } catch {
    return undefined;
  }
}
