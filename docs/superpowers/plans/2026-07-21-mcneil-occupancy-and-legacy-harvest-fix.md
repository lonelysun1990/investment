# McNeil Occupancy Enrichment & Legacy Harvest Bug Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Legacy's harvest bug (6 of 7 real monthly PDFs never downloaded) and give McNeil real month-by-month occupancy data by reading it out of every monthly update email's body text and embedded chart, instead of relying on the sparse, opportunistic rent-roll attachment that today covers at most 1 of 22 archived months.

**Architecture:** Two independent fixes in the same shared scraping/extraction pipeline. Part A is a one-line DOM-scoping fix in `harvestDeal`. Part B adds two new archived doc types (`occupancy-narrative`, `occupancy-chart`) captured from the rendered email body/chart image, two new pure extractor modules (regex-based narrative parsing, vision-LLM chart reading) that both resolve 3-letter month abbreviations to `YYYY-MM` keys anchored against the email's own known month, and a priority-based merge (direct statement > vacant-unit narrative > chart) that replaces the existing rent-roll-based occupancy attachment in `extractMcneilBatch` entirely.

**Tech Stack:** Node.js (`node:test`), Playwright (Chrome DevTools Protocol), OpenAI-compatible vision LLM API (`gpt-4o` via `config.json`'s `vision_llm` block).

## Global Constraints

- **Portal scraping compliance (CLAUDE.md, hard rule):** all CashFlowPortal interaction goes through `page.goto`, reading rendered DOM (`page.evaluate`, `frame.evaluate`), clicking real UI elements, and `elementHandle.screenshot()`/download events on the page's own rendered content. Never call `api.cashflowportal.com` directly (curl/fetch/`page.request.*`/standalone script), never reuse `__access_token` as a Bearer header, never sniff `page.on("response"/"request")`, never do GraphQL introspection, never hand-edit `data/*.json` with numbers from any of the above. If a number can't be obtained by rendering and reading, ask the user — never fill the gap with a direct API call.
- **Live browser dependency:** Tasks 1 (verification step), 6, and 7 require a real, already-logged-in Chrome instance reachable at `http://localhost:9222` (Chrome DevTools Protocol) on the McNeil/Legacy deal pages. Confirm reachability with `curl -s http://localhost:9222/json/version` before starting any of these tasks; if unreachable, stop and ask the user to open/attach Chrome rather than guessing.
- **Real fixtures only:** every new test fixture in this plan is real, already-captured content (`scripts/__fixtures__/mcneil-emails/2024-10-narrative.txt`, `2026-06-narrative.txt`, `2026-06-occupancy-chart.png`) — never fabricate synthetic fixture text/images when real captured content exists.
- **rentRoll removal is intentional:** Task 4 deliberately deletes `extractMcneilBatch`'s existing rent-roll-based occupancy attachment (the `rentRolls`/`matchingRentRoll` logic and the `record.rentRoll` field) per explicit user decision — rentRoll covered at most 1 of 22 real months and is being fully replaced by the new 3-source pipeline, not supplemented. This is a deliberate behavior removal; do not treat "occupancy no longer comes from rentRoll" as a regression to flag.
- **No dashboard changes needed:** `dashboard/app.js` already renders `record.occupancyPct` wherever present; no dashboard file needs modification in this plan.
- **Squash-merge only:** per CLAUDE.md, the finished branch merges via `gh pr merge --squash`, never a plain merge or rebase-merge.

---

### Task 1: Fix Legacy's harvest attachment-link detection bug

**Files:**
- Modify: `scripts/harvest.mjs:86-97`
- Modify (conditionally, only if live verification in Step 4 shows it's needed): `data/raw/legacy/_seen.json`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new (fixes existing `harvestDeal(page, dealId, dealSlug, rawDir, dealConfig)` behavior — no signature change).

**Context:** `harvestDeal`'s attachment-link search currently scopes itself to "the floating overlay with the smallest `innerText.length`," intended to skip past outer wrapper elements. For Legacy's email modal, this sometimes picks an empty backdrop element instead of the real content panel, returning zero links even though the real `<a href="...pdf">` link exists elsewhere in the DOM. This is why 6 of Legacy's 7 real monthly emails have `files: []` in `data/raw/legacy/_seen.json` today. Verified live earlier this session: an unscoped `document.querySelectorAll("a")` search, filtered by `.pdf`/`.xlsx` href, finds the real link immediately. This matches the simpler pattern `harvestStaticDocument` (same file, `scripts/harvest.mjs:153-179`) already uses successfully with no overlay-scoping at all — confirmed live that attachment `<a>` links render on the main page (not inside any iframe), so an unscoped `page.evaluate` search is the correct scope.

- [ ] **Step 1: Replace the overlay-scoped search with an unscoped one**

In `scripts/harvest.mjs`, replace lines 86-97:

```js
    const attachmentLinks = await page.evaluate(() => {
      const overlays = Array.from(document.querySelectorAll("div,section,aside")).filter((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return (s.position === "fixed" || s.position === "absolute") && r.width > 350 && r.height > 250;
      });
      const scope = overlays.sort((a, b) => a.innerText.length - b.innerText.length)[0];
      if (!scope) return [];
      return Array.from(scope.querySelectorAll("a"))
        .map((a) => ({ name: a.innerText.trim(), href: a.href }))
        .filter((a) => a.href && /\.(pdf|xlsx)(\?|$)/i.test(a.href));
    });
```

with:

```js
    const attachmentLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a"))
        .map((a) => ({ name: a.innerText.trim(), href: a.href }))
        .filter((a) => a.href && /\.(pdf|xlsx)(\?|$)/i.test(a.href));
    });
```

- [ ] **Step 2: Run the existing harvest.mjs unit tests**

Run: `node --test scripts/harvest.test.mjs`
Expected: PASS (these tests only cover `parseEmailSubjectMonth`, `parseDistributionText`, `parseOwnershipPct` — pure functions unaffected by this change — this step just confirms nothing else broke).

- [ ] **Step 3: Commit the fix**

```bash
git add scripts/harvest.mjs
git commit -m "fix: search the whole page for attachment links instead of the smallest overlay"
```

- [ ] **Step 4: Live-verify against Legacy's real portal session**

Confirm Chrome is reachable: `curl -s http://localhost:9222/json/version` (must return JSON, not an error). Then run:

```bash
node scripts/harvest.mjs
```

This loops over every deal in `config.json` (`legacy` and `mcneil`) and calls `harvestDeal`. Watch the `legacy:` summary line it prints.

**Check what happens to the 6 previously-empty months** (their subjects are visible in `data/raw/legacy/_seen.json` — any entry with `"files": []`):

- If the run's `legacy:` summary includes those months' keys (e.g. `2025-11, 2025-12, ...`) and `data/raw/legacy/<month>/` now contains a real PDF, no further action is needed — `harvestDeal`'s `if (!month || seen[month]) continue` check must have treated them as revisitable already (do not guess why; if this is the observed behavior, just confirm the files exist and move on).
- If those months are silently skipped (not in the summary, `_seen.json` entries unchanged), it's because `seen[month]` is still truthy from their earlier false-success. In that case, manually remove those 6 entries from `data/raw/legacy/_seen.json` (edit the JSON file to delete the 6 keys with `"files": []` — this is clearing stale tracking metadata, not fabricating extracted data, and is consistent with CLAUDE.md's rule) and re-run `node scripts/harvest.mjs`. Confirm the second run's `legacy:` summary now includes all 6 months and each now has a real PDF on disk under `data/raw/legacy/<month>/`.

Report which of the two cases occurred and the final state of `data/raw/legacy/` (one PDF per real month, 7 total) before moving to Task 2.

---

### Task 2: Add `totalUnits` constant and the McNeil occupancy-narrative extractor

**Files:**
- Modify: `scripts/deals/mcneil.config.mjs`
- Create: `scripts/extract-mcneil-occupancy-narrative.mjs`
- Create: `scripts/extract-mcneil-occupancy-narrative.test.mjs`
- Fixtures already exist (do not recreate): `scripts/__fixtures__/mcneil-emails/2024-10-narrative.txt`, `scripts/__fixtures__/mcneil-emails/2026-06-narrative.txt`

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolveMonthAbbr(abbr, anchorMonth) -> "YYYY-MM"` (throws on unrecognized abbreviation), `extractDirectStatement(narrativeText, anchorMonth) -> {"YYYY-MM": number, "YYYY-MM": number} | null`, `extractVacantUnitNarrative(narrativeText, anchorMonth, totalUnits) -> {"YYYY-MM": number} | null` — all consumed by Task 4.

**Context:** Real McNeil emails carry occupancy two different ways depending on era. Oct 2024's email has a direct statement: `"Occupancy: 90.6% (Sep) vs. 87.5% (Oct)"`. Later emails (e.g. June 2026) instead say `"We currently have 3 vacant units: 103, 114, 203."`, which combined with the known 32-unit total computes to `(32-3)/32*100 = 90.625` → rounds to `90.6`. Both use 3-letter month abbreviations with no year, so they need resolving against the email's own known reported month (`anchorMonth`, already computed elsewhere via `parseEmailSubjectMonth`) — verified live against both real fixtures this session, including the year-rollover case (e.g. "(Dec)" mentioned in a January email means the prior December).

- [ ] **Step 1: Add the `totalUnits` constant to `mcneil.config.mjs`**

In `scripts/deals/mcneil.config.mjs`, change line 31 from:

```js
export const occupancySource = "rentroll";
```

to:

```js
export const occupancySource = "email";

// Source: McNeil Investment Deck, ACQUSITION SUMMARY table, "# Units: 32"
export const totalUnits = 32;
```

- [ ] **Step 2: Write the failing tests for `resolveMonthAbbr`**

Create `scripts/extract-mcneil-occupancy-narrative.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  resolveMonthAbbr,
  extractDirectStatement,
  extractVacantUnitNarrative,
} from "./extract-mcneil-occupancy-narrative.mjs";

const OCT_2024_FIXTURE = "scripts/__fixtures__/mcneil-emails/2024-10-narrative.txt";
const JUN_2026_FIXTURE = "scripts/__fixtures__/mcneil-emails/2026-06-narrative.txt";

test("resolveMonthAbbr resolves the same-month case", () => {
  assert.equal(resolveMonthAbbr("Oct", "2024-10"), "2024-10");
});

test("resolveMonthAbbr resolves the prior-month case within the same year", () => {
  assert.equal(resolveMonthAbbr("Sep", "2024-10"), "2024-09");
});

test("resolveMonthAbbr handles year rollover when the abbreviation is later in the calendar than the anchor month", () => {
  assert.equal(resolveMonthAbbr("Dec", "2026-01"), "2025-12");
});

test("resolveMonthAbbr throws on an unrecognized abbreviation", () => {
  assert.throws(() => resolveMonthAbbr("Xyz", "2024-10"));
});

test("extractDirectStatement parses the real Oct 2024 email's 'Occupancy: X% (MonA) vs. Y% (MonB)' line", async () => {
  const text = await readFile(OCT_2024_FIXTURE, "utf8");
  const result = extractDirectStatement(text, "2024-10");
  assert.deepEqual(result, { "2024-09": 90.6, "2024-10": 87.5 });
});

test("extractDirectStatement returns null when the email has no direct-statement line", async () => {
  const text = await readFile(JUN_2026_FIXTURE, "utf8");
  assert.equal(extractDirectStatement(text, "2026-06"), null);
});

test("extractVacantUnitNarrative computes occupancy from the real June 2026 email's vacant-unit count", async () => {
  const text = await readFile(JUN_2026_FIXTURE, "utf8");
  const result = extractVacantUnitNarrative(text, "2026-06", 32);
  assert.deepEqual(result, { "2026-06": 90.6 });
});

test("extractVacantUnitNarrative returns null when the email has no vacant-unit line", async () => {
  const text = await readFile(OCT_2024_FIXTURE, "utf8");
  assert.equal(extractVacantUnitNarrative(text, "2024-10", 32), null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test scripts/extract-mcneil-occupancy-narrative.test.mjs`
Expected: FAIL with "Cannot find module './extract-mcneil-occupancy-narrative.mjs'" (module doesn't exist yet).

- [ ] **Step 4: Implement the extractor**

Create `scripts/extract-mcneil-occupancy-narrative.mjs`:

```js
const MONTH_ABBR = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

export function resolveMonthAbbr(abbr, anchorMonth) {
  const monthNum = MONTH_ABBR[abbr];
  if (!monthNum) {
    throw new Error(`extract-mcneil-occupancy-narrative: unrecognized month abbreviation "${abbr}"`);
  }
  const [anchorYear, anchorMonthNum] = anchorMonth.split("-").map(Number);
  const year = monthNum > anchorMonthNum ? anchorYear - 1 : anchorYear;
  return `${year}-${String(monthNum).padStart(2, "0")}`;
}

const DIRECT_STATEMENT_PATTERN = /Occupancy:\s*([\d.]+)%\s*\((\w+)\)\s*vs\.\s*([\d.]+)%\s*\((\w+)\)/i;

export function extractDirectStatement(narrativeText, anchorMonth) {
  const match = narrativeText.match(DIRECT_STATEMENT_PATTERN);
  if (!match) return null;
  const [, pctA, abbrA, pctB, abbrB] = match;
  return {
    [resolveMonthAbbr(abbrA, anchorMonth)]: Number(pctA),
    [resolveMonthAbbr(abbrB, anchorMonth)]: Number(pctB),
  };
}

const VACANT_UNIT_PATTERN = /(\d+)\s+vacant units?/i;

export function extractVacantUnitNarrative(narrativeText, anchorMonth, totalUnits) {
  const match = narrativeText.match(VACANT_UNIT_PATTERN);
  if (!match) return null;
  const vacant = Number(match[1]);
  const occupancyPct = Math.round(((totalUnits - vacant) / totalUnits) * 1000) / 10;
  return { [anchorMonth]: occupancyPct };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/extract-mcneil-occupancy-narrative.test.mjs`
Expected: PASS (8/8).

- [ ] **Step 6: Commit**

```bash
git add scripts/deals/mcneil.config.mjs scripts/extract-mcneil-occupancy-narrative.mjs scripts/extract-mcneil-occupancy-narrative.test.mjs
git commit -m "feat: add totalUnits constant and McNeil occupancy-narrative extractor"
```

---

### Task 3: Add the McNeil occupancy-chart vision-LLM extractor

**Files:**
- Create: `scripts/extract-mcneil-occupancy-chart.mjs`
- Create: `scripts/extract-mcneil-occupancy-chart.test.mjs`
- Fixture already exists (do not recreate): `scripts/__fixtures__/mcneil-emails/2026-06-occupancy-chart.png`

**Interfaces:**
- Consumes: `callVisionLlm(config, imageBase64, prompt, opts)` from `scripts/lib/vision-llm.mjs` (existing, unchanged).
- Produces: `resolveTrailingMonths(labels, anchorMonth) -> string[]` (throws if labels aren't a consecutive trailing run ending at `anchorMonth`), `extractOccupancyChart(config, imagePath, anchorMonth, opts) -> {"YYYY-MM": number, ...} | null` — consumed by Task 4.

**Context:** McNeil's monthly emails each embed a bar+line chart (confirmed real PNG, not SVG) showing ~12 trailing months of "Monthly Revenue" bars and "Occupancy %" line, with 3-letter month labels (no year) on the x-axis, oldest on the left. This mirrors `scripts/extract-legacy.mjs`'s existing `extractPnlTable` pattern (same `callVisionLlm`/`config.json` `vision_llm` block, same `callVisionLlmImpl` test-injection convention, same "returns unavailable/null with no config, never throws" contract) but reads chart labels instead of a P&L table. Verified live: the real June 2026 chart's labels are `Jul Aug Sep Oct Nov Dec Jan Feb Mar Apr May Jun` for an anchor month of `2026-06` — a strict 12-month trailing window ending at the anchor.

- [ ] **Step 1: Write the failing tests**

Create `scripts/extract-mcneil-occupancy-chart.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTrailingMonths, extractOccupancyChart } from "./extract-mcneil-occupancy-chart.mjs";

const CHART_FIXTURE = "scripts/__fixtures__/mcneil-emails/2026-06-occupancy-chart.png";

test("resolveTrailingMonths resolves the real 12-label trailing window ending at the anchor month", () => {
  const labels = ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun"];
  const result = resolveTrailingMonths(labels, "2026-06");
  assert.deepEqual(result, [
    "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12",
    "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
  ]);
});

test("resolveTrailingMonths handles a window that crosses a year rollover mid-window", () => {
  const result = resolveTrailingMonths(["Nov", "Dec", "Jan"], "2026-01");
  assert.deepEqual(result, ["2025-11", "2025-12", "2026-01"]);
});

test("resolveTrailingMonths throws when labels are not a consecutive trailing run ending at the anchor month", () => {
  assert.throws(() => resolveTrailingMonths(["Jul", "Aug", "Jun"], "2026-06"));
});

test("resolveTrailingMonths throws on an unrecognized month abbreviation", () => {
  assert.throws(() => resolveTrailingMonths(["Xyz"], "2026-06"));
});

test("extractOccupancyChart returns null with no config, never throws", async () => {
  const result = await extractOccupancyChart(null, CHART_FIXTURE, "2026-06");
  assert.equal(result, null);
});

test("extractOccupancyChart parses the vision LLM's month/occupancy pairs and resolves them to YYYY-MM keys", async () => {
  const fakeConfig = { baseUrl: "https://example.test/v1", apiKey: "x", model: "gpt-4o" };
  const fakeResponse = JSON.stringify({
    months: [
      { label: "Jul", occupancyPct: 97 },
      { label: "Aug", occupancyPct: 93 },
      { label: "Jun", occupancyPct: 88 },
    ],
  });
  const fakeCallVisionLlm = async () => fakeResponse;
  const result = await extractOccupancyChart(fakeConfig, CHART_FIXTURE, "2025-08", {
    callVisionLlmImpl: fakeCallVisionLlm,
  });
  assert.deepEqual(result, { "2025-06": 97, "2025-07": 93, "2025-08": 88 });
});

test("extractOccupancyChart strips a markdown code fence from the vision LLM response before parsing", async () => {
  const fakeConfig = { baseUrl: "https://example.test/v1", apiKey: "x", model: "gpt-4o" };
  const fakeResponse = "```json\n" + JSON.stringify({ months: [{ label: "Jun", occupancyPct: 88 }] }) + "\n```";
  const fakeCallVisionLlm = async () => fakeResponse;
  const result = await extractOccupancyChart(fakeConfig, CHART_FIXTURE, "2026-06", {
    callVisionLlmImpl: fakeCallVisionLlm,
  });
  assert.deepEqual(result, { "2026-06": 88 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/extract-mcneil-occupancy-chart.test.mjs`
Expected: FAIL with "Cannot find module './extract-mcneil-occupancy-chart.mjs'".

- [ ] **Step 3: Implement the extractor**

Create `scripts/extract-mcneil-occupancy-chart.mjs`:

```js
import { readFile } from "node:fs/promises";
import { callVisionLlm } from "./lib/vision-llm.mjs";

const MONTH_ABBR = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

const OCCUPANCY_CHART_PROMPT = `This image is a chart with month labels on the x-axis (3-letter abbreviations, no year, oldest on the left, most recent on the right) and two data series: a bar chart "Monthly Revenue" (left y-axis, dollars) and a line chart "Occupancy %" (right y-axis, percentage). Read ONLY the Occupancy % line's value at each labeled month. Respond with ONLY a JSON object, no prose or code fences, matching exactly this shape:
{
  "months": [
    { "label": "<3-letter month abbreviation as printed, e.g. Jul>", "occupancyPct": number }
  ]
}
List every labeled month from left to right, in the order they appear on the chart. Do not include the $ revenue values or bar heights, only the Occupancy % line's value.`;

export function resolveTrailingMonths(labels, anchorMonth) {
  const [anchorYear, anchorMonthNum] = anchorMonth.split("-").map(Number);
  const n = labels.length;
  return labels.map((label, i) => {
    const monthNum = MONTH_ABBR[label];
    if (!monthNum) {
      throw new Error(`extract-mcneil-occupancy-chart: unrecognized month abbreviation "${label}"`);
    }
    const offset = n - 1 - i;
    const totalMonths = anchorYear * 12 + (anchorMonthNum - 1) - offset;
    const year = Math.floor(totalMonths / 12);
    const month = (totalMonths % 12) + 1;
    if (month !== monthNum) {
      throw new Error(
        `extract-mcneil-occupancy-chart: chart labels are not a consecutive trailing run ending at ${anchorMonth} -- label "${label}" at position ${i} does not land on its own month once anchored`
      );
    }
    return `${year}-${String(month).padStart(2, "0")}`;
  });
}

export async function extractOccupancyChart(config, imagePath, anchorMonth, opts = {}) {
  if (!config) return null;
  const callVisionLlmImpl = opts.callVisionLlmImpl ?? callVisionLlm;

  const imageBase64 = (await readFile(imagePath)).toString("base64");
  let responseText = await callVisionLlmImpl(config, imageBase64, OCCUPANCY_CHART_PROMPT);
  responseText = responseText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();

  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(
      `extract-mcneil-occupancy-chart: vision LLM response was not valid JSON: ${responseText.slice(0, 200)}`
    );
  }

  const months = result.months ?? [];
  const labels = months.map((m) => m.label);
  const resolvedMonths = resolveTrailingMonths(labels, anchorMonth);

  const occupancyByMonth = {};
  months.forEach((m, i) => {
    occupancyByMonth[resolvedMonths[i]] = m.occupancyPct;
  });
  return occupancyByMonth;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/extract-mcneil-occupancy-chart.test.mjs`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add scripts/extract-mcneil-occupancy-chart.mjs scripts/extract-mcneil-occupancy-chart.test.mjs
git commit -m "feat: add McNeil occupancy-chart vision-LLM extractor"
```

---

### Task 4: Replace `extractMcneilBatch`'s rentRoll-based occupancy with the priority merge

**Files:**
- Create: `scripts/lib/merge-occupancy.mjs`
- Create: `scripts/lib/merge-occupancy.test.mjs`
- Modify: `scripts/extract-mcneil.mjs`
- Modify: `scripts/extract-mcneil.test.mjs`
- Modify: `scripts/refresh.mjs`

**Interfaces:**
- Consumes: `extractDirectStatement`, `extractVacantUnitNarrative` (Task 2), `extractOccupancyChart` (Task 3), `totalUnits` (Task 2), `findSections(manifest, docTypes)` (existing, `scripts/extract-mcneil.mjs:230-241`, unchanged).
- Produces: `mergeOccupancySources(sourcesByPriority, sourceLabels) -> Map<string, number>` (pure, exported from `scripts/lib/merge-occupancy.mjs`). `extractMcneilBatch(batchDir, manifest, config)` (config is now a required third parameter — was previously 2-arg). `runMcneilExtraction(config, rawDir, outputPath)` (config is now a required first parameter — was previously `(rawDir, outputPath)`).

**Context:** `extractMcneilBatch` currently attaches `occupancyPct` only from a rent-roll attachment (`rentRolls` array built from `rentroll`/`rentroll-pdf` manifest sections), matched to a P&L month via the rent roll's own `asOfDate`. Per the approved spec amendment, this is being dropped entirely — `occupancyPct` for every month now comes exclusively from the 3-source priority pipeline built in Tasks 2-3. `extractMcneilBatch` needs a `config` parameter (the vision-LLM config block) to pass through to the chart extractor, mirroring exactly how `scripts/extract-legacy.mjs`'s `extractLegacyBatch(batchDir, manifest, config)` / `runLegacyExtraction(config, rawDir, outputPath)` already do it.

- [ ] **Step 1: Write the failing tests for the merge helper**

Create `scripts/lib/merge-occupancy.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeOccupancySources } from "./merge-occupancy.mjs";

test("takes the highest-priority source's value when only one source has a month", () => {
  const result = mergeOccupancySources(
    [new Map([["2024-10", 87.5]]), new Map(), new Map()],
    ["direct statement", "vacant-unit narrative", "chart"]
  );
  assert.deepEqual([...result], [["2024-10", 87.5]]);
});

test("prefers the highest-priority source's value even when a lower-priority source disagrees", () => {
  const result = mergeOccupancySources(
    [new Map([["2026-06", 90.6]]), new Map(), new Map([["2026-06", 84.0]])],
    ["direct statement", "vacant-unit narrative", "chart"]
  );
  assert.equal(result.get("2026-06"), 90.6);
});

test("logs a warning when a lower-priority source disagrees by more than 1 percentage point", () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    mergeOccupancySources(
      [new Map([["2026-06", 90.6]]), new Map(), new Map([["2026-06", 84.0]])],
      ["direct statement", "vacant-unit narrative", "chart"]
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2026-06/);
  assert.match(warnings[0], /90\.6/);
  assert.match(warnings[0], /84/);
});

test("does not warn when sources disagree by 1 percentage point or less", () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    mergeOccupancySources(
      [new Map([["2026-06", 90.6]]), new Map(), new Map([["2026-06", 89.7]])],
      ["direct statement", "vacant-unit narrative", "chart"]
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 0);
});

test("returns an empty map when no source has any data", () => {
  const result = mergeOccupancySources([new Map(), new Map(), new Map()], ["a", "b", "c"]);
  assert.equal(result.size, 0);
});

test("merges months from different sources into the union of all covered months", () => {
  const result = mergeOccupancySources(
    [new Map([["2024-10", 87.5], ["2024-09", 90.6]]), new Map(), new Map([["2024-11", 88.0]])],
    ["direct statement", "vacant-unit narrative", "chart"]
  );
  assert.deepEqual(
    [...result.entries()].sort(),
    [["2024-09", 90.6], ["2024-10", 87.5], ["2024-11", 88.0]]
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lib/merge-occupancy.test.mjs`
Expected: FAIL with "Cannot find module './merge-occupancy.mjs'".

- [ ] **Step 3: Implement the merge helper**

Create `scripts/lib/merge-occupancy.mjs`:

```js
const DISAGREEMENT_THRESHOLD_PP = 1;

export function mergeOccupancySources(sourcesByPriority, sourceLabels) {
  const allMonths = new Set();
  for (const source of sourcesByPriority) {
    for (const month of source.keys()) allMonths.add(month);
  }

  const result = new Map();
  for (const month of allMonths) {
    const entries = sourcesByPriority
      .map((source, i) => ({ value: source.get(month), label: sourceLabels[i] }))
      .filter((e) => e.value !== undefined);
    if (entries.length === 0) continue;

    const chosen = entries[0];
    for (let i = 1; i < entries.length; i++) {
      if (Math.abs(entries[i].value - chosen.value) > DISAGREEMENT_THRESHOLD_PP) {
        console.warn(
          `mergeOccupancySources: ${month} occupancy disagreement -- using ${chosen.value}% from ${chosen.label}, but ${entries[i].label} reports ${entries[i].value}%`
        );
      }
    }
    result.set(month, chosen.value);
  }
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/lib/merge-occupancy.test.mjs`
Expected: PASS (6/6).

- [ ] **Step 5: Commit the merge helper**

```bash
git add scripts/lib/merge-occupancy.mjs scripts/lib/merge-occupancy.test.mjs
git commit -m "feat: add priority-based occupancy source merge helper"
```

- [ ] **Step 6: Delete the three tests that depend on the removed rentRoll-occupancy behavior**

In `scripts/extract-mcneil.test.mjs`, delete these three tests in full (find each by its exact name and remove from the `test("...", async () => { ... });` opening line through its closing `});`):

1. `"extractMcneilBatch attaches occupancy only to the month the rent roll's as-of date falls in"` (currently lines 204-210)
2. `"extractMcneilBatch emits an occupancy-only record when the batch has a rentroll but no cashflow-t12 PDF"` (currently lines 212-235)
3. `"runMcneilExtraction folds batches so an earlier batch's occupancy survives a later batch that lacks a rent roll"` (currently lines 237-268)

- [ ] **Step 7: Update the bundled-PDF test's occupancy assertion**

In `scripts/extract-mcneil.test.mjs`, in the test `"extractMcneilBatch extracts P&L, occupancy, and zero distribution from a real bundled multi-report PDF"`, replace:

```js
  const sep2025 = months.get("2025-09");
  assert.equal(sep2025.occupancyPct, 90.6, "the batch's own rentroll-pdf section (9/30/2025) should attach to Sep 2025");
```

with:

```js
  const sep2025 = months.get("2025-09");
  // occupancyPct now comes exclusively from the email narrative/chart pipeline (Task 4),
  // not from the batch's rentroll-pdf section -- this fixture has no archived
  // occupancy-narrative/occupancy-chart doc, so occupancyPct is correctly absent.
  assert.equal(sep2025.occupancyPct, undefined);
```

Also update the test's title to drop the now-inaccurate "occupancy" claim — rename `"extractMcneilBatch extracts P&L, occupancy, and zero distribution from a real bundled multi-report PDF"` to `"extractMcneilBatch extracts P&L and zero distribution from a real bundled multi-report PDF"`.

- [ ] **Step 8: Write two new integration tests for the narrative-driven merge**

In `scripts/extract-mcneil.test.mjs`, add these two tests (place them where the three deleted tests used to be, right after the `"extractMcneilBatch marks aggregate-only months as low confidence and strips the internal marker"` test):

```js
test("extractMcneilBatch attaches occupancy from a direct-statement narrative even with no PDF in the batch", async () => {
  const TMP_RAW = "scripts/__fixtures__/tmp-mcneil-direct-statement-only";
  await rm(TMP_RAW, { recursive: true, force: true });

  const { mkdir, copyFile } = await import("node:fs/promises");
  const { saveManifest, loadManifest } = await import("./lib/archive-store.mjs");

  await mkdir(`${TMP_RAW}/2024-10`, { recursive: true });
  await copyFile(
    "scripts/__fixtures__/mcneil-emails/2024-10-narrative.txt",
    `${TMP_RAW}/2024-10/occupancy-narrative.txt`
  );
  await saveManifest(`${TMP_RAW}/2024-10`, {
    files: [{ docType: "occupancy-narrative", fileName: "occupancy-narrative.txt", contentHash: "e1" }],
  });

  const manifest = await loadManifest(`${TMP_RAW}/2024-10`);
  const months = await extractMcneilBatch(`${TMP_RAW}/2024-10`, manifest, null);

  assert.equal(months.size, 2);
  assert.equal(months.get("2024-10").occupancyPct, 87.5);
  assert.equal(months.get("2024-09").occupancyPct, 90.6);

  await rm(TMP_RAW, { recursive: true, force: true });
});

test("extractMcneilBatch attaches occupancy from a vacant-unit narrative when no direct statement is present", async () => {
  const TMP_RAW = "scripts/__fixtures__/tmp-mcneil-vacant-unit-only";
  await rm(TMP_RAW, { recursive: true, force: true });

  const { mkdir, copyFile } = await import("node:fs/promises");
  const { saveManifest, loadManifest } = await import("./lib/archive-store.mjs");

  await mkdir(`${TMP_RAW}/2026-06`, { recursive: true });
  await copyFile(
    "scripts/__fixtures__/mcneil-emails/2026-06-narrative.txt",
    `${TMP_RAW}/2026-06/occupancy-narrative.txt`
  );
  await saveManifest(`${TMP_RAW}/2026-06`, {
    files: [{ docType: "occupancy-narrative", fileName: "occupancy-narrative.txt", contentHash: "e2" }],
  });

  const manifest = await loadManifest(`${TMP_RAW}/2026-06`);
  const months = await extractMcneilBatch(`${TMP_RAW}/2026-06`, manifest, null);

  assert.equal(months.size, 1);
  assert.equal(months.get("2026-06").occupancyPct, 90.6);

  await rm(TMP_RAW, { recursive: true, force: true });
});
```

- [ ] **Step 9: Run the tests to verify the new ones fail (module not yet updated) and the modified one fails too**

Run: `node --test scripts/extract-mcneil.test.mjs`
Expected: the two new tests FAIL (`extractMcneilBatch` doesn't accept a third `config` argument yet and still uses rentRoll), and the modified bundled-PDF test FAILS (`sep2025.occupancyPct` is still `90.6`, not `undefined`).

- [ ] **Step 10: Rewrite `extractMcneilBatch` and thread `config` through**

In `scripts/extract-mcneil.mjs`, replace the imports block:

```js
import path from "node:path";
import { extractRentRoll } from "./extract-mcneil-rentroll.mjs";
import { extractRentRollPdf } from "./extract-mcneil-rentroll-pdf.mjs";
import { runGenericExtraction } from "./lib/run-extraction.mjs";
import { distributionLabel } from "./deals/mcneil.config.mjs";
import { resolveArchiveRoot } from "./lib/archive-store.mjs";
```

with:

```js
import path from "node:path";
import { readFile } from "node:fs/promises";
import { runGenericExtraction } from "./lib/run-extraction.mjs";
import { distributionLabel, totalUnits } from "./deals/mcneil.config.mjs";
import { resolveArchiveRoot } from "./lib/archive-store.mjs";
import { extractDirectStatement, extractVacantUnitNarrative } from "./extract-mcneil-occupancy-narrative.mjs";
import { extractOccupancyChart } from "./extract-mcneil-occupancy-chart.mjs";
import { mergeOccupancySources } from "./lib/merge-occupancy.mjs";
```

Then replace the entire `extractMcneilBatch` function and the `runMcneilExtraction`/CLI block that follows it (currently `scripts/extract-mcneil.mjs:243-304`) with:

```js
async function extractMcneilOccupancy(batchDir, manifest, batchMonth, config) {
  const narrativeSections = findSections(manifest, ["occupancy-narrative"]);
  const chartSections = findSections(manifest, ["occupancy-chart"]);

  let directStatement = new Map();
  let vacantNarrative = new Map();
  if (narrativeSections.length > 0) {
    const narrativeText = await readFile(path.join(batchDir, narrativeSections[0].fileName), "utf8");
    const direct = extractDirectStatement(narrativeText, batchMonth);
    if (direct) directStatement = new Map(Object.entries(direct));
    const vacant = extractVacantUnitNarrative(narrativeText, batchMonth, totalUnits);
    if (vacant) vacantNarrative = new Map(Object.entries(vacant));
  }

  let chart = new Map();
  if (chartSections.length > 0) {
    const chartResult = await extractOccupancyChart(
      config,
      path.join(batchDir, chartSections[0].fileName),
      batchMonth
    );
    if (chartResult) chart = new Map(Object.entries(chartResult));
  }

  return mergeOccupancySources(
    [directStatement, vacantNarrative, chart],
    ["direct statement", "vacant-unit narrative", "chart"]
  );
}

export async function extractMcneilBatch(batchDir, manifest, config) {
  const months = new Map();
  const batchMonth = path.basename(batchDir);

  const occupancyByMonth = await extractMcneilOccupancy(batchDir, manifest, batchMonth, config);

  const pnlSections = findSections(manifest, ["cashflow-t12", "trailing-pnl-detail"]);

  if (pnlSections.length === 0) {
    for (const [month, occupancyPct] of occupancyByMonth) {
      months.set(month, { month, occupancyPct });
    }
    return months;
  }

  for (const { fileName, pageRange, docType } of pnlSections) {
    const pdfPath = path.join(batchDir, fileName);
    const pnlByMonth = await extractMcneilPnl(pdfPath, pageRange);
    const distributionByMonth =
      docType === "cashflow-t12"
        ? await extractMcneilDistributions(pdfPath, distributionLabel, pageRange)
        : new Map();

    for (const [month, pnl] of pnlByMonth) {
      const { expenseIsAggregateOnly, ...pnlFields } = pnl;
      const record = {
        ...pnlFields,
        month,
        distribution: distributionByMonth.get(month) ?? 0,
        sourceFile: pdfPath,
        extraction: {
          method: "deterministic",
          confidence: expenseIsAggregateOnly ? "low" : "high",
        },
      };
      if (occupancyByMonth.has(month)) {
        record.occupancyPct = occupancyByMonth.get(month);
      }
      months.set(month, record);
    }
  }

  for (const [month, occupancyPct] of occupancyByMonth) {
    if (!months.has(month)) months.set(month, { month, occupancyPct });
  }

  return months;
}

export async function runMcneilExtraction(config, rawDir, outputPath) {
  return runGenericExtraction(rawDir, outputPath, (batchDir, manifest) => extractMcneilBatch(batchDir, manifest, config));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let config = null;
  try {
    const raw = await readFile("config.json", "utf8");
    config = JSON.parse(raw).vision_llm ?? null;
  } catch {
    console.warn("extract-mcneil: no config.json / vision_llm block found; occupancy chart reading will be skipped.");
  }
  const result = await runMcneilExtraction(config, path.join(resolveArchiveRoot(), "mcneil"), "data/mcneil.json");
  console.log(`Processed months: ${result.monthsProcessed.join(", ") || "(none)"}`);
}
```

Note this removes the `rentRolls` array, the `matchingRentRoll` lookup, and the `record.rentRoll` field entirely, and removes the now-unused imports of `extractRentRoll`/`extractRentRollPdf` (the modules themselves and their own test files are untouched — they're just no longer wired into `extractMcneilBatch`).

- [ ] **Step 11: Update `scripts/refresh.mjs`'s call site**

In `scripts/refresh.mjs`, replace line 35:

```js
  const mcneilResult = await runMcneilExtraction(path.join(resolveArchiveRoot(), "mcneil"), "data/mcneil.json");
```

with:

```js
  const mcneilResult = await runMcneilExtraction(config.vision_llm ?? null, path.join(resolveArchiveRoot(), "mcneil"), "data/mcneil.json");
```

- [ ] **Step 12: Run the full extract-mcneil test suite to verify everything passes**

Run: `node --test scripts/extract-mcneil.test.mjs`
Expected: PASS (all tests, including the two new ones from Step 8 and the modified one from Step 7).

- [ ] **Step 13: Run the full project test suite**

Run: `npm test`
Expected: PASS (0 failures) — this also confirms `scripts/extract-mcneil-rentroll.test.mjs` and `scripts/extract-mcneil-rentroll-pdf.test.mjs` still pass unmodified (they test their modules directly, independent of `extractMcneilBatch`).

- [ ] **Step 14: Commit**

```bash
git add scripts/extract-mcneil.mjs scripts/extract-mcneil.test.mjs scripts/refresh.mjs
git commit -m "feat: replace rentRoll-based McNeil occupancy with the narrative/chart priority merge"
```

---

### Task 5: Capture occupancy-narrative and occupancy-chart in `harvestDeal`

**Files:**
- Modify: `scripts/harvest.mjs`
- Modify: `scripts/deals/mcneil.config.mjs`

**Interfaces:**
- Consumes: `archiveFile(dealRawDir, batchKey, docType, ext, buffer, meta)` (existing, `scripts/lib/archive-store.mjs:52-77`, unchanged).
- Produces: `findEmailContentFrame(page) -> Frame | null` and `captureOccupancyDocs(page, rawDir, month, subject) -> Promise<void>` — both exported from `scripts/harvest.mjs` for reuse by Task 6's backfill script.

**Context:** Verified live this session: McNeil's email body and embedded chart render inside a specific iframe — one of the page's `about:blank`-URL frames whose `document.body.innerText` is non-empty (the other `about:blank` frames on the page are empty utility frames). The email's attachment `<a>` links, by contrast, render on the **main page**, not in this frame (confirmed live: an unscoped `page.evaluate` search for `<a>` tags finds the real attachment link on the main page, while the same search inside the content frame returns zero links) — so Task 1's fix and this task's capture logic each target the correct, different scope. Inside that content frame, the chart is the one `<img>` whose `src` ends in `.png` (verified live: the frame also contains a `.jpeg` company logo and a few `.svg` personalization icons that must be excluded). This capture only makes sense for McNeil (Legacy's monthly update is a single attached PDF, not an email-body chart), so it's gated behind a new `dealConfig.capturesEmailOccupancy` flag.

- [ ] **Step 1: Add the `capturesEmailOccupancy` flag to McNeil's config**

In `scripts/deals/mcneil.config.mjs`, add this line after the `totalUnits` constant added in Task 2:

```js
export const capturesEmailOccupancy = true;
```

(Legacy's `scripts/deals/legacy.config.mjs` is left unchanged — `dealConfig.capturesEmailOccupancy` is simply `undefined`/falsy there.)

- [ ] **Step 2: Add the frame-finding and capture helpers to `harvest.mjs`**

In `scripts/harvest.mjs`, add these two exported functions right after `harvestDeal` (after line 151, before `harvestStaticDocument`):

```js
export async function findEmailContentFrame(page) {
  for (const frame of page.frames()) {
    if (frame.url() !== "about:blank") continue;
    const bodyLength = await frame.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0);
    if (bodyLength > 0) return frame;
  }
  return null;
}

export async function captureOccupancyDocs(page, rawDir, month, subject) {
  const contentFrame = await findEmailContentFrame(page);
  if (!contentFrame) {
    console.warn(`captureOccupancyDocs: could not find email content frame for ${month} -- skipping`);
    return;
  }

  const narrativeText = await contentFrame.evaluate(() => document.body.innerText);
  await archiveFile(rawDir, month, "occupancy-narrative", "txt", Buffer.from(narrativeText, "utf8"), {
    sourceEmailSubject: subject,
  });

  const chartHandle = await contentFrame.evaluateHandle(() => {
    return Array.from(document.querySelectorAll("img")).find((img) => /\.png(\?|$)/i.test(img.src)) ?? null;
  });
  const chartEl = chartHandle.asElement();
  if (chartEl) {
    const chartBuffer = await chartEl.screenshot();
    await archiveFile(rawDir, month, "occupancy-chart", "png", chartBuffer, {
      sourceEmailSubject: subject,
    });
  } else {
    console.warn(`captureOccupancyDocs: no occupancy chart image found for ${month}`);
  }
}
```

- [ ] **Step 3: Call the capture helper from `harvestDeal`'s per-email loop**

In `scripts/harvest.mjs`, inside `harvestDeal`, immediately after the attachment download loop's closing brace (right after line 133's `}`, before the `// Only mark a month as seen...` comment), add:

```js
    if (dealConfig.capturesEmailOccupancy) {
      try {
        await captureOccupancyDocs(page, rawDir, month, subject);
      } catch (err) {
        console.warn(`harvestDeal: occupancy capture failed for ${dealSlug} ${month}: ${err.message}`);
      }
    }
```

- [ ] **Step 4: Run the existing harvest tests**

Run: `node --test scripts/harvest.test.mjs`
Expected: PASS (unchanged pure-function tests; this step confirms the file still parses and nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add scripts/harvest.mjs scripts/deals/mcneil.config.mjs
git commit -m "feat: capture occupancy-narrative and occupancy-chart during McNeil email harvest"
```

Live verification of this capture logic happens in Task 7 (it requires a real browser session and real McNeil emails — there's no practical fixture-based way to test live DOM/iframe-scoping code, consistent with how `harvestDeal` itself has never had automated coverage in this codebase).

---

### Task 6: One-time backfill for already-archived McNeil months

**Files:**
- Create: `scripts/backfill-mcneil-occupancy.mjs`

**Interfaces:**
- Consumes: `findEmailContentFrame`, `captureOccupancyDocs` (Task 5, `scripts/harvest.mjs`), `parseEmailSubjectMonth` (existing, `scripts/harvest.mjs:34-41`, unchanged), `loadManifest`, `resolveArchiveRoot` (existing, `scripts/lib/archive-store.mjs`, unchanged).
- Produces: `backfillMcneilOccupancy(page, dealId, rawDir) -> Promise<{ backfilled: string[] }>`.

**Context:** Going forward, Task 5's capture happens automatically for every new month `harvestDeal` visits. But `harvestDeal` skips any month already in `_seen.json` (`if (!month || seen[month]) continue`), so the 22 already-archived McNeil months will never get their `occupancy-narrative`/`occupancy-chart` docs from the normal harvest loop. This script re-visits each already-archived month's email specifically to capture those two doc types (skipping attachment re-download entirely), independent of `_seen.json` — structurally similar to the existing one-time `migrate-raw-archive.mjs` tool from the earlier McNeil bundle-fix work. It's idempotent: re-running it skips any month whose manifest already has an `occupancy-narrative` entry, so it's safe to re-run after a partial/interrupted run.

- [ ] **Step 1: Implement the backfill script**

Create `scripts/backfill-mcneil-occupancy.mjs`:

```js
import { chromium } from "playwright";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveArchiveRoot, loadManifest } from "./lib/archive-store.mjs";
import { parseEmailSubjectMonth, captureOccupancyDocs } from "./harvest.mjs";

const PORTAL_BASE = "https://whitepagodagroup.cashflowportal.com";

export async function backfillMcneilOccupancy(page, dealId, rawDir) {
  const batchNames = (await readdir(rawDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  await page.goto(`${PORTAL_BASE}/app/documents/${dealId}?tab=emails`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForSelector("tbody tr", { timeout: 20000, state: "attached" });
  await page.waitForTimeout(3000);

  const rows = await page.$$eval("tbody tr", (trs) => trs.map((tr) => tr.innerText));

  const backfilled = [];
  for (let i = 0; i < rows.length; i++) {
    const subject = rows[i];
    const month = parseEmailSubjectMonth(subject);
    if (!month || !batchNames.includes(month)) continue;

    const manifest = await loadManifest(path.join(rawDir, month));
    if (manifest.files.some((f) => f.docType === "occupancy-narrative")) continue;

    const row = page.locator("tbody tr").nth(i);
    await row.locator("button").last().click();
    await page.waitForTimeout(3000);

    try {
      await captureOccupancyDocs(page, rawDir, month, subject);
      backfilled.push(month);
    } catch (err) {
      console.warn(`backfillMcneilOccupancy: occupancy capture failed for ${month}: ${err.message}`);
    }

    const doneButton = page.locator("text=Done").first();
    if (await doneButton.isVisible().catch(() => false)) await doneButton.click();
    await page.waitForTimeout(500);
  }

  return { backfilled };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("cashflowportal")) ?? ctx.pages()[0];

  const config = JSON.parse(await readFile("config.json", "utf8"));

  const result = await backfillMcneilOccupancy(page, config.deals.mcneil.dealId, path.join(resolveArchiveRoot(), "mcneil"));
  console.log(`Backfilled: ${result.backfilled.length ? result.backfilled.join(", ") : "(none)"}`);
  await browser.close();
}
```

- [ ] **Step 2: Sanity-check the file parses and exports correctly**

Run: `node -e "const m = await import('./scripts/backfill-mcneil-occupancy.mjs'); console.log(typeof m.backfillMcneilOccupancy)"`
Expected output: `function`

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-mcneil-occupancy.mjs
git commit -m "feat: add one-time backfill script for McNeil occupancy on already-archived months"
```

Live execution of this script happens in Task 7.

---

### Task 7: Live re-run, reconcile, and commit real data

**Files:**
- Modify (data only, produced by the sanctioned scripts below — never hand-edited): `data/legacy.json`, `data/mcneil.json`
- Modify (only if `buildDashboardData` output changes): `dashboard/data.js`

**Interfaces:**
- Consumes everything built in Tasks 1-6.
- Produces: no new code — this task runs the pipeline for real and verifies the result.

**Context:** This task actually exercises the live browser and real vision-LLM calls end to end. Follow the hard-gate discipline already established in this codebase's own prior extraction work (see `git log` for the non-operating-expense project's Task 6, which correctly stopped and reported rather than committing data through unresolved reconciliation warnings): if genuine reconciliation or occupancy-disagreement warnings appear and can't be attributed to a code bug in Tasks 1-6, **stop, do not hand-edit any JSON, and report the finding** instead of forcing a clean-looking commit.

- [ ] **Step 1: Confirm Chrome is reachable**

Run: `curl -s http://localhost:9222/json/version`
Expected: a JSON object with a `Browser` field. If this fails, stop and ask the user to open/attach Chrome to the McNeil/Legacy portal pages before continuing.

- [ ] **Step 2: Run the full project test suite as a pre-flight check**

Run: `npm test`
Expected: PASS (0 failures) — confirms Tasks 1-6 didn't leave anything broken before live execution.

- [ ] **Step 3: Re-run harvest.mjs (applies Task 1's Legacy fix and Task 5's McNeil capture for any new months)**

Run: `node scripts/harvest.mjs`
Record the printed summary for both deals.

- [ ] **Step 4: Run the McNeil occupancy backfill for already-archived months**

Run: `node scripts/backfill-mcneil-occupancy.mjs`
Record the printed `Backfilled:` list. Expect it to include all 22 previously-archived McNeil months (or fewer, if some months' emails have already been re-visited by Step 3's harvest run for new months, or if a specific month's email no longer exists/loads — investigate and report any month that fails rather than silently skipping).

- [ ] **Step 5: Re-run extraction for both deals**

Run: `node scripts/extract-legacy.mjs`
Run: `node scripts/extract-mcneil.mjs`

Watch for `console.warn` output from either command:
- Legacy: reconciliation warnings (`reconcilePnlRecord`). If these appear, diagnose per the precedent in this codebase's prior Task 6 report before deciding whether to proceed — do not assume they're new bugs from this plan without checking whether they're pre-existing vision-LLM transcription noise.
- McNeil: occupancy disagreement warnings (`mergeOccupancySources`, Task 4) or reconciliation warnings. A disagreement warning is not automatically wrong — it's the intended non-blocking signal — but read each one and confirm the chosen (highest-priority) value looks right against the source doc before proceeding.

- [ ] **Step 6: Verify McNeil now has real month-by-month occupancy**

Run: `node -e "const d = require('./data/mcneil.json'); for (const [m, r] of Object.entries(d)) console.log(m, r.occupancyPct);"`
Expected: the overwhelming majority of months (ideally all with an archived email — recall Nov 2024 has no email at all and will stay without occupancy data, per the spec's stated non-goal) now have a non-`undefined` `occupancyPct`, a major improvement over the pre-fix state of at most 1 of 22.

- [ ] **Step 7: Rebuild the dashboard data**

Run: `node -e "import('./scripts/build-dashboard.mjs').then(m => m.buildDashboardData())"`
Confirm `dashboard/data.js` is regenerated without errors.

- [ ] **Step 8: Run the full test suite one more time**

Run: `npm test`
Expected: PASS (0 failures).

- [ ] **Step 9: Commit the refreshed data**

If Steps 5-8 are clean (no unresolved warnings, tests pass):

```bash
git add data/legacy.json data/mcneil.json dashboard/data.js
git commit -m "data: refresh Legacy and McNeil extraction with occupancy enrichment and Legacy harvest fix"
```

If Steps 5-8 surfaced unresolved warnings that don't have a clear, in-scope code fix, stop here, do not commit `data/*.json`, and report exactly what was found (which months, which warning, what you checked) so the user can decide — consistent with this task's stated hard-gate discipline.
