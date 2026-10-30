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

你是這個需求的**原型作者**。這個外掛已經把 Figma MCP 接進來了，請用你**既有的 Figma MCP 工具**。

這張工作單要做的是：把這次需求的 Figma 畫面，做成一頁**獨立的靜態 HTML 原型** —— 給人看的那一頁，**不是**寫進專案的產品程式碼。

## 為什麼要有這一頁

- **它是驗證工具**：原型只靠抓下來的 P0 素材做得出來，代表那些素材夠用；做不出來，就是素材抓漏了 —— 在還沒寫任何產品程式碼的時候就發現。
- **它是交付物**：使用者可以在瀏覽器裡直接打開它。spec 作者與 developer 拿它當視覺真值來源：截圖只能說「長這樣」，HTML 能說「這裡是 8px 間距、這是 `var(--color-primary)`、這是三欄 grid」。

## 用 figma-implement-design skill

**用 `figma-implement-design` skill 的流程**來做這件事。照它的步驟走，但有兩個地方要改：

| skill 的步驟 | 在這個流程裡 |
|---|---|
| 1 取得 node id | 從 `figma/figma-meta.json` 的 `frames[]` 讀 `nodeId`，拼出**帶 `node-id`** 的 Figma 網址（`https://figma.com/design/<fileKey>/<name>?node-id=1-23`）。node id 裡的 `:` 要換成 `-` |
| 2 抓 design context | 照做（`get_design_context`） |
| 3 抓視覺參考 | 照做（`get_screenshot`） |
| 4 下載 assets | 照做，圖片與 icon 存到 `prototype/assets/` |
| 5 翻譯成專案慣例 | **改成**：翻譯成一頁獨立的靜態 HTML。**不要**寫進專案原始碼 |
| 6 做到 1:1 | 照做 |
| 7 對照截圖驗證 | 照做，但用 `sdd-graph figma-diff` 拿數字，不要靠眼睛 |

`figma/figma-meta.json` 裡的 `frames[]` 是這張工作單的入口：它列出每個主要畫面的 `nodeId`、名稱與寬高。

## 要產出的東西

```
prototype/
  index.html          索引頁：列出每個 frame 的連結
  <frameKey>.html     一 frame 一頁
  css/
    tokens.css        design token → CSS 變數（必填）
    base.css          重置 + 排版基底
    frames.css        各 frame 的版面規則
  assets/
    icons/*.svg
    images/*.png
```

`<frameKey>` 是 frame 的 node id 把 `:` 換成 `-`（`1:23` → `1-23`），**跟 `figma/screenshots/` 裡的截圖檔名一模一樣** —— 這樣量測程式才配得起來（它就是靠檔名配對的）。

三條硬規則：

1. **自帶**：樣式在 `css/` 裡、圖片在 `assets/` 裡、全部用相對路徑。`file://` 直接開得起來，量測程式的瀏覽器也照樣渲染得出來。
2. **`css/tokens.css` 必填**：design token 變成 CSS 變數之後，HTML 裡不准再出現裸 hex。**不寫 Raw 樣式值**這條規則的源頭在這裡。
3. **一 frame 一頁**：頁面尺寸等於 frame 的尺寸（寬高在 `frames[]` 裡）。

## 迭代（這一段是重點）

寫完一頁就跑一次量測：

```
sdd-graph figma-diff --docs <需求目錄> --repo {{cwd}}
```

`<需求目錄>` 就是工作單 `inputs` 裡 `figma/figma-meta.json` 那一條的上層目錄；
`{{cwd}}` 就是工作單的工作目錄（目標專案）。

**`--repo` 一定要帶。** 量測要用的瀏覽器是**目標專案**的 Playwright；少了這個
參數，命令會去你「現在所在的目錄」找瀏覽器，量出來的數字跟圖最後量的不是同一個。

- 退出碼 **0**：沒有硬失敗。像素有一點差是正常的（字體不同本來就會有差），**不擋你**。
- 退出碼 **1**：有硬失敗。報告寫在 `figma/diff/report.md`，照著修 —— 少了頁子、頁子渲染不出來、或者尺寸對不上。
- 退出碼 **2**：命令根本跑不起來（例如目標 repo 沒有 Playwright）。把原因寫進 result 的 summary 回報，**不要硬猜**。

**最多迭代 3 輪。** 3 輪之後還有硬失敗，就把報告裡的失敗摘要寫進 result 的 summary 回報，不要一直修下去。

## 約束
- 只寫工作單 `outputs` 列出的路徑；`cwd`（repo）裡只可**引用**既有的專案設定（例如既有的忽略清單慣例），不得為了產出它們而改動原始碼。不要動其他檔案。
- **不要動 `figma/screenshots/` 裡的截圖** —— 截圖是比對的基準，不是產物。
- 禁止修改 workflow-state.json、checkpoint、lock、runtime/
- 禁止宣布「進入下一階段」或自行決定後續流程
- 若缺使用者決策：不要直接問使用者；在 result 裡回 status: needs_human 並寫清問題

## 完成時

```
sdd-graph complete --task <task-name> --result '{"status":"ok","summary":"<做了幾個 frame 的原型、量測結果如何>","changedFiles":["<你寫出來的檔案>"]}'
```

`changedFiles` 要列出你真的寫出來的檔案（絕對路徑）。
