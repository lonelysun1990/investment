# Rental Investment Analysis Portal — Design Spec

Date: 2026-07-14
Status: Approved — ready for implementation planning

## 1. Problem

Larry has two passive LP investments through White Pagoda Holdings LLC, managed
via a CashFlowPortal investor portal at
`https://whitepagodagroup.cashflowportal.com/app`:

- **The Legacy Apartment** — $50,000 invested (08/19/2025), 31-unit multifamily,
  Dallas/Sherman TX, sponsor Greystone Capital Group, PM Touchstone Property
  Management. **$0 distributed to date, 0% cash-on-cash.** This is the
  underperforming asset and the primary motivation for this project.
- **McNeil Star Apartments** — $50,000 invested (07/28/2024), same PM
  (Touchstone). ~$648/quarter in distributions — performing as expected.

The portal's UI only shows high-level, vague summaries (total invested,
total distributed, a cash-flow-history sparkline). The actual operating detail
— monthly P&L, occupancy, leasing activity, capital expenditures — is buried
in PDF/XLSX attachments on monthly "investor update" emails, which the portal
retains under each deal's Documents → Emails tab, but does not surface or
visualize.

Larry wants to understand, month by month, how each property is actually
performing, how that compares to what was underwritten/projected at
investment time, and — specifically for Legacy — build a quantitative
understanding of how occupancy is driving the losses.

## 2. Goals

1. Extract the operating and financial detail trapped in the emailed
   reports (PDF/XLSX attachments) and portal pages into a structured,
   durable, human-readable data store.
2. Present that data as an interactive local dashboard: monthly P&L,
   occupancy trends, actual-vs-projected, expense breakdowns, and the
   investor's own cash-flow position.
3. Make occupancy's contribution to Legacy's losses legible and quantified
   (not just "vibes") — via a break-even occupancy analysis and an
   occupancy/income overlay.
4. Support ongoing use: whenever a new monthly or quarterly report lands in
   the portal, re-running the tool should pick it up and update the
   dashboard, without redoing prior work or requiring a rebuild.
5. Where an LLM is genuinely required (see §5.3), make the tool provider
   agnostic — configurable to any OpenAI-compatible endpoint (OpenAI,
   DeepSeek, a local model, etc.) via a config file, never hardcoded to one
   vendor.

## 3. Non-goals

- No modification of anything in the CashFlowPortal — read-only access.
- No hosted/cloud deployment. This is a local tool for Larry's own use.
- No general-purpose PDF/XLSX parsing library — adapters are written
  specifically for the two report formats observed (see §5). If a sponsor
  changes report format, the relevant adapter needs updating, not a rewrite
  of the whole pipeline.
- No requirement to support additional properties beyond these two at this
  stage; the pipeline should be reasonably generic (a `deals` config list)
  but a third property is out of scope until requested.
- Deterministic financial parsing does not require any LLM. An LLM is used
  in exactly one place (Legacy's flattened P&L image) and only if configured;
  the tool must degrade gracefully (flag the field, don't crash) if no LLM
  is configured.

## 4. Data sources (confirmed by direct portal inspection)

### 4.1 Portal structure
- Dashboard (`/app`): portfolio totals, per-deal invested/distributed summary.
- Deal page (`/app/deals/{dealId}`): per-deal overview, distributions table,
  documents list, **Emails list** (`/app/documents/{dealId}?tab=emails`),
  deal facts (unit count, acquisition price, loan terms), cash-flow-history
  chart data.
- Deal IDs:
  - Legacy: `d4407d10-0c15-4e74-beb6-82466ac289ba`
  - McNeil: `f8929e29-285b-4904-b4e9-5b41b035535b`
- Documents tab (`/app/documents`): offering docs (Investor Summary PDF,
  PPM), subscription docs, K-1s, wire instructions.
- Each email row has an eye-icon action that opens a modal listing that
  email's attachments as time-limited signed S3 URLs
  (`cashflowportalbucket-prod.s3.amazonaws.com/...`, `Expires=` epoch
  param). URLs must be fetched fresh each run — they cannot be cached
  long-term.
- No public API observed; all access is through the authenticated web UI.
  Login is manual (user-driven); the tool automates everything after
  login via browser automation attached to that authenticated session.

### 4.2 Legacy Apartment monthly report format
Sponsor: Greystone Capital Group. Email subject pattern:
`"The Legacy Apt: <Month> <Year> Update"`. One PDF attachment per email,
named `Legacy Apt Monthly Investor Update (Greystone) - <Month> <Year>.pdf`.

PDF structure (confirmed on May 2026 report, 7 pages):
- Page 2: static deal facts (property type, class, date acquired, purchase
  price, loan amount, loan type/rate) — real text.
- Page 3: **Operations Overview** (occupancy %, evictions in process, lease
  renewals, leasing activity narrative, pre-leased %) and **Financial
  Overview** (plain-English NRI/revenue/NOI for the month) — real text,
  reliably regex-able (e.g. `occupancy at (\d+)%`, `NOI of \$([\d,]+)`).
- Page 4: **Trailing Profit and Loss** table (Touchstone Property
  Management export) — full line-item P&L across a rolling 5-month
  window (income, expense by category, NOI, debt service, capital
  improvements, net income). **This table is a flattened image, not
  text** — confirmed via both `pdftotext` and pdf.js text-content
  extraction (zero extractable text items on this page). This is the one
  place in the whole pipeline that needs visual reading.
- Pages 5–7: capital/renovation narrative + market context (Dallas +
  national) — real text, informative but not needed for the core
  financial model.

Because each month's PDF carries a trailing 5-month P&L, consecutive
reports overlap — this is useful as a consistency cross-check but means
extraction must dedupe by (deal, month), not by (deal, report-file).

### 4.3 McNeil Star Apartments monthly report format
Distinct sponsor naming ("McNeil Investment: <Month> <Year>" subject) but
same PM (Touchstone). Two attachments per email:
- `Rent Roll Summary.xlsx` — unit-level rent roll: unit #, type, sq ft,
  resident name(s), status (`C` = current/occupied, blank = vacant),
  market rent, actual rent, other charges, credits, total, move-in date,
  lease start/end, move-out date, deposits, balance. **Fully structured,
  real spreadsheet data** (confirmed via `openpyxl`, 68 rows). Occupancy %
  is directly computable as (occupied units / total units); this also
  supports per-unit and loss-to-lease analysis directly, with no
  aggregation guesswork.
- `Twelve Month Cash Flow Statement Expanded Detail.pdf` — a
  ResMan-generated rolling 12-month P&L, **fully extractable as real
  text** via `pdftotext -layout` (confirmed, 6 pages). Far more granular
  than Legacy's: breaks out Gross Potential Rent, Gain/Loss to Lease,
  Concessions, Vacancy Loss, Bad Debt/Write-off separately within Rental
  Income; itemizes every expense account; states NET OPERATING INCOME,
  Debt Service (itemized), Capital Improvements (itemized), and NET
  INCOME explicitly as text.

**McNeil requires no LLM at all** — both attachments are deterministically
parseable.

### 4.4 Projection / underwriting sources
Found under Documents (all-documents tab, filterable by deal):
- `The Legacy Apartment Investor Summary.pdf` (offering doc, 08/12/2025)
- `The_Legacy_at_Sherman_LLC_Legal_PPM.pdf` (legal PPM, 08/04/2025)
- Equivalent offering docs should exist for McNeil under its own deal
  filter (not yet opened — to be confirmed during implementation).

These are the source for "actual vs. projected" comparisons. Content depth
(annual vs. monthly targets) has not yet been read page-by-page; the
extraction step must record exactly what granularity exists, and only
where the docs give annual/stabilized figures should the tool derive
implied monthly targets (e.g. stabilized occupancy × market rent × unit
count) — every derived figure must be labeled as derived, not sourced.

## 5. Architecture

Three-stage, re-runnable pipeline, plus a static dashboard that reads its
output. No servers, no databases — flat files only.

```
data/
  raw/
    legacy/<YYYY-MM>/<original-filename>.pdf
    mcneil/<YYYY-MM>/<original-filename>.{pdf,xlsx}
  legacy.json         # canonical extracted model, keyed by month
  mcneil.json         # canonical extracted model, keyed by month
  projections.json    # extracted underwriting targets, per deal
dashboard/
  index.html
  app.js
  data.js             # generated: embeds the three JSON files as JS consts
  vendor/             # vendored chart library, no CDN
scripts/
  harvest.mjs          # stage 1
  extract-legacy.mjs   # stage 2, Legacy adapter
  extract-mcneil.mjs   # stage 2, McNeil adapter
  build-dashboard.mjs  # stage 3
  refresh.mjs          # orchestrates 1→2→3, the one command Larry runs
config.json           # gitignored: vision LLM base_url/api_key/model
config.example.json    # committed template, no secrets
```

### 5.1 Stage 1 — Harvest
Node + Playwright, connected over Chrome DevTools Protocol (CDP) to a
**visible**, user-controlled Chrome window (launched with
`--remote-debugging-port`) rather than a fully-automated headless
browser. Rationale: login is manual/interactive (2FA-capable, no stored
password), and the same profile persists session cookies between runs so
re-login is only needed when the session actually expires.

Per configured deal:
1. Navigate to `/app/documents/{dealId}?tab=emails`.
2. List all rows; diff against previously-harvested email dates/subjects
   (tracked in a small `data/raw/<deal>/_seen.json` manifest) to find new
   reports since last run.
3. For each new row, open its action modal, capture the attachment
   link(s) (signed S3 URLs), and download immediately (URLs expire).
4. Save raw files under `data/raw/<deal>/<report-month>/`.

Also captures, from the deal overview page: current distributions table,
capital balance, and cash-flow-history series — cheap, already-structured
figures worth cross-checking against the P&L-derived numbers.

Failure handling: if the portal layout has changed such that a selector
no longer matches, the harvester must fail loudly (report which step
failed) rather than silently skip a month — silent gaps would corrupt the
"month by month" narrative this whole project is for.

### 5.2 Stage 2 — Extract (per-deal adapters)

**McNeil adapter** (fully deterministic, no LLM):
- `pdftotext -layout` on the 12-month cash-flow PDF, parsed with a
  line-item table parser keyed on account-name labels (indented
  hierarchy: category → subcategory → line item), producing one row per
  (month, account) plus the summary rows (Total Rental Income, Total
  Income, NOI, Total Debt Service, Total Capital Improvements, Net
  Income).
- `openpyxl`-equivalent (Node `xlsx`/`exceljs` library) on the rent-roll
  spreadsheet, computing occupancy % from the `Status` column. Only `C`
  (current/occupied) and blank (vacant) have been observed in the one
  sample pulled during design; ResMan rent rolls commonly include other
  codes (e.g. notice-to-vacate, applicant/approved-not-moved-in). The
  adapter must enumerate the actual set of status values seen across all
  harvested months and classify explicitly (occupied vs. vacant vs.
  "other — flagged for review"), not assume a binary C/blank split.
- Cross-check: the PDF's own Vacancy Loss / Gain-Loss-to-Lease lines
  should be consistent in sign/direction with the rent-roll-derived
  figures for the same month; log (not fail on) discrepancies.

**Legacy adapter** (mostly deterministic, one LLM-assisted step):
- Regex/text extraction from pages 2–3 for: occupancy %, pre-leased %,
  evictions in process, renewals, stated NRI/revenue/NOI for the month,
  static deal facts.
- Page 4 (the flattened P&L image): rendered to a PNG (e.g. via
  `pdftoppm`/`pdf-to-img`) and sent to the configured vision LLM (see
  §5.3) with a prompt requesting the full line-item table as structured
  JSON matching the same schema McNeil's adapter produces (shared output
  shape across both deals simplifies stage 3).
- Validation: the vision-extracted NOI and total revenue for the month
  must match the plain-text-stated NOI/revenue from page 3 (extracted
  deterministically) within a small tolerance. Mismatch → the month's
  detailed-P&L fields are marked `"confidence": "low"` in the JSON and
  surfaced in the dashboard (not silently trusted, not blocking the run).

Both adapters write into the same canonical monthly-record shape:
```json
{
  "month": "2026-05",
  "occupancy_pct": 74,
  "income": { "rental": 18448.91, "other": -1612.28, "total": 16836.63 },
  "expense": { "<category>": <amount>, ... , "total": 14309.59 },
  "noi": 2527.04,
  "debt_service": 6532.50,
  "capital_improvements": 2967.26,
  "net_income": -9347.72,
  "narrative": "We ended May with occupancy at 74%. ...",
  "source_file": "data/raw/legacy/2026-05/....pdf",
  "extraction": { "method": "deterministic|vision_llm", "confidence": "high|low" }
}
```
Records are merged into `data/legacy.json` / `data/mcneil.json` keyed by
`month`, so re-running the pipeline after a new report arrives only adds
new months (or, where an overlapping trailing window gives a second look
at a prior month, overwrites with a note of which report last confirmed
that month's figures) — it never duplicates.

### 5.3 Vision LLM configuration (Legacy's page-4 table only)

Required by exactly one extraction step, and only for Legacy. Configured
via `config.json` (gitignored; `config.example.json` committed as a
template):
```json
{
  "vision_llm": {
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-...",
    "model": "gpt-4o"
  }
}
```
- Calls use the OpenAI-compatible chat-completions schema with an
  `image_url` content block — implemented by OpenAI, DeepSeek, and most
  other hosted/local providers, so switching provider is edit-three-fields,
  not a code change.
- The tool must clearly error (not silently misbehave) if the configured
  model rejects image input — i.e. detect a non-vision-capable model from
  the API's own error response and surface "this model doesn't support
  image input" rather than treating a garbled response as data.
- If `config.json` is absent or `vision_llm` is unset, the pipeline still
  runs: Legacy's page-4 fields are written as `null` with
  `"extraction": {"method": "unavailable"}`, and the dashboard visibly
  flags those months as "detailed P&L not extracted" rather than showing
  blank/misleading zeros.

### 5.4 Stage 3 — Build dashboard data
`build-dashboard.mjs` reads `legacy.json`, `mcneil.json`,
`projections.json`, computes any cross-deal rollups (portfolio totals,
side-by-side comparison arrays), and writes `dashboard/data.js` as plain
JS `const` declarations. The dashboard HTML/JS itself is never
regenerated by this step — only the data file — so manual dashboard
tweaks survive re-runs.

### 5.5 `refresh.mjs`
The single command Larry (or the other coding session, or Larry running
it monthly) runs: harvest → extract (both adapters) → build. Prints a
plain-English summary of what changed (new months found per deal, any
low-confidence flags, any cross-check mismatches).

## 6. Dashboard

Static site (`dashboard/index.html`), opened directly via `file://` — no
server, no network calls, works offline. Vanilla HTML/CSS/JS plus one
vendored charting library (no CDN dependency). Chart/visualization design
follows the project's `dataviz` skill conventions (accessible palettes,
consistent forms, light/dark aware) and general UI polish follows
`frontend-design` conventions.

### 6.1 Portfolio view
Capital invested/distributed per deal, blended net-income trend,
occupancy comparison, a plain "healthy vs. struggling" side-by-side.

### 6.2 Per-property deep dive (both Legacy and McNeil get all seven views;
some McNeil views will simply be less dramatic given it's performing)
1. **Monthly P&L ledger** — full line-item table, month over month,
   sourced from the canonical JSON; low-confidence cells visibly flagged.
2. **Revenue → NOI → Net Income waterfall** — per month or selected
   range, showing how debt service and capex consume NOI.
3. **Occupancy ↔ rental income overlay** — occupancy % line against
   rental-income bars, same time axis; McNeil additionally overlays
   vacancy-loss/loss-to-lease from the rent roll.
4. **Break-even occupancy analysis** — using the fixed-cost structure
   (debt service is fixed; most expense categories are largely
   occupancy-insensitive) to compute the occupancy % at which NOI and,
   separately, net income cross zero, plotted against actual occupancy
   over time.
5. **Actual vs. projection** — occupancy, rent, NOI, distributions vs.
   offering-doc figures (and clearly-labeled derived monthly targets
   where the source docs only give annual/stabilized figures).
6. **Expense breakdown** — category-level spend over time (stacked
   area/bar), flagging categories trending against the underwriting.
7. **Investor cash flow** — Larry's own $50,000 stake: distributions
   received to date, running cash-on-cash, vs. what was projected for
   the equivalent holding period.

## 7. Assumptions to verify during implementation

- McNeil's offering/underwriting documents exist under its own Documents
  filter and contain comparable projection detail to Legacy's — not yet
  opened; confirm early since §6.2.5 depends on it for both deals.
- The two adapters' report formats are stable going forward. If a
  sponsor changes their template, the relevant adapter breaks loudly
  (per §5.1's fail-loud requirement) rather than producing wrong numbers.
- `pdftotext` (poppler) is available on the machine that runs extraction
  (confirmed present on this Mac via Homebrew); the implementation should
  either depend on it explicitly (documented prerequisite) or use a
  pure-JS equivalent — decide during planning.
- The Chrome remote-debugging approach (used successfully during this
  design session to explore the portal) is the intended harvest
  mechanism; if the coding agent implementing this lacks equivalent
  browser-automation tooling in its environment, harvesting will need to
  happen in a session that does (e.g. this one), with raw files handed
  off — the extract/build stages have no such dependency and can run
  anywhere.

## 8. Out of scope for v1 (candidate future work, not to be built now)

- Automated/scheduled refresh (e.g. cron) — v1 is manually triggered.
- Any write actions back to the portal.
- Support for additional properties beyond Legacy and McNeil.
- A generic PDF-table parser usable across arbitrary sponsor formats.
