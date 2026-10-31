/**
 * Single source of truth for every filesystem path in the plugin.
 *
 * The run-context-dependent paths (task dir, checkpoint, lock, run metadata)
 * are resolved from the current run context (`run-context.ts`): in local mode
 * the plugin works inside the user's business repository and the runtime state
 * lives under `<repoRoot>/.sdd`; in remote mode everything falls back to the
 * plugin root, which is the behaviour that existed before the local mode was
 * introduced. `getWorkspaceBase()` stays context-independent - it always means
 * "the remote-mode task workspace parent".
 *
 * The plugin root lookup lives in `plugin-root.ts` so that this module and
 * `run-context.ts` can both use it without importing each other.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getPluginRoot } from './plugin-root.js';
import { getRunContext, isLocalMode } from './run-context.js';

/** Plugin root - re-exported so callers keep a single import site. */
export { getPluginRoot };

/**
 * Base directory holding one sub-directory per task workspace.
 * Override with SDD_GRAPH_WORKSPACE_BASE (tests point this at a temp dir).
 * The override is resolved to an absolute path so every derived work-order
 * path stays absolute even when the variable holds a relative value.
 *
 * This function is deliberately **independent of the run context**: it means
 * "where the remote-mode task workspaces live", and `getWorkspaceInfo()`
 * enumerates it as such. In local mode the task directories live under the
 * run context's `.sdd` root instead, and `getTaskDir()` resolves them there
 * without going through this function.
 */
export function getWorkspaceBase(): string {
  const override = process.env.SDD_GRAPH_WORKSPACE_BASE;
  if (override) {
    return path.resolve(override);
  }
  return path.join(getPluginRoot(), 'workspace', 'tasks');
}

/**
 * Runtime state root of the current run.
 * Format: local → <sdd-home>; remote → <plugin-root>/runtime
 */
export function getSddHome(): string {
  return getRunContext().sddHome;
}

/**
 * Task workspace directory.
 * Format: local → <sdd-home>/tasks/<taskName>; remote → <workspace-base>/<taskName>
 *
 * In local mode the directory MUST stay under the `.sdd` root: the task
 * workspace is deleted recursively on rollback, and pointing it at the user's
 * business repository would delete the user's own code.
 */
export function getTaskDir(taskName: string): string {
  if (isLocalMode()) {
    return path.join(getSddHome(), 'tasks', taskName);
  }
  return path.join(getWorkspaceBase(), taskName);
}

/**
 * Repository directory of a task.
 * Format: <task-dir>/repo
 */
export function getRepoDir(taskName: string): string {
  return path.join(getTaskDir(taskName), 'repo');
}

/**
 * 倉庫根的正規化路徑。
 *
 * **要 `realpath`**：macOS 的 `/var` 是 `/private/var` 的符號連結，
 * 同一個倉庫會有兩種寫法——未正規化的路徑會讓顯示、比對、鎖的記錄
 * 對不上（使用者看到的是 `/var/...`，git 看到的是 `/private/var/...`）。
 *
 * 拿不到就退回 `path.resolve()`：路徑不存在時不該讓呼叫端炸掉。
 *
 * @param repoRoot - 倉庫根目錄
 */
export function canonicalRepoRoot(repoRoot: string): string {
  try {
    return fs.realpathSync(repoRoot);
  } catch {
    return path.resolve(repoRoot);
  }
}

/**
 * 運行時狀態根不得就是業務倉庫根。
 *
 * **為什麼是硬限制**：`cleanupTaskWorkspace()` 會刪 `<sddHome>/tasks/<task>`
 * 與 `<sddHome>/runs/<task>`。`SDD_GRAPH_SDD_HOME` 若被指到倉庫根，
 * 那兩個名字很可能就是使用者自己的目錄（`tasks/`、`runs/` 是很常見的名字）——
 * 刪掉的就是使用者正在寫的東西。
 *
 * **比較的是正規化過的路徑**：macOS 的 `/var` 與 `/private/var` 是同一個地方。
 *
 * @param sddHome - 運行時狀態根
 * @param repoRoot - 業務倉庫根
 * @throws Error when the two are the same directory
 */
export function assertSddHomeSeparate(sddHome: string, repoRoot: string): void {
  if (canonicalRepoRoot(sddHome) === canonicalRepoRoot(repoRoot)) {
    throw new Error(
      `SDD_GRAPH_SDD_HOME 不得指向業務倉庫根（${repoRoot}）：` +
        '插件的清理會刪掉 <狀態根>/tasks/<task> 與 <狀態根>/runs/<task>，' +
        '那很可能就是你自己的目錄。請把它指到別處（例如 <repo>/.sdd）。'
    );
  }
}

/**
 * Requirement documents live INSIDE the cloned repo so they are committed
 * together with the code.
 * Format: <repo-dir>/docs/<requirementName>
 *
 * **就地模式的預設是使用者的業務倉庫根**：就地工作沒有 clone 出來的副本，
 * 文件要寫進使用者自己的倉庫（`<repoRoot>/docs/<requirementName>`）。
 * `getRepoDir()` 在就地模式指的是 `.sdd` 下的路徑，拿它當預設會把文件
 * 寫到一個不是倉庫的地方去。
 *
 * @param requirementName - Normalized requirement name (== normalized task name)
 * @param repoDir - Optional explicit repo directory (fixtures/tests)
 */
export function getDocsDir(requirementName: string, repoDir?: string): string {
  const base =
    repoDir ??
    (isLocalMode()
      ? canonicalRepoRoot(getRunContext().repoRoot)
      : getRepoDir(requirementName));
  return path.join(base, 'docs', requirementName);
}

/**
 * Verification log directory of a resolved docs directory.
 * Format: <docs-dir>/verify
 */
export function getVerifyLogDirFromDocs(docsDir: string): string {
  return path.join(docsDir, 'verify');
}

/**
 * Verification log directory.
 * Format: <docs-dir>/verify
 */
export function getVerifyLogDir(requirementName: string, repoDir?: string): string {
  return getVerifyLogDirFromDocs(getDocsDir(requirementName, repoDir));
}

/**
 * Global branch runtime lock file.
 * Format: local → <sdd-home>/branch-lock.json; remote → <plugin-root>/runtime/branch-runtime-lock.json
 *
 * In remote mode the path is **not** configurable through the environment:
 * the lock is global, and an environment variable that silently points it
 * somewhere else would let two runs use two different locks. Callers that
 * need another file (the tests) pass it explicitly - `buildGraph({ lockPath })`
 * and the `lockPath` option of the lock functions.
 *
 * In local mode the lock lives under the run context's `.sdd` root so that
 * two repositories do not lock each other out.
 */
export function getLockFilePath(): string {
  if (isLocalMode()) {
    return path.join(getSddHome(), 'branch-lock.json');
  }
  return path.join(getPluginRoot(), 'runtime', 'branch-runtime-lock.json');
}

/**
 * LangGraph checkpoint database.
 * Format: local → <sdd-home>/checkpoints.sqlite; remote → <plugin-root>/runtime/checkpoints.sqlite
 */
export function getCheckpointPath(): string {
  if (isLocalMode()) {
    return path.join(getSddHome(), 'checkpoints.sqlite');
  }
  return path.join(getPluginRoot(), 'runtime', 'checkpoints.sqlite');
}

/**
 * Run metadata file.
 * Format: local → <sdd-home>/runs/<taskName>/run-metadata.json; remote → <task-dir>/run-metadata.json
 */
export function getRunMetadataPath(taskName: string): string {
  if (isLocalMode()) {
    return path.join(getSddHome(), 'runs', taskName, 'run-metadata.json');
  }
  return path.join(getTaskDir(taskName), 'run-metadata.json');
}

/**
 * The body of a work order.
 *
 * Every work order is a prompt file: the graph reads the file, the host
 * reads the text the CLI hands it.
 *
 * Format: <plugin-root>/prompts/<name>.md
 *
 * @param name - Name of the prompt (without the `.md` suffix).
 * @param promptsDir - The directory the prompt files live in. Defaults to
 *   the plugin root; the tests point it at a temp dir, so that a test never
 *   writes into the directory the plugin ships.
 */
export function getPromptPath(name: string, promptsDir?: string): string {
  return path.join(promptsDir ?? path.join(getPluginRoot(), 'prompts'), `${name}.md`);
}

/**
 * Read a document of the run.
 *
 * A document that does not exist reads as an empty one; a document that
 * exists but cannot be read is an error - **a broken document is not an
 * empty document**, and the two must not look the same to the gates.
 *
 * @param file - Absolute path of the document.
 * @throws Error when the file exists but cannot be read.
 */
export function readDoc(file: string): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8');
}

/**
 * Read the body of a work order.
 *
 * @param name - Name of the prompt (without the `.md` suffix).
 * @param promptsDir - The directory the prompt files live in. Defaults to
 *   the plugin root; the tests point it at a temp dir.
 * @throws Error when the prompt file cannot be read - a work order without a
 *   body cannot be worked.
 */
export function readPrompt(name: string, promptsDir?: string): string {
  const file = getPromptPath(name, promptsDir);
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read the work order prompt "${name}" (${file}): ${reason}`);
  }
}
