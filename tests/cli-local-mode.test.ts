import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../src/cli/index.js';
import { getLock } from '../src/runtime/branch-lock.js';
import { getPluginRoot } from '../src/runtime/paths.js';
import { resetRunContext } from '../src/runtime/run-context.js';
import { captureIo } from './helpers/capture-io.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type { GitFixture } from './helpers/git-fixture.js';

/**
 * CLI 的就地模式（local）。
 *
 * **就地模式的行為只有真的跑一遍才算數**：這些測試在臨時目錄裡建真的 git
 * 倉庫、真的切分支、真的寫 `.sdd/`、真的呼叫 git——「絕不刪使用者的東西」
 * 與「遠端模式的老用法不能被打斷」這種保證，mock 出來的行為證明不了。
 *
 * **兩種跑法各有理由**：
 * - 進程內（`runCli`）：快，而且能直接檢查磁碟上的狀態。
 * - 真的行程（`bin/sdd-graph` + 外掛副本）：checkpoint 查找鏈要 fallback 到
 *   **外掛根**的舊位置，而外掛根是從模組自己的位置算出來的——只有把外掛
 *   複製一份到臨時目錄，那個「外掛根」才不會是開發者自己的倉庫
 *   （測試去動真實的 `runtime/checkpoints.sqlite` 會污染別人的运行）。
 */

/** 一個有一個 commit 的 git 倉庫。 */
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

/**
 * 寫一把分支鎖。
 *
 * @param file - 鎖檔路徑
 * @param taskName - 握著這把鎖的 task
 * @param running - 鎖是不是還在跑
 */
function writeLock(file: string, taskName: string, running = true): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      running,
      taskName,
      branch: `task/${taskName}`,
      repoPath: '/repo',
      runId: 'run_1',
      startedAt: new Date().toISOString(),
    }),
    'utf-8'
  );
}

/** 一個 JSON 信封。 */
interface Envelope {
  [key: string]: unknown;
}

/** 讀一行 JSON；不是 JSON 就是 undefined。 */
function parseEnvelope(text: string): Envelope | undefined {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    return undefined;
  }
}

/**
 * 外掛的一份副本。
 *
 * **為什麼要複製**：外掛根是從模組自己的位置算出來的，測試想驗證「外掛根
 * 的舊 checkpoint」就只能指向一份副本——否則測試會寫進開發者自己的
 * `runtime/checkpoints.sqlite`（而且會跟別的測試搶同一個檔案）。
 */
function copyPlugin(): string {
  const source = getPluginRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cli-local-plugin-'));
  for (const part of ['bin', 'src', 'prompts', '.claude-plugin']) {
    fs.cpSync(path.join(source, part), path.join(dir, part), { recursive: true });
  }
  fs.cpSync(path.join(source, 'package.json'), path.join(dir, 'package.json'));
  fs.chmodSync(path.join(dir, 'bin', 'sdd-graph'), 0o755);
  // 依賴只有一份：符號連結就好，不用複製整個 node_modules。
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  // **實體路徑**：shim 用 `cd -P` 解析外掛根（macOS 上 `/var` 是
  // `/private/var` 的符號連結），子行程回報的路徑必須是同一個寫法。
  return fs.realpathSync(dir);
}

/** 一個子行程的結果。 */
interface Child {
  /** 結束碼。 */
  rc: number;
  /** stdout 的信封（沒有輸出時是 undefined）。 */
  out: Envelope | undefined;
  /** stderr 的信封（沒有輸出時是 undefined）。 */
  err: Envelope | undefined;
}

describe('CLI 的就地模式（local）', () => {
  let repo: string;
  let ws: string;
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    repo = createRepo('sdd-cli-local-');
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cli-local-ws-'));
    // 工作區（遠端模式的複製目標）搬到臨時目錄，外掛目錄必須保持乾淨。
    process.env.SDD_GRAPH_WORKSPACE_BASE = ws;
    io = captureIo();
    // **cwd 就是使用者的專案目錄**：就地模式的預設是「沒有 --repo 就用 cwd」。
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
  });

  afterEach(() => {
    io.restore();
    vi.restoreAllMocks();
    resetRunContext();
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('start 不帶 --repo 時就地使用 cwd 的倉庫', async () => {
    const rc = await runCli(['start', '--task', 'local-task']);
    const captured = io.take();

    expect(rc).toBe(2);
    expect(captured.err).toBe('');
    const env = JSON.parse(captured.out) as Envelope;
    expect(env.kind).toBe('interrupt');
    expect(env.threadId).toBe('local-task');

    // **程式碼寫在使用者的倉庫裡**：工作分支切出來了。
    expect(currentBranch(repo)).toBe('task/local-task');
    // 運行時狀態寫在業務倉庫的 .sdd 之下。
    expect(fs.existsSync(path.join(repo, '.sdd', 'checkpoints.sqlite'))).toBe(true);
    const meta = JSON.parse(
      fs.readFileSync(path.join(repo, '.sdd', 'runs', 'local-task', 'run-metadata.json'), 'utf-8')
    ) as { repoPath: string };
    expect(meta.repoPath).toBe(fs.realpathSync(repo));
    // **沒有複製任何東西**：就地模式不建工作區。
    expect(fs.existsSync(path.join(ws, 'local-task'))).toBe(false);
  });

  it('就地模式不得把本機絕對路徑寫進要進版本庫的 state 鏡像', async () => {
    await runCli(['start', '--task', 'local-task']);
    io.take();

    const mirror = JSON.parse(
      fs.readFileSync(path.join(repo, 'docs', 'local-task', 'workflow-state.json'), 'utf-8')
    ) as { repoUrl: string; repoPath: string };
    // 沒有遠端就寫目錄名——至少看得出是哪個專案。
    expect(mirror.repoUrl).toBe(`local:${path.basename(repo)}`);
    expect(mirror.repoUrl).not.toContain(os.tmpdir());
  });

  it('start 帶 --repo <url> 時走 remote（既有行為不變）', async () => {
    const fixture = createGitFixture('sdd-cli-local-git-');
    try {
      const rc = await runCli(['start', '--task', 'remote-task', '--repo', fixture.url], {
        // 遠端模式的 checkpoint 與鎖本來就在外掛根底下；測試把它們指到
        // 臨時目錄，外掛目錄必須保持乾淨。
        checkpointPath: path.join(ws, 'cp.sqlite'),
        lockPath: path.join(ws, 'lock.json'),
      });
      const captured = io.take();

      expect(rc).toBe(2);
      expect(JSON.parse(captured.out).threadId).toBe('remote-task');
      // **倉庫真的被複製了一份**：這是遠端模式的行為，不能被就地模式改掉。
      expect(fs.existsSync(path.join(ws, 'remote-task', 'repo', '.git'))).toBe(true);
      // 使用者的倉庫裡沒有就地模式的痕跡。
      expect(fs.existsSync(path.join(repo, '.sdd'))).toBe(false);
      expect(currentBranch(repo)).toBe('main');
    } finally {
      fixture.cleanup();
    }
  });

  it('local 模式下 status 與 stop 找得到那一輪 run（鎖在 .sdd 底下）', async () => {
    await runCli(['start', '--task', 'local-task']);
    io.take();

    const lockFile = path.join(repo, '.sdd', 'branch-lock.json');
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(getLock(lockFile)?.running).toBe(true);

    const statusRc = await runCli(['status', '--task', 'local-task']);
    const status = io.take();
    expect(statusRc).toBe(0);
    expect(JSON.parse(status.out).stage).toBe('prd');

    const stopRc = await runCli(['stop', '--task', 'local-task']);
    io.take();
    expect(stopRc).toBe(0);
    // 就地模式的鎖在業務倉庫的 .sdd 之下——釋放的是那一把。
    expect(getLock(lockFile)?.running).toBe(false);
  });

  it('.sdd 沒被忽略時給出提示，但不改使用者的 .gitignore', async () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n', 'utf-8');

    await runCli(['start', '--task', 'local-task']);
    const captured = io.take();

    const env = JSON.parse(captured.out) as Envelope;
    expect(env.notice).toBe('請把 /.sdd/ 加進 .gitignore');
    // **使用者的 .gitignore 一個字都沒被改**：那是受版本控制的檔案。
    expect(fs.readFileSync(path.join(repo, '.gitignore'), 'utf-8')).toBe('node_modules\n');
  });

  it('.sdd 已經被忽略時不得給提示', async () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), '/.sdd/\n', 'utf-8');

    await runCli(['start', '--task', 'local-task']);
    const captured = io.take();

    const env = JSON.parse(captured.out) as Envelope;
    expect(env.notice).toBeUndefined();
  });

  it('--repo 的路徑不對時必須回 validation_error（不是 internal_error）', async () => {
    const missing = path.join(ws, 'no-such-repo');
    const rc = await runCli(['start', '--task', 'local-task', '--repo', missing]);
    const captured = io.take();

    expect(rc).toBe(1);
    expect(captured.out).toBe('');
    const err = JSON.parse(captured.err) as Envelope;
    expect(err.code).toBe('validation_error');
    expect(String(err.message)).toContain('no-such-repo');
  });

  it('使用者中止髒工作區時必須回 aborted（不是 internal_error）', async () => {
    // 使用者自己正在寫的東西（已跟蹤文件被改過）
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed by the user\n');

    const startRc = await runCli(['start', '--task', 'local-task']);
    const started = io.take();
    expect(startRc).toBe(2);
    expect(JSON.parse(started.out).type).toBe('dirty_worktree');

    const approveRc = await runCli([
      'approve',
      '--task',
      'local-task',
      '--payload',
      JSON.stringify({ action: 'abort' }),
    ]);
    const approved = io.take();

    expect(approveRc).toBe(1);
    expect(approved.out).toBe('');
    expect(JSON.parse(approved.err).code).toBe('aborted');
  });

  it('--repo 指向另一個倉庫時必須拒絕（就地模式只認目前目錄的倉庫）', async () => {
    const other = createRepo('sdd-cli-other-repo-');
    try {
      const rc = await runCli(['start', '--task', 'local-task', '--repo', other]);
      const captured = io.take();

      expect(rc).toBe(1);
      expect(captured.out).toBe('');
      const err = JSON.parse(captured.err) as Envelope;
      expect(err.code).toBe('validation_error');
      expect(String(err.message)).toContain('cd');
      // 另一個倉庫不得被動到
      expect(fs.existsSync(path.join(other, '.sdd'))).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('--repo . 與省略 --repo 等價（同一個倉庫）', async () => {
    const rc = await runCli(['start', '--task', 'local-task', '--repo', '.']);
    const captured = io.take();

    expect(rc).toBe(2);
    expect(JSON.parse(captured.out).threadId).toBe('local-task');
    expect(currentBranch(repo)).toBe('task/local-task');
    expect(fs.existsSync(path.join(repo, '.sdd', 'checkpoints.sqlite'))).toBe(true);
  });

  it('origin url 是本機路徑時，鏡像裡不得出現那個絕對路徑', async () => {
    // 遠端指著本機的一個目錄——那樣的絕對路徑一樣不該進版本庫。
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', '/Users/someone/elsewhere'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await runCli(['start', '--task', 'local-task']);
    io.take();

    const mirror = JSON.parse(
      fs.readFileSync(path.join(repo, 'docs', 'local-task', 'workflow-state.json'), 'utf-8')
    ) as { repoUrl: string };
    expect(mirror.repoUrl).toBe(`local:${path.basename(repo)}`);
    expect(mirror.repoUrl).not.toContain('/Users/someone/elsewhere');
  });
});

/**
 * checkpoint 的查找鏈：真的行程（外掛副本）。
 *
 * **必須是行程**：查找鏈要 fallback 到「外掛根」的舊位置，而外掛根是從模組
 * 自己的位置算出來的。進程內跑就會指向開發者真正的外掛目錄——測試不該
 * 動那裡的 `runtime/checkpoints.sqlite`。
 */
describe('checkpoint 查找鏈（真的行程）', () => {
  let plugin: string;
  let fixture: GitFixture;

  beforeAll(() => {
    plugin = copyPlugin();
    fixture = createGitFixture('sdd-cli-chain-git-');
  });

  afterAll(() => {
    fixture.cleanup();
    fs.rmSync(plugin, { recursive: true, force: true });
  });

  /**
   * 跑副本裡的那支 shim。
   *
   * @param args - 指令與參數
   * @param cwd - 子行程的工作目錄
   * @returns 結束碼與兩個信封
   */
  function bin(args: string[], cwd: string): Child {
    const result = spawnSync(path.join(plugin, 'bin', 'sdd-graph'), args, {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      rc: result.status ?? -1,
      out: parseEnvelope(result.stdout ?? ''),
      err: parseEnvelope(result.stderr ?? ''),
    };
  }

  it('resume 查不到就地位置時要回落外掛根（遠端模式的老用法不能被打斷）', () => {
    // 遠端模式跑一輪：checkpoint 落在外掛根的 runtime/ 之下。
    const started = bin(['start', '--task', 'legacy-task', '--repo', fixture.url], os.tmpdir());
    expect(started.rc).toBe(2);
    expect(started.out?.kind).toBe('interrupt');

    // 換一個沒有 .sdd 的目錄（也不在任何 git 倉庫裡）→ 就地位置查不到。
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cli-chain-cwd-'));
    try {
      const resumed = bin(['resume', '--task', 'legacy-task'], elsewhere);
      expect(resumed.rc).toBe(2);
      expect(resumed.err).toBeUndefined();
      expect(resumed.out?.kind).toBe('interrupt');
      expect(resumed.out?.threadId).toBe('legacy-task');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 120_000);

  it('兩個位置都沒有 thread 時，錯誤訊息要列出查過的兩個位置', () => {
    const repo = createRepo('sdd-cli-chain-repo-');
    try {
      const r = bin(['resume', '--task', 'nothing-here'], repo);

      expect(r.rc).toBe(1);
      expect(r.out).toBeUndefined();
      expect(r.err?.code).toBe('no_checkpoint');
      const message = String(r.err?.message);
      expect(message).toContain('.sdd/checkpoints.sqlite');
      expect(message).toContain('runtime/checkpoints.sqlite');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 120_000);

  it('cwd 不在倉庫裡時，no_checkpoint 的訊息仍然列出兩個位置', () => {
    // 就地的那一份查不了（cwd 不是倉庫），但**那正是使用者最需要知道的**：
    // 「你的 task 可能在某個業務倉庫的 .sdd 裡，請 cd 到那裡再試」。
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cli-chain-norepo-'));
    try {
      const r = bin(['resume', '--task', 'nothing-here'], elsewhere);

      expect(r.rc).toBe(1);
      expect(r.err?.code).toBe('no_checkpoint');
      const message = String(r.err?.message);
      expect(message).toContain('.sdd/checkpoints.sqlite');
      expect(message).toContain('runtime/checkpoints.sqlite');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 120_000);

  it('remote 模式的 status 與 stop 也走新鏈路（找得到外掛根的那一輪）', () => {
    const started = bin(['start', '--task', 'legacy-task', '--repo', fixture.url], os.tmpdir());
    expect(started.rc).toBe(2);

    const status = bin(['status', '--task', 'legacy-task'], os.tmpdir());
    expect(status.rc).toBe(0);
    expect(status.out?.kind).toBe('result');
    expect(status.out?.stage).toBe('prd');

    const stopped = bin(['stop', '--task', 'legacy-task'], os.tmpdir());
    expect(stopped.rc).toBe(0);
    // 外掛根的鎖被釋放了（遠端模式的鎖就在那裡）
    const globalLock = path.join(plugin, 'runtime', 'branch-runtime-lock.json');
    expect(JSON.parse(fs.readFileSync(globalLock, 'utf-8')).running).toBe(false);
  }, 120_000);

  it('stop 只動同一個倉庫的鎖：別的 task 握著本倉庫的鎖時，訊息講的是那把鎖', () => {
    const repo = createRepo('sdd-cli-stop-repo-');
    try {
      // 就地模式跑一輪：鎖在業務倉庫的 .sdd 之下
      expect(bin(['start', '--task', 'local-task'], repo).rc).toBe(2);
      const localLock = path.join(repo, '.sdd', 'branch-lock.json');
      expect(fs.existsSync(localLock)).toBe(true);

      // 全域鎖（外掛根的）被另一個 task 握著
      const globalLock = path.join(plugin, 'runtime', 'branch-runtime-lock.json');
      writeLock(globalLock, 'global-other');
      // 本倉庫的鎖被另一個 task 握著
      writeLock(localLock, 'local-other');

      const stopped = bin(['stop', '--task', 'local-task'], repo);

      expect(stopped.rc).toBe(1);
      expect(stopped.err?.code).toBe('lock_not_owned');
      // **訊息講的是本倉庫那把鎖**，不是全域那把。
      expect(String(stopped.err?.message)).toContain('local-other');
      expect(String(stopped.err?.message)).not.toContain('global-other');
      // 兩把鎖都還在
      expect(JSON.parse(fs.readFileSync(localLock, 'utf-8')).taskName).toBe('local-other');
      expect(JSON.parse(fs.readFileSync(globalLock, 'utf-8')).taskName).toBe('global-other');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 120_000);

  it('stop --force 也不刪掉別的 task 握著的鎖（行為變更）', () => {
    const repo = createRepo('sdd-cli-force-repo-');
    try {
      expect(bin(['start', '--task', 'local-task'], repo).rc).toBe(2);
      const localLock = path.join(repo, '.sdd', 'branch-lock.json');
      const globalLock = path.join(plugin, 'runtime', 'branch-runtime-lock.json');
      writeLock(globalLock, 'global-other');
      writeLock(localLock, 'local-other');

      const forced = bin(['stop', '--task', 'local-task', '--force'], repo);

      expect(forced.rc).toBe(1);
      expect(forced.err?.code).toBe('lock_not_owned');
      // 兩把鎖都還在——`--force` 不得替別人中止他正在跑的那一輪。
      expect(fs.existsSync(localLock)).toBe(true);
      expect(fs.existsSync(globalLock)).toBe(true);
      expect(JSON.parse(fs.readFileSync(globalLock, 'utf-8')).running).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 120_000);

  it('stop 從倉庫裡的另一個目錄執行，釋放的還是本倉庫的鎖', () => {
    const repo = createRepo('sdd-cli-subdir-repo-');
    try {
      expect(bin(['start', '--task', 'local-task'], repo).rc).toBe(2);
      const localLock = path.join(repo, '.sdd', 'branch-lock.json');
      const globalLock = path.join(plugin, 'runtime', 'branch-runtime-lock.json');
      writeLock(globalLock, 'global-other');

      const sub = path.join(repo, 'src');
      fs.mkdirSync(sub, { recursive: true });
      const stopped = bin(['stop', '--task', 'local-task'], sub);

      expect(stopped.rc).toBe(0);
      // 本倉庫的鎖被釋放
      expect(JSON.parse(fs.readFileSync(localLock, 'utf-8')).running).toBe(false);
      // 全域鎖一個字都沒被動到
      expect(JSON.parse(fs.readFileSync(globalLock, 'utf-8')).taskName).toBe('global-other');
      expect(JSON.parse(fs.readFileSync(globalLock, 'utf-8')).running).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 120_000);

  it('stop 在不是倉庫的目錄裡執行時，動的是外掛根的鎖', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cli-stop-norepo-'));
    try {
      const globalLock = path.join(plugin, 'runtime', 'branch-runtime-lock.json');
      // 沒有人在跑的鎖
      writeLock(globalLock, 'someone-else', false);

      const stopped = bin(['stop', '--task', 'local-task'], elsewhere);

      expect(stopped.rc).toBe(0);
      expect(stopped.out?.kind).toBe('result');
      // 外掛根的鎖被釋放（就地位置根本查不了，只能動外掛根那把）
      expect(JSON.parse(fs.readFileSync(globalLock, 'utf-8')).running).toBe(false);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 120_000);
});
