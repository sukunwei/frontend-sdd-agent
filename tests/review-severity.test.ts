import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ReviewResultSchema } from '../src/state/schema.js';

const PROMPTS = path.join(import.meta.dirname, '..', 'prompts');

/** The severity list a prompt tells the reviewer to use. */
function severityList(file: string): string {
  const content = fs.readFileSync(path.join(PROMPTS, file), 'utf-8');
  const match = /"severity":\s*"([^"]+)"/.exec(content);
  return match?.[1] ?? '';
}

describe('評審的嚴重度', () => {
  it('schema 要認得 prompt 用的每一個嚴重度', () => {
    for (const file of ['reviewer.md']) {
      const list = severityList(file);
      expect(list).not.toBe('');
      for (const severity of list.split('|').map((s) => s.trim())) {
        const parsed = ReviewResultSchema.safeParse({
          role: 'spec',
          verdict: 'fail',
          issues: [{ file: 'a.ts', message: 'x', severity }],
        });
        expect(parsed.success, `${file} 的 ${severity} 不在 schema 裡`).toBe(true);
      }
    }
  });

  it('審查者只有一份 prompt：嚴重度清單不會漂移', () => {
    const files = fs.readdirSync(PROMPTS).filter((name) => name.endsWith('-reviewer.md'));
    expect(files).toEqual([]);
    expect(fs.existsSync(path.join(PROMPTS, 'reviewer.md'))).toBe(true);
  });

  it('品質審查者的門檻中間不能有洞（2 或 3 個 high 要 fail）', () => {
    const content = fs.readFileSync(path.join(PROMPTS, 'reviewer.md'), 'utf-8');
    expect(content).toContain('high 問題 2 個或以上');
    expect(content).toContain('high 問題 0 或 1 個');
    expect(content).toContain('2 或 3 個 high 問題');
    // 舊的說法（超過 3 個 fail、不到 2 個 pass）中間留了一個沒人負責的區間
    expect(content).not.toContain('high 問題超過 3 個');
  });
});
