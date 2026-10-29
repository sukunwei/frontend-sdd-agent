import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from '@langchain/langgraph';
import { buildGraph } from '../src/graph/compile.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';
import { getLock } from '../src/runtime/branch-lock.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type { GitFixture } from './helpers/git-fixture.js';

/**
 * Count the git invocations so the tests can prove that the bootstrap node
 * retries the clone and that a rejected repository URL never reaches git.
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

/** A local `file://` repository the bootstrap node can really clone. */
let fixture: GitFixture;

beforeAll(() => {
  fixture = createGitFixture('sdd-boot-remote-');
});

afterAll(() => {
  fixture.cleanup();
});

describe('bootstrap 節點', () => {

  let ws: string;
  let lockFile: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-boot-'));
    lockFile = path.join(ws, 'branch-runtime-lock.json');
    process.env.SDD_GRAPH_WORKSPACE_BASE = ws;
    gitCalls.length = 0;
  });

  afterEach(() => {
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
    fs.rmSync(ws, { recursive: true, force: true });
  });

  /** Build the real graph (no injected bootstrap node) and run one thread. */
  async function runBootstrap(requirementName: string, repoUrl: string): Promise<any> {
    const { g, cfg } = bootstrapGraph(requirementName);
    await g.invoke({ requirementName, repoUrl }, cfg);
    return g.getState(cfg);
  }

  /** The real graph plus the config of one thread. */
  function bootstrapGraph(requirementName: string): { g: any; cfg: any } {
    const g = buildGraph({
      checkpointer: createCheckpointer(path.join(ws, 'cp.sqlite')),
      lockPath: lockFile,
    });
    return { g, cfg: { configurable: { thread_id: requirementName } } };
  }

  /** How many times the clone was tried. */
  function cloneCount(): number {
    return gitCalls.filter((args) => args[0] === 'clone').length;
  }

  it('準備成功時必須建立工作區、拿到鎖並前進到 prd', async () => {
    const snap = await runBootstrap('ok-task', fixture.url);

    expect(snap.values.bootstrapped).toBe(true);
    expect(snap.values.currentStage).toBe('prd');
    expect(snap.values.requirementName).toBe('ok-task');
    expect(snap.values.branch).toBe('task/ok-task');
    expect(snap.values.repoPath).toBe(path.join(ws, 'ok-task', 'repo'));
    expect(String(snap.values.runId)).toMatch(/^run_/);

    // repo 真的被 clone 了，鎖也拿到了
    expect(fs.existsSync(path.join(ws, 'ok-task', 'repo', '.git'))).toBe(true);
    expect(getLock(lockFile)?.taskName).toBe('ok-task');
  });

  it('clone 失敗時必須重試兩次再中斷', async () => {
    const snap = await runBootstrap('dead-task', 'file:///nope-does-not-exist');

    const payload = snap.tasks[0].interrupts[0].value;
    expect(payload.audience).toBe('user');
    expect(payload.type).toBe('bootstrap_failed');
    expect(payload.code).toBe('git_error');

    // 一次 clone 失敗 = 一次 ls-remote + 一次 ls-remote + 一次 clone
    const clones = gitCalls.filter((args) => args[0] === 'clone');
    expect(clones).toHaveLength(3);
  });

  it('每次 approve 的 clone 次數不得累加', async () => {
    const { g, cfg } = bootstrapGraph('dead-task');
    await g.invoke({ requirementName: 'dead-task', repoUrl: 'file:///nope-does-not-exist' }, cfg);
    const afterFirstRun = cloneCount();

    await g.invoke(new Command({ resume: { approved: true } }), cfg);
    const afterFirstApprove = cloneCount();

    await g.invoke(new Command({ resume: { approved: true } }), cfg);
    const afterSecondApprove = cloneCount();

    // 每一次 approve 的 clone 次數都一樣：不得愈滾愈多
    expect(afterFirstApprove - afterFirstRun).toBeGreaterThan(0);
    expect(afterFirstApprove - afterFirstRun).toBe(afterSecondApprove - afterFirstApprove);
    // 而且 run 仍然停在 clone 失敗上
    const snap: any = await g.getState(cfg);
    expect(snap.tasks[0].interrupts[0].value.type).toBe('bootstrap_failed');
  });

  it('repoUrl 以 - 開頭時必須拒絕，不得交給 git', async () => {
    const snap = await runBootstrap('evil-task', '--upload-pack=id');

    const payload = snap.tasks[0].interrupts[0].value;
    expect(payload.type).toBe('bootstrap_failed');
    expect(payload.code).toBe('validation_error');
    expect(gitCalls).toHaveLength(0);
    expect(snap.values.bootstrapped).toBe(false);
  });

  it('repoUrl 含 shell 元字元時必須拒絕', async () => {
    const snap = await runBootstrap('evil-task-2', 'file:///tmp/x;id');

    const payload = snap.tasks[0].interrupts[0].value;
    expect(payload.code).toBe('validation_error');
    expect(gitCalls).toHaveLength(0);
  });
});
