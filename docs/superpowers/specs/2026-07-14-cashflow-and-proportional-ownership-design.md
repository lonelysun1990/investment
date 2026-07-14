# Cash Flow & Proportional Ownership — Design Spec

Date: 2026-07-14
Status: Approved
Parent: 2026-07-14-rental-investment-portal-design.md

## 1. Problem

The dashboard currently shows total-property P&L (income, expenses, NOI, net income) but
does not connect these numbers to what Larry actually receives. The "Investor cash flow"
section at the bottom of each deal view is a placeholder. Additionally:

- Legacy has only one month (May 2026) extracted, but the May PDF contains a rolling
  5-month P&L table (Jan-May 2026) — those earlier months should be extracted.
- McNeil shows all 2025 months as zeros — a bug in extraction.
- Ownership stake (what % of the total capital Larry's $50K represents) is unknown.
- Distributions are not tracked at all.

## 2. Goals

1. Extract Jan-May 2026 Legacy months from the existing May 2026 PDF's trailing P&L image.
2. Fix the McNeil extraction to correctly represent pre-acquisition months.
3. Scrape the distribution history table from each deal's portal overview page during
   the harvest step; save as structured data.
4. Scrape the total capital raise from the offering documents (Investor Summary / PPM)
   to compute Larry's ownership percentage.
5. Replace the placeholder cash-flow card with:
   - Property-level distribution history (table).
   - Larry's proportional share = total distribution × (50,000 / total capital raise).
   - Cross-check: calculated proportional net income vs actual distribution, with
     mismatch flagged when they diverge meaningfully.
6. Keep all existing P&L views and charts unchanged — they show total-property numbers.

## 3. Non-goals

- No changes to how income/expense/NOI/net income are displayed (stays total-property).
- No projection comparison changes.
- No new data source — reuse the existing portal scraping mechanism.

## 4. Design

### 4.1 Legacy: extract earlier months from the May PDF

The May 2026 Legacy report (page 4) is a "Trailing Profit and Loss" table with 5 monthly
columns. Currently the vision LLM prompt extracts only the latest column. Change the
prompt and parser to extract ALL columns, keyed by month label. Each column becomes its
own monthly record in `data/legacy.json`.

The months available in the May PDF should be approximately Jan 2026 – May 2026 (5 columns).

Prompt change: ask the vision LLM to return an array of month objects with the month
label included, rather than a single column.

### 4.2 McNeil: fix pre-acquisition zeros

McNeil was acquired July 2024. The 12-month cash-flow PDF (e.g. June 2026 report) covers
July 2025 – June 2026 — these months should all have real data. The 2025-07 through
2025-12 entries are currently all zeros, which is incorrect.

Investigate and fix the extraction to correctly parse all 12 months from the PDF.
If any months are genuinely pre-activity (buildings not yet operating), they should
be omitted from the data file rather than stored as all-zero records.

### 4.3 Distribution scraping

Add to `harvest.mjs`: after harvesting emails, navigate to each deal's overview page
(`/app/deals/{dealId}`) and scrape:

- The distribution history table (likely under a "Distributions" or "Cash Flow" section).
  Expected columns: date, amount, maybe status/type.
- The total capital invested / raised for the deal (if visible on the overview page).

Save distributions to `data/distributions.json` keyed by deal slug:
```json
{
  "legacy": [
    { "date": "2026-Q1", "amount": 0 }
  ],
  "mcneil": [
    { "date": "2025-Q3", "amount": 648 },
    { "date": "2025-Q4", "amount": 648 },
    { "date": "2026-Q1", "amount": 648 },
    { "date": "2026-Q2", "amount": 648 }
  ]
}
```

### 4.4 Ownership percentage

Scrape the total capital raise from the offering documents in the Documents tab. Store
in `data/capital.json`:
```json
{
  "legacy": { "totalRaise": 1234567, "larryInvestment": 50000 },
  "mcneil": { "totalRaise": 1234567, "larryInvestment": 50000 }
}
```

Larry's ownership % = 50,000 / totalRaise.

If the total raise cannot be determined automatically (e.g., the PPM is a scanned image),
fall back to a hardcoded value in config.json that Larry fills in once.

### 4.5 Dashboard: cash flow section

Replace the placeholder `investorCashFlowCard` (currently showing "see the project's
open follow-up work") with:

```
┌─────────────────────────────────────────────────────┐
│ Your cash flow ($50,000 invested · X.X% ownership)  │
│                                                       │
│ Date        Distribution  Your share    Calc. share  │
│ 2026-Q1     $0            $0           -$2,143     │
│ 2026-Q2     $0            $0           -$1,850     │
│ ...                                                   │
│                                                       │
│ ⚠ Calculated share ≠ actual distribution             │
│   (if mismatch exceeds threshold)                    │
└─────────────────────────────────────────────────────┘
```

Columns:
- **Date**: distribution period (quarter, as observed in portal)
- **Distribution**: total property distribution (from scraped data)
- **Your share**: Distribution × ownership %
- **Calc. share**: sum of net income for the period × ownership % (from P&L records)

Mismatch detection: if |calc share - actual share| > a threshold (e.g. $50 or 10%),
show a warning flag inline.

A small bar chart or sparkline alongside would help visualize the trend.

### 4.6 Data flow

```
harvest.mjs
  ├── scrape distributions → data/distributions.json
  ├── scrape total capital → data/capital.json
  └── download email attachments (existing) → data/raw/

extract-legacy.mjs
  └── extract ALL months from trailing P&L image → data/legacy.json

extract-mcneil.mjs
  └── fix pre-acquisition handling → data/mcneil.json

build-dashboard.mjs
  ├── read legacy.json, mcneil.json, projections.json (existing)
  ├── NEW: read distributions.json, capital.json
  ├── compute ownership %, proportional shares
  └── write dashboard/data.js (add DISTRIBUTIONS, CAPITAL exports)

dashboard/app.js
  └── replace investorCashFlowCard with the real table + mismatch check
```

### 4.7 The tricky part: calculated share vs actual distribution

Net income ≠ distributions because:
- Some cash is held as reserves (capital improvements, vacancy reserves).
- Distributions may lag by a quarter.
- Some months have large one-time capex that distorts net income.

The dashboard should NOT claim a mismatch is an error — it should flag it as a
difference worth investigating. The language should be neutral: "Your proportional
net income was $X but your distribution was $Y — this is normal when capex or
reserves are involved."

## 5. Implementation order

1. Fix McNeil 2025 zeros (simplest bug fix, unblocks dashboard clarity).
2. Extract earlier Legacy months from May PDF (new prompt, immediate value).
3. Scrape distributions and total capital from portal (new data source).
4. Wire distributions + ownership into build-dashboard + app.js (dashboard update).

## 6. Edge cases

- Offering docs may be inaccessible or unscrapable (scanned image PDFs) → fallback to
  manual config value.
- A deal may have no distributions at all (Legacy currently) → show "$0 distributed
  to date" with the calculated share for context.
- Distribution dates may not align cleanly with P&L months (quarterly vs monthly) →
  aggregate P&L to quarterly for comparison.
- The vision LLM may misread some months in the trailing P&L → existing cross-check
  against narrative NOI applies; low-confidence months flagged.
