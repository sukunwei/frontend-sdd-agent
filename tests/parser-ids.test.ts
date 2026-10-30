import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseAcIds,
  parseComplexity,
  parseE2eIds,
  parseE2eRows,
  parseQuestions,
  parseTaskIds,
  parseTasks,
  parseTbcItems,
  slugifyTaskId,
} from '../src/parsers/ids.js';

const FIX = join(import.meta.dirname, 'fixtures', 'qrcode-app');

const readFixture = (name: string): string => readFileSync(join(FIX, name), 'utf-8');

describe('ID 解析', () => {
  it('從 spec.md 抽出 AC-xxx', () => {
    const ids = parseAcIds(readFileSync(join(FIX, 'spec.md'), 'utf-8'));
    expect(ids).toEqual(['AC-001', 'AC-002', 'AC-003', 'AC-004', 'AC-005']);
  });

  it('從 tasks.md 抽出穩定 TASK slug', () => {
    const tasks = parseTasks(readFileSync(join(FIX, 'tasks.md'), 'utf-8'));
    expect(tasks.map(t => t.id)).toContain('TASK-setup-qrcode-page-route');
    expect(tasks.every(t => t.id.startsWith('TASK-'))).toBe(true);
  });

  it('每個 task 都要有 2-5 條驗收條件且不得有 L 複雜度', () => {
    const tasks = parseTasks(readFileSync(join(FIX, 'tasks.md'), 'utf-8'));
    for (const t of tasks) {
      expect(t.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
      expect(t.acceptanceCriteria.length).toBeLessThanOrEqual(5);
      expect(['S', 'M']).toContain(t.complexity);
    }
  });

  it('從 e2e-plan.csv 抽出 E2E-xxx 與 AC 關聯', () => {
    const rows = parseE2eRows(readFileSync(join(FIX, 'e2e-plan.csv'), 'utf-8'));
    expect(rows.map(r => r.testId)).toEqual(['E2E-001', 'E2E-002', 'E2E-003', 'E2E-004', 'E2E-005']);
  });

  it('slug 由標題派生，同標題必得同 ID', () => {
    expect(slugifyTaskId('Setup QR code page route')).toBe('setup-qrcode-page-route');
    expect(slugifyTaskId('Setup QR code page route')).toBe(slugifyTaskId('Setup QR code page route'));
  });
});

describe('AC 與 Q/TBC 抽取', () => {
  it('只認格式正確的 AC heading，AC-0012 不會被誤認成 AC-001', () => {
    expect(parseAcIds('### AC-001: 正常\n### AC-0012: 位數過多\n')).toEqual(['AC-001']);
  });

  it('抽出 spec.md 的 TBC 項目並讀出 blocking 旗標', () => {
    const items = parseTbcItems(readFixture('spec.md'));
    expect(items.map(i => i.id)).toEqual(['TBC-001', 'TBC-002']);
    expect(items[0].blocking).toBe(true);
    expect(items[1].blocking).toBe(false);
    expect(items[0].resolved).toBe(false);
    expect(items[0].description.length).toBeGreaterThan(0);
  });

  it('已解掉的 TBC 讀得出 resolution', () => {
    const items = parseTbcItems('- [TBC-001] (blocking) (resolved: 採用預設值 M) 錯誤修正層級');
    expect(items).toEqual([
      {
        id: 'TBC-001',
        description: '錯誤修正層級',
        blocking: true,
        resolved: true,
        resolution: '採用預設值 M',
        createdAt: '',
      },
    ]);
  });

  it('TBC 的 createdAt 由呼叫端指定', () => {
    const items = parseTbcItems('- [TBC-001] 項目', { createdAt: '2026-10-28T00:00:00.000Z' });
    expect(items[0].createdAt).toBe('2026-10-28T00:00:00.000Z');
  });

  it('抽出 spec.md 的澄清問題並帶上回合與狀態', () => {
    const questions = parseQuestions(readFixture('spec.md'));
    expect(questions.map(q => q.id)).toEqual(['Q-001', 'Q-002', 'Q-003']);
    expect(questions.map(q => q.round)).toEqual([1, 1, 2]);
    expect(questions.map(q => q.status)).toEqual(['pending', 'answered', 'tbc']);
  });
});

describe('tasks.md 解析', () => {
  it('抽出全部 TASK id 且不重複', () => {
    const ids = parseTaskIds(readFixture('tasks.md'));
    expect(ids).toEqual([
      'TASK-setup-qrcode-page-route',
      'TASK-create-qrcode-input',
      'TASK-create-qrcode-display',
      'TASK-create-qrcode-download',
      'TASK-wire-up-main-page',
      'TASK-add-e2e-tests',
      'TASK-add-unit-tests',
    ]);
  });

  it('複雜度欄保持寬型（L 不在解析階段被吞掉）', () => {
    const complexities = parseComplexity(readFixture('tasks.md'));
    expect(complexities).toEqual(['S', 'M', 'M', 'M', 'M', 'S', 'S']);
    expect(complexities).not.toContain('L');
  });

  it('task 帶有標題、複雜度、優先序與 AC 關聯', () => {
    const tasks = parseTasks(readFixture('tasks.md'));
    const setup = tasks.find(t => t.id === 'TASK-setup-qrcode-page-route');
    expect(setup).toBeDefined();
    expect(setup?.title).toBe('Setup QR code page route');
    expect(setup?.complexity).toBe('S');
    expect(setup?.priority).toBe('high');
    expect(setup?.acRefs).toEqual(['AC-001', 'AC-003']);
    expect(setup?.description).toBeTruthy();
  });

  it('task 的 **Frames** 會被讀出來（frameKey，逗號分隔）', () => {
    const md = [
      '| Task ID | Title | Complexity | Priority | AC Refs |',
      '|---------|-------|------------|----------|---------|',
      '| TASK-do-thing | Do thing | S | high | AC-001 |',
      '',
      '### TASK-do-thing: Do thing',
      '',
      '**Description**: 做出一個畫面。',
      '',
      '**Acceptance Criteria**:',
      '- 看得到畫面',
      '',
      '**AC Refs**: AC-001',
      '',
      '**Frames**: 1-23, 2-10',
      '',
    ].join('\n');
    expect(parseTasks(md)[0].frames).toEqual(['1-23', '2-10']);
  });

  it('沒有 **Frames** 的 task 解析出來是空的（純邏輯 task）', () => {
    const md = [
      '| Task ID | Title | Complexity | Priority | AC Refs |',
      '|---------|-------|------------|----------|---------|',
      '| TASK-do-thing | Do thing | S | high | AC-001 |',
      '',
      '### TASK-do-thing: Do thing',
      '',
      '**Description**: 做一件事。',
      '',
      '**Acceptance Criteria**:',
      '- 做得到',
      '',
      '**AC Refs**: AC-001',
      '',
    ].join('\n');
    expect(parseTasks(md)[0].frames).toEqual([]);
  });

  it('tasks.md 出現 L 複雜度時解析器看得見（由關卡決定是否放行）', () => {
    const md = [
      '| Task ID | Title | Complexity | Priority |',
      '|---------|-------|------------|----------|',
      '| TASK-do-thing | Do thing | L | high |',
      '',
    ].join('\n');
    expect(parseComplexity(md)).toEqual(['L']);
    expect(parseTasks(md)[0].complexity).toBe('L');
  });

  it('舊格式 task-N 仍可解析，並升級成穩定 slug', () => {
    const md = [
      '| Task ID | Title | Complexity | Priority |',
      '|---------|-------|------------|----------|',
      '| task-1 | Setup QR code page route | S | high |',
      '',
    ].join('\n');
    expect(parseTaskIds(md)).toEqual(['task-1']);
    expect(parseTasks(md)[0].id).toBe('TASK-setup-qrcode-page-route');
  });

  it('複雜度欄缺漏或值非法時直接報錯', () => {
    const noColumn = ['| Task ID | Title |', '|---------|-------|', '| TASK-a | A |', ''].join('\n');
    expect(() => parseComplexity(noColumn)).toThrow(/complexity/i);

    const badValue = [
      '| Task ID | Title | Complexity | Priority |',
      '|---------|-------|------------|----------|',
      '| TASK-a | A | XL | high |',
      '',
    ].join('\n');
    expect(() => parseComplexity(badValue)).toThrow(/complexity/i);
  });

  it('非法 id 格式不得被寬鬆比對撈進來', () => {
    const md = [
      '| Task ID | Title | Complexity | Priority |',
      '|---------|-------|------------|----------|',
      '| TASK-Setup_Page | Setup page | S | high |',
      '',
    ].join('\n');
    expect(() => parseTasks(md)).toThrow(/TASK-/);
  });

  it('優先序不合法時報錯', () => {
    const md = [
      '| Task ID | Title | Complexity | Priority |',
      '|---------|-------|------------|----------|',
      '| TASK-do-thing | Do thing | S | urgent |',
      '',
    ].join('\n');
    expect(() => parseTasks(md)).toThrow(/priority/i);
  });

  it('detail block 的 id 拼錯時要報錯，不能靜默丟掉驗收條件', () => {
    const md = [
      '| Task ID | Title | Complexity | Priority |',
      '|---------|-------|------------|----------|',
      '| TASK-setup-qrcode-page-route | Setup QR code page route | S | high |',
      '',
      '### TASK-Setup_Page: Setup QR code page route',
      '',
      '**Acceptance Criteria**:',
      '- 路由存在',
      '',
    ].join('\n');
    expect(() => parseTasks(md)).toThrow(/TASK-Setup_Page/);
  });

  it('detail block 沒有對應的 task 時要報錯', () => {
    const md = [
      '| Task ID | Title | Complexity | Priority |',
      '|---------|-------|------------|----------|',
      '| TASK-setup-qrcode-page-route | Setup QR code page route | S | high |',
      '',
      '### TASK-other-task: Other task',
      '',
    ].join('\n');
    expect(() => parseTasks(md)).toThrow(/no matching task/);
  });

  it('驗收條件與 marker 之間隔一行空白時仍要讀得到', () => {
    const md = [
      '| Task ID | Title | Complexity | Priority |',
      '|---------|-------|------------|----------|',
      '| TASK-setup-qrcode-page-route | Setup QR code page route | S | high |',
      '',
      '### TASK-setup-qrcode-page-route: Setup QR code page route',
      '',
      '**Acceptance Criteria**:',
      '',
      '- 路由 `/qrcode-app` 存在且可渲染',
      '- 頁面出現 "QR Code Generator" 標題',
      '',
      '**Files**:',
      '- `src/app/page/qrcode-app/page.tsx`',
      '',
    ].join('\n');
    const tasks = parseTasks(md);
    expect(tasks[0].acceptanceCriteria).toEqual([
      '路由 `/qrcode-app` 存在且可渲染',
      '頁面出現 "QR Code Generator" 標題',
    ]);
  });
});

describe('e2e-plan.csv 解析', () => {
  it('抽出 E2E-xxx', () => {
    expect(parseE2eIds(readFixture('e2e-plan.csv'))).toEqual([
      'E2E-001',
      'E2E-002',
      'E2E-003',
      'E2E-004',
      'E2E-005',
    ]);
  });

  it('每列帶著欄位、步驟與 AC 關聯', () => {
    const rows = parseE2eRows(readFixture('e2e-plan.csv'));
    expect(rows[0]).toEqual({
      testId: 'E2E-001',
      feature: 'Text Input',
      scenario: 'Empty input shows placeholder (AC-001)',
      steps: ['Open /qrcode-app', 'Observe the QR display area'],
      expectedResult: 'Placeholder message is visible',
      priority: 'high',
      acRefs: ['AC-001'],
    });
  });

  it('欄位不符時報錯', () => {
    expect(() => parseE2eRows('test_id,scenario,expected_result\nE2E-001,a,b\n')).toThrow(/column/i);
  });

  it('test_id 格式不合法時報錯', () => {
    const csv = [
      'test_id,feature,scenario,steps,expected_result,priority',
      'E2E-1,Text Input,Empty input (AC-001),step,result,high',
      '',
    ].join('\n');
    expect(() => parseE2eRows(csv)).toThrow(/E2E-/);
  });

  it('優先序不合法時報錯', () => {
    const csv = [
      'test_id,feature,scenario,steps,expected_result,priority',
      'E2E-001,Text Input,Empty input (AC-001),step,result,critical',
      '',
    ].join('\n');
    expect(() => parseE2eRows(csv)).toThrow(/priority/i);
  });

  it('test_id 重複時報錯', () => {
    const csv = [
      'test_id,feature,scenario,steps,expected_result,priority',
      'E2E-001,Text Input,Empty input (AC-001),step,result,high',
      'E2E-001,Text Input,Another input (AC-002),step,result,high',
      '',
    ].join('\n');
    expect(() => parseE2eRows(csv)).toThrow(/duplicat/i);
  });
});

describe('slugifyTaskId', () => {
  it('非英數字一律當分隔符，連續分隔符收斂', () => {
    expect(slugifyTaskId('Create QR code input')).toBe('create-qrcode-input');
    expect(slugifyTaskId('Wire up — main page!')).toBe('wire-up-main-page');
    expect(slugifyTaskId('  spaced   out  ')).toBe('spaced-out');
  });

  it('全大寫縮寫與後面的字合成同一個詞', () => {
    expect(slugifyTaskId('Setup QR code page route')).toBe('setup-qrcode-page-route');
    // 含數字的縮寫不視為縮寫詞
    expect(slugifyTaskId('Add E2E tests')).toBe('add-e2e-tests');
  });

  it('只有已知的複合詞會被合併，其他縮寫各自成詞', () => {
    expect(slugifyTaskId('Add UI tests')).toBe('add-ui-tests');
    expect(slugifyTaskId('Task ID handling')).toBe('task-id-handling');
    expect(slugifyTaskId('Add API E2E tests')).toBe('add-api-e2e-tests');
    expect(slugifyTaskId('QR API tests')).toBe('qr-api-tests');
    expect(slugifyTaskId('QR api tests')).toBe('qr-api-tests');
  });

  it('長度上限 48 且不留下尾端連字號', () => {
    const slug = slugifyTaskId('a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('沒有英數字時回空字串', () => {
    expect(slugifyTaskId('!!!')).toBe('');
  });
});
