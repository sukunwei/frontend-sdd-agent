import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { playwrightRunner, pngSize } from '../src/figma/render.js';
import type { ChildProcessLike, SpawnFn } from '../src/figma/render.js';

/** A child that closes with the given code and stderr. */
function fakeChild(code: number, stderr = ''): ChildProcessLike {
  return {
    stderr: {
      on(_event: 'data', listener: (chunk: unknown) => void): void {
        if (stderr !== '') listener(stderr);
      },
    },
    on(event: 'close' | 'error', listener: ((code: number | null) => void) | ((error: Error) => void)): void {
      if (event === 'close') (listener as (c: number | null) => void)(code);
    },
  };
}

describe('Figma 渲染器', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-render-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pngSize 讀得出圖片的寬高', () => {
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, PNG.sync.write(new PNG({ width: 3, height: 5 })));
    expect(pngSize(file)).toEqual({ width: 3, height: 5 });
  });

  it('檔案不是圖片時報錯說得出原因', () => {
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, 'not a png');
    expect(() => pngSize(file)).toThrow(/png/i);
  });

  it('runner 失敗時回報錯誤訊息，不是丟例外', async () => {
    const runner = playwrightRunner({
      spawn: () => fakeChild(1, 'browser missing'),
      resolvePlaywright: () => '/repo/node_modules/.bin/playwright',
    });
    const result = await runner({
      html: '/x/a.html',
      out: '/x/a.png',
      width: 100,
      height: 50,
      cwd: '/repo',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('playwright');
    expect(result.error).toContain('browser missing');
  });

  it('runner 成功時 ok 為 true', async () => {
    const runner = playwrightRunner({
      spawn: () => fakeChild(0),
      resolvePlaywright: () => '/repo/node_modules/.bin/playwright',
    });
    const result = await runner({
      html: '/x/a.html',
      out: '/x/a.png',
      width: 100,
      height: 50,
      cwd: '/repo',
    });
    expect(result.ok).toBe(true);
  });

  it('runner 用對的參數：目標 repo 自己的 playwright、viewport 尺寸、檔案網址、輸出路徑、cwd', async () => {
    const calls: Array<{ cmd: string; args: string[]; options: { cwd: string } }> = [];
    const spawn: SpawnFn = (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return fakeChild(0);
    };
    const runner = playwrightRunner({
      spawn,
      resolvePlaywright: () => '/repo/node_modules/.bin/playwright',
    });
    await runner({ html: '/x/a.html', out: '/x/a.png', width: 100, height: 50, cwd: '/repo' });

    expect(calls).toHaveLength(1);
    // **不是 npx**：npx 會在目標 repo 沒有 Playwright 的時候自己去下載一份，
    // 而且量到的不是這個專案的那一份。
    expect(calls[0].cmd).toBe('/repo/node_modules/.bin/playwright');
    expect(calls[0].args).toEqual([
      'screenshot',
      '--viewport-size=100,50',
      'file:///x/a.html',
      '/x/a.png',
    ]);
    expect(calls[0].options.cwd).toBe('/repo');
  });

  it('目標 repo 沒有 Playwright 時是環境問題，不是頁子的問題', async () => {
    // 目標 repo 沒有 Playwright：什麼都不跑，直接說清楚。
    let ran = false;
    const runner = playwrightRunner({
      spawn: () => {
        ran = true;
        return fakeChild(0);
      },
      resolvePlaywright: () => undefined,
    });
    const result = await runner({
      html: '/x/a.html',
      out: '/x/a.png',
      width: 100,
      height: 50,
      cwd: '/repo',
    });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('environment');
    expect(result.error).toContain('Playwright');
    // 沒有瀏覽器就不能只說「渲染失敗」：那會被當成 HTML 的問題。
    expect(result.error).not.toBe('render failed');
    expect(ran).toBe(false);
  });

  it('渲染失敗是頁子的問題（不是環境問題）', async () => {
    const runner = playwrightRunner({
      spawn: () => fakeChild(1, 'browser missing'),
      resolvePlaywright: () => '/repo/node_modules/.bin/playwright',
    });
    const result = await runner({
      html: '/x/a.html',
      out: '/x/a.png',
      width: 100,
      height: 50,
      cwd: '/repo',
    });
    expect(result.kind).toBe('page');
    expect(result.error).toContain('browser missing');
  });

  it('瀏覽器沒有安裝是環境問題（不是頁子的問題）', async () => {
    const runner = playwrightRunner({
      spawn: () => fakeChild(1, "Executable doesn't exist at /Users/x/Library/Caches/ms-playwright"),
      resolvePlaywright: () => '/repo/node_modules/.bin/playwright',
    });
    const result = await runner({
      html: '/x/a.html',
      out: '/x/a.png',
      width: 100,
      height: 50,
      cwd: '/repo',
    });
    expect(result.kind).toBe('environment');
  });

  it('渲染卡住要有預算：逾時算失敗，而且要把孩子殺掉', async () => {
    let killed = false;
    const hanging: ChildProcessLike = {
      stderr: null,
      on: (event: 'close' | 'error', listener: never) => {
        if (event === 'close') return undefined;
        return undefined;
      },
      kill: () => {
        killed = true;
        return true;
      },
    };
    const runner = playwrightRunner({
      spawn: () => hanging,
      resolvePlaywright: () => '/repo/node_modules/.bin/playwright',
      timeoutMs: 20,
    });
    const result = await runner({
      html: '/x/a.html',
      out: '/x/a.png',
      width: 100,
      height: 50,
      cwd: '/repo',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timeout');
    expect(killed).toBe(true);
  });

  it('spawn 本身就出錯時回報錯誤，不是丟例外', async () => {
    const runner = playwrightRunner({
      spawn: () => {
        throw new Error('no playwright here');
      },
      resolvePlaywright: () => '/repo/node_modules/.bin/playwright',
    });
    const result = await runner({
      html: '/x/a.html',
      out: '/x/a.png',
      width: 100,
      height: 50,
      cwd: '/repo',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no playwright here');
  });
});
