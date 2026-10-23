# Automatic MC Carrier Lookup

React + TypeScript + Vite frontend and Express backend for FMCSA QCMobile lookups. The interface links to official SAFER Company Snapshot for cross-checking. It does not scrape SAFER pages.

## Requirements
- Node.js 20 LTS or newer
- An FMCSA QCMobile API WebKey
- Internet connection

Official API access instructions: https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess

## Windows setup

### 1. Configure the key
From the project root in PowerShell:
```powershell
Copy-Item .\backend\.env.example .\backend\.env
notepad .\backend\.env
```
Replace `PASTE_YOUR_FMCSA_WEBKEY_HERE` with your real key. Never commit `.env` or expose your key in frontend code.

### 2. Install frontend dependencies
Run in the project root (where the root `package.json` is):
```powershell
npm install
```

### 3. Run backend
Open a second terminal in the project root:
```powershell
cd backend
npm install
npm run dev
```
Keep this terminal open. Backend runs at `http://localhost:5000`.

### 4. Run frontend
Open a third terminal in the project root (not in backend):
```powershell
npm run dev
```
Open the Local URL shown by Vite, usually `http://localhost:5173`.

## Test
- Health: http://localhost:5000/api/health
- MC lookup: http://localhost:5000/api/carriers/1819001

Real lookup results require a valid WebKey and an available matching FMCSA record. If the request fails, the UI displays an error; it does not invent carrier data.

## Limitations
- Uses the FMCSA QCMobile docket-number endpoint, then attempts basics, authority, out-of-service and docket-number endpoints if a USDOT number is identified. Endpoint availability and fields vary.
- The UI displays raw JSON because field names must be confirmed against actual source responses before safely mapping details.
- SAFER is opened as an official cross-check; this starter does not automatically scrape SAFER.
- This is a single-number lookup starter, not yet a bulk processor.
- Do not assume USDOT ACTIVE means operating authority is active. Do not infer missing values.
- Respect FMCSA terms and rate limits.
