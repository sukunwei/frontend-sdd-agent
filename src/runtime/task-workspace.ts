import * as fs from 'fs';
import * as path from 'path';
import { getTaskDir, getRepoDir, getWorkspaceBase } from './paths.js';

export interface TaskWorkspaceResult {
  success: boolean;
  taskDir: string;
  repoDir: string;
  created: boolean;
  error?: string;
}

/**
 * Initialize the task workspace directory structure.
 *
 * Creates:
 *   <task-dir>/
 *   <task-dir>/repo/
 *
 * This is idempotent - if directories already exist, it does not error.
 *
 * @param taskNameNormalized - Normalized task name (kebab-case)
 * @returns Result with success status and paths
 */
export function initTaskWorkspace(taskNameNormalized: string): TaskWorkspaceResult {
  const taskDir = getTaskDir(taskNameNormalized);
  const repoDir = getRepoDir(taskNameNormalized);

  try {
    // Create task directory
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true, mode: 0o755 });
    }

    // Create repo subdirectory
    if (!fs.existsSync(repoDir)) {
      fs.mkdirSync(repoDir, { recursive: true, mode: 0o755 });
    }

    // Verify write permissions by attempting to write a temp file
    const testFile = path.join(taskDir, '.write-test');
    fs.writeFileSync(testFile, 'test', { mode: 0o644 });
    fs.unlinkSync(testFile);

    return {
      success: true,
      taskDir,
      repoDir,
      created: true,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      taskDir,
      repoDir,
      created: false,
      error: `Failed to initialize workspace: ${error}`,
    };
  }
}

/**
 * Check if a task workspace already exists.
 * @param taskNameNormalized - Normalized task name
 */
export function taskWorkspaceExists(taskNameNormalized: string): boolean {
  const taskDir = getTaskDir(taskNameNormalized);
  return fs.existsSync(taskDir) && fs.existsSync(path.join(taskDir, 'repo'));
}

/**
 * Get workspace info (space usage, existing tasks, etc.)
 */
export function getWorkspaceInfo(): {
  workspaceBase: string;
  existingTasks: string[];
  totalSize: number;
} {
  const workspaceBase = getWorkspaceBase();
  const existingTasks: string[] = [];
  let totalSize = 0;

  if (!fs.existsSync(workspaceBase)) {
    return { workspaceBase, existingTasks: [], totalSize: 0 };
  }

  const entries = fs.readdirSync(workspaceBase, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      existingTasks.push(entry.name);
      totalSize += getDirectorySize(path.join(workspaceBase, entry.name));
    }
  }

  return { workspaceBase, existingTasks, totalSize };
}

/**
 * Calculate directory size recursively.
 */
function getDirectorySize(dirPath: string): number {
  let size = 0;
  if (!fs.existsSync(dirPath)) return 0;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += getDirectorySize(fullPath);
    } else {
      const stat = fs.statSync(fullPath);
      size += stat.size;
    }
  }
  return size;
}

/**
 * Clean up a failed task workspace.
 * Only call this during rollback scenarios.
 */
export function cleanupTaskWorkspace(taskNameNormalized: string): void {
  const taskDir = getTaskDir(taskNameNormalized);
  if (fs.existsSync(taskDir)) {
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
}
