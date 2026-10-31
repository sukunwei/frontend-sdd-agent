import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { backupLegacyDb, migrateState } from '../src/commands/migrate-state.js';
import { runCli } from '../src/cli/index.js';
import { buildGraph } from '../src/graph/compile.js';
import type { NodeOutcome } from '../src/graph/state.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import { captureIo } from './helpers/capture-io.js';

/**
 * 把舊的全域 checkpoint 庫搬進業務倉庫。
 *
 * **這些測試跑的是真的東西**：真的 graph、真的 sqlite、真的 git。
 * 搬運的每一個保證（歸屬判定、備份、pending writes、冪等）都要在真的資料庫上
 * 驗證才有意義——mock 掉 sqlite 的測試只證明了 mock 是對的。
 */

/** 這個測試用的倉庫網址。 */
const REPO_URL = 'https://github.com/example/demo.git';
/** 另一個倉庫的網址（不該被搬走）。 */
const OTHER_URL = 'https://github.com/example/other.git';

/**
 * 在舊庫裡造一個停在 interrupt 上的 thread。
 *
 * **用真的 graph**：checkpoint 的格式（channel_values、pending writes）必須是
 * LangGraph 自己寫出來的那樣，否則「搬完可以 resume」這件事根本沒被驗證到。
 */
async function seedThread(dbPath: string, threadId: string, repoUrl: string): Promise<void> {
  const graph = buildGraph({
    checkpointer: createCheckpointer(dbPath),
    // 鎖檔指向臨時目錄：測試不該動到別人正在跑的那把鎖。
    lockPath: `${dbPath}.lock`,
    testNodes: {
      bootstrap: async (): Promise<NodeOutcome> => ({
        kind: 'advance',
        update: { bootstrapped: true, currentStage: 'prd' },
        goto: 'prd',
      }),
      prd: async (): Promise<NodeOutcome> => {
        interrupt({ audience: 'user', type: 'collect_prd' });
        return { kind: 'advance', update: {}, goto: 'spec' };
      },
    },
  });
  await graph.invoke(
    { requirementName: threadId, repoUrl },
    { configurable: { thread_id: threadId } }
  );
}

/** 一個圖：停在 prd 的 interrupt 上，resume 之後走到 completed。 */
function buildResumeGraph(dbPath: string) {
  return buildGraph({
    checkpointer: createCheckpointer(dbPath),
    lockPath: `${dbPath}.lock`,
    testNodes: {
      bootstrap: async (): Promise<NodeOutcome> => ({
        kind: 'advance',
        update: { bootstrapped: true, currentStage: 'prd' },
        goto: 'prd',
      }),
      prd: async (): Promise<NodeOutcome> => {
        interrupt({ audience: 'user', type: 'collect_prd' });
        return { kind: 'advance', update: {}, goto: 'spec' };
      },
      spec: async (): Promise<NodeOutcome> => ({
        kind: 'advance',
        update: { currentStage: 'completed' },
        goto: 'completed',
      }),
    },
  });
}

/**
 * 讀一個 thread 在某個庫裡的 checkpoint。
 *
 * **庫還沒被建立過就回 undefined**：沒有東西可搬時不會憑空造出目標庫，
 * 那是使用者不會預期的副作用。
 */
async function readTuple(
  dbPath: string,
  threadId: string
): Promise<Awaited<ReturnType<SqliteSaver['getTuple']>>> {
  if (!fs.existsSync(dbPath)) return undefined;
  const saver = SqliteSaver.fromConnString(dbPath);
  return saver.getTuple({ configurable: { thread_id: threadId } });
}

/**
 * 在既有的 thread 上再塞一個 checkpoint。
 *
 * **用來造混血的 thread**：舊庫以 task 名當 thread id，兩個倉庫跑過同名 task
 * 時，舊庫裡只有一條 thread，兩個倉庫的 checkpoint 交錯在同一條 parent 鏈上。
 */
async function putCheckpoint(
  dbPath: string,
  threadId: string,
  repoUrl: string,
  checkpointId: string
): Promise<void> {
  const saver = SqliteSaver.fromConnString(dbPath);
  const tuple = await saver.getTuple({ configurable: { thread_id: threadId } });
  await saver.put(
    {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: tuple?.config.configurable?.checkpoint_ns ?? '',
        checkpoint_id: tuple?.checkpoint.id,
      },
    },
    {
      ...(tuple?.checkpoint ?? {
        v: 4,
        id: 'manual',
        ts: new Date().toISOString(),
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      }),
      id: checkpointId,
      channel_values: { ...(tuple?.checkpoint.channel_values ?? {}), repoUrl },
    },
    tuple?.metadata ?? { source: 'loop', step: 0, parents: {} }
  );
}

/**
 * 讓某個 thread 的寫入失敗。
 *
 * **用真的 sqlite、只擋掉寫入**：搬運失敗之後的清理（把半截 thread 刪掉）
 * 只有真的寫失敗一次才驗得到。
 *
 * **要寫到一半才失敗**（`failAt` 次之後）：第一筆就失敗的話目標庫裡根本沒
 * 留下東西，清不清理都一樣——那條測試就驗不到任何事。
 *
 * @param threadId - 要讓它寫不進去的 thread
 * @param failAt - 這個 thread 的第幾次寫入開始失敗
 */
function failWritesFor(threadId: string, failAt = 2): void {
  const originalPut = SqliteSaver.prototype.put;
  let writes = 0;
  vi.spyOn(SqliteSaver.prototype, 'put').mockImplementation(
    async function (
      this: SqliteSaver,
      config: Parameters<SqliteSaver['put']>[0],
      checkpoint: Parameters<SqliteSaver['put']>[1],
      metadata: Parameters<SqliteSaver['put']>[2]
    ): Promise<Awaited<ReturnType<SqliteSaver['put']>>> {
      const configurable: unknown = config.configurable;
      const id =
        typeof configurable === 'object' && configurable !== null
          ? (configurable as Record<string, unknown>).thread_id
          : undefined;
      if (id === threadId) {
        writes += 1;
        if (writes >= failAt) {
          throw new Error('disk is full');
        }
      }
      return originalPut.call(this, config, checkpoint, metadata);
    }
  );
}

/** 一個有 origin 遠端的 git 倉庫。 */
function createRepoWithRemote(prefix: string, remoteUrl: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  };
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'sdd-graph test']);
  git(['remote', 'add', 'origin', remoteUrl]);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  return fs.realpathSync(dir);
}

describe('migrate：把舊的全域 checkpoint 搬進業務倉庫', () => {
  let dir: string;
  let legacyDb: string;
  let targetDb: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-migrate-'));
    legacyDb = path.join(dir, 'legacy', 'checkpoints.sqlite');
    targetDb = path.join(dir, 'repo', '.sdd', 'checkpoints.sqlite');
  });
  afterEach(() => {
    // **原型上的 spy 會跨測試留下來**：不還原的話，後面的測試會一直寫不進去。
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('只搬 repoUrl 匹配的 thread', async () => {
    await seedThread(legacyDb, 'thr-a', REPO_URL);
    await seedThread(legacyDb, 'thr-b', OTHER_URL);

    const result = await migrateState({
      legacyDbPath: legacyDb,
      targetDbPath: targetDb,
      matchUrl: REPO_URL,
    });

    expect(result.error).toBeUndefined();
    expect(result.migrated).toEqual(['thr-a']);
    expect(result.skipped).toEqual(['thr-b']);

    // 搬走的在新庫裡，沒搬的還在舊庫裡。
    expect(await readTuple(targetDb, 'thr-a')).toBeDefined();
    expect(await readTuple(targetDb, 'thr-b')).toBeUndefined();
    expect(await readTuple(legacyDb, 'thr-b')).toBeDefined();
  });

  it('舊庫不存在時不是錯誤（沒有東西可搬）', async () => {
    const result = await migrateState({
      legacyDbPath: path.join(dir, 'nope.sqlite'),
      targetDbPath: targetDb,
      matchUrl: REPO_URL,
    });

    expect(result.error).toBeUndefined();
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('沒有指定 matchUrl 時全搬（undefined = 全搬這條契約）', async () => {
    await seedThread(legacyDb, 'thr-a', REPO_URL);
    await seedThread(legacyDb, 'thr-b', OTHER_URL);

    const result = await migrateState({
      legacyDbPath: legacyDb,
      targetDbPath: targetDb,
    });

    expect(result.error).toBeUndefined();
    expect(result.migrated).toEqual(['thr-a', 'thr-b']);
    expect(result.skipped).toEqual([]);
    expect(await readTuple(targetDb, 'thr-b')).toBeDefined();
  });

  it('混了兩個倉庫的 thread 一個 checkpoint 都不搬', async () => {
    // 舊庫以 task 名當 thread id，兩個倉庫跑過同名 task 時，舊庫裡只有一條
    // thread，兩個倉庫的 checkpoint 交錯在同一條 parent 鏈上。
    await seedThread(legacyDb, 'thr-mixed', REPO_URL);
    await putCheckpoint(legacyDb, 'thr-mixed', OTHER_URL, 'from-another-repo');

    const result = await migrateState({
      legacyDbPath: legacyDb,
      targetDbPath: targetDb,
      matchUrl: REPO_URL,
    });

    expect(result.error).toBeUndefined();
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual(['thr-mixed']);
    expect(result.mixed).toEqual(['thr-mixed']);
    expect(result.skippedReasons?.['thr-mixed']).toContain('混了兩個倉庫');
    // **整條都不搬**：搬一半就是把別的倉庫的進度搬過來。
    expect(await readTuple(targetDb, 'thr-mixed')).toBeUndefined();
  });

  it('repoUrl 只是寫法不同時也不搬（理由說「不一致」）', async () => {
    // 舊庫存的是使用者當初敲的 `--repo` 字串，不是 `git config` 的結果。
    await seedThread(legacyDb, 'thr-a', 'git@github.com:example/demo.git');

    const result = await migrateState({
      legacyDbPath: legacyDb,
      targetDbPath: targetDb,
      matchUrl: REPO_URL,
    });

    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual(['thr-a']);
    expect(result.skippedReasons?.['thr-a']).toContain('不一致');
    expect(result.skippedReasons?.['thr-a']).not.toContain('屬於別的倉庫');
  });

  it('搬運中途失敗時不會留下半截 thread', async () => {
    await seedThread(legacyDb, 'thr-a', REPO_URL);
    // **寫到一半才失敗**：第一個 checkpoint 已經進目標庫了。
    failWritesFor('thr-a');

    const result = await migrateState({
      legacyDbPath: legacyDb,
      targetDbPath: targetDb,
      matchUrl: REPO_URL,
    });

    expect(result.error).toContain('thr-a');
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual(['thr-a']);
    // **半截的 thread 要被清掉**：留著它，下次執行會被判成「已經有同名
    // thread」而永遠補不齊。
    expect(await readTuple(targetDb, 'thr-a')).toBeUndefined();
    const saver = SqliteSaver.fromConnString(targetDb);
    const leftovers: unknown[] = [];
    for await (const tuple of saver.list({ configurable: { thread_id: 'thr-a' } })) {
      leftovers.push(tuple);
    }
    expect(leftovers).toEqual([]);
  });

  it('遷移後新庫的 thread 可以 resume', async () => {
    await seedThread(legacyDb, 'thr-a', REPO_URL);

    const result = await migrateState({
      legacyDbPath: legacyDb,
      targetDbPath: targetDb,
      matchUrl: REPO_URL,
    });
    expect(result.migrated).toEqual(['thr-a']);

    // state 與 pending writes 都要在（pending writes 裝著那張還沒答的問題）。
    const tuple = await readTuple(targetDb, 'thr-a');
    expect(tuple?.checkpoint.channel_values.repoUrl).toBe(REPO_URL);
    expect(tuple?.pendingWrites?.length ?? 0).toBeGreaterThan(0);

    // 真的 resume：圖要能在新庫上把這一輪跑完。
    const graph = buildResumeGraph(targetDb);
    const cfg = { configurable: { thread_id: 'thr-a' } };
    const snapshot = await graph.getState(cfg);
    expect(snapshot.tasks[0]?.interrupts?.[0]?.value).toEqual({
      audience: 'user',
      type: 'collect_prd',
    });

    await graph.invoke(new Command({ resume: 'the-answer' }), cfg);
    const after = await graph.getState(cfg);
    expect(after.values.currentStage).toBe('completed');
  });

  it('搬運前會備份，而且備份裡真的有舊庫的資料', async () => {
    await seedThread(legacyDb, 'thr-a', REPO_URL);

    const result = await migrateState({
      legacyDbPath: legacyDb,
      targetDbPath: targetDb,
      matchUrl: REPO_URL,
    });

    const backup = `${legacyDb}.bak`;
    expect(fs.existsSync(backup)).toBe(true);
    // **備份必須是完整的**：sqlite 預設是 WAL 模式，沒收進主檔的資料住在
    // `-wal` 側檔裡——只複製主檔會備份到一個看起來正常、其實是空的資料庫。
    expect(await readTuple(backup, 'thr-a')).toBeDefined();

    // 舊庫不刪：使用者確認之後才自己清理。
    expect(fs.existsSync(legacyDb)).toBe(true);
    expect(await readTuple(legacyDb, 'thr-a')).toBeDefined();
  });

  it('WAL 收不乾淨時備份連側檔一起複製', async () => {
    await seedThread(legacyDb, 'thr-a', REPO_URL);
    const saver = SqliteSaver.fromConnString(legacyDb);

    // **收 WAL 失敗的那條退路**：側檔（`-wal` 與 `-shm`）都要跟著複製——
    // 少了 `-shm`，sqlite 在只讀開檔時重建不了 WAL 的索引。
    const backup = backupLegacyDb(saver, legacyDb, () => {
      throw new Error('database is locked');
    });

    expect(fs.existsSync(backup)).toBe(true);
    expect(fs.existsSync(`${backup}-wal`)).toBe(true);
    expect(fs.existsSync(`${backup}-shm`)).toBe(true);
    expect(await readTuple(backup, 'thr-a')).toBeDefined();
  });

  it('跑第二次不會覆蓋目標庫裡既有的 thread', async () => {
    await seedThread(legacyDb, 'thr-a', REPO_URL);

    const first = await migrateState({
      legacyDbPath: legacyDb,
      targetDbPath: targetDb,
      matchUrl: REPO_URL,
    });
    expect(first.migrated).toEqual(['thr-a']);

    // 使用者在新庫裡又跑了一輪：目標庫的 thread 已經往前走。
    await putCheckpoint(targetDb, 'thr-a', 'local:newer', 'newer-checkpoint');

    const second = await migrateState({
      legacyDbPath: legacyDb,
      targetDbPath: targetDb,
      matchUrl: REPO_URL,
    });

    expect(second.error).toBeUndefined();
    expect(second.migrated).toEqual([]);
    expect(second.skipped).toEqual(['thr-a']);
    // 目標庫裡比較新的 checkpoint 還在——沒有被舊庫的資料蓋掉。
    const after = await readTuple(targetDb, 'thr-a');
    expect(after?.checkpoint.id).toBe('newer-checkpoint');
    expect(after?.checkpoint.channel_values.repoUrl).toBe('local:newer');
  });
});

describe('migrate：CLI', () => {
  let dir: string;
  let legacyDb: string;
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-migrate-cli-'));
    legacyDb = path.join(dir, 'legacy', 'checkpoints.sqlite');
    io = captureIo();
  });
  afterEach(() => {
    // **原型上的 spy 會跨測試留下來**：不還原的話，後面的測試會一直寫不進去。
    vi.restoreAllMocks();
    io.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('把屬於這個倉庫的 thread 搬進 .sdd，並把別的留在舊庫', async () => {
    const repo = createRepoWithRemote('sdd-migrate-repo-', REPO_URL);
    await seedThread(legacyDb, 'thr-a', REPO_URL);
    await seedThread(legacyDb, 'thr-b', OTHER_URL);

    const rc = await runCli(['migrate', '--repo', repo], { legacyCheckpointPath: legacyDb });
    const captured = io.take();

    expect(rc).toBe(0);
    const envelope = JSON.parse(captured.out) as {
      kind: string;
      migrated: string[];
      skipped: string[];
    };
    expect(envelope.kind).toBe('result');
    expect(envelope.migrated).toEqual(['thr-a']);
    expect(envelope.skipped).toEqual(['thr-b']);

    const target = path.join(repo, '.sdd', 'checkpoints.sqlite');
    expect(await readTuple(target, 'thr-a')).toBeDefined();
    expect(await readTuple(target, 'thr-b')).toBeUndefined();
  });

  it('倉庫沒有遠端地址時一條都不搬，並說明原因', async () => {
    const repo = createRepoWithRemote('sdd-migrate-noremote-', REPO_URL);
    // 把遠端拿掉：沒有遠端地址就無法判定歸屬。
    execFileSync('git', ['-C', repo, 'remote', 'remove', 'origin'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await seedThread(legacyDb, 'thr-a', REPO_URL);

    const rc = await runCli(['migrate', '--repo', repo], { legacyCheckpointPath: legacyDb });
    const captured = io.take();

    expect(rc).toBe(0);
    const envelope = JSON.parse(captured.out) as {
      kind: string;
      migrated: string[];
      skipped: string[];
      notice?: string;
    };
    expect(envelope.migrated).toEqual([]);
    expect(envelope.skipped).toEqual(['thr-a']);
    expect(envelope.notice).toContain('remote.origin.url');
    expect(fs.existsSync(path.join(repo, '.sdd', 'checkpoints.sqlite'))).toBe(false);
  });

  it('部分失敗時錯誤信封裡也有結構化的 migrated / skipped', async () => {
    const repo = createRepoWithRemote('sdd-migrate-partial-', REPO_URL);
    await seedThread(legacyDb, 'thr-a', REPO_URL);
    await seedThread(legacyDb, 'thr-b', REPO_URL);
    failWritesFor('thr-b');

    const rc = await runCli(['migrate', '--repo', repo], { legacyCheckpointPath: legacyDb });
    const captured = io.take();

    expect(rc).toBe(1);
    const envelope = JSON.parse(captured.err) as {
      kind: string;
      message: string;
      migrated: string[];
      skipped: string[];
    };
    expect(envelope.kind).toBe('error');
    // **使用者拿得到機器可讀的部分成功摘要**，不必從訊息裡的字句猜。
    expect(envelope.migrated).toEqual(['thr-a']);
    expect(envelope.skipped).toEqual(['thr-b']);
  });

  it('--repo 指向不存在的路徑時是錯誤（exit 1）', async () => {
    const rc = await runCli(['migrate', '--repo', path.join(dir, 'nope')], {
      legacyCheckpointPath: legacyDb,
    });
    const captured = io.take();

    expect(rc).toBe(1);
    const envelope = JSON.parse(captured.err) as { kind: string; code: string };
    expect(envelope.kind).toBe('error');
  });

  it('--repo 給的是遠端網址時是錯誤（要搬進的是本機倉庫）', async () => {
    const rc = await runCli(['migrate', '--repo', 'https://github.com/example/demo.git'], {
      legacyCheckpointPath: legacyDb,
    });
    const captured = io.take();

    expect(rc).toBe(1);
    const envelope = JSON.parse(captured.err) as { kind: string; code: string; message: string };
    expect(envelope.kind).toBe('error');
    expect(envelope.message).toContain('本機倉庫');
  });

  it('舊的分支鎖仍然提示（遷移不動鎖）', async () => {
    const repo = createRepoWithRemote('sdd-migrate-lock-', REPO_URL);
    await seedThread(legacyDb, 'thr-a', REPO_URL);
    // 舊鎖住在別的 task 手上：全域單例，不能順手搬走。
    fs.writeFileSync(
      path.join(dir, 'legacy', 'branch-runtime-lock.json'),
      JSON.stringify({
        running: true,
        taskName: 'thr-other',
        branch: 'task/thr-other',
        repoPath: '/somewhere',
        runId: 'run-1',
        startedAt: new Date().toISOString(),
      })
    );

    const rc = await runCli(['migrate', '--repo', repo], { legacyCheckpointPath: legacyDb });
    const captured = io.take();

    expect(rc).toBe(0);
    const envelope = JSON.parse(captured.out) as { notice?: string };
    expect(envelope.notice).toContain('thr-other');
    // 鎖沒有被動到。
    expect(fs.existsSync(path.join(dir, 'legacy', 'branch-runtime-lock.json'))).toBe(true);
  });
});
