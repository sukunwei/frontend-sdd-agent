import { describe, expect, it } from 'vitest';
import { readAnswer } from '../src/nodes/answers.js';
import { readGateAnswer, recordGateAnswer } from '../src/nodes/review.js';
import { recordUserAnswer, readUserAnswer } from '../src/nodes/tdd.js';

describe('閘門的答案', () => {
  it('純字串就是答案', () => {
    const answer = readAnswer('wait');
    expect(answer.value).toBe('wait');
    expect(answer.unparsed).toBe(false);
  });

  it('物件裡的答案欄位都要認得', () => {
    for (const key of ['action', 'answer', 'comment', 'text', 'option', 'value', 'response', 'decision', 'choice']) {
      const answer = readAnswer({ [key]: 'skip' });
      expect(answer.value).toBe('skip');
      expect(answer.unparsed).toBe(false);
    }
  });

  it('看不懂的形狀要跟「沒有回答」分開', () => {
    const answer = readAnswer({ foo: 'bar' });
    expect(answer.value).toBe('');
    expect(answer.unparsed).toBe(true);
    expect(answer.raw).toContain('foo');
  });

  it('空字串也算看不懂（那不是一個答案）', () => {
    const answer = readAnswer('   ');
    expect(answer.unparsed).toBe(true);
  });

  it('ledger 要分得出「還沒回答」與「回答看不懂」', () => {
    const state = { stageSteps: {} } as any;

    // 還沒回答
    expect(readGateAnswer(state)).toBeUndefined();

    // 回答看不懂
    const unreadable = { ...state, ...recordGateAnswer({ foo: 'bar' }) };
    const answer = readGateAnswer(unreadable);
    expect(answer).toBeDefined();
    expect(answer?.unparsed).toBe(true);
    expect(answer?.raw).toContain('foo');

    // 看懂的回答
    const readable = { ...state, ...recordGateAnswer({ action: 'wait' }) };
    expect(readGateAnswer(readable)?.value).toBe('wait');
    expect(readGateAnswer(readable)?.unparsed).toBe(false);
  });

  it('舊格式的答案（純字串）還是讀得懂', () => {
    // checkpoint 活得比插件久：升級之前寫進去的答案必須還讀得出來，
    // 否則一個停在閘門上的 run 會在使用者升級插件之後把答案弄丟。
    const legacy = { stageSteps: { 'tdd/escalation-answer': 'wait' } } as any;
    const answer = readGateAnswer(legacy);
    expect(answer?.value).toBe('wait');
    expect(answer?.unparsed).toBe(false);
  });

  it('developer 的問題也要認得 action 這個欄位', () => {
    // 每個閘門的答案形狀都不一樣，但 `{action: ...}` 是使用者最常給的形狀：
    // 讀不出來等於「使用者還沒回答」→ 同一個問題會被問到天荒地老。
    const recorded = recordUserAnswer({ action: 'use the existing button' });
    const state = { stageSteps: {} as Record<string, string>, ...recorded } as any;
    expect(readUserAnswer(state)).toBe('use the existing button');
  });
});
