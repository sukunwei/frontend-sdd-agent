import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Command } from '@langchain/langgraph';
import { buildGraph } from '../src/graph/compile.js';
import { hasStageStep, readStageStep } from '../src/graph/state.js';
import type { GraphState } from '../src/graph/state.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import { acquireLock, getLock } from '../src/runtime/branch-lock.js';
import { SddAbortError } from '../src/runtime/errors.js';
import { getLockFilePath } from '../src/runtime/paths.js';
import { resetRunContext, setRunContext } from '../src/runtime/run-context.js';

/**
 * 停靠在閘口上的快照。
 *
 * LangGraph 的快照型別很寬（`tasks[].interrupts[].value` 是 `unknown`），
 * 這裡只取用得到的部分，讓測試讀得出閘口的 payload。
 */
interface GateSnapshot {
  values: GraphState;
  tasks: Array<{ interrupts: Array<{ value: Record<string, unknown> }> }>;
}

/**
 * 就地模式（local）的 bootstrap 節點與髒工作區閘門。
 *
 * 這些測試真的在臨時目錄裡建 git 倉庫、真的改檔案、真的跑 graph：
 * 閘門的三個性質——**只問一次**、**答完不留鎖**、**使用者的改動不丟**——
 * 只有真的跑一遍才算數。
 */
describe('就地模式的 bootstrap 節點', () => {
  let repo: string;
  let ws: string;

  /** 在臨時目錄裡建一個有一個 commit 的 git 倉庫。 */
  function createRepo(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    };
    git(['init', '--initial-branch=main']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(['add', '.']);
    git(['commit', '-m', 'init']);
    return dir;
  }

  /** 目前所在的分支。 */
  function currentBranch(dir: string): string {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  /** 使用者自己正在寫的東西：改一個已跟蹤的檔案。 */
  function dirtyTheWorktree(): void {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed by the user\n');
  }

  /** 工作區的狀態（只看已跟蹤的檔案，跟插件的口徑一致）。 */
  function worktreeStatus(dir: string): string {
    return execFileSync(
      'git',
      ['-C', dir, 'status', '--porcelain', '--untracked-files=no'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
  }

  beforeEach(() => {
    repo = createRepo('sdd-local-boot-');
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-local-boot-ws-'));
    setRunContext({
      mode: 'local',
      repoRoot: repo,
      sddHome: path.join(repo, '.sdd'),
      workspaceBase: path.join(ws, 'tasks'),
    });
  });

  afterEach(() => {
    resetRunContext();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  /**
   * 真實的 graph + 一個 thread 的設定。
   *
   * graph 的型別在這裡放寬：LangGraph 的 `invoke()` 要的是整份 state，
   * 而測試只給它兩個欄位——跟既有的 graph 測試同一個寫法。
   */
  function localGraph(taskName: string): { g: any; cfg: any } {
    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
    });
    return { g, cfg: { configurable: { thread_id: taskName } } };
  }

  /** 讀快照。 */
  async function snapshotOf(g: any, cfg: any): Promise<GateSnapshot> {
    return (await g.getState(cfg)) as GateSnapshot;
  }

  /** 停下來時掛著的閘口。 */
  function pendingTypes(snap: GateSnapshot): string[] {
    const interrupts = snap.tasks?.[0]?.interrupts ?? [];
    return interrupts.map((i) => String(i.value?.type));
  }

  it('髒工作區時開閘門問使用者，且不動使用者的改動', async () => {
    dirtyTheWorktree();

    const { g, cfg } = localGraph('local-task');
    await g.invoke({ requirementName: 'local-task', repoUrl: 'ignored' }, cfg);

    const snap = await snapshotOf(g, cfg);
    const payload = snap.tasks[0].interrupts[0].value;

    // 閘門的形狀：問人（不是工作單），兩個選項
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('dirty_worktree');
    expect(payload.code).toBe('dirty_worktree');
    expect(payload.options).toEqual(['proceed', 'abort']);
    expect(typeof payload.message).toBe('string');
    expect(String(payload.message).length).toBeGreaterThan(0);

    // 不得前進
    expect(snap.values.bootstrapped).toBe(false);
    expect(snap.values.currentStage).toBe('bootstrap');

    // 使用者正在寫的東西不得被帶走，也不得被切到別的分支
    expect(currentBranch(repo)).toBe('main');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('changed by the user\n');
  });

  it('使用者答 proceed 後第二次執行不再開閘門，且留在當前分支上工作', async () => {
    dirtyTheWorktree();

    const { g, cfg } = localGraph('local-task');
    await g.invoke({ requirementName: 'local-task', repoUrl: 'ignored' }, cfg);
    await g.invoke(new Command({ resume: { action: 'proceed' } }), cfg);

    const snap = await snapshotOf(g, cfg);

    // 前進到 prd
    expect(snap.values.bootstrapped).toBe(true);
    expect(snap.values.currentStage).toBe('prd');
    // proceed 的意思是「不切分支，就在當前 HEAD 上工作」
    expect(snap.values.branch).toBe('main');
    expect(snap.values.repoPath).toBe(fs.realpathSync(repo));

    // **只問一次**：髒工作區的閘門不得再出現
    // （現在掛著的是 prd 階段的閘門——那是另一個問題）
    expect(pendingTypes(snap)).not.toContain('dirty_worktree');

    // 閘門沒有再開，**不是因為工作區變乾淨了**——它還是髒的，
    // 沒有開第二次是因為台賬記住了使用者的答案。
    expect(worktreeStatus(repo)).not.toBe('');

    // 使用者的改動原封不動
    expect(currentBranch(repo)).toBe('main');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('changed by the user\n');
  });

  it('台賬記住了 proceed，state 裡看得到', async () => {
    dirtyTheWorktree();

    const { g, cfg } = localGraph('local-task');
    await g.invoke({ requirementName: 'local-task', repoUrl: 'ignored' }, cfg);
    await g.invoke(new Command({ resume: { action: 'proceed' } }), cfg);

    const snap = await snapshotOf(g, cfg);
    expect(hasStageStep(snap.values, 'bootstrap', 'dirty-worktree')).toBe(true);
    expect(readStageStep(snap.values, 'bootstrap', 'dirty-worktree')).toBe('proceed');
  });

  it('使用者答 abort 時釋放鎖並以 aborted 結束', async () => {
    dirtyTheWorktree();
    // 上一輪跑崩了留下的鎖（同一個 task 的鎖不算衝突，但確實還握在手上）
    acquireLock('local-task', 'task/local-task', repo, 'run_x', getLockFilePath());
    expect(getLock(getLockFilePath())?.running).toBe(true);

    const { g, cfg } = localGraph('local-task');
    await g.invoke({ requirementName: 'local-task', repoUrl: 'ignored' }, cfg);

    let caught: unknown;
    try {
      await g.invoke(new Command({ resume: { action: 'abort' } }), cfg);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SddAbortError);
    expect((caught as SddAbortError).code).toBe('aborted');

    // 鎖必須還回去：這個倉庫不該被鎖住
    expect(getLock(getLockFilePath())?.running).toBe(false);

    // 不得前進
    const snap = await snapshotOf(g, cfg);
    expect(snap.values.bootstrapped).toBe(false);
    expect(snap.values.currentStage).toBe('bootstrap');
  });

  it('abort 時不得留下鎖（本來就沒有鎖的情況）', async () => {
    dirtyTheWorktree();

    const { g, cfg } = localGraph('local-task');
    await g.invoke({ requirementName: 'local-task', repoUrl: 'ignored' }, cfg);

    await expect(
      g.invoke(new Command({ resume: { action: 'abort' } }), cfg)
    ).rejects.toBeInstanceOf(SddAbortError);

    expect(getLock(getLockFilePath())?.running ?? false).toBe(false);
  });

  it('答不認得的選項時要再問一次，不得當成放行', async () => {
    dirtyTheWorktree();

    const { g, cfg } = localGraph('local-task');
    await g.invoke({ requirementName: 'local-task', repoUrl: 'ignored' }, cfg);
    await g.invoke(new Command({ resume: { action: 'yes' } }), cfg);

    const snap = await snapshotOf(g, cfg);
    expect(pendingTypes(snap)).toContain('dirty_worktree');
    expect(snap.values.bootstrapped).toBe(false);
    expect(currentBranch(repo)).toBe('main');
  });

  it('工作區乾淨時就地模式直接開跑，不開髒工作區閘門', async () => {
    const { g, cfg } = localGraph('local-task');
    await g.invoke({ requirementName: 'local-task', repoUrl: 'ignored' }, cfg);

    const snap = await snapshotOf(g, cfg);
    expect(snap.values.bootstrapped).toBe(true);
    expect(snap.values.currentStage).toBe('prd');
    expect(pendingTypes(snap)).not.toContain('dirty_worktree');
    // 乾淨的工作區照舊切出工作分支
    expect(snap.values.branch).toBe('task/local-task');
    expect(currentBranch(repo)).toBe('task/local-task');
    expect(snap.values.repoPath).toBe(fs.realpathSync(repo));
  });

  it('未跟蹤的檔案不算髒，不開閘門', async () => {
    // 插件自己的 `.sdd/` 與使用者的新檔案都是未跟蹤的：
    // 把它們算成髒，閘門每一輪都會觸發，就地模式直接不可用。
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x');

    const { g, cfg } = localGraph('local-task');
    await g.invoke({ requirementName: 'local-task', repoUrl: 'ignored' }, cfg);

    const snap = await snapshotOf(g, cfg);
    expect(pendingTypes(snap)).not.toContain('dirty_worktree');
    expect(snap.values.bootstrapped).toBe(true);
  });
});
