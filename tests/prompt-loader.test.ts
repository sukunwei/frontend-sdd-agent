import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promptVariables, renderPrompt } from '../src/prompts/loader.js';
import { WORK_ORDER_ROLES } from '../src/cli/protocol.js';
import { getPromptPath } from '../src/runtime/paths.js';

/**
 * Every work order of the plugin.
 *
 * **The list is read from the `prompts/` directory, not written out here.**
 * A prompt file that nobody renders any more is a file that rots, and a
 * prompt file that nobody knows about is a work order the graph may hand out
 * without anybody having looked at it. A hand-written list cannot see either
 * one; the directory can.
 */
function listRoles(promptsDir: string): string[] {
  return fs
    .readdirSync(promptsDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .filter((role) => /^[a-z0-9][a-z0-9-]*$/.test(role))
    .sort();
}

/** The directory the prompt files live in. */
const PROMPTS_DIR = path.dirname(getPromptPath('spec-writer'));

/** The roles of the plugin, read from the directory. */
const ROLES = listRoles(PROMPTS_DIR);

/** The variables every work order uses. */
const VARS = {
  goal: '寫 spec',
  cwd: '/repo',
  inputs: '- /repo/docs/prd.md',
  outputs: '- /repo/docs/spec.md',
  outputFormat: 'Markdown',
};

/**
 * The `## 約束` section of a rendered work order.
 *
 * The section is what the worker is told it may and may not do, so it is
 * the part that has to be checked - the prose around it does not grant
 * anything.
 */
function constraints(prompt: string): string {
  const start = prompt.indexOf('## 約束');
  expect(start).toBeGreaterThan(-1);
  const rest = prompt.slice(start + '## 約束'.length);
  const end = rest.indexOf('\n## ');
  const section = end === -1 ? rest : rest.slice(0, end);
  // 粗體的星號只是排版：`**不得**修改` 說的還是「不得修改」。
  return section.replace(/\*\*/g, '');
}

/**
 * A line that grants the worker the right to change a file.
 *
 * The wording differs from role to role (`只改…列出的路徑`, `只寫…列出的路徑`),
 * so the pattern looks for the shape of the grant and not for one exact
 * sentence.
 */
const WRITE_GRANT = /只(改|寫)[^。\n]*列出的路徑/;

/** The roles that only look at the code. */
const REVIEWERS = ['spec-reviewer', 'quality-reviewer'];

/** The roles that write something. */
const WRITERS = ['spec-writer', 'e2e-planner', 'task-splitter', 'figma-fetch', 'developer'];

describe('工作單正文', () => {
  it('模板變數會被取代', () => {
    const out = renderPrompt('spec-writer', VARS);
    expect(out).toContain('寫 spec');
    expect(out).not.toContain('{{goal}}');
    expect(out).not.toContain('{{');
  });

  it('缺少必要變數必須報錯，不得產出半成品工作單', () => {
    expect(() => renderPrompt('spec-writer', {})).toThrow();
    expect(() => renderPrompt('spec-writer', { goal: 'g' })).toThrow();
  });

  it('多餘的變數必須報錯：模板沒有的變數不得被默默吞掉', () => {
    expect(() => renderPrompt('spec-writer', { ...VARS, context: 'x' })).toThrow();
  });

  it('每張工作單都必須禁止自行推進階段', () => {
    for (const role of ROLES) {
      const out = renderPrompt(role, VARS);
      expect(out).toContain('sdd-graph complete');
      expect(out).not.toMatch(/接下來進入|下一步進入|自動調用\s*\w*reviewer/);
    }
  });

  it('每一張工作單都用同一組模板變數', () => {
    for (const role of ROLES) {
      expect(promptVariables(role)).toEqual(['goal', 'cwd', 'inputs', 'outputs', 'outputFormat']);
    }
  });

  it('不存在的角色必須報錯', () => {
    expect(() => renderPrompt('no-such-role', VARS)).toThrow();
  });

  it('角色的名字不得離開 prompts/ 目錄', () => {
    expect(() => renderPrompt('../../etc/passwd', VARS)).toThrow();
  });

  it('評審的工作單不得給工人改原始碼的權力', () => {
    for (const role of REVIEWERS) {
      const rules = constraints(renderPrompt(role, VARS));
      // 唯讀，而且說的是「不准動手」而不是「可以改哪裡」。
      expect(rules).toContain('不得修改任何檔案');
      expect(rules).not.toMatch(WRITE_GRANT);
    }
  });

  it('寫作的工作單仍然可以寫檔（不能把權限收乾淨）', () => {
    for (const role of WRITERS) {
      const rules = constraints(renderPrompt(role, VARS));
      expect(rules).toMatch(WRITE_GRANT);
      expect(rules).not.toContain('不得修改任何檔案');
    }
  });

  it('prompts/ 目錄裡的每一張工作單都必須是圖發得出來的角色', () => {
    // 圖發得出來的角色（`WORK_ORDER_ROLES`）與 prompts/ 裡的檔案必須是
    // 同一組：多一個沒人發得出來的工作單是會腐爛的檔案，少一個則是圖會
    // 發出一張沒有正文的單。
    const handable = WORK_ORDER_ROLES.map((role) => role.replace(/_/g, '-')).sort();
    expect(ROLES).toEqual(handable);
  });

  it('模板裡有拼錯的變數必須報錯，不得產出半成品工作單', () => {
    // **測試寫在臨時目錄裡。** prompts/ 是外掛真正送出去的那個目錄：
    // 留在那裡的檔案會被圖當成工作單發出去（而且會讓上面那一條對不起來）。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-prompts-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'zz-malformed-placeholder.md'),
        ['目標：{{goal-title}}', '工作目錄：{{cwd}}', '', '輸出：{{outputs}}', ''].join('\n'),
        'utf-8'
      );
      expect(() =>
        renderPrompt('zz-malformed-placeholder', VARS, { promptsDir: dir })
      ).toThrow(/malformed|placeholder/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('新的 prompt 檔案必須被發現：清單是掃目錄來的，不是手寫的', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-prompts-'));
    try {
      const file = path.join(dir, 'zz-brand-new-role.md');
      fs.writeFileSync(file, '這是一張還沒有人寫完的工作單。\n', 'utf-8');
      expect(listRoles(dir)).toContain('zz-brand-new-role');
      fs.rmSync(file, { force: true });
      expect(listRoles(dir)).not.toContain('zz-brand-new-role');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('值裡的 {{ 不是模板的洞：不得因為標題提到模板就把整輪弄死', () => {
    // task 的標題是使用者寫的，它可能提到模板。模板的洞在**模板**裡查，
    // 值裡的 `{{` 是值 —— 把它當成洞會讓整張工作單發不出去。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-prompts-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'zz-braces-in-value.md'),
        [
          '目標：{{goal}}',
          '工作目錄：{{cwd}}',
          '',
          '必讀：{{inputs}}',
          '',
          '輸出：{{outputs}}',
          '',
          '格式：{{outputFormat}}',
        ].join('\n'),
        'utf-8'
      );
      const out = renderPrompt(
        'zz-braces-in-value',
        { ...VARS, goal: '支援 {{name}} 參數' },
        { promptsDir: dir }
      );
      expect(out).toContain('支援 {{name}} 參數');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
