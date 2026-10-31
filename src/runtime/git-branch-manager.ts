import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, ExecFileSyncOptions } from 'child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'child_process';
import { getRepoDir, getTaskDir } from './paths.js';
import { cleanupTaskWorkspace } from './task-workspace.js';
import type { ErrorCode } from './errors.js';

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
 * 本地分支準備的結果。
 */
export interface LocalBranchResult {
  /** 是否成功（成功 = 分支已就位，或使用者選擇留在當前分支）。 */
  ok: boolean;
  /** 最終所在的分支；工作區髒且使用者選擇留在當前分支時 = 當前分支。 */
  branch: string;
  /** 切換前的當前分支。 */
  currentBranch: string;
  /** 工作區是否有已跟蹤文件的改動（未跟蹤文件不算）。 */
  dirty: boolean;
  error?: string;
  errorCode?: ErrorCode;
}

/** 就地模式的 git 操作都是本地的，逾時給短一點，失敗時不用等太久。 */
const LOCAL_GIT_TIMEOUT_MS = 10_000;

/**
 * 跑就地模式 git 命令的共用選項。
 *
 * argv 陣列、不經過 shell（分支名裡的 `;` 只是分支名的一部分）；
 * `LC_ALL=C` 讓 git 的錯誤訊息到處都一樣，錯誤訊息才能被拿來判斷原因。
 */
function localGitOptions(): ExecFileSyncOptionsWithStringEncoding {
  return {
    encoding: 'utf-8',
    timeout: LOCAL_GIT_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C' },
  };
}

/**
 * 從 git 失敗的例外裡取出可讀的錯誤訊息。
 *
 * git 的診斷訊息在 stderr；`execFileSync` 把它附在例外的 `stderr` 上。
 * 取不到時退回例外本身的訊息（至少還看得到是什麼命令失敗）。
 */
function gitErrorText(err: unknown): string {
  if (err instanceof Error) {
    const stderr = (err as Error & { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') {
      return stderr.trim();
    }
    return err.message;
  }
  return String(err);
}

/**
 * 判斷工作區是否「髒」。
 *
 * **口徑只看已跟蹤文件的修改**：`git status --porcelain --untracked-files=no`。
 *
 * 未跟蹤文件不算髒，因為切分支時它們會跟著走、不會丟；
 * 而且插件自己的 `.sdd/`、上一輪遺留的 `docs/<other-task>/` 通常都是未跟蹤的，
 * 把它們算成髒會讓閘門每一輪都觸發，就地模式直接不可用。
 *
 * 反過來，已跟蹤文件被改過 = 使用者自己正在寫的東西，
 * 切分支會把它帶走，必須攔下來問使用者，所以這種情況要算髒。
 *
 * @param repoRoot - git 倉庫根目錄
 * @returns 有已跟蹤文件的改動時為 true
 * @throws git 失敗時丟出例外（呼叫端要分得出「髒」跟「查不到」，
 *         查不到時回 false 會被誤讀成「乾淨」，那比報錯更危險）
 */
export function isWorktreeDirty(repoRoot: string): boolean {
  const out = execFileSync(
    'git',
    ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=no'],
    localGitOptions()
  );
  return out.trim() !== '';
}

/**
 * 取得目前所在的分支名。
 *
 * 空倉庫（還沒有任何 commit）時 git 會失敗，此時回 `HEAD`——
 * 呼叫端要的是一個可以寫進 run-metadata 的字串，不是 undefined。
 *
 * @param repoRoot - git 倉庫根目錄
 * @returns 分支名；取不到時為 `'HEAD'`
 */
export function currentBranchName(repoRoot: string): string {
  try {
    const out = execFileSync(
      'git',
      ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'],
      localGitOptions()
    );
    const name = out.trim();
    return name === '' ? 'HEAD' : name;
  } catch {
    // 空倉庫（還沒有任何 commit）git 會失敗；此時用 HEAD 代表「沒有分支」。
    return 'HEAD';
  }
}

/**
 * 本地分支是否存在。
 *
 * 用 `refs/heads/<name>` 精確比對本地分支（不看遠端分支，
 * 也不看同名檔案或 tag）。`--quiet` 讓「不存在」只是退出碼 1，不噴錯誤訊息。
 */
function localBranchExists(repoRoot: string, branchName: string): boolean {
  try {
    execFileSync(
      'git',
      ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
      localGitOptions()
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 在使用者的倉庫裡準備好工作分支（就地模式）。
 *
 * **行為**：
 * 1. 先看工作區乾不乾淨（口徑見 {@link isWorktreeDirty}）；
 * 2. `skipSwitch` → 不切分支，留在當前分支（回傳的 `branch` 是**當前分支名**，
 *    不是目標分支名——run-metadata 要記「真的所在」的分支）；
 * 3. 工作區髒 → 不切、不 stash、不 reset，直接回報錯誤讓呼叫端去問使用者
 *    （使用者決定留在當前分支時，改傳 `skipSwitch: true` 再呼叫一次）；
 * 4. 分支已存在 → `git checkout <branch>`；不存在 → `git checkout -b <branch>`。
 *    分支已存在但 base 不同也照切（那是使用者自己的同名分支，插件不替他判斷）。
 *
 * **絕不做會丟掉使用者改動的事**：不用 `checkout -f`、不用 `clean -fd`、
 * 不用 `stash`、不用 `reset --hard`。git 失敗時把它的原始訊息帶出來，
 * 使用者才知道是分支被別的 worktree 佔用，還是別的問題。
 *
 * @param repoRoot - 使用者業務倉庫的根目錄
 * @param branchName - 目標分支名
 * @param opts - `skipSwitch: true` 表示不切分支，就在此刻的分支上工作
 * @returns 準備結果；失敗時 `ok` 為 false 並帶 `error` / `errorCode`
 */
export function prepareLocalBranch(
  repoRoot: string,
  branchName: string,
  opts: { skipSwitch?: boolean } = {}
): LocalBranchResult {
  const currentBranch = currentBranchName(repoRoot);

  let dirty: boolean;
  try {
    dirty = isWorktreeDirty(repoRoot);
  } catch (err) {
    return {
      ok: false,
      branch: currentBranch,
      currentBranch,
      dirty: false,
      error: `無法判斷工作區狀態：${gitErrorText(err)}`,
      errorCode: 'git_error',
    };
  }

  // 使用者已經決定留在當前分支上工作 → 什麼都不切，回報真的所在分支。
  if (opts.skipSwitch) {
    return { ok: true, branch: currentBranch, currentBranch, dirty };
  }

  // 髒工作區：已跟蹤的改動會被帶到新分支上（使用者正在寫的東西），
  // 所以停下來問使用者，而不是替他 stash 或替他帶走。
  if (dirty) {
    return {
      ok: false,
      branch: currentBranch,
      currentBranch,
      dirty: true,
      error:
        '工作區有已跟蹤文件的改動，插件不會自動 stash，也不會把這些改動帶到新分支。' +
        '請先讓使用者確認；若使用者選擇留在當前分支繼續，改用 skipSwitch。',
      errorCode: 'git_error',
    };
  }

  const exists = localBranchExists(repoRoot, branchName);
  const args = exists
    ? ['-C', repoRoot, 'checkout', branchName]
    : ['-C', repoRoot, 'checkout', '-b', branchName];

  try {
    execFileSync('git', args, localGitOptions());
  } catch (err) {
    const detail = gitErrorText(err);
    // 分支被別的 worktree 佔用是最常見的原因，講清楚，使用者才知道要鬆哪裡。
    // git 的說法隨版本而異（"already checked out at" / "already used by worktree"），兩種都認。
    const occupied =
      detail.includes('already checked out at') || detail.includes('already used by worktree');
    const hint = occupied
      ? '（該分支已被另一個 worktree 佔用，請先釋放那個 worktree 或換一個分支名。）'
      : '';
    return {
      ok: false,
      branch: currentBranch,
      currentBranch,
      dirty,
      error: `git checkout ${branchName} 失敗：${detail}${hint}`,
      errorCode: 'git_error',
    };
  }

  // 以切換後實際所在的分支為準，不假設 git 一定切到我們要的地方。
  return {
    ok: true,
    branch: currentBranchName(repoRoot),
    currentBranch,
    dirty,
  };
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
