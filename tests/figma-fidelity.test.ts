import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureFidelity } from '../src/figma/fidelity.js';
import type { RenderRunner } from '../src/figma/render.js';

/** Write a PNG of the given size. */
function writePng(file: string, width: number, height: number, colour: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = colour;
    png.data[i + 1] = colour;
    png.data[i + 2] = colour;
    png.data[i + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** A runner that draws a picture of the given size. */
function drawingRunner(width: number, height: number, colour = 255): RenderRunner {
  return async (req) => {
    writePng(req.out, width, height, colour);
    return { ok: true };
  };
}

describe('Figma 量測流程', () => {
  let dir: string;
  let docsDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-fidelity-'));
    docsDir = path.join(dir, 'docs', 'demo');
    fs.mkdirSync(path.join(docsDir, 'figma', 'screenshots'), { recursive: true });
    fs.mkdirSync(path.join(docsDir, 'figma', 'prototype'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('渲染失敗算硬失敗，報告裡寫得出原因', async () => {
    writePng(path.join(docsDir, 'figma', 'screenshots', '1-23.png'), 10, 10, 255);
    fs.writeFileSync(path.join(docsDir, 'figma', 'prototype', '1-23.html'), '<html></html>');

    const report = await measureFidelity({
      docsDir,
      repoDir: dir,
      runner: async () => ({ ok: false, error: 'playwright screenshot failed (code 1): boom' }),
    });

    expect(report.hardFailures).toBe(1);
    expect(report.frames[0].status).toBe('render_failed');
    expect(report.frames[0].error).toContain('boom');
  });

  it('缺原型頁算硬失敗', async () => {
    writePng(path.join(docsDir, 'figma', 'screenshots', '1-23.png'), 10, 10, 255);

    const report = await measureFidelity({
      docsDir,
      repoDir: dir,
      runner: drawingRunner(10, 10),
    });

    expect(report.hardFailures).toBe(1);
    expect(report.frames[0].status).toBe('missing_html');
    expect(report.frames[0].key).toBe('1-23');
  });

  it('尺寸對不上算硬失敗，而且不去比像素', async () => {
    writePng(path.join(docsDir, 'figma', 'screenshots', '1-23.png'), 10, 10, 255);
    fs.writeFileSync(path.join(docsDir, 'figma', 'prototype', '1-23.html'), '<html></html>');

    const report = await measureFidelity({
      docsDir,
      repoDir: dir,
      runner: drawingRunner(20, 20),
    });

    expect(report.hardFailures).toBe(1);
    expect(report.frames[0].status).toBe('size_mismatch');
    expect(report.frames[0].ratio).toBe(0);
  });

  it('全部量測成功時 hardFailures 是 0，報告寫到 figma/diff/', async () => {
    writePng(path.join(docsDir, 'figma', 'screenshots', '1-23.png'), 10, 10, 255);
    fs.writeFileSync(path.join(docsDir, 'figma', 'prototype', '1-23.html'), '<html></html>');

    const report = await measureFidelity({
      docsDir,
      repoDir: dir,
      runner: drawingRunner(10, 10),
    });

    expect(report.hardFailures).toBe(0);
    expect(report.frames[0].status).toBe('ok');
    expect(report.frames[0].ratio).toBe(0);
    expect(fs.existsSync(report.mdPath)).toBe(true);
    expect(fs.existsSync(report.jsonPath)).toBe(true);
    expect(fs.existsSync(path.join(docsDir, 'figma', 'diff', 'report.md'))).toBe(true);
    expect(fs.existsSync(path.join(docsDir, 'figma', 'diff', 'frames.json'))).toBe(true);
  });

  it('原型跟截圖不一樣時比例大於 0，而且差異圖會寫出來', async () => {
    writePng(path.join(docsDir, 'figma', 'screenshots', '1-23.png'), 10, 10, 255);
    fs.writeFileSync(path.join(docsDir, 'figma', 'prototype', '1-23.html'), '<html></html>');

    const report = await measureFidelity({
      docsDir,
      repoDir: dir,
      runner: drawingRunner(10, 10, 0),
    });

    expect(report.hardFailures).toBe(0);
    expect(report.frames[0].ratio).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(docsDir, 'figma', 'diff', '1-23.diff.png'))).toBe(true);
  });

  it('沒有任何截圖時不算硬失敗（沒有東西可比）', async () => {
    const report = await measureFidelity({
      docsDir,
      repoDir: dir,
      runner: drawingRunner(10, 10),
    });

    expect(report.hardFailures).toBe(0);
    expect(report.frames).toEqual([]);
  });

  it('截圖讀不出來時算硬失敗，說得出原因', async () => {
    fs.writeFileSync(path.join(docsDir, 'figma', 'screenshots', '1-23.png'), 'not a png');
    fs.writeFileSync(path.join(docsDir, 'figma', 'prototype', '1-23.html'), '<html></html>');

    const report = await measureFidelity({
      docsDir,
      repoDir: dir,
      runner: drawingRunner(10, 10),
    });

    expect(report.hardFailures).toBe(1);
    expect(report.frames[0].status).toBe('diff_failed');
    expect(report.frames[0].error).toContain('png');
  });
});
