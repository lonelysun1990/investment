# McNeil Pipeline Bundle Fix — Design

**Evidence base:** every requirement below traces to a section of
`docs/superpowers/research/2026-07-20-mcneil-pdf-bundle-findings.md` (referenced
as "findings §N"). That document is the source of truth for what was actually found
in the real PDFs; this spec is the source of truth for what we're building in
response.

## Goals

1. Make the raw PDF archive durable across worktrees, so migration/reorganization
   work never again gets stranded in a gitignored worktree copy (findings §1).
2. Correctly classify and extract McNeil's multi-report bundled PDFs, recovering the
   2025 P&L data and rent-roll occupancy snapshots that are currently silently
   discarded (findings §2).
3. Replace the McNeil total capital raise figure with one backed by a real extractor
   against the Investment Deck, rather than the PPM's self-described estimate
   (findings §3).
4. Let the existing "newest batch wins" merge rule naturally backfill the Oct–Dec
   2024 rental/other income breakdown once the Trailing P&L Detail data extracts
   correctly (findings §4) — no new merge logic required.

## Non-Goals

- Monthly occupancy for every calendar month. Only three rent-roll snapshots exist
  in documents gathered so far (9/30/2025, 12/31/2025, 6/30/2026) — findings §2. The
  chart will show 3 points, not 12. If full monthly coverage is wanted later, that's
  a separate investigation (does CashFlowPortal even send a monthly rent roll for
  every month?), not something this fix invents by interpolating.
- Extracting Aged Receivables Summary or Cash Flow Statement Detail data. These
  sections get correctly classified and archived (so they're never again mislabeled
  as balance-sheet) but no extractor consumes them — nothing in the dashboard uses
  this data today.
- Any change to Legacy's pipeline. Findings §5 confirms Legacy's monthly-update PDF
  has no bundling issue.

## 1. Archive durability: resolve to the main checkout, always

**Problem (findings §1):** `data/raw/` is gitignored (`.gitignore:3`) and
scripts have been resolving it relative to cwd. When harvest/migration ran inside
this worktree, the correctly-migrated archive only ever existed in the worktree's
local filesystem — the main checkout's `data/raw/` never changed.

**Fix:** add `resolveArchiveRoot()` to `scripts/lib/archive-store.mjs`:

```js
import { execSync } from "node:child_process";
import path from "node:path";

export function resolveArchiveRoot() {
  const gitCommonDir = execSync("git rev-parse --path-format=absolute --git-common-dir", {
    encoding: "utf8",
  }).trim();
  const mainRoot = path.dirname(gitCommonDir);
  return path.join(mainRoot, "data", "raw");
}
```

Every script that currently builds a `data/raw/...` path relative to `process.cwd()`
or `import.meta.url` (`harvest.mjs`, `migrate-raw-archive.mjs`, both extractors)
switches to `resolveArchiveRoot()`. Effect: running any of these scripts from this
worktree, from main, or from any future worktree all resolve to the exact same
physical directory — the main checkout's `data/raw/`. This is the same
`git rev-parse --git-common-dir` → parent-directory technique the
`finishing-a-development-branch` skill already uses for `MAIN_ROOT`, so it's
consistent with an existing convention rather than a new one.

**Wipe-then-rebuild:** before this fix is exercised for real, the main checkout's
existing `data/raw/` (the stale pre-migration structure — `legacy/2026-05/`,
`mcneil/2025-05/`, `mcneil/2025-08/`, etc., no manifests) is deleted entirely, then
rebuilt from scratch by re-running the (now bundle-aware) migration against this
worktree's already-correct archive contents, followed by a live harvest run to
pick up anything newer. This is safe: `data/raw/` is gitignored, so nothing tracked
in git is affected, and everything in it is reconstructable from CashFlowPortal or
from this worktree's existing copy.

## 2. Bundle-aware classification

**Problem (findings §2):** `classifyDoc()` inspects a file once and assigns one
docType to the whole file. Two real files
(`2025-10/balance-sheet.pdf`, `2026-01/balance-sheet.pdf`) are 13-page bundles
containing 5 distinct reports; only the first (Balance Sheet, pages 1-2) was ever
recognized, silently discarding pages 3-13.

**Fix:** `classifyDoc({filename, pages})` — `pages` is an array of per-page text
(from `pdftotext -layout -f <n> -l <n>`, called once per page) — returns an array of
sections:

```js
// Returns: [{docType, pageRange: [startPage, endPage]}, ...]
const SECTION_TITLES = [
  { docType: "balance-sheet", pattern: /^balance sheet/i },
  { docType: "trailing-pnl-detail", pattern: /trailing profit and loss detail/i },
  { docType: "cashflow-t12", pattern: /twelve month (profit and loss|cash flow)/i },
  { docType: "rentroll-pdf", pattern: /rent roll summary/i },
  { docType: "aged-receivables", pattern: /aged receivables summary/i },
  { docType: "cashflow-detail", pattern: /cash flow statement detail/i },
];
```

Walk `pages` in order; for each page, find the first `SECTION_TITLES` pattern that
matches the page's first non-blank line. If it matches the same `docType` as the
running section, extend the current `pageRange`; if it matches a different
`docType`, close the current section and open a new one; if no pattern matches,
close the current section (if any) and open an `"unclassified"` section, and log a
warning with the filename and page number — an unmatched page must never be
silently folded into a neighboring section, since that's the exact bug being fixed.

**Archive/manifest change:** `archiveFile()` still writes **one physical file**,
byte-identical to what was downloaded (preserves "leave a trace" literally — the
raw archive is not allowed to diverge from what CashFlowPortal actually sent). The
manifest schema changes from a single `docType` field per file entry to a
`sections` array:

```json
{
  "docType": "balance-sheet",
  "fileName": "balance-sheet.pdf",
  "contentHash": "...",
  "sections": [
    { "docType": "balance-sheet", "pageRange": [1, 2] },
    { "docType": "trailing-pnl-detail", "pageRange": [3, 9] },
    { "docType": "rentroll-pdf", "pageRange": [10, 11] },
    { "docType": "aged-receivables", "pageRange": [12, 12] },
    { "docType": "cashflow-detail", "pageRange": [13, 13] }
  ]
}
```

The top-level `docType` and `fileName` are kept for backward compatibility with any
code that still expects a single-classification manifest entry (`docType` is simply
`sections[0].docType`); everything doing real extraction goes through `sections`.

**Extraction orchestration:** `extractMcneilBatch` (in `scripts/extract-mcneil.mjs`)
changes from "look up the one file with docType X" to "look up all
`{file, pageRange}` pairs across all files in the batch whose `sections` contain
docType X," and for each, runs `pdftotext -layout -f <start> -l <end> <file>` to get
just that section's text before handing it to the relevant parser.

## 3. Parsers

**Trailing P&L Detail** (findings §2, §4): `extractMcneilPnl`'s title regex gains
`/trailing profit and loss detail/i` alongside the existing `/twelve month.../i`.
Before trusting this, a plan task verifies the real page-3 text from
`2025-10/balance-sheet.pdf` against `parseMonthHeader`'s two existing layout
variants — if neither matches, `parseMonthHeader` gets a third variant, not a
parallel one-off function.

**PDF-table Rent Roll** (findings §2): new `scripts/extract-mcneil-rentroll-pdf.mjs`.
Column layout differs from the existing XLSX parser
(`scripts/extract-mcneil-rentroll.mjs`): `Unit, Type, Sq. Feet, Residents, Status,
Market Rent, Rent, Other Charges, Credits, Total, Move In, Lease Start, Lease End,
Move Out, Surety Bonds, Deposits, Balance`, and vacant units are the literal string
`"Vacant Unit"` rather than a blank status cell. Occupancy is computed the same way
as the existing parser for chart consistency: `occupancyPct =
round(occupiedUnits/totalUnits*1000)/10`, `status === "C"` → occupied. This is a new
file, not a modification of the XLSX parser — both formats occur and neither
replaces the other.

**Investment Deck capital-raise extractor** (findings §3): new
`scripts/extract-mcneil-investmentdeck.mjs`, parsing the ACQUSITION SUMMARY table
for the line `Total Member Capital Needed to Close  $<amount>`. `investment-deck`
becomes a new doc type in `scripts/deals/mcneil.config.mjs`, harvested via the same
compliant click-and-download flow `harvest.mjs` already uses for other documents
(McNeil Documents tab, row "Investment Deck (PDF)"). Output feeds `data/capital.json`
McNeil's `totalRaise` and `totalRaiseSource`, replacing the PPM-derived $1,500,000.
The existing mismatch-flagging mechanism stays in place to surface the remaining gap
against the ~2.59% actually observed in real distributions — this fix corrects the
stated-raise number, it does not claim to resolve why real distributions imply a
different ownership share.

## 4. Data reconciliation

Once classification and parsers are fixed, re-run the full pipeline
(`npm run refresh` or equivalent) against the rebuilt archive. Expected outcome,
checked against findings §2/§4:
- `data/mcneil.json` gains 2025-01 through 2025-12 (from the two Trailing P&L Detail
  sections, which overlap Jan-Sep 2025 for cross-checking).
- 2024-10, 2024-11, 2024-12 gain proper `income.rental` / `income.other` breakdown
  (previously $0.00 placeholders from the aggregate-only FY2024 T12 report), because
  "newest batch wins" prefers the 2025-10-batch Trailing P&L Detail data over the
  older aggregate report for those months. 2024-09 is not covered by either bundle
  (both start at Oct 2024) and stays on the old aggregate-only source — this is
  expected, not a bug to chase further.
- Occupancy chart gains two more data points (9/30/2025, 12/31/2025) alongside the
  existing 6/30/2026 point — three total, matching the Non-Goals note above.
- `data/capital.json` McNeil `totalRaise` becomes 1,300,000 (or whatever the
  extractor actually reads off the real deck table — the number is not hand-typed
  into the spec or the JSON, the extractor's output is authoritative).

## Testing strategy

All fixtures are real, not synthetic: the actual `2025-10/balance-sheet.pdf` and
`2026-01/balance-sheet.pdf` (or `pdftotext`-dumped per-page text from them, committed
as test fixtures) drive the classification and Trailing-P&L/rent-roll parser tests;
the Investment Deck's real ACQUSITION SUMMARY table text drives the capital-raise
extractor test. This matches the session's explicit instruction not to "blindly
trust the code you wrote" — tests assert against numbers already hand-verified in
the findings doc (e.g., the Sep 2025 Trailing P&L Detail bundle's page range is
[3,9]; the deck's capital figure is $1,300,000), not against values the new code
itself produces.

## Error handling

- Unclassified pages inside a bundle: logged as a warning with filename + page
  number, archived under `docType: "unclassified"` in the manifest — visible for
  manual follow-up, never silently dropped or absorbed into a neighbor.
- `resolveArchiveRoot()` failing (e.g. run outside a git repo, or `git` not on PATH):
  throws immediately rather than falling back to a cwd-relative path — a silent
  fallback here is exactly how the original bug happened.
- Parser mismatches (e.g. Trailing P&L Detail header doesn't match either existing
  `parseMonthHeader` variant): the extraction task fails loudly with the raw header
  text in the error, rather than skipping the section silently.
