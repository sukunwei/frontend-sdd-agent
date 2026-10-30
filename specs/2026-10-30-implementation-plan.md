# Figma 原型 + UI Diff 與 SDD 流程效率 —— 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Figma 抓取流程擴充成「抓資源 → 產生靜態 HTML 原型 → 渲染後與 Figma 截圖做像素 diff → 修到沒有硬失敗」，並同時把整輪 SDD 流程的來回次數降下來（task 拆分粒度、關卡並行、每個 task 只審一次）。

**Architecture:** 兩條獨立的線，交錯進行。A 线（Task A1～A7）改 PRD／spec 階段的 Figma 流程：量測程式做成 `sdd-graph figma-diff` 子命令，**模型和圖呼叫同一支**——模型在自己的回合裡迭代，圖最後跑一次當權威證據。B 线（Task B1～B5）改流程效率本身。三者之中只有 B5（審查合併）會動到 state schema，其餘都不動。

**Tech Stack:** TypeScript（ESM、`module: NodeNext`）、vitest 5、LangGraph（`@langchain/langgraph` 1.5.3）、zod 4、Node ≥ 20.11。新增依賴：`pngjs@7`（CJS）、`pixelmatch@8`（ESM、自帶型別）、`@types/pngjs@6`。

**Spec:**
- `specs/2026-10-30-figma-prototype-and-ui-diff-design.md`
- `specs/2026-10-30-sdd-flow-efficiency-design.md`

## Global Constraints

- 這個 repo 的 `.gitignore` 忽略 `/docs/`，所以設計與計畫文件一律放 `specs/`，不要放 `docs/`。
- 工作單的 **wire role 用底線**（`figma_prototype`），**prompt 檔名用連字號**（`prompts/figma-prototype.md`）。兩者沒有自動轉換，節點要分別指定。
- 工作單的 `inputs`／`outputs` 一律是**絕對路徑**；`outputs` 會被 CLI 檢查有沒有真的寫出來。
- prompt 模板只能用 `{{goal}}`、`{{cwd}}`、`{{inputs}}`、`{{outputs}}`、`{{outputFormat}}` 這五個變數；多給或少給都會讓 `renderPrompt` 丟錯。
- 這個 repo 自己的單元測試是 vitest，一律寫成 `.ts`，**不要寫 `.tsx`**。
- 每個 task 結束都要 commit；commit 訊息結尾加上 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 程式碼註解用英文（跟 `src/` 現況一致）；prompt 與文件用中文。
- 不要動 `workflow-state.json`、checkpoint、lock、`runtime/` 的既有行為。

## Review Focus

規格會暗示、但任何一個 task 的測試都不會自然覆蓋的輸入與狀況（最可能咬到人的排前面）：

1. **目標 repo 沒有 Playwright** —— 量測會整個失敗。這是環境問題不是模型的問題，必須報成人看得懂的訊息，不能變成一個沒有頭緒的失敗。
2. **原型頁的 HTML 語法錯 / asset 相對路徑斷掉** —— 渲染會失敗；報告要留下瀏覽器的 stderr，不要只說「渲染失敗」。
3. **HTML 與 Figma 截圖尺寸不一樣**（設計改了但截圖是舊的）—— 必須判成硬失敗而不是硬比像素，否則會得到一個毫無意義的百分比。
4. **Figma 抓取失敗（P0 沒寫出來）** —— 這時候**不能**發原型工作單（沒有東西可以原型化），流程要直接走到 `confirm_prd`，並記一筆不擋人的 TBC。
5. **沒有 Figma 網址（設計是用文字描述的）** —— 整段原型流程要跳過，不能產生任何原型相關的工作單或 TBC。
6. **設計裡的字體在本機不存在** —— 像素分數會整個失真；報告必須寫明這件事，讓人不要把分數當真值。
7. **`figma/screenshots/` 裡有一張截圖但沒有對應的原型頁** —— 硬失敗，不是軟指標。

---

# Part A —— Figma 原型 + UI diff

## 檔案結構

| 檔案 | 職責 |
|---|---|
| `src/figma/paths.ts` | Figma 相關產物的路徑常數與 `checkPrototype`（純路徑，不碰檔案內容） |
| `src/figma/measure.ts` | 純函式：frame 配對、像素比對、報告文字 |
| `src/figma/render.ts` | 把 HTML 渲染成 PNG（可注入 runner）與讀 PNG 尺寸 |
| `src/figma/fidelity.ts` | 把上面三者組成一次完整量測，寫出 `figma/diff/*` |
| `src/nodes/figma-flow.ts` | 共用的 Figma 流程狀態機（fetch → prototype → 量測 → polish） |
| `prompts/figma-prototype.md` | 用 `figma-implement-design` skill 產生靜態 HTML 的工作單 |
| `prompts/figma-polish.md` | 依 diff 報告修 HTML 的工作單 |

---

### Task 1: A1 —— 量測的純函式（配對、像素比對、報告）

**Files:**
- Create: `src/figma/measure.ts`
- Create: `tests/figma-measure.test.ts`
- Modify: `package.json`（加 `pngjs`、`pixelmatch`、`@types/pngjs`）

**Interfaces:**
- Consumes: 無（純函式）
- Produces:
  ```ts
  export interface FramePair {
    key: string;        // '1-23'
    screenshot: string; // 絕對路徑，figma/screenshots/<key>.png
    html: string;       // 絕對路徑，figma/prototype/<key>.html
  }
  export type FrameStatus =
    | 'ok' | 'missing_html' | 'render_failed' | 'size_mismatch' | 'diff_failed';
  export interface FrameDiff {
    key: string;
    status: FrameStatus;
    ratio: number;   // 0..1，不符像素比例；失敗時為 0
    width: number;
    height: number;
    error?: string;
  }
  export function findFramePairs(docsDir: string): { pairs: FramePair[]; missingHtml: string[] };
  export function comparePng(a: Buffer, b: Buffer): { ratio: number; width: number; height: number; diff: Buffer };
  export function buildReport(frames: FrameDiff[]): { json: string; md: string };
  ```

- [ ] **Step 1: 加依賴並確認匯入形式**

```bash
npm install pngjs@7 pixelmatch@8
npm install -D @types/pngjs@6
```

`pngjs@7` 是 CommonJS，`@types/pngjs` 用的是 `export =` 型別。先用這個寫法：

```ts
import PNG from 'pngjs';
```

如果執行時 `PNG.sync` 是 `undefined`，改成：

```ts
import pngjs from 'pngjs';
const { PNG } = pngjs;
```

哪一種對，由 Step 2 的第一個測試決定 —— 測試綠了才算數。**不要**用 `import { PNG } from 'pngjs'`（runtime 可能沒有這個具名匯出）。

- [ ] **Step 2: 寫失敗的測試**

`tests/figma-measure.test.ts`：

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReport, comparePng, findFramePairs } from '../src/figma/measure.js';

describe('Figma 量測的純函式', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-figma-'));
    fs.mkdirSync(path.join(dir, 'figma', 'screenshots'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'figma', 'prototype'), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('pngjs 的讀圖與尺寸是對的（鎖住匯入形式）', () => {
    // 用 pngjs 自己畫一張 2x2 的圖再讀回來
    const { PNG } = pngjsModule();       // ← 依 Step 1 決定的形式寫死
    const png = new PNG({ width: 2, height: 2 });
    png.data = Buffer.alloc(2 * 2 * 4, 255);
    const buf = PNG.sync.write(png);
    const read = PNG.sync.read(buf);
    expect(read.width).toBe(2);
    expect(read.height).toBe(2);
  });

  it('每張截圖都要配到一個同名原型的 html', () => {
    fs.writeFileSync(path.join(dir, 'figma', 'screenshots', '1-23.png'), 'x');
    fs.writeFileSync(path.join(dir, 'figma', 'screenshots', '1-24.png'), 'x');
    fs.writeFileSync(path.join(dir, 'figma', 'prototype', '1-23.html'), '<html></html>');
    const found = findFramePairs(dir);
    expect(found.pairs.map((p) => p.key)).toEqual(['1-23']);
    expect(found.missingHtml).toEqual(['1-24']);
  });

  it('沒有截圖時配對結果是空的，不是錯誤', () => {
    expect(findFramePairs(dir).pairs).toEqual([]);
  });

  it('兩張一樣的圖比對出來比例是 0', () => { /* comparePng(a, a).ratio === 0 */ });
  it('兩張不同的圖比對出來比例大於 0', () => { /* comparePng(a, b).ratio > 0 */ });
  it('報告裡每一個 frame 都要有一行，含比率與狀態', () => {
    const { md, json } = buildReport([{ key: '1-23', status: 'ok', ratio: 0.0123, width: 1440, height: 900 }]);
    expect(md).toContain('1-23');
    expect(md).toContain('1.23%');
    expect(JSON.parse(json)).toEqual([{ key: '1-23', status: 'ok', ratio: 0.0123, width: 1440, height: 900 }]);
  });
  it('報告必須寫明字體差異會讓分數失真', () => {
    expect(buildReport([]).md).toContain('字體');
  });
});
```

- [ ] **Step 3: 跑測試，確認失敗**

```bash
npx vitest run tests/figma-measure.test.ts
```
Expected: FAIL —— `Cannot find module '../src/figma/measure.js'`

- [ ] **Step 4: 實作 `src/figma/measure.ts`**

要點：
- `findFramePairs`：讀 `figma/screenshots/` 底下的 `.png`（檔名去掉副檔名就是 key，排序後回傳），對每個 key 找 `figma/prototype/<key>.html`；存在 → 進 `pairs`，不存在 → key 進 `missingHtml`。
- `comparePng(a, b)`：用 `PNG.sync.read` 解兩張圖；**寬高不同時回 `{ ratio: 0, width, height, diff: Buffer.alloc(0) }`** 並讓呼叫端判成 `size_mismatch`；同寬高時呼叫 `pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold: 0.1 })` 回傳不符像素數，除以 `width * height` 得 ratio。
- `buildReport`：json 是 `FrameDiff[]` 的 `JSON.stringify`；md 是每個 frame 一行（key、狀態、比率百分比、尺寸）+ 一段開頭說明（每個 frame 的分數、以及「字體與抗鋸齒的差異會讓分數失真」）。

- [ ] **Step 5: 跑測試，確認通過**

```bash
npx vitest run tests/figma-measure.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/figma/measure.ts tests/figma-measure.test.ts package.json package-lock.json
git commit -m "feat: Figma 量測的純函式 —— frame 配對、像素比對、報告

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: A2 —— 渲染器（可注入的 runner）

**Files:**
- Create: `src/figma/render.ts`
- Create: `tests/figma-render.test.ts`

**Interfaces:**
- Consumes: 無
- Produces:
  ```ts
  export interface RenderRequest {
    html: string;   // 絕對路徑
    out: string;    // 絕對路徑，輸出的 png
    width: number;
    height: number;
    cwd: string;    // 跑 npx 的工作目錄（目標 repo）
  }
  export interface RenderResult { ok: boolean; error?: string }
  export type RenderRunner = (req: RenderRequest) => Promise<RenderResult>;
  export function playwrightRunner(): RenderRunner;
  export function pngSize(file: string): { width: number; height: number };
  ```

- [ ] **Step 1: 寫失敗的測試**

`tests/figma-render.test.ts`：

```ts
describe('Figma 渲染器', () => {
  it('pngSize 讀得出圖片的寬高', () => { /* 寫一張 3x5 的 png，pngSize 回 { width: 3, height: 5 } */ });
  it('runner 失敗時回報錯誤訊息，不是丟例外', async () => {
    const runner = playwrightRunner({ spawn: fakeSpawn });   // ← 見 Step 3
    const result = await runner({ html: '/x/a.html', out: '/x/a.png', width: 100, height: 50, cwd: '/repo' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('playwright');
  });
  it('runner 成功時 ok 為 true', async () => { /* fake spawn 回 code 0 */ });
});
```

- [ ] **Step 2: 跑測試，確認失敗**

```bash
npx vitest run tests/figma-render.test.ts
```
Expected: FAIL —— module not found

- [ ] **Step 3: 實作 `src/figma/render.ts`**

- `pngSize(file)`：`PNG.sync.read(fs.readFileSync(file))` 取 `width`／`height`；檔案不存在或不是合法 png → 丟出帶訊息的 Error。
- `playwrightRunner()`：**用 `child_process.spawn` 跑**
  `npx playwright screenshot --viewport-size="<W>,<H>" "file://<html>" "<out>"`，
  cwd = `req.cwd`。**不要**用 `execSync`（會阻塞，而且要能拿 stderr）。
  - 回傳碼 0 → `{ ok: true }`
  - 非 0 → `{ ok: false, error: 'playwright screenshot failed (code N): <stderr>' }`
  - `spawn` 本身出錯（`error` 事件，例如沒有 npx）→ `{ ok: false, error: <err.message> }`
- **可注入點**：`playwrightRunner` 接受一個選項 `{ spawn?: SpawnLike }`，預設用真的 `child_process.spawn`。`SpawnLike` 的形狀只要有 `on('close'|'error')` 與 `stderr` 即可，測試用假的。
  這個注入點是 Task A3 的 CLI 與 Task A6 的流程測試都需要的 —— 測試永遠不跑真的瀏覽器。

- [ ] **Step 4: 跑測試，確認通過**

```bash
npx vitest run tests/figma-render.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/figma/render.ts tests/figma-render.test.ts
git commit -m "feat: 可注入的 Playwright 渲染器

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: A3 —— 量測流程 + `sdd-graph figma-diff` CLI

**Files:**
- Create: `src/figma/fidelity.ts`
- Create: `tests/figma-fidelity.test.ts`
- Modify: `src/cli/index.ts`（新增 `case 'figma-diff'`）

**Interfaces:**
- Consumes: `findFramePairs`、`comparePng`、`buildReport`（Task A1）、`RenderRunner`、`pngSize`（Task A2）
- Produces:
  ```ts
  export interface FidelityOptions {
    docsDir: string;
    repoDir: string;
    runner?: RenderRunner;   // 預設 playwrightRunner()
  }
  export interface FidelityReport {
    frames: FrameDiff[];
    hardFailures: number;
    jsonPath: string;
    mdPath: string;
  }
  export async function measureFidelity(opts: FidelityOptions): Promise<FidelityReport>;
  ```

- [ ] **Step 1: 寫失敗的測試**

`tests/figma-fidelity.test.ts`（用假的 runner，永遠不跑真的瀏覽器）：

```ts
describe('Figma 量測流程', () => {
  it('渲染失敗算硬失敗，報告裡寫得出原因', async () => {
    const runner = async () => ({ ok: false, error: 'playwright screenshot failed (code 1): boom' });
    const report = await measureFidelity({ docsDir, repoDir, runner });
    expect(report.hardFailures).toBe(1);
    expect(report.frames[0].status).toBe('render_failed');
    expect(report.frames[0].error).toContain('boom');
  });

  it('缺原型頁算硬失敗', async () => { /* 只有截圖，沒有 html */ });

  it('尺寸對不上算硬失敗，而且不去比像素', async () => { /* 截圖 10x10，渲染出來 20x20 */ });

  it('全部量測成功時 hardFailures 是 0，報告寫到 figma/diff/', async () => {
    const report = await measureFidelity({ docsDir, repoDir, runner: okRunner });
    expect(report.hardFailures).toBe(0);
    expect(fs.existsSync(path.join(docsDir, 'figma', 'diff', 'report.md'))).toBe(true);
    expect(fs.existsSync(path.join(docsDir, 'figma', 'diff', 'frames.json'))).toBe(true);
  });

  it('沒有任何截圖時不算硬失敗（沒有東西可比）', async () => {
    const report = await measureFidelity({ docsDir, repoDir, runner: okRunner });
    expect(report.hardFailures).toBe(0);
  });
});
```

- [ ] **Step 2: 跑測試，確認失敗**

```bash
npx vitest run tests/figma-fidelity.test.ts
```
Expected: FAIL —— module not found

- [ ] **Step 3: 實作 `src/figma/fidelity.ts`**

流程：
1. `findFramePairs(docsDir)` → `pairs` 與 `missingHtml`。
2. `missingHtml` 每一個 → 一筆 `FrameDiff { status: 'missing_html' }`（硬失敗）。
3. 每個 pair：
   a. `pngSize(screenshot)` → W×H；讀不到 → `status: 'size_mismatch'`（不對，讀不到是 `diff_failed`）。
   b. `runner({ html, out: diff/render/<key>.png, width: W, height: H, cwd: repoDir })`
      - `!ok` → `status: 'render_failed'`，`error` = runner 的訊息。
   c. `pngSize(diff/render/<key>.png)` → 若與 (W,H) 不同 → `status: 'size_mismatch'`，**不進像素比對**。
   d. `comparePng(screenshot, render)` → `status: 'ok'`，`ratio` = 結果；把 `diff` buffer 寫到 `figma/diff/<key>.diff.png`。
4. 寫 `figma/diff/frames.json`（`buildReport(...).json`）與 `figma/diff/report.md`（`buildReport(...).md`）。目錄要先 `mkdirSync(..., { recursive: true })`。
5. `hardFailures` = status 不是 `'ok'` 的 frame 數。**沒有截圖時 frames 是空的，hardFailures 是 0。**

- [ ] **Step 4: 實作 CLI 子命令**

`src/cli/index.ts`：
- 在 `runCli` 的 switch（現在在第 124 行附近）加：
  ```ts
  case 'figma-diff':
    return await cmdFigmaDiff(args);
  ```
- 新增：
  ```ts
  /** `figma-diff --docs <dir> [--repo <dir>]`：量測 HTML 原型跟 Figma 截圖的差異。 */
  async function cmdFigmaDiff(args: ParsedArgs): Promise<number> {
    const docsDir = requireFlag(args, 'docs');
    const repoDir = args.flags.get('repo') ?? process.cwd();
    if (!fs.existsSync(docsDir)) {
      throw new CliError('invalid_arguments', `no such docs directory: ${docsDir}`);
    }
    const report = await measureFidelity({ docsDir, repoDir });
    emitResult({ frames: report.frames, hardFailures: report.hardFailures, report: report.mdPath });
    return report.hardFailures > 0 ? 1 : 0;
  }
  ```
- **退出碼契約（要寫進 README 與 `emitResult` 的說明）**：
  | 碼 | 意思 |
  |---|---|
  | 0 | 量測完成，沒有硬失敗（**可能有像素差** —— 那是軟指標） |
  | 1 | 量測完成，但有硬失敗（缺原型頁／渲染失敗／尺寸不符） |
  | 2 | 參數或環境錯誤（`--docs` 不存在） |

  這個命令不碰圖，所以 2 號碼在這裡代表「用法錯誤」，跟 `EXIT_INTERRUPT` 無關 —— 要在 `emitResult` 的 payload 裡明確標出 `exit` 語意。

- [ ] **Step 5: 跑測試，確認通過**

```bash
npx vitest run tests/figma-fidelity.test.ts
```

- [ ] **Step 6: 加一個 CLI 契約測試**

在 `tests/cli-contract.test.ts` 加：

```ts
it('figma-diff 沒有 --docs 時報 invalid_arguments', async () => {
  const rc = await runCli(['figma-diff']);
  expect(rc).toBe(1);
  expect(JSON.parse(io.take().err).code).toBe('invalid_arguments');
});
```

- [ ] **Step 7: 跑全部測試**

```bash
npx vitest run
npx tsc --noEmit
```
Expected: 全部 PASS，型別無錯

- [ ] **Step 8: Commit**

```bash
git add src/figma/fidelity.ts src/cli/index.ts tests/figma-fidelity.test.ts tests/cli-contract.test.ts
git commit -m "feat: sdd-graph figma-diff —— 量測 HTML 原型與 Figma 截圖的差異

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: A4 —— 產物路徑常數與 `checkPrototype`

**Files:**
- Create: `src/figma/paths.ts`
- Create: `tests/figma-paths.test.ts`
- Modify: `src/nodes/prd.ts`（`FIGMA_SCREENSHOT_DIR` 改為從新模組匯出）

**Interfaces:**
- Produces:
  ```ts
  export const FIGMA_SCREENSHOT_DIR = 'figma/screenshots';
  export const FIGMA_PROTOTYPE_DIR = 'figma/prototype';
  export const FIGMA_DIFF_DIR = 'figma/diff';
  export function checkPrototype(docsDir: string): { ok: boolean; missing: string[] };
  ```

- [ ] **Step 1: 寫失敗的測試**

```ts
describe('原型檢查', () => {
  it('每張截圖都要有對應的原型頁', () => {
    // 造 figma/screenshots/1-23.png 與 figma/prototype/1-23.html
    expect(checkPrototype(docsDir).ok).toBe(true);
    // 拿走 html
    expect(checkPrototype(docsDir).missing).toEqual(['figma/prototype/1-23.html']);
  });
  it('沒有截圖就算通過（沒有 Figma 的需求不受影響）', () => {
    expect(checkPrototype(docsDir).ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試，確認失敗**

```bash
npx vitest run tests/figma-paths.test.ts
```
Expected: FAIL —— module not found

- [ ] **Step 3: 實作 `src/figma/paths.ts`**

- 三個常數照抄上面的值。
- `checkPrototype(docsDir)`：列出 `figma/screenshots/` 底下的 `.png`，對每個 key 檢查 `figma/prototype/<key>.html` 在不在；缺的就回 `figma/prototype/<key>.html`。

- [ ] **Step 4: 把 `prd.ts` 的常數改為轉出**

`src/nodes/prd.ts`：把 `export const FIGMA_SCREENSHOT_DIR = 'figma/screenshots';` 換成
`export { FIGMA_SCREENSHOT_DIR } from '../figma/paths.js';`
（保持對外匯出名稱不變，`tests/prd-stage.test.ts` 才不用改。）

- [ ] **Step 5: 跑測試，確認通過**

```bash
npx vitest run tests/figma-paths.test.ts tests/prd-stage.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/figma/paths.ts tests/figma-paths.test.ts src/nodes/prd.ts
git commit -m "feat: 原型產物的路徑常數與 checkPrototype

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: A5 —— 三張提示詞與兩個新 role

**Files:**
- Create: `prompts/figma-prototype.md`
- Create: `prompts/figma-polish.md`
- Modify: `prompts/figma-fetch.md`（截圖命名契約 + `frames[]`）
- Modify: `src/cli/protocol.ts`（`WORK_ORDER_ROLES` 加兩個 role）

**Interfaces:**
- Consumes: 無
- Produces: wire role `figma_prototype`、`figma_polish`（snake_case）

- [ ] **Step 1: 先改 `src/cli/protocol.ts`**

```ts
export const WORK_ORDER_ROLES = [
  'spec_writer',
  'e2e_planner',
  'task_splitter',
  'developer',
  'spec_reviewer',
  'quality_reviewer',
  'figma_fetch',
  'figma_prototype',
  'figma_polish',
] as const;
```

- [ ] **Step 2: 寫 `prompts/figma-prototype.md`**

必須用齊五個變數（`{{goal}}`、`{{cwd}}`、`{{inputs}}`、`{{outputs}}`、`{{outputFormat}}`），內容要點：

- 角色：**用 `figma-implement-design` skill 的流程**，把這次需求的 Figma 畫面做成獨立的靜態 HTML 原型。
- 每個 frame 的 nodeId 與寬高從 `inputs` 裡的 `figma/figma-meta.json` 的 `frames[]` 讀；拼出帶 `node-id` 的 Figma 網址給 skill。
- **skill 的步驟 5 要改**：不要寫進專案原始碼，要寫成一頁自帶的靜態 HTML（inline 或 `css/`，相對路徑的 `assets/`）。
- `css/tokens.css` 必填：design token 變成 CSS 變數，HTML 裡不准出現裸 hex。
- 一 frame 一頁 `<frameKey>.html` + `index.html` 索引頁。
- **迭代**：寫完一頁就跑 `sdd-graph figma-diff --docs <docsDir>`（docsDir 在工作單的 inputs 裡），依報告改，最多 3 輪，改到沒有硬失敗才回報。
- 約束：只寫 `outputs` 列出的路徑。

- [ ] **Step 3: 寫 `prompts/figma-polish.md`**

- 角色：依 `figma/diff/report.md` 的結果，把 `figma/prototype/*.html` 修到沒有硬失敗。
- 輸入：報告 + 現有的原型頁 + P0 素材。
- 約束：只寫 `outputs`；不要動 Figma 截圖（截圖是比對基準，不是產物）。

- [ ] **Step 4: 改 `prompts/figma-fetch.md`**

改兩處，其他不動：
1. 截圖命名：第 3 步改成「每個主要畫面（frame）存一張 png，檔名用 **frameKey**（nodeId 的 `:` 換成 `-`，例如 `1:23` → `1-23`）」，並刪掉「the name of the file is yours」。
2. 新增一條：`figma-meta.json` 必須有 `frames` 陣列，每個主要畫面一筆 `{ nodeId, name, width, height }`。

- [ ] **Step 5: 加一個提示詞契約測試**

`tests/prompt-loader.test.ts` 已經有列舉 `prompts/` 目錄的測試，確認新檔案會被檢查到。若那個測試斷言檔案數量，要跟著更新。

另外在 `tests/prompt-loader.test.ts` 加：

```ts
it('figma-prototype 的模板用齊五個變數', () => {
  expect(promptVariables('figma-prototype').sort()).toEqual(
    ['cwd', 'goal', 'inputs', 'outputs', 'outputFormat'].sort()
  );
});

it('figma-polish 的模板用齊五個變數', () => {
  expect(promptVariables('figma-polish').sort()).toEqual(
    ['cwd', 'goal', 'inputs', 'outputs', 'outputFormat'].sort()
  );
});
```

- [ ] **Step 6: 跑測試**

```bash
npx vitest run tests/prompt-loader.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add prompts/figma-prototype.md prompts/figma-polish.md prompts/figma-fetch.md src/cli/protocol.ts tests/prompt-loader.test.ts
git commit -m "feat: 原型與修補的提示詞，以及兩個新工作單 role

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: A6 —— 共用的 Figma 流程狀態機（接進 PRD 與 spec 階段）

**Files:**
- Create: `src/nodes/figma-flow.ts`
- Create: `tests/figma-flow.test.ts`
- Modify: `src/nodes/prd.ts`（第 2 步換成呼叫流程）
- Modify: `src/nodes/spec.ts`（補抓路徑後接原型流程）
- Modify: `src/graph/compile.ts`（`BuildGraphOptions` 加 `figmaOptions`）

**Interfaces:**
- Consumes: `measureFidelity`、`FidelityReport`（Task A3）、`checkPrototype`（Task A4）、`renderWorkOrder`（既有）
- Produces:
  ```ts
  export interface FigmaOptions {
    /** 量測函式；測試注入假的。預設是 measureFidelity。 */
    measure?: (opts: { docsDir: string; repoDir: string }) => Promise<FidelityReport>;
  }
  export interface FigmaFlowOptions {
    stage: string;      // 'prd' | 'spec'
    docsDir: string;
    repoDir: string;
    figmaUrl: string;
    gen: number;
    options?: FigmaOptions;
  }
  export async function figmaFlowStep(state: GraphState, opts: FigmaFlowOptions): Promise<NodeOutcome | undefined>;
  export function figmaPrototypeWorkOrder(docsDir: string, repoDir: string): InterruptPayload;
  export function figmaPolishWorkOrder(docsDir: string, repoDir: string, note: string): InterruptPayload;
  ```

- [ ] **Step 1: 先讓量測可以被注入**

`src/graph/compile.ts` 的 `BuildGraphOptions` 加：

```ts
  /**
   * How the Figma stage measures the prototype.
   *
   * The tests inject a fake measurer this way, so that a unit test never
   * runs a browser.
   */
  figmaOptions?: FigmaOptions;
```

然後把 `prdFn`／`specFn` 改成：

```ts
const prdFn: NodeFn = (state) => prdNode(state, opts.figmaOptions);
const specFn: NodeFn = (state) => specNode(state, opts.figmaOptions);
```

`prdNode`／`specNode` 的簽章各自加一個可選的第二參數。

- [ ] **Step 2: 寫失敗的測試**

`tests/figma-flow.test.ts`（沿用 `tests/prd-stage.test.ts` 的 `prdGraph()` 工廠寫法，把量測注入假的）：

```ts
describe('Figma 流程', () => {
  it('抓完之後要發一張原型工作單', async () => {
    // 假 bootstrap → collect_prd → figma_fetch → 回答
    const payload = await pending(g, cfg);
    expect(payload.role).toBe('figma_prototype');
  });

  it('P0 沒抓到時不發原型工作單，直接走到 confirm_prd', async () => {
    // 回答 figma_fetch 說失敗、什麼都沒寫
    const gate = await pending(g, cfg);
    expect(gate.type).toBe('confirm_prd');
  });

  it('量測有硬失敗時發一張修補工作單，修完再量一次', async () => {
    // 假的量測：第一次回一個硬失敗，第二次回 0
    const payloads: string[] = [];
    // ... 依序回答，直到看見 role === 'figma_polish'
    expect(payloads).toContain('figma_polish');
  });

  it('量測沒有硬失敗時不再發任何工作單', async () => { /* 直接到 confirm_prd */ });

  it('沒有 Figma 網址時不會出現任何原型工作單', async () => {
    // collect_prd 回答時不給 figma 網址
    const gate = await pending(g, cfg);
    expect(gate.type).toBe('confirm_prd');
  });

  it('confirm_prd 的 payload 要帶原型路徑與 diff 摘要', async () => {
    const gate = await pending(g, cfg);
    expect(gate.collected.prototype).toContain('figma/prototype/index.html');
    expect(gate.collected.diff).toBeDefined();
  });
});
```

- [ ] **Step 3: 跑測試，確認失敗**

```bash
npx vitest run tests/figma-flow.test.ts
```
Expected: FAIL —— module not found

- [ ] **Step 4: 實作 `src/nodes/figma-flow.ts`**

流程的 step key（記在**呼叫者自己的 stage** 底下，用 generation 分隔）：

| key | 意義 |
|---|---|
| `figma-fetch-done-<gen>` | 抓取工作單已回覆 |
| `figma-prototype-done-<gen>` | 原型工作單已回覆 |
| `figma-polish-done-<gen>-<n>` | 第 n 次修補工作單已回覆 |
| `figma-diff-summary` | 量測摘要（JSON 字串），給 `confirm_prd` 看 |

流程（每次呼叫最多一個 `interrupt()`）：

```
1. 若 !hasStageStep(figma-fetch-done-<gen>)：
     發 figma_fetch 工作單 → 回覆後記 step。
     若 checkFigmaP0(docsDir).missing.length > 0：
        記一筆 figmaTbcItem（不擋人），**直接跳到第 5 步**（沒有東西可以原型化）
2. 若 !hasStageStep(figma-prototype-done-<gen>)：
     發 figma_prototype 工作單 → 回覆後記 step。return（下一輪才量測）
3. 量測（不中斷）：
     report = await (options?.measure ?? measureFidelity)({ docsDir, repoDir })
     記 figma-diff-summary
     若 report.hardFailures > 0 且修補次數 < 2：
        發 figma_polish 工作單（note = 報告裡的失敗摘要）→ 回覆後記 step。return
4. 若硬失敗還在（修補次數用完）：
     記一筆**擋人的** TBC，說明哪幾個 frame 沒過
5. return undefined（流程走完）
```

- `figmaPrototypeWorkOrder(docsDir, repoDir)`：
  - `outputs` = `[<docsDir>/figma/prototype/index.html, <docsDir>/figma/prototype]`（原型目錄整個交給工人寫；`index.html` 另外列一次是為了讓 CLI 的 output 檢查看到它）
  - `inputs` = P0 四份 + `<docsDir>/figma/screenshots` + `<docsDir>/figma/figma-meta.json`
  - `role: 'figma_prototype'`，`resultSchema: 'none'`
  - prompt 用 `renderWorkOrder('figma-prototype', {...})`
- `figmaPolishWorkOrder(docsDir, repoDir, note)`：同上，但 `role: 'figma_polish'`，prompt 尾端加上 `## 上一輪量測的結果\n\n<note>\n`。

- [ ] **Step 5: 接進 `src/nodes/prd.ts`**

把第 2 步（`prd.ts:239-266`）換成：

```ts
const figmaUrl = readStageStep(state, STAGE, STEP_FIGMA_URL) ?? '';
if (figmaUrl !== '') {
  const outcome = await figmaFlowStep(state, {
    stage: STAGE, docsDir: docsDirOf(state), repoDir, figmaUrl, gen, options,
  });
  if (outcome !== undefined) return outcome;
}
```

**注意**：`prd.ts` 原本在 figma 工作單之後立刻做 `checkFigmaP0` 並記 TBC；那段搬到流程裡（第 1 步）。

- [ ] **Step 6: 接進 `src/nodes/spec.ts`**

`spec.ts` 的補抓路徑（`spec.ts:228-252`）在 figma_fetch 工作單之後也要走原型流程：把該段改成呼叫 `figmaFlowStep`，並且**在抓取之後**才進入原型（流程本身會判斷 P0 在不在）。

`spec.ts` 已經 import `figmaWorkOrder` from `prd.js`；改成 import `figmaFlowStep` from `figma-flow.js`。

- [ ] **Step 7: 讓 `confirm_prd` 帶上原型與 diff**

`prd.ts` 第 4 步的 payload：

```ts
const answer = interrupt({
  audience: 'user',
  type: 'confirm_prd',
  collected: collectedSummaryOf(state),
  prototype: path.join(docsDirOf(state), 'figma', 'prototype', 'index.html'),
  diff: readStageStep(state, STAGE, 'figma-diff-summary'),
});
```

- [ ] **Step 8: 跑測試**

```bash
npx vitest run tests/figma-flow.test.ts tests/prd-stage.test.ts tests/spec-stage.test.ts
```

**既有測試的預期影響**：`tests/prd-stage.test.ts` 裡「抓不到 P0」與「worker 回 ok 卻沒寫檔」兩條，因為流程在 P0 缺失時**跳過原型步驟**，下一個中斷仍然是 `confirm_prd` → **不需要改**。若有測試因此失敗，代表流程寫錯了。

- [ ] **Step 9: 跑全部測試與型別檢查**

```bash
npx vitest run
npx tsc --noEmit
```

- [ ] **Step 10: Commit**

```bash
git add src/nodes/figma-flow.ts src/nodes/prd.ts src/nodes/spec.ts src/graph/compile.ts tests/figma-flow.test.ts
git commit -m "feat: Figma 流程接上原型與量測迴圈

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: A7 —— 下游提示詞與 README

**Files:**
- Modify: `prompts/developer.md`
- Modify: `prompts/spec-writer.md`
- Modify: `prompts/quality-reviewer.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: 無
- Produces: 無

- [ ] **Step 1: 改 `prompts/developer.md`**

- P0 素材清單（第 51～54 行附近）加上：
  ```
  - `docs/<requirement>/figma/prototype/index.html`
  - `docs/<requirement>/figma/prototype/<frameKey>.html`
  - `docs/<requirement>/figma/prototype/css/tokens.css`
  ```
- 「UI 真值來源」那條改成：**以 HTML 原型為準、截圖為輔**（截圖只能說「長這樣」，HTML 能說間距與 token 是多少）。
- **同時把第 269 行的 `src/__tests__/<FeatureName>.test.tsx` 改成 `.test.ts`**（見 Task B3；同一個檔案一起改，避免兩次衝突）。

- [ ] **Step 2: 改 `prompts/spec-writer.md`**

`figma/*` 那一列加上「（含靜態 HTML 原型 `figma/prototype/index.html` —— 版面以它為準）」。

- [ ] **Step 3: 改 `prompts/quality-reviewer.md`**

- 「尺寸與間距對得上 design-tree / 截圖」改成「**對得上 `figma/prototype/` 的 HTML 原型**」。
- **明確寫：不跑像素 diff**（理由寫出來：像素 diff 已經在 PRD 階段跑過並留下證據；這裡是定性檢查）。
- 「有視覺證據（snapshot 或前後截圖）」保留。

- [ ] **Step 4: 改 `README.md`**

- PRD 階段的流程圖加上：fetch → prototype → 量測 →（必要時）polish → confirm。
- 工作單 role 表加上 `figma_prototype`、`figma_polish`。
- 產物表加上 `figma/prototype/`、`figma/diff/`。
- 新增一節說明 `sdd-graph figma-diff` 的用法與退出碼（0／1／2）。

- [ ] **Step 5: Commit**

```bash
git add prompts/developer.md prompts/spec-writer.md prompts/quality-reviewer.md README.md
git commit -m "docs: 下游提示詞改用 HTML 原型當視覺真值來源

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

# Part B —— SDD 流程效率

---

### Task 8: B1 —— 放寬 task 的複雜度（`L` 變成合法）

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/schema.ts`
- Modify: `src/nodes/task-split.ts`
- Modify: `tests/tasks-stage.test.ts`
- Modify: `tests/schema.test.ts`

**Interfaces:**
- Consumes: 無
- Produces:
  ```ts
  // src/state/types.ts
  export type Complexity = 'S' | 'M' | 'L';
  // src/nodes/task-split.ts
  export interface TaskSplitExit {
    ok: boolean;
    tasks: Task[];
    invalidComplexTasks: string[];  // L 但驗收條件少於 3 條的 task id
    duplicateIds: string[];
    orphanAcs: string[];
    orphanTasks: string[];
    slugDrift: string[];
    orphanTests: string[];
    error?: string;
  }
  ```

- [ ] **Step 1: 改型別與 schema**

`src/state/types.ts`：
```ts
/**
 * Complexity of a task AS STORED in the state.
 *
 * 'L' is legal: an 'L' task is a single behaviour that spans several files
 * but still fits in one developer turn. The gate rejects an 'L' that does
 * not look like a single behaviour - see `invalidComplexTasks`.
 */
export type Complexity = 'S' | 'M' | 'L';
```
（`ParsedComplexity` 不變，仍然是 `'S' | 'M' | 'L'`。）

`src/state/schema.ts`：
```ts
export const ComplexitySchema: z.ZodType<Complexity> = z.enum(['S', 'M', 'L']);
```
並把第 30～32 行「The `L` complexity is deliberately absent」那段模組註解改掉。

- [ ] **Step 2: 改 `src/nodes/task-split.ts`**

- `TaskSplitExit`：把 `hasComplexL: boolean` 換成 `invalidComplexTasks: string[]`。
- `taskSplitExit`（第 163 行）：算出
  ```ts
  const invalidComplexTasks = parsed
    .filter((task) => task.complexity === 'L' && task.acceptanceCriteria.length < 3)
    .map((task) => task.id);
  ```
  並把 `ok` 改成 `parsed.length > 0 && invalidComplexTasks.length === 0 && duplicateIdsOf(parsed).length === 0`。
  > **為什麼是「L 至少 3 條驗收條件」**：圖沒有辦法判斷「是不是單一行為」，但可以判斷「是不是有���條可觀察的驗收條件」。一個只有 1～2 條 AC 的 L，實際上是還沒拆開的 M。
- `isWorkable`（第 368 行）：現在所有複雜度都合法 → 這個窄化函式可以刪掉，`toStateTask` 直接吃 `ParsedTask`。
- `reasonFor`（第 391 行）：`if (exit.invalidComplexTasks.length > 0) return 'complexity_L';`
- `noteFor`（第 398 行）：把 L 的訊息換成
  ```
  'A task of complexity `L` must be a single behaviour: it needs at least 3 acceptance criteria. An `L` task with 1-2 criteria is an `M` that has not been split yet.'
  ```
  並把出問題的 task id 列進去。

- [ ] **Step 3: 改測試**

`tests/tasks-stage.test.ts`：
- 把「L 一定被退件」的那條改成「**L 可以通過**（有 3 條以上 AC 時）」。
- 新增一條：「L 只有 1～2 條 AC 時被退件，reason 是 `complexity_L`」。
- `exit.hasComplexL` 的斷言改成 `exit.invalidComplexTasks`。

`tests/schema.test.ts`：如果有斷言 `ComplexitySchema` 不接受 `'L'` 的測試，改成接受。

- [ ] **Step 4: 跑測試**

```bash
npx vitest run tests/tasks-stage.test.ts tests/schema.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/state/types.ts src/state/schema.ts src/nodes/task-split.ts tests/tasks-stage.test.ts tests/schema.test.ts
git commit -m "feat: L 級 task 合法，只要它看起來像一個行為

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: B2 —— task 拆分規則改成以效率為準

**Files:**
- Modify: `prompts/task-splitter.md`

**Interfaces:**
- Consumes: Task B1 的 `L` 定義
- Produces: 無

- [ ] **Step 1: 改硬性規則**

- 規則 2（複雜度）：改成
  > **複雜度只能是 `S`、`M` 或 `L`。** `L` = **一個行為、跨多個檔案、但一個 developer 回合做得完**。`L` 必須有 **3 條以上**的驗收條件（只有 1～2 條的 `L` 是還沒拆開的 `M`，會被退回）。
- 規則 3（驗收條件）：從「2～5 條」改成「**3～8 條**」。
- 新增規則：**task 數**——「整份計畫的 task 數約等於 `ceil(AC 數 / 4)`，最多 8 個。超過就是拆太細。」

- [ ] **Step 2: 改拆分原則**

- **測試不要獨立成 task**（唯一例外是最後一個端到端驗收 task）。
- **不要把骨架和內容拆開。**
- **不要把同一次改動拆成三段**（「加路由」「加元件」「接起來」是同一個行為的三段）。
- 補一句成本理由，讓模型知道為什麼：「每個 task 要花三次來回（實作、審查、審查）。多切一刀就是多三次來回。」

- [ ] **Step 3: 改範例**

表格範例裡的 `Complexity` 欄維持 `S` 沒關係，但把「AC Refs」的條數調到 3～4 條，讓範例跟新規則一致。

- [ ] **Step 4: 跑測試**

```bash
npx vitest run tests/tasks-stage.test.ts tests/prompt-loader.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add prompts/task-splitter.md
git commit -m "feat: task 拆分規則改成以效率為準

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 10: B3 —— 單元測試檔用 `.ts`，不用 `.tsx`

**Files:**
- Modify: `src/nodes/tdd.ts`（`taskTestPath`，現在在第 406 行附近）
- Modify: `prompts/developer.md`（第 269 行與第 207 行附近的範例）

**Interfaces:**
- Consumes: 無
- Produces: `taskTestPath(task)` 回 `src/__tests__/<slug>.test.ts`

- [ ] **Step 1: 寫失敗的測試**

在 `tests/tdd-loop.test.ts`（或 `tests/tdd-loop.test.ts` 旁邊的新檔 `tests/tdd-test-path.test.ts`）加：

```ts
import { taskTestPath } from '../src/nodes/tdd.js';

it('單元測試檔是 .ts，不是 .tsx', () => {
  expect(taskTestPath({ id: 'TASK-setup-qrcode-page-route' } as any)).toBe(
    'src/__tests__/setup-qrcode-page-route.test.ts'
  );
});
```

> `taskTestPath` 目前不是匯出的。要匯出它（`export function taskTestPath`）才能這樣測。

- [ ] **Step 2: 跑測試，確認失敗**

```bash
npx vitest run tests/tdd-test-path.test.ts
```
Expected: FAIL —— 得到 `.test.tsx`

- [ ] **Step 3: 改 `src/nodes/tdd.ts`**

```ts
export function taskTestPath(task: Task): string {
  const slug = task.id.replace(/^TASK-/, '');
  return `src/__tests__/${slug}.test.ts`;
}
```

`isTestPath` 的正則 `/(^|\/)__tests__\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)` **已經**接受 `.ts`，不用改。

- [ ] **Step 4: 改 `prompts/developer.md`**

- 第 269 行：`src/__tests__/<FeatureName>.test.tsx` → `src/__tests__/<FeatureName>.test.ts`
- 第 207 行附近的範例：`jest src/__tests__/TaskName.test.tsx` → `.test.ts`
- 補一句：「單元測試用 `.ts` 就夠 —— **不要為了單元測試開 `.tsx`**。」

- [ ] **Step 5: 跑測試**

```bash
npx vitest run tests/tdd-test-path.test.ts tests/tdd-loop.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/nodes/tdd.ts prompts/developer.md tests/tdd-test-path.test.ts
git commit -m "feat: 單元測試檔用 .ts，不要開 .tsx

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 11: B4 —— 驗證關卡並行（`test` 與 `e2e` 同時跑）

**Files:**
- Modify: `src/subgraphs/verify.ts`（`runGates`，現在在第 154 行附近）
- Modify: `tests/verify-retry.test.ts`

**Interfaces:**
- Consumes: `runCheck`（既有）、`VERIFY_CHECKS`（既有）
- Produces: 無（行為改變，介面不變）

- [ ] **Step 1: 寫失敗的測試**

`tests/verify-retry.test.ts` 加：

```ts
it('test 失敗時 e2e 仍然有跑（兩個關卡是同時的）', async () => {
  // runner: lint:ts → 0、lint → 0、test → 1、e2e → 0
  const { graph, cfg } = await runVerify(runner);
  await graph.invoke(..., cfg);
  const checks = snapshot.values.verification.checks;
  expect(checks.find((c) => c.name === 'e2e').status).toBe('passed');   // 舊行為是 'pending'
  expect(checks.find((c) => c.name === 'test').status).toBe('failed');
});

it('lint:ts 失敗時後面的關卡仍然不跑（型別錯了測試結果沒意義）', async () => {
  // runner: lint:ts → 1，其餘不該被呼叫
  expect(calls).not.toContain('e2e');
});
```

- [ ] **Step 2: 跑測試，確認失敗**

```bash
npx vitest run tests/verify-retry.test.ts
```
Expected: FAIL —— e2e 是 `pending`

- [ ] **Step 3: 改 `src/subgraphs/verify.ts` 的 `runGates`**

新的順序：**`lint:ts` → `lint` →（`test` ∥ `e2e`）**

理由寫進註解：
- `lint:ts` 先跑：型別錯了，後面的結果沒意義（維持既有語意）。
- `lint` 接著單獨跑：它帶 `--fix`，**會改動原始碼**；跟別的關卡同時跑就是競態。
- `test` 與 `e2e` **不動原始碼**（jest 寫 snapshot、playwright 寫 `test-results/`，互不干涉），而且 e2e 通常最慢 —— 讓它跟 test 同時跑，總時間從 sum 變 max。

實作：

```ts
async function runGates(repoDir, docsDir, opts): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  const runOptions = { docsDir, timeoutMs: opts.timeoutMs, runner: opts.runner };

  // 第一段：lint:ts 與 lint 必須順序跑（lint 會改原始碼）
  for (const spec of VERIFY_CHECKS.filter((s) => s.name === 'lint:ts' || s.name === 'lint')) {
    const result = await runWithRetries(spec, repoDir, runOptions);
    checks.push(toCheck(spec, result));
    if (result.status === 'failed') {
      for (const rest of VERIFY_CHECKS.slice(checks.length)) {
        checks.push({ name: rest.name, status: 'pending', retries: 0 });
      }
      return checks;
    }
  }

  // 第二段：test 與 e2e 同時跑
  const tail = VERIFY_CHECKS.filter((s) => s.name === 'test' || s.name === 'e2e');
  const results = await Promise.all(tail.map((spec) => runWithRetries(spec, repoDir, runOptions)));
  tail.forEach((spec, i) => checks.push(toCheck(spec, results[i])));
  return checks;
}
```

`runWithRetries` 與 `toCheck` 是新抽出的小函式（重試上限沿用 `MAX_CHECK_RETRIES = 2`；`lint` 的自我修復二次執行仍由 `runCheck` 內部處理）。

- [ ] **Step 4: 跑測試**

```bash
npx vitest run tests/verify-retry.test.ts tests/verify-manual-back-to-tdd.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/subgraphs/verify.ts tests/verify-retry.test.ts
git commit -m "perf: test 與 e2e 關卡同時跑

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 12: B5 —— 每個 task 只審一次（spec review 與 quality review 合併）

**Files:**
- Create: `prompts/reviewer.md`
- Delete: `prompts/spec-reviewer.md`、`prompts/quality-reviewer.md`
- Modify: `src/cli/protocol.ts`（role、`REJECTION_AWARE_ROLES`、`WorkerResultSchema` 加 `reviews`）
- Modify: `src/state/types.ts`（`TddSubStage`、`lastReviews`）
- Modify: `src/state/schema.ts`（`TDD_SUB_STAGES`、`lastReviews`）
- Modify: `src/graph/state.ts`（`tddSubStage` 與 `lastReviews` 的 channel）
- Modify: `src/nodes/review.ts`（工作單與 `reviewContext`）
- Modify: `src/subgraphs/tdd.ts`（子階段狀態機）
- Modify: `src/nodes/tdd.ts`（`reviewSection` 顯示兩份審查）
- Modify: `tests/tdd-loop.test.ts`、`tests/tdd-escalation.test.ts`、`tests/tdd-rejection.test.ts`、`tests/review-severity.test.ts`、`tests/graph-state.test.ts`、`tests/schema.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/state/types.ts
  export type TddSubStage = 'pending' | 'developer_done' | 'review_done' | 'completed';
  // src/state/types.ts
  lastReviews: ReviewResult[];   // 取代 lastReview: ReviewResult | null
  // src/cli/protocol.ts
  export const WORK_ORDER_ROLES = [..., 'reviewer'] as const;   // 移除 spec_reviewer / quality_reviewer
  // src/cli/protocol.ts
  export const WorkerResultSchema = z.object({
    ...,
    review: ReviewResultSchema.optional(),
    reviews: z.array(ReviewResultSchema).optional(),   // 合併審查回兩份
  });
  // src/nodes/review.ts
  export function reviewWorkOrder(state: GraphState, task: Task): WorkOrder;   // 不再有 role 參數
  ```

- [ ] **Step 1: 改 state（型別、schema、channel）**

`src/state/types.ts`：
```ts
export type TddSubStage = 'pending' | 'developer_done' | 'review_done' | 'completed';
```
`lastReview: ReviewResult | null` → `lastReviews: ReviewResult[]`。

`src/state/schema.ts`：`TDD_SUB_STAGES` 改成 `['pending','developer_done','review_done','completed']`；`lastReview: ReviewResultSchema.nullable().default(null)` → `lastReviews: z.array(ReviewResultSchema).default([])`。

`src/graph/state.ts`：`lastReview` 的 channel 改成
```ts
lastReviews: Annotation<ReviewResult[]>({ reducer: (_p, n) => n, default: () => [] }),
```

- [ ] **Step 2: 改 `src/cli/protocol.ts`**

- `WORK_ORDER_ROLES`：移除 `'spec_reviewer'`、`'quality_reviewer'`，加入 `'reviewer'`。
- `REJECTION_AWARE_ROLES`：改成 `['developer', 'reviewer']`。
- `WorkerResultSchema` 加 `reviews: z.array(ReviewResultSchema).optional()`。

- [ ] **Step 3: 改 `src/nodes/review.ts` 與 `src/subgraphs/tdd.ts`**

- `src/nodes/review.ts` 的 `reviewWorkOrder(state, task)`：拿掉 `role` 參數；prompt 改用 `renderWorkOrder('reviewer', {...})`；`role: 'reviewer'`；`resultSchema: 'review'`；`outputs: []`。
- `src/nodes/review.ts` 的 `reviewContext(state)`：把 `state.lastReview` 改成 `state.lastReviews`（陣列），逐份渲染。
- `src/nodes/review.ts` 的 `reviewRoleOf`：**刪掉**（role 從 order 上拿，合併後不再需要）。
- `src/subgraphs/tdd.ts` 的 `readReview`（現在在第 523 行附近）：改成先找 `reviews` 裡 `role` 相符的那一份，找不到才看單一的 `review`。
  ```ts
  function readReview(answer: unknown, role: 'spec' | 'quality'): ReviewResult | undefined {
    const result = answer as { review?: unknown; reviews?: unknown } | undefined;
    const list = Array.isArray(result?.reviews) ? result.reviews : [];
    for (const item of list) {
      const parsed = ReviewResultSchema.safeParse(item);
      if (parsed.success && parsed.data.role === role) return parsed.data;
    }
    const single = ReviewResultSchema.safeParse(result?.review);
    if (single.success && single.data.role === role) return single.data;
    return undefined;
  }
  ```

- [ ] **Step 4: 寫 `prompts/reviewer.md`，刪掉舊的兩份**

新模板一次做兩段審查，**回報兩份 ReviewResult**：

```
## 第一段：spec 合規
（照 spec-reviewer.md 的內容：驗收條件有沒有達成、邊界條件、有沒有做超出範圍的事）

## 第二段：品質
（照 quality-reviewer.md 的內容：設計、測試、錯誤處理、可讀性）

## 完成時
sdd-graph complete --result '{"status":"ok","summary":"...","changedFiles":[],"reviews":[{...role:"spec"...},{...role:"quality"...}]}'
```

（刪掉舊檔案後，`prompts/` 只剩一份 reviewer。）

- [ ] **Step 5: 改 `src/subgraphs/tdd.ts` 的狀態機**

- switch（現在第 129 行附近）改成：
  ```ts
  case 'pending': return developerStep(state, task);
  case 'developer_done': return reviewStep(state, task);
  case 'review_done': return finishTask(state, tasks.length);
  case 'completed': return startCycle();
  ```
- `reviewStep(state, task)`（拿掉 `role` 參數）：
  1. `const order = reviewWorkOrder(state, task);`
  2. `const answer = interrupt(workOrderPayload(order));`
  3. 取出兩份審查：`const spec = readReview(answer, 'spec'); const quality = readReview(answer, 'quality');`
  4. 兩份都缺 → 視為無效審查，走既有的 `handleRejection(state, task, 'invalid_review')` 路徑。
  5. `update.lastReviews = [spec, quality].filter(Boolean)`
  6. **任一 verdict 是 `fail` → `escalateTask(state, task, spec && spec.verdict === 'fail' ? spec : quality)`**（沿用既有：spec 先，spec 過了才看 quality）。
  7. 否則 → `tddSubStage: 'review_done'`。

- `src/nodes/tdd.ts` 的 `reviewSection(state.lastReview)` → 改成渲染 `state.lastReviews` 全部。

- [ ] **Step 6: 改測試**

- `tests/tdd-loop.test.ts`：把「開發 → spec 審查 → 品質審查」三個中斷，改成「開發 → 合併審查」兩個中斷。
- `tests/tdd-escalation.test.ts`：審查失敗的 escalate 行為改成用 `reviews` 陣列回覆。
- `tests/tdd-rejection.test.ts`：審查工作單的 role 從 `spec_reviewer`／`quality_reviewer` 改成 `reviewer`。
- `tests/review-severity.test.ts`：確認 high 嚴重度仍然影響判定。
- `tests/graph-state.test.ts`、`tests/schema.test.ts`：`lastReview` → `lastReviews`、`TDD_SUB_STAGES` 少兩個值。

- [ ] **Step 7: 跑全部測試與型別檢查**

```bash
npx vitest run
npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add -A src prompts tests
git commit -m "perf: 每個 task 只審一次 —— spec 與品質審查合併成一張工作單

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 驗證方式（全部做完之後）

1. **單元測試與型別**：
   ```bash
   npx vitest run
   npx tsc --noEmit
   ```
2. **量測命令的手動驗證**（用一個假的原型頁，不需要真的 Figma）：
   ```bash
   mkdir -p /tmp/figma-demo/figma/screenshots /tmp/figma-demo/figma/prototype
   # 放一張 png 與對應的 html
   npx tsx src/cli/index.ts figma-diff --docs /tmp/figma-demo --repo "$PWD"
   echo "exit=$?"
   ```
   預期：沒有 Playwright 時 exit=2（或 1）**而且訊息說得出是環境問題**（Review Focus #1），不是一個沒頭緒的失敗。
3. **端到端**：在一個真的 Figma 檔上跑 `/sdd-graph:start`，確認
   - `figma/prototype/index.html` 存在而且瀏覽器開得起來；
   - `figma/diff/report.md` 有每個 frame 的分數；
   - `confirm_prd` 的 payload 帶著原型路徑與 diff 摘要。
4. **流程效率**：同一個需求跑一次，數 task 數與中斷次數 —— 目標是 task 數下降、每個 task 的中斷從 3 次降到 2 次。

## 收尾

實作完成後，把這份計畫存成 `specs/2026-10-30-implementation-plan.md` 並 commit（`/docs/` 被 gitignore，計畫要跟 spec 放一起）。
