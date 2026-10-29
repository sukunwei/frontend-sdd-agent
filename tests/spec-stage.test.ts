import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from '@langchain/langgraph';
import { buildGraph } from '../src/graph/compile.js';
import type { NodeOutcome } from '../src/graph/state.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import { specNode } from '../src/nodes/spec.js';

const FIX = path.join(import.meta.dirname, 'fixtures', 'qrcode-app');

describe('Spec 階段出口', () => {
  it('抽不到 AC-xxx 就不算通過', () => {
    const r = specNode.exit({} as any, FIX);
    expect(r.acIds.length).toBeGreaterThan(0);
    expect(r.missingAc).toBe(false);
  });

  it('有未解的 blocking TBC 時不得推進到 e2ePlan', () => {
    const r = specNode.exit({} as any, FIX);
    // fixture 的 TBC-001 是 (blocking) 且未解 → 出口必須報出來（brief 的斷言與 fixture 相矛盾，
    // 以 fixture 為準：未解的 blocking TBC 就是要擋住）
    expect(r.blockingTbc.map((t) => t.id)).toEqual(['TBC-001']);
    expect(r.ok).toBe(false);
  });

  it('spec.md 沒有驗收條件時必須報缺', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-spec-empty-'));
    try {
      fs.writeFileSync(path.join(dir, 'spec.md'), '# spec\n', 'utf-8');
      const r = specNode.exit({} as any, dir);
      expect(r.missingAc).toBe(true);
      expect(r.ok).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未答的問題必須被列出來', () => {
    const r = specNode.exit({} as any, FIX);
    expect(r.openQuestions.map((q) => q.id)).toEqual(['Q-001']);
    expect(r.ok).toBe(false);
  });

  it('使用者解掉的 TBC 不得再擋住出口', () => {
    const r = specNode.exit(
      {
        tbcItems: [
          {
            id: 'TBC-001',
            description: 'x',
            blocking: true,
            resolved: true,
            resolution: 'the default is M',
            createdAt: '',
          },
        ],
      } as any,
      FIX
    );
    expect(r.blockingTbc).toEqual([]);
  });

  it('worker 把 TBC 升級成 blocking 時不得被舊的狀態遮掉', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-spec-escalate-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'spec.md'),
        '## Acceptance Criteria\n\n### AC-001: x\n\n- [TBC-001] (blocking) escalated\n',
        'utf-8'
      );
      const r = specNode.exit(
        {
          tbcItems: [
            { id: 'TBC-001', description: 'old', blocking: false, resolved: false, createdAt: '' },
          ],
        } as any,
        dir
      );
      expect(r.blockingTbc.map((t) => t.id)).toEqual(['TBC-001']);
      expect(r.blockingTbc[0].blocking).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('worker 拿掉的 TBC 不得繼續擋住出口', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-spec-prune-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'spec.md'),
        '## Acceptance Criteria\n\n### AC-001: x\n',
        'utf-8'
      );
      const r = specNode.exit(
        {
          tbcItems: [
            { id: 'TBC-001', description: 'gone', blocking: true, resolved: false, createdAt: '' },
          ],
        } as any,
        dir
      );
      expect(r.blockingTbc).toEqual([]);
      expect(r.ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Spec 節點', () => {
  let dir: string;
  let repoDir: string;
  let docsDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-spec-'));
    repoDir = path.join(dir, 'repo');
    docsDir = path.join(repoDir, 'docs', 'demo');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'prd.md'), '# PRD', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The real spec node behind a fake bootstrap. */
  function specGraph(opts: { design?: 'url' | 'text' | 'none' } = {}): { g: any; cfg: any } {
    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(dir, 'cp.sqlite')),
      testNodes: {
        bootstrap: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: {
            bootstrapped: true,
            currentStage: 'spec',
            requirementName: 'demo',
            repoPath: repoDir,
            // The design decision the prd stage recorded. Without it the
            // spec stage keeps the old behaviour and asks.
            ...(opts.design !== undefined
              ? { stageSteps: { 'prd/design': opts.design } }
              : {}),
          },
          goto: 'spec',
        }),
      },
    });
    return { g, cfg: { configurable: { thread_id: 'thr-spec' } } };
  }

  /** The payload the run is parked on. */
  async function pending(g: any, cfg: any): Promise<any> {
    const snap: any = await g.getState(cfg);
    return snap.tasks[0].interrupts[0].value;
  }

  it('Figma P0 缺失時必須先問使用者', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('figma_missing');
    expect(payload.options).toEqual(['fetch', 'tbc', 'skip']);
  });

  it('使用者說了沒有設計時不得再問一次', async () => {
    const { g, cfg } = specGraph({ design: 'none' });
    await g.invoke({ requirementName: 'demo' }, cfg);

    // 設計的事在 collect_prd 就問過了：不得再問第二次。
    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('host');
    expect(payload.role).toBe('spec_writer');
  });

  it('設計是用文字描述時不得再問一次', async () => {
    const { g, cfg } = specGraph({ design: 'text' });
    await g.invoke({ requirementName: 'demo' }, cfg);

    const payload = await pending(g, cfg);
    expect(payload.role).toBe('spec_writer');
  });

  it('使用者給了 Figma 連結但抓不到檔案時照舊要問', async () => {
    const { g, cfg } = specGraph({ design: 'url' });
    await g.invoke({ requirementName: 'demo' }, cfg);

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('figma_missing');
  });

  it('spec 工作單必須讀設計說明與其他文件', async () => {
    fs.writeFileSync(path.join(docsDir, 'design.md'), '# 設計\n', 'utf-8');
    fs.mkdirSync(path.join(docsDir, 'refs'), { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'refs', 'api.md'), '# API\n', 'utf-8');

    const { g, cfg } = specGraph({ design: 'text' });
    await g.invoke({ requirementName: 'demo' }, cfg);

    const payload = await pending(g, cfg);
    expect(payload.role).toBe('spec_writer');
    expect(payload.inputs).toContain(path.join(docsDir, 'prd.md'));
    expect(payload.inputs).toContain(path.join(docsDir, 'design.md'));
    expect(payload.inputs).toContain(path.join(docsDir, 'refs', 'api.md'));
  });

  it('選了 fetch 但沒有 Figma 網址時不得發無用的工作單', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'fetch' } }), cfg);

    // 沒有網址就沒有東西可抓：下一個中斷必須是 spec_writer 的工作單。
    const payload = await pending(g, cfg);
    expect(payload.role).toBe('spec_writer');

    const snap: any = await g.getState(cfg);
    const tbcs = snap.values.tbcItems as Array<{ id: string; blocking: boolean }>;
    expect(tbcs.some((tbc) => tbc.id === 'TBC-FIGMA-NO-URL' && tbc.blocking === false)).toBe(true);
  });

  it('使用者選 skip 之後才發 spec_writer 工作單', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('host');
    expect(payload.role).toBe('spec_writer');
    expect(payload.outputs).toEqual([
      path.join(docsDir, 'discovery.md'),
      path.join(docsDir, 'spec.md'),
    ]);
    expect(payload.inputs).toContain(path.join(docsDir, 'prd.md'));
  });

  it('工作單回來後抽不到 AC 就再發一次', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    // 第一次工作單：spec.md 沒有驗收條件
    await g.invoke(
      new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }),
      cfg
    );
    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('host');
    expect(payload.role).toBe('spec_writer');
  });

  it('抽得到 AC 但有未答問題時必須問使用者', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    fs.writeFileSync(
      path.join(docsDir, 'spec.md'),
      '## Acceptance Criteria\n\n### AC-001: something\n\n- [Q-001] (pending) which one?\n',
      'utf-8'
    );
    await g.invoke(
      new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }),
      cfg
    );

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('spec_questions');
    expect(payload.questions.map((q: any) => q.id)).toEqual(['Q-001']);
  });

  it('使用者的答案必須寫回 spec.md', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    fs.writeFileSync(
      path.join(docsDir, 'spec.md'),
      '## Acceptance Criteria\n\n### AC-001: something\n\n- [Q-001] (pending) which one?\n',
      'utf-8'
    );
    await g.invoke(
      new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }),
      cfg
    );
    await g.invoke(new Command({ resume: { answers: { 'Q-001': 'the first one' } } }), cfg);

    const spec = fs.readFileSync(path.join(docsDir, 'spec.md'), 'utf-8');
    expect(spec).toContain('(answered)');
    expect(spec).toContain('the first one');
  });

  it('有未解的 blocking TBC 時不得離開 spec 階段', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    fs.writeFileSync(
      path.join(docsDir, 'spec.md'),
      '## Acceptance Criteria\n\n### AC-001: something\n\n- [TBC-001] (blocking) not decided yet\n',
      'utf-8'
    );
    await g.invoke(
      new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }),
      cfg
    );

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('tbc_blocking');
    expect(payload.resolutions.map((r: any) => r.id)).toEqual(['TBC-001']);
  });

  it('沒有驗收條件時使用者的答案必須變成 AC，缺 AC 不得前進', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    fs.writeFileSync(path.join(docsDir, 'spec.md'), '# spec\n', 'utf-8');
    await g.invoke(
      new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }),
      cfg
    );
    // 抽不到 AC：重發一次工作單
    expect((await pending(g, cfg)).role).toBe('spec_writer');
    await g.invoke(
      new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }),
      cfg
    );

    // 第二次還是沒有 AC：問使用者
    const payload = await pending(g, cfg);
    expect(payload.type).toBe('spec_questions');
    await g.invoke(new Command({ resume: { answer: 'the page shows a QR code' } }), cfg);

    // 使用者的答案必須變成驗收條件
    const spec = fs.readFileSync(path.join(docsDir, 'spec.md'), 'utf-8');
    expect(spec).toContain('### AC-001: the page shows a QR code');

    // 有 AC 之後才輪到確認
    expect((await pending(g, cfg)).type).toBe('confirm_spec');
  });

  it('blocking TBC 解掉之後必須能前進', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    fs.writeFileSync(
      path.join(docsDir, 'spec.md'),
      '## Acceptance Criteria\n\n### AC-001: something\n\n- [TBC-001] (blocking) not decided yet\n',
      'utf-8'
    );
    await g.invoke(
      new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }),
      cfg
    );

    expect((await pending(g, cfg)).type).toBe('tbc_blocking');
    await g.invoke(
      new Command({ resume: { resolutions: { 'TBC-001': 'the default is M' } } }),
      cfg
    );

    // 結論必須寫回 spec.md
    const spec = fs.readFileSync(path.join(docsDir, 'spec.md'), 'utf-8');
    expect(spec).toContain('(resolved: the default is M)');

    expect((await pending(g, cfg)).type).toBe('confirm_spec');
    await g.invoke(new Command({ resume: { approved: true } }), cfg);
    const snap: any = await g.getState(cfg);
    expect(snap.values.currentStage).toBe('e2ePlan');
  });

  it('澄清三輪之後未答的問題要轉成 TBC', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    fs.writeFileSync(
      path.join(docsDir, 'spec.md'),
      '## Acceptance Criteria\n\n### AC-001: something\n\n- [Q-001] (pending) which one?\n',
      'utf-8'
    );
    await g.invoke(
      new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }),
      cfg
    );

    // 三輪：每輪使用者都沒有回答
    for (let round = 0; round < 3; round += 1) {
      expect((await pending(g, cfg)).type).toBe('spec_questions');
      await g.invoke(new Command({ resume: { answers: {} } }), cfg);
    }

    // 三輪之後未答的問題變成 blocking TBC
    expect((await pending(g, cfg)).type).toBe('tbc_blocking');
    const spec = fs.readFileSync(path.join(docsDir, 'spec.md'), 'utf-8');
    expect(spec).toContain('- [TBC-001] (blocking)');
  });

  it('worker 回 needs_human 時問題要變成使用者的閘門', async () => {
    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(dir, 'cp-question.sqlite')),
      testNodes: {
        bootstrap: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: {
            bootstrapped: true,
            currentStage: 'spec',
            requirementName: 'demo',
            repoPath: repoDir,
            // PRD 階段留下來的 Figma 網址
            stageSteps: { 'prd/figma-url': 'https://www.figma.com/design/abc' },
          },
          goto: 'spec',
        }),
      },
    });
    const cfg = { configurable: { thread_id: 'thr-spec-question' } };

    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'fetch' } }), cfg);
    await g.invoke(
      new Command({
        resume: {
          status: 'needs_human',
          summary: 'blocked',
          changedFiles: [],
          interrupt: { type: 'figma_permission', question: 'may I read the file?', options: ['yes'] },
        },
      }),
      cfg
    );

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('figma_needs_human');
    expect(payload.question).toBe('may I read the file?');
  });

  it('缺驗收條件時使用者的答案（answers map）必須真的變成 AC', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    fs.writeFileSync(path.join(docsDir, 'spec.md'), '# spec\n', 'utf-8');
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    // 閘門問的是合成問題 Q-NEW
    const payload = await pending(g, cfg);
    expect(payload.type).toBe('spec_questions');
    expect(payload.questions.map((q: any) => q.id)).toContain('Q-NEW');

    // 生產的答案形狀：answers map
    await g.invoke(
      new Command({ resume: { answers: { 'Q-NEW': 'the page shows a QR code' } } }),
      cfg
    );

    const spec = fs.readFileSync(path.join(docsDir, 'spec.md'), 'utf-8');
    expect(spec).toContain('### AC-001: the page shows a QR code');
    expect(spec).not.toContain('no answer given');
  });

  it('缺驗收條件時問題的答案不得被丟掉', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    fs.writeFileSync(
      path.join(docsDir, 'spec.md'),
      '# spec\n\n- [Q-001] (pending) which one?\n',
      'utf-8'
    );
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    const payload = await pending(g, cfg);
    const ids = payload.questions.map((q: any) => q.id);
    expect(ids).toContain('Q-001');
    expect(ids).toContain('Q-NEW');

    await g.invoke(
      new Command({
        resume: { answers: { 'Q-001': 'the first one', 'Q-NEW': 'the page shows a QR code' } },
      }),
      cfg
    );

    const spec = fs.readFileSync(path.join(docsDir, 'spec.md'), 'utf-8');
    // 問題的答案落在問題上
    expect(spec).toContain('- [Q-001] (answered) which one? — the first one');
    // 驗收條件也在
    expect(spec).toContain('### AC-001: the page shows a QR code');
  });

  it('spec.md 讀不到時必須走重發工作單的路徑，不得直接炸掉', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    // 壞掉的文件：一個目錄，不是空檔案
    fs.mkdirSync(path.join(docsDir, 'spec.md'), { recursive: true });
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    // 讀不到就重發一次工作單
    expect((await pending(g, cfg)).role).toBe('spec_writer');
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('spec_failed');
    expect(payload.reason).toBe('unreadable_spec');
  });

  it('spec_failed 的閘門要有放棄的出路', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    fs.mkdirSync(path.join(docsDir, 'spec.md'), { recursive: true });
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    const payload = await pending(g, cfg);
    expect(payload.options).toContain('abort');

    await g.invoke(new Command({ resume: { action: 'abort' } }), cfg);
    const snap: any = await g.getState(cfg);
    // 放棄不是成功：run 的結束必須帶著 blocker
    expect((snap.values.blockers as unknown[]).length).toBeGreaterThan(0);
    expect(snap.values.currentStage).toBe('completed');
  });

  it('工人沒做完的 TBC 不得阻擋流程（它只是紀錄）', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    await g.invoke(
      new Command({ resume: { status: 'failed', summary: 'boom', changedFiles: [] } }),
      cfg
    );

    const snap: any = await g.getState(cfg);
    const tbcs = snap.values.tbcItems as Array<{ id: string; blocking: boolean }>;
    const failed = tbcs.find((tbc) => tbc.id === 'TBC-SPEC-ORDER');
    expect(failed).toBeDefined();
    expect(failed?.blocking).toBe(false);
  });

  it('spec 工作單的 needs_human 問題必須變成使用者閘門', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    await g.invoke(
      new Command({
        resume: {
          status: 'needs_human',
          summary: 'blocked',
          changedFiles: [],
          interrupt: { type: 'scope', question: 'may I decide this?', options: ['yes', 'no'] },
        },
      }),
      cfg
    );

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('worker_needs_human');
    expect(payload.question).toBe('may I decide this?');
    expect(payload.options).toEqual(['yes', 'no']);
  });

  it('全部通過後問使用者確認，確認後前進到 e2ePlan', async () => {
    const { g, cfg } = specGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    fs.writeFileSync(
      path.join(docsDir, 'spec.md'),
      '## Acceptance Criteria\n\n### AC-001: something\n',
      'utf-8'
    );
    await g.invoke(
      new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }),
      cfg
    );

    expect(await pending(g, cfg)).toEqual({ audience: 'user', type: 'confirm_spec' });

    await g.invoke(new Command({ resume: { approved: true } }), cfg);
    const snap: any = await g.getState(cfg);
    expect(snap.values.currentStage).toBe('e2ePlan');
  });
});
