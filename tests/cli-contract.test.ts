import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { interrupt } from '@langchain/langgraph';
import type { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { runCli } from '../src/cli/index.js';
import { buildGraph } from '../src/graph/compile.js';
import type { NodeOutcome } from '../src/graph/state.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import { acquireLock, getLock } from '../src/runtime/branch-lock.js';
import { initTaskWorkspace } from '../src/runtime/task-workspace.js';
import { captureIo } from './helpers/capture-io.js';
import { buildHostGraph } from './helpers/host-graph.js';

const OK_RESULT = JSON.stringify({ status: 'ok', summary: 'done', changedFiles: [] });

describe('CLI 合約', () => {
  let ws: string;
  let cp: string;
  let lockFile: string;
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cli-'));
    cp = path.join(ws, 'cp.sqlite');
    lockFile = path.join(ws, 'branch-runtime-lock.json');
    process.env.SDD_GRAPH_WORKSPACE_BASE = ws;
    io = captureIo();
  });
  afterEach(() => {
    io.restore();
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('參數錯誤必須回 1 且把錯誤寫進 stderr', async () => {
    const rc = await runCli(['start'], { checkpointPath: cp });   // 缺 --task
    const captured = io.take();
    expect(rc).toBe(1);
    expect(captured.out).toBe('');
    const err = JSON.parse(captured.err);
    expect(err.kind).toBe('error');
    expect(err.code).toBe('invalid_arguments');
    expect(typeof err.message).toBe('string');
  });

  it('未知的子命令必須回 1', async () => {
    const rc = await runCli(['nope', '--task', 'x'], { checkpointPath: cp });
    const captured = io.take();
    expect(rc).toBe(1);
    expect(JSON.parse(captured.err).code).toBe('invalid_arguments');
  });

  it('figma-diff 沒有 --docs 時回 2（用法錯誤），並把錯誤寫進 stderr', async () => {
    const rc = await runCli(['figma-diff']);
    const captured = io.take();
    expect(rc).toBe(2);
    expect(captured.out).toBe('');
    expect(JSON.parse(captured.err).code).toBe('invalid_arguments');
  });

  it('figma-diff 在沒有截圖時回 0（沒有東西可比）', async () => {
    const docs = path.join(ws, 'docs', 'demo');
    fs.mkdirSync(docs, { recursive: true });
    const rc = await runCli(['figma-diff', '--docs', docs]);
    const captured = io.take();
    expect(rc).toBe(0);
    expect(JSON.parse(captured.out).hardFailures).toBe(0);
  });

  it('user 閘口不能用 complete 推進，只能用 approve', async () => {
    const rc1 = await runCli(['start', '--task', 'dup-test', '--repo', 'file:///nonexistent'], { checkpointPath: cp, lockPath: lockFile });
    io.take();
    expect(rc1).toBe(2);   // repo 不存在 → bootstrap 重試後中斷（audience=user）
    const rc2 = await runCli(['complete', '--task', 'dup-test', '--result', JSON.stringify({ status: 'ok', summary: '', changedFiles: [] })], { checkpointPath: cp });
    io.take();
    expect(rc2).toBe(1);   // audience 不符 → 報錯，不得推進
  });

  it('exit 2 的信封必須帶 audience/type/threadId/stage/payload', async () => {
    const rc = await runCli(['start', '--task', 'dup-test', '--repo', 'file:///nonexistent'], { checkpointPath: cp, lockPath: lockFile });
    const captured = io.take();
    expect(rc).toBe(2);
    expect(captured.err).toBe('');
    const env = JSON.parse(captured.out);
    expect(env.kind).toBe('interrupt');
    expect(env.audience).toBe('user');
    expect(env.type).toBe('bootstrap_failed');
    expect(env.threadId).toBe('dup-test');
    expect(env.stage).toBe('bootstrap');
    expect(env.payload).toMatchObject({ audience: 'user', type: 'bootstrap_failed', code: 'git_error' });
  });

  it('stdout 只能有 JSON 信封一行', async () => {
    await runCli(['start', '--task', 'dup-test', '--repo', 'file:///nonexistent'], { checkpointPath: cp, lockPath: lockFile });
    const captured = io.take();
    const lines = captured.out.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  it('reset 批准後必須刪掉 thread 的 checkpoint 並清掉工作區', async () => {
    // 一個已經存在的工作區 → start 會停在 already_exists 閘口
    initTaskWorkspace('reset-task');
    const rc1 = await runCli(['start', '--task', 'reset-task', '--repo', 'file:///nonexistent'], { checkpointPath: cp, lockPath: lockFile });
    const started = io.take();
    expect(rc1).toBe(2);
    expect(JSON.parse(started.out).type).toBe('already_exists');

    const rc2 = await runCli(['approve', '--task', 'reset-task', '--payload', '{"action":"reset"}'], { checkpointPath: cp, lockPath: lockFile });
    const reset = io.take();
    expect(rc2).toBe(0);
    expect(JSON.parse(reset.out).reset).toBe(true);

    // checkpoint 沒了
    const rc3 = await runCli(['status', '--task', 'reset-task'], { checkpointPath: cp, lockPath: lockFile });
    const status = io.take();
    expect(rc3).toBe(1);
    expect(JSON.parse(status.err).code).toBe('no_checkpoint');

    // 工作區也沒了
    expect(fs.existsSync(path.join(ws, 'reset-task'))).toBe(false);
  });

  it('reset 批准後必須釋放分支鎖，別的 task 才拿得到', async () => {
    initTaskWorkspace('reset-lock-task');
    // 這個 task 還握著鎖（上一輪的 run）
    acquireLock('reset-lock-task', 'task/reset-lock-task', path.join(ws, 'reset-lock-task', 'repo'), 'run_x', lockFile);

    const rc1 = await runCli(['start', '--task', 'reset-lock-task', '--repo', 'file:///nonexistent'], { checkpointPath: cp, lockPath: lockFile });
    io.take();
    expect(rc1).toBe(2);

    const rc2 = await runCli(['approve', '--task', 'reset-lock-task', '--payload', '{"action":"reset"}'], { checkpointPath: cp, lockPath: lockFile });
    io.take();
    expect(rc2).toBe(0);

    // 鎖不再被握著 → 別的 task 拿得到
    expect(getLock(lockFile)?.running).toBe(false);
    const taken = acquireLock('other-task', 'task/other-task', path.join(ws, 'other'), 'run_y', lockFile);
    expect(taken.success).toBe(true);
  });

  it('checkpointer 不能刪 thread 時不得回報 reset: true', async () => {
    initTaskWorkspace('no-delete-task');
    const saver = createCheckpointer(path.join(ws, 'cp-nodelete.sqlite'));
    // 一個沒有 deleteThread 的 checkpointer
    const noDelete = new Proxy(saver, {
      get(target, prop) {
        if (prop === 'deleteThread') return undefined;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const graph = buildGraph({ checkpointer: noDelete as unknown as SqliteSaver, lockPath: lockFile });

    const rc1 = await runCli(['start', '--task', 'no-delete-task', '--repo', 'file:///nonexistent'], { graph });
    io.take();
    expect(rc1).toBe(2);

    const rc2 = await runCli(['approve', '--task', 'no-delete-task', '--payload', '{"action":"reset"}'], { graph });
    const captured = io.take();
    // 不得回報 reset 成功
    expect(rc2).toBe(1);
    expect(captured.out).toBe('');
    expect(JSON.parse(captured.err).code).toBe('internal_error');
  });

  it('別的 task 握著全域鎖時，reset 的失敗訊息不得說鎖被釋放', async () => {
    initTaskWorkspace('reset-foreign');

    // 刪 checkpoint 會失敗的 checkpointer
    const saver = createCheckpointer(path.join(ws, 'cp-foreign.sqlite'));
    const failing = new Proxy(saver, {
      get(target, prop) {
        if (prop === 'deleteThread') {
          return () => {
            throw new Error('cannot delete thread');
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const graph = buildGraph({ checkpointer: failing as unknown as SqliteSaver, lockPath: lockFile });

    const rc1 = await runCli(
      ['start', '--task', 'reset-foreign', '--repo', 'file:///nonexistent'],
      { graph, lockPath: lockFile }
    );
    const started = io.take();
    expect(rc1).toBe(2);
    expect(JSON.parse(started.out).type).toBe('already_exists');

    // 別的 task 在這之後握著全域鎖：這個 task 沒有鎖，reset 不該動它
    acquireLock('other-task', 'task/other-task', path.join(ws, 'other'), 'run_x', lockFile);

    const rc2 = await runCli(
      ['approve', '--task', 'reset-foreign', '--payload', '{"action":"reset"}'],
      { graph, lockPath: lockFile }
    );
    const captured = io.take();
    expect(rc2).toBe(1);
    const err = JSON.parse(captured.err);
    expect(err.code).toBe('internal_error');
    // 不得聲稱鎖被釋放 —— 別的 task 還握著
    expect(err.message).not.toContain('lock this task held was released');
    expect(err.message).toContain('held no lock');
    // 別的 task 的鎖原封不動（這次 reset 看的就是這個檔案）
    expect(getLock(lockFile)?.running).toBe(true);
    expect(getLock(lockFile)?.taskName).toBe('other-task');
  });

  it('注入的圖沒有另外指定 lockPath 時，reset 釋放的是圖自己的鎖', async () => {
    initTaskWorkspace('reset-graphlock');
    // 這個 task 握著「圖的那把」鎖
    acquireLock('reset-graphlock', 'task/reset-graphlock', path.join(ws, 'reset-graphlock', 'repo'), 'run_x', lockFile);

    const saver = createCheckpointer(path.join(ws, 'cp-graphlock.sqlite'));
    const failing = new Proxy(saver, {
      get(target, prop) {
        if (prop === 'deleteThread') {
          return () => {
            throw new Error('cannot delete thread');
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const graph = buildGraph({ checkpointer: failing as unknown as SqliteSaver, lockPath: lockFile });

    const rc1 = await runCli(['start', '--task', 'reset-graphlock', '--repo', 'file:///nonexistent'], { graph });
    io.take();
    expect(rc1).toBe(2);

    // 沒有 lockPath：CLI 必須用圖記錄的那把鎖，而不是預設值
    const rc2 = await runCli(['approve', '--task', 'reset-graphlock', '--payload', '{"action":"reset"}'], { graph });
    const captured = io.take();
    expect(rc2).toBe(1);
    expect(JSON.parse(captured.err).message).toContain('lock this task held was released');
    // 圖的那把鎖確實被釋放了
    expect(getLock(lockFile)?.running).toBe(false);
  });

  it('lock 釋放失敗時不得回報 reset: true', async () => {
    initTaskWorkspace('reset-relfail');
    acquireLock('reset-relfail', 'task/reset-relfail', path.join(ws, 'reset-relfail', 'repo'), 'run_x', lockFile);
    // 鎖檔不能被改寫 → releaseLock 會失敗
    fs.chmodSync(lockFile, 0o444);

    const rc1 = await runCli(['start', '--task', 'reset-relfail', '--repo', 'file:///nonexistent'], { checkpointPath: cp, lockPath: lockFile });
    io.take();
    expect(rc1).toBe(2);

    const rc2 = await runCli(['approve', '--task', 'reset-relfail', '--payload', '{"action":"reset"}'], { checkpointPath: cp, lockPath: lockFile });
    const captured = io.take();
    fs.chmodSync(lockFile, 0o644);

    // 不得回報 reset 成功
    expect(rc2).toBe(1);
    expect(captured.out).toBe('');
    const err = JSON.parse(captured.err);
    expect(err.code).toBe('internal_error');
    expect(err.message).toContain('lock');

    // 什麼都沒被刪掉：checkpoint 還在、工作區還在
    const rc3 = await runCli(['status', '--task', 'reset-relfail'], { checkpointPath: cp, lockPath: lockFile });
    io.take();
    expect(rc3).toBe(0);
    expect(fs.existsSync(path.join(ws, 'reset-relfail'))).toBe(true);
  });

  it('工作區清不掉時不得回報 reset 成功，錯誤訊息要說明留下什麼', async () => {
    // 工作區的 base 放在自己的子目錄，才能單獨把它鎖成不能寫
    const base = path.join(ws, 'base');
    fs.mkdirSync(base, { recursive: true });
    process.env.SDD_GRAPH_WORKSPACE_BASE = base;
    initTaskWorkspace('reset-wsfail');
    // 這個 task 還握著鎖
    acquireLock('reset-wsfail', 'task/reset-wsfail', path.join(base, 'reset-wsfail', 'repo'), 'run_x', lockFile);

    const rc1 = await runCli(['start', '--task', 'reset-wsfail', '--repo', 'file:///nonexistent'], { checkpointPath: cp, lockPath: lockFile });
    io.take();
    expect(rc1).toBe(2);

    // base 不能寫 → 工作區刪不掉
    fs.chmodSync(base, 0o500);
    const rc2 = await runCli(['approve', '--task', 'reset-wsfail', '--payload', '{"action":"reset"}'], { checkpointPath: cp, lockPath: lockFile });
    const captured = io.take();
    fs.chmodSync(base, 0o700);

    // 不得回報 reset 成功
    expect(rc2).toBe(1);
    expect(captured.out).toBe('');
    const err = JSON.parse(captured.err);
    expect(err.code).toBe('internal_error');
    // 訊息要說明實際留下的狀態：checkpoint 沒了、工作區還在
    expect(err.message).toContain('workspace');
    expect(err.message).toContain('checkpoint');

    // 鎖先釋放 → 後面失敗也不會留下「工作區沒了但鎖還被握著」
    expect(getLock(lockFile)?.running).toBe(false);

    // checkpoint 確實刪掉了
    const rc3 = await runCli(['status', '--task', 'reset-wsfail'], { checkpointPath: cp, lockPath: lockFile });
    const status = io.take();
    expect(rc3).toBe(1);
    expect(JSON.parse(status.err).code).toBe('no_checkpoint');
  });

  it('complete 的 --result 不合法時必須回 1 invalid_result', async () => {
    const { graph } = buildHostGraph(cp);
    expect(await runCli(['start', '--task', 'c1', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    io.take();

    const rc = await runCli(['complete', '--task', 'c1', '--result', 'not-json'], { graph });
    const captured = io.take();
    expect(rc).toBe(1);
    expect(captured.out).toBe('');
    expect(JSON.parse(captured.err).code).toBe('invalid_result');
  });

  it('complete 的 --result 缺 status 時必須回 1 invalid_result', async () => {
    const { graph } = buildHostGraph(cp);
    expect(await runCli(['start', '--task', 'c1b', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    io.take();

    const rc = await runCli(
      ['complete', '--task', 'c1b', '--result', JSON.stringify({ summary: 'done', changedFiles: [] })],
      { graph }
    );
    const captured = io.take();
    expect(rc).toBe(1);
    expect(JSON.parse(captured.err).code).toBe('invalid_result');
  });

  it('complete 的 outputs 沒落盤時必須重發同一張工作單，且不得推進階段', async () => {
    const missing = path.join(ws, 'not-written.md');
    const { graph, runs } = buildHostGraph(cp, { outputs: [missing] });
    expect(await runCli(['start', '--task', 'c2', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    io.take();

    const rc = await runCli(['complete', '--task', 'c2', '--result', OK_RESULT], { graph });
    const captured = io.take();
    expect(rc).toBe(2);
    const env = JSON.parse(captured.out);
    expect(env.kind).toBe('interrupt');
    expect(env.audience).toBe('host');
    expect(env.payload.outputs).toEqual([missing]);
    expect(runs.tail).toBe(0);          // 圖沒有被推進
  });

  it('complete 的 outputs 都落盤時才推進到 completed', async () => {
    const specFile = path.join(ws, 'spec.md');
    fs.writeFileSync(specFile, '# spec', 'utf-8');
    const { graph, runs } = buildHostGraph(cp, { outputs: [specFile] });
    expect(await runCli(['start', '--task', 'c3', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    io.take();

    const rc = await runCli(['complete', '--task', 'c3', '--result', OK_RESULT], { graph });
    const captured = io.take();
    expect(rc).toBe(0);
    const env = JSON.parse(captured.out);
    expect(env.kind).toBe('result');
    expect(env.stage).toBe('completed');
    expect(runs.tail).toBe(1);
  });

  it('同一張工作單被 complete 兩次：第二次必須報 already_completed 且不得重複推進', async () => {
    const { graph, runs } = buildHostGraph(cp);
    expect(await runCli(['start', '--task', 'c4', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    expect(await runCli(['complete', '--task', 'c4', '--result', OK_RESULT], { graph })).toBe(0);
    io.take();

    const rc = await runCli(['complete', '--task', 'c4', '--result', OK_RESULT], { graph });
    const captured = io.take();
    expect(rc).toBe(1);
    expect(JSON.parse(captured.err).code).toBe('already_completed');
    expect(runs.tail).toBe(1);          // 階段沒有被推進第二次
  });

  it('review 結果不是合法 ReviewResult 時必須重發同一張工作單', async () => {
    const { graph, runs } = buildHostGraph(cp, { resultSchema: 'review' });
    expect(await runCli(['start', '--task', 'c5', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    io.take();

    const rc = await runCli(['complete', '--task', 'c5', '--result', JSON.stringify({ status: 'ok', summary: 'PASS', changedFiles: [] })], { graph });
    const captured = io.take();
    expect(rc).toBe(2);
    expect(JSON.parse(captured.out).kind).toBe('interrupt');
    expect(runs.tail).toBe(0);
  });

  it('review 存在但結構不合法時必須重發同一張工作單，不得讓整個 run 失敗', async () => {
    const { graph, runs } = buildHostGraph(cp, { resultSchema: 'review' });
    expect(await runCli(['start', '--task', 'c5b', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    io.take();

    // review 有值但不合法（缺 issues）——必須重發工作單，而不是回 invalid_result
    const malformed = JSON.stringify({
      status: 'ok',
      summary: 'PASS',
      changedFiles: [],
      review: { role: 'spec', verdict: 'pass' },
    });
    const rc = await runCli(['complete', '--task', 'c5b', '--result', malformed], { graph });
    const captured = io.take();
    expect(rc).toBe(2);
    expect(captured.err).toBe('');
    const env = JSON.parse(captured.out);
    expect(env.kind).toBe('interrupt');
    expect(env.audience).toBe('host');
    expect(env.payload.role).toBe('spec_writer');
    expect(runs.tail).toBe(0);
  });

  it('review 存在但結構不合法時（非 review 工作單）也必須重發工作單', async () => {
    const { graph, runs } = buildHostGraph(cp);
    expect(await runCli(['start', '--task', 'c5c', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    io.take();

    const malformed = JSON.stringify({
      status: 'ok',
      summary: 'done',
      changedFiles: [],
      review: { role: 'spec', verdict: 'pass' },
    });
    const rc = await runCli(['complete', '--task', 'c5c', '--result', malformed], { graph });
    const captured = io.take();
    expect(rc).toBe(2);
    expect(captured.err).toBe('');
    expect(JSON.parse(captured.out).kind).toBe('interrupt');
    expect(runs.tail).toBe(0);
  });

  it('review 結果合法時才推進', async () => {
    const { graph, runs } = buildHostGraph(cp, { resultSchema: 'review' });
    expect(await runCli(['start', '--task', 'c6', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    io.take();

    const result = JSON.stringify({
      status: 'ok',
      summary: 'reviewed',
      changedFiles: [],
      reviews: [
        { role: 'spec', verdict: 'pass', issues: [] },
        { role: 'quality', verdict: 'pass', issues: [] },
      ],
    });
    const rc = await runCli(['complete', '--task', 'c6', '--result', result], { graph });
    io.take();
    expect(rc).toBe(0);
    expect(runs.tail).toBe(1);
  });

  it('工作單的路徑不是絕對路徑時必須拒絕該工作單', async () => {
    // 相對路徑會被拿來跟 CLI 自己的 cwd 比對 → 不能默默放行
    const { graph, runs } = buildHostGraph(cp, { outputs: ['not-absolute/spec.md'] });
    expect(await runCli(['start', '--task', 'c7', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    io.take();

    const rc = await runCli(['complete', '--task', 'c7', '--result', OK_RESULT], { graph });
    const captured = io.take();
    expect(rc).toBe(1);
    expect(JSON.parse(captured.err).code).toBe('invalid_order');
    expect(runs.tail).toBe(0);
  });

  it('中斷 payload 沒有 audience 時必須報錯，不得猜成 user 閘口', async () => {
    const saver = createCheckpointer(path.join(ws, 'cp-no-audience.sqlite'));
    const graph = buildGraph({
      checkpointer: saver,
      testNodes: {
        bootstrap: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: { bootstrapped: true, currentStage: 'prd' },
          goto: 'prd',
        }),
        prd: async (): Promise<NodeOutcome> => {
          interrupt({ type: 'no_audience' });
          return { kind: 'advance', update: {}, goto: 'spec' };
        },
      },
    });

    const rc = await runCli(['start', '--task', 'c8', '--repo', 'file:///nonexistent'], { graph });
    const captured = io.take();
    expect(rc).toBe(1);
    expect(captured.out).toBe('');
    expect(JSON.parse(captured.err).code).toBe('audience_mismatch');
  });

  it('resume 沒有 checkpoint 時必須回 1 no_checkpoint', async () => {    const rc = await runCli(['resume', '--task', 'nothing-here'], { checkpointPath: cp });
    const captured = io.take();
    expect(rc).toBe(1);
    expect(JSON.parse(captured.err).code).toBe('no_checkpoint');
    expect(captured.out).toBe('');
  });

  it('resume 必須重發同一張工作單', async () => {
    const { graph } = buildHostGraph(cp);
    expect(await runCli(['start', '--task', 'r1', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    io.take();

    const rc = await runCli(['resume', '--task', 'r1'], { graph });
    const captured = io.take();
    expect(rc).toBe(2);
    const env = JSON.parse(captured.out);
    expect(env.kind).toBe('interrupt');
    expect(env.audience).toBe('host');
    expect(env.payload.role).toBe('spec_writer');
  });

  it('status 只讀：不得推進任何階段', async () => {
    const { graph, runs } = buildHostGraph(cp);
    expect(await runCli(['start', '--task', 's1', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    io.take();

    const rc = await runCli(['status', '--task', 's1'], { graph });
    const captured = io.take();
    expect(rc).toBe(0);
    const env = JSON.parse(captured.out);
    expect(env.kind).toBe('result');
    expect(env.stage).toBe('prd');
    expect(runs.tail).toBe(0);
  });

  it('stop 不得刪掉 checkpoint', async () => {
    const { graph } = buildHostGraph(cp);
    expect(await runCli(['start', '--task', 'st1', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    io.take();

    const rc = await runCli(['stop', '--task', 'st1'], { graph, lockPath: lockFile });
    const captured = io.take();
    expect(rc).toBe(0);
    expect(JSON.parse(captured.out).kind).toBe('result');

    // checkpoint 還在 → resume 仍然拿得到同一張單
    const rc2 = await runCli(['resume', '--task', 'st1'], { graph });
    io.take();
    expect(rc2).toBe(2);
  });

  it('stop 不得釋放別的 task 持有的全域鎖', async () => {
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        running: true,
        taskName: 'other-task',
        branch: 'task/other-task',
        repoPath: '/repo',
        runId: 'run_1',
        startedAt: new Date().toISOString(),
      }),
      'utf-8'
    );

    const rc = await runCli(['stop', '--task', 'my-task'], { lockPath: lockFile });
    const captured = io.take();
    expect(rc).toBe(1);
    expect(JSON.parse(captured.err).code).toBe('lock_not_owned');

    // 別的 task 的鎖必須原封不動
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
    expect(lock.running).toBe(true);
    expect(lock.taskName).toBe('other-task');
  });

  it('stop --force 也不釋放別的 task 持有的全域鎖（行為變更：force 不再越界）', async () => {
    // **行為變更**：`--force` 以前會把別的 task 握著的鎖刪掉，那等於替別人
    // 中止了他正在跑的那一輪；刪掉的是所有倉庫共用的全域鎖，別的倉庫正在
    // 跑的 run 會因此失去保護。現在 `--force` 只處理沒有活著持有者的鎖。
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        running: true,
        taskName: 'other-task',
        branch: 'task/other-task',
        repoPath: '/repo',
        runId: 'run_1',
        startedAt: new Date().toISOString(),
      }),
      'utf-8'
    );

    const rc = await runCli(['stop', '--task', 'my-task', '--force'], { lockPath: lockFile });
    const captured = io.take();
    expect(rc).toBe(1);
    expect(JSON.parse(captured.err).code).toBe('lock_not_owned');
    // 鎖還在別的 task 手上
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf-8')).taskName).toBe('other-task');
  });

  it('stop --force 會刪掉沒有活著持有者的鎖（自己的、壞掉的、已停的）', async () => {
    // 已停的鎖：檔案還在，但沒有人在跑
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        running: false,
        taskName: 'other-task',
        branch: 'task/other-task',
        repoPath: '/repo',
        runId: 'run_1',
        startedAt: new Date().toISOString(),
      }),
      'utf-8'
    );

    const rc = await runCli(['stop', '--task', 'my-task', '--force'], { lockPath: lockFile });
    io.take();
    expect(rc).toBe(0);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('stop 釋放自己持有的鎖', async () => {
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        running: true,
        taskName: 'my-task',
        branch: 'task/my-task',
        repoPath: '/repo',
        runId: 'run_1',
        startedAt: new Date().toISOString(),
      }),
      'utf-8'
    );

    const rc = await runCli(['stop', '--task', 'my-task'], { lockPath: lockFile });
    io.take();
    expect(rc).toBe(0);
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
    expect(lock.running).toBe(false);
  });
});
