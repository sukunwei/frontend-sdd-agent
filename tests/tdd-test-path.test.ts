import { describe, expect, it } from 'vitest';
import { taskTestPath } from '../src/nodes/tdd.js';

describe('task 的測試檔路徑', () => {
  it('單元測試檔是 .ts，不是 .tsx', () => {
    expect(taskTestPath({ id: 'TASK-setup-qrcode-page-route' } as any)).toBe(
      'src/__tests__/setup-qrcode-page-route.test.ts'
    );
  });

  it('路徑由 task id 派生，每一輪都一樣', () => {
    expect(taskTestPath({ id: 'TASK-add-e2e-tests' } as any)).toBe(
      'src/__tests__/add-e2e-tests.test.ts'
    );
  });
});
