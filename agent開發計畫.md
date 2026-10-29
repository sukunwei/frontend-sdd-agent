# SddGraphAgent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 LangGraph 做出可中斷、可恢復、可測試的 SDD **編排器**；當前 Claude Code 會話當寫程式/寫文件的**工人**。圖決定下一階段與工作單，宿主會話只負責執行工作單，不決定流程。

**Architecture:** 父圖持有階段路由（8 階段），`interrupt()` 分兩類 audience：`user` 問人、`host` 發工作單給本會話。圖內只放確定性節點（bootstrap/verify/git tag/解析器）；寫 spec、寫程式、拉 Figma、評審全部是 `audience: host` 工作單，由宿主會話用既有工具（含 Figma MCP）完成，圖只驗收 outputs 是否落盤。**不在圖內嵌套 Agent SDK**，不自己寫 fs 工具循環。

**Tech Stack:** TypeScript (ESM)、Node ≥ 20；`@langchain/langgraph@1.5.3`、`@langchain/langgraph-checkpoint-sqlite@1.1.0`、`zod@4`、`vitest@5`、`tsx`（dev）；不引入 `@langchain/anthropic`、Agent SDK、LangGraph Cloud。

**Spec:** [`实现方案.md`](./实现方案.md)（本計畫的設計文件；下方「與實作方案的差異」列出實作前核對出的修正）

## Global Constraints

- 套件名 `sdd-graph`，插件根 = `agent-study/frontend-sdd-agent/`；marketplace `plugins/sdd-graph` symlink 改指向本目錄，既有 `sdd-agent` 插件不動（兩套 `/sdd-agent:*` 與 `/sdd-graph:*` 並行）。
- `package.json` 必須有 `"type": "module"`（少了這行 top-level await 會編譯失敗，tsx 會退回 CJS）。
- 依賴版本釘死：`@langchain/langgraph@1.5.3`、`@langchain/langgraph-checkpoint-sqlite@1.1.0`、`zod@4.6.7`、`vitest@5.0.5`、`typescript@5`、`tsx@4`。**禁止**加入 `@langchain/anthropic`、Agent SDK、LangGraph Cloud、Postgres checkpointer。
- 階段固定 8 個，順序不可變：`bootstrap → prd → spec → e2ePlan → taskSplit → tdd → verification → completed`。
- TDD 子階段固定 5 個：`pending | developer_done | spec_review_done | quality_review_done | completed`。**v1 沒有 code_review**。
- `thread_id` = 正規化後的 task name = requirement name（單一識別碼，不另立 requirementName 欄位來源）。
- 狀態只存指標（path / hash / 列舉 / 索引）。父 state **不放** `messages`。
- **節點中斷採「就地 `interrupt(payload)`」**：節點函式在自己的 body 內呼叫 `interrupt(payload)`。第一次執行時它丟出 `GraphInterrupt` 使整個 run 停駐；resume 時它**回傳答案**，節點隨後用該答案繼續。`NodeOutcome` 只有 `advance` 變體，**不承載中斷**；`Command({ interrupt })` 在 `@langchain/langgraph@1.5.3` 不存在（會靜默丟棄 payload）。
- **中斷必須是節點做的第一件事**：resume 時 LangGraph 會**重新執行整個節點函式**，所以任何排在 `interrupt()` 之前的副作用（寫檔、git 指令）都會在停駐前與 resume 後各跑一次。所有需要使用者答案的節點一律「先問、再寫」。
- **每個節點執行最多只能呼叫一次 `interrupt()`**：LangGraph 的 `interrupt()` 是依 `scratchpad.resume[idx]` 取值，而 `__resume__` 寫入會**跨多次 approve 累積** —— 同一個節點執行裡的第二次 `interrupt()` 呼叫會**吃掉下一個排隊的答案**而不是再次停駐（審查者實測：第二次 approve 後閘口直接失效、clone 嘗試次數變成 3→6→9→12 倍增）。需要「再問一次」時，**用 `{ kind: 'advance', update: {}, goto: '同一節點' }` 路由回自己**，讓它在**下一次執行**重新開始，而不是在同一個執行裡再問一次。
- 圖是 `currentStage` 的**唯一**寫入者；`workflow-state.json` 只是給人看的鏡像，不是 resume 真源（真源只有 checkpointer）。
- 所有 interrupt payload 必須帶 `audience`；`audience: user` 只能由 `approve` 推進，`audience: host` 只能由 `complete` 推進。退出碼：`0` = 完成或無待辦、`2` = 有待處理 interrupt（stdout 是 JSON 信封）、`1` = 錯誤（stderr 是 JSON）。
- 工作單 `inputs` / `outputs` 一律**絕對路徑**；換會話 resume 時只靠這些路徑重讀落盤產物。
- 文件產物落在**克隆的 repo 內**：`<repoDir>/docs/<requirementName>/`（`prd.md` / `spec.md` / `e2e-plan.csv` / `tasks.md` / `workflow-state.json` / `timeline.md` / `verify/*.log` / `figma/*`）。
- checkpoint 落在 `<pluginRoot>/runtime/checkpoints.sqlite`；鎖落在 `<pluginRoot>/runtime/branch-runtime-lock.json`；clone 落在 `<pluginRoot>/workspace/tasks/<taskName>/repo`。
- 複雜度是 **S / M / L**，L 級不得出現在 tasks.md（不得寫成 L1/L2/L3 —— 那是 jest `describe` 巢狀層級，與複雜度無關）。
- ID 格式：`AC-\d{3}`（spec）、`E2E-\d{3}`（e2e-plan.csv）、`TASK-<標題派生 slug>`（tasks.md）、`TBC-\d{3}`（spec）、`Q-\d{3}`（spec）。
- v1 **不做**：`trace-events.jsonl`、state 內 telemetry、pixel/LHCI/a11y 門禁、Arbiter、第三個評審（code-reviewer）、`/sdd-graph:change` 真實作、Postgres checkpointer、多 requirement 並行、圖內嵌套 Agent SDK。
- 每個 Task 結束提交一次 git commit（目錄目前不是 git 倉庫，Task 1 先 `git init`）。

## 與實作方案的差異

實作方案.md 寫於 2026-10-27；動工前逐條比對現有程式碼後，以下 8 處需要修正。**以本節為準。**

| # | 實作方案的說法 | 核對結果 | 修正 |
|---|---|---|---|
| 1 | §12「仍放在本插件目錄」 | 使用者已決定：新插件自成一體，放 `frontend-sdd-agent/`，marketplace symlink 改指向它；舊 `sdd-agent` 插件不動 | 程式碼不寫進 `~/.claude/plugins/sdd-agent/` |
| 2 | §10「`docs/<name>/` 與 `workspace/tasks/<name>/repo` 分離」 | 使用者已決定：文件寫進克隆的 repo 內，隨 git 提交 | docs 根 = `<repoDir>/docs/<requirementName>/`；`state-manager.ts` 的 `DOCS_BASE='docs'`（相對 CWD）廢棄 |
| 3 | §6 `thread_id = requirementName` | 現有 runtime 只有 task name 一個識別碼（`normalizeTaskName`），兩者實際同一 | 單一 `requirementName` 欄位 = 正規化 task name = thread_id |
| 4 | §5「tdd 僅 L2/L3 需人工」 | 複雜度實際是 **S/M/L**（`spec-to-tasks/SKILL.md:46-55`）；L1/L2 是 jest describe 層級 | 術語改正；L 級**不得出現**是 taskSplit 的確定性拒絕條件（見 Task 10） |
| 5 | §8.3「解析 `TASK-xxx`」 | 現有 fixture 用位置型 `task-1..task-7`，重新拆分會錯位 | 改用穩定 slug `TASK-<標題派生>`；解析器同時接受舊 `task-N` |
| 6 | §5/§9 未提 traceability | 既有 `/sdd-agent:traceability-sync` 與 `docs/qrcode-app/traceability.md` 存在，且既有 skill 定義了 AC↔Task↔E2E 覆蓋閘門 | v1 納入**確定性**矩陣（純 ID 比對，不做語意相似度）；見 Task 10 |
| 7 | §11 `docs/<name>/workflow-state.json` | 現行程式碼有**三處**互相矛盾的路徑假設（`state-manager.ts` 相對 CWD、`status.ts` 用 `taskDir/repo/docs/`、`resume.md` 用 repo 內 docs） | 統一由 `<pluginRoot>/src/runtime/paths.ts` 解析，禁止 `__dirname` 算術與相對路徑 |
| 8 | §12「`workspace/`、`docs/` 必須 gitignore」 | `docs/` 是產物，但 `docs/qrcode-app/` 同時是測試 fixture | fixture 移入 `tests/fixtures/qrcode-app/`；插件根的 `docs/` 全部 gitignore |

另外三點是**已實測驗證**、會直接決定寫法的 LangGraph v1 行為（Task 3、4 必須遵守）：

- `Annotation<T>({ default: () => x })` **沒有** `reducer` 時，`getChannel()` 會退化成 `LastValue`，default 被**靜默丟棄**（欄位在 state 裡直接消失），而且型別上 `SingleReducer` 要求 `reducer` 必填 → 直接是 TS 錯誤。**每個 state 欄位都必須帶 `reducer`。**
- 用 `Command({ update, goto })` 跳到某節點時，該節點必須在 `.addNode(name, fn, { ends: [...] })` 的 `ends` 陣列中被宣告，否則編譯期直接丟 `UnreachableNodeError: Node \`prd\` is not reachable.`。`ends` 只能列**真實存在的節點名**，列到不存在的節點會丟 `Found edge ending at unknown node`。
- pending interrupt 不會讓 `invoke()` 丟例外，而是在回傳值帶 `__interrupt__` 陣列；同一筆 payload 可從 `graph.getState(config).tasks[0].interrupts[0].value` 讀出，`graph.getState(config).next` 給出待執行節點名。這是 CLI 與 `resume` 唯一的讀取來源。

還有兩個實測到的邊界行為，直接決定 CLI 怎麼寫：

- **`invoke()` 在最後一個節點回傳空更新（`{}` 或 `undefined`）時，整個回傳值會是 `undefined`，不是 state。** 所以 (a) 每個節點都要回傳至少一個欄位的更新；(b) CLI **不得**依賴 `invoke()` 的回傳值取得最終狀態，一律改讀 `graph.getState(config).values`。
- **`invoke(null, config)` 在已有 checkpoint 的 thread 上可以正常 resume（不會重跑已完成的節點）；在沒有 checkpoint 的 thread 上會丟 `EmptyInputError: Received no input writes for "__start__"`。** 所以 `resume` 必須先 `getState(config)` 確認 checkpoint 存在，才決定要不要 `invoke`。

## Review Focus

以下五類是規格隱含、但沒有任何 Task 的測試會覆蓋的失敗模式，最可能咬到實際使用的人。每條都已在對應 Task 補上對應測試。

1. **同一張工作單被 `complete` 兩次**（宿主重試、模型重複呼叫）→ 第二次必須報錯，不得重複推進階段、不得重複計失敗次數。→ Task 4
2. **`complete` 回報成功但 `outputs` 檔案不存在** → 必須重發同一張單，且**不**計入 TDD 失敗次數（否則無辜的 worker 會被升級到 rollback）。→ Task 4、Task 12
3. **評審結果是散文「PASS」而不是 ReviewResult JSON** → 必須判為 fail 並重發該張單，第二次仍非 JSON 才升級。→ Task 4、Task 12
4. **宿主擅自改了 `workflow-state.json` 或 lock** → 鏡像必須由圖獨家覆寫，lock 只能由 `stop` 釋放。→ Task 2、Task 5
5. **換會話 resume** → 重發的工作單 `inputs` 必須是落盤的絕對路徑，不得引用上一輪聊天記憶；否則換會話就做不下去。→ Task 4、Task 11

## File Structure

```
frontend-sdd-agent/
├── 实现方案.md                          # 設計文件（已存在，本計畫的 spec）
├── agent開發計畫.md                      # 本文件
├── package.json                         # "type":"module"；bin: { "sdd-graph": "./bin/sdd-graph" }
├── tsconfig.json                        # strict；module NodeNext；outDir dist
├── vitest.config.ts
├── .gitignore                           # node_modules/ dist/ workspace/ runtime/ docs/
├── .claude-plugin/plugin.json            # { "name": "sdd-graph", "version": "0.2.0" }
├── bin/sdd-graph                        # shim：解析插件根後 exec 本地 tsx
├── src/
│   ├── cli/
│   │   ├── index.ts                     # runCli(argv): Promise<number>；退出碼 0/1/2
│   │   ├── protocol.ts                  # zod：WorkOrder / WorkerResult / ReviewResult
│   │   └── envelope.ts                  # stdout JSON 信封（interrupt / error）
│   ├── graph/
│   │   ├── state.ts                     # SddStateAnnotation（每欄位帶 reducer）
│   │   ├── reducers.ts                  # mergeById / mergeRecord / mergeVerification
│   │   └── compile.ts                   # buildGraph(): CompiledGraph
│   ├── nodes/
│   │   ├── bootstrap.ts                 # startTask() 包裝 + lock/already_exists interrupt
│   │   ├── prd.ts                       # collect_prd → figma_fetch → confirm_prd
│   │   ├── spec.ts                      # spec 工作單 + AC 解析 + blocking TBC 閘門
│   │   ├── e2e-plan.ts                  # e2e 工作單 + E2E 解析
│   │   ├── task-split.ts                # tasks 工作單 + TASK slug 解析 + L 級拒絕 + traceability
│   │   └── verify-checks.ts             # 四道關的執行與日誌
│   ├── subgraphs/
│   │   ├── tdd.ts                       # task 串行迴圈 + 升級
│   │   └── verify.ts                    # 四關順序 + 重試 + interrupt
│   ├── parsers/
│   │   ├── ids.ts                       # AC / E2E / TASK slug / TBC / Q / complexity
│   │   ├── spec-md.ts                   # spec.md → AC / TBC / Q
│   │   ├── tasks-md.ts                  # tasks.md → Task[]
│   │   └── e2e-csv.ts                   # e2e-plan.csv → E2E 條目
│   ├── persistence/
│   │   ├── checkpoint.ts                # SqliteSaver 封裝
│   │   └── artifact-store.ts            # workflow-state.json + timeline.md
│   ├── prompts/loader.ts                # prompts/*.md 渲染（{{var}} 取代）
│   └── runtime/
│       ├── paths.ts                     # 插件根解析 + 所有路徑（唯一來源）
│       ├── task-name.ts                 # normalizeTaskName 等
│       ├── task-workspace.ts            # initTaskWorkspace 等
│       ├── branch-lock.ts               # acquire/release/getLock 等
│       ├── git-branch-manager.ts        # cloneBranch 等
│       ├── git-tags.ts                  # sdd/task/<id>/start 標籤
│       └── errors.ts                    # createError / classifyError
├── prompts/                             # 工作單正文（從既有 skills/、agents/ 遷移）
│   ├── spec-writer.md
│   ├── e2e-planner.md
│   ├── task-splitter.md
│   ├── developer.md
│   ├── spec-reviewer.md
│   ├── quality-reviewer.md
│   └── figma-fetch.md
├── commands/                            # Claude Code 宿主 LOOP
│   ├── start.md
│   ├── resume.md
│   ├── status.md
│   └── stop.md
└── tests/
    ├── fixtures/qrcode-app/             # 從 sdd-agent/docs/qrcode-app 複製並改正 ID
    └── *.test.ts
```

`src/runtime/*` 是從 `~/.claude/plugins/sdd-agent/src/runtime/*` **複製**而來（不是跨插件 import —— 舊 `lang-graph-agent` 原型就是用相對路徑跨插件 import `../../../sdd-agent/src/...`，單獨安裝時會壞掉）。複製的同時修掉路徑 bug（見 Task 1）。

---

### Task 1: 可執行包、根路徑解析、runtime 移植

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.claude-plugin/plugin.json`, `bin/sdd-graph`
- Create: `src/runtime/paths.ts`
- Create: `src/runtime/task-name.ts`, `src/runtime/task-workspace.ts`, `src/runtime/branch-lock.ts`, `src/runtime/git-branch-manager.ts`, `src/runtime/errors.ts`（自 `~/.claude/plugins/sdd-agent/src/runtime/` 複製）
- Test: `tests/paths.test.ts`, `tests/task-name.test.ts`

**Interfaces:**
- Consumes: 無
- Produces:
  - `getPluginRoot(): string` — 從 `import.meta.url` 向上走，尋找含 `.claude-plugin/plugin.json` 的祖先目錄；找不到則 throw `Error('plugin root not found')`
  - `getWorkspaceBase(): string` = `process.env.SDD_GRAPH_WORKSPACE_BASE ?? <pluginRoot>/workspace/tasks`（**測試必須能用這個環境變數指向暫存目錄**，否則會污染插件根）
  - `getTaskDir(taskName: string): string` = `<workspaceBase>/<taskName>`
  - `getRepoDir(taskName: string): string` = `<taskDir>/repo`
  - `getDocsDir(taskName: string, requirementName: string): string` = `<repoDir>/docs/<requirementName>`
  - `getLockFilePath(): string` = `<pluginRoot>/runtime/branch-runtime-lock.json`
  - `getCheckpointPath(): string` = `<pluginRoot>/runtime/checkpoints.sqlite`
  - `getVerifyLogDir(taskName, requirementName): string` = `<docsDir>/verify`
  - `normalizeTaskName(raw: string): string`、`generateBranchName(n: string): string`、`generateRunId(): string`、`validateTaskName(raw: string): { valid: boolean; normalized: string; warnings: string[] }`
  - `initTaskWorkspace(n): TaskWorkspaceResult`、`taskWorkspaceExists(n): boolean`、`cleanupTaskWorkspace(n): void`
  - `acquireLock(...): { success: boolean; lock?: BranchRuntimeLock; holderTaskName?: string }`、`releaseLock()`、`forceUnlock()`、`getLock(): BranchRuntimeLock | null`、`getLockStatus()`、`validateLockOwnership(taskName)`
  - `cloneBranch(repoUrl, branchName, taskName): GitCloneResult`、`remoteBranchExists`、`getDefaultBranch`、`getCurrentBranch`、`getGitStatus`
  - `createError(code, message, originalError?): TaskInitError`、`classifyError(code): ErrorCategory`、`formatError(err): string`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/paths.test.ts
import { describe, expect, it } from 'vitest';
import { getPluginRoot, getDocsDir, getRepoDir, getWorkspaceBase } from '../src/runtime/paths.js';

describe('路徑解析', () => {
  it('插件根必須含 .claude-plugin/plugin.json', () => {
    expect(getPluginRoot().endsWith('/frontend-sdd-agent')).toBe(true);
    expect(getPluginRoot()).toContain('/.claude-plugin/');
  });

  it('docs 必須落在克隆的 repo 內，不是插件根', () => {
    const docs = getDocsDir('qrcode-app', 'qrcode-app');
    expect(docs).toBe(`${getRepoDir('qrcode-app')}/docs/qrcode-app`);
    expect(docs.startsWith(getPluginRoot() + '/docs')).toBe(false);
  });

  it('workspace base 預設固定在插件根下', () => {
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
    expect(getWorkspaceBase()).toBe(`${getPluginRoot()}/workspace/tasks`);
  });

  it('SDD_GRAPH_WORKSPACE_BASE 可覆寫 workspace base（測試用）', () => {
    process.env.SDD_GRAPH_WORKSPACE_BASE = '/tmp/sdd-ws';
    expect(getWorkspaceBase()).toBe('/tmp/sdd-ws');
    delete process.env.SDD_GRAPH_WORKSPACE_BASE;
  });
});
```

```ts
// tests/task-name.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/paths.test.ts tests/task-name.test.ts`
Expected: FAIL —— `Cannot find module '../src/runtime/paths.js'`

- [ ] **Step 3: Implement `src/runtime/paths.ts` 與移植的 runtime**

`src/runtime/paths.ts`：

```ts
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function getPluginRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('plugin root not found');
}
```

其餘路徑函式一律由 `getPluginRoot()` 推導。**不要**用 `path.resolve(__dirname, '../../..')` —— 既有 `task-name.ts` 用這招，只在輸出落在 `dist/src/runtime/` 時才剛好對到插件根；tsx 直接跑 `src/runtime/` 時會指到插件的**上一層**。

`src/runtime/*` 其餘五個檔案從 `~/.claude/plugins/sdd-agent/src/runtime/` 複製，僅做兩處改動：(a) 路徑函式改為 `import { ... } from './paths.js'`；(b) `errors.ts` 的 `ErrorCode` 補上 `'git_error'` 已在清單中即可，不加新碼。

`package.json`：`"type": "module"`、`"bin": { "sdd-graph": "./bin/sdd-graph" }`、`"scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" }`、依賴釘死 Global Constraints 的版本。

`bin/sdd-graph`：shell shim，從 `$0` 解析插件根後 `exec "<root>/node_modules/.bin/tsx" "<root>/src/cli/index.ts" "$@"`。

`.gitignore`：`node_modules/`、`dist/`、`workspace/`、`runtime/`、`docs/`、`*.sqlite`。

`.claude-plugin/plugin.json`：`{ "name": "sdd-graph", "version": "0.2.0", "description": "LangGraph-based SDD orchestrator: graph owns stage routing, the Claude Code session works the orders" }`

> **版本為何是 0.2.0 而不是 0.1.0：** Claude Code 的插件快取鍵是 `marketplace + name + version`。舊的 `sdd-graph` 原型已以 `0.1.0` 安裝在 `~/.claude/plugins/cache/fe-sdd/sdd-graph/0.1.0/`，若新插件沿用同版本，Claude Code 會繼續供應舊原型的 `commands/` 與 `src/`，而不是新程式碼。**不要調回 0.1.0。**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/paths.test.ts tests/task-name.test.ts && npm run typecheck`
Expected: PASS；typecheck 無錯誤

- [ ] **Step 5: Commit**

```bash
git init
git add package.json tsconfig.json vitest.config.ts .gitignore .claude-plugin bin src/runtime tests
git commit -m "$(cat <<'EOF'
feat: 建立 sdd-graph 可執行包與唯一的根路徑解析

EOF
)"
```

---

### Task 2: workflow-state 1.1.0 schema 與 ArtifactStore

**Files:**
- Create: `src/state/types.ts`, `src/state/schema.ts`, `src/persistence/artifact-store.ts`
- Test: `tests/schema.test.ts`, `tests/artifact-sync.test.ts`

**Interfaces:**
- Consumes: Task 1 `getDocsDir`
- Produces:
  - `type Stage = 'bootstrap' | 'prd' | 'spec' | 'e2ePlan' | 'taskSplit' | 'tdd' | 'verification' | 'completed'`
  - `type TddSubStage = 'pending' | 'developer_done' | 'spec_review_done' | 'quality_review_done' | 'completed'`
  - `type Complexity = 'S' | 'M' | 'L'`
  - `interface Task { id: string; title: string; description?: string; acceptanceCriteria: string[]; acRefs: string[]; complexity: Complexity; priority: 'high' | 'medium' | 'low' }`
  - `interface ReviewResult { role: 'spec' | 'quality'; verdict: 'pass' | 'fail'; issues: Array<{ file: string; line?: number; message: string; severity: 'critical' | 'medium' | 'low' }> }`
  - `interface VerificationCheck { name: 'lint:ts' | 'lint' | 'test' | 'e2e'; status: 'pending' | 'passed' | 'failed' | 'fixed'; retries: number; lastRunAt?: string; error?: string }`
  - `interface TBCItem { id: string; description: string; blocking: boolean; resolved: boolean; resolution?: string; createdAt: string }`
  - `interface Blocker { id: string; taskId: string; reason: string; createdAt: string }`
  - `interface ArtifactEntry { path: string; hash: string; updatedAt: string }`
  - `type ArtifactIndex = Record<string, ArtifactEntry>`
  - `type Approvals = Partial<Record<'prd' | 'spec' | 'e2ePlan' | 'taskSplit', string>>`
  - `interface SddState { version: '1.1.0'; requirementName: string; repoUrl: string; repoPath: string; branch: string; runId: string; bootstrapped: boolean; currentStage: Stage; artifacts: ArtifactIndex; tbcItems: TBCItem[]; tasks: Task[]; currentTaskIndex: number; tddSubStage: TddSubStage; lastReview: ReviewResult | null; tddAttempts: number; verification: { checks: VerificationCheck[] }; blockers: Blocker[]; approvals: Approvals; createdAt: string; updatedAt: string }`
  - `WorkflowStateSchema`（zod）—— 解析 `workflow-state.json`
  - `class ArtifactStore { constructor(taskName: string, requirementName: string); readonly statePath: string; readonly timelinePath: string; sync(state: SddState): void; load(): SddState | null; appendTimeline(entry: string): void }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/schema.test.ts
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

  it('複雜度不得是 L', () => {
    const bad = { version: '1.1.0', currentStage: 'taskSplit', tasks: [{ id: 'TASK-x', title: 'x', acceptanceCriteria: [], acRefs: [], complexity: 'L', priority: 'high' }] };
    expect(WorkflowStateSchema.safeParse(bad).success).toBe(false);
  });
});
```

```ts
// tests/artifact-sync.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ArtifactStore } from '../src/persistence/artifact-store.js';
import { getDocsDir } from '../src/runtime/paths.js';

describe('ArtifactStore', () => {
  it('state 與 workflow-state.json 雙向一致', () => {
    const store = new ArtifactStore('qrcode-app', 'qrcode-app');
    const state = { version: '1.1.0', requirementName: 'qrcode-app', currentStage: 'spec', tasks: [], tbcItems: [], blockers: [], approvals: {}, artifacts: {}, verification: { checks: [] } } as any;
    store.sync(state);
    const onDisk = JSON.parse(fs.readFileSync(path.join(getDocsDir('qrcode-app', 'qrcode-app'), 'workflow-state.json'), 'utf-8'));
    expect(onDisk.currentStage).toBe('spec');
    expect(onDisk.version).toBe('1.1.0');
    expect(store.load()?.currentStage).toBe('spec');
  });

  it('寫入是原子的（temp + rename），不會留半檔', () => {
    const store = new ArtifactStore('qrcode-app', 'qrcode-app');
    store.sync({ currentStage: 'prd' } as any);
    const dir = getDocsDir('qrcode-app', 'qrcode-app');
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('鏡像覆蓋宿主擅自改寫的內容', () => {
    const store = new ArtifactStore('qrcode-app', 'qrcode-app');
    store.sync({ currentStage: 'prd' } as any);
    const p = path.join(getDocsDir('qrcode-app', 'qrcode-app'), 'workflow-state.json');
    fs.writeFileSync(p, JSON.stringify({ currentStage: 'completed' }));
    store.sync({ currentStage: 'spec' } as any);
    expect(JSON.parse(fs.readFileSync(p, 'utf-8')).currentStage).toBe('spec');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/schema.test.ts tests/artifact-sync.test.ts`
Expected: FAIL —— `Cannot find module '../src/state/schema.js'`

- [ ] **Step 3: Implement schema 與 ArtifactStore**

`src/state/types.ts` 放上列所有 interface/type。`src/state/schema.ts` 用 zod v4 定義 `WorkflowStateSchema`，複雜度用 `z.enum(['S','M'])`（**不含 L**），並從 `src/state/types.ts` 推導型別。

`src/persistence/artifact-store.ts`：

```ts
export class ArtifactStore {
  constructor(private taskName: string, private requirementName: string) {}
  get statePath(): string { return path.join(getDocsDir(this.taskName, this.requirementName), 'workflow-state.json'); }
  get timelinePath(): string { return path.join(getDocsDir(this.taskName, this.requirementName), 'timeline.md'); }
  sync(state: SddState): void { /* mkdir -p；寫 .tmp 再 rename；附帶 updatedAt */ }
  load(): SddState | null { /* 不存在回 null；存在用 WorkflowStateSchema.parse */ }
  appendTimeline(entry: string): void { /* append 一行 markdown，含時間戳 */ }
}
```

`sync` 必須是 **temp + rename**，且每次都整份覆寫（鏡像由圖獨家寫入，見 Review Focus #4）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/schema.test.ts tests/artifact-sync.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state src/persistence tests
git commit -m "$(cat <<'EOF'
feat: 以 1.1.0 schema 與 ArtifactStore 取代一次性線性狀態管理器

EOF
)"
```

---

### Task 3: Graph state、checkpointer、entry_router

**Files:**
- Create: `src/graph/reducers.ts`, `src/graph/state.ts`, `src/persistence/checkpoint.ts`, `src/graph/compile.ts`
- Test: `tests/graph-state.test.ts`, `tests/entry-router.test.ts`

**Interfaces:**
- Consumes: Task 2 `SddState` 型別
- Produces:
  - `mergeById<T extends { id: string }>(left: T[], right: T[]): T[]` —— 以 id 覆蓋既有、附加新的
  - `mergeRecord<T>(left: Record<string, T>, right: Record<string, T>): Record<string, T>`
  - `mergeVerification(left: VerificationState, right: VerificationState): VerificationState` —— 依 `name` 合併 checks
  - `SddStateAnnotation` —— `Annotation.Root({...})`，**每個欄位都帶 `reducer`**（見「與實作方案的差異」第 1 點）
  - `type GraphState = typeof SddStateAnnotation.State`
  - `createCheckpointer(dbPath: string): SqliteSaver` —— `SqliteSaver.fromConnString(dbPath)`；`dbPath` 父目錄不存在時先 `mkdirSync(recursive)`
  - `buildGraph(opts: { checkpointer: SqliteSaver; graphName?: string; testNodes?: Record<string, NodeFn> }): CompiledGraph`
  - `type NodeOutcome = { kind: 'advance'; update: Partial<GraphState>; goto: string } | { kind: 'interrupt'; payload: InterruptPayload }` —— **所有節點回傳這個可判別聯集**，不要直接回 `Command`；節點測試才能直接斷言 `outcome.kind` 與 `outcome.payload.type`
  - `toCommand(outcome: NodeOutcome): Command` —— 把 `NodeOutcome` 轉成 LangGraph 的 `Command`；`kind: 'advance'` → `new Command({ update, goto })`，`kind: 'interrupt'` → `new Command({ interrupt: payload })`
  - `entryRouter(state: GraphState): Promise<NodeOutcome>` —— `bootstrapped === false` → `goto: 'bootstrap'`；否則 `goto: 'routeByStage'`
  - `routeByStage(state: GraphState): Promise<NodeOutcome>` —— 依 `currentStage` 決定下一個節點：`prd→'prd'`、`spec→'spec'`、`e2ePlan→'e2e_plan'`、`taskSplit→'task_split'`、`tdd→'tdd'`、`verification→'verification'`、`completed→'completed'`；**只看 `currentStage` / `approvals` / `blockers`，不得讀其他欄位**
  - `type InterruptPayload = { type: string; [k: string]: unknown }`（定義在 `src/graph/state.ts`，Task 4 的 zod schema 以它為基礎）

- [ ] **Step 1: Write the failing tests**

```ts
// tests/graph-state.test.ts
import { describe, expect, it } from 'vitest';
import { END, START, StateGraph } from '@langchain/langgraph';
import { mergeById, mergeRecord } from '../src/graph/reducers.js';
import { SddStateAnnotation } from '../src/graph/state.js';

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

  it('mergeById 以 id 覆蓋既有項目', () => {
    expect(mergeById([{ id: 'a', v: 1 }], [{ id: 'a', v: 2 }, { id: 'b', v: 3 }]))
      .toEqual([{ id: 'a', v: 2 }, { id: 'b', v: 3 }]);
  });

  it('mergeRecord 淺合併', () => {
    expect(mergeRecord({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });
});
```

```ts
// tests/entry-router.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildGraph } from '../src/graph/compile.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';

describe('entry_router', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('已有 checkpoint 的 resume 不得重跑 bootstrap', async () => {
    let bootstrapRan = 0;
    const saver = createCheckpointer(path.join(dir, 'cp.sqlite'));
    const g = buildGraph({ checkpointer: saver, testNodes: {
      bootstrap: async () => { bootstrapRan += 1; return { bootstrapped: true, currentStage: 'prd' }; },
    }});
    const cfg = { configurable: { thread_id: 'thr-1' } };
    await g.invoke({ requirementName: 'x' }, cfg);
    expect(bootstrapRan).toBe(1);
    await g.invoke(null, cfg);           // 模擬 resume
    expect(bootstrapRan).toBe(1);        // 不得變 2
  });

  it('全新 thread 必須進 bootstrap', async () => {
    let bootstrapRan = 0;
    const saver = createCheckpointer(path.join(dir, 'cp2.sqlite'));
    const g = buildGraph({ checkpointer: saver, testNodes: {
      bootstrap: async () => { bootstrapRan += 1; return { bootstrapped: true }; },
    }});
    await g.invoke({ requirementName: 'y' }, { configurable: { thread_id: 'thr-new' } });
    expect(bootstrapRan).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graph-state.test.ts tests/entry-router.test.ts`
Expected: FAIL —— `Cannot find module '../src/graph/compile.js'`

- [ ] **Step 3: Implement graph state、checkpointer、compile**

`src/graph/state.ts` —— 關鍵：**每個欄位都寫 `reducer`**，否則 default 被丟棄：

```ts
export const SddStateAnnotation = Annotation.Root({
  requirementName: Annotation<string>({ reducer: (_p, n) => n, default: () => '' }),
  repoUrl:        Annotation<string>({ reducer: (_p, n) => n, default: () => '' }),
  repoPath:       Annotation<string>({ reducer: (_p, n) => n, default: () => '' }),
  branch:         Annotation<string>({ reducer: (_p, n) => n, default: () => '' }),
  runId:          Annotation<string>({ reducer: (_p, n) => n, default: () => '' }),
  bootstrapped:   Annotation<boolean>({ reducer: (_p, n) => n, default: () => false }),
  currentStage:   Annotation<Stage>({ reducer: (_p, n) => n, default: () => 'bootstrap' }),
  artifacts:      Annotation<ArtifactIndex>({ reducer: mergeRecord, default: () => ({}) }),
  tbcItems:       Annotation<TBCItem[]>({ reducer: mergeById, default: () => [] }),
  tasks:          Annotation<Task[]>({ reducer: mergeById, default: () => [] }),
  currentTaskIndex: Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
  tddSubStage:    Annotation<TddSubStage>({ reducer: (_p, n) => n, default: () => 'pending' }),
  lastReview:     Annotation<ReviewResult | null>({ reducer: (_p, n) => n, default: () => null }),
  tddAttempts:    Annotation<number>({ reducer: (_p, n) => n, default: () => 0 }),
  verification:   Annotation<VerificationState>({ reducer: mergeVerification, default: () => ({ checks: [] }) }),
  blockers:       Annotation<Blocker[]>({ reducer: mergeById, default: () => [] }),
  approvals:      Annotation<Approvals>({ reducer: mergeRecord, default: () => ({}) }),
});
```

`src/persistence/checkpoint.ts`：`SqliteSaver.fromConnString(dbPath)`，呼叫前 `fs.mkdirSync(path.dirname(dbPath), { recursive: true })`。

`src/graph/compile.ts`：`buildGraph` 建立 `StateGraph(SddStateAnnotation)`，節點先只接 `entry_router` → `bootstrap` → `routeByStage` → `END`；`entry_router` 回傳 `NodeOutcome`，再由 `toCommand` 轉成 `new Command({ update: {}, goto: 'bootstrap' })`，**且 `addNode('entry_router', entryRouter, { ends: ['bootstrap', 'routeByStage'] })`** —— 少了 `ends` 會在編譯期丟 `UnreachableNodeError`。

`src/graph/state.ts` 另需加一行編譯期斷言，確保 Annotation 欄位與 Task 2 的介面一致（否則兩邊會無聲漂移）：

```ts
import type { SddState } from '../state/types.js';
const _assertShape: SddState = null as unknown as typeof SddStateAnnotation.State;
```

`buildGraph` 額外接受 `testNodes?: Record<string, NodeFn>`，讓測試可以注入假的 bootstrap 節點（Task 5 之後正式節點會取代）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph-state.test.ts tests/entry-router.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/graph src/persistence tests
git commit -m "$(cat <<'EOF'
feat: 建立帶 reducer 的 graph state 與 SQLite checkpoint

EOF
)"
```

---

### Task 4: CLI 合約與兩類 interrupt

**Files:**
- Create: `src/cli/protocol.ts`, `src/cli/envelope.ts`, `src/cli/index.ts`
- Test: `tests/cli-contract.test.ts`, `tests/audience-routing.test.ts`, `tests/resume-interrupt.test.ts`

**Interfaces:**
- Consumes: Task 3 `buildGraph`、`createCheckpointer`、`GraphState`；Task 2 `ReviewResult`
- Produces:
  - `WorkOrderSchema`（zod）—— `{ audience: 'host', role: WorkOrderRole, prompt: string, cwd: string, inputs: string[], outputs: string[], resultSchema?: 'review' | 'none' }`
  - `type WorkOrderRole = 'spec_writer' | 'e2e_planner' | 'task_splitter' | 'developer' | 'spec_reviewer' | 'quality_reviewer' | 'figma_fetch'`
  - `WorkerResultSchema`（zod）—— `{ status: 'ok' | 'failed' | 'needs_human', summary: string, changedFiles: string[], review?: ReviewResult, interrupt?: { type: string; question: string; options?: string[] } }`
  - `InterruptPayloadSchema`（zod）—— `{ audience: 'user' | 'host', type: string, [k: string]: unknown }`（**必須要求 `audience`**：全局約束「所有 interrupt payload 必須帶 `audience`」，而這個 schema 就是後續 task 的宣告契約）
  - CLI 錯誤碼（stderr 的 `code` 欄位）：`invalid_result`（`--result` 不是合法的 worker result）、`invalid_order`（工作單違反契約，例如 `inputs`/`outputs` 非絕對路徑）、`audience_mismatch`（用錯 audience 推進）、`already_completed`、`lock_not_owned`（`stop` 的對象不是鎖的持有者，除非 `--force`）、`no_checkpoint`（`resume` 找不到 checkpoint）
  - `WorkOrder` / `WorkerResult` / `InterruptPayload` 型別
  - `envelope(kind: 'interrupt' | 'error', body: unknown): string` —— 產生單行 JSON
  - `runCli(argv: string[]): Promise<number>` —— 可在測試直接呼叫；`main()` 包一層 `process.exit`
  - CLI 子命令：`start --task <n> --repo <url>`、`resume --task <n>`、`complete --task <n> --result <json|@file>`、`approve --task <n> --payload <json|@file>`、`status --task <n>`、`stop --task <n> [--force]`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/audience-routing.test.ts
import { describe, expect, it } from 'vitest';
import { WorkerResultSchema, WorkOrderSchema } from '../src/cli/protocol.js';

describe('audience 路由', () => {
  it('host 工作單必須帶 audience=host 與絕對路徑 outputs', () => {
    const ok = WorkOrderSchema.safeParse({ audience: 'host', role: 'spec_writer', prompt: 'p', cwd: '/a', inputs: ['/a/spec.md'], outputs: ['/a/out/spec.md'], resultSchema: 'none' });
    expect(ok.success).toBe(true);
  });

  it('缺少 audience 的工作單一律不合法', () => {
    expect(WorkOrderSchema.safeParse({ role: 'spec_writer', prompt: 'p', cwd: '/a', inputs: [], outputs: [] }).success).toBe(false);
  });

  it('評審結果不是合法 JSON 結構時，zod 解析失敗', () => {
    expect(WorkerResultSchema.safeParse({ status: 'ok', summary: 'PASS', changedFiles: [] }).success).toBe(true);
    expect(WorkerResultSchema.safeParse({ status: 'ok', summary: 'PASS', changedFiles: [], review: { role: 'spec', verdict: 'pass' } }).success).toBe(false);
  });
});
```

```ts
// tests/cli-contract.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli } from '../src/cli/index.js';

describe('CLI 合約', () => {
  let ws: string;
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'sdd-cli-')); process.env.SDD_GRAPH_WORKSPACE_BASE = ws; });
  afterEach(() => { delete process.env.SDD_GRAPH_WORKSPACE_BASE; rmSync(ws, { recursive: true, force: true }); });

  it('參數錯誤必須回 1 且把錯誤寫進 stderr', async () => {
    const rc = await runCli(['start']);   // 缺 --task
    expect(rc).toBe(1);
  });

  it('user 閘口不能用 complete 推進，只能用 approve', async () => {
    const rc1 = await runCli(['start', '--task', 'dup-test', '--repo', 'file:///nonexistent']);
    expect(rc1).toBe(2);   // repo 不存在 → bootstrap 重試後中斷（audience=user）
    const rc2 = await runCli(['complete', '--task', 'dup-test', '--result', JSON.stringify({ status: 'ok', summary: '', changedFiles: [] })]);
    expect(rc2).toBe(1);   // audience 不符 → 報錯，不得推進
  });
});
```

```ts
// tests/resume-interrupt.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildGraph } from '../src/graph/compile.js';
import { createCheckpointer } from '../src/persistence/checkpoint.js';

describe('resume 跨進程', () => {
  it('換進程後 interrupt payload 不變', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdd-res-'));
    try {
      const db = join(dir, 'cp.sqlite');
      const saver = createCheckpointer(db);
      const g = buildGraph({ checkpointer: saver, testNodes: {
        bootstrap: async () => ({ bootstrapped: true, currentStage: 'prd' }),
        prd: async () => { interrupt({ audience: 'user', type: 'collect_prd' }); return {}; },
      }});
      const cfg = { configurable: { thread_id: 'thr-a' } };
      await g.invoke({ requirementName: 'x' }, cfg);

      // 模擬「換一個進程」：重新 fromConnString 同一個檔案
      const saver2 = createCheckpointer(db);
      const g2 = buildGraph({ checkpointer: saver2, testNodes: { bootstrap: async () => ({}), prd: async () => ({}) } });
      const snap: any = await g2.getState(cfg);
      expect(snap.tasks?.[0]?.interrupts?.[0]?.value).toEqual({ audience: 'user', type: 'collect_prd' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli-contract.test.ts tests/audience-routing.test.ts tests/resume-interrupt.test.ts`
Expected: FAIL —— `Cannot find module '../src/cli/protocol.js'`

- [ ] **Step 3: Implement protocol、envelope、CLI**

`src/cli/protocol.ts` 用 zod v4 定義上列 schema。`WorkOrderSchema.role` 用 `z.enum([...])`。

`src/cli/envelope.ts`：

```ts
export function envelope(kind: 'interrupt' | 'error', body: unknown): string {
  return JSON.stringify({ kind, ...(body as object) });
}
```

`src/cli/index.ts` 的 `runCli` 行為契約：

| 情況 | 退出碼 | stdout | stderr |
|---|---|---|---|
| 圖跑到 `completed` 或本指令無待辦 | 0 | `{"kind":"result","stage":"completed"}` | — |
| 有 pending interrupt | 2 | `{"kind":"interrupt","audience":"user\|host","type":...,"threadId":...,"stage":...,"payload":{...}}` | — |
| 參數錯誤 / 圖不存在 / 違反 audience 契約 | 1 | — | `{"kind":"error","code":"...","message":"..."}` |

**退出碼 2 的判定**：`await graph.invoke(input, config)` 的回傳值若帶 `__interrupt__` 陣列 → 讀 `graph.getState(config).tasks[0].interrupts[0].value` 作為 payload，印出信封並回 2。

**最終狀態一律讀 `getState()`**：`invoke()` 在最後節點回傳空更新時會回 `undefined`，所以判定「已完成」與輸出 `currentStage` 都必須讀 `graph.getState(config).values`，不得用 `invoke()` 的回傳值。

**`resume` 先查 checkpoint**：`resume` 必須先 `getState(config)`；若 `values` 為空（沒有 checkpoint）→ 回 1 並報 `no_checkpoint`，**不得**直接 `invoke(null, config)`（那會丟 `EmptyInputError`）。

**`complete` 的驗證順序**（對應 Review Focus #1 #2 #3）：
1. 讀 pending interrupt；`audience` 必須是 `host`，否則回 1 並報 `audience_mismatch`。
2. 用 `WorkerResultSchema` 解析 `--result`；解析失敗 → 回 1 並報 `invalid_result`。
3. 檢查工作單 `outputs` 裡每個檔案都存在；任一不存在 → **重發同一張工作單**（回 2，payload 不變），**且不**增加 `tddAttempts`。
4. 若是 `resultSchema: 'review'`，`review` 必須通過 `ReviewResultSchema`；不通過 → 重發同一張單。
5. 已完成的單（該 interrupt id 已處理過）→ 回 1 並報 `already_completed`。

**`approve` 的驗證**：pending interrupt 的 `audience` 必須是 `user`，否則回 1 並報 `audience_mismatch`（這是 Review Focus #1 的另一半，也是實作方案 §15 `audience-routing` 測試的要求）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cli-contract.test.ts tests/audience-routing.test.ts tests/resume-interrupt.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli tests
git commit -m "$(cat <<'EOF'
feat: 定義 start/resume/complete/approve 的退出碼與 audience 合約

EOF
)"
```

---

### Task 5: bootstrap 節點

**Files:**
- Create: `src/commands/start-task.ts`, `src/nodes/bootstrap.ts`
- Modify: `src/graph/compile.ts`（接上正式 bootstrap 節點）
- Test: `tests/bootstrap-lock.test.ts`, `tests/already-exists.test.ts`

**Interfaces:**
- Consumes: Task 1 runtime；Task 3 `buildGraph`
- Produces:
  - `startTask(taskNameRaw: string, repoUrl: string): Promise<StartTaskResult>` —— `StartTaskResult { success: boolean; taskName: string; normalizedTaskName: string; branch: string; repoPath: string; runId: string; error?: string; errorCode?: ErrorCode }`
  - `bootstrapNode(state: GraphState): Promise<NodeOutcome>` —— 成功 → `{ kind: 'advance', update: { bootstrapped: true, currentStage: 'prd', repoPath, branch, runId, requirementName }, goto: 'prd' }`；失敗 → `{ kind: 'interrupt', payload: {...} }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/bootstrap-lock.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireLock, releaseLock } from '../src/runtime/branch-lock.js';
import { bootstrapNode } from '../src/nodes/bootstrap.js';

describe('bootstrap 鎖衝突', () => {
  let ws: string;
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'sdd-lock-')); process.env.SDD_GRAPH_WORKSPACE_BASE = ws; });
  afterEach(() => { releaseLock(); delete process.env.SDD_GRAPH_WORKSPACE_BASE; rmSync(ws, { recursive: true, force: true }); });

  it('已有 running 鎖時必須中斷且不得前進', async () => {
    acquireLock('other-task', 'task/other-task', join(ws, 'other'), 'run_x');
    const out = await bootstrapNode({ requirementName: 'qrcode-app', repoUrl: 'file:///nope' } as any);
    expect(out.kind).toBe('interrupt');
    expect((out as any).payload.type).toBe('lock_conflict');
    expect((out as any).payload.options).toEqual(['wait', 'stop_other']);
  });
});
```

```ts
// tests/already-exists.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initTaskWorkspace } from '../src/runtime/task-workspace.js';
import { bootstrapNode } from '../src/nodes/bootstrap.js';

describe('already_exists', () => {
  let ws: string;
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'sdd-dup-')); process.env.SDD_GRAPH_WORKSPACE_BASE = ws; });
  afterEach(() => { delete process.env.SDD_GRAPH_WORKSPACE_BASE; rmSync(ws, { recursive: true, force: true }); });

  it('工作區已存在時中斷讓使用者選 resume 或 reset', async () => {
    initTaskWorkspace('dup-task');
    const out = await bootstrapNode({ requirementName: 'dup-task', repoUrl: 'file:///nope' } as any);
    expect(out.kind).toBe('interrupt');
    expect((out as any).payload.type).toBe('already_exists');
    expect((out as any).payload.options).toEqual(['resume', 'reset']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bootstrap-lock.test.ts tests/already-exists.test.ts`
Expected: FAIL —— `Cannot find module '../src/nodes/bootstrap.js'`

- [ ] **Step 3: Implement bootstrap 節點**

`src/commands/start-task.ts`：自 `~/.claude/plugins/sdd-agent/src/commands/start-task.ts` 複製，改用新的 `paths.ts`；**額外**在 `taskWorkspaceExists()` 命中時不要直接回 `workspace_error`，而是讓節點層轉成 `already_exists` interrupt（實作方案 §6）。

`src/nodes/bootstrap.ts`：

```ts
export async function bootstrapNode(state: GraphState): Promise<NodeOutcome> {
  const result = await startTask(state.requirementName, state.repoUrl);
  if (!result.success) {
    if (result.errorCode === 'lock_conflict') {
      return { kind: 'interrupt', payload: { audience: 'user', type: 'lock_conflict', options: ['wait', 'stop_other'] } };
    }
    if (result.errorCode === 'workspace_error') {
      return { kind: 'interrupt', payload: { audience: 'user', type: 'already_exists', options: ['resume', 'reset'] } };
    }
    return { kind: 'interrupt', payload: { audience: 'user', type: 'bootstrap_failed', code: result.errorCode, message: result.error } };
  }
  return { kind: 'advance', update: { bootstrapped: true, currentStage: 'prd', repoPath: result.repoPath, branch: result.branch, runId: result.runId }, goto: 'prd' };
}
```

`git_error` / `network_error` 依實作方案 §8.1：節點內重試 2 次，再轉 interrupt。

`src/graph/compile.ts` 把 `bootstrap` 節點換成正式實作，並在 `addNode('bootstrap', bootstrapNode, { ends: ['prd', 'bootstrap'] })` 宣告 `ends`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bootstrap-lock.test.ts tests/already-exists.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands src/nodes src/graph tests
git commit -m "$(cat <<'EOF'
feat: 以單一 bootstrap 節點包裝 startTask 與鎖/工作區中斷

EOF
)"
```

---

### Task 6: Verify 子圖

**Files:**
- Create: `src/nodes/verify-checks.ts`, `src/subgraphs/verify.ts`
- Test: `tests/verify-retry.test.ts`, `tests/verify-manual-back-to-tdd.test.ts`

**Interfaces:**
- Consumes: Task 1 `getRepoDir`、`getVerifyLogDir`；Task 2 `VerificationCheck`
- Produces:
  - `VERIFY_CHECKS: ReadonlyArray<{ name: 'lint:ts' | 'lint' | 'test' | 'e2e'; command: string[]; fixable: boolean }>` —— `lint:ts` = `['npx','tsc','--noEmit']`；`lint` = `['npx','eslint','.','--ext','.ts,.tsx','--fix']`；`test` = `['npx','jest','--passWithNoTests','--no-coverage']`；`e2e` = `['npx','playwright','test']`。**只有 `lint` 帶 `--fix`。**
  - `runCheck(name: VerificationCheck['name'], repoDir: string, opts: { timeoutMs?: number; runner?: CheckRunner }): Promise<CheckResult>` —— `CheckRunner = (cmd: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>`；`CheckResult = { status: 'passed' | 'failed' | 'fixed'; exitCode: number; log: string }`。timeout 預設 120000ms；日誌寫 `<docsDir>/verify/<name>.log`。`opts.runner` 供測試注入假執行器，避免單元測試真的跑 tsc/eslint。
  - `routeAfterFailure(action: 'manual' | 'skip' | 'abort'): 'tdd' | 'completed'` —— 純函式；`'manual' → 'tdd'`、`'skip' → 'completed'`、`'abort' → 'completed'`（`skip` 與 `abort` 目的地相同，差別由節點記錄 `Blocker` 來表達）
  - `verifySubgraph` —— 四關依序，各關失敗時該關最多重試 2 次；`retries >= 2` 仍失敗 → 中斷 `{ audience: 'user', type: 'verify_failed', failed: [...], options: ['manual', 'skip', 'abort'] }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/verify-retry.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCheck, VERIFY_CHECKS } from '../src/nodes/verify-checks.js';

describe('verify 重試', () => {
  it('四關順序固定，只有 lint 可自動修', () => {
    expect(VERIFY_CHECKS.map(c => c.name)).toEqual(['lint:ts', 'lint', 'test', 'e2e']);
    expect(VERIFY_CHECKS.filter(c => c.fixable).map(c => c.name)).toEqual(['lint']);
  });

  it('eslint 失敗後 --fix 通過，status 必須是 fixed 且指令帶 --fix', async () => {
    const calls: string[][] = [];
    let n = 0;
    const r = await runCheck('lint', '/tmp', {
      runner: async (cmd) => { calls.push(cmd); n += 1; return { code: n === 1 ? 1 : 0, stdout: '', stderr: '' }; },
    });
    expect(r.status).toBe('fixed');
    expect(calls[0]).toContain('--fix');
  });

  it('非 fixable 的關卡失敗就是 failed，不會變 fixed', async () => {
    const r = await runCheck('test', '/tmp', { runner: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
    expect(r.status).toBe('failed');
  });

  it('日誌必須寫到 verify/<name>.log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdd-vlog-'));
    try {
      process.env.SDD_GRAPH_WORKSPACE_BASE = dir;
      const r = await runCheck('test', dir, { runner: async () => ({ code: 1, stdout: 'out', stderr: 'err' }) });
      expect(r.log).toContain('err');
    } finally {
      delete process.env.SDD_GRAPH_WORKSPACE_BASE;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

```ts
// tests/verify-manual-back-to-tdd.test.ts
import { describe, expect, it } from 'vitest';
import { routeAfterFailure } from '../src/subgraphs/verify.js';

describe('verify 失敗後回 tdd', () => {
  it('manual 選項必須路由回 tdd', () => {
    expect(routeAfterFailure('manual')).toBe('tdd');
  });

  it('skip 與 abort 不得路由到 tdd', () => {
    expect(routeAfterFailure('skip')).not.toBe('tdd');
    expect(routeAfterFailure('abort')).not.toBe('tdd');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/verify-retry.test.ts tests/verify-manual-back-to-tdd.test.ts`
Expected: FAIL —— `Cannot find module '../src/subgraphs/verify.js'`

- [ ] **Step 3: Implement Verify 子圖**

`src/nodes/verify-checks.ts` 用 `child_process.spawn`（不是 `execSync`，避免阻塞 event loop 且能設 timeout）。timeout 到 → 視為失敗，記錄 `timeout` 到 log。

`src/subgraphs/verify.ts` 匯出 `verifySubgraph`，其 `routeAfterFailure(action)` 是純函式：`'manual' → 'tdd'`、`'skip' → 'completed'`、`'abort' → 'completed'`。**驗證階段的節點名是 `verify` 不是 `verification`** —— `verification` 是 state channel 名，LangGraph 拒絕同名節點（`verification is already being used as a state attribute`）。**verify 節點不得改業務程式碼**（實作方案 §8.5）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/verify-retry.test.ts tests/verify-manual-back-to-tdd.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/nodes/verify-checks.ts src/subgraphs/verify.ts tests
git commit -m "$(cat <<'EOF'
feat: 以四道確定性關卡組成 verify 子圖並支援 manual 回 tdd

EOF
)"
```

---

### Task 7: ID 與文件解析器

**Files:**
- Create: `src/parsers/ids.ts`, `src/parsers/spec-md.ts`, `src/parsers/tasks-md.ts`, `src/parsers/e2e-csv.ts`
- Create: `tests/fixtures/qrcode-app/`（自 `~/.claude/plugins/sdd-agent/docs/qrcode-app/` 複製，ID 改成新格式）
- Test: `tests/parser-ids.test.ts`

**Interfaces:**
- Consumes: 無（純函式）
- Produces:
  - `slugifyTaskId(title: string): string` —— 標題 → 小寫 kebab slug（保留 `CamelCase` 詞中的大小寫邊界無法還原時，以空白/標點切分後小寫）
  - `parseAcIds(specMd: string): string[]` —— 抓 `^### (AC-\d{3}):`
  - `parseE2eIds(csv: string): string[]` —— 抓 `E2E-\d{3}`
  - `parseTaskIds(tasksMd: string): string[]` —— 抓 `TASK-<slug>`（相容舊的 `task-\d+`）
  - `parseComplexity(tasksMd: string): Complexity[]`
  - `parseTasks(tasksMd: string): Task[]` —— 回 Task 2 `src/state/types.ts` 定義的 `Task`（`id` / `title` / `description?` / `acceptanceCriteria` / `acRefs` / `complexity` / `priority`）
  - `parseTbcItems(specMd: string): TBCItem[]` —— 抓 `[TBC-\d{3}]`
  - `parseQuestions(specMd: string): SpecQuestion[]` —— 抓 `Q-\d{3}`
  - `parseE2eRows(csv: string): E2eRow[]` —— `E2eRow { testId: string; feature: string; scenario: string; steps: string[]; expectedResult: string; priority: 'high'|'medium'|'low' }`
  - `type E2eRow` 定義在 `src/parsers/ids.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/parser-ids.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseAcIds, parseE2eRows, parseTasks, slugifyTaskId } from '../src/parsers/ids.js';

const FIX = join(import.meta.dirname, 'fixtures', 'qrcode-app');

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/parser-ids.test.ts`
Expected: FAIL —— `Cannot find module '../src/parsers/ids.js'`

- [ ] **Step 3: Implement 解析器並建立 fixture**

`src/parsers/ids.ts` 放共用正則與 `slugifyTaskId`；其餘三個檔案各自解析一種文件。

`slugifyTaskId`：把標題依「非英數字 → 分隔」切成詞，全部小寫後以 `-` 連接；連續 `-` 收斂；前後 `-` 去掉；長度上限 48。

fixture 要點（`tests/fixtures/qrcode-app/`）：
- `spec.md`：保留現有 10 節結構，**新增** `## Acceptance Criteria` 節，含 `### AC-001:` ～ `### AC-005:`。
- `tasks.md`：Task ID 欄改成 `TASK-setup-qrcode-page-route` 等 slug；**新增複雜度欄**（S/M）；每個 task 補 2-5 條驗收條件。
- `e2e-plan.csv`：欄位改為 `test_id,feature,scenario,steps,expected_result,priority`，`test_id` 改成 `E2E-001`～`E2E-005`，`scenario` 保留 `(AC-00x)` 關聯。
- 保留 `prd.md`；`workflow-state.json` 刪除（由 Task 2 的 schema 另行測試）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/parser-ids.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/parsers tests/fixtures tests/parser-ids.test.ts
git commit -m "$(cat <<'EOF'
feat: 抽出 AC/E2E/TBC/Q 與穩定 TASK slug 的解析器

EOF
)"
```

---

### Task 8: PRD 階段

**Files:**
- Create: `src/nodes/prd.ts`, `prompts/figma-fetch.md`
- Modify: `src/graph/compile.ts`
- Test: `tests/prd-stage.test.ts`

**Interfaces:**
- Consumes: Task 3 `buildGraph`；Task 7 `ArtifactStore`；Task 1 `getDocsDir`
- Produces:
  - `prdNode(state: GraphState): Promise<NodeOutcome>` —— 流程：中斷 `{ audience: 'user', type: 'collect_prd' }` → 寫 `prd.md` → 若使用者給了 figma URL 則中斷 `{ audience: 'host', type: 'work_order', role: 'figma_fetch', ... }` → 中斷 `{ audience: 'user', type: 'confirm_prd' }`
  - `FIGMA_P0_FILES: ReadonlyArray<string>` —— `['figma/figma-meta.json', 'figma/design-tree.json', 'figma/design-tokens.json', 'figma/design-context.md']`，外加 `figma/screenshots/` 至少 1 張 png
  - `checkFigmaP0(docsDir: string): { ok: boolean; missing: string[] }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/prd-stage.test.ts
import { describe, expect, it } from 'vitest';
import { checkFigmaP0 } from '../src/nodes/prd.js';

describe('PRD 階段', () => {
  it('缺少 P0 檔案時必須回報缺哪些', () => {
    const r = checkFigmaP0('/tmp/definitely-missing');
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('figma/design-tree.json');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/prd-stage.test.ts`
Expected: FAIL —— `Cannot find module '../src/nodes/prd.js'`

- [ ] **Step 3: Implement PRD 節點與 figma-fetch 工作單**

`prompts/figma-fetch.md` 的正文必須說明：由**當前 Claude Code 會話**用既有 Figma MCP 工具抓取 P0 資源，落到 `outputs` 列出的絕對路徑；**不得**自行呼叫 Figma REST API；完成後呼叫 `sdd-graph complete`。

`src/nodes/prd.ts` 的 `prdNode` 順序（實作方案 §8.2）：
1. `interrupt({ audience: 'user', type: 'collect_prd' })` —— 問人要 PRD 內容與（選填）Figma URL。**禁止**先讓模型憑空寫一份 PRD 再請人改。
2. 寫 `<docsDir>/prd.md`。
3. 若有 figma URL → 發 `audience: host` 的 `figma_fetch` 工作單，`outputs` = `<docsDir>/figma/...` 的 P0 檔案清單。
4. Figma 失敗 → 記一筆 `blocking: false` 的 TBC，不堵死非 UI 需求。
5. `interrupt({ audience: 'user', type: 'confirm_prd' })` → 通過後 `currentStage = 'spec'`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/prd-stage.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/nodes/prd.ts prompts/figma-fetch.md src/graph tests
git commit -m "$(cat <<'EOF'
feat: PRD 階段先問人再發 figma_fetch 工作單

EOF
)"
```

---

### Task 9: Spec 工作單

**Files:**
- Create: `src/nodes/spec.ts`, `prompts/spec-writer.md`
- Modify: `src/graph/compile.ts`
- Test: `tests/spec-stage.test.ts`

**Interfaces:**
- Consumes: Task 7 `parseAcIds`、`parseTbcItems`、`parseQuestions`；Task 8 `FIGMA_P0_FILES`
- Produces:
  - `specNode(state: GraphState): Promise<NodeOutcome>` —— 發 `audience: host` 工作單（`role: 'spec_writer'`），`outputs` = `[<docsDir>/discovery.md, <docsDir>/spec.md]`；出口跑解析器抽 `AC-xxx`
  - `specNode.exit(state): SpecExit` —— 純函式，回 `{ ok: boolean; acIds: string[]; blockingTbc: TBCItem[]; openQuestions: SpecQuestion[]; missingAc: boolean }`
  - `SpecQuestion` 定義在 `src/state/types.ts`：`{ id: string; question: string; round: 1 | 2 | 3; status: 'pending' | 'answered' | 'tbc' }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/spec-stage.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { specNode } from '../src/nodes/spec.js';

const FIX = join(import.meta.dirname, 'fixtures', 'qrcode-app');

describe('Spec 階段出口', () => {
  it('抽不到 AC-xxx 就不算通過', () => {
    const r = specNode.exit({} as any, FIX);
    expect(r.acIds.length).toBeGreaterThan(0);
  });

  it('有未解的 blocking TBC 時不得推進到 e2ePlan', () => {
    // fixture 的 spec.md 刻意含一條未解的 blocking TBC-001 —— 出口必須**回報**它，
    // 而不是讓它從 state 帳本讀不到而變成空陣列（那會讓這條斷言虛構地通過）。
    const r = specNode.exit({} as any, FIX);
    expect(r.blockingTbc.some(t => t.id === 'TBC-001' && t.blocking && !t.resolved)).toBe(true);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/spec-stage.test.ts`
Expected: FAIL —— `Cannot find module '../src/nodes/spec.js'`

- [ ] **Step 3: Implement Spec 節點與工作單**

`prompts/spec-writer.md` 正文必須包含：產出 `discovery.md`（探索與澄清紀錄）與 `spec.md`；`spec.md` 必含 `## Acceptance Criteria` 節，每條以 `### AC-001: <描述>` 起頭；澄清問題最多 3 輪，未解者轉為 `[TBC-001]` 並標 `blocking`；**禁止**出現「接下來進入 taskSplit」之類的階段推進語句；完成後呼叫 `sdd-graph complete --result ...`，若缺使用者決策則回 `status: 'needs_human'` 而不是直接問使用者。

`src/nodes/spec.ts`：
- 進場：若 Figma P0 缺失 → 中斷 `{ audience: 'user', type: 'figma_missing', options: ['fetch', 'tbc', 'skip'] }`；選 `fetch` 則改發 `figma_fetch` 工作單。
- 發 `spec_writer` 工作單，`inputs` = `[<docsDir>/prd.md]` + 已存在的 Figma P0 檔案 + `CLAUDE.md`（若存在），`outputs` = `[<docsDir>/discovery.md, <docsDir>/spec.md]`。
- 出口：`specNode.exit` 抽 AC / TBC / Q。
  - **抽不到 AC → 重發同一張工作單一次**（第二次仍抽不到 → 中斷 `{ audience: 'user', type: 'spec_questions', questions: [...] }` 問人）。
  - **有未答的 `Q-xxx` → 中斷 `{ audience: 'user', type: 'spec_questions', questions: [...] }`**，使用者回填答案後寫回 `spec.md`；澄清最多 3 輪，超過 3 輪未答者轉為 TBC。
  - **仍有未解的 blocking TBC → 中斷 `{ audience: 'user', type: 'tbc_blocking', resolutions: [...] }`**，不得 `goto 'e2ePlan'`。
- 全部通過 → 中斷 `{ audience: 'user', type: 'confirm_spec' }` → 通過後 `currentStage = 'e2ePlan'`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/spec-stage.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/nodes/spec.ts prompts/spec-writer.md src/graph tests
git commit -m "$(cat <<'EOF'
feat: Spec 階段以工作單產出 discovery/spec 並用 blocking TBC 把住推進

EOF
)"
```

---

### Task 10: E2E 與 TaskSplit 工作單

**Files:**
- Create: `src/nodes/e2e-plan.ts`, `src/nodes/task-split.ts`, `prompts/e2e-planner.md`, `prompts/task-splitter.md`
- Modify: `src/graph/compile.ts`
- Test: `tests/tasks-stage.test.ts`

**Interfaces:**
- Consumes: Task 7 `parseE2eRows`、`parseTasks`
- Produces:
  - `e2eNode(state): Promise<NodeOutcome>` —— 發 `role: 'e2e_planner'` 工作單，`outputs` = `[<docsDir>/e2e-plan.csv]`；出口解析 E2E id，通過後中斷 `{ audience: 'user', type: 'confirm_e2e' }`，通過後 `currentStage = 'taskSplit'`
  - `taskSplitNode(state): Promise<NodeOutcome>` —— 發 `role: 'task_splitter'` 工作單，`outputs` = `[<docsDir>/tasks.md]`
  - `taskSplitNode.exit(state): TaskSplitExit` —— `TaskSplitExit { ok: boolean; tasks: Task[]; hasComplexL: boolean; duplicateIds: string[]; orphanAcs: string[]; orphanTasks: string[] }`
  - `buildTraceabilityMatrix(acIds: string[], tasks: Task[], e2e: E2eRow[]): TraceabilityMatrix` —— `TraceabilityMatrix { rows: Array<{ acId: string; taskIds: string[]; testIds: string[] }>; orphanTasks: string[]; orphanTests: string[] }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/tasks-stage.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildTraceabilityMatrix, taskSplitNode } from '../src/nodes/task-split.js';
import { parseE2eRows, parseTasks } from '../src/parsers/ids.js';

const FIX = join(import.meta.dirname, 'fixtures', 'qrcode-app');

describe('TaskSplit 出口', () => {
  it('不得出現 L 複雜度', () => {
    const r = taskSplitNode.exit({ docsDir: FIX } as any);
    expect(r.hasComplexL).toBe(false);
  });

  it('TASK id 不得重複', () => {
    const r = taskSplitNode.exit({ docsDir: FIX } as any);
    expect(r.duplicateIds).toEqual([]);
  });

  it('每個 AC 至少被一個 task 引用', () => {
    const r = taskSplitNode.exit({ docsDir: FIX } as any);
    expect(r.orphanAcs).toEqual([]);
  });

  it('traceability 矩陣雙向無孤兒', () => {
    const tasks = parseTasks(readFileSync(join(FIX, 'tasks.md'), 'utf-8'));
    const e2e = parseE2eRows(readFileSync(join(FIX, 'e2e-plan.csv'), 'utf-8'));
    const m = buildTraceabilityMatrix(['AC-001','AC-002','AC-003','AC-004','AC-005'], tasks, e2e);
    expect(m.orphanTasks).toEqual([]);
    expect(m.orphanTests).toEqual([]);
    expect(m.rows.length).toBe(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tasks-stage.test.ts`
Expected: FAIL —— `Cannot find module '../src/nodes/task-split.js'`

- [ ] **Step 3: Implement 兩個工作單節點與 traceability 矩陣**

`prompts/e2e-planner.md`：產出 `e2e-plan.csv`，欄位固定 `test_id,feature,scenario,steps,expected_result,priority`；`test_id` 為 `E2E-001` 起算；必須涵蓋 Happy Path / Error / Boundary 三類情境；`scenario` 內以 `(AC-00x)` 標註對應 AC。

`prompts/task-splitter.md`：產出 `tasks.md`；Task ID 為 `TASK-<標題派生 slug>`；**每個 task 必須有複雜度欄且只能是 S 或 M**；每個 task 2-5 條驗收條件；每個 task 引用至少一個 `AC-xxx`；**禁止**出現 L 級任務。

`src/nodes/task-split.ts` 的出口（實作方案 §8.3）：
- 解析 `TASK-xxx`；有重複 id → 重發工作單一次。
- 有 L 複雜度 → 重發工作單一次（prompt 附上「拆到 S/M」要求）；第二次仍有 L → `interrupt({ audience: 'user', type: 'task_split_failed', reason: 'complexity_L' })`。
- 孤儿 AC / 孤儿 task → 記 TBC（`blocking: false`）並在 `timeline.md` 標記，不擋推進。
- 通過 → `interrupt({ audience: 'user', type: 'confirm_tasks' })` → 通過後 `currentStage = 'tdd'`。

`buildTraceabilityMatrix` 是**純 ID 比對**，不做語意相似度（YAGNI；既有 skill 的 0.32 門檻語意比對 v1 不做）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tasks-stage.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/nodes prompts src/graph tests
git commit -m "$(cat <<'EOF'
feat: 以工作單產出 e2e-plan 與穩定 TASK slug 的 tasks.md

EOF
)"
```

---

### Task 11: TDD 子圖與 git 標籤

**Files:**
- Create: `src/runtime/git-tags.ts`, `src/subgraphs/tdd.ts`, `src/nodes/tdd.ts`, `prompts/developer.md`
- Modify: `src/graph/compile.ts`
- Test: `tests/tdd-loop.test.ts`

**Interfaces:**
- Consumes: Task 1 `getRepoDir`；Task 2 `Task`、`TddSubStage`
- Produces:
  - `tagTaskStart(repoDir: string, taskId: string): { created: boolean; tag: string }` —— 標籤名 `sdd/task/<taskId>/start`；**已存在就跳過不重建**（實作方案 §16）
  - `resetToTaskStart(repoDir: string, taskId: string): boolean` —— `git reset --hard sdd/task/<taskId>/start`
  - `tddSubgraph` —— task **串行**；`currentTaskIndex` 指向 `state.tasks[currentTaskIndex]`
  - `tddNode.developerWorkOrder(state, task): WorkOrder` —— `role: 'developer'`，`outputs` = 該 task 預期的測試與實作路徑，`inputs` = `[<docsDir>/tasks.md, <docsDir>/spec.md]`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/tdd-loop.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, execSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetToTaskStart, tagTaskStart } from '../src/runtime/git-tags.js';

describe('TDD 迴圈與 git 標籤', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdd-git-'));
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
    execSync('echo a > f.txt && git add -A && git commit -qm init', { cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('標籤名固定 sdd/task/<id>/start，且已存在時不重建', () => {
    const r1 = tagTaskStart(dir, 'TASK-setup-qrcode-page-route');
    expect(r1.tag).toBe('sdd/task/TASK-setup-qrcode-page-route/start');
    expect(r1.created).toBe(true);
    const r2 = tagTaskStart(dir, 'TASK-setup-qrcode-page-route');
    expect(r2.created).toBe(false);
  });

  it('reset 能回到 start 標籤', () => {
    tagTaskStart(dir, 'TASK-x');
    execSync('echo b > f.txt && git add -A && git commit -qm change', { cwd: dir });
    expect(resetToTaskStart(dir, 'TASK-x')).toBe(true);
    expect(execSync('git show --stat --oneline HEAD', { cwd: dir }).toString()).toContain('init');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tdd-loop.test.ts`
Expected: FAIL —— `Cannot find module '../src/runtime/git-tags.js'`

- [ ] **Step 3: Implement git 標籤、TDD 子圖與 developer 工作單**

`src/runtime/git-tags.ts` 用 `execFileSync('git', ['-C', repoDir, 'tag', tag])`；建立前先 `git rev-parse --verify refs/tags/<tag>` 檢查存在性。

`src/subgraphs/tdd.ts` 的流程（實作方案 §8.4）：

```
load_current_task
  → git tag sdd/task/<id>/start        （確定性，圖內執行；已存在則跳過）
  → interrupt WorkOrder developer      （audience: host）
  → interrupt WorkOrder spec_review    （audience: host，resultSchema: 'review'）
  → interrupt WorkOrder quality_review （audience: host，resultSchema: 'review'）
  → mark_complete → 下一 task 或 END
```

task **串行**（實作方案 §8.4），不做並行。

`prompts/developer.md`（由 `~/.claude/plugins/sdd-agent/agents/developer.md` 遷移）：保留 TEST LIST → RED → GREEN → REFACTOR 流程、triangulation 規則（每個行為 ≥2 個測試）、回歸檢查、UI Fidelity Checklist；**刪除**所有「進入下一階段 / 自動調用 X reviewer」的語句（該 agent 檔本來就沒有跨階段指令，可直接搬）。結尾要求：`sdd-graph complete --result '{"status":"ok",...}'`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tdd-loop.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/git-tags.ts src/subgraphs src/nodes prompts/developer.md src/graph tests
git commit -m "$(cat <<'EOF'
feat: 以 git 標籤與工作單組成串行的 TDD 子圖

EOF
)"
```

---

### Task 12: 評審工作單與失敗升級

**Files:**
- Create: `src/nodes/review.ts`, `prompts/spec-reviewer.md`, `prompts/quality-reviewer.md`
- Modify: `src/subgraphs/tdd.ts`
- Test: `tests/tdd-escalation.test.ts`, `tests/work-order-complete.test.ts`

**Interfaces:**
- Consumes: Task 4 `WorkerResultSchema`；Task 11 `tagTaskStart`、`resetToTaskStart`
- Produces:
  - `reviewWorkOrder(state, task, role: 'spec' | 'quality'): WorkOrder` —— `resultSchema: 'review'`
  - `validateCompletion(workOrder: WorkOrder, result: WorkerResult): CompletionCheck` —— `CompletionCheck { ok: boolean; reason?: 'missing_outputs' | 'invalid_review' | 'invalid_result'; countsAsFailure: boolean }`
  - `escalate(state, task, attempts: number): Escalation` —— **回傳可判別聯集，不要回 `Command`**：
    `type Escalation = { kind: 'retry_developer' } | { kind: 'rollback'; interrupt: { audience: 'user'; type: 'tdd_rollback' } } | { kind: 'blocked'; interrupt: { audience: 'user'; type: 'tdd_blocked'; options: string[] } }`
    1 → `retry_developer`（圖側帶 `lastReview` 重發 developer 工作單）；2 → `rollback`（先 `resetToTaskStart` 再由節點轉成中斷）；3 → `blocked`（寫 `blockers` 後由節點轉成中斷）

- [ ] **Step 1: Write the failing tests**

```ts
// tests/tdd-escalation.test.ts
import { describe, expect, it } from 'vitest';
import { escalate } from '../src/nodes/review.js';

describe('TDD 失敗升級', () => {
  it('第一次失敗回 developer 工作單', () => {
    expect(escalate({ tddAttempts: 1 } as any, { id: 'TASK-x' } as any, 1).kind).toBe('retry_developer');
  });

  it('第二次失敗改成 rollback 中斷', () => {
    const r = escalate({ tddAttempts: 2 } as any, { id: 'TASK-x' } as any, 2);
    expect(r.kind).toBe('rollback');
    expect((r as any).interrupt.type).toBe('tdd_rollback');
  });

  it('第三次失敗寫 blocker 並問使用者', () => {
    const r = escalate({ tddAttempts: 3 } as any, { id: 'TASK-x' } as any, 3);
    expect(r.kind).toBe('blocked');
    expect((r as any).interrupt.type).toBe('tdd_blocked');
    expect((r as any).interrupt.options).toEqual(['wait', 'skip', 'abort']);
  });
});
```

```ts
// tests/work-order-complete.test.ts
import { describe, expect, it } from 'vitest';
import { validateCompletion } from '../src/nodes/review.js';

describe('complete 驗證', () => {
  it('outputs 檔案不存在時必須重發同一張單且不計失敗次數', () => {
    const r = validateCompletion({ outputs: ['/definitely/missing.md'] } as any, { status: 'ok', summary: '', changedFiles: [] } as any);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing_outputs');
    expect(r.countsAsFailure).toBe(false);
  });

  it('評審結果不是合法 JSON 時重發同一張單', () => {
    const r = validateCompletion({ outputs: [], resultSchema: 'review' } as any, { status: 'ok', summary: 'PASS', changedFiles: [] } as any);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_review');
    expect(r.countsAsFailure).toBe(false);
  });

  it('outputs 都在且評審通過時才算成功', () => {
    const r = validateCompletion({ outputs: [], resultSchema: 'review' } as any,
      { status: 'ok', summary: '', changedFiles: [], review: { role: 'spec', verdict: 'pass', issues: [] } } as any);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tdd-escalation.test.ts tests/work-order-complete.test.ts`
Expected: FAIL —— `Cannot find module '../src/nodes/review.js'`

- [ ] **Step 3: Implement 評審工作單、驗證與升級**

`src/nodes/review.ts`：
- `validateCompletion(workOrder, result)` —— 回 `{ ok: boolean; reason?: 'missing_outputs' | 'invalid_review' | 'invalid_result'; countsAsFailure: boolean }`。
  - `missing_outputs` → `countsAsFailure: false`，**重發同一張單**（宿主沒把活幹完，不是品質問題，不得消耗 TDD 失敗次數 —— Review Focus #2）。
  - `invalid_review` → **第一次** `countsAsFailure: false` 並重發同一張單；**第二次**仍是非法 JSON 則視為評審 fail（`countsAsFailure: true`），交給 `escalate` 處理（實作方案 §8.4「zod 失敗 = fail，再跑工人一次；第二次仍不是 JSON 則升級」）。
  - `invalid_result` → `countsAsFailure: false`，回 1 讓宿主重送合法的 `--result`。
- `escalate(state, task, attempts)` —— 三級升級如上。第 2 級在轉成中斷**之前**呼叫 `resetToTaskStart`（實作方案 §8.4）；中斷之前不做不可重入副作用，所以 `resetToTaskStart` 必須冪等（標籤已存在就跳過）。

`prompts/spec-reviewer.md`（由 `agents/spec-reviewer.md` 遷移）：審查「實作了嗎」；FAIL 條件沿用原 5 條；**最後只輸出一段 ReviewResult JSON**，散文 PASS 不接受。刪除「交給 quality-reviewer」之類的跨 agent 語句。

`prompts/quality-reviewer.md`（由 `agents/quality-reviewer.md` + `agents/code-reviewer.md` 合併，v1 取消第三個評審）：品質 + 正確性/安全檢查合併為一份 checklist；保留原 FAIL/PASS 門檻（critical、>3 high、TS 編譯失敗、測試隔離違規等）；同樣只輸出 ReviewResult JSON。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tdd-escalation.test.ts tests/work-order-complete.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/nodes/review.ts src/subgraphs/tdd.ts prompts tests
git commit -m "$(cat <<'EOF'
feat: 評審只收 JSON 並以三級升級處理失敗與缺產物

EOF
)"
```

---

### Task 13: 工作單正文遷移、Claude Code 宿主 LOOP、插件註冊

**Files:**
- Create: `src/prompts/loader.ts`, `commands/start.md`, `commands/resume.md`, `commands/status.md`, `commands/stop.md`
- Modify: `prompts/*.md`（補上統一的模板變數與結尾契約）
- Test: `tests/prompt-loader.test.ts`

**Interfaces:**
- Consumes: Task 4 `WorkOrder`；Task 1 `getPluginRoot`
- Produces:
  - `renderPrompt(role: string, vars: Record<string, string>): string` —— 讀 `<pluginRoot>/prompts/<role>.md`，把 `{{key}}` 換成 `vars[key]`；未知的 `{{key}}` 拋錯
  - `commands/start.md` —— 唯一的控制流是實作方案 §4 的 LOOP
  - `commands/resume.md` —— 同一 LOOP，從 checkpoint 重發未完成的工作單
  - `commands/status.md` —— 只讀：lock + `workflow-state.json` + `graph.getState()`，**不推進**
  - `commands/stop.md` —— `releaseLock()`，**保留** checkpoint 與工作區

- [ ] **Step 1: Write the failing test**

```ts
// tests/prompt-loader.test.ts
import { describe, expect, it } from 'vitest';
import { renderPrompt } from '../src/prompts/loader.js';

describe('工作單正文', () => {
  it('模板變數會被取代', () => {
    const out = renderPrompt('spec-writer', { goal: '寫 spec', inputs: 'A', outputs: 'B' });
    expect(out).toContain('寫 spec');
    expect(out).not.toContain('{{goal}}');
  });

  it('缺少必要變數必須報錯，不得產出半成品工作單', () => {
    expect(() => renderPrompt('spec-writer', {})).toThrow();
  });

  it('每張工作單都必須禁止自行推進階段', () => {
    const out = renderPrompt('spec-writer', { goal: 'g', inputs: 'i', outputs: 'o' });
    expect(out).toContain('sdd-graph complete');
    expect(out).not.toMatch(/接下來進入|下一步進入|自動調用\s*\w*reviewer/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prompt-loader.test.ts`
Expected: FAIL —— `Cannot find module '../src/prompts/loader.js'`

- [ ] **Step 3: Implement loader、統一工作單模板、重寫 commands**

`src/prompts/loader.ts`：讀檔、取代 `{{key}}`、遇到未提供或多餘的變數都拋錯（用一個固定變數集合 `['goal','inputs','outputs','cwd','outputFormat','context']` 驗證）。

`prompts/*.md` 統一模板（每個 role 都用同一組骨架，只換 `outputFormat` 內容）：

```
你正在完成一張工作單。完成後必須呼叫 `sdd-graph complete --result <json>`。

## 目標
{{goal}}

## 工作目錄
{{cwd}}

## 必讀輸入
{{inputs}}

## 必交輸出
{{outputs}}

## 產出格式
{{outputFormat}}

## 約束
- 只改 outputs 列出的路徑，以及 cwd 內為完成本單所需的原始碼
- 禁止修改 workflow-state.json、checkpoint、lock、runtime/
- 禁止宣布「進入下一階段」或自行決定後續流程
- 若缺使用者決策：不要直接問使用者；在 result 裡回 status: needs_human 並寫清問題
```

`commands/start.md` 的正文（唯一允許的控制流）：

```
LOOP:
  1. 執行 `sdd-graph start --task <taskName> --repo <repoUrl>`
  2. 依退出碼分支：
     - exit 0：階段已完成，向使用者回報結果，結束
     - exit 2：讀 stdout 的 JSON 信封，依 audience 分支
         · audience=user：把 payload 的 question/options 問使用者；
           使用者答完後執行 sdd-graph approve --task <taskName> --payload '<json>'
         · audience=host：依 payload.role 與 payload.prompt，用本會話既有工具完成 payload.outputs；
           完成後執行 sdd-graph complete --task <taskName> --result '<json>'
     - exit 1：讀 stderr，向使用者回報錯誤，結束
  3. 回到步驟 1

禁止：跳過 complete/approve 自己推進階段、手動改 workflow-state.json、在工作單之外改檔案
```

`commands/resume.md`：同一個 LOOP，只是第一步改成 `sdd-graph resume --task <taskName>`；**必須**先印出被重發的工作單（id/role/outputs）讓使用者知道要幹嘛。

`commands/status.md`：只讀，明寫「本指令不會推進任何階段」。
`commands/stop.md`：`sdd-graph stop --task <taskName>`，說明保留 checkpoint 與工作區。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/prompt-loader.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/prompts prompts commands tests
git commit -m "$(cat <<'EOF'
feat: 統一工作單模板並把 Claude Code 命令改寫成單一 LOOP

EOF
)"
```

---

### Task 14: 端對端手跑、change 入口、README

**Files:**
- Create: `commands/change.md`, `README.md`
- Modify: `src/cli/index.ts`（加 `change` 子命令）
- Test: `tests/change-entry.test.ts`

**Interfaces:**
- Consumes: Task 4 `runCli`；Task 13 `commands/*.md`
- Produces:
  - `sdd-graph change --task <n>` —— v1 **只預留**：印出「未實作」並回 1，**不得** silently 忽略（實作方案 §13）
  - `README.md` —— 安裝、marketplace symlink 指令、六階段圖、`/sdd-graph:*` 命令一覽、v1 不做清單

- [ ] **Step 1: Write the failing test**

```ts
// tests/change-entry.test.ts
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';

describe('change 入口', () => {
  it('v1 必須明確報未實作而不是 silently 忽略', async () => {
    const rc = await runCli(['change', '--task', 'whatever']);
    expect(rc).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/change-entry.test.ts`
Expected: FAIL —— 找不到 `change` 子命令（目前回 1 但訊息不對，測試改用訊息斷言）

- [ ] **Step 3: Implement change 入口與 README**

`src/cli/index.ts` 的 `change` 分支：印 `{"kind":"error","code":"not_implemented","message":"/sdd-graph:change 尚未實作：v1 只預留入口，圖狀態仍由階段路由推進。"}` 到 stderr，回 1。

`commands/change.md`：說明 v1 未實作、預留原因（圖要能從 checkpoint 改道，不能做成一次性單向帶）、以及未來要支援的方向。

`README.md`：安裝（`npm install` + marketplace symlink 指令）、架構圖、六階段與 interrupt 分類、命令一覽、v1 不做清單、如何跑測試。

- [ ] **Step 4: 端到端手跑（人工，非自動化）**

在真實 Claude Code 會話裡依序驗收：

1. `/sdd-graph:start --task qrcode-demo --repo <本機 git repo>` → 圖跑到 `collect_prd` 中斷，宿主把 PRD 問題問出來。
2. 使用者回答 → `approve` → 進 `spec` → 發 `spec_writer` 工作單 → 宿主寫出 `spec.md`（含 `AC-001`～）→ `complete` → 圖解析出 AC → `confirm_spec`。
3. **開新會話**執行 `/sdd-graph:resume --task qrcode-demo` → 必須拿到**同一張**未完成工作單，且**不得**重跑 bootstrap（看 `git log` 與 `runtime/branch-runtime-lock.json` 的 `runId` 未變）。
4. 故意讓 `complete` 回報一個不存在的 output → 必須重發同一張單，且 `tddAttempts` 不增加。
5. 故意用 `approve` 去答一張 `audience: host` 的單 → 必須報 `audience_mismatch`。

五項全部符合才算通過；任一不符就修到符合再往下。

- [ ] **Step 5: Commit**

```bash
git add commands README.md src/cli tests
git commit -m "$(cat <<'EOF'
feat: 預留 change 入口並補齊插件說明文件

EOF
)"
```

---

## 任務與里程碑對照

| 里程碑 | Tasks | 可交付物 |
|---|---|---|
| M1 骨架 | 1–4 | 可執行套件 + 空圖 + 兩類 interrupt + CLI 合約；殺進程仍能 resume 同一張單 |
| M2 確定性骨架 | 5–7 | bootstrap（鎖/工作區中斷）、verify 四關、ID 解析器；全程不經過 Claude |
| M3 寫作階段 | 8–10 | PRD/Spec/E2E/Tasks 四張工作單 + traceability 矩陣；blocking TBC 擋得住推進 |
| M4 TDD + 宿主 | 11–14 | TDD 迴圈、評審升級、LOOP 命令、真機換會話手跑 |

## 附錄：實作方案 §15 測試清單對照

| 實作方案要求的測試 | 本計畫位置 |
|---|---|
| `entry-router.test.ts` | Task 3 |
| `resume-interrupt.test.ts` | Task 4 |
| `already-exists.test.ts` | Task 5 |
| `bootstrap-lock.test.ts` | Task 5 |
| `verify-retry.test.ts` | Task 6 |
| `verify-manual-back-to-tdd.test.ts` | Task 6 |
| `tdd-loop.test.ts` | Task 11 |
| `tdd-escalation.test.ts` | Task 12 |
| `artifact-sync.test.ts` | Task 2 |
| `parser-ids.test.ts` | Task 7 |
| `work-order-complete.test.ts` | Task 12 |
| `audience-routing.test.ts` | Task 4 |
