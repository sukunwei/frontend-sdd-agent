import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { startTask } from '../src/commands/start-task.js';
import { getCheckpointPath, getLockFilePath } from '../src/runtime/paths.js';
import { resetRunContext, setRunContext } from '../src/runtime/run-context.js';
import { cleanupTaskWorkspace, getWorkspaceInfo } from '../src/runtime/task-workspace.js';

/**
 * 記錄 git 呼叫，證明就地模式沒有 clone。
 *
 * 模仿 `tests/bootstrap-node.test.ts` 的寫法：真的跑 git（就地模式的行為
 * 就是 git 的行為），只把呼叫次數記下來。
 */
const { gitCalls } = vi.hoisted(() => ({ gitCalls: [] as string[][] }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (file: string, args: string[], options?: unknown) => {
      if (file === 'git') gitCalls.push(args);
      return (actual.execFileSync as (...a: unknown[]) => unknown)(file, args, options);
    },
  };
});

/**
 * 就地模式的啟動流程。
 *
 * 這些測試真的在臨時目錄裡建 git 倉庫、真的切分支、真的刪檔案——
 * 「絕不刪使用者的東西」這種保證只有真的刪一遍才算數。
 */
describe('local 模式的 startTask', () => {
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

  beforeEach(() => {
    repo = createRepo('sdd-local-start-');
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-local-ws-'));
    process.env.SDD_GRAPH_WORKSPACE_BASE = ws;
    gitCalls.length = 0;
    setRunContext({
      mode: 'local',
      repoRoot: repo,
      sddHome: path.join(repo, '.sdd'),
      workspaceBase: ws,
    });
  });

  afterEach(() => {
    resetRunContext();
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('local 模式不 clone，repoPath 就是業務倉庫根', async () => {
    const r = await startTask('local-task', 'ignored');

    expect(r.success).toBe(true);
    expect(r.repoPath).toBe(fs.realpathSync(repo));
    expect(gitCalls.filter((a) => a[0] === 'clone').length).toBe(0);
  });

  it('local 模式把 run-metadata 寫在 .sdd/runs/<task>/ 之下', async () => {
    const r = await startTask('local-task', 'ignored');
    expect(r.success).toBe(true);

    const metaPath = path.join(repo, '.sdd', 'runs', 'local-task', 'run-metadata.json');
    expect(fs.existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
      branch: string;
      repoPath: string;
      taskName: string;
    };
    expect(meta.taskName).toBe('local-task');
    expect(meta.branch).toBe('task/local-task');
    expect(meta.repoPath).toBe(fs.realpathSync(repo));
  });

  it('local 模式不建 workspace 目錄', async () => {
    const r = await startTask('local-task', 'ignored');
    expect(r.success).toBe(true);

    // 外掛的 workspace 底下不該有這個 task
    expect(fs.existsSync(path.join(ws, 'local-task'))).toBe(false);
    // 就地模式的 task 目錄只有 .sdd/tasks/<task>，沒有 repo/
    expect(fs.existsSync(path.join(repo, '.sdd', 'tasks', 'local-task'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.sdd', 'tasks', 'local-task', 'repo'))).toBe(false);
  });

  it('local 模式在業務倉庫裡切出工作分支', async () => {
    const r = await startTask('local-task', 'ignored');

    expect(r.success).toBe(true);
    expect(r.branch).toBe('task/local-task');
    expect(currentBranch(repo)).toBe('task/local-task');
  });

  it('髒工作區回報 dirty_worktree 阻塞', async () => {
    // 使用者自己正在寫的東西（已跟蹤文件被改過）
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');

    const r = await startTask('local-task', 'ignored');

    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('dirty_worktree');
    // 使用者的改動不能被帶到別的分支上
    expect(currentBranch(repo)).toBe('main');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('changed\n');
  });

  it('未跟蹤檔案不算髒', async () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x');

    const r = await startTask('local-task', 'ignored');

    expect(r.success).toBe(true);
    expect(r.errorCode).toBeUndefined();
  });

  it('使用者批准留在當前分支時（skipBranchSwitch）不回報髒工作區', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');

    const r = await startTask('local-task', 'ignored', { skipBranchSwitch: true });

    expect(r.success).toBe(true);
    expect(r.branch).toBe('main');
    expect(currentBranch(repo)).toBe('main');
  });

  it('local 模式不受 repoUrl 的字元黑名單約束（remote 模式會拒絕的輸入）', async () => {
    // 這個輸入 remote 模式**真的會被拒絕**（以 - 開頭 → git 會當成選項），
    // 所以這條測試才真的區分了兩條路徑。
    const evil = '-upload-pack=evil';

    resetRunContext();
    const remote = await startTask('remote-task', evil);
    expect(remote.success).toBe(false);
    expect(remote.errorCode).toBe('validation_error');
    expect(gitCalls.filter((a) => a[0] === 'clone').length).toBe(0);

    setRunContext({
      mode: 'local',
      repoRoot: repo,
      sddHome: path.join(repo, '.sdd'),
      workspaceBase: ws,
    });
    const local = await startTask('local-task', evil);
    expect(local.success).toBe(true);
    expect(gitCalls.filter((a) => a[0] === 'clone').length).toBe(0);
  });

  it('同一個 task 再跑一次時回報 already_exists', async () => {
    const first = await startTask('local-task', 'ignored');
    expect(first.success).toBe(true);

    const second = await startTask('local-task', 'ignored');
    expect(second.success).toBe(false);
    // **錯誤碼要說「這個 task 已經跑過了」**：不是「工作區建不起來」
    // （那是可重試的錯，重跑不會讓既有的運行時狀態消失）。
    expect(second.errorCode).toBe('already_exists');
    // **訊息不得指向分支**：分支存在本來就不是阻擋（reset 不刪分支），
    // 使用者照著訊息去查分支只會白查一場。
    expect(second.error).not.toContain('branch');
    expect(second.error).toContain('run metadata');
  });

  it('只有分支存在（reset 之後）時不阻塞——分支會被複用', async () => {
    // reset 只清 .sdd 下的運行時狀態，不刪分支（刪使用者的東西是硬紅線）。
    // 若分支存在也算阻塞，reset 之後這個 task 就永遠起不來。
    execFileSync('git', ['-C', repo, 'branch', 'task/local-task'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const r = await startTask('local-task', 'ignored');

    expect(r.success).toBe(true);
    expect(r.branch).toBe('task/local-task');
    // 複用既有的分支，不另外開一條
    expect(currentBranch(repo)).toBe('task/local-task');
    expect(fs.existsSync(path.join(repo, '.sdd', 'runs', 'local-task', 'run-metadata.json'))).toBe(true);
  });

  it('reset 只刪 .sdd/ 下的東西，不動業務倉庫', async () => {
    const r = await startTask('local-task', 'ignored');
    expect(r.success).toBe(true);

    // 使用者自己的東西：業務檔案、docs/、分支
    fs.mkdirSync(path.join(repo, 'docs', 'local-task'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'local-task', 'prd.md'), '# prd');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed by the user\n');

    cleanupTaskWorkspace('local-task');

    // 使用者的東西全都在
    expect(fs.readFileSync(path.join(repo, 'docs', 'local-task', 'prd.md'), 'utf-8')).toBe('# prd');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('changed by the user\n');
    expect(currentBranch(repo)).toBe('task/local-task');
    expect(
      execFileSync('git', ['-C', repo, 'rev-parse', '--verify', 'refs/heads/task/local-task'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    ).toBeTruthy();

    // 插件自己的運行時狀態沒了
    expect(fs.existsSync(path.join(repo, '.sdd', 'runs', 'local-task'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.sdd', 'tasks', 'local-task'))).toBe(false);
  });

  it('清理目標不在 .sdd 之下時拒絕刪除', () => {
    const outside = path.join(repo, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');

    expect(() => cleanupTaskWorkspace('../../outside')).toThrow();
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });

  it('清理目標就是父目錄本身時也拒絕刪除', () => {
    // cleanupTaskWorkspace('.') 會指向 <sddHome>/tasks —— 那是整棵樹，
    // 不是「某個 task 的目錄」，必須拒絕。
    fs.mkdirSync(path.join(repo, '.sdd', 'tasks', 'other-task'), { recursive: true });

    expect(() => cleanupTaskWorkspace('.')).toThrow();
    expect(fs.existsSync(path.join(repo, '.sdd', 'tasks', 'other-task'))).toBe(true);
  });

  it('狀態根被指到倉庫根時，清理必須拒絕刪（那是使用者自己的目錄）', () => {
    // 使用者自己的目錄：`tasks/` 與 `runs/` 是很常見的名字。
    const own = path.join(repo, 'tasks', 'my-own');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'keep.txt'), 'keep');

    // SDD_GRAPH_SDD_HOME 被指到倉庫根（用戶自己設定的）。
    setRunContext({
      mode: 'local',
      repoRoot: repo,
      sddHome: repo,
      workspaceBase: ws,
    });

    expect(() => cleanupTaskWorkspace('my-own')).toThrow();
    // **使用者的目錄一個字都沒被動到。**
    expect(fs.existsSync(path.join(own, 'keep.txt'))).toBe(true);
  });

  it('local 模式列舉既有 task 時看 .sdd/tasks', async () => {
    const r = await startTask('local-task', 'ignored');
    expect(r.success).toBe(true);

    const info = getWorkspaceInfo();
    expect(info.existingTasks).toContain('local-task');
    expect(info.workspaceBase).toBe(path.join(repo, '.sdd', 'tasks'));
  });

  it('兩個倉庫的同名 task 不串狀態', async () => {
    const repoB = createRepo('sdd-local-start-b-');
    try {
      const a = await startTask('same-task', 'ignored');
      expect(a.success).toBe(true);

      // A 的鎖還握在手上，B 照樣能開始（鎖檔各自歸各的倉庫）
      expect(getLockFilePath()).toBe(path.join(repo, '.sdd', 'branch-lock.json'));
      expect(fs.existsSync(path.join(repo, '.sdd', 'branch-lock.json'))).toBe(true);

      setRunContext({
        mode: 'local',
        repoRoot: repoB,
        sddHome: path.join(repoB, '.sdd'),
        workspaceBase: ws,
      });

      const b = await startTask('same-task', 'ignored');
      expect(b.success).toBe(true);

      // 兩邊的狀態各自在自己的 .sdd 之下
      expect(fs.existsSync(path.join(repo, '.sdd', 'runs', 'same-task', 'run-metadata.json'))).toBe(true);
      expect(fs.existsSync(path.join(repoB, '.sdd', 'runs', 'same-task', 'run-metadata.json'))).toBe(true);
      expect(getCheckpointPath()).toBe(path.join(repoB, '.sdd', 'checkpoints.sqlite'));
      expect(getLockFilePath()).toBe(path.join(repoB, '.sdd', 'branch-lock.json'));

      // A 的分支不影響 B
      expect(currentBranch(repo)).toBe('task/same-task');
      expect(currentBranch(repoB)).toBe('task/same-task');
    } finally {
      fs.rmSync(repoB, { recursive: true, force: true });
    }
  });
});
