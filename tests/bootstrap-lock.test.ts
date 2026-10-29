import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from '@langchain/langgraph';
import { acquireLock, getLock } from '../src/runtime/branch-lock.js';
import { buildGraph } from '../src/graph/compile.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import { startTask } from '../src/commands/start-task.js';
import { initTaskWorkspace } from '../src/runtime/task-workspace.js';
import { cloneFixture, createGitFixture } from './helpers/git-fixture.js';
import type { GitFixture } from './helpers/git-fixture.js';

/**
 * The bootstrap node raises its interrupt **inside** the node body
 * (`interrupt(payload)`), because LangGraph v1 has no `Command({ interrupt })`.
 * The only way to observe the parked payload is therefore to run the node
 * inside a graph: outside a graph `interrupt()` throws a plain
 * `Error("Called interrupt() outside of the context of a graph.")` and the
 * payload is lost.
 *
 * Every test writes into a temp directory and passes the temp lock path
 * explicitly - the real lock lives in the plugin root and belongs to whoever
 * is running sdd-graph right now.
 */
describe('bootstrap 鎖衝突', () => {

  let ws: string;
  let lockFile: string;
  let fixture: GitFixture;

  beforeAll(() => {
    fixture = createGitFixture('sdd-lock-remote-');
  });

  afterAll(() => {
    fixture.cleanup();
  });

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-lock-'));
    lockFile = path.join(ws, 'branch-runtime-lock.json');
    process.env.SDD_GRAPH_WORKSPACE_BASE = ws;
  });

  afterEach(() => {
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('已有 running 鎖時必須中斷且不得前進', async () => {
    acquireLock('other-task', 'task/other-task', path.join(ws, 'other'), 'run_x', lockFile);

    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
      lockPath: lockFile,
    });
    const cfg = { configurable: { thread_id: 'qrcode-app' } };
    await g.invoke({ requirementName: 'qrcode-app', repoUrl: 'file:///nope' }, cfg);

    const snap: any = await g.getState(cfg);
    const payload = snap.tasks[0].interrupts[0].value;
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('lock_conflict');
    expect(payload.options).toEqual(['wait', 'stop_other']);
    // 預檢查開的閘口也要帶診斷訊息
    expect(typeof payload.message).toBe('string');
    expect(payload.message).toContain('other-task');

    // 不得前進
    expect(snap.values.bootstrapped).toBe(false);
    expect(snap.values.currentStage).toBe('bootstrap');

    // 別人的鎖不得被動到，也不得開始 clone
    expect(getLock(lockFile)?.taskName).toBe('other-task');
    expect(fs.existsSync(path.join(ws, 'qrcode-app'))).toBe(false);
  });

  it('選 wait 時必須繼續等著，不得搶別人的鎖', async () => {
    acquireLock('other-task', 'task/other-task', path.join(ws, 'other'), 'run_x', lockFile);

    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
      lockPath: lockFile,
    });
    const cfg = { configurable: { thread_id: 'qrcode-app' } };
    await g.invoke({ requirementName: 'qrcode-app', repoUrl: 'file:///nope' }, cfg);
    await g.invoke(new Command({ resume: { action: 'wait' } }), cfg);

    const snap: any = await g.getState(cfg);
    // 對方還在跑 → 同一個問題再問一次
    expect(snap.tasks[0].interrupts[0].value.type).toBe('lock_conflict');
    expect(getLock(lockFile)?.taskName).toBe('other-task');
    expect(snap.values.bootstrapped).toBe(false);
  });

  it('選 stop_other 時必須接管鎖，不得還停在鎖衝突', async () => {
    acquireLock('other-task', 'task/other-task', path.join(ws, 'other'), 'run_x', lockFile);

    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
      lockPath: lockFile,
    });
    const cfg = { configurable: { thread_id: 'qrcode-app' } };
    await g.invoke({ requirementName: 'qrcode-app', repoUrl: 'file:///nope' }, cfg);
    await g.invoke(new Command({ resume: { action: 'stop_other' } }), cfg);

    const snap: any = await g.getState(cfg);
    // 鎖已經換人 → 問題換成「clone 失敗」（repo 不存在）
    expect(snap.tasks[0].interrupts[0].value.type).toBe('bootstrap_failed');
    expect(getLock(lockFile)?.taskName).toBe('qrcode-app');
  });

  it('wait 可以連續選兩次：每次都重新停在同一個問題上', async () => {
    acquireLock('other-task', 'task/other-task', path.join(ws, 'other'), 'run_x', lockFile);

    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
      lockPath: lockFile,
    });
    const cfg = { configurable: { thread_id: 'qrcode-app' } };
    await g.invoke({ requirementName: 'qrcode-app', repoUrl: 'file:///nope' }, cfg);

    // 第一次 approve：選 wait → 對方還在跑 → 同一個問題再問一次
    await g.invoke(new Command({ resume: { action: 'wait' } }), cfg);
    const afterFirst: any = await g.getState(cfg);
    expect(afterFirst.tasks[0].interrupts[0].value.type).toBe('lock_conflict');

    // 第二次 approve：還是選 wait → 還是同一個問題
    await g.invoke(new Command({ resume: { action: 'wait' } }), cfg);
    const afterSecond: any = await g.getState(cfg);
    expect(afterSecond.tasks[0].interrupts[0].value.type).toBe('lock_conflict');
    expect(afterSecond.tasks[0].interrupts[0].value.options).toEqual(['wait', 'stop_other']);

    // 別人的鎖還在原主手上，run 也沒有前進
    expect(getLock(lockFile)?.taskName).toBe('other-task');
    expect(afterSecond.values.bootstrapped).toBe(false);
    expect(afterSecond.values.currentStage).toBe('bootstrap');
  });

  it('自己留下的舊鎖必須拿得回來，不得卡在 lock_conflict', async () => {
    // 上一輪的 run 崩了：工作區還在，鎖也還是自己的
    acquireLock('dup-task', 'task/dup-task', path.join(ws, 'dup-task', 'repo'), 'run_x', lockFile);
    initTaskWorkspace('dup-task');

    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
      lockPath: lockFile,
    });
    const cfg = { configurable: { thread_id: 'dup-task' } };
    await g.invoke({ requirementName: 'dup-task', repoUrl: 'file:///nope' }, cfg);

    const parked: any = await g.getState(cfg);
    expect(parked.tasks[0].interrupts[0].value.type).toBe('already_exists');

    await g.invoke(new Command({ resume: { action: 'reset' } }), cfg);
    const snap: any = await g.getState(cfg);
    // 自己的鎖被拿回來了 → 失敗的是 clone，不是鎖
    expect(snap.tasks[0].interrupts[0].value.type).toBe('bootstrap_failed');
    expect(snap.tasks[0].interrupts[0].value.code).toBe('git_error');
    expect(getLock(lockFile)?.taskName).toBe('dup-task');
  });

  it('鎖被別人持有時，訊息必須指出真正的出路', async () => {
    acquireLock('other-task', 'task/other-task', path.join(ws, 'other'), 'run_x', lockFile);

    const result = await startTask('my-task', 'file:///nope', { lockPath: lockFile });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('lock_conflict');
    // 真正的出路：`stop` 釋放鎖，或在鎖閘口選 stop_other
    expect(result.error).toContain('sdd-graph stop --task other-task');
    expect(result.error).toContain('stop_other');
  });

  it('沒有持有者時訊息不得給出跑不了的指令', async () => {
    // 鎖檔做成一個目錄：acquireLock 的 rename 失敗，而且沒有「持有者」
    fs.mkdirSync(lockFile);

    const result = await startTask('my-task', 'file:///nope', { lockPath: lockFile });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('lock_conflict');
    // 不得出現跑不了的 `stop --task another task`
    expect(result.error).not.toContain('--task another task');
    expect(result.error).not.toContain('another task');
    // 這條路徑也會開鎖閘口（見 Ruling 17），所以提 stop_other 是做得到的
    expect(result.error).toContain('stop_other');
    // 但仍要給出做得到的建議
    expect(result.error).toContain('lock file is writable');
  });

  it('startTask 內部拿不到鎖時也必須開鎖閘口（帶 stop_other）', async () => {
    // 鎖檔做成一個目錄：預檢查讀不到鎖 → 過關；acquireLock 的 rename 失敗
    // → 內部拿不到鎖。這一條不是預檢查擋下來的。
    fs.mkdirSync(lockFile);

    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
      lockPath: lockFile,
    });
    const cfg = { configurable: { thread_id: 'qrcode-app' } };
    await g.invoke({ requirementName: 'qrcode-app', repoUrl: 'file:///nope' }, cfg);

    const snap: any = await g.getState(cfg);
    const payload = snap.tasks[0].interrupts[0].value;
    // 必須是鎖閘口，不是沒有 options 的 bootstrap_failed
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('lock_conflict');
    expect(payload.options).toEqual(['wait', 'stop_other']);
    // 閘口必須帶診斷訊息：使用者要知道發生什麼事
    expect(payload.code).toBe('lock_conflict');
    expect(typeof payload.message).toBe('string');
    expect(payload.message.length).toBeGreaterThan(0);
    expect(payload.message).toContain('lock file is writable');
    expect(snap.values.bootstrapped).toBe(false);
  });

  it('自己留下的舊鎖釋放不掉時不得被靜靜忽略', async () => {
    // 鎖是這個 task 自己的（上一輪的 run 留下的），但鎖檔不能被改寫
    acquireLock('my-task', 'task/my-task', path.join(ws, 'my-task'), 'run_x', lockFile);
    fs.chmodSync(lockFile, 0o444);

    const result = await startTask('my-task', 'file:///nope', { lockPath: lockFile });
    fs.chmodSync(lockFile, 0o644);

    // 不得假裝成功，也不得靜靜忽略釋放失敗
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('lock_conflict');
    expect(result.error).toContain('lock file could not be rewritten');
    // 訊息要指出做得到的出路
    expect(result.error).toContain('stop_other');
  });

  it('forceUnlock 失敗時不得讓 run 沒有鎖就前進', async () => {
    // 鎖檔放在不能寫的目錄裡 → forceUnlock 刪不掉它
    const lockDir = path.join(ws, 'locks');
    fs.mkdirSync(lockDir);
    const foreignLock = path.join(lockDir, 'branch-runtime-lock.json');
    acquireLock('other-task', 'task/other-task', path.join(ws, 'other'), 'run_x', foreignLock);
    fs.chmodSync(lockDir, 0o500);

    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
      lockPath: foreignLock,
    });
    const cfg = { configurable: { thread_id: 'qrcode-app' } };
    await g.invoke({ requirementName: 'qrcode-app', repoUrl: 'file:///nope' }, cfg);
    // 使用者選 stop_other → forceUnlock 失敗
    await g.invoke(new Command({ resume: { action: 'stop_other' } }), cfg);

    const snap: any = await g.getState(cfg);
    fs.chmodSync(lockDir, 0o700);

    // 鎖還在別人手上 → run 不得前進，仍停在鎖閘口
    expect(snap.values.bootstrapped).toBe(false);
    expect(snap.values.currentStage).toBe('bootstrap');
    expect(snap.tasks[0].interrupts[0].value.type).toBe('lock_conflict');
    expect(getLock(foreignLock)?.taskName).toBe('other-task');
  });

  it('acquireLock 失敗時不得前進到 prd', async () => {
    // 把鎖檔做成一個目錄：acquireLock 的 rename 會失敗 → 拿不到鎖
    fs.mkdirSync(lockFile);
    // 已經 clone 好的工作區 → 使用者選 resume → 節點必須拿鎖才能接手
    const repoDir = path.join(ws, 'dup-task', 'repo');
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    cloneFixture(fixture.url, repoDir);

    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
      lockPath: lockFile,
    });
    const cfg = { configurable: { thread_id: 'dup-task' } };
    await g.invoke({ requirementName: 'dup-task', repoUrl: 'file:///nope' }, cfg);
    await g.invoke(new Command({ resume: { action: 'resume' } }), cfg);

    const snap: any = await g.getState(cfg);
    // 拿不到鎖 → 不得接手、不得前進到 prd
    expect(snap.values.bootstrapped).toBe(false);
    expect(snap.values.currentStage).toBe('bootstrap');
    expect(snap.tasks[0].interrupts[0].value.type).toBe('already_exists');
  });
});
