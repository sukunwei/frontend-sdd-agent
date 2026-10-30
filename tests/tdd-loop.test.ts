import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from '@langchain/langgraph';
import { resetToTaskStart, tagTaskStart } from '../src/runtime/git-tags.js';
import { buildGraph } from '../src/graph/compile.js';
import type { NodeOutcome } from '../src/graph/state.js';
import { developerWorkOrder, readDeveloperResult, recordDeveloperReport } from '../src/nodes/tdd.js';
import { reviewWorkOrder } from '../src/nodes/review.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import type { Task } from '../src/state/types.js';

const FIX = join(import.meta.dirname, 'fixtures', 'qrcode-app');

const TASK_A: Task = {
  id: 'TASK-setup-qrcode-page-route',
  title: 'Setup QR code page route',
  description: '建立 `/qrcode-app` 頁面路由',
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

describe('TDD 迴圈與 git 標籤', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdd-git-'));
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
    execSync('echo a > f.txt && git add -A && git commit -qm init', { cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('標籤名固定 sdd/task/<id>/start，且已存在時不重建', () => {
    const r1 = tagTaskStart(dir, 'TASK-setup-qrcode-page-route');
    expect(r1.tag).toBe('sdd/task/TASK-setup-qrcode-page-route/start');
    expect(r1.created).toBe(true);
    const r2 = tagTaskStart(dir, 'TASK-setup-qrcode-page-route');
    expect(r2.created).toBe(false);
  });

  it('reset 能回到 start 標籤', () => {
    tagTaskStart(dir, 'TASK-x');
    execSync('echo b > f.txt && git add -A && git commit -qm change', { cwd: dir });
    expect(resetToTaskStart(dir, 'TASK-x')).toBe(true);
    expect(execSync('git show --stat --oneline HEAD', { cwd: dir }).toString()).toContain('init');
  });
});

describe('TDD 子圖', () => {
  let dir: string;
  let repoDir: string;
  let docsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdd-tdd-'));
    repoDir = join(dir, 'repo');
    docsDir = join(repoDir, 'docs', 'demo');
    mkdirSync(docsDir, { recursive: true });
    copyFileSync(join(FIX, 'tasks.md'), join(docsDir, 'tasks.md'));
    copyFileSync(join(FIX, 'spec.md'), join(docsDir, 'spec.md'));
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repoDir });
    execSync('git add -A && git commit -qm init', { cwd: repoDir });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** The graph under test: the real TDD node, the stages in front of it stubbed. */
  function tddGraph(tasks: Task[]): { g: any; cfg: any; verifyRuns: { count: number } } {
    const verifyRuns = { count: 0 };
    const g = buildGraph({
      checkpointer: createCheckpointer(join(dir, 'cp.sqlite')),
      testNodes: {
        bootstrap: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: {
            bootstrapped: true,
            currentStage: 'tdd',
            requirementName: 'demo',
            repoPath: repoDir,
            tasks,
            currentTaskIndex: 0,
          },
          goto: 'tdd',
        }),
        verify: async (): Promise<NodeOutcome> => {
          verifyRuns.count += 1;
          return {
            kind: 'advance',
            update: { currentStage: 'completed' },
            goto: 'completed',
          };
        },
      },
    });
    return { g, cfg: { configurable: { thread_id: 'thr-tdd' } }, verifyRuns };
  }

  /** The payload the run is parked on. */
  async function pending(g: any, cfg: any): Promise<any> {
    const snap: any = await g.getState(cfg);
    return snap.tasks[0].interrupts[0].value;
  }

  /** The state of the run. */
  async function values(g: any, cfg: any): Promise<any> {
    const snap: any = await g.getState(cfg);
    return snap.values;
  }

  /**
   * The worker writes the files of the order.
   *
   * The work order names the implementation files *and* the test file of the
   * task, and the graph checks them itself (the CLI does the same).
   */
  function developerFiles(): void {
    const dir = join(repoDir, 'src', 'app', 'page', 'qrcode-app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'page.tsx'), 'export default function Page() { return null; }\n');
    writeFileSync(join(dir, 'page.module.css'), '.page {}\n');
    const test = join(repoDir, 'src', '__tests__', 'setup-qrcode-page-route.test.ts');
    mkdirSync(join(test, '..'), { recursive: true });
    writeFileSync(test, "it('renders', () => {});\n");
  }

  it('第一個中斷是 developer 工作單，輸出是該 task 預期的檔案', async () => {
    const { g, cfg } = tddGraph([TASK_A]);
    await g.invoke({ requirementName: 'demo' }, cfg);

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('host');
    expect(payload.type).toBe('work_order');
    expect(payload.role).toBe('developer');
    expect(payload.cwd).toBe(repoDir);
    // **The inputs are slim**: the task is in the prompt, and there is no
    // Figma design in this fixture, so the specification is all there is.
    expect(payload.inputs).toEqual([join(docsDir, 'spec.md')]);
    expect(payload.outputs).toEqual([
      join(repoDir, 'src/app/page/qrcode-app/page.tsx'),
      join(repoDir, 'src/app/page/qrcode-app/page.module.css'),
      // The test file of the task is part of the scope: the developer
      // prompt demands the TDD flow, and the scope rule says the worker
      // only writes the paths of `outputs`.
      join(repoDir, 'src/__tests__/setup-qrcode-page-route.test.ts'),
    ]);
  });

  it('developer 工作單的輸出一定要有測試檔（否則 worker 會不寫測試）', async () => {
    const { g, cfg } = tddGraph([TASK_A]);
    await g.invoke({ requirementName: 'demo' }, cfg);

    const payload = await pending(g, cfg);
    const tests = payload.outputs.filter((file: string) => /__tests__|\.test\.|\.spec\./.test(file));
    expect(tests.length).toBeGreaterThan(0);
    // 工作單裡也說得出來那個測試檔是哪一個
    expect(payload.prompt).toContain('src/__tests__/setup-qrcode-page-route.test.ts');
  });

  it('developer 工作單之前必須先打上 start 標籤', async () => {
    const { g, cfg } = tddGraph([TASK_A]);
    await g.invoke({ requirementName: 'demo' }, cfg);

    const tags = execSync('git tag', { cwd: repoDir }).toString();
    expect(tags).toContain('sdd/task/TASK-setup-qrcode-page-route/start');
  });

  it('developer 完成後是一張審查工作單（spec 與 quality 一起審）', async () => {
    const { g, cfg, verifyRuns } = tddGraph([TASK_A]);
    await g.invoke({ requirementName: 'demo' }, cfg);

    developerFiles();
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }), cfg);
    const review = await pending(g, cfg);
    expect(review.role).toBe('reviewer');
    expect(review.resultSchema).toBe('review');

    // 一張單問兩個問題：兩個結論一起回來。
    await g.invoke(
      new Command({
        resume: {
          status: 'ok',
          summary: '',
          changedFiles: [],
          reviews: [
            { role: 'spec', verdict: 'pass', issues: [] },
            { role: 'quality', verdict: 'pass', issues: [] },
          ],
        },
      }),
      cfg
    );
    // 審查通過 → 這個 task 完成 → 交棒給驗證階段（不再有審查工作單）
    expect(verifyRuns.count).toBe(1);
  });

  it('舊的 checkpoint（spec_review_done）不能讓 run 卡死：合併審查還是要跑', async () => {
    // 舊版本的子階段值：規格審查已經過了，下一步是品質審查。現在兩者合併，
    // 所以它要落到「開發者做完了，該審查了」—— 不是掉進沒有 case 的縫裡。
    const g = buildGraph({
      checkpointer: createCheckpointer(join(dir, 'cp.sqlite')),
      testNodes: {
        bootstrap: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: {
            bootstrapped: true,
            currentStage: 'tdd',
            requirementName: 'demo',
            repoPath: repoDir,
            tasks: [TASK_A],
            currentTaskIndex: 0,
            tddSubStage: 'spec_review_done' as any,
          },
          goto: 'tdd',
        }),
      },
    });
    const cfg = { configurable: { thread_id: 'thr-legacy-substage' } };

    await g.invoke({ requirementName: 'demo' }, cfg);

    const payload = await pending(g, cfg);
    expect(payload.role).toBe('reviewer');
  });

  it('task 串行：一個 task 走完才輪到下一個', async () => {
    const { g, cfg } = tddGraph([TASK_A, TASK_B]);
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerFiles();
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }), cfg);
    await g.invoke(
      new Command({
        resume: {
          status: 'ok',
          summary: '',
          changedFiles: [],
          reviews: [
            { role: 'spec', verdict: 'pass', issues: [] },
            { role: 'quality', verdict: 'pass', issues: [] },
          ],
        },
      }),
      cfg
    );

    // 第一個 task 完成 → 第二個 task 的 developer 工作單
    const payload = await pending(g, cfg);
    expect(payload.role).toBe('developer');
    const state = await values(g, cfg);
    expect(state.currentTaskIndex).toBe(1);
    expect(state.tddSubStage).toBe('pending');
  });

  it('全部 task 完成後交棒給驗證階段', async () => {
    const { g, cfg, verifyRuns } = tddGraph([TASK_A]);
    await g.invoke({ requirementName: 'demo' }, cfg);
    developerFiles();
    await g.invoke(new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }), cfg);
    await g.invoke(
      new Command({
        resume: {
          status: 'ok',
          summary: '',
          changedFiles: [],
          reviews: [
            { role: 'spec', verdict: 'pass', issues: [] },
            { role: 'quality', verdict: 'pass', issues: [] },
          ],
        },
      }),
      cfg
    );

    // 交棒是真的交到驗證節點（不是自己把階段設成 completed）
    expect(verifyRuns.count).toBe(1);
    const state = await values(g, cfg);
    expect(state.currentStage).toBe('completed');
  });

  it('developer 需要使用者決定時必須問使用者', async () => {
    const { g, cfg } = tddGraph([TASK_A]);
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(
      new Command({
        resume: {
          status: 'needs_human',
          summary: '卡住了',
          changedFiles: [],
          interrupt: { type: 'developer_question', question: '要用哪個元件？', options: ['a', 'b'] },
        },
      }),
      cfg
    );

    const payload = await pending(g, cfg);
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('developer_question');
    expect(payload.question).toBe('要用哪個元件？');
    expect(payload.options).toEqual(['a', 'b']);
  });

  it('使用者回答之後必須重發 developer 工作單，並且帶著答案', async () => {
    const { g, cfg } = tddGraph([TASK_A]);
    await g.invoke({ requirementName: 'demo' }, cfg);
    await g.invoke(
      new Command({
        resume: {
          status: 'needs_human',
          summary: '卡住了',
          changedFiles: [],
          interrupt: { type: 'developer_question', question: '要用哪個元件？', options: ['a', 'b'] },
        },
      }),
      cfg
    );
    await g.invoke(new Command({ resume: { answer: '用 a' } }), cfg);

    const payload = await pending(g, cfg);
    expect(payload.role).toBe('developer');
    expect(payload.prompt).toContain('用 a');
  });

  it('工作目錄不是 git repo 時迴圈仍然要能跑', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain, { recursive: true });
    const g = buildGraph({
      checkpointer: createCheckpointer(join(dir, 'cp-plain.sqlite')),
      testNodes: {
        bootstrap: async (): Promise<NodeOutcome> => ({
          kind: 'advance',
          update: {
            bootstrapped: true,
            currentStage: 'tdd',
            requirementName: 'demo',
            repoPath: plain,
            tasks: [TASK_A],
            currentTaskIndex: 0,
          },
          goto: 'tdd',
        }),
      },
    });
    const cfg = { configurable: { thread_id: 'thr-plain' } };
    await g.invoke({ requirementName: 'demo' }, cfg);

    const payload = await pending(g, cfg);
    expect(payload.role).toBe('developer');
  });
});

describe('developer 節點', () => {
  it('needs_human 但沒有問題：算失敗，而且要說得出來為什麼', () => {
    const outcome = readDeveloperResult({ status: 'needs_human', summary: '', changedFiles: [] });
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' ? outcome.summary : '').toContain('did not state the question');
  });

  it('needs_human 帶著問題：交給使用者', () => {
    const outcome = readDeveloperResult({
      status: 'needs_human',
      summary: '卡住了',
      changedFiles: [],
      interrupt: { type: 'developer_question', question: '要用哪個元件？', options: ['a'] },
    });
    expect(outcome.kind).toBe('needs_human');
    expect(outcome.kind === 'needs_human' ? outcome.question.question : '').toBe('要用哪個元件？');
  });

  it('ok 會帶出摘要與改到的檔案（審查者要知道實作了什麼）', () => {
    const outcome = readDeveloperResult({
      status: 'ok',
      summary: '加了頁面與測試',
      changedFiles: ['/repo/src/page.tsx'],
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    expect(outcome.summary).toBe('加了頁面與測試');
    expect(outcome.changedFiles).toEqual(['/repo/src/page.tsx']);
  });
});

describe('評審工作單的脈絡', () => {
  let dir: string;
  let repoDir: string;
  let docsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdd-ctx-'));
    repoDir = join(dir, 'repo');
    docsDir = join(repoDir, 'docs', 'demo');
    mkdirSync(docsDir, { recursive: true });
    copyFileSync(join(FIX, 'tasks.md'), join(docsDir, 'tasks.md'));
    copyFileSync(join(FIX, 'spec.md'), join(docsDir, 'spec.md'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const state = (): any => ({
    repoPath: repoDir,
    requirementName: 'demo',
    stageSteps: {},
  });

  describe('工作單的 context 要瘦', () => {
    /** The prototype of one frame, on disk. */
    function writePrototype(key = '1-23'): void {
      const prototypeDir = join(docsDir, 'figma', 'prototype');
      mkdirSync(join(prototypeDir, 'css'), { recursive: true });
      mkdirSync(join(docsDir, 'figma', 'screenshots'), { recursive: true });
      writeFileSync(join(prototypeDir, `${key}.html`), '<html></html>');
      writeFileSync(join(prototypeDir, 'css', 'tokens.css'), ':root {}');
      writeFileSync(join(docsDir, 'figma', 'screenshots', `${key}.png`), 'x');
    }

    it('developer 的 inputs 只有 spec、這個 task 的原型頁與截圖、tokens.css', () => {
      writePrototype();
      const order = developerWorkOrder(state(), { ...TASK_A, frames: ['1-23'] });
      expect(order.inputs).toEqual([
        join(docsDir, 'spec.md'),
        join(docsDir, 'figma', 'prototype', '1-23.html'),
        join(docsDir, 'figma', 'screenshots', '1-23.png'),
        join(docsDir, 'figma', 'prototype', 'css', 'tokens.css'),
      ]);
    });

    it('developer 的 inputs 不再包含整份 tasks.md（task 已經在提示詞裡）', () => {
      writePrototype();
      const order = developerWorkOrder(state(), { ...TASK_A, frames: ['1-23'] });
      expect(order.inputs).not.toContain(join(docsDir, 'tasks.md'));
    });

    it('沒有 Figma 設計時 inputs 只剩 spec.md', () => {
      const order = developerWorkOrder(state(), TASK_A);
      expect(order.inputs).toEqual([join(docsDir, 'spec.md')]);
    });

    it('frame 不存在時不給那條路徑（會話不該拿到找不到的檔案）', () => {
      const order = developerWorkOrder(state(), { ...TASK_A, frames: ['9-99'] });
      expect(order.inputs).toEqual([join(docsDir, 'spec.md')]);
    });

    it('審查工作單也要瘦：spec 加上這個 task 的原型頁', () => {
      writePrototype();
      const order = reviewWorkOrder(state(), { ...TASK_A, frames: ['1-23'] });
      expect(order.inputs).toEqual([
        join(docsDir, 'spec.md'),
        join(docsDir, 'figma', 'prototype', '1-23.html'),
      ]);
    });
  });

  it('評審工作單要說得出來開發者做了什麼', () => {
    const withReport = {
      ...state(),
      ...recordDeveloperReport({
        summary: '加了頁面骨架與測試',
        changedFiles: ['/repo/src/app/page/qrcode-app/page.tsx'],
      }),
    };
    const order = reviewWorkOrder(withReport, TASK_A);
    expect(order.prompt).toContain('這次實作的回報');
    expect(order.prompt).toContain('加了頁面骨架與測試');
    expect(order.prompt).toContain('page.tsx');
  });

  it('讀不到 tasks.md 的檔案清單時，工作單必須說出來', () => {
    const broken = { ...state(), repoPath: join(dir, 'nowhere') };
    const order = developerWorkOrder(broken, TASK_A);
    expect(order.prompt).toContain('讀不到');
    // 範圍不能是空的：至少要有測試檔
    expect(order.outputs.length).toBeGreaterThan(0);
  });
});
