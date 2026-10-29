import { describe, expect, it } from 'vitest';
import { generateBranchName, normalizeTaskName } from '../src/runtime/task-name.js';

describe('task name 正規化', () => {
  it('與既有 runtime 的六步 pipeline 行為一致', () => {
    expect(normalizeTaskName('Checkout Page Redesign 2024')).toBe('checkout-page-redesign-2024');
    expect(normalizeTaskName('  a/b:c  ')).toBe('a-b-c');
    expect(normalizeTaskName('')).toBe('task');
    expect(normalizeTaskName('!!!')).toBe('task');
  });

  it('分支名固定 task/<name>', () => {
    expect(generateBranchName('qrcode-app')).toBe('task/qrcode-app');
  });
});
