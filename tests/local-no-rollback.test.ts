import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { execFileSync as ExecFileSync } from 'child_process';
import { Command } from '@langchain/langgraph';
import type { StateSnapshot } from '@langchain/langgraph';
import { buildGraph } from '../src/graph/compile.js';
import type { CompiledSddGraph } from '../src/graph/compile.js';
import { STAGE_NODE_NAMES } from '../src/graph/node-names.js';
import type { GraphState } from '../src/graph/state.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import { resetRunContext, setRunContext } from '../src/runtime/run-context.js';
import type { Task } from '../src/state/types.js';

/**
 * 插件自己發出的子行程呼叫（命令 + 參數）。
 *
 * **這是「就地模式一個子行程都沒跑」的證據**，而且它不能是一句空話：
 *
 * - 記的是**所有**子行程入口（`execFileSync` / `execFile` / `execSync` /
 *   `exec` / `spawn` / `spawnSync`）與**所有**命令，不只 `git`——插件哪天
 *   改用 `spawnSync`、換了別的執行檔、或是拼了 shell 字串，都還抓得到。
 * - mock 只記錄、不改行為，所以被記下來的每一條都是插件真的跑過的指令。
 * - 遠端模式那個測試會順便斷言「記錄器抓得到東西」：**記錄器一旦失效，
 *   那個測試會紅**，就地模式的斷言就不會變成永遠為真的空話。
 */
const { subprocessCalls } = vi.hoisted(() => ({ subprocessCalls: [] as string[][] }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();

  /** 記一條子行程呼叫：命令本體 + （有的話）argv。 */
  const record = (command: unknown, args: unknown): void => {
    const head = String(command);
    subprocessCalls.push(
      Array.isArray(args) ? [head, ...args.map((arg) => String(arg))] : [head]
    );
  };

  /** 包一層：先記錄，再照原樣呼叫。 */
  const wrap =
    (fn: unknown) =>
    (...args: unknown[]): unknown => {
      record(args[0], args[1]);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };

  return {
    ...actual,
    execFileSync: wrap(actual.execFileSync),
    execFile: wrap(actual.execFile),
    execSync: wrap(actual.execSync),
    exec: wrap(actual.exec),
    spawnSync: wrap(actual.spawnSync),
    spawn: wrap(actual.spawn),
  };
});

/**
 * **測試自己**用的 git 呼叫（沒有被 mock）。
 *
 * 這樣一來 `subprocessCalls` 裡面記到的每一條都是**插件**跑的命令——測試自己
 * 為了布置場景而跑的 git 不會混進來，「插件一個子行程都沒跑」這個斷言才是真的。
 */
let realExecFileSync: typeof ExecFileSync;

beforeAll(async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  realExecFileSync = actual.execFileSync;
});

const FIX = path.join(import.meta.dirname, 'fixtures', 'qrcode-app');

const TASK_A: Task = {
  id: 'TASK-setup-qrcode-page-route',
  title: 'Setup QR code page route',
  acceptanceCriteria: ['路由 `/qrcode-app` 存在且可渲染'],
  acRefs: ['AC-001'],
  complexity: 'S',
  priority: 'high',
};

/** 一個 thread 的設定。 */
interface ThreadConfig {
  configurable: { thread_id: string };
}

/** 閘門的 payload。 */
interface GatePayload {
  audience?: string;
  type?: string;
  options?: string[];
  taskId?: string;
  rollback?: string;
  question?: string;
  note?: string;
}

/* ------------------------------------------------------------------ */
/* 共用的場景                                                          */
/* ------------------------------------------------------------------ */

/**
 * 建一個使用者的業務倉庫：一個 commit，外加一個使用者還沒 commit 的改動。
 *
 * @param prefix - 臨時目錄的前綴。
 */
function createBusinessRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (args: string[]): void => {
    realExecFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  };
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'user@example.com']);
  git(['config', 'user.name', 'user']);

  fs.mkdirSync(path.join(dir, 'docs', 'demo'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'tasks.md'), path.join(dir, 'docs', 'demo', 'tasks.md'));
  fs.copyFileSync(path.join(FIX, 'spec.md'), path.join(dir, 'docs', 'demo', 'spec.md'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'committed\n');

  git(['add', '.']);
  git(['commit', '-m', 'init']);

  // **使用者自己正在寫的東西**：改了已跟蹤的檔案，但還沒 commit。
  fs.writeFileSync(path.join(dir, 'a.txt'), '使用者正在寫的東西\n');
  return dir;
}

/**
 * 圖（bootstrap 與 verify 換成假的，其餘都是真的節點）。
 *
 * @param repo - 這一輪工作的倉庫。
 * @param tmp - 暫存目錄（checkpoint 放這裡）。
 * @param thread - thread id。
 */
function tddGraph(
  repo: string,
  tmp: string,
  thread: string
): { g: CompiledSddGraph; cfg: ThreadConfig } {
  const g = buildGraph({
    checkpointer: createCheckpointer(path.join(tmp, `cp-${thread}.sqlite`)),
    testNodes: {
      bootstrap: async () => ({
        kind: 'advance',
        update: {
          bootstrapped: true,
          currentStage: 'tdd',
          requirementName: 'demo',
          repoPath: repo,
          tasks: [TASK_A],
          currentTaskIndex: 0,
        },
        goto: STAGE_NODE_NAMES.tdd,
      }),
      verify: async () => ({
        kind: 'advance',
        update: { currentStage: 'completed' },
        goto: STAGE_NODE_NAMES.completed,
      }),
    },
  });
  return { g, cfg: { configurable: { thread_id: thread } } };
}

/** 停下來時掛著的閘門。 */
async function pending(g: CompiledSddGraph, cfg: ThreadConfig): Promise<GatePayload> {
  const snap: StateSnapshot = await g.getState(cfg);
  return (snap.tasks[0]?.interrupts ?? [])[0].value as GatePayload;
}

/** 快照裡的 state。 */
async function values(g: CompiledSddGraph, cfg: ThreadConfig): Promise<GraphState> {
  const snap: StateSnapshot = await g.getState(cfg);
  return snap.values as GraphState;
}

/**
 * 開發者把 task 做出來了（並 commit）。
 *
 * **只 commit 自己的檔案** —— 使用者那個還沒 commit 的改動不在裡面。
 *
 * @param repo - 開發者工作的倉庫。
 * @param round - 第幾輪（每一輪寫的內容不一樣，不然第二次就沒有東西可 commit）。
 */
function developerWorks(repo: string, round: number): void {
  const dir = path.join(repo, 'src', 'app', 'page', 'qrcode-app');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'page.tsx'),
    `export default function Page() { return null; /* round ${round} */ }\n`
  );
  fs.writeFileSync(path.join(dir, 'page.module.css'), `.page { /* round ${round} */ }\n`);
  const test = path.join(repo, 'src', '__tests__', 'setup-qrcode-page-route.test.ts');
  fs.mkdirSync(path.dirname(test), { recursive: true });
  fs.writeFileSync(test, `it('renders ${round}', () => {});\n`);

  realExecFileSync('git', ['add', 'src'], { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  realExecFileSync('git', ['commit', '-m', `work ${round}`], {
    cwd: repo,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** 開發者回報 task 完成了。 */
async function developerDone(g: CompiledSddGraph, cfg: ThreadConfig): Promise<void> {
  await g.invoke(new Command({ resume: { status: 'ok', summary: 'done', changedFiles: [] } }), cfg);
}

/** 評審不通過（spec 失敗）。 */
async function specFails(g: CompiledSddGraph, cfg: ThreadConfig): Promise<void> {
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

/**
 * 把 TDD 迴圈驅動到「第二次失敗」的升級閘門。
 *
 * **兩次失敗才會升級到回滾**：第一次只是把評審退回給開發者。
 *
 * @param g - 圖。
 * @param cfg - thread 設定。
 * @param repo - 開發者工作的倉庫。
 */
async function driveToRollbackGate(
  g: CompiledSddGraph,
  cfg: ThreadConfig,
  repo: string
): Promise<GatePayload> {
  await g.invoke({ requirementName: 'demo' } as unknown as GraphState, cfg);

  developerWorks(repo, 1);
  await developerDone(g, cfg);
  await specFails(g, cfg);

  developerWorks(repo, 2);
  await developerDone(g, cfg);
  await specFails(g, cfg);

  return pending(g, cfg);
}

/** 倉庫裡的 tag 清單。 */
function tagsOf(repo: string): string[] {
  const out = realExecFileSync('git', ['tag'], {
    cwd: repo,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return out.split('\n').filter((line) => line.trim() !== '');
}

/** 目前 HEAD 指向的 commit。 */
function headOf(repo: string): string {
  return realExecFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** 工作區的狀態（只看已跟蹤的檔案，跟插件的口徑一致）。 */
function worktreeStatusOf(repo: string): string {
  return realExecFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: repo,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/* ------------------------------------------------------------------ */
/* 就地模式                                                            */
/* ------------------------------------------------------------------ */

/**
 * 就地模式（local）的 TDD 迴圈：**不做任何自動回滾，也不打 tag**。
 *
 * **為什麼要拿真的 git 倉庫來驗**：就地模式下的 `repoDir` 就是使用者的業務
 * 倉庫，插件跑的任何一條 git 指令都會動到使用者自己的檔案。所以這個測試真的
 * 建一個倉庫、真的留著使用者的未提交改動、真的把 TDD 迴圈跑到升級閘門，然後
 * 檢查四件事：
 *
 * 1. 插件一個 git 指令都沒跑（連 `git tag` 都沒有），
 * 2. 使用者的未提交改動一個位元組都沒動，
 * 3. 壞掉的程式碼原封不動留在倉庫裡 —— 就地模式不代替使用者決定該撤銷什麼，
 * 4. 閘門把這件事說清楚 —— 使用者才知道要自己去收拾。
 */
describe('就地模式不做任何自動回滾', () => {
  let repo: string;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-local-rollback-ws-'));
    repo = createBusinessRepo('sdd-local-rollback-');
    setRunContext({
      mode: 'local',
      repoRoot: repo,
      sddHome: path.join(repo, '.sdd'),
      workspaceBase: path.join(tmp, 'tasks'),
    });
    subprocessCalls.length = 0;
  });

  afterEach(() => {
    resetRunContext();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    subprocessCalls.length = 0;
  });

  it('連續失敗兩次：不打 tag、不 reset、使用者的未提交改動一字未動', async () => {
    const { g, cfg } = tddGraph(repo, tmp, 'thr-local-rollback');
    await g.invoke({ requirementName: 'demo' } as unknown as GraphState, cfg);

    developerWorks(repo, 1);
    await developerDone(g, cfg);
    await specFails(g, cfg);
    developerWorks(repo, 2);
    await developerDone(g, cfg);

    // 第二次失敗之前的 HEAD：開發者自己的 commit
    const headBeforeEscalation = headOf(repo);
    await specFails(g, cfg);

    // 閘門開著了
    const payload = await pending(g, cfg);
    expect(payload.type).toBe('tdd_rollback');

    // **插件一個子行程都沒跑**：沒有 git、沒有 tag、沒有 reset、沒有任何
    // 別的執行檔（記錄器抓的是所有子行程入口與所有命令，不只 `git`）
    expect(subprocessCalls).toEqual([]);

    // 沒有回滾點：任務起始的 tag 從來沒有被建立
    expect(tagsOf(repo).filter((tag) => tag.startsWith('sdd/task/'))).toEqual([]);

    // **HEAD 沒有被拽回去**：開發者的 commit 還在頭上
    expect(headOf(repo)).toBe(headBeforeEscalation);

    // **壞掉的程式碼原封不動留在使用者的倉庫裡**（就地模式不代替使用者做決定）
    expect(fs.existsSync(path.join(repo, 'src', 'app', 'page', 'qrcode-app', 'page.tsx'))).toBe(
      true
    );

    // **使用者的未提交改動一個位元組都沒動**
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('使用者正在寫的東西\n');
    expect(worktreeStatusOf(repo)).toContain('a.txt');

    // 閘門說的是「沒有回滾」，不是假裝還原過
    expect(payload.rollback).toBe('skipped');
    expect((await values(g, cfg)).tddAttempts).toBe(2);
  });

  it('閘門訊息要說明就地模式不做任何自動回滾', async () => {
    const { g, cfg } = tddGraph(repo, tmp, 'thr-local-rollback-note');

    const payload = await driveToRollbackGate(g, cfg, repo);

    // 使用者得知道壞代碼還在他的倉庫裡，而且要自己去收拾
    const message = `${payload.question ?? ''} ${payload.note ?? ''}`;
    expect(message).toContain('就地模式');
    expect(message).toContain('回滾');
    expect(message).toContain('請手動處理');
  });

  it('放棄這個 task 的那道閘門（tdd_blocked）也要說明壞代碼留在哪裡', async () => {
    const { g, cfg } = tddGraph(repo, tmp, 'thr-local-blocked');

    // 兩次失敗 → 回滾閘門
    await driveToRollbackGate(g, cfg, repo);
    // 使用者說「再試一次」
    await g.invoke(new Command({ resume: { action: 'wait' } }), cfg);
    // 第三次失敗 → 放棄這個 task 的閘門
    developerWorks(repo, 3);
    await developerDone(g, cfg);
    await specFails(g, cfg);

    const payload = await pending(g, cfg);
    expect(payload.type).toBe('tdd_blocked');

    // **這一道閘門沒有 `rollback` 欄位，但它恰恰是用戶下次回來唯一會看到的
    // 那一道**——他必須知道壞代碼還留在自己的倉庫裡。
    const message = `${payload.question ?? ''} ${payload.note ?? ''}`;
    expect(message).toContain('就地模式');
    expect(message).toContain('回滾');
    expect(message).toContain('請手動處理');
  });
});

/**
 * 遠端（remote）模式的行為逐字不變。
 *
 * **就地模式的改動不得連累到遠端模式**：遠端模式還是要打 tag、還是要把壞掉
 * 的程式碼還原回去（那份倉庫是插件 clone 出來的副本，砸了不心疼）。
 */
describe('遠端模式仍然打 tag 並回滾', () => {
  let repo: string;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-remote-rollback-ws-'));
    repo = createBusinessRepo('sdd-remote-rollback-');
    // 遠端模式：預設的運行上下文就是 remote
    resetRunContext();
    subprocessCalls.length = 0;
  });

  afterEach(() => {
    resetRunContext();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    subprocessCalls.length = 0;
  });

  it('仍然打任務起始的 tag，並把壞掉的程式碼還原回去', async () => {
    const { g, cfg } = tddGraph(repo, tmp, 'thr-remote-rollback');

    const payload = await driveToRollbackGate(g, cfg, repo);

    // 回滾點還在：遠端模式照舊打 tag
    expect(tagsOf(repo)).toContain('sdd/task/TASK-setup-qrcode-page-route/start');

    // 壞掉的程式碼被還原回去了（副本而已，砸了不心疼）
    expect(fs.existsSync(path.join(repo, 'src', 'app', 'page', 'qrcode-app', 'page.tsx'))).toBe(
      false
    );
    expect(payload.rollback).toBe('done');

    // **遠端模式的閘門訊息一字未變**（就地模式的說明不得跑進來）
    expect(payload.question).toBeUndefined();

    // **記錄器是活的**：遠端模式裡插件確實跑過 `git reset --hard`。
    // 這條斷言讓「記錄器失效」這件事會紅——就地模式那條
    // 「插件一個子行程都沒跑」的斷言才不會變成一句空話。
    expect(
      subprocessCalls.some(
        (call) =>
          call[0] === 'git' && call.includes('reset') && call.includes('--hard')
      )
    ).toBe(true);
  });
});
