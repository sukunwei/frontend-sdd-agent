import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../src/cli/index.js';
import { buildGraph } from '../src/graph/compile.js';
import type { CompiledSddGraph } from '../src/graph/compile.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import { getPluginRoot } from '../src/runtime/paths.js';
import { captureIo } from './helpers/capture-io.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type { GitFixture } from './helpers/git-fixture.js';

/**
 * The end-to-end run of the plugin.
 *
 * The test drives the **library entry point** (`runCli`) against the **real
 * graph**: the workspace is prepared by a real `git clone` of a local
 * repository, the documents are written by the test (the host does that in a
 * real session), and the verification gates are the only thing that is faked -
 * they would otherwise run `tsc`/`eslint`/`jest`/`playwright` for real.
 *
 * Every step asserts three things: the **exit code**, the **audience** of
 * the envelope and the **thread id**. They are the contract the host (the
 * `commands/*.md` LOOP) branches on, so a change that breaks them breaks the
 * plugin.
 *
 * **This is the in-process half of the end-to-end story.** The host does not
 * call `runCli` - it runs `bin/sdd-graph` as a **process**, and the exit code
 * of that process is the only thing it can see. The second describe block
 * below drives the real binary, so the process-level contract (the exit
 * status, and a resume that rehydrates the pending work order from the
 * sqlite file in a brand new process) is covered too.
 */

/** The task of the run (= the thread id). */
const TASK = 'e2e-demo';

/** The plugin root (the directory the binary lives in). */
const PLUGIN_ROOT = getPluginRoot();

/** The task of the child-process run. */
const CHILD_TASK = 'e2e-child';

/** The result of one command. */
interface Command {
  /** The exit code. */
  rc: number;
  /** The envelope of stdout (empty when stdout was empty). */
  out: Record<string, unknown> | undefined;
  /** The envelope of stderr (empty when stderr was empty). */
  err: Record<string, unknown> | undefined;
}

describe('端對端：真實的 CLI 走完一輪', () => {
  let ws: string;
  let cp: string;
  let lockFile: string;
  let fixture: GitFixture;
  let graph: CompiledSddGraph;
  let io: ReturnType<typeof captureIo>;
  let repoDir: string;
  let docsDir: string;
  let runtimeBefore: string[];
  let workspaceBefore: string[];

  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-e2e-'));
    // The workspace and the checkpoint live in a temp dir: the plugin root
    // must stay clean after the run.
    runtimeBefore = runtimeFiles();
    workspaceBefore = workspaceTasks();
    process.env.SDD_GRAPH_WORKSPACE_BASE = ws;
    cp = path.join(ws, 'checkpoints.sqlite');
    lockFile = path.join(ws, 'branch-runtime-lock.json');
    fixture = createGitFixture('sdd-e2e-git-');
    io = captureIo();
    graph = buildGraph({
      checkpointer: createCheckpointer(cp),
      lockPath: lockFile,
      // The four gates of the verification stage are the only thing that is
      // faked: they would otherwise run the tool chain of the fixture repo.
      verifyOptions: { runner: async () => ({ code: 0, stdout: '', stderr: '' }) },
    });
    repoDir = path.join(ws, TASK, 'repo');
    docsDir = path.join(repoDir, 'docs', TASK);
  });

  afterAll(() => {
    io.restore();
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
    fixture.cleanup();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  /** Run one command of the CLI and read what it said. */
  async function cli(args: string[]): Promise<Command> {
    const rc = await runCli(args, { graph, lockPath: lockFile });
    const captured = io.take();
    return {
      rc,
      out: captured.out.trim() === '' ? undefined : JSON.parse(captured.out),
      err: captured.err.trim() === '' ? undefined : JSON.parse(captured.err),
    };
  }

  /** The state of the run. */
  async function state(): Promise<Record<string, unknown>> {
    const snapshot = (await graph.getState({ configurable: { thread_id: TASK } })) as unknown as {
      values: Record<string, unknown>;
    };
    return snapshot.values;
  }

  /** The commit log of the cloned repository. */
  function gitLog(): string {
    return execFileSync('git', ['-C', repoDir, 'log', '--oneline'], { encoding: 'utf-8' });
  }

  /** Write a document of the run (the host does this in a real session). */
  function writeDoc(name: string, content: string): string {
    const file = path.join(docsDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
    return file;
  }

  /**
   * The human-facing mirror of the state, as it is on disk.
   *
   * @returns The parsed mirror.
   */
  function readMirror(): Record<string, unknown> {
    const file = path.join(docsDir, 'workflow-state.json');
    expect(fs.existsSync(file)).toBe(true);
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  }

  /** The result of a worker that finished its order. */
  function okResult(summary: string, changedFiles: string[] = []): string {
    return JSON.stringify({ status: 'ok', summary, changedFiles });
  }

  it('1. start：圖把工作區準備好，然後停在 collect_prd 問使用者要 PRD', async () => {
    const r = await cli(['start', '--task', TASK, '--repo', fixture.url]);

    expect(r.rc).toBe(2);
    expect(r.out?.threadId).toBe(TASK);
    expect(r.out?.kind).toBe('interrupt');
    expect(r.out?.audience).toBe('user');
    expect(r.out?.type).toBe('collect_prd');
    expect(r.out?.stage).toBe('prd');
    expect(r.err).toBeUndefined();

    // The repository was really cloned into the workspace.
    expect(fs.existsSync(path.join(repoDir, '.git'))).toBe(true);

    // **The mirror is written.** `workflow-state.json` is what a person (and
    // `sdd-graph status`) reads to see where the run is - it is written from
    // the graph's own state, into the cloned repository.
    const mirror = readMirror();
    expect(mirror.currentStage).toBe('prd');
    expect(mirror.requirementName).toBe(TASK);
    expect(mirror.version).toBe('1.1.0');
  });

  it('2. approve：使用者給了 PRD，圖問這份 PRD 能不能用', async () => {
    const r = await cli([
      'approve',
      '--task',
      TASK,
      '--payload',
      JSON.stringify({ prdMarkdown: PRD, figmaUrl: '' }),
    ]);

    expect(r.rc).toBe(2);
    expect(r.out?.threadId).toBe(TASK);
    expect(r.out?.audience).toBe('user');
    expect(r.out?.type).toBe('confirm_prd');

    // The PRD of the user is on disk.
    expect(fs.readFileSync(path.join(docsDir, 'prd.md'), 'utf-8')).toContain('# PRD');
  });

  it('3. approve：使用者確認 PRD，圖進 spec 階段並直接發 spec_writer 工作單', async () => {
    const r = await cli(['approve', '--task', TASK, '--payload', JSON.stringify({ approved: true })]);

    expect(r.rc).toBe(2);
    expect(r.out?.threadId).toBe(TASK);
    // 使用者在 collect_prd 就說過「沒有 Figma」了：spec 階段不得再問第二次。
    expect(r.out?.audience).toBe('host');
    expect(r.out?.type).toBe('work_order');
    expect(r.out?.stage).toBe('spec');

    const payload = r.out?.payload as { role: string; outputs: string[]; inputs: string[] };
    expect(payload.role).toBe('spec_writer');
    expect(payload.outputs).toEqual([
      path.join(docsDir, 'discovery.md'),
      path.join(docsDir, 'spec.md'),
    ]);
    expect(payload.inputs).toContain(path.join(docsDir, 'prd.md'));

    // The mirror follows the run.
    expect(readMirror().currentStage).toBe('spec');
  });

  it('5. 硬案例：拿 approve 去答一張 host 的單，必須回 1 audience_mismatch', async () => {
    const r = await cli(['approve', '--task', TASK, '--payload', JSON.stringify({ approved: true })]);

    expect(r.rc).toBe(1);
    expect(r.out).toBeUndefined();
    expect(r.err?.kind).toBe('error');
    expect(r.err?.code).toBe('audience_mismatch');

    // 圖沒有被推進：還是同一張 spec 工作單。
    const values = await state();
    expect(values.currentStage).toBe('spec');
  });

  it('6. 換會話：resume 重發同一張單，而且不重跑 bootstrap', async () => {
    const before = await state();
    const logBefore = gitLog();

    const r = await cli(['resume', '--task', TASK]);

    expect(r.rc).toBe(2);
    expect(r.out?.threadId).toBe(TASK);
    expect(r.out?.audience).toBe('host');
    const payload = r.out?.payload as { role: string; outputs: string[] };
    expect(payload.role).toBe('spec_writer');
    expect(payload.outputs).toEqual([
      path.join(docsDir, 'discovery.md'),
      path.join(docsDir, 'spec.md'),
    ]);

    // 同一輪：runId 沒變，repo 也沒有被重新複製。
    const after = await state();
    expect(after.runId).toBe(before.runId);
    expect(gitLog()).toBe(logBefore);
  });

  it('7. 硬案例：complete 說做完了但檔案沒落盤 → 同一張單再發一次，階段不動', async () => {
    const before = await state();

    const r = await cli([
      'complete',
      '--task',
      TASK,
      '--result',
      okResult('規格寫好了', [path.join(docsDir, 'spec.md')]),
    ]);

    expect(r.rc).toBe(2);
    expect(r.out?.threadId).toBe(TASK);
    expect(r.out?.audience).toBe('host');
    expect(r.out?.stage).toBe('spec');
    const payload = r.out?.payload as { role: string; outputs: string[] };
    expect(payload.role).toBe('spec_writer');
    expect(payload.outputs).toEqual([
      path.join(docsDir, 'discovery.md'),
      path.join(docsDir, 'spec.md'),
    ]);

    // 沒有檔案就沒有完成：階段不動，spec 階段的世代（重讀文件的次數）也不動。
    // 這一單不算失敗 —— `tddAttempts` 在這裡沒有意义（它只在 TDD 階段動），
    // 用它斷言等於什麼都沒斷言。
    const values = await state();
    expect(values.currentStage).toBe('spec');
    expect(generationOf(values)).toBe(generationOf(before));
  });

  it('8. 宿主把規格寫出來，complete 之後圖問這份規格能不能用', async () => {
    writeDoc('discovery.md', DISCOVERY);
    writeDoc('spec.md', SPEC);

    const r = await cli([
      'complete',
      '--task',
      TASK,
      '--result',
      okResult('規格寫好了', [path.join(docsDir, 'spec.md')]),
    ]);

    expect(r.rc).toBe(2);
    expect(r.out?.threadId).toBe(TASK);
    expect(r.out?.audience).toBe('user');
    expect(r.out?.type).toBe('confirm_spec');
  });

  it('9. approve：規格確認，圖發出 e2e_planner 工作單', async () => {
    const r = await cli(['approve', '--task', TASK, '--payload', JSON.stringify({ approved: true })]);

    expect(r.rc).toBe(2);
    expect(r.out?.threadId).toBe(TASK);
    expect(r.out?.audience).toBe('host');
    const payload = r.out?.payload as { role: string };
    expect(payload.role).toBe('e2e_planner');
  });

  it('10. 宿主把 e2e 計畫寫出來，complete 之後圖問這份計畫能不能用', async () => {
    writeDoc('e2e-plan.csv', E2E_PLAN);

    const r = await cli([
      'complete',
      '--task',
      TASK,
      '--result',
      okResult('計畫寫好了', [path.join(docsDir, 'e2e-plan.csv')]),
    ]);

    expect(r.rc).toBe(2);
    expect(r.out?.threadId).toBe(TASK);
    expect(r.out?.audience).toBe('user');
    expect(r.out?.type).toBe('confirm_e2e');
  });

  it('11. approve：計畫確認，圖發出 task_splitter 工作單', async () => {
    const r = await cli(['approve', '--task', TASK, '--payload', JSON.stringify({ approved: true })]);

    expect(r.rc).toBe(2);
    expect(r.out?.threadId).toBe(TASK);
    expect(r.out?.audience).toBe('host');
    const payload = r.out?.payload as { role: string };
    expect(payload.role).toBe('task_splitter');
  });

  it('12. 宿主把 tasks.md 寫出來，complete 之後圖問這份計畫能不能用', async () => {
    writeDoc('tasks.md', TASKS);

    const r = await cli([
      'complete',
      '--task',
      TASK,
      '--result',
      okResult('task 拆好了', [path.join(docsDir, 'tasks.md')]),
    ]);

    expect(r.rc).toBe(2);
    expect(r.out?.threadId).toBe(TASK);
    expect(r.out?.audience).toBe('user');
    expect(r.out?.type).toBe('confirm_tasks');
  });

  it('13. approve：task 確認，圖發出 developer 工作單', async () => {
    const r = await cli(['approve', '--task', TASK, '--payload', JSON.stringify({ approved: true })]);

    expect(r.rc).toBe(2);
    expect(r.out?.threadId).toBe(TASK);
    expect(r.out?.audience).toBe('host');
    const payload = r.out?.payload as { role: string; outputs: string[] };
    expect(payload.role).toBe('developer');
    // 範圍裡有實作檔，也要有這個 task 的測試檔（TDD 的第一步）
    expect(payload.outputs).toEqual([
      path.join(repoDir, 'src', 'greeting.ts'),
      path.join(repoDir, 'src', '__tests__', 'add-greeting.test.tsx'),
    ]);
  });

  it('14. 宿主把程式碼寫出來，complete 之後圖發出規格審查工作單', async () => {
    const source = path.join(repoDir, 'src', 'greeting.ts');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'export const greeting = (name: string) => `Hello, ${name}`;\n', 'utf-8');
    // 測試檔也要真的寫出來：工作單的輸出清單裡有它
    const testFile = path.join(repoDir, 'src', '__tests__', 'add-greeting.test.tsx');
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    fs.writeFileSync(testFile, "it('greets', () => {});\n", 'utf-8');

    const r = await cli(['complete', '--task', TASK, '--result', okResult('寫好了', [source, testFile])]);

    expect(r.rc).toBe(2);
    expect(r.out?.threadId).toBe(TASK);
    expect(r.out?.audience).toBe('host');
    const payload = r.out?.payload as { role: string };
    expect(payload.role).toBe('spec_reviewer');
  });

  it('15. complete：規格審查通過，圖發出品質審查工作單', async () => {
    const r = await cli([
      'complete',
      '--task',
      TASK,
      '--result',
      JSON.stringify({
        status: 'ok',
        summary: '規格都做到了',
        changedFiles: [],
        review: { role: 'spec', verdict: 'pass', issues: [] },
      }),
    ]);

    expect(r.rc).toBe(2);
    expect(r.out?.threadId).toBe(TASK);
    expect(r.out?.audience).toBe('host');
    const payload = r.out?.payload as { role: string };
    expect(payload.role).toBe('quality_reviewer');
  });

  it('16. complete：品質審查通過，四道關卡過了，圖走到 completed', async () => {
    const r = await cli([
      'complete',
      '--task',
      TASK,
      '--result',
      JSON.stringify({
        status: 'ok',
        summary: '寫得好而且是對的',
        changedFiles: [],
        review: { role: 'quality', verdict: 'pass', issues: [] },
      }),
    ]);

    expect(r.rc).toBe(0);
    expect(r.out?.kind).toBe('result');
    expect(r.out?.stage).toBe('completed');
    expect(r.out?.threadId).toBe(TASK);
    expect(r.err).toBeUndefined();

    const values = await state();
    expect(values.currentStage).toBe('completed');
  });

  it('17. 收工之後：外掛目錄沒有留下任何工作區或 checkpoint', async () => {
    // 工作區與 checkpoint 都在臨時目錄裡：外掛目錄乾乾淨淨。
    expect(fs.existsSync(path.join(ws, TASK))).toBe(true);
    // `runtime/` 與 `workspace/` 跟這一輪開始前一模一樣：這一輪沒有留下
    // 任何東西。
    //
    // **斷言的是「沒被動過」，不是「不存在」。** 外掛根目錄就是預設的
    // 工作區根目錄：開發者自己跑過一次插件之後，那兩個目錄就有東西了，
    // 斷言「不存在」會讓整套測試永遠紅下去 —— 而且那件事與這一輪無關。
    expect(runtimeFiles()).toEqual(runtimeBefore);
    expect(workspaceTasks()).toEqual(workspaceBefore);
  });
});

/**
 * The end-to-end run through the **real binary**.
 *
 * The host does not call `runCli` - it runs `bin/sdd-graph` as a **process**
 * and branches on the **exit status** of that process (`commands/start.md`).
 * Everything below is therefore spawned for real: one new process per
 * command, the sqlite checkpointer opened from disk, the workspace on disk.
 *
 * **This is the half the in-process test cannot cover.** A library call
 * returns a number; a shim that swallowed it would still pass an in-process
 * suite, and a "resume" that reused the same in-memory graph would never
 * prove that the pending work order survives the death of the process.
 *
 * **The flow runs in a copy of the plugin.** The binary finds the plugin
 * root from its own location, so a copy in a temp dir gets its own
 * `runtime/` (its own sqlite file) and its own workspace: the run of the
 * test never touches the repository, and no other run can disturb it (a
 * stale lock or a stale thread would otherwise change what the run does -
 * a run that finds a lock adopts the old workspace, a run that finds a
 * thread resumes it).
 *
 * The last step runs the **plugin's own** binary in the repository, to
 * prove that the shim the host really runs hands the exit code to the
 * process.
 */
describe('端對端：真的 spawn bin/sdd-graph（行程層級）', () => {
  /** The files the binary writes into `runtime/`. */
  const RUNTIME_FILES = [
    'checkpoints.sqlite',
    'checkpoints.sqlite-shm',
    'checkpoints.sqlite-wal',
    'branch-runtime-lock.json',
  ];

  /** The copy of the plugin the child processes run in. */
  let plugin: string;
  let fixture: GitFixture;
  /** What `runtime/` held before this suite ran. */
  let runtimeBefore: string[];
  /** What `workspace/tasks/` held before this suite ran. */
  let workspaceBefore: string[];

  beforeAll(() => {
    plugin = copyPlugin();
    fixture = createGitFixture('sdd-e2e-bin-git-');
    runtimeBefore = runtimeFiles();
    workspaceBefore = workspaceTasks();
  });

  afterAll(() => {
    fixture.cleanup();
    fs.rmSync(plugin, { recursive: true, force: true });
    // 外掛目錄必須跟這一輪開始前一模一樣：沒有 checkpoint、沒有工作區。
    //
    // **斷言的是「沒被動過」，不是「不存在」。** 外掛根目錄就是預設的
    // 工作區根目錄，而 `runtime/` 放著全域的 checkpoint 與分支鎖：開發者
    // 自己跑過一次插件之後，那兩個目錄就有東西了 —— 舊的斷言不但會讓整套
    // 測試永遠紅下去，`afterAll` 還會把**別人那一輪的 checkpoint 刪掉**。
    expect(runtimeFiles()).toEqual(runtimeBefore);
    expect(workspaceTasks()).toEqual(workspaceBefore);
  });

  /**
   * Run the binary in a **new process**.
   *
   * @param args - The arguments of the command.
   * @returns The exit status and what the process said.
   */
  function bin(args: string[]): Child {
    const result = spawnSync(path.join(plugin, 'bin', 'sdd-graph'), args, {
      cwd: plugin,
      encoding: 'utf-8',
      env: { ...process.env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return childOf(result);
  }

  /**
   * Run the **plugin's own** binary (the one in the repository).
   *
   * The binary finds the plugin root from its own location, so this one
   * writes into the **repository**: its checkpoint goes to `runtime/` and
   * its workspace to `workspace/tasks/`. The caller is responsible for
   * putting the workspace somewhere else (`SDD_GRAPH_WORKSPACE_BASE`) and
   * for cleaning up afterwards.
   *
   * @param args - The arguments of the command.
   * @param env - Extra environment variables for the child.
   * @returns The exit status and what the process said.
   */
  function ownBin(args: string[], env: Record<string, string> = {}): Child {
    const result = spawnSync(path.join(PLUGIN_ROOT, 'bin', 'sdd-graph'), args, {
      cwd: PLUGIN_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return childOf(result);
  }

  /** The workspace of the child run. */
  function repoDir(): string {
    return path.join(plugin, 'workspace', 'tasks', CHILD_TASK, 'repo');
  }

  /** The docs directory of the child run. */
  function docsDir(): string {
    return path.join(repoDir(), 'docs', CHILD_TASK);
  }

  it(
    '1. start：行程跑起來了，退出碼是 2，stdout 是 collect_prd 的信封',
    () => {
      const r = bin(['start', '--task', CHILD_TASK, '--repo', fixture.url]);

      expect(r.stdout).toContain('"kind":"interrupt"');
      expect(r.rc).toBe(2);
      expect(r.err).toBeUndefined();
      expect(r.out?.kind).toBe('interrupt');
      expect(r.out?.audience).toBe('user');
      expect(r.out?.type).toBe('collect_prd');
      expect(r.out?.threadId).toBe(CHILD_TASK);
      expect(r.out?.stage).toBe('prd');

      // 真的複製了 repo。
      expect(fs.existsSync(path.join(repoDir(), '.git'))).toBe(true);
    },
    120_000
  );

  it(
    '2. approve：新的行程用磁碟上的 checkpoint 接得上，PRD 也真的寫進 repo',
    () => {
      const r = bin([
        'approve',
        '--task',
        CHILD_TASK,
        '--payload',
        JSON.stringify({ prdMarkdown: PRD, figmaUrl: '' }),
      ]);

      expect(r.rc).toBe(2);
      expect(r.err).toBeUndefined();
      expect(r.out?.kind).toBe('interrupt');
      expect(r.out?.audience).toBe('user');
      expect(r.out?.type).toBe('confirm_prd');
      expect(r.out?.threadId).toBe(CHILD_TASK);

      expect(fs.readFileSync(path.join(docsDir(), 'prd.md'), 'utf-8')).toContain('# PRD');
    },
    120_000
  );

  it(
    '3. approve：確認 PRD 之後圖直接發 spec_writer 工作單（設計問過了就不再問）',
    () => {
      const r = bin(['approve', '--task', CHILD_TASK, '--payload', JSON.stringify({ approved: true })]);

      expect(r.rc).toBe(2);
      expect(r.out?.audience).toBe('host');
      expect(r.out?.type).toBe('work_order');
      expect(r.out?.stage).toBe('spec');
      expect(r.out?.threadId).toBe(CHILD_TASK);

      const payload = r.out?.payload as { role: string; outputs: string[]; inputs: string[] };
      expect(payload.role).toBe('spec_writer');
      expect(payload.outputs).toEqual([
        path.join(docsDir(), 'discovery.md'),
        path.join(docsDir(), 'spec.md'),
      ]);
      expect(payload.inputs).toContain(path.join(docsDir(), 'prd.md'));
    },
    120_000
  );

  it(
    '5. 換會話：全新的行程 resume，磁碟上的 checkpoint 讓同一張單再發一次',
    () => {
      // 記號放在 clone 出來的 repo 裡：新的行程若重新複製，記號就不見了。
      const marker = path.join(repoDir(), '.same-workspace');
      fs.writeFileSync(marker, 'same workspace', 'utf-8');

      const r = bin(['resume', '--task', CHILD_TASK]);

      expect(r.rc).toBe(2);
      expect(r.err).toBeUndefined();
      expect(r.out?.kind).toBe('interrupt');
      expect(r.out?.audience).toBe('host');
      expect(r.out?.type).toBe('work_order');
      expect(r.out?.threadId).toBe(CHILD_TASK);
      expect(r.out?.stage).toBe('spec');
      const payload = r.out?.payload as { role: string; outputs: string[] };
      expect(payload.role).toBe('spec_writer');
      expect(payload.outputs).toEqual([
        path.join(docsDir(), 'discovery.md'),
        path.join(docsDir(), 'spec.md'),
      ]);

      // 同一個工作區：沒有被重新複製。
      expect(fs.existsSync(marker)).toBe(true);
    },
    120_000
  );

  it(
    '6. 沒有 checkpoint 的話，resume 不得假裝有工作單（證明那張單真的在磁碟上）',
    () => {
      for (const name of RUNTIME_FILES) {
        if (name.startsWith('checkpoints.sqlite')) {
          fs.rmSync(path.join(plugin, 'runtime', name), { force: true });
        }
      }

      const r = bin(['resume', '--task', CHILD_TASK]);

      expect(r.rc).toBe(1);
      expect(r.out).toBeUndefined();
      expect(r.err?.kind).toBe('error');
      expect(r.err?.code).toBe('no_checkpoint');
    },
    120_000
  );

  it(
    '7. 外掛自己的 bin/sdd-graph：結束碼與信封都是真的行程說的',
    () => {
      // 這一次跑的是 **repository 裡的那支 shim**（README 叫使用者跑的那
      // 一支），而不是副本。
      //
      // **它一個狀態都不碰。** `change` 在圖被建起來之前就結束了：不開
      // checkpoint、不拿分支鎖、不寫工作區。這很重要 —— 這支 shim 的 plugin
      // root 就是 repository 自己，所以它寫的東西會落在**開發者自己的**
      // `runtime/` 與 `workspace/` 裡。
      //
      // 整條 `start` 的流程已經由上面的 1～6 走過了，而那幾個跑的就是
      // **同一支 shim 的副本**（`copyPlugin()` 逐位元組複製 `bin/`）。這裡
      // 補的是「repository 裡的那一支本身」：它找得到自己的 plugin root、
      // 找得到 tsx、跑得起 CLI，而且**把結束碼與信封交給行程**。
      const r = ownBin(['change', '--task', 'e2e-own']);

      expect(r.rc).toBe(1);
      expect(r.err?.kind).toBe('error');
      expect(r.err?.code).toBe('not_implemented');
      // 一個字都沒有留在 stdout：stdout 是給「發生了什麼」的，錯誤走 stderr。
      expect(r.out).toBeUndefined();

      // 這一輪沒有在 repository 裡留下任何東西。
      expect(runtimeFiles()).toEqual(runtimeBefore);
      expect(workspaceTasks()).toEqual(workspaceBefore);
    },
    120_000
  );
});

/** What one child process of the binary said. */
interface Child {
  /** The exit status of the process. */
  rc: number;
  /** Everything the process wrote to stdout. */
  stdout: string;
  /** Everything the process wrote to stderr. */
  stderr: string;
  /** The envelope on stdout (undefined when stdout was empty). */
  out: Record<string, unknown> | undefined;
  /** The envelope on stderr (undefined when stderr was empty). */
  err: Record<string, unknown> | undefined;
}

/**
 * Read the JSON envelope of a stream.
 *
 * @param text - What the process wrote.
 * @returns The envelope, or `undefined` when there was none.
 */
function parseEnvelope(text: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * What a child process of the binary said.
 *
 * @param result - What `spawnSync` returned.
 * @returns The exit status and the two streams.
 */
function childOf(result: {
  status: number | null;
  stdout: string | null;
  stderr: string | null;
}): Child {
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    rc: result.status ?? -1,
    stdout,
    stderr,
    out: parseEnvelope(stdout),
    err: parseEnvelope(stderr),
  };
}

/**
 * A copy of the plugin in a temp dir.
 *
 * The binary resolves the plugin root from its own location, so the copy
 * gets its own `runtime/` (its own sqlite file and its own branch lock) and
 * its own workspace. The run of the test therefore never touches the
 * repository, and nothing else can disturb it.
 *
 * @returns The directory of the copy.
 */
function copyPlugin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-e2e-plugin-'));
  for (const part of ['bin', 'src', 'prompts', '.claude-plugin']) {
    fs.cpSync(path.join(PLUGIN_ROOT, part), path.join(dir, part), { recursive: true });
  }
  fs.cpSync(path.join(PLUGIN_ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.chmodSync(path.join(dir, 'bin', 'sdd-graph'), 0o755);
  // 依賴只有一份：符號連結就好，不用複製整個 node_modules。
  fs.symlinkSync(path.join(PLUGIN_ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  // **實體路徑**：shim 用 `cd -P` 解析 plugin root（marketplace 的 symlink
  // 就是這樣被解析到真實目錄的），所以子行程回報的路徑是實體路徑。macOS 上
  // `/var` 是 `/private/var` 的 symlink —— 斷言與子行程必須用同一個路徑。
  return fs.realpathSync(dir);
}

/**
 * What is in the plugin root's `runtime/` directory.
 *
 * The plugin root is shared, so the tests compare the directory with what it
 * was before the run instead of demanding that it be empty: what matters is
 * that the run leaves nothing behind, not what somebody else left there.
 */
function runtimeFiles(): string[] {
  const dir = path.join(getPluginRoot(), 'runtime');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

/**
 * The task workspaces in the plugin root.
 *
 * The plugin root is the default workspace base, so a run that is started
 * for real leaves a task directory behind. Like {@link runtimeFiles}, this
 * exists so that the suite can compare the directory with what it was
 * before the run: a developer who ran the plugin once must not break the
 * suite for ever.
 */
function workspaceTasks(): string[] {
  const dir = path.join(getPluginRoot(), 'workspace', 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

/**
 * The generation of the spec stage - how many times the stage went back to
 * the beginning to read the documents again.
 *
 * @param values - The values of a state snapshot.
 * @returns The generation, or `undefined` when the stage never recorded one.
 */
function generationOf(values: Record<string, unknown>): string | undefined {
  const steps = values.stageSteps as Record<string, string> | undefined;
  return steps?.['spec/generation'];
}

/** The PRD the user gives. */
const PRD = [
  '# PRD: e2e demo',
  '',
  '需求：輸入名字，看到問候語。',
  '',
].join('\n');

/** The discovery document of the spec worker. */
const DISCOVERY = [
  '# Discovery: e2e demo',
  '',
  '- 讀了 PRD，沒有歧義。',
  '',
].join('\n');

/** The spec of the run. */
const SPEC = [
  '# SPEC: e2e demo',
  '',
  '## 背景',
  '',
  '使用者輸入名字，畫面顯示問候語。',
  '',
  '## Acceptance Criteria',
  '',
  '### AC-001: 輸入名字會看到問候語',
  '輸入 `Ada` 時，畫面上出現 `Hello, Ada`。',
  '',
  '## Non-goals',
  '',
  '- 不做多語系。',
  '',
].join('\n');

/** The e2e plan of the run. */
const E2E_PLAN = [
  'test_id,feature,scenario,steps,expected_result,priority',
  'E2E-001,Greeting,Greeting shows the name (AC-001),"Open /demo;Type Ada","The page shows Hello, Ada",high',
  '',
].join('\n');

/** The tasks of the run. */
const TASKS = [
  '# Tasks: e2e demo',
  '',
  '## Task List',
  '',
  '| Task ID | Title | Complexity | Priority | AC Refs |',
  '|---------|-------|------------|----------|---------|',
  '| TASK-add-greeting | Add greeting | S | high | AC-001 |',
  '',
  '## Task Details',
  '',
  '### TASK-add-greeting: Add greeting',
  '',
  '**Description**: 加一個會回問候語的函式。',
  '',
  '**Acceptance Criteria**:',
  '- 輸入名字會回 `Hello, <name>`',
  '',
  '**AC Refs**: AC-001',
  '',
  '**Files**:',
  '- `src/greeting.ts`',
  '',
].join('\n');
