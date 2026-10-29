import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from '@langchain/langgraph';
import { initTaskWorkspace } from '../src/runtime/task-workspace.js';
import { buildGraph } from '../src/graph/compile.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import { cloneFixture, createGitFixture } from './helpers/git-fixture.js';
import type { GitFixture } from './helpers/git-fixture.js';

/**
 * `start` on a task whose workspace is already there must not fail and must
 * not silently start over: the node parks with an `already_exists` gate and
 * lets the user pick `resume` or `reset`.
 *
 * The gate is raised with `interrupt(payload)` inside the node body, so the
 * payload can only be read from a parked graph (see bootstrap-lock.test.ts).
 */
describe('already_exists', () => {
  let ws: string;
  let lockFile: string;
  let fixture: GitFixture;

  beforeAll(() => {
    fixture = createGitFixture('sdd-dup-remote-');
  });

  afterAll(() => {
    fixture.cleanup();
  });

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-dup-'));
    lockFile = path.join(ws, 'branch-runtime-lock.json');
    process.env.SDD_GRAPH_WORKSPACE_BASE = ws;
  });

  afterEach(() => {
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
    fs.rmSync(ws, { recursive: true, force: true });
  });

  /** Build the real graph and run one thread into the first gate. */
  async function runToGate(requirementName: string, repoUrl: string): Promise<any> {
    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
      lockPath: lockFile,
    });
    const cfg = { configurable: { thread_id: requirementName } };
    await g.invoke({ requirementName, repoUrl }, cfg);
    return g.getState(cfg);
  }

  it('工作區已存在時中斷讓使用者選 resume 或 reset', async () => {
    initTaskWorkspace('dup-task');

    const snap = await runToGate('dup-task', 'file:///nope');
    const payload = snap.tasks[0].interrupts[0].value;
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('already_exists');
    expect(payload.options).toEqual(['resume', 'reset']);

    // 不得前進，也不得把既有工作區刪掉
    expect(snap.values.bootstrapped).toBe(false);
    expect(fs.existsSync(path.join(ws, 'dup-task', 'repo'))).toBe(true);
  });

  it('選 resume 時必須沿用既有工作區，不得重新 clone', async () => {
    // 一個已經 clone 好、也有 run metadata 的工作區
    const repoDir = path.join(ws, 'dup-task', 'repo');
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    cloneFixture(fixture.url, repoDir);
    fs.writeFileSync(
      path.join(ws, 'dup-task', 'run-metadata.json'),
      JSON.stringify({ runId: 'run_old' }),
      'utf-8'
    );

    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
      lockPath: lockFile,
    });
    const cfg = { configurable: { thread_id: 'dup-task' } };
    await g.invoke({ requirementName: 'dup-task', repoUrl: 'file:///nope' }, cfg);
    await g.invoke(new Command({ resume: { action: 'resume' } }), cfg);

    const snap: any = await g.getState(cfg);
    expect(snap.values.bootstrapped).toBe(true);
    expect(snap.values.currentStage).toBe('prd');
    expect(snap.values.repoPath).toBe(repoDir);
    expect(snap.values.runId).toBe('run_old');   // 沿用舊 run
    expect(fs.existsSync(path.join(repoDir, '.git'))).toBe(true);
  });

  it('選 reset 時必須清掉舊工作區重新開始', async () => {
    initTaskWorkspace('dup-task');

    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
      lockPath: lockFile,
    });
    const cfg = { configurable: { thread_id: 'dup-task' } };
    await g.invoke({ requirementName: 'dup-task', repoUrl: 'file:///nope' }, cfg);
    await g.invoke(new Command({ resume: { action: 'reset' } }), cfg);

    const snap: any = await g.getState(cfg);
    // 舊工作區不見了，repo 又不存在 → 停在 clone 失敗
    expect(snap.tasks[0].interrupts[0].value.type).toBe('bootstrap_failed');
    expect(fs.existsSync(path.join(ws, 'dup-task'))).toBe(false);
  });
});
