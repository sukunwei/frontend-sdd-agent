import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Command } from '@langchain/langgraph';
import type { StateSnapshot } from '@langchain/langgraph';
import { buildGraph } from '../src/graph/compile.js';
import type { CompiledSddGraph } from '../src/graph/compile.js';
import { hasStageStep, readStageStep } from '../src/graph/state.js';
import type { GraphState } from '../src/graph/state.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import { acquireLock, getLock } from '../src/runtime/branch-lock.js';
import { SddAbortError } from '../src/runtime/errors.js';
import { getLockFilePath } from '../src/runtime/paths.js';
import { resetRunContext, setRunContext } from '../src/runtime/run-context.js';

/**
 * 「節點執行到一半時插進去」的鉤子。
 *
 * **為什麼需要它**：節點在一次執行裡讀鎖三次——預檢查、`startTask()` 內部、
 * abort 的時候。中間只有一次 `git status`，單執行緒的測試沒辦法在那個縫隙裡
 * 插進去（`execFileSync` 是同步的，事件迴圈被佔住）。
 *
 * **所以把「別的 task 拿鎖」掛在 `git status` 上**：那個呼叫是同步的，
 * 鉤子就在它之前把鎖寫進去——時序是確定的，不是靠 sleep 賭出來的。
 */
const { raceHook } = vi.hoisted(() => ({
  raceHook: { current: null as (() => void) | null },
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (file: string, args: string[], options?: unknown) => {
      // 工作區狀態查詢之前 → 讓「別的 task」拿到鎖（只觸發一次）
      if (file === 'git' && args.includes('status') && raceHook.current) {
        const hook = raceHook.current;
        raceHook.current = null;
        hook();
      }
      return (actual.execFileSync as (...a: unknown[]) => unknown)(file, args, options);
    },
  };
});

/** 一個 thread 的設定（thread_id 就是 task 名）。 */
interface ThreadConfig {
  configurable: { thread_id: string };
}

/** 閘口的 payload：測試只看得到自己問過的欄位。 */
interface GatePayload {
  audience?: string;
  type?: string;
  code?: string;
  options?: string[];
  message?: string;
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
    raceHook.current = null;
    resetRunContext();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  /** 真實的 graph + 一個 thread 的設定。 */
  function localGraph(threadId: string): { g: CompiledSddGraph; cfg: ThreadConfig } {
    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
    });
    return { g, cfg: { configurable: { thread_id: threadId } } };
  }

  /**
   * 跑 graph 的輸入。
   *
   * **是整份 state 的一個片段**：`invoke()` 的型別要的是完整的 state，
   * 而測試只給它它關心的欄位——CLI 那邊也是同一個寫法。
   */
  function inputOf(values: Partial<GraphState>): GraphState {
    return values as GraphState;
  }

  /** 快照裡的 state（LangGraph 的型別是 `any`，這裡收窄成自己的 state）。 */
  function valuesOf(snap: StateSnapshot): GraphState {
    return snap.values as GraphState;
  }

  /** 停下來時掛著的閘口。 */
  function gatesOf(snap: StateSnapshot): GatePayload[] {
    return (snap.tasks[0]?.interrupts ?? []).map((i) => i.value as GatePayload);
  }

  /** 停下來時掛著的閘口類型。 */
  function pendingTypes(snap: StateSnapshot): string[] {
    return gatesOf(snap).map((payload) => String(payload.type));
  }

  it('髒工作區時開閘門問使用者，且不動使用者的改動', async () => {
    dirtyTheWorktree();

    const { g, cfg } = localGraph('local-task');
    await g.invoke(inputOf({ requirementName: 'local-task', repoUrl: 'ignored' }), cfg);

    const snap = await g.getState(cfg);
    const payload = gatesOf(snap)[0];

    // 閘門的形狀：問人（不是工作單），兩個選項
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('dirty_worktree');
    expect(payload.code).toBe('dirty_worktree');
    expect(payload.options).toEqual(['proceed', 'abort']);
    expect(typeof payload.message).toBe('string');
    expect(String(payload.message).length).toBeGreaterThan(0);

    // 不得前進
    expect(valuesOf(snap).bootstrapped).toBe(false);
    expect(valuesOf(snap).currentStage).toBe('bootstrap');

    // 使用者正在寫的東西不得被帶走，也不得被切到別的分支
    expect(currentBranch(repo)).toBe('main');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('changed by the user\n');
  });

  it('使用者答 proceed 後第二次執行不再開閘門，且留在當前分支上工作', async () => {
    dirtyTheWorktree();

    const { g, cfg } = localGraph('local-task');
    await g.invoke(inputOf({ requirementName: 'local-task', repoUrl: 'ignored' }), cfg);
    await g.invoke(new Command({ resume: { action: 'proceed' } }), cfg);

    const snap = await g.getState(cfg);

    // 前進到 prd
    expect(valuesOf(snap).bootstrapped).toBe(true);
    expect(valuesOf(snap).currentStage).toBe('prd');
    // proceed 的意思是「不切分支，就在當前 HEAD 上工作」
    expect(valuesOf(snap).branch).toBe('main');
    expect(valuesOf(snap).repoPath).toBe(fs.realpathSync(repo));

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
    await g.invoke(inputOf({ requirementName: 'local-task', repoUrl: 'ignored' }), cfg);
    await g.invoke(new Command({ resume: { action: 'proceed' } }), cfg);

    const snap = await g.getState(cfg);
    expect(hasStageStep(valuesOf(snap), 'bootstrap', 'dirty-worktree')).toBe(true);
    expect(readStageStep(valuesOf(snap), 'bootstrap', 'dirty-worktree')).toBe('proceed');
  });

  it('使用者答 abort 時釋放鎖並以 aborted 結束', async () => {
    dirtyTheWorktree();
    // 上一輪跑崩了留下的鎖（同一個 task 的鎖不算衝突，但確實還握在手上）
    acquireLock('local-task', 'task/local-task', repo, 'run_x', getLockFilePath());
    expect(getLock(getLockFilePath())?.running).toBe(true);

    const { g, cfg } = localGraph('local-task');
    await g.invoke(inputOf({ requirementName: 'local-task', repoUrl: 'ignored' }), cfg);

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
    const snap = await g.getState(cfg);
    expect(valuesOf(snap).bootstrapped).toBe(false);
    expect(valuesOf(snap).currentStage).toBe('bootstrap');
  });

  it('abort 時不得釋放別的 task 的鎖', async () => {
    dirtyTheWorktree();

    const { g, cfg } = localGraph('local-task');
    await g.invoke(inputOf({ requirementName: 'local-task', repoUrl: 'ignored' }), cfg);

    // 閘門開著的這段時間裡（等人回答），另一個 task 拿到了鎖。
    // 這個 run 自己還沒拿到鎖（髒檢查在拿鎖之前就回來了），所以 abort 時
    // 那把鎖很可能就是別人的——把它清掉，兩個 task 就會同時在一個倉庫裡幹活，
    // 那正是這把鎖存在的理由。
    //
    // **插在 `git status` 上**：節點的預檢查與 `startTask()` 內部都已經看過
    // 鎖了（那時它還不存在），abort 才是第三次讀鎖——剛好落在這個縫隙裡。
    raceHook.current = () => {
      acquireLock('other-task', 'task/other-task', repo, 'run_y', getLockFilePath());
    };

    await expect(
      g.invoke(new Command({ resume: { action: 'abort' } }), cfg)
    ).rejects.toBeInstanceOf(SddAbortError);

    // 別的 task 的鎖必須還在它手上
    expect(getLock(getLockFilePath())?.taskName).toBe('other-task');
    expect(getLock(getLockFilePath())?.running).toBe(true);
  });

  it('abort 時不得留下鎖（本來就沒有鎖的情況）', async () => {
    dirtyTheWorktree();

    const { g, cfg } = localGraph('local-task');
    await g.invoke(inputOf({ requirementName: 'local-task', repoUrl: 'ignored' }), cfg);

    await expect(
      g.invoke(new Command({ resume: { action: 'abort' } }), cfg)
    ).rejects.toBeInstanceOf(SddAbortError);

    expect(getLock(getLockFilePath())?.running ?? false).toBe(false);
  });

  it('答不認得的選項時要再問一次，不得當成放行', async () => {
    dirtyTheWorktree();

    const { g, cfg } = localGraph('local-task');
    await g.invoke(inputOf({ requirementName: 'local-task', repoUrl: 'ignored' }), cfg);
    await g.invoke(new Command({ resume: { action: 'yes' } }), cfg);

    const snap = await g.getState(cfg);
    expect(pendingTypes(snap)).toContain('dirty_worktree');
    expect(valuesOf(snap).bootstrapped).toBe(false);
    expect(currentBranch(repo)).toBe('main');
  });

  it('already_exists 閘門答 reset 之後，髒工作區的閘門會再問一次（台賬被清掉）', async () => {
    // 這個 task 之前跑過：留下 run-metadata，下一次跑就會撞上 already_exists
    const first = localGraph('run-1');
    await first.g.invoke(inputOf({ requirementName: 'local-task', repoUrl: 'ignored' }), first.cfg);
    expect(valuesOf(await first.g.getState(first.cfg)).bootstrapped).toBe(true);

    // 使用者現在正在寫東西
    dirtyTheWorktree();

    // 第二輪：同一個 task，state 帶著上一輪記下的「問過了」
    const second = localGraph('run-2');
    await second.g.invoke(
      inputOf({
        requirementName: 'local-task',
        repoUrl: 'ignored',
        stageSteps: { 'bootstrap/dirty-worktree': 'proceed' },
      }),
      second.cfg
    );

    const parked = await second.g.getState(second.cfg);
    expect(pendingTypes(parked)).toContain('already_exists');

    // 答 reset：從頭再來——台賬裡「問過了」那一步必須被清掉，
    // 否則下一個執行會靜默地沿用上次的決定（在當前分支上幹活），
    // 而不是重新問使用者。
    await second.g.invoke(new Command({ resume: { action: 'reset' } }), second.cfg);

    const afterReset = await second.g.getState(second.cfg);
    expect(pendingTypes(afterReset)).toContain('dirty_worktree');
    expect(readStageStep(valuesOf(afterReset), 'bootstrap', 'dirty-worktree')).toBe('');
    // 不得靜默地在當前分支上幹活
    expect(valuesOf(afterReset).bootstrapped).toBe(false);
    expect(currentBranch(repo)).toBe('task/local-task');
  });

  it('工作區乾淨時就地模式直接開跑，不開髒工作區閘門', async () => {
    const { g, cfg } = localGraph('local-task');
    await g.invoke(inputOf({ requirementName: 'local-task', repoUrl: 'ignored' }), cfg);

    const snap = await g.getState(cfg);
    expect(valuesOf(snap).bootstrapped).toBe(true);
    expect(valuesOf(snap).currentStage).toBe('prd');
    expect(pendingTypes(snap)).not.toContain('dirty_worktree');
    // 乾淨的工作區照舊切出工作分支
    expect(valuesOf(snap).branch).toBe('task/local-task');
    expect(currentBranch(repo)).toBe('task/local-task');
    expect(valuesOf(snap).repoPath).toBe(fs.realpathSync(repo));
  });

  it('未跟蹤的檔案不算髒，不開閘門', async () => {
    // 插件自己的 `.sdd/` 與使用者的新檔案都是未跟蹤的：
    // 把它們算成髒，閘門每一輪都會觸發，就地模式直接不可用。
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x');

    const { g, cfg } = localGraph('local-task');
    await g.invoke(inputOf({ requirementName: 'local-task', repoUrl: 'ignored' }), cfg);

    const snap = await g.getState(cfg);
    expect(pendingTypes(snap)).not.toContain('dirty_worktree');
    expect(valuesOf(snap).bootstrapped).toBe(true);
  });
});
