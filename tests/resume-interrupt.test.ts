import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { interrupt } from '@langchain/langgraph';
import { buildGraph } from '../src/graph/compile.js';
import type { NodeOutcome } from '../src/graph/state.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import { runCli } from '../src/cli/index.js';
import { captureIo } from './helpers/capture-io.js';
import { buildHostGraph } from './helpers/host-graph.js';

describe('resume 跨進程', () => {
  it('換進程後 interrupt payload 不變', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-res-'));
    try {
      const db = path.join(dir, 'cp.sqlite');
      const saver = createCheckpointer(db);
      const g = buildGraph({ checkpointer: saver, testNodes: {
        bootstrap: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: { bootstrapped: true, currentStage: 'prd' },
          goto: 'prd',
        }),
        prd: async (): Promise<NodeOutcome> => {
          interrupt({ audience: 'user', type: 'collect_prd' });
          return { kind: 'advance', update: {}, goto: 'spec' };
        },
      }});
      const cfg = { configurable: { thread_id: 'thr-a' } };
      await g.invoke({ requirementName: 'x' }, cfg);

      // 模擬「換一個進程」：重新 fromConnString 同一個檔案
      const saver2 = createCheckpointer(db);
      const g2 = buildGraph({
        checkpointer: saver2,
        testNodes: {
          bootstrap: async (): Promise<NodeOutcome> => ({ kind: 'advance', update: {}, goto: 'prd' }),
          prd: async (): Promise<NodeOutcome> => ({ kind: 'advance', update: {}, goto: 'spec' }),
        },
      });
      const snap: any = await g2.getState(cfg);
      expect(snap.tasks?.[0]?.interrupts?.[0]?.value).toEqual({ audience: 'user', type: 'collect_prd' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resume 跨進程（CLI）', () => {
  let dir: string;
  let db: string;
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-res-cli-'));
    db = path.join(dir, 'cp.sqlite');
    io = captureIo();
  });
  afterEach(() => {
    io.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('換進程後 resume 必須重發同一張工作單', async () => {
    const order = {
      role: 'developer',
      prompt: 'implement the task',
      cwd: '/repo',
      inputs: ['/repo/docs/spec.md'],
      outputs: ['/repo/src/app.ts'],
    };
    const first = buildHostGraph(db, order).graph;
    expect(await runCli(['start', '--task', 'thr-b', '--repo', 'file:///nonexistent'], { graph: first })).toBe(2);
    io.take();

    // 換一個進程：新的 checkpointer、新的圖，同一個資料庫
    const second = buildHostGraph(db, order).graph;
    const rc = await runCli(['resume', '--task', 'thr-b'], { graph: second });
    const captured = io.take();
    expect(rc).toBe(2);
    const env = JSON.parse(captured.out);
    expect(env.kind).toBe('interrupt');
    expect(env.audience).toBe('host');
    expect(env.type).toBe('work_order');
    expect(env.payload).toEqual({
      audience: 'host',
      type: 'work_order',
      role: 'developer',
      prompt: 'implement the task',
      cwd: '/repo',
      inputs: ['/repo/docs/spec.md'],
      outputs: ['/repo/src/app.ts'],
      resultSchema: 'none',
    });
  });
});
