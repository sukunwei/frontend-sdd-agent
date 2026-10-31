import * as fs from 'fs';
import * as path from 'path';
import { acquireLock, getLock, releaseLock } from '../runtime/branch-lock.js';
import type { ErrorCode } from '../runtime/errors.js';
import {
  cloneBranch,
  isWorktreeDirty,
  localBranchExists,
  prepareLocalBranch,
} from '../runtime/git-branch-manager.js';
import { isGitRepository } from '../runtime/git-tags.js';
import { getLockFilePath, getRepoDir, getRunMetadataPath, getTaskDir } from '../runtime/paths.js';
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
}

/**
 * What keeps a task from starting right now.
 *
 * `lock_conflict` - another task holds the global branch lock.
 * `already_exists` - the workspace of this task is already on disk.
 * `dirty_worktree` - 就地模式下工作區有已跟蹤文件的改動。`startTask()` 對
 * 同一件事回報 `errorCode: 'dirty_worktree'`（動手之前就擋下來），
 * 這個 kind 則是 bootstrap 節點開閘門時用的形狀。
 *
 * The lock conflict carries a `message`: the gate the user sees has to say
 * what is going on, not only offer two buttons.
 */
export type StartTaskBlocker =
  | { kind: 'lock_conflict'; holderTaskName: string; message?: string }
  | { kind: 'already_exists'; taskDir: string }
  | { kind: 'dirty_worktree'; message: string };

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
 * 所以「這個 task 之前跑過嗎」只能用讀得到的訊號回答：
 * - run-metadata 檔存在 → 之前跑過；
 * - 分支 `task/<name>` 存在 → 之前跑過（分支是就地模式的產物）。
 *
 * 髒工作區不在這裡判斷：它是「這一次能不能動手」的狀態，由 `startTask()`
 * 在動手之前自己判斷（見 {@link readWorktreeDirty}）。
 */
function detectLocalBlocker(normalizedTaskName: string): StartTaskBlocker | null {
  const context = getRunContext();
  const taskDir = getTaskDir(normalizedTaskName);

  if (fs.existsSync(getRunMetadataPath(normalizedTaskName))) {
    return { kind: 'already_exists', taskDir };
  }
  if (localBranchExists(context.repoRoot, generateBranchName(normalizedTaskName))) {
    return { kind: 'already_exists', taskDir };
  }
  return null;
}

/**
 * 工作區有沒有已跟蹤文件的改動。
 *
 * `undefined` = **查不到**（不是 git 倉庫、git 不在 PATH、git 逾時），
 * 不是「乾淨」——回 false 會被誤讀成可以放心切分支，那比報錯更危險。
 *
 * `isWorktreeDirty()` 宣告回傳 boolean 但真的會拋，這是刻意的；
 * 這裡必須接住，否則 `startTask()` 會直接炸出去。
 *
 * @param repoRoot - 倉庫根目錄
 */
function readWorktreeDirty(repoRoot: string): boolean | undefined {
  try {
    return isWorktreeDirty(repoRoot);
  } catch {
    return undefined;
  }
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
  const runId = generateRunId();

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
  if (blocker?.kind === 'already_exists') {
    return failure(
      base,
      `Task "${normalizedTaskName}" already exists in this repository (run metadata or ` +
        `branch ${branchName} is already there). Use resume or reset first.`,
      'workspace_error'
    );
  }

  // Step 3: 工作區髒不髒？已跟蹤文件的改動會被帶到新分支上，
  // 那是使用者自己正在寫的東西——插件不替他 stash，也不替他帶走。
  // 查不到狀態（不是 git 倉庫、git 失敗）時擋下來：不知道就不動手。
  const dirty = readWorktreeDirty(repoRoot);
  if (dirty === undefined) {
    return failure(
      base,
      `Cannot tell whether the worktree of ${repoRoot} is clean - git status failed. ` +
        'Nothing was touched.',
      'git_error'
    );
  }
  if (dirty === true && !opts.skipBranchSwitch) {
    return failure(
      base,
      '工作區有已跟蹤文件的改動，插件不會自動 stash，也不會把這些改動帶到新分支。' +
        '請先讓使用者確認；若使用者選擇留在當前分支繼續，改用 skipBranchSwitch。',
      'dirty_worktree'
    );
  }

  // Step 4: take the lock - 與 remote 模式同一套規則
  const lockOutcome = takeBranchLock(normalizedTaskName, branchName, repoRoot, runId, lockPath);
  if (!lockOutcome.ok) {
    return failure(base, lockOutcome.error, 'lock_conflict', lockOutcome.holderTaskName);
  }

  // Step 5: 準備分支（就地模式的「clone」）
  const prepared = prepareLocalBranch(repoRoot, branchName, {
    skipSwitch: opts.skipBranchSwitch,
  });
  if (!prepared.ok) {
    // 分支沒準備好，鎖要還回去——否則這個倉庫會一直被鎖住。
    releaseLock(lockPath);
    // 髒不髒看 `dirty`，不看 `errorCode`：`git_error` 被歸類成可自動重試，
    // 照抄會讓髒工作區被重試策略反反覆複地重試。
    if (prepared.dirty === true) {
      return failure(
        { ...base, branch: prepared.branch },
        prepared.error ?? '工作區有未提交的改動',
        'dirty_worktree'
      );
    }
    return failure(
      { ...base, branch: prepared.branch },
      prepared.error ?? 'Git operation failed',
      prepared.errorCode ?? 'git_error'
    );
  }

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
  writeRunMetadata({
    runId,
    taskName: normalizedTaskName,
    branch: prepared.branch,
    repoPath: repoRoot,
    repoUrl,
    startedAt: new Date().toISOString(),
    status: 'running',
  });

  return {
    success: true,
    taskName: taskNameRaw,
    normalizedTaskName,
    branch: prepared.branch,
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
 * 倉庫根的正規化路徑。
 *
 * **要 `realpath`**：macOS 的 `/var` 是 `/private/var` 的符號連結，
 * 同一個倉庫會有兩種寫法——回報未正規化的路徑，顯示、比對、
 * 鎖的記錄就會對不上（使用者看到的是 `/var/...`，git 看到的是 `/private/var/...`）。
 *
 * @param repoRoot - 上下文裡的倉庫根
 */
function canonicalRepoRoot(repoRoot: string): string {
  try {
    return fs.realpathSync(repoRoot);
  } catch {
    return path.resolve(repoRoot);
  }
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
  try {
    const raw = fs.readFileSync(getRunMetadataPath(normalizedTaskName), 'utf-8');
    const parsed = JSON.parse(raw) as { runId?: unknown };
    return typeof parsed.runId === 'string' && parsed.runId !== '' ? parsed.runId : generateRunId();
  } catch {
    return generateRunId();
  }
}
