import * as fs from 'fs';
import * as path from 'path';
import {
  canonicalRepoRoot,
  getTaskDir,
  getRepoDir,
  getSddHome,
  getWorkspaceBase,
} from './paths.js';
import { getRunContext, isLocalMode } from './run-context.js';

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
 *   <task-dir>/repo/    (remote 模式才有)
 *
 * This is idempotent - if directories already exist, it does not error.
 *
 * **就地模式（local）只建 `<task-dir>`**（= `<sdd-home>/tasks/<task>`）：
 * 就地工作的「倉庫」就是使用者的業務倉庫，`<task-dir>/repo` 不會裝任何東西，
 * 建一個空目錄只會讓人誤以為程式碼寫在那裡。
 *
 * @param taskNameNormalized - Normalized task name (kebab-case)
 * @returns Result with success status and paths
 */
export function initTaskWorkspace(taskNameNormalized: string): TaskWorkspaceResult {
  const taskDir = getTaskDir(taskNameNormalized);
  const repoDir = getRepoDir(taskNameNormalized);
  // 就地模式的「倉庫」是使用者的業務倉庫根，不是 <task-dir>/repo；
  // 用正規化後的路徑，才跟 `startTask()` 回報的 repoPath、鎖檔與
  // run-metadata 指向同一個地方。
  const effectiveRepoDir = isLocalMode()
    ? canonicalRepoRoot(getRunContext().repoRoot)
    : repoDir;

  try {
    // Create task directory
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true, mode: 0o755 });
    }

    // Create repo subdirectory（就地模式沒有 repo 目錄——見上）
    if (!isLocalMode() && !fs.existsSync(repoDir)) {
      fs.mkdirSync(repoDir, { recursive: true, mode: 0o755 });
    }

    // Verify write permissions by attempting to write a temp file
    const testFile = path.join(taskDir, '.write-test');
    fs.writeFileSync(testFile, 'test', { mode: 0o644 });
    fs.unlinkSync(testFile);

    return {
      success: true,
      taskDir,
      repoDir: effectiveRepoDir,
      created: true,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      taskDir,
      repoDir: effectiveRepoDir,
      created: false,
      error: `Failed to initialize workspace: ${error}`,
    };
  }
}

/**
 * Check if a task workspace already exists.
 *
 * 就地模式的 workspace 是 `<sdd-home>/tasks/<task>`（沒有 repo 子目錄），
 * 所以判據只有 task 目錄本身；remote 模式維持「task 目錄與 repo 目錄都在」的舊判準。
 *
 * @param taskNameNormalized - Normalized task name
 */
export function taskWorkspaceExists(taskNameNormalized: string): boolean {
  const taskDir = getTaskDir(taskNameNormalized);
  if (isLocalMode()) {
    return fs.existsSync(taskDir);
  }
  return fs.existsSync(taskDir) && fs.existsSync(path.join(taskDir, 'repo'));
}

/**
 * Get workspace info (space usage, existing tasks, etc.)
 *
 * **就地模式列舉的是 `<sdd-home>/tasks`**：`getWorkspaceBase()` 永遠是外掛根的
 * remote 語義（Task 1 的裁決），就地模式的 task 目錄不在那裡——照舊列舉的話
 * `status` 會說「沒有任務」，而 `.sdd/tasks/` 下明明有。
 */
export function getWorkspaceInfo(): {
  workspaceBase: string;
  existingTasks: string[];
  totalSize: number;
} {
  const workspaceBase = isLocalMode() ? path.join(getSddHome(), 'tasks') : getWorkspaceBase();
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
 *
 * **就地模式只刪 `<sdd-home>/` 之下的兩個目錄**（`tasks/<task>` 與 `runs/<task>`）：
 * 使用者的業務倉庫裡的 `docs/<task>/`、分支、程式碼一概不碰——刪掉的是
 * 使用者正在寫的東西，不是插件的一次性副本。
 *
 * **刪除前一定先驗證目標確實在該根目錄之下**（{@link assertUnderBase}）：
 * 這是「刪錯就是資料遺失」的最後一道閘。
 *
 * @param taskNameNormalized - Normalized task name
 * @throws Error when a deletion target is not under the expected root
 */
export function cleanupTaskWorkspace(taskNameNormalized: string): void {
  if (isLocalMode()) {
    const sddHome = getSddHome();
    const taskDir = getTaskDir(taskNameNormalized);
    const runsDir = path.join(sddHome, 'runs', taskNameNormalized);
    // **驗到各自的父目錄，不只是「在 .sdd 之下」**：`SDD_GRAPH_SDD_HOME`
    // 若被指到倉庫根，刪的也該只是 `tasks/<task>` 與 `runs/<task>` 兩個目錄，
    // 不能是使用者在倉庫裡的整個目錄。
    assertUnderBase(path.join(sddHome, 'tasks'), taskDir);
    assertUnderBase(path.join(sddHome, 'runs'), runsDir);
    removeIfExists(taskDir);
    removeIfExists(runsDir);
    return;
  }

  // remote 模式：task 目錄在外掛的 workspace 之下，同樣先驗證再刪。
  const taskDir = getTaskDir(taskNameNormalized);
  assertUnderBase(getWorkspaceBase(), taskDir);
  removeIfExists(taskDir);
}

/**
 * 目標路徑必須**嚴格**在 `base` 之下，否則拒絕刪除。
 *
 * **這是最後一道閘**：清理函式是遞迴刪除，指向錯一次就是使用者的程式碼沒了。
 * 判斷用 `path.resolve`（詞法上）就夠——目標路徑都是自己組出來的，
 * 詞法上越界就是越界。
 *
 * **嚴格**（不接受「目標就是 base 自己」）：`cleanupTaskWorkspace('.')` 會把
 * 整個 `<sddHome>/tasks` 樹清掉——那已經不是「某個 task 的目錄」了。
 *
 * @param base - 目標必須位於其下的根目錄
 * @param target - 要刪除的路徑
 * @throws Error when the target is not strictly under the base
 */
function assertUnderBase(base: string, target: string): void {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error(
      `refusing to delete "${target}": it is not strictly under "${resolvedBase}"`
    );
  }
}

/** 存在就刪掉（不存在不是錯）。 */
function removeIfExists(target: string): void {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}
