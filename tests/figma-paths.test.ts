import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPrototype } from '../src/figma/paths.js';

describe('原型檢查', () => {
  let dir: string;
  let docsDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-paths-'));
    docsDir = path.join(dir, 'docs', 'demo');
    fs.mkdirSync(path.join(docsDir, 'figma', 'screenshots'), { recursive: true });
    fs.mkdirSync(path.join(docsDir, 'figma', 'prototype'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('每張截圖都要有對應的原型頁', () => {
    fs.writeFileSync(path.join(docsDir, 'figma', 'screenshots', '1-23.png'), 'x');
    fs.writeFileSync(path.join(docsDir, 'figma', 'prototype', '1-23.html'), '<html></html>');
    expect(checkPrototype(docsDir).ok).toBe(true);
    expect(checkPrototype(docsDir).missing).toEqual([]);
  });

  it('缺一個原型頁時只報那一個，而且用的是相對路徑', () => {
    fs.writeFileSync(path.join(docsDir, 'figma', 'screenshots', '1-23.png'), 'x');
    fs.writeFileSync(path.join(docsDir, 'figma', 'screenshots', '1-24.png'), 'x');
    fs.writeFileSync(path.join(docsDir, 'figma', 'prototype', '1-23.html'), '<html></html>');
    const check = checkPrototype(docsDir);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(['figma/prototype/1-24.html']);
  });

  it('沒有截圖就算通過（沒有 Figma 的需求不受影響）', () => {
    expect(checkPrototype(docsDir).ok).toBe(true);
    expect(checkPrototype(docsDir).missing).toEqual([]);
  });
});
