# Rental Investment Analysis Portal

A local tool that extracts monthly financial reports for two rental
property investments out of the CashFlowPortal investor portal and
visualizes them as an interactive dashboard.

## Prerequisites

- Node.js 18+
- `poppler` (`brew install poppler`) — provides `pdftotext` and `pdftoppm`
- `npm install`
- Copy `config.example.json` to `config.json` and fill in:
  - `deals.legacy.dealId` / `deals.mcneil.dealId` (portal deal UUIDs —
    already correct in the example file, only change if these deals'
    URLs change)
  - `vision_llm` — OPTIONAL. Only needed to extract Legacy's detailed
    monthly P&L table (its report format embeds that table as an image).
    Point `base_url`/`api_key`/`model` at any OpenAI-compatible
    vision-capable model (OpenAI GPT-4o, DeepSeek's vision model, a local
    Ollama vision model, etc.). Leave this block out entirely to run
    without any LLM — Legacy's occupancy/narrative/summary figures still
    extract fully deterministically; only the itemized expense table for
    that one deal will show as "not extracted" in the dashboard.

## Monthly refresh workflow

1. Launch Chrome with remote debugging and log into the portal manually:
   ```
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --remote-debugging-port=9222 \
     --user-data-dir=/path/to/a/persistent/chrome-profile-dir \
     "https://whitepagodagroup.cashflowportal.com/app"
   ```
   Log in through the UI. This profile directory persists your session,
   so you generally only need to log in again when the session expires.
2. Run: `npm run refresh`
   This harvests any new monthly emails since the last run, extracts
   their attachments into `data/legacy.json` / `data/mcneil.json`,
   refreshes `data/distributions.json` (your per-quarter distribution
   from the portal's Distributions table, plus quarterly totals
   aggregated from the deterministic per-month figures) and the
   ownership cross-check in `data/capital.json`, and regenerates
   `dashboard/data.js`.
3. Open `dashboard/index.html` directly in a browser (no server needed).

`data/capital.json`'s `totalRaise` field is the one figure that is
**not** produced by `npm run refresh`. It is captured once per deal,
manually, from that deal's offering document (the PPM / Investor
Summary, or for McNeil specifically, the Investment Deck's ACQUSITION
SUMMARY table) using `extractTotalRaise` from `scripts/lib/offering-doc.mjs`.
A deal's total capital raise does not change over time, so it is
recorded once and left in place — the refresh never re-scrapes it. To
re-capture it (e.g. after obtaining a corrected offering document), run
`extractTotalRaise(pdfPath, labelPattern)` against the PDF and update
`totalRaise` (and its `totalRaiseSource` note) by hand. Static
one-time documents like the Investment Deck are archived via
`harvestStaticDocument` (in `scripts/harvest.mjs`), not the per-month
`harvestDeal` flow — they don't change monthly, so they aren't
re-downloaded on every refresh.

## Running tests

`npm test` — runs all `*.test.mjs` files under `scripts/`. All financial
parsing logic is deterministic and tested against real sample reports
committed under `scripts/__fixtures__/`.

## Data files

- `data/legacy.json`, `data/mcneil.json`, `data/projections.json` are
  tracked in git — they're the durable record of what's been extracted,
  and Larry's own financial history is worth versioning.
- `data/raw/` (the original downloaded PDFs/XLSX files) is gitignored —
  regenerable via `npm run refresh` from the portal, and large.
- `dashboard/data.js` is gitignored — it's a pure, regenerable derivative
  of the three JSON files above.
