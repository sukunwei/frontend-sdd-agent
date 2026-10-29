# SPEC: QR Code Generator (qrcode-app)

## 背景

- **需求**：由使用者輸入的文字即時產生可掃描的 QR code
- **組件類型**：Next.js Page（App Router）
- **單檔組件**：否
- **來源 PRD**：`prd.md`

---

## 資料結構

| 欄位 | 型別 | 說明 |
|------|------|------|
| text | `string` | 使用者目前輸入的文字，上限 512 字元 |
| qrCanvas | `HTMLCanvasElement \| null` | 產生出的 QR code canvas，尚未產生時為 `null` |
| error | `string \| null` | 輸入不合法時的錯誤訊息 |

**狀態**：
- Default：輸入為空，不產生 QR code
- Typing：已有文字，QR code 即時更新
- Error：輸入框紅色邊框並顯示錯誤訊息

---

## API 設計

### 2.1 `QrCodeInput/`

| Property | Type | Description |
|----------|------|-------------|
| value | `string` | 受控的輸入值 |
| onChange | `(value: string) => void` | 文字變更 handler |
| error | `string \| null` | 驗證失敗時的錯誤訊息 |
| maxLength | `number` | 上限 512 字元 |

### 2.2 `QrCodeDisplay/`

| Property | Type | Description |
|----------|------|-------------|
| value | `string` | 要編碼的文字 |
| size | `number` | QR code 邊長（預設 200） |

### 2.3 `QrCodeDownload/`

| Property | Type | Description |
|----------|------|-------------|
| qrRef | `RefObject<HTMLCanvasElement>` | QR code 的 canvas ref |

---

## 組件設計

```
┌─────────────────────────────────────┐
│         QrCodeGenerator             │
│  ┌───────────────────────────────┐  │
│  │      "QR Code Generator"      │  │  ← h1 標題
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │  [        Text Input       ]  │  │  ← QrCodeInput
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │                               │  │
│  │      [QR Code Image]         │  │  ← QrCodeDisplay (canvas)
│  │                               │  │
│  └───────────────────────────────┘  │
│  ┌───────────────────────────────┐  │
│  │     [ Download PNG ]          │  │  ← QrCodeDownload
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

**資料流**：

```
使用者輸入 → QrCodeInput.onChange → state.text
    ↓
QrCodeDisplay 重新渲染 → qrcode() 產生 canvas
    ↓
下載鈕使用 canvas.toDataURL() → 觸發下載
```

**檔案結構**：

```
src/app/page/qrcode-app/
├── page.tsx              # 主頁面（Server Component）
├── page.module.css       # 頁面樣式
└── components/
    ├── QrCodeInput/
    │   ├── index.tsx      # 'use client'
    │   └── QrCodeInput.module.css
    ├── QrCodeDisplay/
    │   ├── index.tsx      # 'use client'
    │   └── QrCodeDisplay.module.css
    └── QrCodeDownload/
        ├── index.tsx      # 'use client'
        └── QrCodeDownload.module.css
```

---

## 設計系統

| Element | Classes |
|---------|---------|
| Container | `min-h-screen flex flex-col items-center justify-center p-8` |
| Title | `text-2xl font-bold mb-6` |
| Input | `w-full max-w-md px-4 py-2 border rounded-lg` |
| QR Wrapper | `mt-6 p-4 bg-white shadow-lg rounded-lg` |
| Download Btn | `mt-4 px-6 py-2 bg-blue-600 text-white rounded-lg` |

---

## 邊界條件

| 情況 | 行為 |
|------|------|
| 輸入為空 | 顯示佔位文字，QR code 區塊留白，下載鈕 disabled |
| 文字長度 > 512 | 顯示錯誤訊息 "Text too long for QR code"，不產生 QR code |
| 輸入非字串 | 先轉成字串再處理 |
| QR code 產生失敗 | 顯示錯誤狀態，不讓例外往上拋 |

---

## Non-goals

- 自訂 QR code 顏色或尺寸（沿用函式庫預設值）
- 批次產生
- QR code 掃描（辨識）
- 歷史紀錄或已存檔的 QR code

---

## Alternatives considered

| 方案 | 為什麼不採用 |
|------|--------------|
| 用 `<img>` + 外部 QR API 產生圖片 | 需要額外網路依賴與隱私風險，且無法離線使用 |
| 用 SVG 取代 canvas | 下載 PNG 需要額外的轉檔步驟，canvas 一次到位 |
| 用套件管理狀態（MobX） | 這個頁面只有單一 state，`useState` 足夠 |

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| QR code 套件在 Node 端被誤引入 | 只在 client component 內 `import`，並在 CI 以 lint 檢查 |
| 使用者輸入超長字串拖慢畫面 | 限制 512 字元，超過即擋下並提示 |
| 下載的檔名在不同瀏覽器行為不一致 | 固定檔名 `qrcode.png` 並以 E2E 測試鎖定 |

---

## NFR

- **效能**：輸入到 QR code 重繪的時間 < 100 ms（本地 300 字元內）
- **可及性**：輸入框有 label、下載鈕有 `aria-label`、錯誤訊息以 `role="alert"` 呈現
- **瀏覽器**：最新版 Chrome、Firefox、Safari
- **型別**：TypeScript strict mode，元件 props 明確宣告

---

## Acceptance Criteria

### AC-001: Empty input shows placeholder
輸入為空時，QR code 區塊顯示佔位文字 "Enter text to generate QR"。

### AC-002: Typing generates QR in real-time
使用者輸入文字後，QR code 隨即重新產生並更新畫面。

### AC-003: Download button disabled when no text, enabled when text present
輸入為空時下載鈕為 disabled；一旦有文字就變成可用。

### AC-004: Download creates valid PNG file with correct filename
按下下載鈕會取得檔名為 `qrcode.png` 的 PNG 檔案。

### AC-005: Error shown when text > 512 chars
輸入超過 512 字元時顯示錯誤訊息，且不產生 QR code。

---

## Clarification Questions

### Round 1

- [Q-001] QR code 的錯誤修正層級是否需要讓使用者調整？
- [Q-002] (answered) 下載的檔名固定為 `qrcode.png`，不做輸入內容的推導。

### Round 2

- [Q-003] (tbc) 錯誤修正層級沿用函式庫預設值（M），不再追問。

---

## To Be Confirmed

- [TBC-001] (blocking) QR code 錯誤修正層級的預設值尚未由產品端確認。
- [TBC-002] (non-blocking) 是否需要支援自訂 QR code 顏色，預設沿用函式庫預設值。
