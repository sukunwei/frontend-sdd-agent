# Tasks: QR Code Generator (qrcode-app)

## Task List

| Task ID | Title | Complexity | Priority | AC Refs |
|---------|-------|------------|----------|---------|
| TASK-setup-qrcode-page-route | Setup QR code page route | S | high | AC-001, AC-003 |
| TASK-create-qrcode-input | Create QR code input | M | high | AC-001, AC-005 |
| TASK-create-qrcode-display | Create QR code display | M | high | AC-002 |
| TASK-create-qrcode-download | Create QR code download | M | high | AC-003, AC-004 |
| TASK-wire-up-main-page | Wire up main page | M | medium | AC-002, AC-004 |
| TASK-add-e2e-tests | Add E2E tests | S | medium | AC-001, AC-002, AC-003, AC-004, AC-005 |
| TASK-add-unit-tests | Add unit tests | S | medium | AC-005 |

## Task Details

### TASK-setup-qrcode-page-route: Setup QR code page route

**Description**: 建立 Next.js App Router 頁面路由 `/qrcode-app`，頁面先只有標題與版面骨架。

**Acceptance Criteria**:
- 路由 `/qrcode-app` 存在且可渲染
- 頁面出現 "QR Code Generator" 標題
- 版面置中、上下排列（依 `spec.md` 的設計系統）

**AC Refs**: AC-001, AC-003

**Files**:
- `src/app/page/qrcode-app/page.tsx`
- `src/app/page/qrcode-app/page.module.css`

### TASK-create-qrcode-input: Create QR code input

**Description**: 建立 `QrCodeInput` client component，負責受控輸入與長度驗證。

**Acceptance Criteria**:
- 輸入框為受控元件，onChange 回傳最新字串
- 文字超過 512 字元時顯示錯誤訊息且不往上回報新值
- 輸入框有 label 與 `aria-label`

**AC Refs**: AC-001, AC-005

**Files**:
- `src/components/qrcode-app/QrCodeInput/index.tsx`
- `src/components/qrcode-app/QrCodeInput/QrCodeInput.module.css`

### TASK-create-qrcode-display: Create QR code display

**Description**: 建立 `QrCodeDisplay` client component，用 `qrcode` 套件把文字畫到 canvas。

**Acceptance Criteria**:
- 有文字時 canvas 渲染出 QR code
- 沒有文字時顯示佔位文字 "Enter text to generate QR"
- QR code 邊長預設為 200px

**AC Refs**: AC-002

**Files**:
- `src/components/qrcode-app/QrCodeDisplay/index.tsx`
- `src/components/qrcode-app/QrCodeDisplay/QrCodeDisplay.module.css`

### TASK-create-qrcode-download: Create QR code download

**Description**: 建立 `QrCodeDownload` client component，把 canvas 轉成 PNG 下載。

**Acceptance Criteria**:
- 沒有 QR code 資料時下載鈕為 disabled
- 按下下載鈕會下載檔名為 `qrcode.png` 的 PNG 檔案
- 下載鈕有 `aria-label`

**AC Refs**: AC-003, AC-004

**Files**:
- `src/components/qrcode-app/QrCodeDownload/index.tsx`
- `src/components/qrcode-app/QrCodeDownload/QrCodeDownload.module.css`

### TASK-wire-up-main-page: Wire up main page

**Description**: 在主頁面把三個元件接起來，讓輸入、預覽與下載形成完整流程。

**Acceptance Criteria**:
- 輸入文字後 QR code 立即更新
- 下載鈕的可用狀態跟著輸入內容切換
- 頁面組裝後符合 `spec.md` 的版面圖

**AC Refs**: AC-002, AC-004

**Files**:
- `src/app/page/qrcode-app/page.tsx`

### TASK-add-e2e-tests: Add E2E tests

**Description**: 用 Playwright 寫 `e2e-plan.csv` 內的 E2E-001～E2E-005 五個情境。

**Acceptance Criteria**:
- E2E-001～E2E-005 五個測試全部通過
- 測試以 `AC-xxx` 標註涵蓋的驗收條件
- 測試不依賴真實網路

**AC Refs**: AC-001, AC-002, AC-003, AC-004, AC-005

**Files**:
- `e2e/qrcode-app.spec.ts`

### TASK-add-unit-tests: Add unit tests

**Description**: 補上輸入驗證與元件狀態的單元測試。

**Acceptance Criteria**:
- 覆蓋 512 字元的邊界（512 通過、513 失敗）
- 覆蓋輸入為空時的佔位狀態
- 測試覆蓋率達到專案門檻

**AC Refs**: AC-005

**Files**:
- `src/__tests__/qrcode-app.test.ts`
