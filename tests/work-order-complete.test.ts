import { describe, expect, it } from 'vitest';
import { validateCompletion } from '../src/nodes/review.js';

describe('complete 驗證', () => {
  it('outputs 檔案不存在時必須重發同一張單且不計失敗次數', () => {
    const r = validateCompletion(
      { outputs: ['/definitely/missing.md'] } as any,
      { status: 'ok', summary: '', changedFiles: [] } as any
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing_outputs');
    expect(r.countsAsFailure).toBe(false);
  });

  it('評審結果不是合法 JSON 時重發同一張單', () => {
    const r = validateCompletion(
      { outputs: [], resultSchema: 'review' } as any,
      { status: 'ok', summary: 'PASS', changedFiles: [] } as any
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_review');
    expect(r.countsAsFailure).toBe(false);
  });

  it('outputs 都在且評審通過時才算成功', () => {
    const r = validateCompletion(
      { outputs: [], resultSchema: 'review', role: 'reviewer' } as any,
      {
        status: 'ok',
        summary: '',
        changedFiles: [],
        reviews: [
          { role: 'spec', verdict: 'pass', issues: [] },
          { role: 'quality', verdict: 'pass', issues: [] },
        ],
      } as any
    );
    expect(r.ok).toBe(true);
  });

  it('審查只回一份結論 → 非法評審（兩個問題都要回答）', () => {
    const r = validateCompletion(
      { outputs: [], resultSchema: 'review', role: 'reviewer' } as any,
      {
        status: 'ok',
        summary: '',
        changedFiles: [],
        reviews: [{ role: 'spec', verdict: 'pass', issues: [] }],
      } as any
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_review');
  });

  it('工人說沒做完（status: failed）就算沒完成，帶著合法評審也不行', () => {
    const r = validateCompletion(
      { outputs: [], resultSchema: 'review', role: 'reviewer' } as any,
      {
        status: 'failed',
        summary: '沒寫完',
        changedFiles: [],
        reviews: [
          { role: 'spec', verdict: 'pass', issues: [] },
          { role: 'quality', verdict: 'pass', issues: [] },
        ],
      } as any
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unfinished');
    expect(r.countsAsFailure).toBe(false);
  });

  it('第二次仍是非法評審時才算成失敗', () => {
    const r = validateCompletion(
      { outputs: [], resultSchema: 'review' } as any,
      { status: 'ok', summary: 'PASS', changedFiles: [] } as any,
      1
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_review');
    expect(r.countsAsFailure).toBe(true);
  });

  it('審查的結論少了一個角色時視為非法評審', () => {
    const r = validateCompletion(
      { outputs: [], resultSchema: 'review', role: 'reviewer' } as any,
      {
        status: 'ok',
        summary: '',
        changedFiles: [],
        review: { role: 'spec', verdict: 'pass', issues: [] },
      } as any
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_review');
  });
});
