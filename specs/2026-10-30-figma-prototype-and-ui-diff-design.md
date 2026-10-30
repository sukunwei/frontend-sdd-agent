# Figma 原型與 UI diff 流程設計

日期：2026-10-30
狀態：待實作
相關文件：`specs/2026-10-30-sdd-flow-efficiency-design.md`（同一輪的效率優化）

---

## 1. 目標

PRD 階段的 Figma 抓取，現在只產出「給人看的素材」：節點樹、design token、設計說明、截圖。這些素材抓得對不對，要等到寫完程式碼、看到畫面才知道 —— **太晚了**。

這份設計在抓取之後加兩步：

1. 把抓到的設計轉成一頁**靜態 HTML 原型**；
2. 把原型渲染出來的畫面跟 Figma 截圖做 **UI diff**，把差異修掉。

原型同時是兩件事：

- **驗證工具** —— 原型只靠抓下來的資源做得出來，代表那些資源夠用。抓得少了，diff 立刻看得出來。
- **交付物** —— 使用者可以在瀏覽器裡直接打開它。spec 作者與 developer 拿到的是一份比 PNG 好讀得多的視覺真值：截圖只能說「長這樣」，HTML 能說「這裡是 8px 間距、這是 `var(--color-primary)`、這是三欄 grid」。

## 2. 不做的事

| 不做 | 理由 |
|---|---|
| 不在 TDD 階段做像素 diff | 這件事在 PRD 階段就做完了。像素 diff 應該發生在**還沒寫任何產品程式碼**的時候 —— 那時要修的成本只有改一份 HTML。等到 TDD 才發現抓錯了，要改的是整套實作。 |
| 不自己呼叫 Figma REST API | 會話本來就有 Figma MCP 工具。外掛不碰 token、不加設定檔。 |
| 不寫進目標 repo 的原始碼 | 原型是文件，住在 `docs/<需求>/figma/prototype/`。 |
| 不用像素分數擋流程 | 像素比對對抗鋸齒與字體渲染太敏感。硬關卡只擋「根本跑不起来的失敗」。 |

## 3. 產物契約

全部落在 `<repo>/docs/<需求>/` 底下：

```
figma/
  figma-meta.json      ← 改：必須有 frames[]
  design-tree.json       不變
  design-tokens.json     不變
  design-context.md      不變
  screenshots/
    1-23.png           ← 改：檔名 = frameKey
  prototype/           ← 新
    index.html           索引頁：列出每個 frame 的連結
    1-23.html            一 frame 一頁
    css/
      tokens.css         design token → CSS 變數（必填）
      base.css           重置 + 排版基底
      frames.css         各 frame 的版面規則
    assets/
      icons/*.svg        skill 下載回來的 icon
      images/*.png       skill 下載回來的圖片
  diff/                ← 新，而且只有「圖」會寫它
    report.md            人看的報告：每個 frame 的分數與差異熱區，以及失敗的原因（瀏覽器自己的 stderr）
    frames.json          機器讀：FrameDiff[]（{ key, status, ratio, width, height, error? }）
    1-23.diff.png        差異圖
    render/1-23.png      HTML 的實際渲染截圖
```

### 3.1 frameKey

`nodeId` 裡的 `:` 換成 `-`（`1:23` → `1-23`）。截圖與 HTML 用同一個 key，因此自動配對。

量測模組掃 `screenshots/*.png`，每一張去配 `prototype/<key>.html`；配不到就是「這張截圖沒有對應的原型」。

### 3.2 `figma-meta.json` 的 `frames[]`

```jsonc
{
  "fileKey": "abc123",
  "name": "Design System",
  "lastModified": "...",
  "pages": ["Page 1"],
  "frames": [
    { "nodeId": "1:23", "name": "Home / Desktop", "width": 1440, "height": 900 }
  ]
}
```

`frames[]` 是必要的，因為 `figma-implement-design` skill 需要**帶 `node-id` 的 Figma 網址**，而 frame 清單只有抓取階段知道。記下寬高之後，量測時也能檢查截圖尺寸是否等於 frame 尺寸。

### 3.3 原型的三條硬規則

1. **自帶** —— inline 或 `css/` 內的樣式、`assets/` 內的資源、全部相對路徑。`file://` 直接開得起來，Playwright 也照樣渲染。
2. **`css/tokens.css` 必填** —— design token 變成 CSS 變數之後，HTML 裡不該再出現裸 hex。這是 developer 階段「不寫 Raw 樣式值」那條規則的源頭。
3. **一 frame 一頁** —— 頁面尺寸等於 frame 尺寸。

## 4. 工作單

四張。都在 PRD 階段（或 spec 階段的補抓路徑，見 §6.2）。

| role | 什麼時候發 | 產出 |
|---|---|---|
| `figma_fetch`（既有，改 prompt） | 有 Figma 網址時 | P0 四份 + `screenshots/<frameKey>.png` + `figma-meta.json` 的 `frames[]` |
| `figma_prototype`（新） | P0 與截圖齊全後 | `prototype/index.html`、每 frame 一頁 HTML、`css/`、`assets/` |
| `figma_polish`（新） | 權威量測仍有硬失敗時（罕見） | 修好的 HTML |
| — | 圖自己跑，不中斷 | `figma/diff/*` 權威報告 |

### 4.1 `figma_fetch` 的改動

- 截圖檔名不再是「名字隨你取」，而是 `<frameKey>.png`。
- `figma-meta.json` 必須有 `frames[]`（每個主要畫面的 nodeId／名稱／寬／高）。
- **哪些 frame 是 P0**：主要畫面（`screenshots/` 裡有截圖的那些）。量測只量 P0，不是整份 design 的每一頁。

### 4.2 `figma_prototype` 的工作單怎麼叫 skill

工作單裡明講「**用 `figma-implement-design` skill 的流程**」，並逐點指定差異：

| skill 步驟 | 在這個流程裡 |
|---|---|
| 1 取得 node id | 從 `figma-meta.json` 的 `frames[]` 讀，拼出帶 `node-id` 的網址 |
| 2 抓 design context | 照做（`get_design_context`） |
| 3 抓視覺參考 | 照做（`get_screenshot`） |
| 4 下載 assets | 照做，存到 `prototype/assets/` |
| 5 翻譯成專案慣例 | **改成**：翻譯成獨立的靜態 HTML。不要寫進專案原始碼 |
| 6 做到 1:1 | 照做 |
| 7 對照截圖驗證 | 照做，但**用 `sdd-graph figma-diff` 拿數字**，不要靠眼睛 |

**模型在自己的回合裡迭代**：工作單裡叫它跑 `sdd-graph figma-diff`，依報告改 HTML，最多迭代 3 輪，滿意了才回報。圖之後再跑同一支程式一次，當權威證據。

### 4.3 `figma_polish` 的工作單

只有「圖的權威量測發現硬失敗」時才發。輸入是 diff 報告與現有的 prototype，輸出是修好的 HTML。正常情況下不會用到 —— 因為模型已經在回合內迭代過了。

## 5. 量測

### 5.1 模組 `src/figma/measure.ts`

```
1. 掃 figma/screenshots/*.png → frameKey 清單
2. 每個 frameKey：
   ├ 沒有 prototype/<key>.html        → 硬失敗（缺原型頁）
   ├ 讀 PNG 尺寸 → viewport W×H
   ├ npx playwright screenshot --viewport-size="W,H" file://<html> diff/render/<key>.png
   │     cwd = 目標 repo；失敗 → 硬失敗（渲染失敗）
   ├ 兩張圖尺寸不同                    → 硬失敗（尺寸不符）
   └ pixelmatch → ratio + diff/<key>.diff.png
3. 寫 diff/frames.json + diff/report.md
```

**依賴**：只加 `pngjs` + `pixelmatch`（純 JS，沒有瀏覽器下載）。瀏覽器用**目標 repo 已有的 Playwright** —— 驗證階段的 e2e 關卡本來就靠它，不為此改動目標 repo 的套件。

### 5.2 CLI `sdd-graph figma-diff`

```
sdd-graph figma-diff [--docs <dir>] [--repo <dir>] [--json]
```

- 印每個 frame 的 ratio 摘要；exit code 0 = 沒有硬失敗，1 = 有硬失敗。
- **模型和圖呼叫的是同一支程式** —— 模型在回合內拿它迭代，圖用它產生權威報告。這是「圖跑量測」這條約束的實作方式：量測的程式住在外掛裡，兩邊跑的是同一份程式碼。

### 5.3 硬失敗 vs 軟指標

| 分級 | 條件 | 處置 |
|---|---|---|
| 硬失敗 | 渲染失敗／尺寸不符／缺原型頁／完全沒有可配對的 frame | 擋：發 `figma_polish`；用完仍不通 → blocking TBC，問使用者 |
| 軟指標 | 像素 ratio > 2% | 不擋：寫進 `report.md` 與 non-blocking TBC，`confirm_prd` 讓使用者看得到 |

`report.md` 必須寫明一件事：**字體與抗鋸齒的差異會讓基準失真**。所以分數是軟指標；硬指標只有「跑不起來」。

## 6. 圖的接線

### 6.1 PRD 階段

```
collect_prd → figma_fetch → 檢查 P0 與截圖 → figma_prototype
 → 【圖的權威量測】 → 有硬失敗？ → figma_polish → 再量測（最多 2 次）
   → [figma_needs_human 若有] → confirm_prd（payload 加：原型路徑 + diff 摘要）→ spec
```

沒有 Figma（設計用文字描述）→ 整段跳過。

`confirm_prd` 的 payload 要帶 `prototype/index.html` 的路徑與 diff 摘要 —— 使用者確認 PRD 的時候，順便看得到原型跟還差多少。

### 6.2 spec 階段的補抓路徑

`src/nodes/spec.ts` 有一條自己的 Figma 路徑（PRD 抓不到時由使用者決定要不要補抓）。那條路徑**也要走原型流程**，否則 developer 階段會沒有 HTML 真值來源。

因此原型流程要抽成共用模組（例如 `src/nodes/figma-flow.ts`），由 `prd.ts` 與 `spec.ts` 各自呼叫，step ledger 記在各呼叫者自己的 stage 底下（resume 才不會走錯分支）。

### 6.3 檢查函式

- `checkFigmaP0(docsDir)` —— 維持原樣（P0 四份 + 至少一張 png）。
- `checkPrototype(docsDir)` —— 新增：每張截圖都要有對應的原型頁。

## 7. 下游

| 檔案 | 改動 |
|---|---|
| `prompts/developer.md` | P0 素材清單加 `figma/prototype/<frameKey>.html` 與 `figma/prototype/css/tokens.css`；「UI 真值來源」改成「以 HTML 原型為準、截圖為輔」 |
| `prompts/spec-writer.md` | `figma/*` 的說明加上原型 |
| `prompts/quality-reviewer.md` | 「Layout and spacing match screenshots」改成「跟 prototype 對得上」；**不做像素 diff** |
| `README.md` | 流程圖、role 清單、產物表 |

## 8. 錯誤處理

| 情況 | 處置 |
|---|---|
| 沒有 Figma 網址 | 跳過整段原型流程 |
| P0 抓不到 | 沿用現有行為：non-blocking TBC，流程繼續 |
| 抓到了但沒有截圖 | 硬失敗 → polish |
| 有截圖但沒有原型頁 | 硬失敗 → polish |
| 渲染不出來（HTML 語法錯、asset 路徑錯） | 硬失敗 → polish；報告寫下 stderr |
| 尺寸對不上 | 硬失敗 → polish |
| 像素差太多 | 軟指標 → 報告 + TBC，不擋 |
| 目標 repo 沒有 Playwright | **環境問題**：直接記 blocking TBC，不發修補工作單（那不是 HTML 的問題）。量測程式用的是目標 repo 自己的 `node_modules/.bin/playwright`，不是 `npx`（`npx` 會自己去下載一份，量的就不是這個專案了） |

## 9. 測試策略

- **量測模組**：注入假的 renderer 與假的 diff 函式（測試不跑真的 Playwright、不裝瀏覽器）。
- **PRD／spec 的迴圈**：用既有的 `testNodes` 注入假節點，驗證「量測有硬失敗 → 發 polish → 再量測 → 放行」的分支。
- **`checkFigmaP0` / `checkPrototype`**：純函式，沒有特殊狀況。
- **CLI**：`figma-diff` 的參數解析與 exit code。
- 這個 repo 自己的單元測試是 vitest，寫成 `.ts`（不需要 `.tsx`）。

## 10. 實作影響清單

**新增**
- `src/figma/measure.ts` —— 量測模組
- `src/nodes/figma-flow.ts` —— 共用的 Figma 流程（fetch → prototype → measure → polish）
- `prompts/figma-prototype.md`、`prompts/figma-polish.md`
- `specs/` 這份文件

**修改**
- `prompts/figma-fetch.md` —— 截圖命名契約、`frames[]`
- `src/nodes/prd.ts` —— 呼叫共用流程、確認關卡 payload
- `src/nodes/spec.ts` —— 補抓路徑呼叫共用流程
- `src/cli/protocol.ts` —— `WORK_ORDER_ROLES` 加 `figma_prototype`、`figma_polish`（payload 的 role 用底線，prompt 檔名用連字號：`figma_prototype` ↔ `prompts/figma-prototype.md`）
- `src/cli/index.ts` —— `figma-diff` 子命令
- `package.json` —— 加 `pngjs`、`pixelmatch`
- `prompts/developer.md`、`prompts/spec-writer.md`、`prompts/quality-reviewer.md`
- `README.md`
