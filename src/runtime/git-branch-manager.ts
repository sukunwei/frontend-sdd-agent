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
  /**
   * 工作區是否有已跟蹤文件的改動（未跟蹤文件不算）。
   *
   * `undefined` = **無法判斷**（例如不是 git 倉庫、git 失敗），
   * 不是「乾淨」——不知道就說不知道，別寫成 false 讓人誤以為可以放心往下走。
   */
  dirty: boolean | undefined;
  error?: string;
  errorCode?: ErrorCode;
}

/**
 * 只讀 git 命令（status / rev-parse）的逾時。
 *
 * 這些命令只是看狀態，不該把使用者卡住；大倉庫的 `git status` 偶爾慢，
 * 給 10 秒夠用又不會變成無限期等待。
 */
export const GIT_READ_TIMEOUT_MS = 10_000;

/**
 * 寫入型 git 命令（checkout）的逾時。
 *
 * **寫操作不能用只讀的短逾時**：`execFileSync` 逾時會把 git 砍掉（SIGTERM），
 * 切大分支時可能在「索引已更新、檔案還沒寫完」的中途被砍，
 * 留下一堆要 `git checkout .` 才能收拾的半完成狀態——
 * 那是在使用者真實的倉庫上動手，砍半的代價太高。
 */
export const GIT_WRITE_TIMEOUT_MS = 120_000;

/**
 * 跑只讀 git 命令的選項。
 *
 * argv 陣列、不經過 shell（分支名裡的 `;` 只是分支名的一部分）；
 * `LC_ALL=C` 讓 git 的錯誤訊息到處都一樣，錯誤訊息才能被拿來判斷原因。
 */
function localReadOptions(): ExecFileSyncOptionsWithStringEncoding {
  return {
    encoding: 'utf-8',
    timeout: GIT_READ_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C' },
  };
}

/**
 * 跑寫入型 git 命令的選項（只有 checkout 走這條）。
 *
 * 逾時比只讀命令長，理由見 {@link GIT_WRITE_TIMEOUT_MS}。
 */
function localWriteOptions(): ExecFileSyncOptionsWithStringEncoding {
  return {
    encoding: 'utf-8',
    timeout: GIT_WRITE_TIMEOUT_MS,
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
 * 這次失敗是逾時造成的嗎？
 *
 * `execFileSync` 逾時會把 git 砍掉（SIGTERM），例外上帶 `code: 'ETIMEDOUT'`、
 * `status: null`、`signal: 'SIGTERM'`；git 自己拒絕時則是 `status` 有數字。
 * **逾時與 git 自己的拒絕要分得開**：逾時代表「命令沒跑完」——
 * 對寫操作來說還可能留下半完成的狀態，與「git 拒絕了這件事」完全不同，
 * 使用者要能一眼看出是哪一種。
 */
function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const e = err as Error & {
    code?: unknown;
    status?: number | null;
    signal?: string | null;
  };
  return e.code === 'ETIMEDOUT' || (e.status === null && e.signal === 'SIGTERM');
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
    localReadOptions()
  );
  return out.trim() !== '';
}

/**
 * 取得目前所在的分支名。
 *
 * **回傳 `'HEAD'` 代表「目前不在任何分支上」，它不是一個分支名。**
 * 兩種情況都會得到 `'HEAD'`：
 * - detached HEAD（checkout 到某個 commit，沒有分支指向它）——
 *   `git rev-parse --abbrev-ref HEAD` 會印出字面的 `HEAD`，這裡明確地把它當成「沒有分支」；
 * - 倉庫還沒有任何提交（沒有分支可站）——rev-parse 會直接失敗。
 *
 * 兩種情況都不回「那個還沒生出來的分支名」：
 * 呼叫端（例如寫 run-metadata）要的是一個真的存在的分支，
 * 拿到一個不存在的分支名，比拿到明確的 `'HEAD'` 更糟。
 *
 * @param repoRoot - git 倉庫根目錄
 * @returns 分支名；**不在任何分支上**（或不是 git 倉庫）時為 `'HEAD'`
 */
export function currentBranchName(repoRoot: string): string {
  try {
    const out = execFileSync(
      'git',
      ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'],
      localReadOptions()
    );
    const name = out.trim();
    // detached HEAD 時 git 印出的就是字面的 'HEAD'——那不是分支名。
    if (name === '' || name === 'HEAD') {
      return 'HEAD';
    }
    return name;
  } catch {
    // 空倉庫（還沒有任何提交）或不是 git 倉庫：沒有「目前所在的分支」可言。
    return 'HEAD';
  }
}

/**
 * 本地分支是否存在。
 *
 * 用 `refs/heads/<name>` 精確比對本地分支（不看遠端分支，
 * 也不看同名檔案或 tag）。`--quiet` 讓「不存在」只是退出碼 1，不噴錯誤訊息。
 *
 * @param repoRoot - 倉庫根目錄
 * @param branchName - 分支名（不含 `refs/heads/`）
 */
export function localBranchExists(repoRoot: string, branchName: string): boolean {
  try {
    execFileSync(
      'git',
      ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
      localReadOptions()
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
 * **回傳值的三種失敗語意**（靠 `ok` + `dirty` 一起看）：
 * - `ok:false` + `dirty:true` → 工作區髒，需要使用者決定（呼叫端開閘門）；
 * - `ok:false` + `dirty:undefined` → 連工作區狀態都查不到（不是 git 倉庫、git 失敗）；
 * - `ok:false` + `dirty:false` → 真的 git 失敗（checkout 被拒絕或逾時）。
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
      // **不知道就說不知道**：這裡回 false 會被讀成「工作區乾淨」。
      dirty: undefined,
      error: isTimeoutError(err)
        ? `無法判斷工作區狀態：git status 逾時（${GIT_READ_TIMEOUT_MS / 1000} 秒後被中止）。`
        : `無法判斷工作區狀態：${gitErrorText(err)}`,
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
    // checkout 是寫操作，用獨立的長逾時（見 {@link GIT_WRITE_TIMEOUT_MS}）。
    execFileSync('git', args, localWriteOptions());
  } catch (err) {
    // 逾時 ≠ git 拒絕：逾時是「命令被砍在半路」，可能留下半完成的索引，
    // 使用者要能分辨這兩種情況（處理方式完全不同）。
    if (isTimeoutError(err)) {
      return {
        ok: false,
        branch: currentBranch,
        currentBranch,
        dirty,
        error:
          `git checkout ${branchName} 逾時（${GIT_WRITE_TIMEOUT_MS / 1000} 秒後被中止）：` +
          '命令可能沒跑完，工作區可能處於半完成狀態，請先用 git status 確認。',
        errorCode: 'git_error',
      };
    }
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
