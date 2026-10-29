import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from '@langchain/langgraph';
import { buildGraph } from '../src/graph/compile.js';
import type { NodeOutcome } from '../src/graph/state.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import { checkFigmaP0, FIGMA_P0_FILES } from '../src/nodes/prd.js';

describe('PRD 階段', () => {
  it('缺少 P0 檔案時必須回報缺哪些', () => {
    const r = checkFigmaP0('/tmp/definitely-missing');
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('figma/design-tree.json');
  });

  it('P0 檔案清單固定', () => {
    expect(FIGMA_P0_FILES).toEqual([
      'figma/figma-meta.json',
      'figma/design-tree.json',
      'figma/design-tokens.json',
      'figma/design-context.md',
    ]);
  });

  it('P0 齊全（檔案與截圖）時才算通過', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p0-'));
    try {
      for (const rel of FIGMA_P0_FILES) {
        const file = path.join(dir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{}', 'utf-8');
      }
      expect(checkFigmaP0(dir).ok).toBe(false); // 還沒有截圖
      expect(checkFigmaP0(dir).missing).toContain('figma/screenshots/*.png');

      const shots = path.join(dir, 'figma', 'screenshots');
      fs.mkdirSync(shots, { recursive: true });
      fs.writeFileSync(path.join(shots, 'screen-01.png'), 'png', 'utf-8');
      expect(checkFigmaP0(dir).ok).toBe(true);
      expect(checkFigmaP0(dir).missing).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PRD 節點', () => {
  let dir: string;
  let repoDir: string;
  let docsDir: string;
  let prdPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-prd-'));
    repoDir = path.join(dir, 'repo');
    docsDir = path.join(repoDir, 'docs', 'demo');
    prdPath = path.join(docsDir, 'prd.md');
    fs.mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The real PRD node behind a fake bootstrap. */
  function prdGraph(): { g: any; cfg: any } {
    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(dir, 'cp.sqlite')),
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
    return { g, cfg: { configurable: { thread_id: 'thr-prd' } } };
  }

  /** The payload the run is parked on. */
  async function pending(g: any, cfg: any): Promise<any> {
    const snap: any = await g.getState(cfg);
    return snap.tasks[0].interrupts[0].value;
  }

  it('第一件事必須是問人：不得先憑空寫一份 PRD', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('collect_prd');
    // 閘門必須說清楚答案的形狀
    expect(payload.answer.prdMarkdown).toBeTypeOf('string');
    expect(payload.answer.figmaUrl).toBeTypeOf('string');
    expect(fs.existsSync(prdPath)).toBe(false);
  });

  it('使用者給了 PRD 才寫 prd.md', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { prdMarkdown: '# PRD\n\n要有一個 QR code 產生器' } }), cfg);

    expect(fs.readFileSync(prdPath, 'utf-8')).toContain('要有一個 QR code 產生器');
  });

  it('沒有 Figma URL 時直接問確認', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { prdMarkdown: '# PRD' } }), cfg);

    expect(await pending(g, cfg)).toEqual({ audience: 'user', type: 'confirm_prd' });
  });

  it('有 Figma URL 時必須發 figma_fetch 工作單，outputs 是 P0 檔案', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(
      new Command({ resume: { prdMarkdown: '# PRD', figmaUrl: 'https://www.figma.com/design/abc' } }),
      cfg
    );

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('host');
    expect(payload.role).toBe('figma_fetch');
    expect(payload.type).toBe('work_order');
    expect(payload.outputs).toEqual([
      ...FIGMA_P0_FILES.map((rel) => path.join(docsDir, rel)),
      path.join(docsDir, 'figma', 'screenshots'),
    ]);
    expect(payload.prompt).toContain('https://www.figma.com/design/abc');
  });

  it('Figma 抓取失敗時記一筆不擋人的 TBC，不得堵死非 UI 需求', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(
      new Command({ resume: { prdMarkdown: '# PRD', figmaUrl: 'https://www.figma.com/design/abc' } }),
      cfg
    );
    await g.invoke(
      new Command({ resume: { status: 'failed', summary: '抓不到', changedFiles: [] } }),
      cfg
    );

    const snap: any = await g.getState(cfg);
    const tbcs = snap.values.tbcItems as Array<{ id: string; blocking: boolean; description: string }>;
    expect(tbcs.length).toBeGreaterThan(0);
    expect(tbcs.every((tbc) => tbc.blocking === false)).toBe(true);
    // TBC 的 id 必須帶著階段名：兩個階段的 TBC 才不會互相蓋掉
    expect(tbcs[0].id).toBe('TBC-FIGMA-prd');
    // 失敗不得把流程卡住：下一個中斷是確認。
    expect(await pending(g, cfg)).toEqual({ audience: 'user', type: 'confirm_prd' });
  });

  it('確認後前進到 spec 階段', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { prdMarkdown: '# PRD' } }), cfg);
    await g.invoke(new Command({ resume: { approved: true } }), cfg);

    const snap: any = await g.getState(cfg);
    expect(snap.values.currentStage).toBe('spec');
  });

  it('工作單的 outputs 必須包含截圖目錄，prompt 也要同意', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(
      new Command({ resume: { prdMarkdown: '# PRD', figmaUrl: 'https://www.figma.com/design/abc' } }),
      cfg
    );

    const payload = await pending(g, cfg);
    const shots = path.join(docsDir, 'figma', 'screenshots');
    expect(payload.outputs).toContain(shots);
    expect(payload.prompt).toContain(shots);
  });

  it('worker 回 ok 但沒有寫 P0 檔案時仍要記一筆不擋人的 TBC', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(
      new Command({ resume: { prdMarkdown: '# PRD', figmaUrl: 'https://www.figma.com/design/abc' } }),
      cfg
    );
    // 工人說完成了，但檔案一個都沒有：檔案系統說了算。
    await g.invoke(
      new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }),
      cfg
    );

    const snap: any = await g.getState(cfg);
    const tbcs = snap.values.tbcItems as Array<{ blocking: boolean; description: string }>;
    expect(tbcs.length).toBeGreaterThan(0);
    expect(tbcs.every((tbc) => tbc.blocking === false)).toBe(true);
    expect(tbcs[0].description).toContain('design-tree.json');
    // 不得堵死流程
    expect(await pending(g, cfg)).toEqual({ audience: 'user', type: 'confirm_prd' });
  });

  it('worker 回 needs_human 時問題要變成使用者的閘門', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(
      new Command({ resume: { prdMarkdown: '# PRD', figmaUrl: 'https://www.figma.com/design/abc' } }),
      cfg
    );
    await g.invoke(
      new Command({
        resume: {
          status: 'needs_human',
          summary: 'blocked',
          changedFiles: [],
          interrupt: { type: 'figma_permission', question: 'may I read the file?', options: ['yes', 'no'] },
        },
      }),
      cfg
    );

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('figma_needs_human');
    expect(payload.question).toBe('may I read the file?');
    expect(payload.options).toEqual(['yes', 'no']);
  });

  it('階段 ledger 的 payload 不得放進 artifacts 的 path', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(
      new Command({ resume: { prdMarkdown: '# PRD', figmaUrl: 'https://www.figma.com/design/abc' } }),
      cfg
    );

    const snap: any = await g.getState(cfg);
    // artifacts 只放產出的檔案：它的 path 一定是路徑
    expect(snap.values.artifacts).toEqual({});
    for (const entry of Object.values(snap.values.artifacts ?? {}) as Array<{ path: string }>) {
      expect(path.isAbsolute(entry.path)).toBe(true);
    }
    // ledger 有自己的 channel
    expect(Object.keys(snap.values.stageSteps ?? {}).length).toBeGreaterThan(0);
    expect(snap.values.stageSteps['prd/figma-url']).toBe('https://www.figma.com/design/abc');
  });

  it('答案形狀不對時要出錯，不得無聲地再問一次', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);

    await expect(
      g.invoke(new Command({ resume: { prd: '# PRD' } }), cfg)
    ).rejects.toThrow(/prdMarkdown/);
  });

  it('approved 不是 true 時不得當成同意', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { prdMarkdown: '# PRD' } }), cfg);
    await g.invoke(new Command({ resume: { approved: 'no' } }), cfg);

    // 'no' 不是 true：不得當成同意
    expect((await pending(g, cfg)).type).toBe('collect_prd');
    const snap: any = await g.getState(cfg);
    expect(snap.values.currentStage).toBe('prd');
  });

  it('沒有 requirement name 時也要停在 collect_prd', async () => {
    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(dir, 'cp-empty.sqlite')),
      testNodes: {
        bootstrap: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: { bootstrapped: true, currentStage: 'prd', requirementName: '', repoPath: repoDir },
          goto: 'prd',
        }),
      },
    });
    const cfg = { configurable: { thread_id: 'thr-prd-empty' } };

    await g.invoke({ requirementName: '' }, cfg);
    const snap: any = await g.getState(cfg);
    expect(snap.tasks[0].interrupts[0].value.type).toBe('collect_prd');
  });

  it('使用者不確認就重新收集 PRD', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { prdMarkdown: '# PRD 第一版' } }), cfg);
    await g.invoke(new Command({ resume: { approved: false } }), cfg);

    // 必須回到收集 PRD 的閘門，而不是再問一次確認
    expect(await pending(g, cfg)).toEqual({
      audience: 'user',
      type: 'collect_prd',
      answer: { prdMarkdown: expect.any(String), figmaUrl: expect.any(String) },
    });

    await g.invoke(new Command({ resume: { prdMarkdown: '# PRD 第二版' } }), cfg);
    expect(fs.readFileSync(prdPath, 'utf-8')).toContain('第二版');
  });

  it('先前的 TBC 不得被之後的更新蓋掉', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(
      new Command({ resume: { prdMarkdown: '# PRD', figmaUrl: 'https://www.figma.com/design/abc' } }),
      cfg
    );
    await g.invoke(
      new Command({
        resume: {
          status: 'needs_human',
          summary: 'blocked',
          changedFiles: [],
          interrupt: { type: 'figma_permission', question: 'may I read it?', options: ['yes'] },
        },
      }),
      cfg
    );
    await g.invoke(new Command({ resume: { answer: 'yes' } }), cfg);

    const snap: any = await g.getState(cfg);
    const ids = (snap.values.tbcItems as Array<{ id: string }>).map((tbc) => tbc.id);
    // 抓取失敗的 TBC 與使用者回答的 TBC 都要在
    expect(ids).toContain('TBC-FIGMA-prd');
    expect(ids).toContain('TBC-FIGMA-ANSWER');
  });

  it('使用者不確認就重新收集，不得自己往前', async () => {
    const { g, cfg } = prdGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { prdMarkdown: '# PRD' } }), cfg);
    await g.invoke(new Command({ resume: { approved: false } }), cfg);

    // 拒絕之後要回到收集 PRD 的閘門，不是再問一次確認
    expect((await pending(g, cfg)).type).toBe('collect_prd');
    const snap: any = await g.getState(cfg);
    expect(snap.values.currentStage).toBe('prd');
  });
});
