import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from '@langchain/langgraph';
import { buildGraph } from '../src/graph/compile.js';
import type { NodeOutcome } from '../src/graph/state.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import { e2eNode } from '../src/nodes/e2e-plan.js';
import { buildTraceabilityMatrix, taskSplitNode } from '../src/nodes/task-split.js';
import { parseE2eRows, parseTasks } from '../src/parsers/ids.js';

const FIX = path.join(import.meta.dirname, 'fixtures', 'qrcode-app');


/**
 * A `tasks.md` with one task of the given complexity and acceptance criteria.
 */
function tasksMd(complexity: string, criteria: number): string {
  const acs = Array.from({ length: criteria }, (_, i) => `- 條件 ${i + 1}`).join('\n');
  return [
    '# Tasks: demo',
    '',
    '## Task List',
    '',
    '| Task ID | Title | Complexity | Priority | AC Refs |',
    '|---------|-------|------------|----------|---------|',
    `| TASK-huge-thing | Huge thing | ${complexity} | high | AC-001 |`,
    '',
    '## Task Details',
    '',
    '### TASK-huge-thing: Huge thing',
    '',
    '**Description**: 一個行為。',
    '',
    '**Acceptance Criteria**:',
    acs,
    '',
    '**AC Refs**: AC-001',
    '',
    '**Files**:',
    '- `src/thing.ts`',
    '',
  ].join('\n');
}

describe('TaskSplit 出口', () => {
  it('範例計畫裡不得有不合法的 L 級 task', () => {
    const r = taskSplitNode.exit({} as any, FIX);
    expect(r.invalidComplexTasks).toEqual([]);
  });

  it('TASK id 不得重複', () => {
    const r = taskSplitNode.exit({} as any, FIX);
    expect(r.duplicateIds).toEqual([]);
  });

  it('每個 AC 至少被一個 task 引用', () => {
    const r = taskSplitNode.exit({} as any, FIX);
    expect(r.orphanAcs).toEqual([]);
  });

  it('task id 必須由標題派生', () => {
    const r = taskSplitNode.exit({} as any, FIX);
    expect(r.slugDrift).toEqual([]);
  });

  it('L 級 task 有三條以上驗收條件時可以通過', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-tasks-l-'));
    try {
      fs.copyFileSync(path.join(FIX, 'spec.md'), path.join(dir, 'spec.md'));
      fs.writeFileSync(path.join(dir, 'tasks.md'), tasksMd('L', 3), 'utf-8');
      const r = taskSplitNode.exit({} as any, dir);
      expect(r.invalidComplexTasks).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.tasks.map((task) => task.complexity)).toEqual(['L']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('L 級 task 只有一兩條驗收條件時被退件（那是還沒拆開的 M）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-tasks-l-'));
    try {
      fs.copyFileSync(path.join(FIX, 'spec.md'), path.join(dir, 'spec.md'));
      fs.writeFileSync(path.join(dir, 'tasks.md'), tasksMd('L', 2), 'utf-8');
      const r = taskSplitNode.exit({} as any, dir);
      expect(r.invalidComplexTasks).toEqual(['TASK-huge-thing']);
      expect(r.ok).toBe(false);
      expect(r.tasks).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('重複的 task id 必須被報出來', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-tasks-dup-'));
    try {
      fs.copyFileSync(path.join(FIX, 'spec.md'), path.join(dir, 'spec.md'));
      fs.writeFileSync(
        path.join(dir, 'tasks.md'),
        [
          '| Task ID | Title | Complexity | Priority | AC Refs |',
          '|---------|-------|------------|----------|---------|',
          '| TASK-setup-qrcode-page-route | Setup QR code page route | S | high | AC-001 |',
          '| TASK-setup-qrcode-page-route | Setup QR code page route | S | high | AC-002 |',
          '',
        ].join('\n'),
        'utf-8'
      );
      const r = taskSplitNode.exit({} as any, dir);
      expect(r.duplicateIds).toEqual(['TASK-setup-qrcode-page-route']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('traceability 矩陣雙向無孤兒', () => {
    const tasks = parseTasks(fs.readFileSync(path.join(FIX, 'tasks.md'), 'utf-8'));
    const e2e = parseE2eRows(fs.readFileSync(path.join(FIX, 'e2e-plan.csv'), 'utf-8'));
    const m = buildTraceabilityMatrix(
      ['AC-001', 'AC-002', 'AC-003', 'AC-004', 'AC-005'],
      tasks,
      e2e
    );
    expect(m.orphanTasks).toEqual([]);
    expect(m.orphanTests).toEqual([]);
    expect(m.rows.length).toBe(5);
  });

  it('traceability 矩陣要指出沒有 AC 的 task 與 test', () => {
    const tasks = parseTasks(fs.readFileSync(path.join(FIX, 'tasks.md'), 'utf-8'));
    const e2e = parseE2eRows(fs.readFileSync(path.join(FIX, 'e2e-plan.csv'), 'utf-8'));
    const m = buildTraceabilityMatrix(['AC-001'], tasks, e2e);
    expect(m.orphanTasks.length).toBeGreaterThan(0);
    expect(m.orphanTests.length).toBeGreaterThan(0);
    expect(m.rows.length).toBe(1);
    expect(m.rows[0].taskIds).toContain('TASK-setup-qrcode-page-route');
  });
});

describe('E2E 節點', () => {
  let dir: string;
  let repoDir: string;
  let docsDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-e2e-'));
    repoDir = path.join(dir, 'repo');
    docsDir = path.join(repoDir, 'docs', 'demo');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.copyFileSync(path.join(FIX, 'spec.md'), path.join(docsDir, 'spec.md'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The real e2e node behind a fake bootstrap. */
  function e2eGraph(): { g: any; cfg: any } {
    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(dir, 'cp.sqlite')),
      testNodes: {
        bootstrap: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: {
            bootstrapped: true,
            currentStage: 'e2ePlan',
            requirementName: 'demo',
            repoPath: repoDir,
          },
          goto: 'e2e_plan',
        }),
      },
    });
    return { g, cfg: { configurable: { thread_id: 'thr-e2e' } } };
  }

  async function pending(g: any, cfg: any): Promise<any> {
    const snap: any = await g.getState(cfg);
    return snap.tasks[0].interrupts[0].value;
  }

  it('必須發 e2e_planner 工作單，產出 e2e-plan.csv', async () => {
    const { g, cfg } = e2eGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('host');
    expect(payload.role).toBe('e2e_planner');
    expect(payload.outputs).toEqual([path.join(docsDir, 'e2e-plan.csv')]);
    expect(payload.inputs).toContain(path.join(docsDir, 'spec.md'));
  });

  it('計畫沒有測試案例時再發一次', async () => {
    const { g, cfg } = e2eGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    const payload = await pending(g, cfg);
    expect(payload.role).toBe('e2e_planner');
  });

  it('第二次還是沒有測試案例時必須問使用者', async () => {
    const { g, cfg } = e2eGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('e2e_plan_failed');
    expect(payload.reason).toBe('no_test_ids');
  });

  it('確認後前進到 taskSplit 階段', async () => {
    const { g, cfg } = e2eGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    fs.copyFileSync(path.join(FIX, 'e2e-plan.csv'), path.join(docsDir, 'e2e-plan.csv'));
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    expect(await pending(g, cfg)).toEqual({ audience: 'user', type: 'confirm_e2e' });

    await g.invoke(new Command({ resume: { approved: true } }), cfg);
    const snap: any = await g.getState(cfg);
    expect(snap.values.currentStage).toBe('taskSplit');
  });
});

describe('TaskSplit 節點', () => {
  let dir: string;
  let repoDir: string;
  let docsDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-tasks-'));
    repoDir = path.join(dir, 'repo');
    docsDir = path.join(repoDir, 'docs', 'demo');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.copyFileSync(path.join(FIX, 'spec.md'), path.join(docsDir, 'spec.md'));
    fs.copyFileSync(path.join(FIX, 'e2e-plan.csv'), path.join(docsDir, 'e2e-plan.csv'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The real task-split node behind a fake bootstrap. */
  function splitGraph(): { g: any; cfg: any } {
    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(dir, 'cp.sqlite')),
      testNodes: {
        bootstrap: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: {
            bootstrapped: true,
            currentStage: 'taskSplit',
            requirementName: 'demo',
            repoPath: repoDir,
          },
          goto: 'task_split',
        }),
      },
    });
    return { g, cfg: { configurable: { thread_id: 'thr-tasks' } } };
  }

  async function pending(g: any, cfg: any): Promise<any> {
    const snap: any = await g.getState(cfg);
    return snap.tasks[0].interrupts[0].value;
  }

  it('必須發 task_splitter 工作單，產出 tasks.md', async () => {
    const { g, cfg } = splitGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('host');
    expect(payload.role).toBe('task_splitter');
    expect(payload.outputs).toEqual([path.join(docsDir, 'tasks.md')]);
    expect(payload.inputs).toContain(path.join(docsDir, 'spec.md'));
    expect(payload.inputs).toContain(path.join(docsDir, 'e2e-plan.csv'));
  });

  it('L 級 task 看起來不像單一行為時再發一次，並在 prompt 裡說清楚規則', async () => {
    const { g, cfg } = splitGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    fs.writeFileSync(
      path.join(docsDir, 'tasks.md'),
      [
        '| Task ID | Title | Complexity | Priority | AC Refs |',
        '|---------|-------|------------|----------|---------|',
        '| TASK-huge-thing | Huge thing | L | high | AC-001 |',
        '',
      ].join('\n'),
      'utf-8'
    );
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    const payload = await pending(g, cfg);
    expect(payload.role).toBe('task_splitter');
    // L 本身不是問題：不夠多驗收條件才是。
    expect(payload.prompt).toMatch(/at least 3 acceptance criteria/);
  });

  it('第二次還是有 L 級任務時必須問使用者', async () => {
    const { g, cfg } = splitGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    fs.writeFileSync(
      path.join(docsDir, 'tasks.md'),
      [
        '| Task ID | Title | Complexity | Priority | AC Refs |',
        '|---------|-------|------------|----------|---------|',
        '| TASK-huge-thing | Huge thing | L | high | AC-001 |',
        '',
      ].join('\n'),
      'utf-8'
    );
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('task_split_failed');
    expect(payload.reason).toBe('complexity_L');
  });

  it('重複的 task id 必須重發一次工作單，然後擋下來', async () => {
    const { g, cfg } = splitGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    fs.writeFileSync(
      path.join(docsDir, 'tasks.md'),
      [
        '| Task ID | Title | Complexity | Priority | AC Refs |',
        '|---------|-------|------------|----------|---------|',
        '| TASK-setup-qrcode-page-route | Setup QR code page route | S | high | AC-001 |',
        '| TASK-setup-qrcode-page-route | Setup QR code page route | S | high | AC-002 |',
        '',
      ].join('\n'),
      'utf-8'
    );
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    // 重複的 id：重發一次工作單
    const payload = await pending(g, cfg);
    expect(payload.role).toBe('task_splitter');

    // 第二次還是有重複：擋下來
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);
    const failed = await pending(g, cfg);
    expect(failed.audience).toBe('user');
    expect(failed.type).toBe('task_split_failed');
    expect(failed.reason).toBe('duplicate_ids');
  });

  it('空的 tasks.md 必須被拒絕，不得直接確認', async () => {
    const { g, cfg } = splitGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    fs.writeFileSync(path.join(docsDir, 'tasks.md'), '', 'utf-8');
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    // 空計畫：重發一次工作單
    expect((await pending(g, cfg)).role).toBe('task_splitter');

    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);
    const failed = await pending(g, cfg);
    expect(failed.audience).toBe('user');
    expect(failed.type).toBe('task_split_failed');
  });

  it('有表頭但沒有資料的 tasks.md 必須被拒絕', async () => {
    const { g, cfg } = splitGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    // 有效的表格、零筆資料：parseTasks 不會丟錯，守門靠的是 parsed.length > 0
    fs.writeFileSync(
      path.join(docsDir, 'tasks.md'),
      [
        '| Task ID | Title | Complexity | Priority | AC Refs |',
        '|---------|-------|------------|----------|---------|',
        '',
      ].join('\n'),
      'utf-8'
    );
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    // 空計畫：重發一次工作單
    expect((await pending(g, cfg)).role).toBe('task_splitter');
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    const failed = await pending(g, cfg);
    expect(failed.audience).toBe('user');
    expect(failed.type).toBe('task_split_failed');
  });

  it('spec.md 讀不到時 task split 必須走重發工作單的路徑，不得炸掉', async () => {
    const { g, cfg } = splitGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    // 壞掉的文件：一個目錄
    fs.rmSync(path.join(docsDir, 'spec.md'), { force: true });
    fs.mkdirSync(path.join(docsDir, 'spec.md'), { recursive: true });

    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);
    expect((await pending(g, cfg)).role).toBe('task_splitter');
  });

  it('worker 回 needs_human 時問題要問到使用者', async () => {
    const { g, cfg } = splitGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(
      new Command({
        resume: {
          status: 'needs_human',
          summary: 'blocked',
          changedFiles: [],
          interrupt: { type: 'scope', question: 'may I split it like this?', options: ['yes', 'no'] },
        },
      }),
      cfg
    );

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('worker_needs_human');
    expect(payload.question).toBe('may I split it like this?');
    expect(payload.options).toEqual(['yes', 'no']);

    // 問題也要留在 TBC 裡，使用者看得到
    const snap: any = await g.getState(cfg);
    const tbcs = snap.values.tbcItems as Array<{ id: string; blocking: boolean }>;
    expect(tbcs.some((tbc) => tbc.id === 'TBC-TASKS-ORDER' && tbc.blocking === false)).toBe(true);
  });

  it('孤兒 AC 不得擋住推進，但必須記成 TBC 並標在 timeline', async () => {
    const { g, cfg } = splitGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    fs.writeFileSync(
      path.join(docsDir, 'tasks.md'),
      [
        '| Task ID | Title | Complexity | Priority | AC Refs |',
        '|---------|-------|------------|----------|---------|',
        '| TASK-setup-qrcode-page-route | Setup QR code page route | S | high | AC-001 |',
        '',
      ].join('\n'),
      'utf-8'
    );
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    const snap: any = await g.getState(cfg);
    const tbcs = snap.values.tbcItems as Array<{ id: string; blocking: boolean }>;
    expect(tbcs.some((tbc) => tbc.id.includes('ORPHAN') && tbc.blocking === false)).toBe(true);
    const timeline = fs.readFileSync(path.join(docsDir, 'timeline.md'), 'utf-8');
    expect(timeline).toContain('AC-002');

    // 不得擋住推進：下一個中斷是確認。
    expect(await pending(g, cfg)).toEqual({ audience: 'user', type: 'confirm_tasks' });
  });

  it('確認後前進到 tdd 階段，task 進到狀態', async () => {
    const { g, cfg } = splitGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    fs.copyFileSync(path.join(FIX, 'tasks.md'), path.join(docsDir, 'tasks.md'));
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'x', changedFiles: [] } }), cfg);

    expect(await pending(g, cfg)).toEqual({ audience: 'user', type: 'confirm_tasks' });

    await g.invoke(new Command({ resume: { approved: true } }), cfg);
    const snap: any = await g.getState(cfg);
    expect(snap.values.currentStage).toBe('tdd');
    const tasks = snap.values.tasks as Array<{ id: string; complexity: string }>;
    expect(tasks.length).toBe(7);
    expect(tasks.every((task) => task.complexity !== 'L')).toBe(true);
  });
});
