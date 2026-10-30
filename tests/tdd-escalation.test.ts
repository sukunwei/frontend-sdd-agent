import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from '@langchain/langgraph';
import { escalate } from '../src/nodes/review.js';
import { buildGraph } from '../src/graph/compile.js';
import type { NodeOutcome } from '../src/graph/state.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import type { Task } from '../src/state/types.js';

const FIX = join(import.meta.dirname, 'fixtures', 'qrcode-app');

const TASK_A: Task = {
  id: 'TASK-setup-qrcode-page-route',
  title: 'Setup QR code page route',
  acceptanceCriteria: ['路由 `/qrcode-app` 存在且可渲染'],
  acRefs: ['AC-001'],
  complexity: 'S',
  priority: 'high',
};

const TASK_B: Task = {
  id: 'TASK-create-qrcode-input',
  title: 'Create QR code input',
  acceptanceCriteria: ['輸入框為受控元件'],
  acRefs: ['AC-001'],
  complexity: 'M',
  priority: 'high',
};

describe('TDD 失敗升級', () => {
  it('第一次失敗回 developer 工作單', () => {
    expect(escalate({ tddAttempts: 1 } as any, { id: 'TASK-x' } as any, 1).kind).toBe(
      'retry_developer'
    );
  });

  it('第二次失敗改成 rollback 中斷', () => {
    const r = escalate({ tddAttempts: 2 } as any, { id: 'TASK-x' } as any, 2);
    expect(r.kind).toBe('rollback');
    expect((r as any).interrupt.type).toBe('tdd_rollback');
  });

  it('第三次失敗寫 blocker 並問使用者', () => {
    const r = escalate({ tddAttempts: 3 } as any, { id: 'TASK-x' } as any, 3);
    expect(r.kind).toBe('blocked');
    expect((r as any).interrupt.type).toBe('tdd_blocked');
    expect((r as any).interrupt.options).toEqual(['wait', 'skip', 'abort']);
  });
});

describe('TDD 失敗升級（圖側）', () => {
  let dir: string;
  let repoDir: string;
  let docsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdd-esc-'));
    repoDir = join(dir, 'repo');
    docsDir = join(repoDir, 'docs', 'demo');
    mkdirSync(docsDir, { recursive: true });
    copyFileSync(join(FIX, 'tasks.md'), join(docsDir, 'tasks.md'));
    copyFileSync(join(FIX, 'spec.md'), join(docsDir, 'spec.md'));
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repoDir });
    execSync('git add -A && git commit -qm init', { cwd: repoDir });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function tddGraph(opts: { repo?: string; tasks?: Task[]; thread?: string } = {}): { g: any; cfg: any } {
    const g = buildGraph({
      checkpointer: createCheckpointer(join(dir, `cp-${opts.thread ?? 'esc'}.sqlite`)),
      testNodes: {
        bootstrap: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: {
            bootstrapped: true,
            currentStage: 'tdd',
            requirementName: 'demo',
            repoPath: opts.repo ?? repoDir,
            tasks: opts.tasks ?? [TASK_A],
            currentTaskIndex: 0,
          },
          goto: 'tdd',
        }),
        verify: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: { currentStage: 'completed' },
          goto: 'completed',
        }),
      },
    });
    return { g, cfg: { configurable: { thread_id: opts.thread ?? 'thr-esc' } } };
  }

  async function pending(g: any, cfg: any): Promise<any> {
    const snap: any = await g.getState(cfg);
    return snap.tasks[0].interrupts[0].value;
  }

  async function values(g: any, cfg: any): Promise<any> {
    const snap: any = await g.getState(cfg);
    return snap.values;
  }

  /**
   * The worker implements the task and commits it.
   *
   * **Every file of the order has to exist**: the work order names the
   * implementation files *and* the test file of the task, and the graph
   * checks them itself (the CLI does the same).
   *
   * @param target - The directory the worker writes into (the repository of
   *   the run, or a plain directory without a repository).
   */
  function developerWorks(target: string = repoDir): void {
    const dir = join(target, 'src', 'app', 'page', 'qrcode-app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'page.tsx'), 'export default function Page() { return null; }\n', 'utf-8');
    writeFileSync(join(dir, 'page.module.css'), '.page {}\n', 'utf-8');
    const test = join(target, 'src', '__tests__', 'setup-qrcode-page-route.test.ts');
    mkdirSync(join(test, '..'), { recursive: true });
    writeFileSync(test, "it('renders', () => {});\n", 'utf-8');
    if (existsSync(join(target, '.git'))) {
      execSync('git add -A && git commit -q --allow-empty -m work', { cwd: target });
    }
  }

  /** The developer reports the task as done. */
  async function developerDone(g: any, cfg: any): Promise<void> {
    await g.invoke(
      new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }),
      cfg
    );
  }

  /**
   * The reviewer rejects the work.
   *
   * The reviewer answers two questions in one order: the spec verdict fails
   * (the task was not done), the quality verdict passes (what was written is
   * not the problem).
   */
  async function specFails(g: any, cfg: any): Promise<void> {
    await g.invoke(
      new Command({
        resume: {
          status: 'ok',
          summary: '',
          changedFiles: [],
          reviews: [
            {
              role: 'spec',
              verdict: 'fail',
              issues: [
                { file: 'src/app/page/qrcode-app/page.tsx', message: '沒有實作', severity: 'critical' },
              ],
            },
            { role: 'quality', verdict: 'pass', issues: [] },
          ],
        },
      }),
      cfg
    );
  }

  it('第一次失敗要把評審帶回 developer 工作單', async () => {
    const { g, cfg } = tddGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);

    const payload = await pending(g, cfg);
    expect(payload.role).toBe('developer');
    // 評審的內容要跟著回到 developer 工作單裡
    expect(payload.prompt).toContain('上一次評審的結果');
    expect(payload.prompt).toContain('沒有實作');

    const state = await values(g, cfg);
    expect(state.tddAttempts).toBe(1);
  });

  it('兩份結論都要回到 developer 工作單裡（spec 的不會被 quality 蓋掉）', async () => {
    const { g, cfg } = tddGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerWorks();
    await developerDone(g, cfg);

    // 兩個問題都有結論，而且都不通過
    await g.invoke(
      new Command({
        resume: {
          status: 'ok',
          summary: '',
          changedFiles: [],
          reviews: [
            {
              role: 'spec',
              verdict: 'fail',
              issues: [
                { file: 'src/app/page/qrcode-app/page.tsx', message: '驗收條件沒做到', severity: 'critical' },
              ],
            },
            {
              role: 'quality',
              verdict: 'fail',
              issues: [
                { file: 'src/app/page/qrcode-app/page.tsx', message: '壞掉的 pattern', severity: 'high' },
              ],
            },
          ],
        },
      }),
      cfg
    );

    const payload = await pending(g, cfg);
    expect(payload.role).toBe('developer');
    expect(payload.prompt).toContain('驗收條件沒做到');
    expect(payload.prompt).toContain('壞掉的 pattern');
  });

  it('第二次失敗要 rollback 並問使用者', async () => {
    const { g, cfg } = tddGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);
    // 第二次：developer 又做一次，評審又失敗
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('tdd_rollback');
    expect(payload.options).toEqual(['wait', 'skip', 'abort']);

    // rollback：task 起的標籤之後的 commit 都不見了
    const file = join(repoDir, 'src', 'app', 'page', 'qrcode-app', 'page.tsx');
    expect(existsSync(file)).toBe(false);

    const state = await values(g, cfg);
    expect(state.tddAttempts).toBe(2);
  });

  it('第三次失敗要寫 blocker 並問使用者', async () => {
    const { g, cfg } = tddGraph();
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);
    // 使用者說「再試一次」，developer 又做一次，評審又失敗
    await g.invoke(new Command({ resume: { action: 'wait' } }), cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('tdd_blocked');
    expect(payload.options).toEqual(['wait', 'skip', 'abort']);

    const state = await values(g, cfg);
    expect((state.blockers as unknown[]).length).toBeGreaterThan(0);
  });

  it('工作區不是 git repo 時，rollback 不得讓 run 炸掉（要問使用者）', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain, { recursive: true });
    const { g, cfg } = tddGraph({ repo: plain, thread: 'thr-plain-esc' });
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerWorks(plain);
    await developerDone(g, cfg);
    await specFails(g, cfg);
    developerWorks(plain);
    await developerDone(g, cfg);
    await specFails(g, cfg);

    // 沒有 repository 就没有標籤可 rollback —— 但使用者還是要被問。
    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('tdd_rollback');
    expect(payload.options).toEqual(['wait', 'skip', 'abort']);
    expect((await values(g, cfg)).tddAttempts).toBe(2);
  });

  it('skip：這個 task 被放棄，索引只往前一格', async () => {
    const { g, cfg } = tddGraph({ tasks: [TASK_A, TASK_B], thread: 'thr-skip' });
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);

    // 使用者放棄這個 task
    await g.invoke(new Command({ resume: { action: 'skip' } }), cfg);

    // 下一個 task 的 developer 工作單（不是跳過 task，也不是停在原地）
    const payload = await pending(g, cfg);
    expect(payload.role).toBe('developer');
    const state = await values(g, cfg);
    expect(state.currentTaskIndex).toBe(1);
    expect(state.tddSubStage).toBe('pending');
  });

  it('abort：run 結束，blocker 留著，階段是 completed', async () => {
    const { g, cfg } = tddGraph({ thread: 'thr-abort' });
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);

    await g.invoke(new Command({ resume: { action: 'abort' } }), cfg);

    const state = await values(g, cfg);
    expect(state.currentStage).toBe('completed');
    expect((state.blockers as unknown[]).length).toBe(1);
  });

  it('使用者回答了看不懂的形狀：答案要留下來，閘門要帶著診斷再問一次', async () => {
    const { g, cfg } = tddGraph({ thread: 'thr-unparsed' });
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);

    // 使用者回答了一個圖看不懂的形狀（沒有任何已知的欄位）
    await g.invoke(new Command({ resume: { foo: 'bar' } }), cfg);

    // 閘門被再問一次，而且帶著上一次答案的診斷
    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('tdd_rollback');
    expect(payload.previousAnswer).toContain('foo');
    expect(payload.note).toContain('could not be read');

    // 這一次用看得懂的形狀回答 → 閘門收下
    await g.invoke(new Command({ resume: { action: 'wait' } }), cfg);
    const state = await values(g, cfg);
    expect(state.tddSubStage).toBe('pending');
  });

  it('wait 之後那個 blocker 要被收掉（task 還在跑）', async () => {
    const { g, cfg } = tddGraph({ thread: 'thr-stale' });
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);
    await g.invoke(new Command({ resume: { action: 'wait' } }), cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);

    // 第三次失敗 → blocker
    expect((await values(g, cfg)).blockers.length).toBeGreaterThan(0);

    // 使用者說再試一次 → blocker 收掉
    await g.invoke(new Command({ resume: { action: 'wait' } }), cfg);
    expect((await values(g, cfg)).blockers).toHaveLength(0);
  });

  it('評審結果不是合法 JSON 時第一次重發同一張單、第二次升級', async () => {
    const { g, cfg } = tddGraph({ thread: 'thr-invalid' });
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerWorks();
    await developerDone(g, cfg);

    // 第一次：散文 PASS —— 不算失敗，重發同一張單
    await g.invoke(
      new Command({ resume: { status: 'ok', summary: 'PASS', changedFiles: [] } }),
      cfg
    );
    let payload = await pending(g, cfg);
    expect(payload.role).toBe('reviewer');
    expect((await values(g, cfg)).tddAttempts).toBe(0);

    // 第二次：還是非法 JSON —— 升級
    await g.invoke(
      new Command({ resume: { status: 'ok', summary: 'PASS', changedFiles: [] } }),
      cfg
    );
    payload = await pending(g, cfg);
    expect(payload.role).toBe('developer');
    expect((await values(g, cfg)).tddAttempts).toBe(1);
  });

  it('評審一直說「沒做完」時不能無限重發：第一次重發、第二次升級', async () => {
    const { g, cfg } = tddGraph({ thread: 'thr-unfinished' });
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerWorks();
    await developerDone(g, cfg);

    // 第一次：評審者說自己沒做完 —— 同一張單再發一次（不算失敗）
    await g.invoke(
      new Command({ resume: { status: 'failed', summary: '沒時間了', changedFiles: [] } }),
      cfg
    );
    let payload = await pending(g, cfg);
    expect(payload.role).toBe('reviewer');
    expect((await values(g, cfg)).tddAttempts).toBe(0);

    // 第二次：還是沒做完 —— 升級，不能再無限發下去
    await g.invoke(
      new Command({ resume: { status: 'failed', summary: '沒時間了', changedFiles: [] } }),
      cfg
    );
    payload = await pending(g, cfg);
    expect(payload.role).toBe('developer');
    expect((await values(g, cfg)).tddAttempts).toBe(1);
  });

  it('rollback 閘門要說明程式碼到底有沒有被還原', async () => {
    const { g, cfg } = tddGraph({ thread: 'thr-rollback-outcome' });
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);
    developerWorks();
    await developerDone(g, cfg);
    await specFails(g, cfg);

    // 這一次是真的 rollback 成功了（tag 在、repository 在）
    const payload = await pending(g, cfg);
    expect(payload.type).toBe('tdd_rollback');
    expect(payload.rollback).toBe('done');
  });

  it('沒有 repository 時 rollback 要說「跳過了」，不能假裝還原過', async () => {
    const plain = join(dir, 'plain-outcome');
    mkdirSync(plain, { recursive: true });
    const { g, cfg } = tddGraph({ repo: plain, thread: 'thr-rollback-skipped' });
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerWorks(plain);
    await developerDone(g, cfg);
    await specFails(g, cfg);
    developerWorks(plain);
    await developerDone(g, cfg);
    await specFails(g, cfg);

    // 壞掉的程式碼還在磁碟上 —— 使用者必須知道這件事
    const payload = await pending(g, cfg);
    expect(payload.type).toBe('tdd_rollback');
    expect(payload.rollback).toBe('skipped');
  });

  it('developer 問的問題用 action 回答時不得被丟掉', async () => {
    const { g, cfg } = tddGraph({ thread: 'thr-dev-question' });
    await g.invoke({ requirementName: 'demo' }, cfg);

    // developer 卡住了，問使用者一個問題
    await g.invoke(
      new Command({
        resume: {
          status: 'needs_human',
          summary: '',
          changedFiles: [],
          interrupt: { type: 'needs_human', question: '要沿用既有的按鈕嗎？' },
        },
      }),
      cfg
    );

    // 圖把問題問出來了
    const asked = await pending(g, cfg);
    expect(asked.audience).toBe('user');
    expect(asked.question).toContain('沿用既有的按鈕');

    // 使用者用 `{action: ...}` 回答 —— 每一個閘門都用的那個形狀
    await g.invoke(new Command({ resume: { action: '沿用既有的按鈕' } }), cfg);

    // 答案要進到下一張 developer 工作單裡（而且不是「再問一次」）
    const order = await pending(g, cfg);
    expect(order.role).toBe('developer');
    expect(order.prompt).toContain('沿用既有的按鈕');
  });
});
