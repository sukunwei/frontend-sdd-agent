import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command, END, interrupt } from '@langchain/langgraph';
import { buildGraph, entryRouter, routeByStage } from '../src/graph/compile.js';
import type { GraphState, NodeOutcome } from '../src/graph/state.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import type { Stage } from '../src/state/types.js';

describe('entry_router', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
    // 正式 bootstrap 節點會準備工作區：不得寫進插件根
    process.env.SDD_GRAPH_WORKSPACE_BASE = dir;
  });
  afterEach(() => {
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('已有 checkpoint 的 resume 不得重跑 bootstrap', async () => {
    let bootstrapRan = 0;
    const saver = createCheckpointer(path.join(dir, 'cp.sqlite'));
    const g = buildGraph({ checkpointer: saver, testNodes: {
      bootstrap: async (): Promise<NodeOutcome> => {
        bootstrapRan += 1;
        return { kind: 'advance', update: { bootstrapped: true, currentStage: 'prd' }, goto: 'prd' };
      },
    }});
    const cfg = { configurable: { thread_id: 'thr-1' } };
    await g.invoke({ requirementName: 'x' }, cfg);
    expect(bootstrapRan).toBe(1);
    await g.invoke(null, cfg);           // 模擬 resume
    expect(bootstrapRan).toBe(1);        // 不得變 2
  });

  it('全新 thread 必須進 bootstrap', async () => {
    let bootstrapRan = 0;
    const saver = createCheckpointer(path.join(dir, 'cp2.sqlite'));
    const g = buildGraph({ checkpointer: saver, testNodes: {
      bootstrap: async (): Promise<NodeOutcome> => {
        bootstrapRan += 1;
        return { kind: 'advance', update: { bootstrapped: true }, goto: 'prd' };
      },
    }});
    await g.invoke({ requirementName: 'y' }, { configurable: { thread_id: 'thr-new' } });
    expect(bootstrapRan).toBe(1);
  });

  it('還沒 bootstrap 過時 entry_router 走 bootstrap', async () => {
    const outcome = await entryRouter({ bootstrapped: false } as GraphState);
    expect(outcome.kind).toBe('advance');
    expect(outcome.kind === 'advance' && outcome.goto).toBe('bootstrap');
  });

  it('已經 bootstrap 過時 entry_router 走 routeByStage', async () => {
    const outcome = await entryRouter({ bootstrapped: true } as GraphState);
    expect(outcome.kind).toBe('advance');
    expect(outcome.kind === 'advance' && outcome.goto).toBe('routeByStage');
  });

  it('routeByStage 依 currentStage 決定下一個節點', async () => {
    const cases: Array<[Stage, string]> = [
      ['prd', 'prd'],
      ['spec', 'spec'],
      ['e2ePlan', 'e2e_plan'],
      ['taskSplit', 'task_split'],
      ['tdd', 'tdd'],
      // 'verification' 是 state channel 名稱，LangGraph 不允許同名節點，故節點名為 'verify'
      ['verification', 'verify'],
      ['completed', 'completed'],
    ];
    for (const [stage, node] of cases) {
      const outcome = await routeByStage({ currentStage: stage } as GraphState);
      expect(outcome.kind).toBe('advance');
      expect(outcome.kind === 'advance' && outcome.goto).toBe(node);
    }
  });

  it('bootstrap 階段沒有後續節點：不得回頭重跑 bootstrap', async () => {
    const outcome = await routeByStage({ currentStage: 'bootstrap' } as GraphState);
    expect(outcome.kind).toBe('advance');
    expect(outcome.kind === 'advance' && outcome.goto).toBe(END);
  });

  it('尚未實作的階段節點會停在 pending interrupt', async () => {
    const saver = createCheckpointer(path.join(dir, 'cp3.sqlite'));
    const g = buildGraph({ checkpointer: saver, testNodes: {
      bootstrap: async (): Promise<NodeOutcome> => ({
        kind: 'advance', update: { bootstrapped: true, currentStage: 'prd' }, goto: 'prd',
      }),
    }});
    const cfg = { configurable: { thread_id: 'thr-interrupt' } };
    await g.invoke({ requirementName: 'x' }, cfg);
    const snap: any = await g.getState(cfg);
    // PRD 階段已經有真的節點：閘門除了說明自己，還要說明答案的形狀
    expect(snap.tasks[0].interrupts[0].value).toMatchObject({
      audience: 'user',
      type: 'collect_prd',
    });
  });

  it('正式 bootstrap 節點接上後：repoUrl 不合法時必須停下來，不得假裝已 bootstrap', async () => {
    const saver = createCheckpointer(path.join(dir, 'cp4.sqlite'));
    const g = buildGraph({ checkpointer: saver, lockPath: path.join(dir, 'lock.json') });
    const cfg = { configurable: { thread_id: 'thr-no-bootstrap' } };
    // 沒有 repoUrl → 正式 bootstrap 節點驗不過 → 中斷，不得前進
    await g.invoke({ requirementName: 'x' }, cfg);
    const snap: any = await g.getState(cfg);
    expect(snap.tasks[0].interrupts[0].value).toMatchObject({ audience: 'user' });
    expect(snap.values.bootstrapped).toBe(false);
  });

  it('帶值 resume：節點拿到答案、副作用只跑一次、圖繼續前進', async () => {
    const answers: unknown[] = [];
    let sideEffects = 0;
    const saver = createCheckpointer(path.join(dir, 'cp-resume.sqlite'));
    const g = buildGraph({ checkpointer: saver, testNodes: {
      bootstrap: async (): Promise<NodeOutcome> => ({
        kind: 'advance', update: { bootstrapped: true, currentStage: 'prd' }, goto: 'prd',
      }),
      prd: async (): Promise<NodeOutcome> => {
        // interrupt() 必須是節點的第一件事：恢復時整個節點會重跑一次
        const answer = interrupt({ audience: 'user', type: 'collect_prd' });
        sideEffects += 1;
        answers.push(answer);
        return { kind: 'advance', update: { currentStage: 'spec' }, goto: 'spec' };
      },
    }});
    const cfg = { configurable: { thread_id: 'thr-resume-value' } };

    await g.invoke({ requirementName: 'x' }, cfg);
    expect(sideEffects).toBe(0);                       // 掛起時副作用還沒跑
    const parked: any = await g.getState(cfg);
    expect(parked.tasks[0].interrupts[0].value).toEqual({ audience: 'user', type: 'collect_prd' });

    await g.invoke(new Command({ resume: 'the-prd' }), cfg);   // 不得丟例外
    expect(answers).toEqual(['the-prd']);              // 答案有送到節點
    expect(sideEffects).toBe(1);                       // 副作用只跑一次
    const after: any = await g.getState(cfg);
    expect(after.values.currentStage).toBe('spec');    // 圖繼續往下走
  });

  it('帶值 resume：節點恢復後不得丟例外，圖要繼續走', async () => {
    const saver = createCheckpointer(path.join(dir, 'cp-resume-placeholder.sqlite'));
    // 正式 bootstrap 節點已經接上，這裡注入一個會先掛起的節點，專門測恢復
    const g = buildGraph({ checkpointer: saver, testNodes: {
      bootstrap: async (): Promise<NodeOutcome> => {
        interrupt({ audience: 'user', type: 'bootstrap_not_implemented' });
        return { kind: 'advance', update: { bootstrapped: true, currentStage: 'prd' }, goto: 'prd' };
      },
    }});
    const cfg = { configurable: { thread_id: 'thr-resume-placeholder' } };
    await g.invoke({ requirementName: 'x' }, cfg);
    const parked: any = await g.getState(cfg);
    expect(parked.tasks[0].interrupts[0].value).toMatchObject({ audience: 'user' });

    await g.invoke(new Command({ resume: 'the-answer' }), cfg);   // 不得丟例外
    const after: any = await g.getState(cfg);
    expect(after.values.currentStage).toBe('prd');     // 恢復後推進到 prd
  });

  it('注入圖中不存在的節點必須立刻報錯，不得靜默忽略', () => {
    const saver = createCheckpointer(path.join(dir, 'cp-unknown.sqlite'));
    expect(() =>
      buildGraph({ checkpointer: saver, testNodes: { ask: async () => ({ kind: 'advance', update: {}, goto: 'prd' }) } })
    ).toThrow(/ask/);
  });

  it('最終狀態必須用 getState() 讀：invoke() 的回傳值型別容許 undefined', async () => {
    const saver = createCheckpointer(path.join(dir, 'cp-end.sqlite'));
    const g = buildGraph({ checkpointer: saver, testNodes: {
      bootstrap: async (): Promise<NodeOutcome> => ({
        kind: 'advance',
        update: { bootstrapped: true },
        goto: 'prd',
      }),
    }});
    const cfg = { configurable: { thread_id: 'thr-end' } };
    // 節點沒有寫入任何狀態時，invoke() 不保證有值
    const out: GraphState | undefined = await g.invoke({ requirementName: 'y' }, cfg);
    const snap = await g.getState(cfg);
    expect(snap.values.currentStage).toBe('bootstrap');
    expect(snap.values.bootstrapped).toBe(true);
    expect(out === undefined || out.currentStage === 'bootstrap').toBe(true);
  });

  it('completed 階段走到圖的盡頭', async () => {
    const saver = createCheckpointer(path.join(dir, 'cp-completed.sqlite'));
    const g = buildGraph({ checkpointer: saver, testNodes: {
      bootstrap: async (): Promise<NodeOutcome> => ({
        // 節點必須自己指定要去哪：bootstrap 之後的靜態邊只會去 prd
        kind: 'advance', update: { bootstrapped: true, currentStage: 'verification' }, goto: 'verify',
      }),
      verify: async (): Promise<NodeOutcome> => ({
        kind: 'advance', update: { currentStage: 'completed' }, goto: 'completed',
      }),
    }});
    const cfg = { configurable: { thread_id: 'thr-completed' } };
    await g.invoke({ requirementName: 'x' }, cfg);
    const snap = await g.getState(cfg);
    expect(snap.values.currentStage).toBe('completed');
    expect(snap.next).toEqual([]);          // 圖已結束，沒有待辦節點
  });
});

describe('createCheckpointer', () => {
  it('父目錄不存在時必須先建立', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cp-'));
    try {
      const db = path.join(dir, 'nested', 'deep', 'cp.sqlite');
      createCheckpointer(db);
      expect(fs.existsSync(db)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
