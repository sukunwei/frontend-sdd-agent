import * as fs from 'fs';
import * as path from 'path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

/**
 * 把舊的全域 checkpoint 庫搬進業務倉庫的 `.sdd/` 之下。
 *
 * **為什麼要搬，而不是共用一個庫**：舊版本把所有倉庫的 run 都寫進插件根目錄
 * 的同一個 sqlite 檔，於是兩個倉庫裡同名 task 的 run 會互相蓋掉。搬到每個
 * 倉庫自己的 `.sdd/checkpoints.sqlite` 之後，一個倉庫的 run 只認自己那份。
 *
 * **搬運是逐個 thread 判歸屬的，不是整庫複製**：舊庫裡可能躺著好幾個倉庫的
 * run，整庫複製會把別的倉庫的 run 也搬過來——那正是這次改造要修的問題。
 * 判準只有一個：舊 thread 的 `repoUrl` 是不是等於目標倉庫的
 * `remote.origin.url`。
 *
 * **沒有遠端地址就一條都不搬**：沒有判準就沒有歸屬，硬搬就是把別的倉庫的 run
 * 搬過來（由呼叫端 `src/cli/index.ts` 決定要不要搬）。
 *
 * **舊庫不刪**：搬運前先備份一份 `.bak`，剩下的由使用者確認後自己清理。
 */

/** 一個 checkpoint 的完整快照（型別從 `SqliteSaver` 的簽名推導，不另外依賴套件）。 */
type CheckpointTuple = NonNullable<Awaited<ReturnType<SqliteSaver['getTuple']>>>;

/** 一筆 pending write（`[taskId, channel, value]`）。 */
type PendingWriteTuple = NonNullable<CheckpointTuple['pendingWrites']>[number];

/** 遷移的選項。 */
export interface MigrateOptions {
  /** 舊的全域 checkpoint 庫 */
  legacyDbPath: string;
  /** 目標庫（<repo>/.sdd/checkpoints.sqlite） */
  targetDbPath: string;
  /** 只搬 repoUrl 匹配這個值的 thread；undefined = 全搬 */
  matchUrl?: string;
}

/** 遷移的結果。 */
export interface MigrateResult {
  /** 搬走的 thread 名。 */
  migrated: string[];
  /** 留在舊庫的 thread 名。 */
  skipped: string[];
  /** 搬運失敗時的原因（有的話）。 */
  error?: string;
  /**
   * 每個被留下的 thread 為什麼被留下。
   *
   * **一定要說清楚**：使用者要知道哪些沒被搬、為什麼——不然他只能自己去猜。
   */
  skippedReasons?: Record<string, string>;
  /**
   * 混了兩個倉庫的 thread 名。
   *
   * **這些 thread 一個 checkpoint 都沒有搬**：同一個 task 名在兩個倉庫跑過，
   * 舊庫裡只有一條 thread，兩個倉庫的 checkpoint 交錯在同一條 parent 鏈上。
   * 搬整條等於把別的倉庫的進度一起搬過來——正是這次改造要修的那個 bug。
   */
  mixed?: string[];
  /**
   * 備份檔的位置。
   *
   * **舊庫存在就會備份**（不管有沒有東西可搬）：備份是搬運前的保險，
   * 沒有東西可搬時它也只是一份等值的副本。
   */
  backupPath?: string;
}

/**
 * better-sqlite3 沒有隨套件附型別；用到的部分自己描述。
 *
 * **只宣告用得到的**：這個模組碰 sqlite 只有兩個理由——收 WAL（備份要完整）
 * 與關檔（不留著打開的連線）。
 */
interface SqliteDatabaseLike {
  /** 執行一條 pragma。 */
  pragma(statement: string): unknown;
  /** 關掉連線（sqlite 會把 WAL 收進主檔）。 */
  close(): void;
}

/**
 * 取得 saver 底下那個 sqlite 連線。
 *
 * @param saver - checkpoint 儲存器
 */
function sqliteDatabase(saver: SqliteSaver): SqliteDatabaseLike {
  return saver.db as unknown as SqliteDatabaseLike;
}

/**
 * 讀出 checkpoint 設定裡的欄位。
 *
 * **一律先當成 `unknown` 再收窄**：`configurable` 的型別是第三方套件給的
 * `Record<string, any>`，不收窄就等於把 `any` 帶進整個模組。
 */
function configurableOf(tuple: CheckpointTuple): Record<string, unknown> {
  const configurable: unknown = tuple.config.configurable;
  return typeof configurable === 'object' && configurable !== null
    ? (configurable as Record<string, unknown>)
    : {};
}

/** 把錯誤變成一句話。 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 列出舊庫裡的 thread 名。
 *
 * **只給命令層報告用**：沒有遠端地址、不能判定歸屬的時候，命令要告訴使用者
 * 哪些 thread 還留在舊庫裡。
 *
 * @param legacyDbPath - 舊的 checkpoint 庫
 * @returns thread 名（已排序）；舊庫不存在時是空陣列
 */
export async function listLegacyThreads(legacyDbPath: string): Promise<string[]> {
  if (!fs.existsSync(legacyDbPath)) return [];
  const saver = SqliteSaver.fromConnString(legacyDbPath);
  try {
    const threads = new Set<string>();
    for await (const tuple of saver.list({ configurable: {} })) {
      const id = configurableOf(tuple).thread_id;
      if (typeof id === 'string' && id !== '') threads.add(id);
    }
    return [...threads].sort();
  } finally {
    closeQuietly(saver);
  }
}

/**
 * 把舊庫裡的 thread 搬進目標庫。
 *
 * **逐個 thread 判定歸屬**：只有 `repoUrl` 等於 `matchUrl` 的 thread 才會被搬
 * （`matchUrl` 是 undefined 時全搬）。搬不走的留在舊庫，並記下為什麼。
 *
 * @param opts - 遷移選項
 * @returns 搬走的、留下的，以及（失敗時）原因
 */
export async function migrateState(opts: MigrateOptions): Promise<MigrateResult> {
  const result: MigrateResult = { migrated: [], skipped: [], skippedReasons: {}, mixed: [] };

  // **舊庫不存在不是錯誤**：沒有東西可搬而已。
  if (!fs.existsSync(opts.legacyDbPath)) {
    return result;
  }

  let legacy: SqliteSaver;
  try {
    legacy = SqliteSaver.fromConnString(opts.legacyDbPath);
  } catch (err) {
    result.error = `無法開啟舊的 checkpoint 庫（${opts.legacyDbPath}）：${errorMessage(err)}`;
    return result;
  }

  // **目標庫只有真的搬東西時才建立**：沒有東西可搬卻在使用者的倉庫裡憑空造出
  // 一個 `.sdd/checkpoints.sqlite`，是使用者不會預期的副作用。
  let target: SqliteSaver | undefined;
  const targetSaver = (): SqliteSaver => {
    if (!target) {
      fs.mkdirSync(path.dirname(opts.targetDbPath), { recursive: true });
      target = SqliteSaver.fromConnString(opts.targetDbPath);
    }
    return target;
  };

  try {
    // **備份先做**：備份要在任何寫入之前落盤。
    result.backupPath = backupLegacyDb(legacy, opts.legacyDbPath);

    const byThread = await readThreads(legacy);
    for (const threadId of [...byThread.keys()].sort()) {
      try {
        const decision = await migrateThread(
          targetSaver,
          byThread.get(threadId) ?? [],
          threadId,
          opts
        );
        if (decision.kind === 'migrated') {
          result.migrated.push(threadId);
        } else {
          result.skipped.push(threadId);
          if (decision.kind === 'mixed' && result.mixed) {
            result.mixed.push(threadId);
          }
          if (result.skippedReasons) {
            result.skippedReasons[threadId] = decision.reason;
          }
        }
      } catch (err) {
        // **一個 thread 搬失敗不該讓別的 thread 也搬不成**：記下來繼續。
        const reason = `搬運失敗：${errorMessage(err)}`;
        result.skipped.push(threadId);
        if (result.skippedReasons) result.skippedReasons[threadId] = reason;
        result.error = `thread ${threadId} ${reason}`;
      }
    }
  } catch (err) {
    result.error = errorMessage(err);
  } finally {
    closeQuietly(legacy);
    if (target) closeQuietly(target);
  }

  return result;
}

/** 一個 thread 的搬運結果。 */
type ThreadDecision =
  | { kind: 'migrated' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'mixed'; reason: string };

/**
 * 搬一個 thread（或決定不搬它）。
 *
 * @param targetSaver - 目標庫的 saver（需要時才會建立目標庫）
 * @param tuples - 這個 thread 的所有 checkpoint（新的在前）
 * @param threadId - thread 名
 * @param opts - 遷移選項
 */
async function migrateThread(
  targetSaver: () => SqliteSaver,
  tuples: CheckpointTuple[],
  threadId: string,
  opts: MigrateOptions
): Promise<ThreadDecision> {
  if (tuples.length === 0) {
    return { kind: 'skipped', reason: '舊庫裡讀不到這個 thread 的 checkpoint' };
  }

  // **歸屬要看的不是「最新那個 checkpoint」，而是整條 thread**。
  //
  // 舊庫以 task 名當 thread id，而舊庫是全域的：兩個倉庫跑過同名 task 時，
  // 舊庫裡只有**一條** thread，兩個倉庫的 checkpoint 交錯在同一條 parent 鏈上。
  // 只看最新那個會以為整條 thread 都屬於它——搬過去等於把別的倉庫的進度
  // 一起搬走（`repoUrl` 那個 channel 是後寫蓋先寫，誰最後跑誰贏）。
  // 那正是這次改造要修的 bug，遷移工具自己不能犯。
  const repoUrls = repoUrlsOf(tuples);
  if (repoUrls.normalized.size > 1) {
    return {
      kind: 'mixed',
      reason:
        `這個 thread 出現了兩種不同的 repoUrl 寫法（${repoUrls.originals.join('、')}），` +
        '它們指向不同的倉庫，請手動處理',
    };
  }

  // **比對用正規化後的值**：同一個倉庫的兩種寫法（`git@github.com:x/y.git`
  // 與 `https://github.com/x/y.git`）是同一個倉庫，不該因為寫法不同就搬不過去。
  const repoUrl = repoUrls.originals[0];
  const normalizedRepoUrl =
    repoUrls.normalized.size === 1 ? [...repoUrls.normalized][0] : undefined;
  if (opts.matchUrl !== undefined && normalizedRepoUrl !== normalizeRepoUrl(opts.matchUrl)) {
    return {
      kind: 'skipped',
      reason:
        repoUrl === undefined
          ? '讀不到 repoUrl，無法判定歸屬'
          : // **只說「不一致」，不要說「屬於別的倉庫」**：舊庫存的是使用者當初
            // 敲的 `--repo` 字串，跟 `remote.origin.url` 未必一樣。
            `repoUrl 與本倉庫不一致（舊庫的 repoUrl：${repoUrl}）`,
    };
  }

  // **目標庫裡已經有同名 thread 就不覆蓋**：使用者可能已經在新庫裡跑過這一輪，
  // 拿舊庫的資料蓋回去等於把比較新的進度弄丟。
  if (fs.existsSync(opts.targetDbPath)) {
    const existing = await targetSaver().getTuple({ configurable: { thread_id: threadId } });
    if (existing !== undefined) {
      return { kind: 'skipped', reason: '目標庫裡已經有同名 thread，不覆蓋' };
    }
  }

  await copyThread(targetSaver(), threadId, tuples);
  return { kind: 'migrated' };
}

/**
 * 把一個 thread 的 checkpoint 與 pending writes 寫進目標庫。
 *
 * **pending writes 也要搬**：thread 上還沒落地的寫作（包含那張還沒答的問題）
 * 住在另一張表裡，只搬 checkpoint 會讓這輪 run 變成「沒有 pending」，
 * `resume` 之後就接不上來了。
 *
 * **搬一半要清掉**：寫到一半出錯（磁碟滿、權限…）會在目標庫留下前幾個
 * checkpoint（parent 鏈斷在半路）。那半截 thread 會讓「目標庫裡已經有同名
 * thread」的檢查誤判成「已經搬過了」——下次執行就永遠補不齊，只能手改
 * 資料庫。所以失敗時把這條 thread 從目標庫刪掉。
 *
 * @param target - 目標庫的 saver
 * @param threadId - thread 名
 * @param tuples - 這個 thread 的所有 checkpoint
 */
async function copyThread(
  target: SqliteSaver,
  threadId: string,
  tuples: CheckpointTuple[]
): Promise<void> {
  try {
    for (const tuple of tuples) {
      const configurable = configurableOf(tuple);
      const namespace =
        typeof configurable.checkpoint_ns === 'string' ? configurable.checkpoint_ns : '';

      // **parent 的 id 要照抄**：parent 關係是 checkpoint 鏈的骨幹，搬過去之後
      // 新庫裡的這條鏈才接得起來。
      const parentConfigurable: unknown = tuple.parentConfig?.configurable;
      const parentIdRaw =
        typeof parentConfigurable === 'object' && parentConfigurable !== null
          ? (parentConfigurable as Record<string, unknown>).checkpoint_id
          : undefined;
      const parentId = typeof parentIdRaw === 'string' ? parentIdRaw : undefined;

      await target.put(
        {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: namespace,
            ...(parentId === undefined ? {} : { checkpoint_id: parentId }),
          },
        },
        tuple.checkpoint,
        tuple.metadata ?? { source: 'loop', step: 0, parents: {} }
      );

      for (const [taskId, writes] of groupWrites(tuple.pendingWrites ?? [])) {
        await target.putWrites(
          {
            configurable: {
              thread_id: threadId,
              checkpoint_ns: namespace,
              checkpoint_id: tuple.checkpoint.id,
            },
          },
          writes,
          taskId,
          ''
        );
      }
    }
  } catch (err) {
    // **清掉半截的 thread**：留著它，下次執行會被判成「已經有同名 thread」
    // 而永遠跳過。
    const cleaned = await deleteThreadQuietly(target, threadId);
    throw new Error(
      cleaned
        ? errorMessage(err)
        : `${errorMessage(err)}（而且半截的資料清不掉，請手動清理目標庫裡的這條 thread）`
    );
  }
}

/**
 * 從目標庫刪掉一條 thread。
 *
 * **清不掉要說清楚**：清不掉的使用者得自己動手，訊息裡得寫出來。
 *
 * @param target - 目標庫的 saver
 * @param threadId - thread 名
 * @returns 有沒有清掉
 */
async function deleteThreadQuietly(target: SqliteSaver, threadId: string): Promise<boolean> {
  try {
    await target.deleteThread(threadId);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把 pending writes 依 task 分組。
 *
 * **同一個 task 的順序要留著**：寫作的套用順序就是它們在 checkpoint 裡的順序。
 *
 * @param writes - 一個 checkpoint 的 pending writes
 */
function groupWrites(writes: PendingWriteTuple[]): Array<[string, Array<[string, unknown]>]> {
  const groups = new Map<string, Array<[string, unknown]>>();
  for (const [taskId, channel, value] of writes) {
    const group = groups.get(taskId) ?? [];
    group.push([channel, value]);
    groups.set(taskId, group);
  }
  return [...groups];
}

/**
 * 讀出舊庫裡的 thread 與它們的 checkpoint。
 *
 * @param saver - 舊庫的 saver
 * @returns thread 名 → 它的 checkpoint（新的在前）
 */
async function readThreads(saver: SqliteSaver): Promise<Map<string, CheckpointTuple[]>> {
  const byThread = new Map<string, CheckpointTuple[]>();
  for await (const tuple of saver.list({ configurable: {} })) {
    const id = configurableOf(tuple).thread_id;
    if (typeof id !== 'string' || id === '') continue;
    const tuples = byThread.get(id) ?? [];
    tuples.push(tuple);
    byThread.set(id, tuples);
  }
  return byThread;
}

/**
 * 這個 thread 裡出現過的 `repoUrl`。
 *
 * **空字串不算**：thread 的第一個 checkpoint（`source: 'input'`）是在輸入被
 * 套進 channel 之前寫的，`repoUrl` 還是空的——那不是「另一個倉庫」，
 * 只是還沒寫進去。
 *
 * **比對用正規化後的值**：見 {@link normalizeRepoUrl}。
 *
 * @param tuples - 這個 thread 的所有 checkpoint
 * @returns 正規化後的寫法（拿來比對）與原始寫法（拿來顯示）
 */
function repoUrlsOf(tuples: CheckpointTuple[]): { normalized: Set<string>; originals: string[] } {
  const normalized = new Set<string>();
  const originals: string[] = [];
  for (const tuple of tuples) {
    const values: unknown = tuple.checkpoint.channel_values;
    if (typeof values !== 'object' || values === null) continue;
    const url = (values as Record<string, unknown>).repoUrl;
    if (typeof url !== 'string' || url === '') continue;
    normalized.add(normalizeRepoUrl(url));
    if (!originals.includes(url)) originals.push(url);
  }
  return { normalized, originals };
}

/**
 * 去掉結尾的 `.git`。
 */
function stripGitSuffix(path: string): string {
  return path.replace(/\.git$/, '');
}

/**
 * 把 repoUrl 正規化，讓「同一個倉庫的不同寫法」變成同一個值。
 *
 * **為什麼要正規化**：`git@github.com:x/y.git` 與 `https://github.com/x/y.git`
 * 是同一個倉庫，但字串比對會說它們不同 —— 那會讓一條 thread 被判成
 * 「混了兩個倉庫」，**一個 checkpoint 都搬不過去**，而且沒有覆寫的出口。
 *
 * 做的三件事：
 * 1. 去掉結尾的 `.git`；
 * 2. `git@host:path` → `host/path`；
 * 3. `scheme://host/path` → `host/path`（主機名的大小寫正規化，路徑不動 ——
 *    某些主機上的路徑是大小寫敏感的）。
 *
 * `file://` 與本機路徑不會被拆成 `host/path`（那樣會把兩個不同的本機目錄
 * 變成同一個值），它們原樣保留 —— 兩者本來就沒有別的寫法可混淆。
 *
 * @param url - 使用者寫的 repoUrl
 */
export function normalizeRepoUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === '') return '';

  // scp 語法：git@github.com:x/y.git
  const scp = /^([^/@\s]+)@([^:/\s]+):(.+)$/.exec(trimmed);
  if (scp) {
    return `${scp[2].toLowerCase()}/${stripGitSuffix(scp[3])}`;
  }

  // URL：https://github.com/x/y.git、ssh://git@github.com/x/y.git
  const parsed = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]+)\/(.*)$/.exec(trimmed);
  if (parsed) {
    const authority = parsed[2];
    const at = authority.indexOf('@');
    const host = at === -1 ? authority : authority.slice(at + 1);
    return `${host.toLowerCase()}/${stripGitSuffix(parsed[3])}`;
  }

  return stripGitSuffix(trimmed);
}

/**
 * 把舊庫備份成 `<舊庫>.bak`。
 *
 * **備份必須是完整的**：sqlite 預設是 WAL 模式，還沒收進主檔的資料住在
 * `-wal` 側檔裡——只複製主檔會備份到一個看起來正常、其實是空的資料庫。
 * 所以先要求 sqlite 把 WAL 收乾淨；收不乾淨就把側檔一起複製。
 *
 * **側檔要 `-wal` 與 `-shm` 兩個都複製**：`-shm` 是 WAL 的索引，
 * 少了它 sqlite 在只讀開檔時重建不了索引（要能寫才能重建）——那份備份
 * 就變成「開得起但讀不出來」。檔名沿用 sqlite 的慣例 `<庫>-wal` /
 * `<庫>-shm`，sqlite 才認得出來那是同一個資料庫的側檔。
 *
 * @param saver - 舊庫的 saver
 * @param legacyDbPath - 舊庫的路徑
 * @param flush - 把 WAL 收進主檔的步驟（測試可以讓它失敗，走側檔退路）
 * @returns 備份檔的路徑
 */
export function backupLegacyDb(
  saver: SqliteSaver,
  legacyDbPath: string,
  flush: (saver: SqliteSaver) => void = flushWal
): string {
  const backupPath = `${legacyDbPath}.bak`;
  try {
    flush(saver);
  } catch {
    // 收不乾淨就靠側檔退路。
  }
  fs.copyFileSync(legacyDbPath, backupPath);

  // **只有 WAL 還有資料時才需要側檔**：收乾淨的話主檔本身就是完整的。
  const walPath = `${legacyDbPath}-wal`;
  if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    fs.copyFileSync(walPath, `${backupPath}-wal`);
    const shmPath = `${legacyDbPath}-shm`;
    if (fs.existsSync(shmPath) && fs.statSync(shmPath).size > 0) {
      fs.copyFileSync(shmPath, `${backupPath}-shm`);
    }
  }
  return backupPath;
}

/**
 * 把 WAL 裡的資料收進主檔。
 *
 * **收不回去不算錯**：備份那一段還有側檔的退路。
 *
 * @param saver - 舊庫的 saver
 */
function flushWal(saver: SqliteSaver): void {
  try {
    sqliteDatabase(saver).pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // 留給備份那一段處理。
  }
}

/**
 * 關掉一個 saver 的連線。
 *
 * **關不掉就算了**：命令的最後一步不該因為收尾失敗而報錯。
 *
 * @param saver - 要關掉的 saver
 */
function closeQuietly(saver: SqliteSaver): void {
  try {
    sqliteDatabase(saver).close();
  } catch {
    // 忽略。
  }
}
