import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCheck, runCommand, VERIFY_CHECKS } from '../src/nodes/verify-checks.js';
import { buildVerifyGraph, readSnapshot } from './helpers/verify-graph.js';

/** A temp directory that is removed again after the test. */
function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-vlog-'));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

describe('verify 重試', () => {
  it('四關順序固定，只有 lint 可自動修', () => {
    expect(VERIFY_CHECKS.map(c => c.name)).toEqual(['lint:ts', 'lint', 'test', 'e2e']);
    expect(VERIFY_CHECKS.filter(c => c.fixable).map(c => c.name)).toEqual(['lint']);
  });

  it('每一關的指令都是固定的，只有 lint 帶 --fix', () => {
    const commands = Object.fromEntries(VERIFY_CHECKS.map(c => [c.name, c.command]));
    expect(commands).toEqual({
      'lint:ts': ['npx', 'tsc', '--noEmit'],
      lint: ['npx', 'eslint', '.', '--ext', '.ts,.tsx', '--fix'],
      test: ['npx', 'jest', '--passWithNoTests', '--no-coverage'],
      e2e: ['npx', 'playwright', 'test'],
    });
  });

  it('eslint 失敗後 --fix 通過，status 必須是 fixed 且指令帶 --fix', async () => {
    await withTempDir(async (dir) => {
      const calls: string[][] = [];
      let n = 0;
      const r = await runCheck('lint', dir, {
        docsDir: dir,
        runner: async (cmd) => {
          calls.push(cmd);
          n += 1;
          return { code: n === 1 ? 1 : 0, stdout: '', stderr: '' };
        },
      });
      expect(r.status).toBe('fixed');
      expect(calls[0]).toContain('--fix');
      // eslint 的第一次執行已經改過檔案，所以要再跑一次才知道修好了。
      expect(calls.length).toBe(2);
    });
  });

  it('非 fixable 的關卡失敗就是 failed，不會變 fixed', async () => {
    await withTempDir(async (dir) => {
      const calls: string[][] = [];
      const r = await runCheck('test', dir, {
        docsDir: dir,
        runner: async (cmd) => {
          calls.push(cmd);
          return { code: 1, stdout: '', stderr: 'boom' };
        },
      });
      expect(r.status).toBe('failed');
      expect(r.exitCode).toBe(1);
      // 沒有 --fix 的關卡不會重跑。
      expect(calls.length).toBe(1);
    });
  });

  it('日誌必須寫到 verify/<name>.log', async () => {
    await withTempDir(async (dir) => {
      const docsDir = join(dir, 'docs', 'demo');
      const r = await runCheck('test', dir, {
        docsDir,
        runner: async () => ({ code: 1, stdout: 'out', stderr: 'err' }),
      });
      expect(r.log).toContain('err');

      const logFile = join(docsDir, 'verify', 'test.log');
      expect(existsSync(logFile)).toBe(true);
      expect(readFileSync(logFile, 'utf8')).toContain('err');
    });
  });

  it('逾時算失敗，而且日誌要記錄 timeout', async () => {
    await withTempDir(async (dir) => {
      const result = await runCommand(
        [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
        dir,
        100
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('timeout');
    });
  });
});

describe('verify 關卡順序', () => {
  it('四關依序跑過，全部通過時圖走到 completed', async () => {
    await withTempDir(async (dir) => {
      const calls: string[][] = [];
      const { graph } = buildVerifyGraph({
        dbPath: join(dir, 'cp.sqlite'),
        repoDir: dir,
        runner: async (cmd) => {
          calls.push(cmd);
          return { code: 0, stdout: '', stderr: '' };
        },
      });
      const cfg = { configurable: { thread_id: 'thr-verify-ok' } };

      await graph.invoke({ requirementName: 'demo' } as never, cfg);

      expect(calls.map((cmd) => cmd[1])).toEqual(['tsc', 'eslint', 'jest', 'playwright']);

      const after = await readSnapshot(graph, cfg);
      expect(after.values.currentStage).toBe('completed');
      const checks = (after.values.verification as { checks: Array<{ name: string; status: string }> })
        .checks;
      expect(checks.map((check) => check.name)).toEqual(['lint:ts', 'lint', 'test', 'e2e']);
      expect(checks.every((check) => check.status === 'passed')).toBe(true);
    });
  });

  it('失敗的關卡最多重試兩次，後面的關卡不跑', async () => {
    await withTempDir(async (dir) => {
      const calls: string[][] = [];
      const { graph } = buildVerifyGraph({
        dbPath: join(dir, 'cp.sqlite'),
        repoDir: dir,
        runner: async (cmd) => {
          calls.push(cmd);
          return { code: 1, stdout: '', stderr: 'boom' };
        },
      });
      const cfg = { configurable: { thread_id: 'thr-verify-retry' } };

      await graph.invoke({ requirementName: 'demo' } as never, cfg);

      // 1 次執行 + 2 次重試，然後才問使用者。
      expect(calls.length).toBe(3);
      expect(calls.every((cmd) => cmd[1] === 'tsc')).toBe(true);

      const after = await readSnapshot(graph, cfg);
      const checks = (after.values.verification as {
        checks: Array<{ name: string; status: string; retries: number; error?: string }>;
      }).checks;
      const failed = checks.find((check) => check.name === 'lint:ts');
      expect(failed?.status).toBe('failed');
      expect(failed?.retries).toBe(2);
      expect(failed?.error).toContain('boom');
      // 第一關就失敗了，後面的關卡沒有跑。
      expect(checks.find((check) => check.name === 'lint')?.status).toBe('pending');
      expect(checks.find((check) => check.name === 'test')?.status).toBe('pending');
      expect(checks.find((check) => check.name === 'e2e')?.status).toBe('pending');
    });
  });
});
