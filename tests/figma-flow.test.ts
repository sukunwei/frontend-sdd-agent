import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from '@langchain/langgraph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FidelityReport } from '../src/figma/fidelity.js';
import { buildGraph } from '../src/graph/compile.js';
import type { NodeOutcome } from '../src/graph/state.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';

/** A measurement that returns the given hard failures, one call after another. */
function fakeMeasure(hardFailures: number[]): () => Promise<FidelityReport> {
  let call = 0;
  return async () => {
    const failures = hardFailures[Math.min(call, hardFailures.length - 1)];
    call += 1;
    return {
      frames: failures === 0
        ? []
        : [{ key: '1-23', status: 'render_failed', ratio: 0, width: 0, height: 0, error: 'boom' }],
      hardFailures: failures,
      jsonPath: '/tmp/frames.json',
      mdPath: '/tmp/report.md',
    };
  };
}

/** A measurement whose failure is the machine's fault, not the prototype's. */
function fakeEnvironmentMeasure(): () => Promise<FidelityReport> {
  return async () => ({
    frames: [
      {
        key: '1-23',
        status: 'render_failed',
        ratio: 0,
        width: 0,
        height: 0,
        error: 'no Playwright in /repo',
        errorKind: 'environment',
      },
    ],
    hardFailures: 1,
    jsonPath: '/tmp/frames.json',
    mdPath: '/tmp/report.md',
  });
}

/** A measurement whose frames were measured but differ a lot. */
function fakeDriftingMeasure(): () => Promise<FidelityReport> {
  return async () => ({
    frames: [
      { key: '1-23', status: 'ok', ratio: 0.08, width: 1440, height: 900 },
    ],
    hardFailures: 0,
    jsonPath: '/tmp/frames.json',
    mdPath: '/tmp/report.md',
  });
}

describe('Figma 流程', () => {
  let dir: string;
  let repoDir: string;
  let docsDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-flow-'));
    repoDir = path.join(dir, 'repo');
    docsDir = path.join(repoDir, 'docs', 'demo');
    fs.mkdirSync(docsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The PRD node behind a fake bootstrap, with a fake measurement. */
  function prdGraph(measure: ReturnType<typeof fakeMeasure>) {
    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(dir, 'cp.sqlite')),
      figmaOptions: { measure },
      testNodes: {
        bootstrap: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: {
            bootstrapped: true,
            currentStage: 'prd',
            requirementName: 'demo',
            repoPath: repoDir,
          },
          goto: 'prd',
        }),
      },
    });
    return { g, cfg: { configurable: { thread_id: 'thr-flow' } } };
  }

  /** The payload the run is parked on. */
  async function pending(g: unknown, cfg: unknown): Promise<any> {
    const snap: any = await (g as any).getState(cfg);
    return snap.tasks[0].interrupts[0].value;
  }

  /** Write the P0 files and one screenshot. */
  function writeP0(): void {
    fs.mkdirSync(path.join(docsDir, 'figma', 'screenshots'), { recursive: true });
    for (const relative of [
      'figma/figma-meta.json',
      'figma/design-tree.json',
      'figma/design-tokens.json',
      'figma/design-context.md',
    ]) {
      fs.writeFileSync(path.join(docsDir, relative), '{}');
    }
    fs.writeFileSync(path.join(docsDir, 'figma', 'screenshots', '1-23.png'), 'x');
  }

  /** Answer the collect_prd gate and the fetch order. */
  async function answerUpToPrototype(g: any, cfg: any): Promise<void> {
    await g.invoke(
      new Command({ resume: { prdMarkdown: '# PRD', figmaUrl: 'https://www.figma.com/design/abc' } }),
      cfg
    );
    await g.invoke(new Command({ resume: { status: 'ok', summary: '抓到了', changedFiles: [] } }), cfg);
  }

  it('抓完之後要發一張原型工作單', async () => {
    const { g, cfg } = prdGraph(fakeMeasure([0]));
    await g.invoke({ requirementName: 'demo' }, cfg);
    writeP0();
    await answerUpToPrototype(g, cfg);

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('host');
    expect(payload.role).toBe('figma_prototype');
  });

  it('P0 沒抓到時不發原型工作單，直接走到 confirm_prd', async () => {
    const { g, cfg } = prdGraph(fakeMeasure([0]));
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(
      new Command({ resume: { prdMarkdown: '# PRD', figmaUrl: 'https://www.figma.com/design/abc' } }),
      cfg
    );
    await g.invoke(
      new Command({ resume: { status: 'failed', summary: '抓不到', changedFiles: [] } }),
      cfg
    );

    const gate = await pending(g, cfg);
    expect(gate.type).toBe('confirm_prd');
  });

  it('量測有硬失敗時發一張修補工作單，修完再量一次', async () => {
    const { g, cfg } = prdGraph(fakeMeasure([1, 0]));
    await g.invoke({ requirementName: 'demo' }, cfg);
    writeP0();
    await answerUpToPrototype(g, cfg);

    const prototype = await pending(g, cfg);
    expect(prototype.role).toBe('figma_prototype');

    await g.invoke(new Command({ resume: { status: 'ok', summary: '原型好了', changedFiles: [] } }), cfg);

    const polish = await pending(g, cfg);
    expect(polish.role).toBe('figma_polish');

    await g.invoke(new Command({ resume: { status: 'ok', summary: '修好了', changedFiles: [] } }), cfg);

    const gate = await pending(g, cfg);
    expect(gate.type).toBe('confirm_prd');
  });

  it('量測沒有硬失敗時不再發任何工作單', async () => {
    const { g, cfg } = prdGraph(fakeMeasure([0]));
    await g.invoke({ requirementName: 'demo' }, cfg);
    writeP0();
    await answerUpToPrototype(g, cfg);

    await g.invoke(new Command({ resume: { status: 'ok', summary: '原型好了', changedFiles: [] } }), cfg);

    const gate = await pending(g, cfg);
    expect(gate.type).toBe('confirm_prd');
  });

  it('沒有 Figma 網址時不會出現任何原型工作單', async () => {
    const { g, cfg } = prdGraph(fakeMeasure([0]));
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { prdMarkdown: '# PRD' } }), cfg);

    const gate = await pending(g, cfg);
    expect(gate.type).toBe('confirm_prd');
  });

  it('confirm_prd 的 payload 要帶原型路徑與 diff 摘要', async () => {
    const { g, cfg } = prdGraph(fakeMeasure([0]));
    await g.invoke({ requirementName: 'demo' }, cfg);
    writeP0();
    await answerUpToPrototype(g, cfg);
    await g.invoke(new Command({ resume: { status: 'ok', summary: '原型好了', changedFiles: [] } }), cfg);

    const gate = await pending(g, cfg);
    expect(gate.prototype).toContain(path.join('figma', 'prototype', 'index.html'));
    expect(gate.diff).toBeDefined();
  });

  it('環境問題（沒有 Playwright）不得發修補工作單，要直接問使用者', async () => {
    const { g, cfg } = prdGraph(fakeEnvironmentMeasure());
    await g.invoke({ requirementName: 'demo' }, cfg);
    writeP0();
    await answerUpToPrototype(g, cfg);
    await g.invoke(new Command({ resume: { status: 'ok', summary: '原型好了', changedFiles: [] } }), cfg);

    // 沒有修補工作單：環境問題不是 HTML 的問題。
    const gate = await pending(g, cfg);
    expect(gate.type).toBe('confirm_prd');

    const snap: any = await g.getState(cfg);
    const tbcs = snap.values.tbcItems as Array<{ id: string; blocking: boolean; description: string }>;
    expect(tbcs.some((tbc) => tbc.blocking)).toBe(true);
  });

  it('像素差太多時記一筆不擋人的 TBC，而且 confirm_prd 看得到分數', async () => {
    const { g, cfg } = prdGraph(fakeDriftingMeasure());
    await g.invoke({ requirementName: 'demo' }, cfg);
    writeP0();
    await answerUpToPrototype(g, cfg);
    await g.invoke(new Command({ resume: { status: 'ok', summary: '原型好了', changedFiles: [] } }), cfg);

    const gate = await pending(g, cfg);
    expect(gate.type).toBe('confirm_prd');
    expect(gate.diff).toContain('1-23');

    const snap: any = await g.getState(cfg);
    const tbcs = snap.values.tbcItems as Array<{ id: string; blocking: boolean; description: string }>;
    expect(tbcs.length).toBeGreaterThan(0);
    expect(tbcs.every((tbc) => !tbc.blocking)).toBe(true);
  });

  it('spec 階段補抓之後也要做原型', async () => {
    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(dir, 'cp.sqlite')),
      figmaOptions: { measure: fakeMeasure([0]) },
      testNodes: {
        bootstrap: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: {
            bootstrapped: true,
            currentStage: 'spec',
            requirementName: 'demo',
            repoPath: repoDir,
            stageSteps: {
              'prd/design': 'url',
              'prd/figma-url': 'https://www.figma.com/design/abc',
            },
          },
          goto: 'spec',
        }),
      },
    });
    const cfg = { configurable: { thread_id: 'thr-spec-flow' } };
    await g.invoke({ requirementName: 'demo' }, cfg);

    // 使用者決定補抓
    const gate = await pending(g, cfg);
    expect(gate.type).toBe('figma_missing');
    await g.invoke(new Command({ resume: { action: 'fetch' } }), cfg);

    const fetchOrder = await pending(g, cfg);
    expect(fetchOrder.role).toBe('figma_fetch');

    writeP0();
    await g.invoke(new Command({ resume: { status: 'ok', summary: '抓到了', changedFiles: [] } }), cfg);

    const prototype = await pending(g, cfg);
    expect(prototype.role).toBe('figma_prototype');
  });
});
