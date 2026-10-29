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

你是**目前這個 Claude Code 會話**。這個外掛已經把 Figma MCP 接進來了，請用你**既有的 Figma MCP 工具**抓取這次需求的設計資源。

- **不得**自行呼叫 Figma REST API（不要用 `curl`、`fetch`、也不要另外找 token）。工具已經有了，用工具就好。
- 不要為了抓資源而新增設定檔、認證資訊或環境變數。

## 要做的事

1. 讀工作單下方「The Figma file of this run」區塊裡的 Figma 檔案網址。
2. 用 Figma MCP 工具取出 P0 資源，**寫到工作單 `outputs` 列出的絕對路徑**：

   | 檔案 | 內容 |
   |------|------|
   | `figma/figma-meta.json` | 設計檔的 metadata（file key、名稱、最後修改時間、頁面清單） |
   | `figma/design-tree.json` | 設計節點樹（frame、component、instance、尺寸、座標） |
   | `figma/design-tokens.json` | 色彩、字級、間距等 design token |
   | `figma/design-context.md` | 給實作者看的設計說明（版面、狀態、互動、邊界） |

3. 另外把**至少一張**畫面截圖存成 png，放進工作單說明的截圖目錄（`outputs` 的最後一項，見下方說明）。
4. 抓完後把結果交回圖。

## 約束
- 只改工作單 `outputs` 列出的路徑（P0 檔案與截圖目錄）；`cwd`（repo）裡只可**引用**既有的專案設定（例如既有的忽略清單慣例），不得為了產出它們而改動原始碼。不要動其他檔案。
- 禁止修改 workflow-state.json、checkpoint、lock、runtime/
- 禁止宣布「進入下一階段」或自行決定後續流程
- 若缺使用者決策：不要直接問使用者；在 result 裡回 status: needs_human 並寫清問題

## 完成時

```
sdd-graph complete --task <task-name> --result '{"status":"ok","summary":"<一句話說明抓到了什麼>","changedFiles":["<你寫出來的檔案>"]}'
```

`changedFiles` 要列出你真的寫出來的檔案（絕對路徑）。
