import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { captureIo } from './helpers/capture-io.js';

describe('change 入口', () => {
  it('v1 必須明確報未實作而不是 silently 忽略', async () => {
    const io = captureIo();
    try {
      const rc = await runCli(['change', '--task', 'whatever']);
      const captured = io.take();

      expect(rc).toBe(1);
      expect(captured.out).toBe('');
      const err = JSON.parse(captured.err);
      expect(err.kind).toBe('error');
      expect(err.code).toBe('not_implemented');
      expect(err.message).toBe(
        '/sdd-graph:change 尚未實作：v1 只預留入口，圖狀態仍由階段路由推進。'
      );
    } finally {
      io.restore();
    }
  });

  it('change 不得動到圖：沒有 task 的時候也不該靜靜地成功', async () => {
    const io = captureIo();
    try {
      const rc = await runCli(['change']);
      const captured = io.take();

      expect(rc).toBe(1);
      expect(captured.out).toBe('');
      expect(JSON.parse(captured.err).code).toBe('not_implemented');
    } finally {
      io.restore();
    }
  });
});
