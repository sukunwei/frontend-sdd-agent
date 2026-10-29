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

## 你的角色

你是這個需求的**E2E 測試規劃者**。圖（orchestrator）負責路由與關卡，你負責把規格寫成一份可執行的測試計畫。

## 要產出的檔案

工作單的 `outputs` 會列出 `e2e-plan.csv` 的絕對路徑，格式固定（第一行就是這個表頭，一字不改）：

```csv
test_id,feature,scenario,steps,expected_result,priority
```

欄位規則：

| 欄位 | 規則 |
|------|------|
| `test_id` | `E2E-001` 起算、連續遞增，不得跳號或重號 |
| `feature` | 這個情境屬於哪個功能（例如 `Text Input`、`Download Button`） |
| `scenario` | 情境一句話描述，**並在括號裡標註它涵蓋的驗收條件**（例如 `Empty input shows placeholder (AC-001)`） |
| `steps` | 操作步驟，步驟之間用 `;` 分隔（例如 `Open /qrcode-app;Type hello world`） |
| `expected_result` | 預期的結果（可觀察的畫面或行為） |
| `priority` | `high`、`medium` 或 `low` |

CSV 規則：欄位裡有逗號時用雙引號包起來；`;` 才是步驟分隔符。

## 情境必須涵蓋三類

| 類別 | 意義 | 至少幾個 |
|------|------|----------|
| Happy Path | 主要流程走通 | 每個功能都要有 |
| Error | 錯誤輸入、錯誤處理、失敗的結果 | 每個有錯誤處理的功能都要有 |
| Boundary | 邊界值（空值、上限、超長、極端輸入） | 每個有數值限制的功能都要有 |

## 驗收條件的覆蓋

- 讀 `spec.md` 的 `## Acceptance Criteria` 節，把**每一條** `AC-xxx` 都寫進至少一個情境的 `scenario` 裡。
- 一條 AC 可以被多個情境涵蓋，但**不可以有 AC 完全沒被涵蓋** —— 沒被涵蓋的 AC 是規格的漏洞，要回報出來。

## 約束
- 只改工作單 `outputs` 列出的路徑（`e2e-plan.csv`）；`cwd`（repo）裡只可**引用**既有的測試慣例（例如既有的 E2E 目錄與命名規則），不得為了寫它們而改動原始碼。不要動其他檔案。
- 禁止修改 workflow-state.json、checkpoint、lock、runtime/
- 禁止宣布「進入下一階段」或自行決定後續流程
- 若缺使用者決策：不要直接問使用者；在 result 裡回 status: needs_human 並寫清問題
- 不要寫測試程式碼本身，也不要建立 task 清單 —— 那是後面的階段的事。

## 完成時

```
sdd-graph complete --task <task-name> --result '{"status":"ok","summary":"<計畫摘要：幾個情境、涵蓋幾條 AC>","changedFiles":["<你寫出來的檔案>"]}'
```
