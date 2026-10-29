import * as fs from 'fs';
import * as path from 'path';
import { getLockFilePath } from './paths.js';

export interface BranchRuntimeLock {
  running: boolean;
  taskName: string;
  branch: string;
  repoPath: string;
  runId: string;
  startedAt: string;
}

/**
 * Acquire the global branch runtime lock.
 * Uses atomic write (temp file + rename) to ensure consistency.
 *
 * @returns true if lock acquired, false if already locked
 */
export function acquireLock(
  taskName: string,
  branchName: string,
  repoPath: string,
  runId: string,
  lockPath: string = getLockFilePath()
): { success: boolean; lock?: BranchRuntimeLock; holderTaskName?: string } {
  const tempPath = lockPath + '.tmp';

  try {
    // Ensure runtime directory exists
    const runtimeDir = path.dirname(lockPath);
    if (!fs.existsSync(runtimeDir)) {
      fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o755 });
    }

    // Check existing lock
    const existingLock = getLock(lockPath);
    if (existingLock && existingLock.running) {
      return {
        success: false,
        lock: existingLock,
        holderTaskName: existingLock.taskName,
      };
    }

    // Create new lock
    const lock: BranchRuntimeLock = {
      running: true,
      taskName,
      branch: branchName,
      repoPath,
      runId,
      startedAt: new Date().toISOString(),
    };

    // Atomic write: write to temp, then rename
    fs.writeFileSync(tempPath, JSON.stringify(lock, null, 2), { mode: 0o644 });
    fs.renameSync(tempPath, lockPath);

    return { success: true, lock };
  } catch (err) {
    console.error('Failed to acquire lock:', err);
    return {
      success: false,
      lock: getLock(lockPath) ?? undefined,
      holderTaskName: getLock(lockPath)?.taskName,
    };
  }
}

/**
 * Release the global branch runtime lock.
 * Idempotent - does not error if no lock exists.
 */
export function releaseLock(lockPath: string = getLockFilePath()): { success: boolean; error?: string } {
  try {
    if (!fs.existsSync(lockPath)) {
      return { success: true }; // No lock, already released
    }

    // Clear the lock by writing running: false instead of deleting
    // This preserves info for debugging while indicating not running
    const lock = getLock(lockPath);
    if (lock) {
      lock.running = false;
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), { mode: 0o644 });
    } else {
      fs.unlinkSync(lockPath);
    }

    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to release lock: ${error}` };
  }
}

/**
 * Force unlock - for admin use when lock is orphaned.
 */
export function forceUnlock(lockPath: string = getLockFilePath()): { success: boolean; error?: string } {
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to force unlock: ${error}` };
  }
}

/**
 * Get current lock status.
 * Returns null if no lock exists.
 */
export function getLock(lockPath: string = getLockFilePath()): BranchRuntimeLock | null {
  if (!fs.existsSync(lockPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(lockPath, 'utf-8');
    const lock = JSON.parse(content) as BranchRuntimeLock;
    return lock;
  } catch {
    return null;
  }
}

/**
 * Validate that the current lock belongs to the specified task.
 */
export function validateLockOwnership(
  taskName: string,
  lockPath: string = getLockFilePath()
): {
  valid: boolean;
  isLocked: boolean;
  isHolder: boolean;
  holderTaskName?: string;
} {
  const lock = getLock(lockPath);

  if (!lock) {
    return { valid: true, isLocked: false, isHolder: false };
  }

  if (!lock.running) {
    return { valid: true, isLocked: false, isHolder: false };
  }

  return {
    valid: false,
    isLocked: true,
    isHolder: lock.taskName === taskName,
    holderTaskName: lock.taskName,
  };
}

/**
 * Get lock status summary for display.
 */
export function getLockStatus(lockPath: string = getLockFilePath()): {
  isLocked: boolean;
  taskName?: string;
  branch?: string;
  runId?: string;
  startedAt?: string;
  duration?: string;
} {
  const lock = getLock(lockPath);

  if (!lock || !lock.running) {
    return { isLocked: false };
  }

  const startedAt = new Date(lock.startedAt);
  const durationMs = Date.now() - startedAt.getTime();
  const durationMinutes = Math.floor(durationMs / 60000);
  const durationHours = Math.floor(durationMinutes / 60);

  let duration: string;
  if (durationHours > 0) {
    duration = `${durationHours}h ${durationMinutes % 60}m`;
  } else if (durationMinutes > 0) {
    duration = `${durationMinutes}m`;
  } else {
    duration = '<1m';
  }

  return {
    isLocked: true,
    taskName: lock.taskName,
    branch: lock.branch,
    runId: lock.runId,
    startedAt: lock.startedAt,
    duration,
  };
}
