# SDD 流程效率設計

日期：2026-10-30
狀態：待實作
相關文件：`specs/2026-10-30-figma-prototype-and-ui-diff-design.md`（同一輪的 Figma 流程改���）

---

## 1. 問題

一輪 SDD 流程慢，慢在**來回次數**，不是慢在做事。

每個工作單中斷一次，會話就要恢復一次、重新讀一次 prompt、重新讀一次 spec 與素材、確認自己在第幾個 task。來回次數是程式裡可以數的：

| 階段 | 來回次數 | 來源 |
|---|---|---|
| PRD | 3（+1 若工人有問題） | `collect_prd` → `figma_fetch` → `confirm_prd` |
| Spec | 2～5 | 寫 spec → 補問題 → 補 TBC → `confirm_spec` |
| E2E | 2 | 寫計畫 → `confirm_e2e` |
| Task split | 2 | 切 task → `confirm_tasks` |
| **TDD** | **3 × 每個 task** | developer → spec review → quality review（失敗重來最多 3 輪 → 單一 task 最壞 9 次） |
| Verify | 1 | 四道關卡（內部，不算來回） |

**總計 ≈ 10 + 3N**（N = task 數）。5 個 task 的 run 大約 25 次來回。

每個 task 的 spec review 與 quality review 都要重讀一次 diff 與 spec，token 成本也跟 task 數走。所以**每多切一刀 = 多 3 次來回**。

這份設計從三個地方省時間：task 不要切太細、關卡不要串行等、每個 task 不要審兩次。

## 2. Task 拆分粒度

### 2.1 現在的規則

`prompts/task-splitter.md`：

- 複雜度只准 `S`／`M`，**`L` 直接退件重拆**（`src/nodes/task-split.ts:402`：「A task of complexity `L` is too big」）
- **「測試也拆成 task（E2E 一個、單元測試一個）」**
- 每個 task **2～5 條驗收條件**

### 2.2 三條改動

**（a）測試不獨立成 task**

唯一例外是最後一個「端到端驗收」task（要整個 app 才跑得動）。單元測試跟著它測的實作走 —— developer 的工作單本來就要求 TDD（先寫測試再寫實作），測試留在實作 task 裡是天然的。

單元測試檔用 `.ts` 就夠，不需要為了單元測試開 `.tsx`。

**（b）放寬 `L`，但改掉 `L` 的定義**

判準不該是複雜度字母，該是「**一個 developer 回合做得完嗎**」。

| 情況 | 判定 |
|---|---|
| 跨多個檔案，但一個回合做得完 | `L`，允許 |
| 一個回合做不完 | 拆 —— 而且拆的是「流程的中段」，不是「檔案數」 |

程式面要跟著改：

- `src/state/schema.ts:78` —— `ComplexitySchema` 從 `z.enum(['S', 'M'])` 放開成 `['S', 'M', 'L']`；`src/state/types.ts` 的 `Complexity` 型別跟著放寬。
- `src/nodes/task-split.ts` —— `hasComplexL` 閘門從「一律退件」改成「L 必須是單一行為，否則退件」；退件訊息要說清楚差在哪裡。

**（c）用 task 數當預算**

`N ≈ ceil(AC 數 / 4)`，上限 8。超過 8 不是「需求大」，是「拆太細」。

驗收條件的條數也要跟著放寬：每個 task **3～8 條 AC**（現在是 2～5），否則 4 條 AC 的 task 數預算會逼出比預期更多的切片。

### 2.3 兩條反模式

- **不要把骨架和內容拆開** —— 「先建頁面骨架」再「再填內容」：中間那個 task 沒有可驗收的使用者行為，卻要付 3 次來回和一次 rollback 風險。
- **不要把同一次改動拆三段** —— 「加路由」「加元件」「接起來」是同一個行為的三段。

### 2.4 12 條 AC 的需求

| | task 數 | 來回 |
|---|---|---|
| 照現有規則 | 8～10 | 24～30 |
| 改成垂直切片 | 3 | 9 |

### 2.5 風險那側

大 task 失敗 = 整個切片 rollback，來回成本 9 次。所以「越大越快」有上限，**上限就是一個 developer 回合**。純邏輯 task（後端、資料層、工具函式）可以更大，因為沒有視覺成本；視覺 task 維持單一畫面 —— 視覺正確性只有一輪 diff 能救。

## 3. 驗證關卡並行

`src/nodes/verify-checks.ts` 現在是依序跑（`lint:ts` → `lint` → `test` → `e2e`），**一關失敗就停後面的**。

改成四道關卡**全部跑完再一起報**，時間從 sum 變 max。e2e 通常最慢，這一項在實務上最有感。

唯一的例外保留順序：`lint:ts` 失敗時跳過後面（型別錯了，測試結果沒意義）。

`lint` 目前的 `--fix` 二次執行邏輯保留 —— 它是唯一能自我修復的關卡。

## 4. 每個 task 只審一次

現在每個 task 三張工作單：developer → spec review → quality review。

改成 **spec review 與 quality review 併進同一張工作單、同一個回合**：先照 spec 審（驗收條件有沒有達成），再照品質審（設計、測試、錯誤處理）。一次來回拿到兩份結論。

每 task 3 次 → 2 次；審查失敗要重來時，兩個審查一起重跑，省一半。

程式面：`src/subgraphs/tdd.ts` 的子階段狀態機從
`developer_done → spec_review_done → quality_review_done`
合併成
`developer_done → review_done`。

`prompts/spec-reviewer.md` 與 `prompts/quality-reviewer.md` 合併成一份 `prompts/reviewer.md`（先 spec 後 quality 兩段）。

## 5. 不在這份 spec 裡的

這三件事效益大但工程量大，而且跟上面三件不同性質，各自另開：

| 主題 | 說明 |
|---|---|
| 風險分級的人工關卡 | `confirm_prd`／`confirm_spec`／`confirm_e2e`／`confirm_tasks` 四個關卡都要人回應。可以改成低風險時自動放行、關卡降級成通知。**這是風險取捨，要人決定。** |
| task 平行 | 不同 task 各自 worktree 同時實作。效益最大（3N → 1），但要動 branch 鎖、審查一致性、衝突整合。 |
| prompt／context 瘦身 | 每個 task 都重讀整份 spec 與全部 figma 素材。有了 HTML 原型之後，可以只給這個 task 對應的那一個 frame。 |

另外，Figma 階段的迭代改成「模型在回合內自己跑量測」（量測程式做成 CLI），讓 figma 階段的來回從 k 次降到 1 次 —— 那一條在 `specs/2026-10-30-figma-prototype-and-ui-diff-design.md` 裡。

## 6. 實作影響清單

**修改**
- `prompts/task-splitter.md` —— 拆分原則與硬性規則
- `src/state/schema.ts`、`src/state/types.ts` —— 放寬 `Complexity`
- `src/nodes/task-split.ts` —— `hasComplexL` 閘門改成「L 必須是單一行為」
- `src/nodes/verify-checks.ts` —— 關卡並行
- `src/subgraphs/tdd.ts` —— 合併兩個審查子階段
- `prompts/spec-reviewer.md` + `prompts/quality-reviewer.md` → `prompts/reviewer.md`
- `src/cli/protocol.ts` —— `WORK_ORDER_ROLES` 去掉 `spec_reviewer`、`quality_reviewer`，改成 `reviewer`（payload 的 role 用底線，prompt 檔名用連字號：`reviewer` ↔ `prompts/reviewer.md`）
- `README.md` —— 流程與角色說明

**測試**
- 單元測試（vitest，`.ts`）涵蓋：新的 `Complexity`  schema、放寬後的閘門行為、關卡並行的結果聚合、合併後的子階段狀態機
- 既有測試需要更新（複雜度、退件訊息、審查工作單的數量）
