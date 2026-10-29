import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, ExecFileSyncOptions } from 'child_process';
import { getRepoDir, getTaskDir } from './paths.js';
import { cleanupTaskWorkspace } from './task-workspace.js';

export interface GitCloneResult {
  success: boolean;
  repoPath: string;
  branch: string;
  error?: string;
  errorCode?: 'git_error' | 'network_error' | 'permission_error' | 'cleanup_failed';
}

/**
 * Check if a remote branch already exists.
 */
export function remoteBranchExists(repoUrl: string, branchName: string): boolean {
  try {
    const result = execFileSync(
      'git',
      ['ls-remote', '--heads', repoUrl, branchName],
      { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result.includes(branchName);
  } catch {
    return false;
  }
}

/**
 * Get the default branch name of a remote repository.
 */
export function getDefaultBranch(repoUrl: string): string {
  try {
    const result = execFileSync(
      'git',
      ['ls-remote', '--symref', repoUrl, 'HEAD'],
      { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const match = result.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
    return match ? match[1] : 'main';
  } catch {
    return 'main';
  }
}

/**
 * Clone a specific branch into the task repo directory.
 * Creates the branch if it doesn't exist on remote.
 */
export function cloneBranch(
  repoUrl: string,
  branchName: string,
  taskNameNormalized: string
): GitCloneResult {
  const repoDir = getRepoDir(taskNameNormalized);
  const taskDir = getTaskDir(taskNameNormalized);

  const execOptions: ExecFileSyncOptions = {
    encoding: 'utf-8',
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  try {
    // Step 1: Check if branch exists on remote
    const branchExists = remoteBranchExists(repoUrl, branchName);

    if (!branchExists) {
      // Step 2: Create branch from default if it doesn't exist
      // We need to create a local repo first, then push to create the remote branch
      const defaultBranch = getDefaultBranch(repoUrl);

      // Clone the default branch first
      execFileSync(
        'git',
        ['clone', '--branch', defaultBranch, '--single-branch', repoUrl, repoDir],
        execOptions
      );

      // Create the new branch
      execFileSync('git', ['-C', repoDir, 'checkout', '-b', branchName], execOptions);

      // Push to origin to create the remote branch
      try {
        execFileSync('git', ['-C', repoDir, 'push', '-u', 'origin', branchName], execOptions);
      } catch (pushErr) {
        // If push fails due to permissions, that's okay - local branch still works
        console.warn('Push to remote failed (may be expected in some setups):', pushErr);
      }
    } else {
      // Branch exists, clone it directly
      execFileSync(
        'git',
        ['clone', '--branch', branchName, '--single-branch', repoUrl, repoDir],
        execOptions
      );
    }

    // Verify clone was successful by checking for .git directory
    const gitDir = path.join(repoDir, '.git');
    if (!fs.existsSync(gitDir)) {
      throw new Error('Clone succeeded but .git directory not found');
    }

    return {
      success: true,
      repoPath: repoDir,
      branch: branchName,
    };
  } catch (err) {
    // Attempt rollback - clean up half-created directory
    try {
      cleanupTaskWorkspace(taskNameNormalized);
    } catch {
      // Cleanup failed - this is a critical error
      return {
        success: false,
        repoPath: repoDir,
        branch: branchName,
        error: `Clone failed and cleanup also failed: ${err}`,
        errorCode: 'cleanup_failed',
      };
    }

    const error = err instanceof Error ? err.message : String(err);
    let errorCode: GitCloneResult['errorCode'] = 'git_error';

    if (error.includes('Authentication failed') || error.includes('permission')) {
      errorCode = 'permission_error';
    } else if (error.includes('Connection') || error.includes('network') || error.includes('timeout')) {
      errorCode = 'network_error';
    }

    return {
      success: false,
      repoPath: repoDir,
      branch: branchName,
      error: `Git operation failed: ${error}`,
      errorCode,
    };
  }
}

/**
 * Get current branch name in a repo directory.
 */
export function getCurrentBranch(repoDir: string): string | null {
  try {
    const branch = execFileSync('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return branch.trim();
  } catch {
    return null;
  }
}

/**
 * Get git status for a repo.
 */
export function getGitStatus(repoDir: string): {
  isClean: boolean;
  currentBranch: string | null;
  hasChanges: boolean;
  stagedChanges: number;
  unstagedChanges: number;
} {
  try {
    const status = execFileSync('git', ['-C', repoDir, 'status', '--porcelain'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const lines = status.trim().split('\n').filter(Boolean);
    let stagedCount = 0;
    let unstagedCount = 0;

    for (const line of lines) {
      if (line.startsWith('??') || line.startsWith('!!')) {
        // Untracked - consider unstaged
        unstagedCount++;
      } else if (line[1] === ' ') {
        // Staged change
        stagedCount++;
      } else {
        // Unstaged change
        unstagedCount++;
      }
    }

    return {
      isClean: lines.length === 0,
      currentBranch: getCurrentBranch(repoDir),
      hasChanges: lines.length > 0,
      stagedChanges: stagedCount,
      unstagedChanges: unstagedCount,
    };
  } catch {
    return {
      isClean: false,
      currentBranch: null,
      hasChanges: false,
      stagedChanges: 0,
      unstagedChanges: 0,
    };
  }
}
