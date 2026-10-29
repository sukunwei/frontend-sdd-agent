import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from '@langchain/langgraph';
import { routeAfterFailure } from '../src/subgraphs/verify.js';
import { buildVerifyGraph, readSnapshot } from './helpers/verify-graph.js';

describe('verify 失敗後回 tdd', () => {
  it('manual 選項必須路由回 tdd', () => {
    expect(routeAfterFailure('manual')).toBe('tdd');
  });

  it('skip 與 abort 不得路由到 tdd', () => {
    expect(routeAfterFailure('skip')).not.toBe('tdd');
    expect(routeAfterFailure('abort')).not.toBe('tdd');
  });
});

describe('verify 節點', () => {
  it('關卡失敗時中斷使用者，選 manual 之後圖回到 tdd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdd-verify-'));
    try {
      const { graph, runs } = buildVerifyGraph({
        dbPath: join(dir, 'cp.sqlite'),
        repoDir: dir,
        // Every gate fails: the node has to ask the user.
        runner: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
      });
      const cfg = { configurable: { thread_id: 'thr-verify' } };

      await graph.invoke({ requirementName: 'demo' } as never, cfg);

      const parked = await readSnapshot(graph, cfg);
      const interrupt = parked.tasks[0]?.interrupts?.[0]?.value as
        | { audience: string; type: string; failed: string[]; options: string[]; logs: Record<string, string> }
        | undefined;
      expect(interrupt?.audience).toBe('user');
      expect(interrupt?.type).toBe('verify_failed');
      expect(interrupt?.failed).toEqual(['lint:ts']);
      expect(interrupt?.options).toEqual(['manual', 'skip', 'abort']);
      // The user has to be able to find the log of the gate that failed.
      expect(interrupt?.logs?.['lint:ts']).toBe(join(dir, 'docs', 'demo', 'verify', 'lint:ts.log'));

      await graph.invoke(new Command({ resume: { action: 'manual' } }), cfg);

      expect(runs.tdd).toBe(1);
      const after = await readSnapshot(graph, cfg);
      expect(after.values.currentStage).toBe('tdd');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('關卡每一輪只跑一次：停下來之前與 resume 之後的執行次數一樣', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdd-verify-'));
    try {
      const calls: string[][] = [];
      const { graph, runs } = buildVerifyGraph({
        dbPath: join(dir, 'cp.sqlite'),
        repoDir: dir,
        tddParks: true,
        runner: async (cmd) => {
          calls.push(cmd);
          return { code: 1, stdout: '', stderr: 'boom' };
        },
      });
      const cfg = { configurable: { thread_id: 'thr-verify-once' } };

      await graph.invoke({ requirementName: 'demo' } as never, cfg);

      // 一個失敗的關卡：1 次執行 + 2 次重試。
      expect(calls.length).toBe(3);

      await graph.invoke(new Command({ resume: { action: 'manual' } }), cfg);

      // resume 不會再跑一次關卡 - 關卡在停下來之前就已經跑完了。
      expect(calls.length).toBe(3);
      expect(runs.tdd).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('答案要依已經記錄的結果處理，不能被後來一次通過蓋掉', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdd-verify-'));
    try {
      let n = 0;
      const { graph, runs } = buildVerifyGraph({
        dbPath: join(dir, 'cp.sqlite'),
        repoDir: dir,
        tddParks: true,
        // 前三次失敗（1 次 + 2 次重試），之後就會通過。
        runner: async () => {
          n += 1;
          return { code: n <= 3 ? 1 : 0, stdout: '', stderr: 'boom' };
        },
      });
      const cfg = { configurable: { thread_id: 'thr-verify-flaky' } };

      await graph.invoke({ requirementName: 'demo' } as never, cfg);
      await graph.invoke(new Command({ resume: { action: 'manual' } }), cfg);

      // 使用者回答 manual：圖必須回到 tdd。就算這時候關卡再跑一次會通過，
      // 也不能把這次的失敗當成沒發生過。
      expect(runs.tdd).toBe(1);
      expect(n).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skip 也要留下 blocker，不然看起來跟乾淨通過一樣', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdd-verify-'));
    try {
      const { graph, runs } = buildVerifyGraph({
        dbPath: join(dir, 'cp.sqlite'),
        repoDir: dir,
        runner: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
      });
      const cfg = { configurable: { thread_id: 'thr-verify-skip' } };

      await graph.invoke({ requirementName: 'demo' } as never, cfg);
      await graph.invoke(new Command({ resume: { action: 'skip' } }), cfg);

      expect(runs.tdd).toBe(0);
      const after = await readSnapshot(graph, cfg);
      expect(after.values.currentStage).toBe('completed');
      const blockers = after.values.blockers as Array<{ reason: string }>;
      expect(blockers).toHaveLength(1);
      expect(blockers[0].reason).toContain('skipped');
      expect(blockers[0].reason).toContain('lint:ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('abort 會留下 blocker，而且不是乾淨的完成', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdd-verify-'));
    try {
      const { graph, runs } = buildVerifyGraph({
        dbPath: join(dir, 'cp.sqlite'),
        repoDir: dir,
        runner: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
      });
      const cfg = { configurable: { thread_id: 'thr-verify-abort' } };

      await graph.invoke({ requirementName: 'demo' } as never, cfg);
      await graph.invoke(new Command({ resume: { action: 'abort' } }), cfg);

      expect(runs.tdd).toBe(0);
      const after = await readSnapshot(graph, cfg);
      expect(after.values.currentStage).toBe('completed');
      expect(after.values.blockers).toHaveLength(1);
      const blockers = after.values.blockers as Array<{ reason: string }>;
      expect(blockers[0].reason).toContain('lint:ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
