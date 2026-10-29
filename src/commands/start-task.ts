import * as fs from 'fs';
import { acquireLock, getLock, releaseLock } from '../runtime/branch-lock.js';
import type { ErrorCode } from '../runtime/errors.js';
import { cloneBranch } from '../runtime/git-branch-manager.js';
import { getLockFilePath, getRepoDir, getRunMetadataPath, getTaskDir } from '../runtime/paths.js';
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
  if (taskWorkspaceExists(normalizedTaskName)) {
    return { kind: 'already_exists', taskDir: getTaskDir(normalizedTaskName) };
  }
  return null;
}

/**
 * Start a new task: prepare the workspace, take the branch lock, clone the
 * repository.
 *
 * @param taskNameRaw - Raw task name from the user.
 * @param repoUrl - Repository to clone.
 * @param opts - Options (the lock file the run uses).
 */
export async function startTask(
  taskNameRaw: string,
  repoUrl: string,
  opts: StartTaskOptions = {}
): Promise<StartTaskResult> {
  const lockPath = opts.lockPath ?? getLockFilePath();

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
  let lockResult = acquireLock(normalizedTaskName, branchName, repoPath, runId, lockPath);
  if (!lockResult.success && lockResult.holderTaskName === normalizedTaskName) {
    // The lock is **ours**: the previous run of this task crashed and left it
    // behind. `detectStartBlocker` does not call that a conflict, so the two
    // have to agree - take the lock over instead of failing forever.
    const released = releaseLock(lockPath);
    if (!released.success) {
      // The lock file could not be rewritten: the takeover is impossible and
      // the lock is still held. Say so instead of pretending.
      return failure(
        base,
        `Cannot acquire lock: the lock is held by "${normalizedTaskName}" (this task's own ` +
          `previous run) and the lock file could not be rewritten ` +
          `(${released.error ?? 'unknown error'}). Fix the lock file's permissions, ` +
          'or take the lock away with the `stop_other` option of the lock gate.',
        'lock_conflict',
        normalizedTaskName
      );
    }
    lockResult = acquireLock(normalizedTaskName, branchName, repoPath, runId, lockPath);
  }
  if (!lockResult.success) {
    return failure(
      base,
      lockConflictMessage(lockResult.holderTaskName, normalizedTaskName),
      'lock_conflict',
      lockResult.holderTaskName
    );
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
    fs.writeFileSync(getRunMetadataPath(metadata.taskName), JSON.stringify(metadata, null, 2), {
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
