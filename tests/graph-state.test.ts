import { describe, expect, it } from 'vitest';
import { END, START, StateGraph } from '@langchain/langgraph';
import { mergeById, mergeRecord, mergeVerification } from '../src/graph/reducers.js';
import type { VerificationState } from '../src/graph/reducers.js';
import { SddStateAnnotation, toCommand } from '../src/graph/state.js';

describe('graph state', () => {
  it('default 必須真的出現在 state 裡（沒有 reducer 會被靜默丟棄）', async () => {
    const g = new StateGraph(SddStateAnnotation)
      .addNode('n', async () => ({ currentStage: 'bootstrap' }))   // 節點必須回傳非空更新，否則 invoke() 回 undefined
      .addEdge(START, 'n').addEdge('n', END)
      .compile();
    const out: any = await g.invoke({});
    expect(out.currentStage).toBe('bootstrap');
    expect(out.currentTaskIndex).toBe(0);   // ← 這幾個值只可能來自 default
    expect(out.tasks).toEqual([]);
    expect(out.bootstrapped).toBe(false);
    expect(out.lastReview).toBeNull();
  });

  it('每一個欄位都要有 default（含 version 與時間戳）', async () => {
    const g = new StateGraph(SddStateAnnotation)
      .addNode('n', async () => ({ currentStage: 'bootstrap' }))
      .addEdge(START, 'n').addEdge('n', END)
      .compile();
    const out: any = await g.invoke({});
    expect(out.version).toBe('1.1.0');
    expect(out.requirementName).toBe('');
    expect(out.repoUrl).toBe('');
    expect(out.repoPath).toBe('');
    expect(out.branch).toBe('');
    expect(out.runId).toBe('');
    expect(out.artifacts).toEqual({});
    expect(out.tbcItems).toEqual([]);
    expect(out.tddSubStage).toBe('pending');
    expect(out.tddAttempts).toBe(0);
    expect(out.verification).toEqual({ checks: [] });
    expect(out.blockers).toEqual([]);
    expect(out.approvals).toEqual({});
    expect(typeof out.createdAt).toBe('string');
    expect(typeof out.updatedAt).toBe('string');
  });

  it('mergeById 以 id 覆蓋既有項目', () => {
    expect(mergeById([{ id: 'a', v: 1 }], [{ id: 'a', v: 2 }, { id: 'b', v: 3 }]))
      .toEqual([{ id: 'a', v: 2 }, { id: 'b', v: 3 }]);
  });

  it('mergeById 保留既有順序，新項目附加在後', () => {
    expect(mergeById([{ id: 'b', v: 1 }, { id: 'a', v: 1 }], [{ id: 'c', v: 9 }]))
      .toEqual([{ id: 'b', v: 1 }, { id: 'a', v: 1 }, { id: 'c', v: 9 }]);
  });

  it('mergeRecord 淺合併', () => {
    expect(mergeRecord({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('mergeRecord 右邊覆蓋左邊', () => {
    expect(mergeRecord({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('mergeVerification 以 name 合併 checks', () => {
    const left: VerificationState = {
      checks: [{ name: 'test', status: 'pending', retries: 0 }],
    };
    const right: VerificationState = {
      checks: [
        { name: 'test', status: 'passed', retries: 1 },
        { name: 'lint', status: 'passed', retries: 0 },
      ],
    };
    expect(mergeVerification(left, right)).toEqual({
      checks: [
        { name: 'test', status: 'passed', retries: 1 },
        { name: 'lint', status: 'passed', retries: 0 },
      ],
    });
  });

  it('toCommand 把 advance 轉成帶 update 與 goto 的 Command', () => {
    const cmd = toCommand({ kind: 'advance', update: { currentStage: 'prd' }, goto: 'prd' });
    expect(cmd.goto).toEqual(['prd']);   // LangGraph 會把 goto 正規化成陣列
    expect(cmd.update).toEqual({ currentStage: 'prd' });
  });
});
