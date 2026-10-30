import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReport, comparePng, findFramePairs } from '../src/figma/measure.js';

/** A PNG of the given size, filled with one colour. */
function solidPng(width: number, height: number, colour: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = colour;
    png.data[i + 1] = colour;
    png.data[i + 2] = colour;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe('Figma 量測的純函式', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-figma-'));
    fs.mkdirSync(path.join(dir, 'figma', 'screenshots'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'figma', 'prototype'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pngjs 的讀圖與尺寸是對的（鎖住匯入形式）', () => {
    const buf = solidPng(2, 2, 255);
    const read = PNG.sync.read(buf);
    expect(read.width).toBe(2);
    expect(read.height).toBe(2);
  });

  it('每張截圖都要配到一個同名原型的 html', () => {
    fs.writeFileSync(path.join(dir, 'figma', 'screenshots', '1-23.png'), 'x');
    fs.writeFileSync(path.join(dir, 'figma', 'screenshots', '1-24.png'), 'x');
    fs.writeFileSync(path.join(dir, 'figma', 'prototype', '1-23.html'), '<html></html>');

    const found = findFramePairs(dir);
    expect(found.pairs.map((p) => p.key)).toEqual(['1-23']);
    expect(found.pairs[0].screenshot).toBe(path.join(dir, 'figma', 'screenshots', '1-23.png'));
    expect(found.pairs[0].html).toBe(path.join(dir, 'figma', 'prototype', '1-23.html'));
    expect(found.missingHtml).toEqual(['1-24']);
  });

  it('配對結果是照 key 排序的', () => {
    for (const key of ['2-10', '1-23', '10-2']) {
      fs.writeFileSync(path.join(dir, 'figma', 'screenshots', `${key}.png`), 'x');
      fs.writeFileSync(path.join(dir, 'figma', 'prototype', `${key}.html`), '<html></html>');
    }
    expect(findFramePairs(dir).pairs.map((p) => p.key)).toEqual(['1-23', '10-2', '2-10']);
  });

  it('沒有截圖時配對結果是空的，不是錯誤', () => {
    expect(findFramePairs(dir).pairs).toEqual([]);
    expect(findFramePairs(dir).missingHtml).toEqual([]);
  });

  it('兩張一樣的圖比對出來比例是 0', () => {
    const a = solidPng(4, 4, 255);
    const result = comparePng(a, a);
    expect(result.ratio).toBe(0);
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
  });

  it('兩張不同的圖比對出來比例大於 0', () => {
    const a = solidPng(4, 4, 255);
    const b = solidPng(4, 4, 0);
    expect(comparePng(a, b).ratio).toBeGreaterThan(0);
  });

  it('尺寸不同時不比像素，比例是 0', () => {
    const a = solidPng(4, 4, 255);
    const b = solidPng(8, 8, 0);
    const result = comparePng(a, b);
    expect(result.ratio).toBe(0);
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
  });

  it('報告裡每一個 frame 都要有一行，含比率與狀態', () => {
    const frames = [
      { key: '1-23', status: 'ok' as const, ratio: 0.0123, width: 1440, height: 900 },
      { key: '1-24', status: 'render_failed' as const, ratio: 0, width: 0, height: 0, error: 'boom' },
    ];
    const { md, json } = buildReport(frames);
    expect(md).toContain('1-23');
    expect(md).toContain('1.23%');
    expect(md).toContain('1-24');
    expect(md).toContain('render_failed');
    expect(JSON.parse(json)).toEqual(frames);
  });

  it('報告裡要寫得出失敗的原因（瀏覽器的 stderr）', () => {
    const { md } = buildReport([
      {
        key: '1-23',
        status: 'render_failed',
        ratio: 0,
        width: 0,
        height: 0,
        error: 'playwright screenshot failed (code 1): browser missing',
      },
    ]);
    expect(md).toContain('browser missing');
  });

  it('報告必須寫明字體差異會讓分數失真', () => {
    expect(buildReport([]).md).toContain('字體');
  });
});
