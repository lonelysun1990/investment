# McNeil Occupancy Enrichment & Legacy Harvest Bug Fix — Design

## Evidence

Both problems were manually verified live against the real CashFlowPortal earlier this session, per the user's explicit "find it first, verify it, do it ad-hoc a few times before coming up with a plan" instruction.

**Legacy**: 9 total emails (confirmed live, one page, no pagination). 7 are real monthly updates (`parseEmailSubjectMonth` already correctly excludes the other 2 — a K-1 notice and a closing notice). `_seen.json` shows all 7 were visited, but 6 came back with `files: []`. Clicked into Nov 2025's email live: a real `<a href=".../Nov 2025 Update.pdf">` link is present in the DOM. A plain, unscoped `document.querySelectorAll('a')` filtered by `.pdf`/`.xlsx` href pattern found it immediately.

**McNeil**: ~19 real monthly emails span Oct 2024 → June 2026. Checked three (June 2026, Oct 2025, Oct 2024) and found three distinct occupancy sources depending on era:
1. Oct 2024's email: plain text `"Occupancy: 90.6% (Sep) vs. 87.5% (Oct)"`.
2. Later emails' "Operations" narrative: `"We currently have 3 vacant units: 103, 114, 203."` — computable against the known 32-unit total (Investment Deck, "# Units: 32").
3. Every checked email also has an embedded chart (confirmed via DOM/iframe inspection — a real PNG at `https://sc.cashflowportal.com/deal_updates/...`, not SVG/vector) showing ~12-13 trailing months of "Monthly Revenue + Occupancy %".

## Part A: Legacy harvest bug fix

**Root cause** (`scripts/harvest.mjs`, `harvestDeal`'s `attachmentLinks` block): the current logic filters for `position: fixed|absolute` elements sized `>350x250`, then picks the one with the *smallest* `innerText.length` — intended to skip past outer wrapper elements to the real content panel. For Legacy's "View email" modal, this heuristic sometimes picks an empty backdrop/mask element instead (text length 0, which always sorts first), returning zero links even though the real attachment link exists elsewhere on the page.

**Fix**: drop the overlay-scoping heuristic entirely. Search the whole page directly:

```js
const attachmentLinks = await page.evaluate(() => {
  return Array.from(document.querySelectorAll("a"))
    .map((a) => ({ name: a.innerText.trim(), href: a.href }))
    .filter((a) => a.href && /\.(pdf|xlsx)(\?|$)/i.test(a.href));
});
```

This matches the simpler pattern `harvestStaticDocument` (added in the prior PR) already uses successfully with no overlay-scoping at all. The Documents-tab table itself uses `<button>` elements for downloads, not `<a href>` links pointing at files, so an unscoped search doesn't risk picking up unrelated links elsewhere on the page — confirmed by inspection during this session's manual investigation.

**Retry**: `harvestDeal` only marks a month `seen` when `hadFailure` is false (existing logic, unchanged). Legacy's 6 empty months currently have `files: []` from what was actually a *false* success (no attachment links found, so the loop found nothing to fail on, `hadFailure` stayed false, and the month got marked seen anyway with an empty file list) — the bug isn't a retry-tracking problem, it's specifically that zero links were ever found, so nothing entered the download loop at all. The task implementing this fix must verify directly (by re-running harvest against Legacy live) whether these 6 months' entries in `_seen.json` need to be manually cleared to force a re-visit, or whether they're naturally revisited — do not assume either way going into implementation.

## Part B: McNeil occupancy enrichment

### Raw archiving

Two new doc types, both keyed to the email's own reported month (already computed by `parseEmailSubjectMonth`):
- `occupancy-chart`: captured via `elementHandle.screenshot()` on the rendered `<img>` element showing the chart — a real capture of rendered DOM content, not a fetch to the image URL, keeping this compliant with the DOM-only rule. Archived via the existing `archiveFile` with `ext` matching whatever format the screenshot produces (PNG).
- `occupancy-narrative`: the email body's plain text (already available via a DOM read during `harvestDeal`'s existing flow), archived as a `.txt` file.

Both live in the same batch-vintage archive structure as PDFs, via the same `archiveFile`/manifest mechanism — no new archive concepts, just two new doc types.

### Extraction, three sources in priority order

All three feed into a single per-month occupancy record, merged the same way `rentRolls` already merges into `extractMcneilBatch`'s final months map (match by month, attach `occupancyPct`).

1. **Direct statement** (highest priority): regex `/Occupancy:\s*([\d.]+)%\s*\((\w+)\)\s*vs\.\s*([\d.]+)%\s*\((\w+)\)/i` against the archived narrative text. Resolves each three-letter month abbreviation to a full `YYYY-MM` key anchored against the email's own known month (one abbreviation typically matches the email's own month letter-for-letter; the other resolves to the nearest prior calendar month, handling year rollover — e.g. "(Dec)" in a January email means the prior December). This pattern has only been confirmed in one real email so far (Oct 2024) — treat it as "extract when present," not as a guaranteed feature of every email.

2. **Vacant-unit narrative**: regex `/(\d+)\s+vacant units?/i` against the same archived narrative text, for the email's own reported month only. Computed as `(totalUnits - vacantCount) / totalUnits * 100`, using a new exported constant in `scripts/deals/mcneil.config.mjs`:
   ```js
   // Source: McNeil Investment Deck, ACQUSITION SUMMARY table, "# Units: 32"
   export const totalUnits = 32;
   ```

3. **Chart image** (lowest priority, but the only source covering months with no email at all, e.g. the confirmed-missing Nov 2024, and the only source giving ~12-13 months per single vision-LLM call): a new vision-LLM prompt asking for `{"<YYYY-MM>": occupancyPct, ...}` pairs across the chart's visible months, reusing the existing `callVisionLlm`/`config.json` `vision_llm` block (same pattern as Legacy's P&L table extraction — no new API key needed). Month labels on the chart are abbreviations without years; resolve using the same anchoring logic as source 1, anchored against the email's own known month (the rightmost point).

**Conflict resolution**: for each month, take the value from the single highest-priority source that has one (direct statement, else vacant-unit narrative, else chart). If any other source also has a value for that same month, compare it against the chosen value and log one `console.warn` per disagreeing source (non-blocking, same pattern as the P&L reconciliation validator) if the two differ by more than 1 percentage point. The chosen (highest-priority) value is always what gets stored, regardless of how many other sources agree or disagree with it.

### Backfill

A separate one-time script/function iterates every already-archived McNeil batch month, re-visits that month's email live, and captures `occupancy-chart`/`occupancy-narrative` only (skipping already-downloaded PDF attachments) — independent of `_seen.json`, which only tracks "have we fetched this month's attachments." `harvestDeal`'s normal per-month loop also performs this same capture for new months going forward, so no second code path needs to exist long-term — the backfill script is a one-time historical catch-up, structurally similar to how `migrate-raw-archive.mjs` already exists as a one-time historical tool from the earlier McNeil bundle-fix work.

## Non-Goals

- No change to how PDF attachments are downloaded or classified (Part A only touches the link-*finding* step, not the download/archive/classify pipeline after a link is found).
- No attempt to resolve disagreement between the chart and text sources beyond logging a warning — if they disagree, the higher-priority source's value is trusted and used; a human can investigate the warning later.
- No monthly occupancy guarantee — Nov 2024 (confirmed: no email exists for that month at all) can only ever be filled by a chart that happens to include it as a trailing point in some later email; if no such chart covers it, that month stays without occupancy data.

## Testing

- Legacy fix: a fixture-based test is not practical here (the bug is in live DOM-overlay-scoping logic against a real portal page, not something a static PDF fixture can reproduce) — verification is a live re-run of `harvestDeal` against Legacy's real portal session, confirming all 7 real months now download their real attachment.
- McNeil occupancy extractors (regex parsing, anchoring logic, vacant-unit computation): unit-testable with real archived text fixtures (the actual email body text already captured during this session's manual investigation, saved as committed test fixtures) — no live portal access needed for these tests.
- Chart vision-LLM extraction: tested the same way Legacy's existing vision-LLM extraction is tested — a fake `callVisionLlmImpl` returning canned JSON, exercising the parsing/anchoring/merge logic without a real API call in the test suite.
