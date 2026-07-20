# Multi-Property Data Pipeline & Compliance Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-deal-hardcoded raw archive and extraction pipeline with a generic, batch-vintage-organized system that fixes occupancy/capital-raise/distribution completeness, and rewrite everything tainted by the direct-API-call compliance violation.

**Architecture:** A content-hash-deduped raw archive keyed by report vintage (`data/raw/<deal>/<batch-YYYY-MM>/<docType>.<ext>` + manifest), a per-deal config declaring doc-type classification and parsers, a generic fold-based merge engine (newest-batch-wins-unless-blank), and DOM-only portal scraping throughout. Deterministic PDF/XLSX parsing stays in Node (`pdftotext`, `exceljs`); Legacy's embedded-image P&L table keeps using the existing vision-LLM path.

**Tech Stack:** Node.js 18+ (ES modules), Playwright over CDP, `pdftotext` (poppler), `exceljs`, `node:test`/`node:assert`, `node:crypto` for content hashing.

## Global Constraints

- All portal interaction is DOM/click-driven only — page navigation, reading rendered text, clicking real UI elements, downloading via captured browser download events. Never call `api.cashflowportal.com` directly, in any form (see `CLAUDE.md`). This applies to every task in this plan, including any manual verification steps.
- No hosted/cloud deployment — local files only. Dashboard loads via `file://`.
- `npm run refresh` remains the single re-run command once this plan lands.
- `config.json` is gitignored; never commit secrets.
- All financial parsing is deterministic where possible; the vision LLM is only used for Legacy's page-4 embedded-image P&L table.
- Every parser or config module gets a `*.test.mjs`, with fixtures under `scripts/__fixtures__/` — no exceptions. This is a direct response to `extract-mcneil-2025.mjs` shipping untested and producing uncaught bugs.
- Merge rule, applied uniformly to every field: the newest batch's value wins unless it is null/undefined/all-zero, in which case the older batch's value is kept.

---

### Task 1: Content-hash archive store

**Files:**
- Create: `scripts/lib/archive-store.mjs`
- Test: `scripts/lib/archive-store.test.mjs`

**Interfaces:**
- Produces: `hashContent(buffer): string`, `loadManifest(batchDir): Promise<{files: Array<{docType, fileName, contentHash, sourceEmailSubject, harvestedAt, batchDateSource}>}>`, `saveManifest(batchDir, manifest): Promise<void>`, `findDuplicateHash(dealRawDir, contentHash): Promise<string|null>`, `archiveFile(dealRawDir, batchKey, docType, ext, buffer, meta): Promise<{written: boolean, duplicateOf?: string}>` — used by Task 7, 8, 11.

- [ ] **Step 1: Write the failing tests**

```javascript
// scripts/lib/archive-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { hashContent, archiveFile, findDuplicateHash, loadManifest } from "./archive-store.mjs";

const TMP_DIR = "scripts/__fixtures__/tmp-archive-store";

test("hashContent is deterministic for identical buffers", () => {
  const a = hashContent(Buffer.from("hello"));
  const b = hashContent(Buffer.from("hello"));
  assert.equal(a, b);
});

test("hashContent differs for different buffers", () => {
  const a = hashContent(Buffer.from("hello"));
  const b = hashContent(Buffer.from("world"));
  assert.notEqual(a, b);
});

test("archiveFile writes a new file and records it in the batch manifest", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  const result = await archiveFile(TMP_DIR, "2026-01", "cashflow-t12", "pdf", Buffer.from("report-a"), {
    sourceEmailSubject: "January 2026 Update",
  });
  assert.equal(result.written, true);
  const written = await readFile(`${TMP_DIR}/2026-01/cashflow-t12.pdf`, "utf8");
  assert.equal(written, "report-a");
  const manifest = await loadManifest(`${TMP_DIR}/2026-01`);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].docType, "cashflow-t12");
  assert.equal(manifest.files[0].sourceEmailSubject, "January 2026 Update");
  await rm(TMP_DIR, { recursive: true, force: true });
});

test("archiveFile skips an exact duplicate found in a different batch", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await archiveFile(TMP_DIR, "2025-05", "cashflow-t12", "pdf", Buffer.from("same-report"), {});
  const result = await archiveFile(TMP_DIR, "2025-08", "cashflow-t12", "pdf", Buffer.from("same-report"), {});
  assert.equal(result.written, false);
  assert.equal(result.duplicateOf, "2025-05");
  await assert.rejects(() => readFile(`${TMP_DIR}/2025-08/cashflow-t12.pdf`, "utf8"));
  await rm(TMP_DIR, { recursive: true, force: true });
});

test("findDuplicateHash returns null for a brand-new hash", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await archiveFile(TMP_DIR, "2026-01", "cashflow-t12", "pdf", Buffer.from("report-a"), {});
  const result = await findDuplicateHash(TMP_DIR, hashContent(Buffer.from("totally-different")));
  assert.equal(result, null);
  await rm(TMP_DIR, { recursive: true, force: true });
});

test("loadManifest returns an empty files array when no manifest exists yet", async () => {
  const manifest = await loadManifest("scripts/__fixtures__/tmp-archive-store-nonexistent");
  assert.deepEqual(manifest, { files: [] });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/lib/archive-store.test.mjs`
Expected: FAIL with "Cannot find module './archive-store.mjs'".

- [ ] **Step 3: Implement archive-store.mjs**

```javascript
// scripts/lib/archive-store.mjs
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

export function hashContent(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function loadManifest(batchDir) {
  try {
    const raw = await readFile(path.join(batchDir, "manifest.json"), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return { files: [] };
    throw err;
  }
}

export async function saveManifest(batchDir, manifest) {
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(batchDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export async function findDuplicateHash(dealRawDir, contentHash) {
  let batchNames;
  try {
    batchNames = (await readdir(dealRawDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  for (const batchName of batchNames) {
    const manifest = await loadManifest(path.join(dealRawDir, batchName));
    if (manifest.files.some((f) => f.contentHash === contentHash)) return batchName;
  }
  return null;
}

export async function archiveFile(dealRawDir, batchKey, docType, ext, buffer, meta = {}) {
  const contentHash = hashContent(buffer);
  const duplicateOf = await findDuplicateHash(dealRawDir, contentHash);
  if (duplicateOf) {
    return { written: false, duplicateOf };
  }
  const batchDir = path.join(dealRawDir, batchKey);
  const fileName = `${docType}.${ext}`;
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(batchDir, fileName), buffer);

  const manifest = await loadManifest(batchDir);
  manifest.files.push({
    docType,
    fileName,
    contentHash,
    sourceEmailSubject: meta.sourceEmailSubject ?? null,
    harvestedAt: meta.harvestedAt ?? new Date().toISOString(),
    batchDateSource: meta.batchDateSource ?? "content",
  });
  await saveManifest(batchDir, manifest);
  return { written: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/lib/archive-store.test.mjs`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/archive-store.mjs scripts/lib/archive-store.test.mjs
git commit -m "feat: add content-hash-deduped batch archive store"
```

---

### Task 2: Batch-date resolver

**Files:**
- Create: `scripts/lib/batch-date.mjs`
- Test: `scripts/lib/batch-date.test.mjs`

**Interfaces:**
- Produces: `resolveBatchDate({ text, asOfDate, harvestedAt }): { batchKey: string, source: "content"|"harvest-fallback" }` — used by Task 11.

- [ ] **Step 1: Write the failing tests**

```javascript
// scripts/lib/batch-date.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBatchDate } from "./batch-date.mjs";

test("resolves batch date from a 'Printed M/D/YYYY' line", () => {
  const text = "Printed 1/20/2025 5:59:24 PM\nMcNeil Star\n";
  const result = resolveBatchDate({ text, harvestedAt: "2025-05-01T00:00:00.000Z" });
  assert.deepEqual(result, { batchKey: "2025-01", source: "content" });
});

test("resolves batch date from a rent-roll as-of date when text has none", () => {
  const result = resolveBatchDate({ asOfDate: "2026-06-30", harvestedAt: "2026-06-15T00:00:00.000Z" });
  assert.deepEqual(result, { batchKey: "2026-06", source: "content" });
});

test("prefers asOfDate over a printed-date line when both are present", () => {
  const text = "Printed 6/30/2026 8:27:04 PM\n";
  const result = resolveBatchDate({ text, asOfDate: "2026-07-01", harvestedAt: "2026-06-15T00:00:00.000Z" });
  assert.deepEqual(result, { batchKey: "2026-07", source: "content" });
});

test("falls back to harvest date when no content date is found", () => {
  const result = resolveBatchDate({ text: "no date here", harvestedAt: "2025-09-03T00:00:00.000Z" });
  assert.deepEqual(result, { batchKey: "2025-09", source: "harvest-fallback" });
});

test("pads single-digit months from the 'Printed' line", () => {
  const text = "Printed 3/5/2026 10:00:00 AM\n";
  const result = resolveBatchDate({ text, harvestedAt: "2026-03-10T00:00:00.000Z" });
  assert.deepEqual(result, { batchKey: "2026-03", source: "content" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/lib/batch-date.test.mjs`
Expected: FAIL with "Cannot find module './batch-date.mjs'".

- [ ] **Step 3: Implement batch-date.mjs**

```javascript
// scripts/lib/batch-date.mjs
export function resolveBatchDate({ text, asOfDate, harvestedAt }) {
  if (asOfDate) {
    const match = asOfDate.match(/^(\d{4})-(\d{2})-\d{2}$/);
    if (match) return { batchKey: `${match[1]}-${match[2]}`, source: "content" };
  }
  if (text) {
    const printedMatch = text.match(/Printed\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (printedMatch) {
      const [, month, , year] = printedMatch;
      return { batchKey: `${year}-${month.padStart(2, "0")}`, source: "content" };
    }
  }
  return { batchKey: harvestedAt.slice(0, 7), source: "harvest-fallback" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/lib/batch-date.test.mjs`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/batch-date.mjs scripts/lib/batch-date.test.mjs
git commit -m "feat: add batch-date resolver for the archive store"
```

---

### Task 3: Generic merge engine

**Files:**
- Create: `scripts/lib/merge-months.mjs`
- Test: `scripts/lib/merge-months.test.mjs`

**Interfaces:**
- Produces: `isBlank(value): boolean`, `mergeRecordFields(oldRecord, newRecord): object`, `foldMonths(batchesOldToNew: Map<string,object>[]): Map<string,object>` — used by Task 7, 8.

- [ ] **Step 1: Write the failing tests**

```javascript
// scripts/lib/merge-months.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlank, mergeRecordFields, foldMonths } from "./merge-months.mjs";

test("isBlank treats null, undefined, and zero as blank", () => {
  assert.equal(isBlank(null), true);
  assert.equal(isBlank(undefined), true);
  assert.equal(isBlank(0), true);
  assert.equal(isBlank(42), false);
});

test("isBlank treats an object as blank only when every value is blank", () => {
  assert.equal(isBlank({ rental: 0, other: 0, total: 0 }), true);
  assert.equal(isBlank({ rental: 100, other: 0, total: 100 }), false);
});

test("mergeRecordFields keeps the old value when the new one is blank", () => {
  const merged = mergeRecordFields({ occupancyPct: 84.4, noi: 100 }, { occupancyPct: null, noi: 200 });
  assert.equal(merged.occupancyPct, 84.4);
  assert.equal(merged.noi, 200);
});

test("mergeRecordFields returns the new record whole when there is no old record", () => {
  const merged = mergeRecordFields(undefined, { occupancyPct: 74, noi: 50 });
  assert.deepEqual(merged, { occupancyPct: 74, noi: 50 });
});

test("foldMonths lets a later batch's blank occupancy fall back to an earlier batch's value", () => {
  const batchOld = new Map([["2026-01", { occupancyPct: 84.4, income: { total: 100 } }]]);
  const batchNew = new Map([["2026-01", { occupancyPct: null, income: { total: 150 } }]]);
  const result = foldMonths([batchOld, batchNew]);
  assert.equal(result.get("2026-01").occupancyPct, 84.4);
  assert.equal(result.get("2026-01").income.total, 150);
});

test("foldMonths folds three batches in order, each contributing new months", () => {
  const b1 = new Map([["2025-01", { noi: 10 }]]);
  const b2 = new Map([["2025-02", { noi: 20 }]]);
  const b3 = new Map([["2025-01", { noi: 15 }]]);
  const result = foldMonths([b1, b2, b3]);
  assert.equal(result.get("2025-01").noi, 15);
  assert.equal(result.get("2025-02").noi, 20);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/lib/merge-months.test.mjs`
Expected: FAIL with "Cannot find module './merge-months.mjs'".

- [ ] **Step 3: Implement merge-months.mjs**

```javascript
// scripts/lib/merge-months.mjs
export function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "number") return value === 0;
  if (typeof value === "object") return Object.values(value).every(isBlank);
  return false;
}

export function mergeRecordFields(oldRecord, newRecord) {
  if (!oldRecord) return newRecord;
  const merged = { ...oldRecord };
  for (const [key, newValue] of Object.entries(newRecord)) {
    merged[key] = isBlank(newValue) ? oldRecord[key] : newValue;
  }
  return merged;
}

export function foldMonths(batchesOldToNew) {
  const result = new Map();
  for (const batch of batchesOldToNew) {
    for (const [month, record] of batch) {
      result.set(month, mergeRecordFields(result.get(month), record));
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/lib/merge-months.test.mjs`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/merge-months.mjs scripts/lib/merge-months.test.mjs
git commit -m "feat: add generic newest-wins-unless-blank merge engine"
```

---

### Task 4: McNeil distribution-line extraction

**Files:**
- Modify: `scripts/extract-mcneil.mjs`
- Modify: `scripts/extract-mcneil.test.mjs`

**Interfaces:**
- Consumes: `parseMoney` from `./lib/money.mjs` (existing).
- Produces: `parseMonthHeader(text): string[]` and `extractMcneilDistributions(pdfPath, labelPattern): Promise<Map<string, number>>` — used by Task 7.

**What:** The McNeil cash-flow PDF has a "Member's Distribution" row in its Financing Activities section, after the point where `extractMcneilPnl`'s parsing loop currently stops (`reachedNetIncome` breaks the loop right after the NET INCOME row). Add a separate, full-text scan for this row, and factor month-header parsing out so both functions share it.

- [ ] **Step 1: Confirm the real fixture data this test relies on**

Run: `pdftotext -layout scripts/__fixtures__/mcneil/2026-06-cashflow-statement.pdf - | grep -B1 -A1 "Distribut"`
Expected output includes:
```
      Member's Distribution
          Member's Distribution             0.00 ... (118,999.45) ... (24,999.86) ...          0.00
      Total Member's Distributi             0.00 ... (118,999.45) ... (24,999.86) ...          0.00
```
**Correction (verified during Task 4's implementation, both by the implementer and independently re-verified by the controller via character-position alignment against the header row and an order-based token count):** the two nonzero amounts land under **Jan 2026** and **Apr 2026**, not Jul 2025 / Oct 2025 as originally written here — the dense 12-column layout is easy to mis-eyeball. The values below are corrected accordingly.

The values under "Member's Distribution" are `(118,999.45)` in the Jan 2026 column and `(24,999.86)` in the Apr 2026 column, zero everywhere else.

- [ ] **Step 2: Write the failing tests**

Add to `scripts/extract-mcneil.test.mjs` (extend the existing import line):

```javascript
import { extractMcneilPnl, extractMcneilDistributions, runMcneilExtraction } from "./extract-mcneil.mjs";
```

```javascript
test("extracts the Member's Distribution line across all 12 header months", async () => {
  const result = await extractMcneilDistributions(FIXTURE, /Member's Distribution/i);
  assert.equal(result.size, 12);
  assert.equal(result.get("2026-01"), 118999.45);
  assert.equal(result.get("2026-04"), 24999.86);
  assert.equal(result.get("2025-08"), 0);
  assert.equal(result.get("2026-06"), 0);
});

test("extractMcneilDistributions does not double-count the 'Total Member's Distributi' subtotal row", async () => {
  const result = await extractMcneilDistributions(FIXTURE, /Member's Distribution/i);
  // If the truncated "Total Member's Distributi" row were matched too, Jan 2026 would double to 237,998.90
  assert.equal(result.get("2026-01"), 118999.45);
});
```

Also guard the row-parsing loop against a real `pdftotext` layout quirk: very wide negative dollar amounts elsewhere in the statement (e.g. Investing Activities' `Buildings` row) occasionally collapse the column separator to a single space, which `splitRow` cannot tokenize — it throws via `parseMoney`. Skip those rows (they can never be the distribution row) rather than letting the whole scan crash; see the corrected Step 4 code below, which wraps the `splitRow` call in a try/catch.

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test scripts/extract-mcneil.test.mjs`
Expected: FAIL with "extractMcneilDistributions is not a function".

- [ ] **Step 4: Factor out parseMonthHeader and add extractMcneilDistributions**

In `scripts/extract-mcneil.mjs`, replace the header-parsing block inside `extractMcneilPnl`:

```javascript
export async function extractMcneilPnl(pdfPath) {
  const text = await fullText(pdfPath);
  const lines = text.split("\n");

  const headerLine = lines.find((l) => /^Account\s+\w{3} \d{4}/.test(l.trim()));
  if (!headerLine) throw new Error("extract-mcneil: could not find table header row");
  const monthLabels = headerLine
    .replace(/^Account/, "")
    .trim()
    .split(/\s{2,}/)
    .filter(Boolean);
  const monthKeys = monthLabels.slice(0, -1).map(toMonthKey);
```

With:

```javascript
export function parseMonthHeader(text) {
  const headerLine = text.split("\n").find((l) => /^Account\s+\w{3} \d{4}/.test(l.trim()));
  if (!headerLine) throw new Error("extract-mcneil: could not find table header row");
  const monthLabels = headerLine
    .replace(/^Account/, "")
    .trim()
    .split(/\s{2,}/)
    .filter(Boolean);
  return monthLabels.slice(0, -1).map(toMonthKey);
}

export async function extractMcneilPnl(pdfPath) {
  const text = await fullText(pdfPath);
  const lines = text.split("\n");
  const monthKeys = parseMonthHeader(text);
```

Then, after `extractMcneilPnl`'s closing brace, add:

```javascript
export async function extractMcneilDistributions(pdfPath, labelPattern) {
  const text = await fullText(pdfPath);
  const monthKeys = parseMonthHeader(text);
  const result = new Map(monthKeys.map((key) => [key, 0]));

  for (const rawLine of text.split("\n")) {
    let row;
    try {
      row = splitRow(rawLine);
    } catch {
      // pdftotext occasionally collapses the space between two adjacent
      // wide dollar values (e.g. large negative amounts in unrelated
      // sections), which splitRow cannot parse. Skip those rows — they
      // are never the distribution row we're looking for.
      continue;
    }
    if (!row) continue;
    if (row.label.startsWith("Total ")) continue;
    if (!labelPattern.test(row.label)) continue;
    const perMonth = row.values.slice(0, monthKeys.length);
    if (perMonth.length !== monthKeys.length) continue;
    monthKeys.forEach((key, i) => {
      result.set(key, result.get(key) + Math.abs(perMonth[i]));
    });
  }
  return result;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/extract-mcneil.test.mjs`
Expected: 8 pass (6 existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add scripts/extract-mcneil.mjs scripts/extract-mcneil.test.mjs
git commit -m "feat: extract McNeil's Member's Distribution line deterministically"
```

---

### Task 5: Per-deal config modules

**Files:**
- Create: `scripts/deals/mcneil.config.mjs`
- Create: `scripts/deals/mcneil.config.test.mjs`
- Create: `scripts/deals/legacy.config.mjs`
- Create: `scripts/deals/legacy.config.test.mjs`

**Interfaces:**
- Produces (per deal config module): `dealSlug: string`, `classifyDoc({filename, text}): string`, `distributionLabel: RegExp|null`, `totalRaiseLabel: RegExp`, `occupancySource: "rentroll"|"narrative"` — used by Task 7, 8, 11.

- [ ] **Step 1: Write the failing tests for McNeil's config**

```javascript
// scripts/deals/mcneil.config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDoc, distributionLabel, totalRaiseLabel } from "./mcneil.config.mjs";

test("classifies a twelve-month cash flow PDF as cashflow-t12", () => {
  const text = "Twelve Month Cash Flow Statement Expanded Detail\nJune 2026 - Accrual";
  assert.equal(classifyDoc({ filename: "cashflow.pdf", text }), "cashflow-t12");
});

test("classifies a twelve-month profit and loss PDF as cashflow-t12", () => {
  const text = "Twelve Month Profit and Loss\nJanuary 2024 - December 2024";
  assert.equal(classifyDoc({ filename: "T12.pdf", text }), "cashflow-t12");
});

test("classifies a balance sheet PDF as balance-sheet", () => {
  const text = "McNeil Star\nGolden Group Multifamily LLC\nBalance Sheet\nDecember 2024";
  assert.equal(classifyDoc({ filename: "BalanceSheet.pdf", text }), "balance-sheet");
});

test("classifies an xlsx file as rentroll regardless of content", () => {
  assert.equal(classifyDoc({ filename: "rentroll.xlsx", text: "" }), "rentroll");
});

test("classifies an offering memorandum as offering-doc", () => {
  const text = "McNeil Star Apartments Private Placement Memorandum";
  assert.equal(classifyDoc({ filename: "offering.pdf", text }), "offering-doc");
});

test("returns unknown for unrecognized content", () => {
  assert.equal(classifyDoc({ filename: "random.pdf", text: "Just some text" }), "unknown");
});

test("distributionLabel matches the exact 'Member's Distribution' row label, not its Total subtotal", () => {
  assert.ok(distributionLabel.test("Member's Distribution"));
  assert.ok(!distributionLabel.test("Total Member's Contribut"));
});

test("totalRaiseLabel matches common offering-amount phrasing", () => {
  assert.ok(totalRaiseLabel.test("Total Offering Amount: $1,930,000"));
  assert.ok(totalRaiseLabel.test("Total Capital Raised 1,300,000"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/deals/mcneil.config.test.mjs`
Expected: FAIL with "Cannot find module './mcneil.config.mjs'".

- [ ] **Step 3: Implement mcneil.config.mjs**

```javascript
// scripts/deals/mcneil.config.mjs
export const dealSlug = "mcneil";

export function classifyDoc({ filename, text }) {
  if (filename.toLowerCase().endsWith(".xlsx")) return "rentroll";
  if (/twelve month (profit and loss|cash flow)/i.test(text)) return "cashflow-t12";
  if (/balance sheet/i.test(text)) return "balance-sheet";
  if (/subscription agreement|offering memorandum|private placement/i.test(text)) return "offering-doc";
  return "unknown";
}

export const distributionLabel = /^Member's Distribution$/i;
export const totalRaiseLabel = /Total (Offering Amount|Capital Rais(?:e|ed))/i;
export const occupancySource = "rentroll";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/deals/mcneil.config.test.mjs`
Expected: 8 pass.

- [ ] **Step 5: Write the failing tests for Legacy's config**

```javascript
// scripts/deals/legacy.config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDoc, distributionLabel, totalRaiseLabel } from "./legacy.config.mjs";

test("classifies the monthly investor update PDF as monthly-update", () => {
  const text = "The Legacy Apartment May Update\nThe Legacy Apartment";
  assert.equal(classifyDoc({ filename: "report.pdf", text }), "monthly-update");
});

test("classifies an offering memorandum as offering-doc", () => {
  const text = "The Legacy Apartment Private Placement Memorandum";
  assert.equal(classifyDoc({ filename: "offering.pdf", text }), "offering-doc");
});

test("returns unknown for unrecognized content", () => {
  assert.equal(classifyDoc({ filename: "random.pdf", text: "Just some text" }), "unknown");
});

test("has no distribution label yet, since Legacy's reports don't itemize one", () => {
  assert.equal(distributionLabel, null);
});

test("totalRaiseLabel matches common offering-amount phrasing", () => {
  assert.ok(totalRaiseLabel.test("Total Offering Amount: $1,200,000"));
});
```

- [ ] **Step 6: Run tests to verify they fail, then implement legacy.config.mjs**

```javascript
// scripts/deals/legacy.config.mjs
export const dealSlug = "legacy";

export function classifyDoc({ filename, text }) {
  if (/update\.pdf$/i.test(filename) || /\w+ Update\b/i.test(text)) return "monthly-update";
  if (/subscription agreement|offering memorandum|private placement/i.test(text)) return "offering-doc";
  return "unknown";
}

export const distributionLabel = null;
export const totalRaiseLabel = /Total (Offering Amount|Capital Rais(?:e|ed))/i;
export const occupancySource = "narrative";
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test scripts/deals/legacy.config.test.mjs`
Expected: 5 pass.

- [ ] **Step 8: Commit**

```bash
git add scripts/deals/
git commit -m "feat: add per-deal config modules for McNeil and Legacy"
```

---

### Task 6: Capital-raise PDF parser

**Files:**
- Create: `scripts/lib/offering-doc.mjs`
- Test: `scripts/lib/offering-doc.test.mjs`

**Interfaces:**
- Consumes: `parseMoney` from `./money.mjs` (existing).
- Produces: `extractTextFromPdf(pdfPath): Promise<string>`, `findTotalRaise(text, labelPattern): number|null`, `extractTotalRaise(pdfPath, labelPattern): Promise<number|null>` — used by Task 11, 12.

**Note:** `findTotalRaise` is fully unit-testable with literal string fixtures. `extractTotalRaise`'s PDF-reading path needs a real offering-document PDF, which isn't available yet — Task 12 (compliance rewrite / re-derivation) harvests one live and must add one integration test asserting `extractTotalRaise(realPdfPath, mcneilConfig.totalRaiseLabel)` returns the correct figure before that task is considered done.

- [ ] **Step 1: Write the failing tests**

```javascript
// scripts/lib/offering-doc.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { findTotalRaise } from "./offering-doc.mjs";

test("finds the largest dollar amount on a line matching the label pattern", () => {
  const text = "Summary of Terms\nTotal Offering Amount: $1,930,000\nMinimum Investment: $50,000\n";
  const result = findTotalRaise(text, /Total Offering Amount/i);
  assert.equal(result, 1930000);
});

test("returns null when no line matches the label pattern", () => {
  const text = "Summary of Terms\nMinimum Investment: $50,000\n";
  const result = findTotalRaise(text, /Total Offering Amount/i);
  assert.equal(result, null);
});

test("handles a comma-formatted amount without a dollar sign", () => {
  const text = "Total Capital Raised 1,300,000\n";
  const result = findTotalRaise(text, /Total Capital Raised/i);
  assert.equal(result, 1300000);
});

test("picks the largest amount on the matching line when several numbers appear", () => {
  const text = "Total Offering Amount: $1,930,000 (50 units at $38,600)\n";
  const result = findTotalRaise(text, /Total Offering Amount/i);
  assert.equal(result, 1930000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/lib/offering-doc.test.mjs`
Expected: FAIL with "Cannot find module './offering-doc.mjs'".

- [ ] **Step 3: Implement offering-doc.mjs**

```javascript
// scripts/lib/offering-doc.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseMoney } from "./money.mjs";

const execFileAsync = promisify(execFile);

export async function extractTextFromPdf(pdfPath) {
  const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"]);
  return stdout;
}

export function findTotalRaise(text, labelPattern) {
  for (const line of text.split("\n")) {
    if (!labelPattern.test(line)) continue;
    const amounts = line.match(/\$?[\d,]+(?:\.\d{2})?/g);
    if (!amounts) continue;
    const values = amounts.map((a) => parseMoney(a.replace(/^\$/, "")));
    const largest = Math.max(...values);
    if (largest > 0) return largest;
  }
  return null;
}

export async function extractTotalRaise(pdfPath, labelPattern) {
  const text = await extractTextFromPdf(pdfPath);
  return findTotalRaise(text, labelPattern);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/lib/offering-doc.test.mjs`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/offering-doc.mjs scripts/lib/offering-doc.test.mjs
git commit -m "feat: add deterministic total-capital-raise PDF parser"
```

---

### Task 7: Generic multi-batch runner; rewire McNeil extraction for occupancy completeness

**Files:**
- Create: `scripts/lib/run-extraction.mjs`
- Create: `scripts/lib/run-extraction.test.mjs`
- Modify: `scripts/extract-mcneil.mjs`
- Modify: `scripts/extract-mcneil.test.mjs`
- Modify fixtures: `scripts/__fixtures__/raw-mcneil/2026-06/` (add `manifest.json`, rename files to doc-type names)

**Interfaces:**
- Consumes: `loadManifest` from `./archive-store.mjs` (Task 1), `foldMonths` from `./merge-months.mjs` (Task 3).
- Produces: `runGenericExtraction(dealRawDir, outputPath, extractBatch): Promise<{monthsProcessed: string[], batchesProcessed: string[]}>` — used by Task 8.

**What:** Every batch in a deal's raw dir now carries a `manifest.json` (Task 1's format) instead of ad hoc filenames. `runGenericExtraction` walks batches oldest-to-newest, calls a deal-specific `extractBatch(batchDir, manifest)` for each, and folds the results with `foldMonths` — so occupancy (or any field) from an older batch survives even when a newer batch's report doesn't cover it, instead of the current bug where only the most-recently-processed month ever gets occupancy.

- [ ] **Step 1: Write the failing test for the generic runner**

```javascript
// scripts/lib/run-extraction.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { runGenericExtraction } from "./run-extraction.mjs";
import { saveManifest } from "./archive-store.mjs";

const TMP_RAW = "scripts/__fixtures__/tmp-run-extraction-raw";
const TMP_OUTPUT = "scripts/__fixtures__/tmp-run-extraction-output.json";

test("runGenericExtraction folds batches oldest to newest and writes the merged JSON", async () => {
  await rm(TMP_RAW, { recursive: true, force: true });
  await rm(TMP_OUTPUT, { force: true });
  await mkdir(`${TMP_RAW}/2026-01`, { recursive: true });
  await mkdir(`${TMP_RAW}/2026-02`, { recursive: true });
  await saveManifest(`${TMP_RAW}/2026-01`, { files: [] });
  await saveManifest(`${TMP_RAW}/2026-02`, { files: [] });

  const extractBatch = async (batchDir) => {
    if (batchDir.endsWith("2026-01")) {
      return new Map([["2026-01", { occupancyPct: 84.4, noi: 100 }]]);
    }
    return new Map([["2026-01", { occupancyPct: null, noi: 200 }]]);
  };

  const result = await runGenericExtraction(TMP_RAW, TMP_OUTPUT, extractBatch);
  assert.deepEqual(result.monthsProcessed, ["2026-01"]);
  assert.deepEqual(result.batchesProcessed, ["2026-01", "2026-02"]);

  const written = JSON.parse(await readFile(TMP_OUTPUT, "utf8"));
  assert.equal(written["2026-01"].occupancyPct, 84.4, "older batch's occupancy should survive the fold");
  assert.equal(written["2026-01"].noi, 200, "newer batch's non-blank noi should win");

  await rm(TMP_RAW, { recursive: true, force: true });
  await rm(TMP_OUTPUT, { force: true });
});

test("runGenericExtraction returns empty results when the raw dir doesn't exist yet", async () => {
  const result = await runGenericExtraction("scripts/__fixtures__/tmp-does-not-exist", TMP_OUTPUT, async () => new Map());
  assert.deepEqual(result, { monthsProcessed: [], batchesProcessed: [] });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/lib/run-extraction.test.mjs`
Expected: FAIL with "Cannot find module './run-extraction.mjs'".

- [ ] **Step 3: Implement run-extraction.mjs**

```javascript
// scripts/lib/run-extraction.mjs
import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadManifest } from "./archive-store.mjs";
import { foldMonths } from "./merge-months.mjs";
import { saveRecords } from "./record-store.mjs";

export async function runGenericExtraction(dealRawDir, outputPath, extractBatch) {
  let batchNames;
  try {
    batchNames = (await readdir(dealRawDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (err) {
    if (err.code === "ENOENT") return { monthsProcessed: [], batchesProcessed: [] };
    throw err;
  }

  const batches = [];
  for (const batchName of batchNames) {
    const batchDir = path.join(dealRawDir, batchName);
    const manifest = await loadManifest(batchDir);
    const batchMonths = await extractBatch(batchDir, manifest);
    if (batchMonths.size > 0) batches.push(batchMonths);
  }

  const merged = foldMonths(batches);
  const records = {};
  for (const [month, record] of merged) records[month] = record;
  await saveRecords(outputPath, records);

  return { monthsProcessed: [...merged.keys()].sort(), batchesProcessed: batchNames };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/lib/run-extraction.test.mjs`
Expected: 2 pass.

- [ ] **Step 5: Commit the generic runner**

```bash
git add scripts/lib/run-extraction.mjs scripts/lib/run-extraction.test.mjs
git commit -m "feat: add generic multi-batch extraction runner"
```

- [ ] **Step 6: Migrate the raw-mcneil test fixture to the manifest-based layout**

```bash
mkdir -p scripts/__fixtures__/raw-mcneil/2026-06
mv scripts/__fixtures__/raw-mcneil/2026-06/cashflow.pdf scripts/__fixtures__/raw-mcneil/2026-06/cashflow-t12.pdf
mv scripts/__fixtures__/raw-mcneil/2026-06/rentroll.xlsx scripts/__fixtures__/raw-mcneil/2026-06/rentroll.xlsx
```

Create `scripts/__fixtures__/raw-mcneil/2026-06/manifest.json`:

```json
{
  "files": [
    { "docType": "cashflow-t12", "fileName": "cashflow-t12.pdf", "contentHash": "fixture", "sourceEmailSubject": null, "harvestedAt": "2026-06-15T00:00:00.000Z", "batchDateSource": "content" },
    { "docType": "rentroll", "fileName": "rentroll.xlsx", "contentHash": "fixture", "sourceEmailSubject": null, "harvestedAt": "2026-06-15T00:00:00.000Z", "batchDateSource": "content" }
  ]
}
```

- [ ] **Step 7: Write the failing test for the McNeil batch extractor**

Replace the last test in `scripts/extract-mcneil.test.mjs` (`"runMcneilExtraction scans a raw dir..."`) with:

```javascript
test("extractMcneilBatch attaches occupancy only to the month the rent roll's as-of date falls in", async () => {
  const { loadManifest } = await import("./lib/archive-store.mjs");
  const manifest = await loadManifest("scripts/__fixtures__/raw-mcneil/2026-06");
  const months = await extractMcneilBatch("scripts/__fixtures__/raw-mcneil/2026-06", manifest);
  assert.equal(months.get("2026-06").occupancyPct, 84.4);
  assert.equal(months.get("2026-05").occupancyPct, undefined);
});

test("runMcneilExtraction folds batches so an earlier batch's occupancy survives a later batch that lacks a rent roll", async () => {
  const TMP_RAW = "scripts/__fixtures__/tmp-mcneil-fold-raw";
  const outputPath = "scripts/__fixtures__/tmp-mcneil-fold-output.json";
  await rm(TMP_RAW, { recursive: true, force: true });
  await rm(outputPath, { force: true });

  const { mkdir, copyFile } = await import("node:fs/promises");
  const { saveManifest } = await import("./lib/archive-store.mjs");

  await mkdir(`${TMP_RAW}/2026-05`, { recursive: true });
  await copyFile("scripts/__fixtures__/mcneil/2026-06-cashflow-statement.pdf", `${TMP_RAW}/2026-05/cashflow-t12.pdf`);
  await copyFile("scripts/__fixtures__/mcneil/2026-06-rent-roll.xlsx", `${TMP_RAW}/2026-05/rentroll.xlsx`);
  await saveManifest(`${TMP_RAW}/2026-05`, {
    files: [
      { docType: "cashflow-t12", fileName: "cashflow-t12.pdf", contentHash: "a" },
      { docType: "rentroll", fileName: "rentroll.xlsx", contentHash: "b" },
    ],
  });

  await mkdir(`${TMP_RAW}/2026-06`, { recursive: true });
  await copyFile("scripts/__fixtures__/mcneil/2026-06-cashflow-statement.pdf", `${TMP_RAW}/2026-06/cashflow-t12.pdf`);
  await saveManifest(`${TMP_RAW}/2026-06`, {
    files: [{ docType: "cashflow-t12", fileName: "cashflow-t12.pdf", contentHash: "c" }],
  });

  await runMcneilExtraction(TMP_RAW, outputPath);
  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(written["2026-06"].occupancyPct, 84.4, "occupancy from the 2026-05 batch's rent roll should survive into 2026-06");

  await rm(TMP_RAW, { recursive: true, force: true });
  await rm(outputPath, { force: true });
});
```

- [ ] **Step 8: Run tests to verify they fail**

Run: `node --test scripts/extract-mcneil.test.mjs`
Expected: FAIL with "extractMcneilBatch is not a function".

- [ ] **Step 9: Implement extractMcneilBatch and rewire runMcneilExtraction**

In `scripts/extract-mcneil.mjs`, replace the entire `runMcneilExtraction` function (and its now-unused `readdir`/`extractRentRoll`-driving loop) with:

```javascript
import path from "node:path";
import { extractRentRoll } from "./extract-mcneil-rentroll.mjs";
import { runGenericExtraction } from "./lib/run-extraction.mjs";

export async function extractMcneilBatch(batchDir, manifest) {
  const pdfEntry = manifest.files.find((f) => f.docType === "cashflow-t12");
  const months = new Map();
  if (!pdfEntry) return months;

  const pdfPath = path.join(batchDir, pdfEntry.fileName);
  const pnlByMonth = await extractMcneilPnl(pdfPath);
  const distributionByMonth = await extractMcneilDistributions(pdfPath, /Member's Distribution/i);

  const rentrollEntry = manifest.files.find((f) => f.docType === "rentroll");
  const rentRoll = rentrollEntry ? await extractRentRoll(path.join(batchDir, rentrollEntry.fileName)) : null;

  for (const [month, pnl] of pnlByMonth) {
    const record = {
      ...pnl,
      month,
      distribution: distributionByMonth.get(month) ?? 0,
      sourceFile: pdfPath,
      extraction: { method: "deterministic", confidence: "high" },
    };
    if (rentRoll && rentRoll.asOfDate?.startsWith(month)) {
      record.occupancyPct = rentRoll.occupancyPct;
      record.rentRoll = rentRoll;
    }
    months.set(month, record);
  }
  return months;
}

export async function runMcneilExtraction(rawDir, outputPath) {
  return runGenericExtraction(rawDir, outputPath, extractMcneilBatch);
}
```

Remove the old `import { readdir } from "node:fs/promises";` / `import { loadRecords, saveRecords, mergeRecord } from "./lib/record-store.mjs";` block that supported the old per-file loop, if nothing else in the file still uses them (check with `grep -n "readdir\|mergeRecord\|loadRecords" scripts/extract-mcneil.mjs` before removing).

- [ ] **Step 10: Run tests to verify they pass**

Run: `node --test scripts/extract-mcneil.test.mjs`
Expected: 9 pass (8 from Task 4 minus the removed integration test, plus 2 new).

- [ ] **Step 11: Run the full suite to confirm nothing else regressed**

Run: `npm test`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add scripts/extract-mcneil.mjs scripts/extract-mcneil.test.mjs scripts/__fixtures__/raw-mcneil/
git commit -m "feat: rewire McNeil extraction onto the generic batch-fold runner for occupancy completeness"
```

---

### Task 8: Rewire Legacy extraction onto the same generic runner

**Files:**
- Modify: `scripts/extract-legacy.mjs`
- Modify: `scripts/extract-legacy.test.mjs`
- Modify fixtures: `scripts/__fixtures__/raw-legacy/2026-05/` (add `manifest.json`, rename file to `monthly-update.pdf`)

**Interfaces:**
- Consumes: `runGenericExtraction` from `./lib/run-extraction.mjs` (Task 7).

**What:** Same generalization as Task 7, applied to Legacy. Legacy's occupancy already only ever applies to the report's own "current" month (a real limitation of the source document, not a pipeline bug) — but once more monthly batches accumulate over time, each batch's own occupancy now survives in the fold instead of being at risk of being overwritten, exactly like McNeil.

- [ ] **Step 1: Migrate the raw-legacy test fixture to the manifest-based layout**

```bash
mv scripts/__fixtures__/raw-legacy/2026-05/report.pdf scripts/__fixtures__/raw-legacy/2026-05/monthly-update.pdf
```

Create `scripts/__fixtures__/raw-legacy/2026-05/manifest.json`:

```json
{
  "files": [
    { "docType": "monthly-update", "fileName": "monthly-update.pdf", "contentHash": "fixture", "sourceEmailSubject": null, "harvestedAt": "2026-05-20T00:00:00.000Z", "batchDateSource": "content" }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

Replace the last test in `scripts/extract-legacy.test.mjs` (the `runLegacyExtraction` integration test, if present — check via `grep -n "runLegacyExtraction" scripts/extract-legacy.test.mjs`) with:

```javascript
test("extractLegacyBatch reads the monthly-update doc via manifest and returns records keyed by month", async () => {
  const { loadManifest } = await import("./lib/archive-store.mjs");
  const manifest = await loadManifest("scripts/__fixtures__/raw-legacy/2026-05");
  const records = await extractLegacyBatch("scripts/__fixtures__/raw-legacy/2026-05", manifest, null);
  assert.ok(records.has("2026-05"));
  assert.equal(records.get("2026-05").occupancyPct, 74);
});

test("runLegacyExtraction produces the same May 2026 occupancy via the batch-based path", async () => {
  const outputPath = "scripts/__fixtures__/tmp-legacy-output.json";
  await runLegacyExtraction(null, "scripts/__fixtures__/raw-legacy", outputPath);
  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(written["2026-05"].occupancyPct, 74);
  await rm(outputPath, { force: true });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test scripts/extract-legacy.test.mjs`
Expected: FAIL with "extractLegacyBatch is not a function".

- [ ] **Step 4: Implement extractLegacyBatch and rewire runLegacyExtraction**

In `scripts/extract-legacy.mjs`, replace the entire `runLegacyExtraction` function with:

```javascript
import { runGenericExtraction } from "./lib/run-extraction.mjs";

export async function extractLegacyBatch(batchDir, manifest, config) {
  const entry = manifest.files.find((f) => f.docType === "monthly-update");
  if (!entry) return new Map();
  const pdfPath = path.join(batchDir, entry.fileName);
  const batchMonth = path.basename(batchDir);
  const records = await extractLegacyMonth(config, pdfPath, batchMonth);
  return new Map(Object.entries(records));
}

export async function runLegacyExtraction(config, rawDir, outputPath) {
  return runGenericExtraction(rawDir, outputPath, (batchDir, manifest) => extractLegacyBatch(batchDir, manifest, config));
}
```

Remove the old `import { readdir } from "node:fs/promises";` / `mergeRecord`-based loop it replaces, if nothing else in the file still needs them.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/extract-legacy.test.mjs`
Expected: all pass, including the 2 new tests.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/extract-legacy.mjs scripts/extract-legacy.test.mjs scripts/__fixtures__/raw-legacy/
git commit -m "feat: rewire Legacy extraction onto the generic batch-fold runner"
```

---

### Task 9: Harden harvest.mjs to DOM-only downloads; add distribution/ownership parsers

**Files:**
- Modify: `scripts/harvest.mjs`
- Modify: `scripts/harvest.test.mjs`

**Interfaces:**
- Produces: `parseDistributionText(text): Array<{date: string, amount: number}>`, `parseOwnershipPct(text): number|null` — used by Task 12. `scrapeDistributions(page, dealId)` and `scrapeOwnershipPct(page, dealId)` are browser-driving glue with no automated test (see Step 5); the click-based download replacement is inlined into `harvestDeal` rather than extracted as its own function.

**What:** Two independent changes: (1) replace the raw `page.request.get(href)` attachment download with a real click + captured browser download event, closing the narrow compliance ambiguity noted in `CLAUDE.md`; (2) add pure, unit-tested parsers for distribution-history and ownership-percentage text, plus the DOM-scraping functions that feed them (used live in Task 12).

- [ ] **Step 1: Write the failing tests for the pure parsers**

Add to `scripts/harvest.test.mjs`:

```javascript
import { parseDistributionText, parseOwnershipPct } from "./harvest.mjs";
```

```javascript
test("parseDistributionText extracts quarter and amount from 'Q3 2025' style rows", () => {
  const text = "Distribution History\nQ3 2025   $699.99\nQ4 2025   $648.14\n";
  const result = parseDistributionText(text);
  assert.deepEqual(result, [
    { date: "2025-Q3", amount: 699.99 },
    { date: "2025-Q4", amount: 648.14 },
  ]);
});

test("parseDistributionText extracts rows in '2026-Q2' style too", () => {
  const text = "2026-Q1   $648.14\n2026-Q2   $648.14\n";
  const result = parseDistributionText(text);
  assert.deepEqual(result, [
    { date: "2026-Q1", amount: 648.14 },
    { date: "2026-Q2", amount: 648.14 },
  ]);
});

test("parseOwnershipPct extracts a percentage followed by 'ownership'", () => {
  assert.equal(parseOwnershipPct("Your ownership: 2.59% ownership of the deal"), 2.59);
});

test("parseOwnershipPct returns null when no percentage is present", () => {
  assert.equal(parseOwnershipPct("No ownership figures shown yet"), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/harvest.test.mjs`
Expected: FAIL with "parseDistributionText is not a function".

- [ ] **Step 3: Implement the pure parsers in harvest.mjs**

Add near the top of `scripts/harvest.mjs`, after the existing `MONTH_NAMES` constant:

```javascript
export function parseDistributionText(text) {
  const rows = [];
  const lineRegex = /(Q[1-4]\s*\d{4}|\d{4}\s*Q[1-4])\D{0,10}\$?([\d,]+\.\d{2})/g;
  let match;
  while ((match = lineRegex.exec(text))) {
    const period = match[1].replace(/\s+/g, " ").trim();
    const parts = period.match(/Q([1-4])\s*(\d{4})|(\d{4})\s*Q([1-4])/);
    const quarter = parts[1] ?? parts[4];
    const year = parts[2] ?? parts[3];
    rows.push({ date: `${year}-Q${quarter}`, amount: parseFloat(match[2].replace(/,/g, "")) });
  }
  return rows;
}

export function parseOwnershipPct(text) {
  const match = text.match(/([\d.]+)\s*%\s*(?:ownership|equity|of the deal)/i);
  return match ? parseFloat(match[1]) : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/harvest.test.mjs`
Expected: all pass.

- [ ] **Step 5: Harden the attachment download and add DOM-scraping functions (no automated test — browser-driving code)**

In `scripts/harvest.mjs`, inside `harvestDeal`, replace:

```javascript
    for (const { name, href } of attachmentLinks) {
      const response = await page.request.get(href);
      const buffer = await response.body();
      const safeName = name.replace(/[^a-zA-Z0-9.\- ]/g, "_");
      await writeFile(path.join(monthDir, safeName), buffer);
    }
```

With:

```javascript
    for (const { name, href } of attachmentLinks) {
      const safeName = name.replace(/[^a-zA-Z0-9.\- ]/g, "_");
      const link = page.locator(`a[href="${href}"]`).first();
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        link.click(),
      ]);
      await download.saveAs(path.join(monthDir, safeName));
    }
```

Then add, after `harvestDeal`'s closing brace:

```javascript
export async function scrapeDistributions(page, dealId) {
  await page.goto(`${PORTAL_BASE}/app/deals/${dealId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  const viewAll = page.locator("text=View all").first();
  if (await viewAll.isVisible().catch(() => false)) {
    await viewAll.click();
    await page.waitForTimeout(1000);
  }
  const text = await page.evaluate(() => document.body.innerText);
  return parseDistributionText(text);
}

export async function scrapeOwnershipPct(page, dealId) {
  await page.goto(`${PORTAL_BASE}/app/deals/${dealId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  const text = await page.evaluate(() => document.body.innerText);
  return parseOwnershipPct(text);
}
```

This step has no automated test — it requires a live, logged-in Chrome session (per `CLAUDE.md`, this is the compliant DOM-only path). It's exercised manually in Task 12.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass (new parser tests + all existing).

- [ ] **Step 7: Commit**

```bash
git add scripts/harvest.mjs scripts/harvest.test.mjs
git commit -m "feat: harden attachment downloads to click-based; add distribution/ownership DOM parsers"
```

---

### Task 10: Compliance audit script

**Files:**
- Create: `scripts/audit-no-api-calls.mjs`
- Test: `scripts/audit-no-api-calls.test.mjs`

**Interfaces:**
- Produces: `findViolations(dirPath): Promise<Array<{file: string, line: number, match: string}>>`, CLI entrypoint that exits non-zero if any are found.

- [ ] **Step 1: Write the failing tests**

```javascript
// scripts/audit-no-api-calls.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { findViolations } from "./audit-no-api-calls.mjs";

const TMP_DIR = "scripts/__fixtures__/tmp-audit-scripts";

test("flags a direct call to api.cashflowportal.com", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
  await writeFile(`${TMP_DIR}/bad.mjs`, 'const resp = await page.request.post("https://api.cashflowportal.com/graphql/");\n');
  const violations = await findViolations(TMP_DIR);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, `${TMP_DIR}/bad.mjs`);
  await rm(TMP_DIR, { recursive: true, force: true });
});

test("flags reuse of the __access_token cookie", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
  await writeFile(`${TMP_DIR}/bad.mjs`, 'const token = cookies.find(c => c.name === "__access_token");\n');
  const violations = await findViolations(TMP_DIR);
  assert.equal(violations.length, 1);
  await rm(TMP_DIR, { recursive: true, force: true });
});

test("passes clean files with no violations", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
  await writeFile(`${TMP_DIR}/good.mjs`, 'await page.goto("https://whitepagodagroup.cashflowportal.com/app");\n');
  const violations = await findViolations(TMP_DIR);
  assert.equal(violations.length, 0);
  await rm(TMP_DIR, { recursive: true, force: true });
});

test("scans subdirectories recursively", async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(`${TMP_DIR}/nested`, { recursive: true });
  await writeFile(`${TMP_DIR}/nested/bad.mjs`, 'fetch("https://api.cashflowportal.com/v1/deals/1");\n');
  const violations = await findViolations(TMP_DIR);
  assert.equal(violations.length, 1);
  await rm(TMP_DIR, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/audit-no-api-calls.test.mjs`
Expected: FAIL with "Cannot find module './audit-no-api-calls.mjs'".

- [ ] **Step 3: Implement audit-no-api-calls.mjs**

```javascript
// scripts/audit-no-api-calls.mjs
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const BANNED_PATTERNS = [/api\.cashflowportal\.com/, /__access_token/];

export async function findViolations(dirPath) {
  const violations = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      violations.push(...(await findViolations(fullPath)));
      continue;
    }
    if (!entry.name.endsWith(".mjs") && !entry.name.endsWith(".js")) continue;
    const content = await readFile(fullPath, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      for (const pattern of BANNED_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({ file: fullPath, line: i + 1, match: line.trim() });
        }
      }
    });
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = await findViolations("scripts");
  if (violations.length > 0) {
    console.error("Compliance audit FAILED — direct CashFlowPortal API access found:");
    for (const v of violations) console.error(`  ${v.file}:${v.line}: ${v.match}`);
    process.exit(1);
  }
  console.log("Compliance audit passed — no direct API access found in scripts/.");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/audit-no-api-calls.test.mjs`
Expected: 4 pass.

- [ ] **Step 5: Wire the audit into npm test**

In `package.json`, change the `test` script:

```json
"test": "node --test \"scripts/**/*.test.mjs\" && node scripts/audit-no-api-calls.mjs",
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all tests pass, followed by "Compliance audit passed — no direct API access found in scripts/."

- [ ] **Step 7: Commit**

```bash
git add scripts/audit-no-api-calls.mjs scripts/audit-no-api-calls.test.mjs package.json
git commit -m "feat: add compliance audit script; wire into npm test"
```

---

### Task 11: Raw archive migration script

**Files:**
- Create: `scripts/migrate-raw-archive.mjs`
- Test: `scripts/migrate-raw-archive.test.mjs`

**Interfaces:**
- Consumes: `archiveFile` from `./lib/archive-store.mjs` (Task 1), `resolveBatchDate` from `./lib/batch-date.mjs` (Task 2), `extractTextFromPdf` from `./lib/offering-doc.mjs` (Task 6), each deal's `classifyDoc` (Task 5).
- Produces: `planMigration(oldRawDir, dealConfig): Promise<Array<{oldPath, batchKey, docType, ext, buffer}>>`, `runMigration(oldRawDir, newRawDir, dealConfig): Promise<Array<{oldPath, batchKey, docType, ext, written, duplicateOf?}>>` — used manually in Task 12.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/migrate-raw-archive.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { runMigration } from "./migrate-raw-archive.mjs";
import * as mcneilConfig from "./deals/mcneil.config.mjs";

test("migrates the raw-mcneil fixture into batch-vintage folders with normalized doc types", async () => {
  const NEW_DIR = "scripts/__fixtures__/tmp-migrated-mcneil";
  await rm(NEW_DIR, { recursive: true, force: true });
  const results = await runMigration("scripts/__fixtures__/raw-mcneil", NEW_DIR, mcneilConfig);

  const cashflowResult = results.find((r) => r.oldPath.endsWith("cashflow-t12.pdf"));
  assert.equal(cashflowResult.docType, "cashflow-t12");
  assert.equal(cashflowResult.batchKey, "2026-06");
  assert.equal(cashflowResult.written, true);

  const rentrollResult = results.find((r) => r.oldPath.endsWith("rentroll.xlsx"));
  assert.equal(rentrollResult.docType, "rentroll");

  await rm(NEW_DIR, { recursive: true, force: true });
});

test("skips manifest.json itself when migrating an already-archived directory", async () => {
  const NEW_DIR = "scripts/__fixtures__/tmp-migrated-mcneil-2";
  await rm(NEW_DIR, { recursive: true, force: true });
  const results = await runMigration("scripts/__fixtures__/raw-mcneil", NEW_DIR, mcneilConfig);
  assert.ok(!results.some((r) => r.oldPath.endsWith("manifest.json")));
  await rm(NEW_DIR, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/migrate-raw-archive.test.mjs`
Expected: FAIL with "Cannot find module './migrate-raw-archive.mjs'".

- [ ] **Step 3: Implement migrate-raw-archive.mjs**

```javascript
// scripts/migrate-raw-archive.mjs
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { archiveFile } from "./lib/archive-store.mjs";
import { resolveBatchDate } from "./lib/batch-date.mjs";
import { extractTextFromPdf } from "./lib/offering-doc.mjs";

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
      const text = ext === "pdf" ? await extractTextFromPdf(filePath).catch(() => "") : "";
      const docType = dealConfig.classifyDoc({ filename: file.name, text });
      const { batchKey } = resolveBatchDate({ text, harvestedAt: `${monthDir}-01T00:00:00.000Z` });
      plan.push({ oldPath: filePath, batchKey, docType, ext, buffer });
    }
  }
  return plan;
}

export async function runMigration(oldRawDir, newRawDir, dealConfig) {
  const plan = await planMigration(oldRawDir, dealConfig);
  const results = [];
  for (const entry of plan) {
    const result = await archiveFile(newRawDir, entry.batchKey, entry.docType, entry.ext, entry.buffer, {
      batchDateSource: "content",
    });
    results.push({ ...entry, ...result });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , dealSlug, oldDir, newDir] = process.argv;
  if (!dealSlug || !oldDir || !newDir) {
    console.error("Usage: node scripts/migrate-raw-archive.mjs <dealSlug> <oldRawDir> <newRawDir>");
    process.exit(1);
  }
  const dealConfig = await import(`./deals/${dealSlug}.config.mjs`);
  const results = await runMigration(oldDir, newDir, dealConfig);
  for (const r of results) {
    console.log(`${r.written ? "moved" : "skipped (dup of " + r.duplicateOf + ")"}: ${r.oldPath} -> ${r.batchKey}/${r.docType}.${r.ext}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/migrate-raw-archive.test.mjs`
Expected: 2 pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-raw-archive.mjs scripts/migrate-raw-archive.test.mjs
git commit -m "feat: add raw-archive migration script"
```

---

### Task 12: Compliance rewrite — re-derive tainted data, delete non-compliant script, re-harvest real archives

**Prerequisite:** Chrome running with `--remote-debugging-port=9222`, logged into CashFlowPortal, per the README. Every step below follows `CLAUDE.md` — DOM navigation, reading rendered text, clicking real elements, downloading via captured browser events. No step in this task issues or replays a request against `api.cashflowportal.com`.

**Files:**
- Delete: `scripts/extract-mcneil-2025.mjs`
- Modify: `data/capital.json`, `data/distributions.json`, `data/mcneil.json`
- Migrate: `data/raw/mcneil/`, `data/raw/legacy/` (via Task 11's script)

This task has no unit tests of its own — it's the live re-derivation the whole plan exists to enable. Each step has an explicit, checkable expected outcome instead.

- [ ] **Step 1: Delete the untested, unreproducible script**

```bash
rm scripts/extract-mcneil-2025.mjs
```

- [ ] **Step 2: Migrate the real raw archives**

```bash
node scripts/migrate-raw-archive.mjs mcneil data/raw/mcneil data/raw/mcneil-migrated
node scripts/migrate-raw-archive.mjs legacy data/raw/legacy data/raw/legacy-migrated
```

Expected: console output shows the McNeil duplicates (2025-05/08/09/10/11/12) collapsing to a small number of distinct batches (skipped entries print "skipped (dup of ...)"). Inspect `data/raw/mcneil-migrated/` manually — confirm one batch folder per distinct `Printed <date>` value found earlier (2025-01, and whichever batch date the Sept-2025 balance sheet resolves to), each with a `manifest.json`.

- [ ] **Step 3: Re-harvest to fill the gaps the old archive is missing**

Using `harvestDeal` (Task 9's hardened version) and `scrapeDistributions`/`scrapeOwnershipPct` (also Task 9), pull:
- The McNeil offering/subscription document (needed for `data/capital.json.totalRaise` — locate it via the Documents tab, download via real click).
- Any McNeil batches not already covered by the migrated archive (e.g., if a 2025-Q3-covering T12 report exists as its own email that was never harvested).
- Legacy's offering document, for the same reason.

Write these into `data/raw/mcneil-migrated/<batch>/offering-doc.pdf` and `data/raw/legacy-migrated/<batch>/offering-doc.pdf` respectively, using `archiveFile` from Task 1 directly (same dedup behavior).

Expected: `data/raw/mcneil-migrated/` and `data/raw/legacy-migrated/` each contain an `offering-doc.pdf` in some batch folder.

- [ ] **Step 4: Swap in the migrated archives (non-destructively)**

`data/raw/` is gitignored — the original PDFs/XLSX files under `data/raw/mcneil` and `data/raw/legacy` have no backup anywhere (not in git, not pushed). Rename, don't delete, so a migration bug can't cause permanent data loss:

```bash
mv data/raw/mcneil data/raw/mcneil.pre-migration-backup
mv data/raw/legacy data/raw/legacy.pre-migration-backup
mv data/raw/mcneil-migrated data/raw/mcneil
mv data/raw/legacy-migrated data/raw/legacy
```

Only delete `data/raw/mcneil.pre-migration-backup` and `data/raw/legacy.pre-migration-backup` after Task 13's full end-to-end verification passes — add this as the first step of Task 13, not here.

- [ ] **Step 5: Re-derive capital.json**

Run `extractTotalRaise` (Task 6) against the harvested offering docs with each deal's `totalRaiseLabel` (Task 5), and `scrapeOwnershipPct` (Task 9) against each deal's page as a cross-check. Write the results:

```json
{
  "legacy": { "totalRaise": <value>, "larryInvestment": 50000, "ownershipPctCheck": <value from DOM> },
  "mcneil": { "totalRaise": <value>, "larryInvestment": 50000, "ownershipPctCheck": <value from DOM> }
}
```

Expected: `50000 / totalRaise` for each deal is within a few hundredths of a percent of `ownershipPctCheck` — if not, do not silently pick one; leave both fields in place for `build-dashboard.mjs` (a later, separate dashboard-rework plan) to surface as a flag.

- [ ] **Step 6: Re-derive distributions.json**

Run `scrapeDistributions` (Task 9) against the McNeil and Legacy deal pages (clicking "View all" to capture every row) to get `myDistribution` per quarter. Separately, run `runMcneilExtraction` (now producing a `distribution` field per month via Task 7) and aggregate months into quarters to get `totalDistribution` per quarter for McNeil. Write:

```json
{
  "legacy": [],
  "mcneil": [
    { "date": "2025-Q3", "myDistribution": <DOM value>, "totalDistribution": <PDF-derived value> },
    ...
  ]
}
```

Expected: every quarter DOM-scraping returns for McNeil (all 7, via "View all") appears in the array — replacing the previously committed, API-sourced 7 entries entirely.

- [ ] **Step 7: Regenerate mcneil.json from the real archive**

```bash
node scripts/extract-mcneil.mjs
```

Expected: `data/mcneil.json` now contains 2024-09 through 2026-06 (or whatever the real re-harvested archive covers) sourced entirely from real, retained documents under `data/raw/mcneil/` — no entries whose `sourceFile` points at a `/tmp` path or a truncated placeholder string.

- [ ] **Step 8: Run the full suite and the compliance audit**

Run: `npm test`
Expected: all pass, including the Task 10 audit step.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "fix: re-derive capital/distribution/McNeil-2024-2025 data through the compliant DOM-only pipeline"
```

---

### Task 13: Final wiring and end-to-end verification

**Files:**
- Modify: `scripts/build-dashboard.mjs` (only if field names changed — check against Task 7's `distribution` field and Task 12's `capital.json`/`distributions.json` shapes)
- Modify: `scripts/refresh.mjs` (only if any function signatures changed)

**What:** Confirm the whole `npm run refresh` pipeline still runs end to end against the new archive layout, and that no dashboard-facing consumer (`build-dashboard.mjs`) reads a field name that no longer exists. (The dashboard's own rendering logic — waterfall chart, distribution chart placement, ledger/chart alignment — is out of scope for this plan; see the follow-up dashboard-rework plan.)

- [ ] **Step 1: Check build-dashboard.mjs against the new data shapes**

Run: `grep -n "totalRaise\|distribution\|occupancyPct" scripts/build-dashboard.mjs`

For each match, confirm the field still exists with the same name in `data/capital.json`/`data/distributions.json`/`data/mcneil.json` as written by Task 12. If a field was renamed (e.g. plain `amount` → `myDistribution`/`totalDistribution` in `distributions.json`), update `build-dashboard.mjs`'s corresponding reads to match.

- [ ] **Step 2: Run the full refresh pipeline**

Run: `node scripts/build-dashboard.mjs`
Expected: `dashboard/data.js` is written without errors.

- [ ] **Step 3: Run the full test suite one final time**

Run: `npm test`
Expected: all pass, including the compliance audit.

- [ ] **Step 4: Manual dashboard smoke check**

Open `dashboard/index.html` directly in a browser. Confirm:
- McNeil and Legacy each show occupancy for more months than before (not just the single latest month).
- "Total capital raise" is no longer blank for either deal.
- The distribution history section shows both a "my distribution" and a "total distribution" number, not a back-calculated one.

- [ ] **Step 5: Delete the pre-migration backups now that Steps 2-4 have verified the new archive end to end**

```bash
rm -rf data/raw/mcneil.pre-migration-backup data/raw/legacy.pre-migration-backup
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: wire generic pipeline output into build-dashboard end to end"
```
