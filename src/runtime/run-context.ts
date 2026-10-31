import * as path from 'path';
import { getPluginRoot } from './plugin-root.js';

/**
 * 這一次運行工作在哪一種倉庫上。
 *
 * - `local`：就地工作，程式碼直接寫在用戶的業務倉庫裡。
 * - `remote`：舊的克隆模式，倉庫是插件 workspace 裡的一份副本。
 */
export type RepoMode = 'local' | 'remote';

export interface RunContext {
  mode: RepoMode;
  /** local: 業務倉庫根；remote: clone 出來的倉庫目錄 */
  repoRoot: string;
  /** 運行時狀態根（local 模式 = <repoRoot>/.sdd） */
  sddHome: string;
  /** remote 模式 = <插件根>/workspace/tasks；local 模式不使用 */
  workspaceBase: string;
}

/**
 * 當前運行上下文。
 *
 * 未設置時 `getRunContext()` 退回插件根的 remote 上下文，既有命令
 *（resume / status / stop）與既有測試因此一行不改也能跑。
 */
let current: RunContext | undefined;

/**
 * 設置這一次運行的上下文。
 *
 * 這是全進程唯一的上下文：節點拿不到 CLI 的參數，卻又要知道自己在
 * 哪個倉庫裡工作，所以上下文必須是模組級單例而不是逐層透傳。
 */
export function setRunContext(ctx: RunContext): void {
  current = ctx;
}

/**
 * 取得當前運行上下文；未設置時退回插件根的 remote 上下文。
 */
export function getRunContext(): RunContext {
  if (current) return current;
  const pluginRoot = getPluginRoot();
  return {
    mode: 'remote',
    repoRoot: pluginRoot,
    sddHome: path.join(pluginRoot, 'runtime'),
    workspaceBase: path.join(pluginRoot, 'workspace', 'tasks'),
  };
}

/**
 * 清除運行上下文，回到未設置的狀態（測試用）。
 */
export function resetRunContext(): void {
  current = undefined;
}

/**
 * 目前是否為就地模式。
 */
export function isLocalMode(): boolean {
  return getRunContext().mode === 'local';
}

/**
 * 推導某個倉庫的運行時狀態根。
 *
 * `SDD_GRAPH_SDD_HOME` 可覆寫（例如把狀態放在磁碟之外或共用一份），
 * 覆寫值一律解析成絕對路徑，衍生路徑才不會隨 cwd 漂移。
 *
 * @param repoRoot - 業務倉庫根
 */
export function defaultSddHome(repoRoot: string): string {
  const override = process.env.SDD_GRAPH_SDD_HOME;
  if (override) return path.resolve(override);
  return path.join(repoRoot, '.sdd');
}
