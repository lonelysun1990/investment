# McNeil PDF Bundle & Capital-Raise Findings

**Purpose:** Ground-truth evidence gathered by manually reading the raw CashFlowPortal
PDFs (per user instruction: discover manually first, write pipeline code second).
This document is the source of truth for the upcoming brainstorm/spec/plan — every
requirement in the spec and every test fixture in the plan should trace back to a
fact recorded here, not to a paraphrase of it. Update this file (not just the spec)
if further manual investigation turns up something new.

## 1. Raw archive was never synced to the real checkout

- The main checkout's `data/raw/` (gitignored) still has the pre-migration structure:
  `legacy/2026-05/`, `mcneil/2025-05/`, `mcneil/2025-08/`, `mcneil/2025-09/`,
  `mcneil/2025-10/`, `mcneil/2025-11/`, `mcneil/2025-12/`, `mcneil/2026-06/` — no
  `manifest.json` files, no batch-vintage layout.
- The correct migrated archive only ever existed inside this worktree's local
  filesystem: `.claude/worktrees/multi-property-data-pipeline/data/raw/{legacy,mcneil}/<batch-YYYY-MM>/*.pdf` +
  `manifest.json` + `_seen.json`.
- Root cause: `data/raw/` is gitignored, so no PR ever carried the migrated archive
  back to the main checkout. Nothing about the pipeline code is wrong here — this is
  a pure process gap. **Any fix must not rely on gitignoring the raw archive**, or it
  will silently rot again the same way.

## 2. McNeil sponsor bundles multiple reports into one PDF

Confirmed via `pdfinfo` + `pdftotext -f <n> -l <n>` page-by-page dumps, in the
worktree's `data/raw/mcneil/`:

### `2025-10/balance-sheet.pdf` — 13 pages, real filename as harvested
| Pages | Content |
|---|---|
| 1–2 | Balance Sheet, September 2025 |
| 3–9 | **Trailing Profit And Loss Detail**, September 2025, printed 10/2/2025 11:18:31 PM. Columns: `Oct 2024 \| Nov 2024 \| Dec 2024 \| Jan 2025 \| Feb 2025 \| Mar 2025 \| Apr 2025 \| May 2025 \| Jun 2025 \| Jul 2025 \| Aug 2025 \| Sep 2025 \| Adjusted \| Total \| Variance`. Itemized rows: Gross Potential Rent, Loss to Old Lease, Bad Debt, Vacancy Loss, Rent Concessions, etc. |
| 10–11 | **Rent Roll Summary**, as of 9/30/2025. Per-unit rows (sample: units 101–106). Columns: `Unit, Type, Sq. Feet, Residents, Status, Market Rent, Rent, Other Charges, Credits, Total, Move In, Lease Start, Lease End, Move Out, Surety Bonds, Deposits, Balance`. Status values seen: `Vacant Unit`, `C` (current/occupied). |
| 12 | Aged Receivables Summary, 9/30/2025 |
| 13 | Cash Flow Statement Detail, September 2025 |

### `2026-01/balance-sheet.pdf` — 13 pages, same bundle pattern
| Pages | Content |
|---|---|
| 1–2 | Balance Sheet, December 2025 |
| 3–9 | **Trailing Profit And Loss Detail**, December 2025, printed 1/19/2026 10:36:32 AM. Columns: `Jan 2025 \| Feb 2025 \| Mar 2025 \| Apr 2025 \| May 2025 \| Jun 2025 \| Jul 2025 \| Aug 2025 \| Sep 2025 \| Oct 2025 \| Nov 2025 \| Dec 2025 \| Adjusted \| Total \| Variance`. |
| 10–11 | **Rent Roll Summary**, as of 12/31/2025. Same column layout as above. |
| 12 | Aged Receivables Summary, 12/31/2025 |
| 13 | Cash Flow Statement Detail, December 2025 |

These two bundles together cover the entire Jan 2025–Dec 2025 gap (overlapping on
Jan–Sep 2025, which is useful for cross-checking one extractor against the other).

### Files confirmed NOT bundled (single-report, already handled correctly)
- `2025-01/balance-sheet.pdf` — 1 page, standalone, December 2024 balance sheet.
- `2025-01/cashflow-t12.pdf` — 3 pages, "Twelve Month Profit and Loss, January 2024 - December 2024", already extracted correctly.
- `2026-06/cashflow-t12.pdf` — 6 pages, "Twelve Month Cash Flow Statement Expanded Detail, June 2026", already extracted correctly.

### Root cause of the bug
`scripts/deals/mcneil.config.mjs`'s `classifyDoc()` reads only enough of the file to
find a title match (`/balance sheet/i` etc.) and assigns ONE docType to the WHOLE
file. For these two files, page 1 says "Balance Sheet", so the entire 13-page file
was filed as `balance-sheet` and pages 3–13 (P&L + occupancy + receivables + cash
flow) were never looked at by any extractor. **This is the direct, verified answer to
the user's question "what caused the occupancy issue, is it a data-source problem":**
it is not a missing-source problem — the source data exists and is downloaded — it's
a per-file (not per-section) classification bug.

### Implication for occupancy chart
Real rent-roll occupancy snapshots exist for: 9/30/2025, 12/31/2025 (both newly
found, buried in the bundles above), and 6/30/2026 (already extracted from a
non-bundled file elsewhere in the pipeline — the one point currently on the chart).
**There is no rent roll for every single month** — only these three dates have one in
the documents gathered so far. A correct fix produces 3 occupancy points, not 12; if
the user wants monthly occupancy, that requires either a different report that isn't
currently in the harvested set, or accepting sparse/interpolated points — flag this
back to the user during brainstorming rather than assuming full monthly coverage is
achievable from documents in hand.

## 3. Total capital raise: three conflicting figures, none yet fully authoritative

| Figure | Source document | Status |
|---|---|---|
| $1,500,000 | PPM, "Sources of Funds" table, equity line | Document itself calls this an estimate "subject to material change" |
| **$1,300,000** | Investment Deck (`Documents` tab, row "Investment Deck (PDF)"), "ACQUSITION SUMMARY" table, row "Total Member Capital Needed to Close" | Self-consistent with the SAME deck's own stated ownership %: deck states "% of Overall Membership Ownership for $ Invested: 3.8%" for a $50,000 investment; $50,000 / $1,300,000 = 3.846% ≈ 3.8% — internal agreement within one document |
| ~$1,928,571 | Implied by reconciling the real (DOM-scraped) 2026-Q2 distribution: $648.14 of $24,999.86 total ≈ 2.593% ownership, back-solved against $50,000 | This is the actual observed cash distribution ratio, but derived, not stated in any document |

Current best evidence points to **$1,300,000** as the figure to use in
`data/capital.json`, because it's the only figure that is both (a) stated directly in
a document and (b) internally corroborated by a second, independent number in that
same document (the 3.8% ownership figure). It still does not match the ~2.59%
actually observed in real distributions — that discrepancy should be preserved and
surfaced in the dashboard (the existing `capitalRaiseMismatch`-style flagging
mechanism), not silently resolved by picking a number and hiding the tension.

Source file for re-verification: `/tmp/cfp-investment-deck/mcneil-investment-deck.pdf`
(35 pages, downloaded via compliant click+download from McNeil's Documents tab,
dealId `f8929e29-285b-4904-b4e9-5b41b035535b`; row index 4, "Investment Deck (PDF)").
Text dump at `/tmp/investment-deck.txt` (regenerate with `pdftotext -layout` if
these temp files are gone — they are not committed anywhere).

## 4. 2024 monthly data — user's "all zero" claim only partially matches current state

Current `data/mcneil.json` (main checkout) has 2024-09 through 2024-12 present, with
non-zero `netIncome` and `income.total` (e.g. 2024-09 netIncome $3,616.44, income.total
$6,646.25) — **not literally all-zero**. The FY2024 T12 report
(`2024-annual-cashflow-statement.pdf`) is NOT aggregate-only for income: it contains
`Total Net Rental Income` / `Total Other Rental Income` rows, so the
`income.rental` / `income.other` breakdown IS populated for these months from this
report alone (e.g. 2024-09 `income.rental` $6,646.25) — no need to wait on another
source for the income split. What IS aggregate-only in this report is the *expense*
side: it reports only a single `TOTAL EXPENSE` figure with no lower-level operating
category breakdown that sums to it, and rolls debt service + capital improvements
into one `TOTAL NON-OPERATING EXPENSE` line instead of reporting them separately —
this is what `expenseIsAggregateOnly` flags.

Separately, this report's `pdftotext -layout` rendering has a column-layout quirk
unrelated to the aggregate-only expense structure above: two itemized expense-category
rows (`Total Advertising and marketing`, `Total Building Improvements`) glue their
leading "0.00" value directly onto the label with zero or one separating space,
because the layout leaves no room for a real 2+-space gap before a short zero-valued
first column. Before the account-code fix in `splitRow` (Task 1 of this branch), this
quirk was masked — the same rows were skipped for the unrelated reason that their
leading account-code prefix (e.g. `5099.001`) was mistaken for a money value. After
that fix, `splitRow` correctly skips past the account code but then absorbed the glued
"0.00" into the label, corrupting 2024-09's itemized expense breakdown with garbage
keys (`"Advertising and marketing0.00"`, `"Building Improvements 0.00"`) while leaving
`expense.total` correct (it comes from the separate aggregate `TOTAL EXPENSE` line,
unaffected). Fixed by having `splitRow` return `null` for any row whose label itself
ends in a money-shaped token, rather than guess at the split.

The newly-discovered Trailing P&L Detail bundle (`2025-10/balance-sheet.pdf`, pages
3–9) covers Oct–Dec 2024 too, WITH itemized rows (Gross Potential Rent, etc.) —
extracting from this bundle could still be useful for cross-verification, but is not
required to fill an income-split gap for Oct–Dec 2024 since the T12 report already
supplies it. Sep 2024 is not covered by any bundle found so far (both bundles start at
Oct 2024) — flag this gap explicitly rather than assuming it's fixed.

## 5. Legacy — confirmed NOT affected

`data/raw/legacy/2026-05/monthly-update.pdf` is 7 pages (not 4, as previously
assumed): title, property info, Operations Overview narrative (occupancy narrative
source, already extracted), embedded P&L table image (page 4, already handled via
vision-LLM extraction), Renovation/Capital Items narrative, Dallas Market Update,
National Market Update. Pages 5–7 confirmed to contain no additional financial
tables. No bundling bug for Legacy — this is a McNeil-sponsor-specific behavior.

## 6. Open questions to carry into brainstorming (not yet resolved)

- Should `classifyDoc` move from "one docType per file" to "per-page/per-section
  classification within a file," or should harvesting split multi-report PDFs into
  per-section sub-documents at download time (so the raw archive itself stores one
  report per file)? Both fix the bug; they trade off differently against "raw PDFs
  should look like what CashFlowPortal actually sent" (mentioned as a value by the
  user re: keeping a trace).
- Rent Roll Summary pages are PDF text tables, not XLSX — the existing
  `extractRentRoll` (in `scripts/extract-mcneil-rentroll.mjs`) only parses XLSX. A new
  parser is needed for this PDF table format; it should NOT replace the existing XLSX
  path, both formats occur.
- Whether the Trailing P&L Detail header format matches either of
  `parseMonthHeader`'s two existing layout variants in `scripts/extract-mcneil.mjs`,
  or needs a third — not yet checked line-by-line against those functions.
- Final decision on $1,300,000 vs. keeping the mismatch-flagging approach — worth
  confirming with the user during brainstorming rather than deciding unilaterally.

## 7. harvest.mjs never classifies or archives (discovered while writing the plan)

`harvestDeal()` (in `scripts/harvest.mjs`) downloads email attachments straight into
`data/raw/<deal>/<month>/<sanitized-original-name>` — no `classifyDoc()` call, no
`archiveFile()` call, no `manifest.json` written. `archiveFile` is only ever called
from `migrate-raw-archive.mjs` (grep-confirmed across `scripts/`).

`refresh.mjs` (the `npm run refresh` entrypoint) calls `harvestDeal()` and then
immediately calls `runMcneilExtraction("data/raw/mcneil", ...)` on the *same*
directory, with no migration step in between. `extractMcneilBatch` requires a
`manifest.json` per batch folder (via `loadManifest`, which returns `{files: []}`
when one is missing) — so any month `harvestDeal()` downloads via a normal
`npm run refresh` is invisible to extraction until someone manually re-runs
`migrate-raw-archive.mjs`.

**Implication:** the batch-vintage, manifest-based archive currently in this
worktree was produced by a one-off manual `migrate-raw-archive.mjs` run (Task
11/12 of this session), not by the live pipeline. This is a second, independent
mechanism (besides the worktree/main-checkout desync in §1) by which `data/raw/`
can end up inconsistent — live harvesting and manual migration both write into the
same `data/raw/<deal>/` tree using different folder-keying and file-naming schemes.

**Decision (confirmed with user):** fold classification+archiving directly into
`harvestDeal()` — it calls the new bundle-aware `classifyDoc()` and `archiveFile()`
itself at download time, using the same content-derived `resolveBatchDate()` batch
key that `migrate-raw-archive.mjs` already uses (not the cruder email-subject-month
key `harvestDeal()` currently uses for its folder name). `migrate-raw-archive.mjs`
becomes a one-time historical-backfill tool only, not part of the live refresh path.
