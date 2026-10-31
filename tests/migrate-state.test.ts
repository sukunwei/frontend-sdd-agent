import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { migrateState } from '../src/commands/migrate-state.js';
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

/** 讀一個 thread 在某個庫裡的 checkpoint。 */
async function readTuple(
  dbPath: string,
  threadId: string
): Promise<Awaited<ReturnType<SqliteSaver['getTuple']>>> {
  const saver = SqliteSaver.fromConnString(dbPath);
  return saver.getTuple({ configurable: { thread_id: threadId } });
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

  it('跑第二次不會覆蓋目標庫裡既有的 thread', async () => {
    await seedThread(legacyDb, 'thr-a', REPO_URL);

    const first = await migrateState({
      legacyDbPath: legacyDb,
      targetDbPath: targetDb,
      matchUrl: REPO_URL,
    });
    expect(first.migrated).toEqual(['thr-a']);

    // 使用者在新庫裡又跑了一輪：目標庫的 thread 已經往前走。
    const saver = SqliteSaver.fromConnString(targetDb);
    const tuple = await saver.getTuple({ configurable: { thread_id: 'thr-a' } });
    await saver.put(
      {
        configurable: {
          thread_id: 'thr-a',
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
        id: 'newer-checkpoint',
        channel_values: { ...(tuple?.checkpoint.channel_values ?? {}), repoUrl: 'local:newer' },
      },
      tuple?.metadata ?? { source: 'loop', step: 0, parents: {} }
    );

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
