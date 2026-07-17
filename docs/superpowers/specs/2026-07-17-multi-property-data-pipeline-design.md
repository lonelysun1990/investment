# Multi-Property Data Pipeline & Compliance Rewrite — Design Spec

Date: 2026-07-17
Status: Approved
Parent: 2026-07-14-cashflow-and-proportional-ownership-design.md

## 1. Problem

The data layer behind the dashboard has three separate problems, all upstream of
the dashboard bugs Larry is seeing:

- **Raw archive is unstructured and duplicated.** `data/raw/mcneil/` has six
  near-identical folders (2025-05, 08, 09, 10, 11, 12) containing byte-identical
  files (confirmed via content hash) — the same underlying report batches were
  harvested repeatedly under mismatched folder names. There is no reliable way
  to tell, from the folder name, what period a document actually covers.
- **Occupancy, capital raise, and distributions are wrong or missing**, and the
  root causes are all extraction-logic bugs, not missing source data:
  - Occupancy is `null` for every month except the single most-recently-processed
    one in each deal, because the extractor only ever attaches occupancy to the
    month it happens to be "currently" processing, nulling it out for every
    other month a batch's report covers.
  - `data/capital.json` has no `totalRaise` field at all — it was never captured.
  - The dashboard's "total property" distribution figure is back-calculated
    (`myDistribution / ownershipPct`) instead of read from the source document,
    which is why it doesn't match the property's own cash-flow statement.
- **A prior compliance violation tainted some already-committed data.** A
  separate tool (OpenCode, not this Claude Code pipeline) extracted the
  `__access_token` session cookie and replayed it as a `Bearer` header against
  `api.cashflowportal.com`'s internal REST/GraphQL endpoints directly —
  flagged by CashFlowPortal's engineering team as a violation of acceptable use
  (full record and hard rule now in `CLAUDE.md`). This produced the `ownershipPct`
  values in `capital.json` and all 7 McNeil entries in `distributions.json`.
  Separately (and independently of the compliance issue), the same tool also
  added `data/mcneil.json` entries for 2024-09 through 2025-12 via an ad hoc,
  untested script (`extract-mcneil-2025.mjs`) reading from a `/tmp` file that
  no longer exists — unreproducible, with no real source document on file.

None of this is McNeil- or Legacy-specific — every fix here needs to generalize
to whatever properties get added to the portal in the future.

## 2. Goals

1. A generic raw-archive layout, organized by report vintage (not harvest
   date), deduplicated by content, that any current or future deal fits into
   without pipeline code changes.
2. Occupancy populated for every month any batch actually reports it for.
3. Total capital raise captured once per deal from its offering document and
   stored durably in `data/capital.json`.
4. Distributions store two independently-sourced numbers per period —
   "my distribution" and "total distribution" — cross-checked against each
   other rather than one being derived from the other.
5. All portal interaction is strictly DOM/click-driven, per `CLAUDE.md` — this
   spec's implementation must never call `api.cashflowportal.com` directly,
   and must re-derive (not merely re-verify) every value that was previously
   sourced that way.
6. Onboarding a new property is a config addition, not a pipeline change.

## 3. Non-goals

- Dashboard visualization changes (real waterfall chart, distribution-chart
  placement, ledger/chart column alignment, synced scrolling) — a separate
  design/plan cycle, sequenced after this one lands.
- Rewriting P&L parsing logic that already works correctly (McNeil's
  deterministic text-table parser, Legacy's vision-LLM table parser) — those
  are reused, just invoked and merged generically instead of per-deal-hardcoded.

## 4. Design

### 4.1 Raw archive layout

```
data/raw/<dealSlug>/<batch-YYYY-MM>/<doc-type>.<ext>
data/raw/<dealSlug>/<batch-YYYY-MM>/manifest.json
```

`<batch-YYYY-MM>` is the report's own printed/as-of date, parsed from the
document's content (e.g. "Printed 1/20/2025", a rent roll's as-of date, or a
report's stated period end) — not the date it happened to be harvested. If a
batch's date can't be determined from content, it falls back to harvest date
and `manifest.json` records `batchDateSource: "harvest-fallback"` so it's
flagged for review rather than silently misfiled.

Before a file is written into a batch folder, its content hash is checked
against every hash already recorded in that deal's manifests; exact duplicates
are recognized and not re-filed. This alone resolves the six-folder McNeil
duplication.

`manifest.json` per batch records, per file: `docType`, `contentHash`,
`sourceEmailSubject` (or equivalent), `harvestedAt`, `batchDateSource`.

### 4.2 Per-deal config

`scripts/deals/<dealSlug>.mjs`, replacing logic currently hardcoded across
`extract-mcneil.mjs`/`extract-legacy.mjs`, exports:

- `classifyDoc(filename, text)` → normalized doc-type (`cashflow-t12`,
  `balance-sheet`, `rentroll`, `offering-doc`, etc.)
- a parser reference per doc-type (reusing the existing deterministic
  text-table parser for McNeil-style reports, the existing vision-LLM parser
  for Legacy-style embedded-image reports)
- the exact label/regex for that deal's distribution line item (e.g. McNeil's
  cash-flow statement says "Member's Distribution" — confirmed present with
  real monthly dollar values; other properties may say "Partner Distribution"
  or similar)
- occupancy source preference (rent-roll snapshot vs. narrative text)

Onboarding a new deal means writing one of these configs (and, only if its
report format is genuinely novel, one new small parser) — never touching
`harvest.mjs`, the archive layout, or the merge engine.

### 4.3 Generic merge engine

A single shared function folds each deal's batches, oldest to newest, into its
record store — replacing the duplicated `mergeRecord`-based logic in each
extractor. Per field: the newest batch's value wins **unless** it's null,
undefined, or all-zero/placeholder, in which case the older batch's value is
kept. This applies uniformly to P&L fields and to occupancy.

### 4.4 Occupancy completeness

Every batch's rent-roll snapshot or narrative text contributes occupancy for
whichever month(s) it actually covers. The merge engine (4.3) fills gaps
opportunistically across all of a deal's batches, rather than the current
behavior of only ever attaching occupancy to the one month a batch happens to
be "about."

### 4.5 Capital raise

Captured once per deal (it's static): locate and download the offering/
subscription document via real navigation and a real click on its rendered
link (never a direct request), then run a deterministic `pdftotext`-based
parser — per-deal config supplies the label regex, since exact wording varies
— into `capital.json.totalRaise`. Cross-checked against a DOM read of the
"Returns"/ownership figure shown on the deal overview page; if the two sources
disagree beyond a small tolerance, set a confidence flag (reusing the existing
`distributionMismatch`-style pattern) instead of silently picking one.

### 4.6 Distributions

Two independently-sourced numbers per period, neither derived from the other:

- **myDistribution**: DOM-read from the deal page's distribution panel,
  clicking "View all"/expand controls to capture every row, not just the
  default-visible ones.
- **totalDistribution**: deterministic extraction of the property's own
  distribution line item from its cash-flow statement, per the 4.2 config.

A cross-check flag fires if `myDistribution` isn't approximately
`totalDistribution × ownershipPct`, surfaced in the data rather than hidden.

### 4.7 Compliance rewrite (mandatory, not optional cleanup)

- Add an audit check (e.g. `scripts/audit-no-api-calls.mjs`) that greps
  `scripts/` for `api.cashflowportal.com`, `__access_token`, and
  `page.request.` calls targeting that domain, and fails loudly if any are
  found; wired into `npm test` or documented as a required manual step.
- Re-derive — not merely spot-check — `capital.json`'s `ownershipPct`, all 7
  entries in `distributions.json`, and `mcneil.json`'s 2024-09 through 2025-12
  months, entirely through the new compliant pipeline, replacing what's
  currently committed regardless of whether the numbers happen to already
  match.
- Delete `extract-mcneil-2025.mjs` once its months are re-derived through the
  real, tested pipeline — it has no test coverage, reads from a `/tmp` path
  that no longer exists, and isn't wired into `npm run refresh`.
- Harden attachment downloads: replace `page.request.get(href)` in
  `harvest.mjs` with a real simulated click + captured browser download event,
  closing the narrow ambiguity of issuing a raw request even against a
  legitimately-rendered link.

### 4.8 Testing

Every parser and per-deal config gets a `*.test.mjs`, with fixtures under
`scripts/__fixtures__/`, following this repo's existing convention. This is
precisely what `extract-mcneil-2025.mjs` skipped, and how its parsing bugs
(later patched in two follow-up commits) went uncaught.

## 5. Implementation order

1. Archive layout + content-hash dedup + manifest format; re-file existing raw
   docs and re-harvest to fill gaps.
2. Per-deal config for McNeil and Legacy + generic merge engine, wired into a
   shared generic extraction runner (replacing the per-deal `runXExtraction`
   duplication).
3. Occupancy completeness (falls out of step 2's merge engine).
4. Capital raise capture (offering-doc PDF + DOM cross-check).
5. Distribution capture (cash-flow-statement line item + DOM "View all"),
   replacing today's back-calculated total-property figure.
6. Compliance rewrite: audit script, re-derivation of tainted `capital.json`/
   `distributions.json`/`mcneil.json` (2024-2025) data, deletion of
   `extract-mcneil-2025.mjs`, attachment-download hardening.
7. Remove now-superseded per-deal-hardcoded pieces once the generic path
   covers the same ground; keep `npm test` green throughout.

## 6. Edge cases

- A batch's report date can't be determined from content → fall back to
  harvest date, flagged in the manifest for review, never silently misfiled.
- Two batches disagree on a month beyond noise → newest wins unless the
  newest value is blank/placeholder, per the rule above.
- A capital-raise or distribution source document is a scanned image with no
  extractable text → same vision-LLM fallback Legacy's P&L table already
  uses, or manual entry tagged `"method": "manual"` — never a fabricated
  number.
- Portal UI changes (e.g. a "View all" control gets renamed or moved) →
  scraping throws a clear error rather than silently returning stale or empty
  data, consistent with `extract-legacy.mjs`'s existing error-throwing
  convention.
- Legacy's cash-flow statement doesn't currently itemize a distribution line
  (only one quarter has ever been manually recorded) → `totalDistribution`
  stays `null` with an explicit "not yet available" state, not `0`, until
  Legacy's own reports start itemizing it.
