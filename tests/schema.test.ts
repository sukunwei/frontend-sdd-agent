import { describe, expect, it } from 'vitest';
import { WorkflowStateSchema } from '../src/state/schema.js';

describe('workflow-state 1.1.0', () => {
  it('必須含 currentStage / tasks / tddSubStage / checks / tbcItems（實作方案 §17.7）', () => {
    const doc = {
      version: '1.1.0', requirementName: 'qrcode-app', currentStage: 'tdd',
      repoPath: '/abs/repo', branch: 'task/qrcode-app', runId: 'run_20261027_120000',
      tasks: [{ id: 'TASK-setup-qrcode-page-route', title: 'Setup QR code page route', acceptanceCriteria: ['a'], acRefs: ['AC-001'], complexity: 'S', priority: 'high' }],
      tddSubStage: 'developer_done', currentTaskIndex: 0,
      verification: { checks: [{ name: 'lint:ts', status: 'passed', retries: 0 }] },
      tbcItems: [], blockers: [], approvals: {}, artifacts: {},
      createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z',
    };
    const parsed = WorkflowStateSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
  });

  it('複雜度可以是 L：一個跨檔案但仍是單一行為的 task', () => {
    const doc = { version: '1.1.0', currentStage: 'taskSplit', tasks: [{ id: 'TASK-x', title: 'x', acceptanceCriteria: ['a'], acRefs: ['AC-001'], complexity: 'L', priority: 'high' }] };
    const parsed = WorkflowStateSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
  });

  it('其他版本不得被接受（鏡像格式只有 1.1.0）', () => {
    const doc = { version: '1.0.0', requirementName: 'qrcode-app', currentStage: 'prd' };
    expect(WorkflowStateSchema.safeParse(doc).success).toBe(false);
  });

  it('未知的 stage 不得被接受', () => {
    const doc = { version: '1.1.0', requirementName: 'qrcode-app', currentStage: 'retrospective' };
    expect(WorkflowStateSchema.safeParse(doc).success).toBe(false);
  });

  it('缺少的欄位以預設值補齊（鏡像可被部分寫入）', () => {
    const parsed = WorkflowStateSchema.parse({ version: '1.1.0', requirementName: 'qrcode-app' });
    expect(parsed.currentStage).toBe('bootstrap');
    expect(parsed.tasks).toEqual([]);
    expect(parsed.tbcItems).toEqual([]);
    expect(parsed.blockers).toEqual([]);
    expect(parsed.artifacts).toEqual({});
    expect(parsed.approvals).toEqual({});
    expect(parsed.currentTaskIndex).toBe(0);
    expect(parsed.tddSubStage).toBe('pending');
    expect(parsed.lastReviews).toEqual([]);
    expect(parsed.tddAttempts).toBe(0);
    expect(parsed.verification.checks).toEqual([]);
    expect(parsed.bootstrapped).toBe(false);
  });
});
