import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { isRejectionMarker, rejectionMarker } from '../src/cli/protocol.js';
import { runCli } from '../src/cli/index.js';
import { buildGraph } from '../src/graph/compile.js';
import type { NodeOutcome } from '../src/graph/state.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import type { Task } from '../src/state/types.js';
import { captureIo } from './helpers/capture-io.js';

const FIX = path.join(import.meta.dirname, 'fixtures', 'qrcode-app');

const TASK_A: Task = {
  id: 'TASK-setup-qrcode-page-route',
  title: 'Setup QR code page route',
  acceptanceCriteria: ['路由 `/qrcode-app` 存在且可渲染'],
  acRefs: ['AC-001'],
  complexity: 'S',
  priority: 'high',
};

/** A result that is not a review: the prose "PASS" of a lazy reviewer. */
const NOT_A_REVIEW = JSON.stringify({ status: 'ok', summary: 'PASS', changedFiles: [] });

describe('駁回標記', () => {
  it('標記與一般結果必須分得開', () => {
    expect(isRejectionMarker(rejectionMarker('invalid_review'))).toBe(true);
    expect(isRejectionMarker(rejectionMarker('missing_outputs'))).toBe(true);
    expect(isRejectionMarker({ status: 'ok', summary: '', changedFiles: [] })).toBe(false);
    expect(isRejectionMarker({ __rejected: true })).toBe(false);
    expect(isRejectionMarker({ __rejected: true, reason: 'nonsense' })).toBe(false);
    expect(isRejectionMarker('invalid_review')).toBe(false);
    expect(isRejectionMarker(undefined)).toBe(false);
  });
});

describe('CLI 的駁回要交給圖（Ruling 24）', () => {
  let ws: string;
  let repoDir: string;
  let docsDir: string;
  let cp: string;
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-reject-'));
    repoDir = path.join(ws, 'repo');
    docsDir = path.join(repoDir, 'docs', 'demo');
    fs.mkdirSync(docsDir, { recursive: true });
    fs.copyFileSync(path.join(FIX, 'tasks.md'), path.join(docsDir, 'tasks.md'));
    fs.copyFileSync(path.join(FIX, 'spec.md'), path.join(docsDir, 'spec.md'));
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repoDir });
    execSync('git add -A && git commit -qm init', { cwd: repoDir });
    cp = path.join(ws, 'cp.sqlite');
    process.env.SDD_GRAPH_WORKSPACE_BASE = ws;
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
    fs.rmSync(ws, { recursive: true, force: true });
  });

  /** The graph under test: the real TDD node, the stage in front of it stubbed. */
  function tddGraph(): any {
    return buildGraph({
      checkpointer: createCheckpointer(cp),
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
  }

  /** The files the developer order asks for are on disk. */
  function writeDeveloperFiles(): void {
    const dir = path.join(repoDir, 'src', 'app', 'page', 'qrcode-app');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'page.tsx'), 'export default function Page() { return null; }\n');
    fs.writeFileSync(path.join(dir, 'page.module.css'), '.page {}\n');
    const test = path.join(repoDir, 'src', '__tests__', 'setup-qrcode-page-route.test.tsx');
    fs.mkdirSync(path.dirname(test), { recursive: true });
    fs.writeFileSync(test, 'it("works", () => {});\n');
  }

  it('第一次不合法評審：同一張單重發、階段不動；第二次：升級', async () => {
    const graph = tddGraph();

    // 1. developer 工作單
    expect(await runCli(['start', '--task', 'reject-1', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    const started = JSON.parse(io.take().out);
    expect(started.payload.role).toBe('developer');

    // 2. 檔案都在 → developer 完成 → spec 評審工作單
    writeDeveloperFiles();
    expect(
      await runCli(
        ['complete', '--task', 'reject-1', '--result', JSON.stringify({ status: 'ok', summary: 'done', changedFiles: [] })],
        { graph }
      )
    ).toBe(2);
    const review = JSON.parse(io.take().out);
    expect(review.payload.role).toBe('spec_reviewer');

    // 3. 評審不是合法的 ReviewResult → 同一張單重發，階段不動
    expect(
      await runCli(['complete', '--task', 'reject-1', '--result', NOT_A_REVIEW], { graph })
    ).toBe(2);
    const again = JSON.parse(io.take().out);
    expect(again.kind).toBe('interrupt');
    expect(again.audience).toBe('host');
    expect(again.stage).toBe('tdd');
    expect(again.payload.role).toBe('spec_reviewer');
    // 同一張單：payload 一模一樣
    expect(again.payload).toEqual(review.payload);

    // 4. 第二次還是不合法 → 升級（開發者工作單帶著失敗回去）
    expect(
      await runCli(['complete', '--task', 'reject-1', '--result', NOT_A_REVIEW], { graph })
    ).toBe(2);
    const escalated = JSON.parse(io.take().out);
    expect(escalated.kind).toBe('interrupt');
    expect(escalated.payload.role).toBe('developer');
  });

  it('輸出檔案沒有落盤：同一張單重發，圖自己記住次數', async () => {
    const graph = tddGraph();

    expect(await runCli(['start', '--task', 'reject-2', '--repo', 'file:///nonexistent'], { graph })).toBe(2);
    io.take();

    // 檔案沒有落盤 → CLI 把駁回交給圖 → 同一張單重發
    const rc = await runCli(
      ['complete', '--task', 'reject-2', '--result', JSON.stringify({ status: 'ok', summary: 'done', changedFiles: [] })],
      { graph }
    );
    const captured = io.take();
    expect(rc).toBe(2);
    const env = JSON.parse(captured.out);
    expect(env.kind).toBe('interrupt');
    expect(env.payload.role).toBe('developer');
    expect(env.stage).toBe('tdd');

    // 圖自己記住這一次駁回
    let state: any = await graph.getState({ configurable: { thread_id: 'reject-2' } });
    expect(state.values.stageSteps['tdd/missing-outputs']).toBe('1');
    expect(state.values.tddAttempts).toBe(0);

    // 第二次沒有落盤 → 升級（developer 失敗次數 +1）
    const rc2 = await runCli(
      ['complete', '--task', 'reject-2', '--result', JSON.stringify({ status: 'ok', summary: 'done', changedFiles: [] })],
      { graph }
    );
    const escalated = io.take();
    expect(rc2).toBe(2);
    expect(JSON.parse(escalated.out).payload.role).toBe('developer');

    state = await graph.getState({ configurable: { thread_id: 'reject-2' } });
    expect(state.values.tddAttempts).toBe(1);
  });
});
