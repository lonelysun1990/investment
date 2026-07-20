# McNeil Pipeline Bundle Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the McNeil data pipeline so it durably archives raw PDFs, correctly classifies and extracts the multi-report bundles the sponsor sends, and sources the total capital raise from a real document via a real extractor — closing every gap recorded in `docs/superpowers/research/2026-07-20-mcneil-pdf-bundle-findings.md`.

**Architecture:** `classifyDoc()` moves from "one docType per file" to "one or more `{docType, pageRange}` sections per file"; the manifest schema gains a `sections` array (additive, backward compatible); extraction orchestration (`extractMcneilBatch`) loops over sections instead of doing a single per-file docType lookup; `harvestDeal()` gains the ability to classify+archive at download time (folding what used to require a manual `migrate-raw-archive.mjs` run into the live pipeline); and every script touching `data/raw/` resolves that path via a new `resolveArchiveRoot()` helper so it always points at the main checkout regardless of which worktree is running it.

**Tech Stack:** Node.js (`node:test`, `node:child_process`), `pdftotext`/`pdfinfo` (poppler), Playwright over CDP for the live portal.

## Global Constraints

- Every step of `harvestDeal()`/`harvestStaticDocument()` that touches CashFlowPortal must be `page.goto` + real DOM reads/clicks + `page.waitForEvent("download")` — never `page.request`, never `page.on("response"/"request")`, never a direct call to `api.cashflowportal.com`, per `CLAUDE.md`'s hard compliance rule. `npm test` runs `scripts/audit-no-api-calls.mjs`, which fails the build if either banned string (`api.cashflowportal.com`, `__access_token`) appears anywhere under `scripts/`.
- All new/changed extraction and classification logic is tested against real fixture PDFs already committed under `scripts/__fixtures__/mcneil/` (created for this plan from the actual downloaded documents) — never synthetic mock text, per the session's explicit "don't blindly trust the code you wrote" instruction.
- `resolveArchiveRoot()` is used ONLY for the gitignored `data/raw/` path. Never apply it to `data/*.json` output paths (`data/mcneil.json`, `data/legacy.json`, `data/capital.json`, `data/distributions.json`) — those are tracked files meant to be written wherever the current checkout/worktree is, so a PR can carry them.
- `npm test` (which runs `node --test "scripts/**/*.test.mjs"` then the compliance audit) must pass after every task, with zero regressions to existing tests.
- Every new manifest entry keeps a `sections` array; entries missing it (pre-existing manifests written before this plan) are treated by callers as an implicit single section (`[{docType, pageRange: null}]`) — never assume `sections` is present without defaulting.

---

### Task 1: Trailing P&L Detail support in `extractMcneilPnl`

The McNeil sponsor's newest report format ("Trailing Profit And Loss Detail") uses a third header layout `parseMonthHeader` doesn't recognize, prefixes every line-item row with an account code (e.g. `4001.001 Gross Potential Rent`) that breaks `splitRow`'s money-token detection, and labels its rental/other income subtotal rows differently (`Total Net Rental Income` / `Total Other Rental Income` instead of `Total Rental Income` / `Total Other Income`). This task fixes all three, verified against the real bundled PDF pages already committed as `scripts/__fixtures__/mcneil/2025-trailing-pnl-detail.pdf` (pages 3-9 of the real `data/raw/mcneil/2025-10/balance-sheet.pdf`, Oct 2024-Sep 2025).

It also extracts a shared `extractPdfText(pdfPath, pageRange)` helper into a new `scripts/lib/pdf-pages.mjs`, replacing `extract-mcneil.mjs`'s private `fullText` — needed here to support the optional page-range extraction, and reused by Task 2 and Task 5.

**Files:**
- Create: `scripts/lib/pdf-pages.mjs`
- Modify: `scripts/extract-mcneil.mjs`
- Test: `scripts/lib/pdf-pages.test.mjs` (new)
- Test: `scripts/extract-mcneil.test.mjs` (extend)

**Interfaces:**
- Produces: `extractPdfText(pdfPath: string, pageRange?: [number, number]): Promise<string>` — runs `pdftotext -layout [-f start -l end] pdfPath -`; omitting `pageRange` extracts the whole file.
- Produces: `extractMcneilPnl(pdfPath: string, pageRange?: [number, number]): Promise<Map<string, PnlRecord>>` — pageRange is a new, optional second parameter; existing single-argument call sites are unaffected.
- Consumes (Task 5): the `pageRange` parameter, called with a section's `[start, end]` from the manifest.

- [ ] **Step 1: Create `scripts/lib/pdf-pages.mjs` with `extractPdfText`**

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function extractPdfText(pdfPath, pageRange) {
  const args = ["-layout"];
  if (pageRange) args.push("-f", String(pageRange[0]), "-l", String(pageRange[1]));
  args.push(pdfPath, "-");
  const { stdout } = await execFileAsync("pdftotext", args);
  return stdout;
}
```

- [ ] **Step 2: Write a failing test for `extractPdfText`'s page-range support**

Create `scripts/lib/pdf-pages.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPdfText } from "./pdf-pages.mjs";

test("extractPdfText extracts the whole file when no pageRange is given", async () => {
  const text = await extractPdfText("scripts/__fixtures__/mcneil/2025-trailing-pnl-detail.pdf");
  assert.match(text, /Trailing Profit And Loss Detail/);
  assert.match(text, /TOTAL EXPENSE/);
});

test("extractPdfText extracts only the requested page range from a real multi-page file", async () => {
  const text = await extractPdfText("scripts/__fixtures__/mcneil/2025-10-balance-sheet-bundle.pdf", [3, 3]);
  assert.match(text, /Trailing Profit And Loss Detail/);
  assert.doesNotMatch(text, /Rent Roll Summary/, "page 3 alone must not contain the rent roll section");
});
```

- [ ] **Step 3: Run the new test to verify it fails**

Run: `node --test scripts/lib/pdf-pages.test.mjs`
Expected: FAIL with `Cannot find module './pdf-pages.mjs'` (module doesn't exist as a resolvable test target yet — it does from Step 1, so this instead confirms the test file itself runs; if Step 1 already passed, skip to Step 4). If Step 1's file exists, this step should already PASS — in that case note it and continue; the meaningful failing-test gate for this task is Step 5 below (`extractMcneilPnl`).

- [ ] **Step 4: Run the passing test to confirm `extractPdfText` works**

Run: `node --test scripts/lib/pdf-pages.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Write failing tests for the Trailing P&L Detail format in `extractMcneilPnl`**

Add to `scripts/extract-mcneil.test.mjs` (new fixture constant + new tests):

```js
const TRAILING_PNL_FIXTURE = "scripts/__fixtures__/mcneil/2025-trailing-pnl-detail.pdf";
```

```js
test("parses the Trailing Profit And Loss Detail header into 12 real months (Oct 2024-Sep 2025)", async () => {
  const result = await extractMcneilPnl(TRAILING_PNL_FIXTURE);
  assert.equal(result.size, 12);
  assert.deepEqual([...result.keys()], [
    "2024-10", "2024-11", "2024-12", "2025-01", "2025-02", "2025-03",
    "2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09",
  ]);
});

test("extracts the rental/other income breakdown from account-code-prefixed subtotal rows", async () => {
  const result = await extractMcneilPnl(TRAILING_PNL_FIXTURE);
  const oct = result.get("2024-10");
  assert.equal(oct.income.rental, 21148.00);
  assert.equal(oct.income.other, 623.00);
  assert.equal(oct.income.total, 21771.00);
});

test("matches existing verified net income figures for Oct-Dec 2024 (cross-check against the older aggregate-only report)", async () => {
  const result = await extractMcneilPnl(TRAILING_PNL_FIXTURE);
  assert.equal(result.get("2024-10").netIncome, -11374.71);
  assert.equal(result.get("2024-11").netIncome, -16364.47);
  assert.equal(result.get("2024-12").netIncome, -11270.67);
});

test("extracts the final month (Sep 2025) correctly, including income/expense internal consistency", async () => {
  const result = await extractMcneilPnl(TRAILING_PNL_FIXTURE);
  const sep = result.get("2025-09");
  assert.equal(sep.income.rental, 22660.00);
  assert.equal(sep.income.other, 39.00);
  assert.equal(sep.income.total, 22699.00);
  assert.equal(sep.expense.total, 15282.80);
  assert.equal(sep.noi, 7416.20);
  assert.equal(sep.netIncome, 180.39);
});

test("flags the Trailing P&L Detail report as aggregate-only, same as the older annual report", async () => {
  const result = await extractMcneilPnl(TRAILING_PNL_FIXTURE);
  for (const month of result.keys()) {
    assert.equal(result.get(month).expenseIsAggregateOnly, true, `${month} should be flagged aggregate-only`);
  }
});

test("extractMcneilPnl accepts an optional pageRange and extracts only that range from a larger file", async () => {
  const result = await extractMcneilPnl("scripts/__fixtures__/mcneil/2025-10-balance-sheet-bundle.pdf", [3, 9]);
  assert.equal(result.size, 12);
  assert.equal(result.get("2024-10").netIncome, -11374.71);
});
```

- [ ] **Step 6: Run the new tests to verify they fail**

Run: `node --test scripts/extract-mcneil.test.mjs`
Expected: FAIL — `parseMonthHeader` throws `"could not find table header row"` for the new fixture (neither existing header variant matches "Account   Actual   Actual ... Total   Variance").

- [ ] **Step 7: Fix `splitRow`'s money-token false positive on account-code prefixes**

In `scripts/extract-mcneil.mjs`, change the `moneyToken` regex inside `splitRow` (the account code `4001.001` was matching as if it were a money value, since `\.\d{2}` matched the first two of its three decimal digits):

```js
function splitRow(line) {
  const moneyToken = /-?\(?\$?[\d,]+\.\d{2}(?!\d)\)?/;
  const firstMoneyMatch = line.match(new RegExp(`\\s{2,}${moneyToken.source}`));
  if (!firstMoneyMatch) return null;
  const label = line.slice(0, firstMoneyMatch.index).trim();
  const rest = line.slice(firstMoneyMatch.index).trim();
  const values = rest.split(/\s{2,}/).filter(Boolean).map(parseMoney);
  return { label, values };
}
```

- [ ] **Step 8: Add the third `parseMonthHeader` layout variant**

In `scripts/extract-mcneil.mjs`, add a third branch to `parseMonthHeader`, after the existing "older report layout" branch and before the final `throw`:

```js
export function parseMonthHeader(text) {
  const lines = text.split("\n");

  // Usual layout: "Account   Jul 2025   Aug 2025   ...   Total" on one line.
  const inlineHeaderLine = lines.find((l) => /^Account\s+\w{3} \d{4}/.test(l.trim()));
  if (inlineHeaderLine) {
    const monthLabels = inlineHeaderLine
      .replace(/^Account/, "")
      .trim()
      .split(/\s{2,}/)
      .filter(Boolean);
    return monthLabels.slice(0, -1).map(toMonthKey);
  }

  // Older report layout: a lone "Account" line, with the month/year labels
  // on the line immediately before it instead of sharing the same line.
  const accountLineIndex = lines.findIndex((l) => l.trim() === "Account");
  if (accountLineIndex > 0) {
    const monthLabels = lines[accountLineIndex - 1]
      .trim()
      .split(/\s{2,}/)
      .filter(Boolean);
    if (monthLabels.length > 1 && /^\w{3} \d{4}$/.test(monthLabels[0])) {
      return monthLabels.slice(0, -1).map(toMonthKey);
    }
  }

  // Trailing Profit And Loss Detail layout: "Account   Actual   Actual  ...
  // Total   Variance", with month/year labels on the line immediately
  // before it, ending in "Adjusted" (for "Adjusted Total") instead of a
  // bare "Total".
  const accountActualLineIndex = lines.findIndex((l) => /^Account\s+Actual(\s+Actual)*/.test(l.trim()));
  if (accountActualLineIndex > 0) {
    const monthLabels = lines[accountActualLineIndex - 1]
      .trim()
      .split(/\s{2,}/)
      .filter(Boolean);
    if (monthLabels.length > 1 && /^\w{3} \d{4}$/.test(monthLabels[0])) {
      return monthLabels.slice(0, -1).map(toMonthKey);
    }
  }

  throw new Error("extract-mcneil: could not find table header row");
}
```

- [ ] **Step 9: Normalize account-code-prefixed labels and add the rental/other income aliases**

In `scripts/extract-mcneil.mjs`, inside `extractMcneilPnl`'s row loop, replace the block that computes `perMonth` and does the label-matching switch:

```js
    if (!row) continue;
    const label = row.label.replace(/^\d+\.\d+\s+/, "");
    const perMonth = row.values.slice(0, monthKeys.length);
    if (perMonth.length !== monthKeys.length) continue;

    monthKeys.forEach((key, i) => {
      const rec = months.get(key);
      const value = perMonth[i];
      if (label === "Total Rental Income" || label === "Total Net Rental Income") rec.income.rental = value;
      else if (label === "Total Other Income" || label === "Total Other Rental Income") rec.income.other = value;
      else if (label === "TOTAL INCOME") rec.income.total = value;
      else if (label === "NET OPERATING INCOME") rec.noi = value;
      else if (label === "Total Debt Service") rec.debtService = value;
      else if (label === "Total Capital Improvements") rec.capitalImprovements = value;
      else if (label === "NET INCOME") {
        rec.netIncome = value;
      } else if (label === "TOTAL EXPENSE") {
        rec.expense.total = value;
        aggregateExpenseMonths.add(key);
      } else if (label === "TOTAL NON-OPERATING EXPENSE") {
        aggregateOnlyMonths.add(key);
      } else if (/^Total /.test(label)) {
        rec.expense[label.replace(/^Total /, "")] = value;
      }
    });

    if (label === "NET INCOME") reachedNetIncome = true;
```

(This replaces every remaining `row.label` reference in this block with the normalized `label`.)

- [ ] **Step 10: Replace `extract-mcneil.mjs`'s private `fullText` with the shared `extractPdfText`, and add the `pageRange` parameter**

In `scripts/extract-mcneil.mjs`:
- Delete the private `fullText` function.
- Add `import { extractPdfText } from "./lib/pdf-pages.mjs";` near the top imports.
- Change `extractMcneilPnl` and `extractMcneilDistributions` signatures and their internal call:

```js
export async function extractMcneilPnl(pdfPath, pageRange) {
  const text = await extractPdfText(pdfPath, pageRange);
  const lines = text.split("\n");
  const monthKeys = parseMonthHeader(text);
  // ...rest unchanged...
```

```js
export async function extractMcneilDistributions(pdfPath, labelPattern, pageRange) {
  const text = await extractPdfText(pdfPath, pageRange);
  const monthKeys = parseMonthHeader(text);
  // ...rest unchanged...
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `node --test scripts/extract-mcneil.test.mjs scripts/lib/pdf-pages.test.mjs`
Expected: PASS, all tests (existing + new)

- [ ] **Step 12: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 13: Commit**

```bash
git add scripts/lib/pdf-pages.mjs scripts/lib/pdf-pages.test.mjs scripts/extract-mcneil.mjs scripts/extract-mcneil.test.mjs scripts/__fixtures__/mcneil/2025-trailing-pnl-detail.pdf scripts/__fixtures__/mcneil/2025-10-balance-sheet-bundle.pdf
git commit -m "feat: extract Trailing P&L Detail report format in extractMcneilPnl

Fixes a splitRow false-positive on account-code prefixes, adds the
report's third parseMonthHeader layout variant, and aliases its
'Total Net Rental Income'/'Total Other Rental Income' labels so the
rental/other income breakdown populates correctly. Verified against
the real Oct 2024-Sep 2025 bundle page range."
```

---

### Task 2: New `extract-mcneil-rentroll-pdf.mjs`

The Rent Roll Summary sections buried in the bundled PDFs carry a ready-made "Property Occupancy" summary table (`Total Occupied ... 29   90.6%   ...`), computed by the source system itself — simpler and more authoritative than re-deriving occupancy by counting individual unit rows the way the existing XLSX parser does. Verified against both real Rent Roll Summary fixtures (9/30/2025 and 12/31/2025).

**Files:**
- Create: `scripts/extract-mcneil-rentroll-pdf.mjs`
- Test: `scripts/extract-mcneil-rentroll-pdf.test.mjs`

**Interfaces:**
- Produces: `extractRentRollPdf(pdfPath: string, pageRange?: [number, number]): Promise<{asOfDate, totalUnits, occupiedUnits, vacantUnits, occupancyPct}>`
- Consumes (Task 5): called per `rentroll-pdf`-typed section found in a batch's manifest.

- [ ] **Step 1: Write the failing tests**

Create `scripts/extract-mcneil-rentroll-pdf.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRentRollPdf } from "./extract-mcneil-rentroll-pdf.mjs";

test("extracts occupancy from the real 9/30/2025 Rent Roll Summary", async () => {
  const result = await extractRentRollPdf("scripts/__fixtures__/mcneil/2025-09-rentroll-summary.pdf");
  assert.equal(result.asOfDate, "2025-09-30");
  assert.equal(result.totalUnits, 32);
  assert.equal(result.occupiedUnits, 29);
  assert.equal(result.vacantUnits, 3);
  assert.equal(result.occupancyPct, 90.6);
});

test("extracts occupancy from the real 12/31/2025 Rent Roll Summary", async () => {
  const result = await extractRentRollPdf("scripts/__fixtures__/mcneil/2025-12-rentroll-summary.pdf");
  assert.equal(result.asOfDate, "2025-12-31");
  assert.equal(result.occupiedUnits, 27);
  assert.equal(result.vacantUnits, 5);
  assert.equal(result.occupancyPct, 84.4);
});

test("accepts a pageRange and extracts only that section from a larger bundled file", async () => {
  const result = await extractRentRollPdf("scripts/__fixtures__/mcneil/2025-10-balance-sheet-bundle.pdf", [10, 11]);
  assert.equal(result.asOfDate, "2025-09-30");
  assert.equal(result.occupancyPct, 90.6);
});

test("throws a clear error when the Property Occupancy summary is missing", async () => {
  await assert.rejects(
    () => extractRentRollPdf("scripts/__fixtures__/mcneil/2025-trailing-pnl-detail.pdf"),
    /could not find Property Occupancy summary/
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/extract-mcneil-rentroll-pdf.test.mjs`
Expected: FAIL with `Cannot find module './extract-mcneil-rentroll-pdf.mjs'`

- [ ] **Step 3: Implement `extract-mcneil-rentroll-pdf.mjs`**

```js
import { extractPdfText } from "./lib/pdf-pages.mjs";

export async function extractRentRollPdf(pdfPath, pageRange) {
  const text = await extractPdfText(pdfPath, pageRange);

  const asOfMatch = text.match(/Rent Roll Summary\s*\n\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const asOfDate = asOfMatch
    ? `${asOfMatch[3]}-${asOfMatch[1].padStart(2, "0")}-${asOfMatch[2].padStart(2, "0")}`
    : null;

  const occupiedMatch = text.match(/^Total\s+Occupied\s+[\d,]+\.\d{2}\s+[\d.]+%\s+(\d+)\s+([\d.]+)%/m);
  const vacantMatch = text.match(/^Total\s+Vacant\s+[\d,]+\.\d{2}\s+[\d.]+%\s+(\d+)\s+([\d.]+)%/m);
  if (!occupiedMatch || !vacantMatch) {
    throw new Error(`extract-mcneil-rentroll-pdf: could not find Property Occupancy summary in ${pdfPath}`);
  }

  const occupiedUnits = Number(occupiedMatch[1]);
  const vacantUnits = Number(vacantMatch[1]);
  return {
    asOfDate,
    totalUnits: occupiedUnits + vacantUnits,
    occupiedUnits,
    vacantUnits,
    occupancyPct: Number(occupiedMatch[2]),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/extract-mcneil-rentroll-pdf.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 6: Commit**

```bash
git add scripts/extract-mcneil-rentroll-pdf.mjs scripts/extract-mcneil-rentroll-pdf.test.mjs scripts/__fixtures__/mcneil/2025-09-rentroll-summary.pdf scripts/__fixtures__/mcneil/2025-12-rentroll-summary.pdf
git commit -m "feat: add PDF-table rent roll extractor using the report's own occupancy summary

Parses the Rent Roll Summary section's 'Property Occupancy' table
directly (Total Occupied/Vacant by unit count) rather than re-deriving
occupancy from per-unit rows -- simpler, and matches what the source
system itself already computed. Verified against both real 9/30/2025
and 12/31/2025 snapshots."
```

---

### Task 3: `resolveArchiveRoot()` and manifest `sections` support

Fixes the root cause of findings §1: `data/raw/` is gitignored, and every script resolved it relative to `process.cwd()` — so migration/reorganization work done inside this worktree never reached the main checkout. `resolveArchiveRoot()` walks `git rev-parse --git-common-dir` → parent directory (the same technique `finishing-a-development-branch` already uses for `MAIN_ROOT`), so it always resolves to the one real main-checkout `data/raw/`, regardless of which worktree runs it.

Also adds an additive `sections` field to the manifest schema (needed by Task 4's bundle-aware classification) without changing `archiveFile`'s existing signature or breaking any existing caller/test.

**Files:**
- Modify: `scripts/lib/archive-store.mjs`
- Modify: `scripts/extract-mcneil.mjs` (CLI entrypoint only)
- Modify: `scripts/extract-legacy.mjs` (CLI entrypoint only)
- Modify: `scripts/harvest.mjs` (CLI entrypoint only)
- Modify: `scripts/refresh.mjs`
- Test: `scripts/lib/archive-store.test.mjs` (extend)

**Interfaces:**
- Produces: `resolveArchiveRoot(): string` — absolute path to `<main-checkout-root>/data/raw`.
- Produces: `archiveFile(dealRawDir, batchKey, docType, ext, buffer, meta = {})` — unchanged signature; `meta.sections` is a new optional field, defaulting to `[{docType, pageRange: null}]` when omitted.
- Consumes (Tasks 5, 8): `meta.sections` populated with real `{docType, pageRange}` arrays for bundled files.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/lib/archive-store.test.mjs`:

```js
test("resolveArchiveRoot resolves to the same path regardless of the calling subdirectory's cwd", async () => {
  const { execFileSync } = await import("node:child_process");
  const path = (await import("node:path")).default;
  const fromRepoRoot = resolveArchiveRoot();
  assert.ok(fromRepoRoot.endsWith(path.join("data", "raw")));

  const script = `import { resolveArchiveRoot } from ${JSON.stringify(path.resolve("scripts/lib/archive-store.mjs"))}; console.log(resolveArchiveRoot());`;
  const fromSubdir = execFileSync("node", ["--input-type=module", "-e", script], {
    cwd: "scripts/lib",
    encoding: "utf8",
  }).trim();
  assert.equal(fromSubdir, fromRepoRoot, "must resolve identically whether run from repo root or a subdirectory");
});

test("archiveFile records a real sections array in the manifest when provided via meta.sections", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  const sections = [
    { docType: "balance-sheet", pageRange: [1, 2] },
    { docType: "trailing-pnl-detail", pageRange: [3, 9] },
  ];
  await archiveFile(TMP_DIR, "2025-10", "balance-sheet", "pdf", Buffer.from("bundle-content"), { sections });
  const manifest = await loadManifest(`${TMP_DIR}/2025-10`);
  assert.deepEqual(manifest.files[0].sections, sections);
  await rm(TMP_DIR, { recursive: true, force: true });
});

test("archiveFile defaults sections to a single implicit section when meta.sections is omitted", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await archiveFile(TMP_DIR, "2026-01", "cashflow-t12", "pdf", Buffer.from("report-a"), {});
  const manifest = await loadManifest(`${TMP_DIR}/2026-01`);
  assert.deepEqual(manifest.files[0].sections, [{ docType: "cashflow-t12", pageRange: null }]);
  await rm(TMP_DIR, { recursive: true, force: true });
});
```

Update the test file's import line to include `resolveArchiveRoot`:

```js
import { hashContent, archiveFile, findDuplicateHash, loadManifest, resolveArchiveRoot } from "./archive-store.mjs";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/lib/archive-store.test.mjs`
Expected: FAIL — `resolveArchiveRoot is not a function` / `manifest.files[0].sections` is `undefined`

- [ ] **Step 3: Implement `resolveArchiveRoot` and the `sections` default in `archiveFile`**

In `scripts/lib/archive-store.mjs`, add near the top (after existing imports):

```js
import { execSync } from "node:child_process";
```

Add the new export (anywhere before `archiveFile`):

```js
export function resolveArchiveRoot() {
  const gitCommonDir = execSync("git rev-parse --path-format=absolute --git-common-dir", {
    encoding: "utf8",
  }).trim();
  const mainRoot = path.dirname(gitCommonDir);
  return path.join(mainRoot, "data", "raw");
}
```

In `archiveFile`, change the `manifest.files.push` call to add `sections`:

```js
  manifest.files.push({
    docType,
    fileName,
    contentHash,
    sections: meta.sections ?? [{ docType, pageRange: null }],
    sourceEmailSubject: meta.sourceEmailSubject ?? null,
    harvestedAt: meta.harvestedAt ?? new Date().toISOString(),
    batchDateSource: meta.batchDateSource ?? "content",
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/lib/archive-store.test.mjs`
Expected: PASS, all tests (existing + new)

- [ ] **Step 5: Wire `resolveArchiveRoot()` into every CLI entrypoint that hardcodes `data/raw`**

In `scripts/extract-mcneil.mjs`, change the CLI block at the bottom:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runMcneilExtraction(path.join(resolveArchiveRoot(), "mcneil"), "data/mcneil.json");
  console.log(`Processed months: ${result.monthsProcessed.join(", ") || "(none)"}`);
}
```

Add `resolveArchiveRoot` to its existing `import { extractRentRoll } from "./extract-mcneil-rentroll.mjs";` block area — add a new import line: `import { resolveArchiveRoot } from "./lib/archive-store.mjs";` (`path` is already imported in this file).

In `scripts/extract-legacy.mjs`, find the CLI block's `runLegacyExtraction(config, "data/raw/legacy", "data/legacy.json")` call and change it to:

```js
  const result = await runLegacyExtraction(config, path.join(resolveArchiveRoot(), "legacy"), "data/legacy.json");
```

Add `import path from "node:path";` and `import { resolveArchiveRoot } from "./lib/archive-store.mjs";` to its imports if not already present.

In `scripts/harvest.mjs`, change the CLI block's loop:

```js
  for (const [slug, deal] of Object.entries(config.deals)) {
    const result = await harvestDeal(page, deal.dealId, slug, path.join(resolveArchiveRoot(), slug));
    console.log(`${slug}: ${result.newMonths.length ? result.newMonths.join(", ") : "no new months"}`);
  }
```

Add `import { resolveArchiveRoot } from "./lib/archive-store.mjs";` (`path` is already imported).

In `scripts/refresh.mjs`, change all three `data/raw/...` call sites:

```js
  for (const [slug, deal] of Object.entries(config.deals)) {
    await harvestDeal(page, deal.dealId, slug, path.join(resolveArchiveRoot(), slug));
  }

  const legacyResult = await runLegacyExtraction(config.vision_llm ?? null, path.join(resolveArchiveRoot(), "legacy"), "data/legacy.json");
  const mcneilResult = await runMcneilExtraction(path.join(resolveArchiveRoot(), "mcneil"), "data/mcneil.json");
```

Add `import path from "node:path";` and `import { resolveArchiveRoot } from "./lib/archive-store.mjs";` to its imports.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/archive-store.mjs scripts/lib/archive-store.test.mjs scripts/extract-mcneil.mjs scripts/extract-legacy.mjs scripts/harvest.mjs scripts/refresh.mjs
git commit -m "fix: resolve data/raw/ to the main checkout regardless of worktree

Adds resolveArchiveRoot(), which walks git rev-parse --git-common-dir
to the main checkout root -- the same technique finishing-a-
development-branch already uses -- so raw-archive writes never again
get stranded in a worktree-local copy. Also adds an additive
'sections' field to manifest entries, defaulting to a single implicit
section for backward compatibility."
```

---

### Task 4: Bundle-aware `classifyDoc()` for McNeil, and its migration wiring

Adds `extractPagesFromPdf` (whole-file, split on `pdftotext`'s form-feed page separators — one subprocess call instead of one per page) to `scripts/lib/pdf-pages.mjs`, and rewrites `mcneil.config.mjs`'s `classifyDoc()` to scan every page's text independently and return an array of `{docType, pageRange}` sections instead of a single docType for the whole file. Verified against the real 13-page bundle: produces exactly the 5 sections recorded in the findings doc.

`classifyDoc`'s only caller, `migrate-raw-archive.mjs`, is updated in the same task (not a separate one): it's the sole place that needs to extract per-page text and normalize `classifyDoc`'s result shape (array for McNeil, bare string for Legacy — `legacy.config.mjs` itself is untouched). Splitting the rewrite from its only caller update would leave `npm test` red on the rewrite's own commit (`migrate-raw-archive.test.mjs` would fail against the new call shape) — this task lands both together so every commit keeps the suite green, per this plan's Global Constraints.

**Files:**
- Modify: `scripts/lib/pdf-pages.mjs`
- Modify: `scripts/deals/mcneil.config.mjs`
- Modify: `scripts/migrate-raw-archive.mjs`
- Test: `scripts/lib/pdf-pages.test.mjs` (extend)
- Test: `scripts/deals/mcneil.config.test.mjs` (rewrite)
- Test: `scripts/migrate-raw-archive.test.mjs` (extend)

**Interfaces:**
- Produces: `extractPagesFromPdf(pdfPath: string): Promise<string[]>` — one entry per PDF page.
- Produces (breaking change to `mcneil.config.mjs`'s `classifyDoc`, additive to its call sites): `classifyDoc({filename, pages}): Array<{docType: string, pageRange: [number,number] | null}>`. `legacy.config.mjs`'s `classifyDoc` is untouched — it still takes `{filename, text}` and returns a bare string; this task's `migrate-raw-archive.mjs` update normalizes both shapes at the call site.
- Produces: `planMigration`/`runMigration` results gain a `sections` field per entry (existing `docType`, `batchKey`, `written`, `duplicateOf` fields are unchanged).
- Consumes: `archiveFile`'s `meta.sections` (Task 3).
- Consumes (Task 5): `extractPagesFromPdf`, `classifyDoc`'s new return shape, both reused by `extractMcneilBatch`.

- [ ] **Step 1: Write the failing test for `extractPagesFromPdf`**

Add to `scripts/lib/pdf-pages.test.mjs`:

```js
test("extractPagesFromPdf splits a real 13-page bundle into 13 page-text entries", async () => {
  const pages = await extractPagesFromPdf("scripts/__fixtures__/mcneil/2025-10-balance-sheet-bundle.pdf");
  assert.equal(pages.length, 13);
  assert.match(pages[0], /Balance Sheet/);
  assert.match(pages[2], /Trailing Profit And Loss Detail/);
  assert.match(pages[9], /Rent Roll Summary/);
  assert.match(pages[11], /Aged Receivables Summary/);
  assert.match(pages[12], /Cash Flow Statement Detail/);
});
```

Update the import line: `import { extractPdfText, extractPagesFromPdf } from "./pdf-pages.mjs";`

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/lib/pdf-pages.test.mjs`
Expected: FAIL — `extractPagesFromPdf is not a function`

- [ ] **Step 3: Implement `extractPagesFromPdf`**

Add to `scripts/lib/pdf-pages.mjs`:

```js
export async function extractPagesFromPdf(pdfPath) {
  const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"]);
  const pages = stdout.split("\f");
  if (pages.length > 1 && pages[pages.length - 1].trim() === "") pages.pop();
  return pages;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/lib/pdf-pages.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Rewrite `scripts/deals/mcneil.config.test.mjs` for the new signature and shape**

Replace the entire file:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDoc, distributionLabel, totalRaiseLabel } from "./mcneil.config.mjs";
import { extractPagesFromPdf } from "../lib/pdf-pages.mjs";

test("classifies a twelve-month cash flow PDF as cashflow-t12", () => {
  const pages = ["Twelve Month Cash Flow Statement Expanded Detail\nJune 2026 - Accrual"];
  assert.deepEqual(classifyDoc({ filename: "cashflow.pdf", pages }), [{ docType: "cashflow-t12", pageRange: [1, 1] }]);
});

test("classifies a twelve-month profit and loss PDF as cashflow-t12", () => {
  const pages = ["Twelve Month Profit and Loss\nJanuary 2024 - December 2024"];
  assert.deepEqual(classifyDoc({ filename: "T12.pdf", pages }), [{ docType: "cashflow-t12", pageRange: [1, 1] }]);
});

test("classifies a balance sheet PDF as balance-sheet", () => {
  const pages = ["McNeil Star\nGolden Group Multifamily LLC\nBalance Sheet\nDecember 2024"];
  assert.deepEqual(classifyDoc({ filename: "BalanceSheet.pdf", pages }), [{ docType: "balance-sheet", pageRange: [1, 1] }]);
});

test("classifies an xlsx file as rentroll regardless of content", () => {
  assert.deepEqual(classifyDoc({ filename: "rentroll.xlsx", pages: [] }), [{ docType: "rentroll", pageRange: null }]);
});

test("classifies an offering memorandum as offering-doc", () => {
  const pages = ["McNeil Star Apartments Private Placement Memorandum"];
  assert.deepEqual(classifyDoc({ filename: "offering.pdf", pages }), [{ docType: "offering-doc", pageRange: [1, 1] }]);
});

test("returns unknown for unrecognized content", () => {
  assert.deepEqual(classifyDoc({ filename: "random.pdf", pages: ["Just some text"] }), [{ docType: "unknown", pageRange: [1, 1] }]);
});

test("classifies an offering memorandum that also mentions balance sheet/cash flow as offering-doc, not the generic type", () => {
  const pages = ["McNeil Star Apartments Private Placement Memorandum\n\nExhibit C: Balance Sheet and Twelve Month Cash Flow Statement"];
  assert.deepEqual(classifyDoc({ filename: "offering.pdf", pages }), [{ docType: "offering-doc", pageRange: [1, 1] }]);
});

test("classifies a real 13-page bundled report into 5 distinct sections by page range", async () => {
  const pages = await extractPagesFromPdf("scripts/__fixtures__/mcneil/2025-10-balance-sheet-bundle.pdf");
  const sections = classifyDoc({ filename: "balance-sheet.pdf", pages });
  assert.deepEqual(sections, [
    { docType: "balance-sheet", pageRange: [1, 2] },
    { docType: "trailing-pnl-detail", pageRange: [3, 9] },
    { docType: "rentroll-pdf", pageRange: [10, 11] },
    { docType: "aged-receivables", pageRange: [12, 12] },
    { docType: "cashflow-detail", pageRange: [13, 13] },
  ]);
});

test("distributionLabel matches the exact 'Member's Distribution' row label, not its Total subtotal", () => {
  assert.ok(distributionLabel.test("Member's Distribution"));
  assert.ok(!distributionLabel.test("Total Member's Contribut"));
});

test("totalRaiseLabel matches common offering-amount phrasing", () => {
  assert.ok(totalRaiseLabel.test("Total Offering Amount: $1,930,000"));
  assert.ok(totalRaiseLabel.test("Total Capital Raised 1,300,000"));
});

test("totalRaiseLabel matches the real McNeil PPM's Sources of Funds equity line", () => {
  assert.ok(totalRaiseLabel.test("Equity (from the proceeds of this Offering)                                 $1,500,000"));
});

test("totalRaiseLabel does not match a bare grand-total line that isn't specifically about the offering amount", () => {
  assert.ok(!totalRaiseLabel.test("Total"));
  assert.ok(!totalRaiseLabel.test("                                                Total                        $2,698,000"));
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `node --test scripts/deals/mcneil.config.test.mjs`
Expected: FAIL — `classifyDoc` still expects `{filename, text}` and returns a bare string.

- [ ] **Step 7: Rewrite `classifyDoc` in `scripts/deals/mcneil.config.mjs`**

```js
export const dealSlug = "mcneil";

const SECTION_PATTERNS = [
  { docType: "offering-doc", pattern: /subscription agreement|offering memorandum|private placement/i },
  { docType: "trailing-pnl-detail", pattern: /trailing profit and loss detail/i },
  { docType: "cashflow-t12", pattern: /twelve month (profit and loss|cash flow)/i },
  { docType: "balance-sheet", pattern: /balance sheet/i },
  { docType: "rentroll-pdf", pattern: /rent roll summary/i },
  { docType: "aged-receivables", pattern: /aged receivables summary/i },
  { docType: "cashflow-detail", pattern: /cash flow statement detail/i },
];

export function classifyDoc({ filename, pages }) {
  if (filename.toLowerCase().endsWith(".xlsx")) return [{ docType: "rentroll", pageRange: null }];

  const sections = [];
  for (let i = 0; i < pages.length; i++) {
    const pageNum = i + 1;
    const match = SECTION_PATTERNS.find(({ pattern }) => pattern.test(pages[i]));
    const docType = match ? match.docType : "unknown";
    const last = sections[sections.length - 1];
    if (last && last.docType === docType) last.pageRange[1] = pageNum;
    else sections.push({ docType, pageRange: [pageNum, pageNum] });
  }
  return sections.length ? sections : [{ docType: "unknown", pageRange: null }];
}

export const distributionLabel = /^Member's Distribution$/i;
export const totalRaiseLabel = /Total (Offering Amount|Capital Rais(?:e|ed))|Equity.*proceeds of this Offering/i;
export const occupancySource = "rentroll";
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test scripts/deals/mcneil.config.test.mjs`
Expected: PASS (11 tests)

Do not run the full suite or commit yet — `migrate-raw-archive.test.mjs` still calls `classifyDoc` with the old `{filename, text}` shape and would fail against `pages` being `undefined`. Continue directly to the migration wiring below before checking `npm test` or committing, so this task's single commit lands with the suite green throughout.

- [ ] **Step 9: Write the failing test for bundle migration**

Add to `scripts/migrate-raw-archive.test.mjs`:

```js
import path from "node:path";
```

(add near the existing imports if not already present)

```js
test("migrates a real multi-report bundled PDF, storing all 5 sections in the manifest", async () => {
  const NEW_DIR = "scripts/__fixtures__/tmp-migrated-mcneil-bundle";
  await rm(NEW_DIR, { recursive: true, force: true });
  const results = await runMigration("scripts/__fixtures__/raw-mcneil-bundle", NEW_DIR, mcneilConfig);

  const bundleResult = results.find((r) => r.oldPath.endsWith("balance-sheet.pdf"));
  assert.equal(bundleResult.docType, "balance-sheet");
  assert.equal(bundleResult.written, true);

  const manifest = JSON.parse(
    await readFile(path.join(NEW_DIR, bundleResult.batchKey, "manifest.json"), "utf8")
  );
  const entry = manifest.files.find((f) => f.fileName === "balance-sheet.pdf");
  assert.deepEqual(entry.sections, [
    { docType: "balance-sheet", pageRange: [1, 2] },
    { docType: "trailing-pnl-detail", pageRange: [3, 9] },
    { docType: "rentroll-pdf", pageRange: [10, 11] },
    { docType: "aged-receivables", pageRange: [12, 12] },
    { docType: "cashflow-detail", pageRange: [13, 13] },
  ]);

  await rm(NEW_DIR, { recursive: true, force: true });
});
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `node --test scripts/migrate-raw-archive.test.mjs`
Expected: FAIL — `classifyDoc` now expects `{filename, pages}` (Step 7 above) but `planMigration` still only passes `{filename, text}`; `pages` is `undefined` inside `classifyDoc`.

- [ ] **Step 11: Rewrite `planMigration` and `runMigration`**

Replace the top of `scripts/migrate-raw-archive.mjs`:

```js
// scripts/migrate-raw-archive.mjs
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { archiveFile } from "./lib/archive-store.mjs";
import { resolveBatchDate } from "./lib/batch-date.mjs";
import { extractPagesFromPdf } from "./lib/pdf-pages.mjs";

export async function planMigration(oldRawDir, dealConfig) {
  const monthDirs = (await readdir(oldRawDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const plan = [];
  for (const monthDir of monthDirs) {
    const dirPath = path.join(oldRawDir, monthDir);
    const files = (await readdir(dirPath, { withFileTypes: true })).filter(
      (f) => f.isFile() && f.name !== "manifest.json"
    );
    for (const file of files) {
      const filePath = path.join(dirPath, file.name);
      const buffer = await readFile(filePath);
      const ext = path.extname(file.name).replace(".", "");
      const pages = ext.toLowerCase() === "pdf" ? await extractPagesFromPdf(filePath).catch(() => []) : [];
      const text = pages.join("\n");
      const rawResult = dealConfig.classifyDoc({ filename: file.name, pages, text });
      const sections = Array.isArray(rawResult) ? rawResult : [{ docType: rawResult, pageRange: null }];
      const docType = sections[0].docType;
      const harvestedAt = `${monthDir}-01T00:00:00.000Z`;
      const { batchKey, source } = resolveBatchDate({ text, harvestedAt });
      plan.push({ oldPath: filePath, batchKey, docType, sections, ext, buffer, source, harvestedAt });
    }
  }
  return plan;
}

export async function runMigration(oldRawDir, newRawDir, dealConfig) {
  const plan = await planMigration(oldRawDir, dealConfig);
  const results = [];
  for (const entry of plan) {
    const result = await archiveFile(newRawDir, entry.batchKey, entry.docType, entry.ext, entry.buffer, {
      batchDateSource: entry.source,
      harvestedAt: entry.harvestedAt,
      sections: entry.sections,
    });
    results.push({ ...entry, ...result });
  }
  return results;
}
```

Leave the file's CLI block (`if (import.meta.url === ...)`) unchanged — it already takes `oldDir`/`newDir` as explicit CLI arguments, not a hardcoded path, so it needs no `resolveArchiveRoot()` wiring.

- [ ] **Step 12: Run the migration test to verify it passes**

Run: `node --test scripts/migrate-raw-archive.test.mjs`
Expected: PASS, all tests (existing 4 + new bundle test)

- [ ] **Step 13: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures — this is the first point in this task where the full suite is checked; both the `classifyDoc` rewrite and the `migrate-raw-archive.mjs` caller update are in place together, so nothing should be red.

- [ ] **Step 14: Commit**

```bash
git add scripts/lib/pdf-pages.mjs scripts/lib/pdf-pages.test.mjs scripts/deals/mcneil.config.mjs scripts/deals/mcneil.config.test.mjs scripts/migrate-raw-archive.mjs scripts/migrate-raw-archive.test.mjs scripts/__fixtures__/raw-mcneil-bundle
git commit -m "feat: bundle-aware classifyDoc for McNeil, and its migration wiring

classifyDoc now scans every page independently and returns an array of
{docType, pageRange} sections, so a single downloaded PDF that bundles
multiple distinct reports (as McNeil's sponsor does) no longer gets
the whole file silently misclassified as whatever the first page's
title says. planMigration extracts per-page text and normalizes
classifyDoc's result (array for McNeil, bare string for Legacy,
unchanged) at the call site. Verified end-to-end against the real
13-page bundle, producing exactly the 5 sections found by hand in the
research doc."
```

---

### Task 5: `extractMcneilBatch` orchestration for sections

Rewrites the batch-extraction orchestrator to gather P&L-bearing sections (`cashflow-t12` and `trailing-pnl-detail`) and occupancy-bearing sections (`rentroll` and `rentroll-pdf`) across *all* sections of *all* files in a batch, instead of looking up a single file by a single docType. Distributions are only pulled from `cashflow-t12` sections (verified: the Trailing P&L Detail report never contains a `Member's Distribution` row). Fully backward compatible with existing pre-bundle manifests (which lack a `sections` field and default to a single implicit section with `pageRange: null`, i.e. "whole file" — exactly matching current behavior).

**Files:**
- Modify: `scripts/extract-mcneil.mjs`
- Test: `scripts/extract-mcneil.test.mjs` (extend)

**Interfaces:**
- Consumes: `extractMcneilPnl(pdfPath, pageRange)` (Task 1), `extractMcneilDistributions(pdfPath, labelPattern, pageRange)` (Task 1), `extractRentRollPdf(pdfPath, pageRange)` (Task 2), manifest entries' `sections` field (Task 3).
- Produces: `extractMcneilBatch(batchDir, manifest): Promise<Map<string, MonthRecord>>` — signature unchanged.

- [ ] **Step 1: Add the `pageRange` parameter to `extractMcneilDistributions`'s call site awareness**

(Already done in Task 1, Step 10 — `extractMcneilDistributions(pdfPath, labelPattern, pageRange)`. This step is a no-op if Task 1 is complete; otherwise apply Task 1 Step 10 first.)

- [ ] **Step 2: Write the failing test for real bundled-batch extraction**

Add to `scripts/extract-mcneil.test.mjs`:

```js
test("extractMcneilBatch extracts P&L, occupancy, and zero distribution from a real bundled multi-report PDF", async () => {
  const TMP_RAW = "scripts/__fixtures__/tmp-mcneil-bundle-batch";
  await rm(TMP_RAW, { recursive: true, force: true });

  const { mkdir, copyFile } = await import("node:fs/promises");
  const { saveManifest, loadManifest } = await import("./lib/archive-store.mjs");

  await mkdir(`${TMP_RAW}/2025-10`, { recursive: true });
  await copyFile(
    "scripts/__fixtures__/mcneil/2025-10-balance-sheet-bundle.pdf",
    `${TMP_RAW}/2025-10/balance-sheet.pdf`
  );
  await saveManifest(`${TMP_RAW}/2025-10`, {
    files: [
      {
        docType: "balance-sheet",
        fileName: "balance-sheet.pdf",
        contentHash: "bundle-hash",
        sections: [
          { docType: "balance-sheet", pageRange: [1, 2] },
          { docType: "trailing-pnl-detail", pageRange: [3, 9] },
          { docType: "rentroll-pdf", pageRange: [10, 11] },
          { docType: "aged-receivables", pageRange: [12, 12] },
          { docType: "cashflow-detail", pageRange: [13, 13] },
        ],
      },
    ],
  });

  const manifest = await loadManifest(`${TMP_RAW}/2025-10`);
  const months = await extractMcneilBatch(`${TMP_RAW}/2025-10`, manifest);

  assert.equal(months.size, 12);
  const oct2024 = months.get("2024-10");
  assert.equal(oct2024.income.rental, 21148);
  assert.equal(oct2024.income.other, 623);
  assert.equal(oct2024.netIncome, -11374.71);
  assert.equal(oct2024.distribution, 0, "trailing-pnl-detail sections never carry a distribution row");

  const sep2025 = months.get("2025-09");
  assert.equal(sep2025.occupancyPct, 90.6, "the batch's own rentroll-pdf section (9/30/2025) should attach to Sep 2025");

  await rm(TMP_RAW, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test scripts/extract-mcneil.test.mjs`
Expected: FAIL — the current `extractMcneilBatch` only looks for a manifest entry with `docType === "cashflow-t12"`, which doesn't exist in this manifest (it's `"balance-sheet"` with sections).

- [ ] **Step 4: Rewrite `extractMcneilBatch`**

In `scripts/extract-mcneil.mjs`, add `import { extractRentRollPdf } from "./extract-mcneil-rentroll-pdf.mjs";` alongside the existing `extractRentRoll` import, then replace `extractMcneilBatch`:

```js
function findSections(manifest, docTypes) {
  const results = [];
  for (const file of manifest.files) {
    const sections = file.sections ?? [{ docType: file.docType, pageRange: null }];
    for (const section of sections) {
      if (docTypes.includes(section.docType)) {
        results.push({ fileName: file.fileName, pageRange: section.pageRange, docType: section.docType });
      }
    }
  }
  return results;
}

export async function extractMcneilBatch(batchDir, manifest) {
  const months = new Map();

  const rentRolls = [];
  for (const { fileName } of findSections(manifest, ["rentroll"])) {
    rentRolls.push(await extractRentRoll(path.join(batchDir, fileName)));
  }
  for (const { fileName, pageRange } of findSections(manifest, ["rentroll-pdf"])) {
    rentRolls.push(await extractRentRollPdf(path.join(batchDir, fileName), pageRange));
  }

  const pnlSections = findSections(manifest, ["cashflow-t12", "trailing-pnl-detail"]);

  if (pnlSections.length === 0) {
    for (const rentRoll of rentRolls) {
      if (!rentRoll.asOfDate) continue;
      const month = rentRoll.asOfDate.slice(0, 7);
      months.set(month, { month, occupancyPct: rentRoll.occupancyPct, rentRoll });
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
      const matchingRentRoll = rentRolls.find((r) => r.asOfDate?.startsWith(month));
      if (matchingRentRoll) {
        record.occupancyPct = matchingRentRoll.occupancyPct;
        record.rentRoll = matchingRentRoll;
      }
      months.set(month, record);
    }
  }
  return months;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test scripts/extract-mcneil.test.mjs`
Expected: PASS, all tests (existing + new)

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures — pay particular attention to the pre-existing tests `"extractMcneilBatch marks aggregate-only months as low confidence..."`, `"...attaches occupancy only to the month the rent roll's as-of date falls in"`, `"...emits an occupancy-only record when the batch has a rentroll but no cashflow-t12 PDF"`, and `"runMcneilExtraction folds batches..."` — these use manifests with no `sections` field at all, and must still pass unchanged via the `file.sections ?? [{docType: file.docType, pageRange: null}]` default in `findSections`.

- [ ] **Step 7: Commit**

```bash
git add scripts/extract-mcneil.mjs scripts/extract-mcneil.test.mjs
git commit -m "fix: extractMcneilBatch iterates manifest sections, not one file per docType

Gathers all P&L-bearing (cashflow-t12, trailing-pnl-detail) and
occupancy-bearing (rentroll, rentroll-pdf) sections across every file
in a batch, instead of looking up a single file by a single docType.
Distributions are only pulled from cashflow-t12 sections, since the
Trailing P&L Detail report never carries a Member's Distribution row.
Fully backward compatible with pre-bundle manifests."
```

---

### Task 6: Investment Deck capital-raise label

Adds a label pattern for the real capital-raise figure to `mcneil.config.mjs`. No new extractor code is needed — `scripts/lib/offering-doc.mjs`'s existing generic `extractTotalRaise(pdfPath, labelPattern)` already works correctly against the real Investment Deck fixture (verified: returns exactly `1300000`).

**Files:**
- Modify: `scripts/deals/mcneil.config.mjs`
- Test: `scripts/deals/mcneil.config.test.mjs` (extend)

**Interfaces:**
- Produces: `investmentDeckRaiseLabel: RegExp` — new export.
- Consumes (Task 9): `extractTotalRaise` from `scripts/lib/offering-doc.mjs` (unmodified), called with this label against the archived Investment Deck PDF.

- [ ] **Step 1: Write the failing test**

Add to `scripts/deals/mcneil.config.test.mjs`:

```js
import { extractTotalRaise } from "../lib/offering-doc.mjs";
```

```js
test("investmentDeckRaiseLabel extracts the real capital-raise figure from the Investment Deck's ACQUSITION SUMMARY table", async () => {
  const result = await extractTotalRaise(
    "scripts/__fixtures__/mcneil/2024-investment-deck-acquisition-summary.pdf",
    investmentDeckRaiseLabel
  );
  assert.equal(result, 1300000);
});
```

Update the import line to include the new export: `import { classifyDoc, distributionLabel, totalRaiseLabel, investmentDeckRaiseLabel } from "./mcneil.config.mjs";`

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/deals/mcneil.config.test.mjs`
Expected: FAIL — `investmentDeckRaiseLabel` is `undefined`

- [ ] **Step 3: Add the export**

In `scripts/deals/mcneil.config.mjs`, add after the existing `totalRaiseLabel` export:

```js
export const investmentDeckRaiseLabel = /Total Member Capital Needed to Close/i;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/deals/mcneil.config.test.mjs`
Expected: PASS, all tests (existing + new)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 6: Commit**

```bash
git add scripts/deals/mcneil.config.mjs scripts/deals/mcneil.config.test.mjs scripts/__fixtures__/mcneil/2024-investment-deck-acquisition-summary.pdf
git commit -m "feat: add label pattern for McNeil's real capital-raise figure

investmentDeckRaiseLabel matches the Investment Deck's ACQUSITION
SUMMARY 'Total Member Capital Needed to Close' line ($1,300,000) --
self-consistent with the same deck's own stated 3.8% ownership for a
\$50k investment. Reuses the existing generic extractTotalRaise, no
new extractor needed. Replaces the PPM's caveated \$1,500,000 estimate
as the source for data/capital.json (wired in Task 9)."
```

---

### Task 7: Fold classification+archiving into `harvestDeal()`

Fixes findings §7: `harvestDeal()` currently downloads attachments straight into an email-month-keyed staging folder with no classification and no manifest, and `refresh.mjs` runs extraction against that folder with no migration step in between — so a normal `npm run refresh` never actually produces anything extraction can read. This task makes `harvestDeal()` classify and archive each downloaded attachment itself, using the same content-derived `resolveBatchDate()` batch key `migrate-raw-archive.mjs` already uses (not the cruder email-subject-month key). `migrate-raw-archive.mjs` remains only as a one-time historical-backfill tool.

**Files:**
- Modify: `scripts/harvest.mjs`
- Modify: `scripts/refresh.mjs`

**Interfaces:**
- Produces: `harvestDeal(page, dealId, dealSlug, rawDir, dealConfig)` — gains a new 5th required parameter, `dealConfig` (the deal's config module, same as passed to `migrate-raw-archive.mjs`).
- Consumes: `extractPagesFromPdf` (Task 4), `classifyDoc` (either shape, normalized the same way Task 4's `migrate-raw-archive.mjs` update does), `resolveBatchDate`, `archiveFile`.

This task's changed code is Playwright/browser-driven and cannot be exercised by the existing `node:test` suite (consistent with the existing `scripts/harvest.test.mjs`, which only tests the pure helper functions `parseEmailSubjectMonth`/`parseDistributionText`/`parseOwnershipPct` — never `harvestDeal` itself). There is no test-first step for this task; instead, run the existing pure-function tests to confirm no regression, and rely on Task 9's live end-to-end run for integration verification.

- [ ] **Step 1: Update `harvestDeal`'s signature and imports**

In `scripts/harvest.mjs`, change the imports at the top:

```js
import { loadRecords, saveRecords } from "./lib/record-store.mjs";
import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { archiveFile, resolveArchiveRoot } from "./lib/archive-store.mjs";
import { resolveBatchDate } from "./lib/batch-date.mjs";
import { extractPagesFromPdf } from "./lib/pdf-pages.mjs";
```

- [ ] **Step 2: Replace the download loop to classify and archive instead of `saveAs`-ing to a staging folder**

In `scripts/harvest.mjs`, change `harvestDeal`'s signature and the body of its per-attachment download loop:

```js
export async function harvestDeal(page, dealId, dealSlug, rawDir, dealConfig) {
  const seenPath = path.join(rawDir, "_seen.json");
  const seen = await loadSeenManifest(seenPath);

  await page.goto(`${PORTAL_BASE}/app/documents/${dealId}?tab=emails`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForSelector("tbody tr", { timeout: 20000, state: "attached" });
  await page.waitForTimeout(3000);

  const rows = await page.$$eval("tbody tr", (trs) => trs.map((tr) => tr.innerText));

  const newMonths = [];
  for (let i = 0; i < rows.length; i++) {
    const subject = rows[i];
    const month = parseEmailSubjectMonth(subject);
    if (!month || seen[month]) continue;

    const row = page.locator("tbody tr").nth(i);
    await row.locator("button").last().click();
    await page.waitForTimeout(3000);

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

    const downloaded = [];
    let hadFailure = false;
    for (const { name, href } of attachmentLinks) {
      const safeName = name.replace(/[^a-zA-Z0-9.\- ]/g, "_");
      try {
        const link = page.locator(`a[href="${href}"]`).first();
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 30000 }),
          link.click(),
        ]);
        const tmpPath = await download.path();
        const buffer = await readFile(tmpPath);
        const ext = path.extname(safeName).replace(".", "");
        const pages = ext.toLowerCase() === "pdf" ? await extractPagesFromPdf(tmpPath).catch(() => []) : [];
        const text = pages.join("\n");
        const rawResult = dealConfig.classifyDoc({ filename: safeName, pages, text });
        const sections = Array.isArray(rawResult) ? rawResult : [{ docType: rawResult, pageRange: null }];
        const docType = sections[0].docType;
        if (docType === "unknown") {
          console.warn(`harvestDeal: could not classify "${name}" (${dealSlug} ${month}) -- archived as unknown`);
        }
        const { batchKey } = resolveBatchDate({ text, harvestedAt: new Date().toISOString() });
        await archiveFile(rawDir, batchKey, docType, ext, buffer, {
          sourceEmailSubject: subject,
          sections,
        });
        downloaded.push(name);
      } catch (err) {
        hadFailure = true;
        console.warn(
          `harvestDeal: download failed for ${dealSlug} ${month} "${name}" (${href}): ${err.message}`
        );
      }
    }

    if (!hadFailure) {
      seen[month] = { harvestedAt: new Date().toISOString(), files: downloaded };
      newMonths.push(month);
      await saveSeenManifest(seenPath, seen);
    }

    const doneButton = page.locator("text=Done").first();
    if (await doneButton.isVisible().catch(() => false)) await doneButton.click();
    await page.waitForTimeout(500);
  }

  return { newMonths };
}
```

(This removes the old `await mkdir(monthDir, { recursive: true });` staging-directory setup entirely — attachments are archived straight to their content-derived batch, never staged in an email-month folder. `_seen.json`'s email-month-keyed dedup bookkeeping is unchanged.)

- [ ] **Step 3: Update the two call sites for the new `dealConfig` parameter**

In `scripts/harvest.mjs`'s own CLI block at the bottom:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("cashflowportal")) ?? ctx.pages()[0];

  const configRaw = await (await import("node:fs/promises")).readFile("config.json", "utf8");
  const config = JSON.parse(configRaw);

  for (const [slug, deal] of Object.entries(config.deals)) {
    const dealConfig = await import(`./deals/${slug}.config.mjs`);
    const result = await harvestDeal(page, deal.dealId, slug, path.join(resolveArchiveRoot(), slug), dealConfig);
    console.log(`${slug}: ${result.newMonths.length ? result.newMonths.join(", ") : "no new months"}`);
  }
  await browser.close();
}
```

In `scripts/refresh.mjs`, change the harvest loop:

```js
  for (const [slug, deal] of Object.entries(config.deals)) {
    const dealConfig = await import(`./deals/${slug}.config.mjs`);
    await harvestDeal(page, deal.dealId, slug, path.join(resolveArchiveRoot(), slug), dealConfig);
  }
```

- [ ] **Step 4: Run the existing pure-function tests to confirm no regression**

Run: `node --test scripts/harvest.test.mjs`
Expected: PASS, all existing tests (these only cover `parseEmailSubjectMonth`/`parseDistributionText`/`parseOwnershipPct`, unaffected by this change)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 6: Commit**

```bash
git add scripts/harvest.mjs scripts/refresh.mjs
git commit -m "fix: harvestDeal classifies and archives at download time

harvestDeal previously saved attachments into an email-month-keyed
staging folder with no classification and no manifest -- refresh.mjs
then ran extraction against that same folder with no migration step
in between, so a normal refresh never actually produced anything
extraction could read. harvestDeal now classifies (bundle-aware) and
archives each attachment itself, using the same content-derived
resolveBatchDate() batch key migrate-raw-archive.mjs already uses.
migrate-raw-archive.mjs remains only as a one-time historical-backfill
tool."
```

---

### Task 8: Documents-tab static-document download (Investment Deck)

Adds a new harvesting function for one-time static documents on CashFlowPortal's Documents tab (distinct from the per-month Emails tab flow `harvestDeal` already handles), using the exact selectors verified live via Chrome CDP earlier in this investigation: `?tab=documents` URL, row matched by visible text, and the row's **third** button (index 2) triggers a real download.

**Files:**
- Modify: `scripts/harvest.mjs`

**Interfaces:**
- Produces: `harvestStaticDocument(page, dealId, docLabel, docType, rawDir, batchKey = "offering"): Promise<{found: boolean, written?: boolean, duplicateOf?: string}>`
- Consumes: `archiveFile` (Task 3).

Like Task 7, this function is Playwright/browser-driven and has no automated test — its selectors were already verified live (confirmed downloading the real 5,572,929-byte Investment Deck PDF via `?tab=documents` + row-text match + `row.locator("button").nth(2)` + `page.waitForEvent("download")`) during this session's manual investigation phase, before this plan was written.

- [ ] **Step 1: Add `harvestStaticDocument` to `scripts/harvest.mjs`**

Add after `harvestDeal`:

```js
export async function harvestStaticDocument(page, dealId, docLabel, docType, rawDir, batchKey = "offering") {
  await page.goto(`${PORTAL_BASE}/app/documents/${dealId}?tab=documents`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2500);

  const rows = page.locator("tbody tr");
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const rowText = await row.innerText();
    if (!rowText.includes(docLabel)) continue;

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      row.locator("button").nth(2).click(),
    ]);
    const tmpPath = await download.path();
    const buffer = await readFile(tmpPath);
    const result = await archiveFile(rawDir, batchKey, docType, "pdf", buffer, {
      sourceEmailSubject: docLabel,
    });
    return { found: true, ...result };
  }
  return { found: false };
}
```

- [ ] **Step 2: Run the full test suite to confirm no regression**

Run: `npm test`
Expected: PASS, 0 failures (this step adds a new export with no automated test, consistent with `harvestDeal`'s existing precedent; the compliance audit still passes since this function only does `page.goto`/`page.locator`/`page.waitForEvent("download")`).

- [ ] **Step 3: Commit**

```bash
git add scripts/harvest.mjs
git commit -m "feat: add harvestStaticDocument for Documents-tab one-time downloads

Downloads static documents (e.g. the Investment Deck) from
CashFlowPortal's Documents tab via a real DOM click + captured
download event -- verified live against the real 35-page, 5.5MB
Investment Deck PDF during this session's manual investigation.
Distinct from harvestDeal's per-month Emails-tab flow: these
documents don't change monthly, so they aren't re-downloaded on every
refresh."
```

---

### Task 9: Wipe, rebuild, and reconcile

The final integration task: wipe the main checkout's stale pre-migration `data/raw/`, rebuild it from this worktree's already-correct archive plus a live harvest run (using everything fixed in Tasks 1-9), capture the Investment Deck once via `harvestStaticDocument`, re-run the full pipeline, and verify the reconciled output against the findings doc's expectations. Updates `README.md` to describe the new capture-once convention for the Investment Deck, matching the existing documented convention for `extractTotalRaise`.

**Files:**
- Modify: (data only) `data/mcneil.json`, `data/capital.json`
- Modify: `README.md`

This task has no new source code and thus no new automated tests; its correctness is verified against the concrete real numbers already hand-verified earlier in this investigation and recorded in the findings doc.

- [ ] **Step 1: Confirm Chrome is reachable over CDP**

Run: `curl -s http://localhost:9222/json/version`
Expected: JSON response containing `"Browser": "Chrome/..."`. If this fails, ask the user to relaunch Chrome with remote debugging before continuing — do not proceed to a live harvest without it.

- [ ] **Step 2: Back up the main checkout's current `data/raw/` before wiping it**

```bash
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
mv "$MAIN_ROOT/data/raw" "$MAIN_ROOT/data/raw.pre-rebuild-backup-$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo backup)"
```

(`data/raw/` is gitignored, so this is a plain filesystem move, not a git operation. Keeping the backup, rather than deleting outright, means the old structure can still be inspected if anything about the rebuild looks wrong.)

- [ ] **Step 3: Rebuild from this worktree's already-correct archive via the now-bundle-aware migration**

For each deal, migrate this worktree's existing (correctly-structured) local `data/raw/<deal>/` into the main checkout's freshly-emptied `data/raw/<deal>/`:

```bash
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
node scripts/migrate-raw-archive.mjs mcneil data/raw/mcneil "$MAIN_ROOT/data/raw/mcneil"
node scripts/migrate-raw-archive.mjs legacy data/raw/legacy "$MAIN_ROOT/data/raw/legacy"
```

Confirm the output shows the 13-page bundles (`2025-10/balance-sheet.pdf`, `2026-01/balance-sheet.pdf`) each producing 5 sections, not a single `balance-sheet` classification.

- [ ] **Step 4: Run a live harvest to pick up anything newer than this worktree's local copy**

```bash
node scripts/harvest.mjs
```

Expected: no errors; any brand-new months since this worktree's archive was last updated get classified and archived directly (Task 7), landing in the main checkout's `data/raw/` (Task 3's `resolveArchiveRoot()`).

- [ ] **Step 5: Capture the Investment Deck once via `harvestStaticDocument`**

```bash
node -e '
import { chromium } from "playwright";
import { harvestStaticDocument } from "./scripts/harvest.mjs";
import { resolveArchiveRoot } from "./scripts/lib/archive-store.mjs";
import path from "node:path";

const browser = await chromium.connectOverCDP("http://localhost:9222");
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes("cashflowportal")) ?? ctx.pages()[0];
const result = await harvestStaticDocument(
  page,
  "f8929e29-285b-4904-b4e9-5b41b035535b",
  "Investment Deck (PDF)",
  "investment-deck",
  path.join(resolveArchiveRoot(), "mcneil")
);
console.log(result);
await browser.close();
'
```

Expected: `{ found: true, written: true }` (or `written: false, duplicateOf: "offering"` if this exact file is already archived from an earlier manual download this session).

- [ ] **Step 6: Re-run the full pipeline**

```bash
npm run refresh
```

Expected: no errors. `data/mcneil.json` gains 2025-01 through 2025-12; Oct-Dec 2024 gain real `income.rental`/`income.other` values (no longer $0.00 placeholders).

- [ ] **Step 7: Verify the reconciled McNeil data against the findings doc**

```bash
node -e '
import { readFile } from "node:fs/promises";
const data = JSON.parse(await readFile("data/mcneil.json", "utf8"));
console.log("months:", Object.keys(data).sort());
console.log("2024-10:", JSON.stringify(data["2024-10"]));
console.log("2025-09 occupancyPct:", data["2025-09"]?.occupancyPct);
console.log("2025-12 occupancyPct:", data["2025-12"]?.occupancyPct);
'
```

Expected: months include the full run from 2024-09 (or 2024-10, depending on what the live archive actually contains — recall findings §4: neither bundle covers Sep 2024) through the latest available month; `2024-10.income.rental` is `21148`, not `0`; `2025-09.occupancyPct` is `90.6`; `2025-12.occupancyPct` is `84.4`.

If any of these don't match, stop and diagnose before touching `data/capital.json` — do not paper over a mismatch by hand-editing the JSON.

- [ ] **Step 8: Update `data/capital.json`'s McNeil `totalRaise` using the real extractor**

```bash
node -e '
import { extractTotalRaise } from "./scripts/lib/offering-doc.mjs";
import { investmentDeckRaiseLabel } from "./scripts/deals/mcneil.config.mjs";
import { resolveArchiveRoot } from "./scripts/lib/archive-store.mjs";
import path from "node:path";

const result = await extractTotalRaise(
  path.join(resolveArchiveRoot(), "mcneil", "offering", "investment-deck.pdf"),
  investmentDeckRaiseLabel
);
console.log("extracted total raise:", result);
'
```

Expected: `1300000`. Then hand-edit `data/capital.json`'s `mcneil.totalRaise` to this value and update `mcneil.totalRaiseSource` to:

```
"McNeil Star Apartment LLC - Investment Deck (PDF), ACQUSITION SUMMARY table, 'Total Member Capital Needed to Close' -- self-consistent with the same deck's own stated 3.8% ownership for a $50k investment (50000/1300000 = 3.85%). Replaces the PPM's Sources of Funds estimate. Still does not match the ~2.59% ownership implied by the real 2026-Q2 distribution ($648.14 of $24,999.86) -- that discrepancy remains unresolved and is intentionally left visible via ownershipPctCheck rather than papered over."
```

(This is the one JSON field this plan hand-edits, matching the pre-existing, README-documented convention that `totalRaise` is captured once from a real extractor run and recorded by hand — not re-scraped on every refresh. See Step 9.)

- [ ] **Step 9: Update `README.md`'s capital-raise section**

Find the existing paragraph (currently reading `data/capital.json`'s `totalRaise` field is the one figure that is not produced by `npm run refresh`...`) and extend it to mention the Investment Deck as McNeil's source and `harvestStaticDocument` as how it's archived:

```markdown
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
```

- [ ] **Step 10: Run the full test suite one final time**

Run: `npm test`
Expected: PASS, 0 failures

- [ ] **Step 11: Commit the data and README changes**

```bash
git add README.md data/mcneil.json data/capital.json
git commit -m "data: rebuild data/raw archive and reconcile McNeil pipeline output

Wiped the main checkout's stale pre-migration data/raw/ (backed up,
not deleted) and rebuilt it via the now-bundle-aware migration plus a
live harvest, closing the gap where migration work only ever landed
in a gitignored worktree copy. Re-ran the full pipeline: 2025 monthly
data and two additional occupancy snapshots (9/30/2025, 12/31/2025)
recovered from the previously-misclassified bundled PDFs. Updated
McNeil's totalRaise to $1,300,000 from the Investment Deck's
ACQUSITION SUMMARY table, replacing the PPM's caveated estimate."
```

- [ ] **Step 12: Leave the pre-rebuild backup for the user to review, and report final numbers**

Do not delete `data/raw.pre-rebuild-backup-*` automatically — report its path and let the user decide whether to remove it once they've spot-checked the dashboard against the rebuilt data.
