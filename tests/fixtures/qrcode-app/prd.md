# PRD: QR Code Generator (qrcode-app)

## 1. Concept & Vision

A clean, focused QR code generator page where users enter text and instantly get a scannable QR code. No clutter, no distractions — just input, output, download.

## 2. Tech Stack

- **Framework**: Next.js 16 (App Router) + React 18
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS + CSS Modules
- **QR Library**: `qrcode` npm package or similar
- **State**: React useState (simple enough, no MobX needed)
- **Testing**: Jest + Playwright

## 3. Functionality

| # | Feature | Description |
|---|---------|-------------|
| F1 | Text Input | Single-line text input field for URL or text |
| F2 | Live QR Preview | Real-time QR code generation as user types |
| F3 | Download Button | Download QR code as PNG image |
| F4 | Error State | Show error if text is empty or too long for QR |

## 4. User Flow

1. User navigates to `/qrcode-app`
2. User types text in input field
3. QR code preview updates in real-time
4. User clicks "Download" to save QR as PNG

## 5. Component Inventory

| Component | Description |
|-----------|-------------|
| `QrCodeGenerator/` | Main page component |
| `QrCodeInput/` | Text input field with validation |
| `QrCodeDisplay/` | Renders QR code image |
| `QrCodeDownload/` | Download button |

## 6. File Structure

```
src/app/page/qrcode-app/
├── page.tsx
├── page.module.css
└── components/
    ├── QrCodeInput/
    ├── QrCodeDisplay/
    └── QrCodeDownload/
```

## 7. Out of Scope

- Custom QR colors/sizes (use defaults)
- Batch generation
- QR code scanning
- History/saved codes
