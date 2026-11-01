import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ErrorCode } from './errors.js';
import type { RepoMode } from './run-context.js';

/**
 * 解析後的目標倉庫。
 */
export interface ResolvedRepo {
  /** local = 就地工作；remote = 克隆一份到外掛目錄。 */
  mode: RepoMode;
  /**
   * local：倉庫的真實根（`git rev-parse --show-toplevel`）。
   * remote：空字串——clone 的目標目錄由呼叫端決定，解析器不猜
   * （clone 之前那個目錄還不存在，解析器沒有任何依據可以填）。
   */
  repoRoot: string;
  /** remote 模式的原始 URL；local 模式為 undefined。 */
  remoteUrl?: string;
}

/**
 * 倉庫解析失敗。
 *
 * 帶著 `code`（`validation_error`）是為了讓呼叫端把它翻成對應的錯誤碼，
 * 而不是一律當成 `internal_error`——使用者打錯 `--repo` 是自己的問題，
 * 該由使用者改，不是插件的 bug。
 */
export class RepoResolutionError extends Error {
  readonly code: ErrorCode = 'validation_error';

  constructor(message: string) {
    super(message);
    this.name = 'RepoResolutionError';
  }
}

/**
 * 這個字串看起來是遠端倉庫嗎？
 *
 * **`file://` 也算 remote，這是刻意的相容設計。** 過去 `--repo ../other-repo`
 * 會把那一路徑克隆一份到外掛的 workspace；現在同一串會被判成 local（就地工作），
 * 那是靜默的行為變更。要保留「從本地路徑克隆」的舊用法，就改寫 `file://` 前綴。
 *
 * **以 `.git` 結尾的路徑算 remote**，但那只是**字串形態的預判**：
 * 一個真的存在、而且真的是 git 倉庫的 `foo.git` 目錄仍然是就地工作
 * （見 {@link resolveRepo}）——使用者眼前是一個真的倉庫，就地工作才是他
 * 想要的。判斷只看字串形態，因為解析器還不知道那個目錄存不存在。
 *
 * @param spec - 使用者給的 `--repo` 值
 */
export function isRemoteSpec(spec: string): boolean {
  return spec.includes('://') || spec.startsWith('git@') || spec.endsWith('.git');
}

/**
 * 這個字串是 URL 嗎（不是檔案系統路徑）？
 *
 * **`file://` 是 URL**：它明確表示「把這份路徑克隆一份」，即使那個路徑
 * 存在而且是 git 倉庫也不就地工作——那是保留舊用法的出口。
 */
function isUrlSpec(spec: string): boolean {
  return spec.includes('://') || spec.startsWith('git@');
}

/**
 * 取得某個目錄所在 git 倉庫的真實根。
 *
 * **走 git 命令而不是查 `.git` 目錄**：`isGitRepository()` 只對倉庫根有效——
 * 倉庫的子目錄裡沒有 `.git`，會被誤判成「不是倉庫」，而使用者給的 `--repo`
 * 完全可能就是倉庫裡的某個子目錄。
 *
 * git 的輸出用 C locale 讀（`LC_ALL=C`），訊息才到處都一樣。
 *
 * @param dir - 要查的目錄
 * @returns 倉庫根；不是 git 倉庫（或 git 失敗）時為 undefined
 */
export function gitTopLevel(dir: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    const top = out.trim();
    return top === '' ? undefined : top;
  } catch {
    return undefined;
  }
}

/**
 * 把 `--repo` 的值解析成 local 或 remote 模式。
 *
 * **判定順序是固定的，不猜**：
 * 1. 缺省 → 用 `cwd`；
 * 2. **既存的路徑且是 git 倉庫 → local**（目錄名是不是 `.git` 結尾不影響，
 *    見 {@link isRemoteSpec}）；
 * 3. 命中 URL 形態 → remote（`file://` 也算）；
 * 4. 其餘按路徑處理 → 路徑不存在或不是 git 倉庫就報錯。
 *
 * 路徑寫錯與 URL 寫錯在使用者眼裡是同一件事——「看起來對，其實不對」——
 * 所以路徑不存在時，錯誤訊息把兩種可能都講出來。
 *
 * @param spec - `--repo` 的值；undefined 或空白表示用 cwd
 * @param cwd - 解析相對路徑的基準目錄
 * @throws RepoResolutionError 當 spec 兩種模式都不是
 */
export function resolveRepo(spec: string | undefined, cwd: string): ResolvedRepo {
  const raw = spec?.trim() || cwd;
  const target = path.resolve(cwd, raw);

  // **既存的路徑先當本機路徑**：目錄名叫 `foo.git` 也一樣——使用者眼前是
  // 一個真的 git 倉庫，就地工作才是他想要的。`file://` 與其他 URL 除外
  // （那是「克隆一份」的明確指示）。
  if (!isUrlSpec(raw) && fs.existsSync(target)) {
    const top = gitTopLevel(target);
    if (top !== undefined) {
      return { mode: 'local', repoRoot: fs.realpathSync(top) };
    }
  }

  if (isRemoteSpec(raw)) {
    return { mode: 'remote', repoRoot: '', remoteUrl: raw };
  }

  if (!fs.existsSync(target)) {
    throw new RepoResolutionError(
      `路徑不存在：${target}。` +
        '若要指向遠端倉庫，請改給 repository URL' +
        '（例如 https://github.com/x/y.git、git@github.com:x/y.git 或 file:///path/to/repo）。'
    );
  }

  const top = gitTopLevel(target);
  if (top === undefined) {
    throw new RepoResolutionError(
      `不是 git 倉庫：${target}。就地工作必須在 git 倉庫裡進行。` +
        '若要指向遠端倉庫，請改給 repository URL（例如 https://github.com/x/y.git）。'
    );
  }

  return { mode: 'local', repoRoot: fs.realpathSync(top) };
}
