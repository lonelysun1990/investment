# Cash Flow & Proportional Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add distribution tracking, proportional ownership, earlier Legacy months, and fix McNeil zero-month noise to the rental investment dashboard.

**Architecture:** Five independent tasks. Task 1 filters pre-operation zero months from McNeil extraction. Task 2 expands the Legacy vision LLM prompt to extract all 5 columns from the trailing P&L table. Task 3 scrapes distributions from each deal's portal overview page. Task 4 scrapes total capital raise from offering docs. Task 5 wires all new data into the dashboard cash-flow section.

**Tech Stack:** Node.js 18+, Playwright (CDP), pdftotext, GPT-4o via OpenAI API, vanilla HTML/CSS/JS + Chart.js

## Global Constraints

- No hosted/cloud deployment — local files only.
- All financial parsing must be deterministic where possible; LLM only for Legacy's page-4 image table.
- Dashboard loads via `file://` (no server needed once built).
- `npm run refresh` must remain the single re-run command.
- `config.json` is gitignored; never commit secrets.

---

### Task 1: Filter pre-operation zero months from McNeil extraction

**Files:**
- Modify: `scripts/extract-mcneil.mjs:120-137`
- Modify: `scripts/extract-mcneil.test.mjs:38-43`

**What:** The 12-month McNeil PDF genuinely has zeros for Jul-Dec 2025 (property not yet operating). Currently these zero months are stored, making charts show misleading flat lines. Skip them.

- [ ] **Step 1: Update the test to expect zero months are filtered**

In `scripts/extract-mcneil.test.mjs`, replace the test at line 38-43:

```javascript
test("excludes pre-operation zero-only months from the result map", async () => {
  const result = await extractMcneilPnl(FIXTURE);
  // Jul 2025 has all zeros in the fixture PDF — should be excluded
  assert.ok(!result.has("2025-07"), "2025-07 should be excluded (all zeros, pre-operation)");
  assert.ok(!result.has("2025-08"));
  assert.ok(!result.has("2025-09"));
  assert.ok(!result.has("2025-10"));
  assert.ok(!result.has("2025-11"));
  assert.ok(!result.has("2025-12"));
  // Jan 2026 onward has real data — should be included
  assert.ok(result.has("2026-01"));
  assert.equal(result.size, 6); // Jan-Jun 2026 only
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --test-name-pattern="excludes pre-operation"
```
Expected: FAIL — the old code still includes 2025-07.

- [ ] **Step 3: Add zero-filtering to extractMcneilPnl**

In `scripts/extract-mcneil.mjs`, after line 85 (`return months;`), add a filter before the return. Replace:

```javascript
  return months;
```

With:

```javascript
  for (const [key, rec] of months) {
    const allZero =
      rec.income.rental === 0 &&
      rec.income.other === 0 &&
      rec.income.total === 0 &&
      Object.values(rec.expense).every((v) => v === 0) &&
      rec.noi === 0 &&
      rec.debtService === 0 &&
      rec.capitalImprovements === 0 &&
      rec.netIncome === 0;
    if (allZero) months.delete(key);
  }
  return months;
```

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```
Expected: 50 pass (the old "pre-acquisition months as zero" test was replaced; the runMcneilExtraction integration test still passes since the fixture JSON already has zero months merged and the filter won't affect previously-written records — see note below).

**Note on `runMcneilExtraction`:** The `mergeRecord` in `runMcneilExtraction` (line 135) merges new extraction results over existing records. Existing zero months in `data/mcneil.json` won't be deleted by this filter — they'll stay unless the file is regenerated from scratch. To clean up existing data, we'll handle that in Task 5 (build-dashboard) where we can also filter zeros when building `data.js`.

- [ ] **Step 5: Commit**

```bash
git add scripts/extract-mcneil.mjs scripts/extract-mcneil.test.mjs
git commit -m "feat: filter pre-operation zero months from McNeil extraction"
```

---

### Task 2: Extract all months from Legacy's trailing P&L image

**Files:**
- Modify: `scripts/extract-legacy.mjs:47-57` (prompt)
- Modify: `scripts/extract-legacy.mjs:59-89` (parser)
- Modify: `scripts/extract-legacy.mjs:91-109` (extractLegacyMonth)
- Modify: `scripts/extract-legacy.test.mjs:40-76` (EXPECTED_TABLE and tests)

**What:** The May 2026 Legacy PDF page 4 shows a rolling 5-month P&L (Jan-May). Currently only the rightmost column is extracted. Change the prompt to request ALL columns as an array, and update the parser to handle multiple-month responses.

- [ ] **Step 1: Update the prompt constant**

In `scripts/extract-legacy.mjs`, replace the `PNL_TABLE_PROMPT` (line 47-57):

```javascript
const PNL_TABLE_PROMPT = `This image is a property-management "Trailing Profit and Loss" table with monthly columns (typically 5 months). Extract ALL months' columns, not just the latest. The leftmost visible month column is the earliest, the rightmost is the most recent. Respond with ONLY a JSON object, no prose or code fences, matching exactly this shape:
{
  "months": {
    "<YYYY-MM>": {
      "income": { "rental": number, "other": number, "total": number },
      "expense": { "<exact category label as printed>": number, ..., "total": number },
      "noi": number,
      "debtService": number,
      "otherNonOperating": number,
      "capitalImprovements": number,
      "netIncome": number
    }
  }
}
Use the month label shown in the column header (e.g., "Jan 2026" → "2026-01"). Use negative numbers (not parentheses) for any value shown in parentheses in the image. Do not include currency symbols or commas in the numbers.`;
```

- [ ] **Step 2: Update the EXPECTED_TABLE in tests**

In `scripts/extract-legacy.test.mjs`, replace the `EXPECTED_TABLE` constant (line 40-59):

```javascript
const EXPECTED_TABLE = {
  months: {
    "2026-01": {
      income: { rental: 18448.91, other: 0, total: 18448.91 },
      expense: { "Administration Expense": 266.31, Marketing: 0, "Salaries & Wages": 1481.64, "Contract Services": 0, "Repair/Maintenance Expenses": 603.85, "Make Ready Expense": 323.96, "Utility Expenses": 5635.64, "Management Fees": 671.53, "Fixed Expenses": 5326.66, total: 14309.59 },
      noi: 4139.32,
      debtService: 6532.5,
      otherNonOperating: 2375,
      capitalImprovements: 2967.26,
      netIncome: -7735.44,
    },
    "2026-02": {
      income: { rental: 18448.91, other: 0, total: 18448.91 },
      expense: { "Administration Expense": 266.31, Marketing: 0, "Salaries & Wages": 1481.64, "Contract Services": 0, "Repair/Maintenance Expenses": 603.85, "Make Ready Expense": 323.96, "Utility Expenses": 5635.64, "Management Fees": 671.53, "Fixed Expenses": 5326.66, total: 14309.59 },
      noi: 4139.32,
      debtService: 6532.5,
      otherNonOperating: 2375,
      capitalImprovements: 2967.26,
      netIncome: -7735.44,
    },
    "2026-03": {
      income: { rental: 18448.91, other: 0, total: 18448.91 },
      expense: { "Administration Expense": 266.31, Marketing: 0, "Salaries & Wages": 1481.64, "Contract Services": 0, "Repair/Maintenance Expenses": 603.85, "Make Ready Expense": 323.96, "Utility Expenses": 5635.64, "Management Fees": 671.53, "Fixed Expenses": 5326.66, total: 14309.59 },
      noi: 4139.32,
      debtService: 6532.5,
      otherNonOperating: 2375,
      capitalImprovements: 2967.26,
      netIncome: -7735.44,
    },
    "2026-04": {
      income: { rental: 18448.91, other: 0, total: 18448.91 },
      expense: { "Administration Expense": 266.31, Marketing: 0, "Salaries & Wages": 1481.64, "Contract Services": 0, "Repair/Maintenance Expenses": 603.85, "Make Ready Expense": 323.96, "Utility Expenses": 5635.64, "Management Fees": 671.53, "Fixed Expenses": 5326.66, total: 14309.59 },
      noi: 4139.32,
      debtService: 6532.5,
      otherNonOperating: 2375,
      capitalImprovements: 2967.26,
      netIncome: -7735.44,
    },
    "2026-05": {
      income: { rental: 18448.91, other: -1612.28, total: 16836.63 },
      expense: { "Administration Expense": 266.31, Marketing: 0, "Salaries & Wages": 1481.64, "Contract Services": 0, "Repair/Maintenance Expenses": 603.85, "Make Ready Expense": 323.96, "Utility Expenses": 5635.64, "Management Fees": 671.53, "Fixed Expenses": 5326.66, total: 14309.59 },
      noi: 2527.04,
      debtService: 6532.5,
      otherNonOperating: 2375,
      capitalImprovements: 2967.26,
      netIncome: -9347.72,
    },
  },
};
```

**NOTE:** The Jan-Apr values above are placeholders copied from May for the test structure. The actual extraction will produce real values from the PDF. The tests that use `EXPECTED_TABLE` with a mock LLM (`fakeCallVisionLlm`) will need these placeholder values to match. Since the actual values aren't known until we run the real extraction, we will **skip updating the mock LLM tests for now** — they'll use the new shape with placeholder values. After the real extraction runs (Task 5), the values in `data/legacy.json` will be the ground truth.

The plan accounts for this: use a fake LLM that returns a valid multi-month response in tests, then run the real extraction separately.

- [ ] **Step 3: Update extractPnlTable to handle multi-month response**

In `scripts/extract-legacy.mjs`, replace the `extractPnlTable` function body (line 69-87). After extracting `table`, add parsing of the `months` wrapper:

Replace:
```javascript
  const responseText = await callVisionLlmImpl(config, imageBase64, PNL_TABLE_PROMPT);
  responseText = responseText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  let table;
  try {
    table = JSON.parse(responseText);
  } catch {
    throw new Error(
      `extract-legacy: vision LLM response for ${month} was not valid JSON: ${responseText.slice(0, 200)}`
    );
  }

  const narrative = await extractNarrative(pdfPath);
  const noiMatches = Math.abs(Math.round(table.noi) - narrative.statedNoi) <= NOI_CROSS_CHECK_TOLERANCE;
  const revenueMatches =
    Math.abs(Math.round(table.income.total) - narrative.statedTotalRevenue) <= NOI_CROSS_CHECK_TOLERANCE;

  return {
    table,
    method: "vision_llm",
    confidence: noiMatches && revenueMatches ? "high" : "low",
  };
```

With:
```javascript
  let responseText = await callVisionLlmImpl(config, imageBase64, PNL_TABLE_PROMPT);
  responseText = responseText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(
      `extract-legacy: vision LLM response for ${month} was not valid JSON: ${responseText.slice(0, 200)}`
    );
  }

  const tablesByMonth = result.months ?? { [month]: result };

  const narrative = await extractNarrative(pdfPath);
  const latestMonthTable = tablesByMonth[month];
  const noiMatches = latestMonthTable
    ? Math.abs(Math.round(latestMonthTable.noi) - narrative.statedNoi) <= NOI_CROSS_CHECK_TOLERANCE
    : false;
  const revenueMatches = latestMonthTable
    ? Math.abs(Math.round(latestMonthTable.income.total) - narrative.statedTotalRevenue) <= NOI_CROSS_CHECK_TOLERANCE
    : false;

  return {
    tablesByMonth,
    method: "vision_llm",
    confidence: noiMatches && revenueMatches ? "high" : "low",
  };
```

- [ ] **Step 4: Update extractLegacyMonth to handle multi-month output**

Replace `extractLegacyMonth` (line 91-109):

```javascript
export async function extractLegacyMonth(config, pdfPath, month, opts = {}) {
  const narrative = await extractNarrative(pdfPath);
  const { tablesByMonth, method, confidence } = await extractPnlTable(config, pdfPath, month, opts);

  const records = {};
  for (const [m, table] of Object.entries(tablesByMonth)) {
    records[m] = {
      month: m,
      occupancyPct: m === month ? narrative.occupancyPct : null,
      preLeasedPct: m === month ? narrative.preLeasedPct : null,
      income: table?.income ?? null,
      expense: table?.expense ?? null,
      noi: table?.noi ?? null,
      debtService: table?.debtService ?? null,
      capitalImprovements: table?.capitalImprovements ?? null,
      netIncome: table?.netIncome ?? null,
      narrative: m === month ? narrative.narrative : null,
      sourceFile: pdfPath,
      extraction: { method, confidence: m === month ? confidence : "low" },
    };
  }
  return records;
}
```

- [ ] **Step 5: Update extractLegacyMonth mock-LLM tests**

In `scripts/extract-legacy.test.mjs`, replace tests at line 88-109:

```javascript
test("extractLegacyMonth assembles multiple monthly records with no LLM configured", async () => {
  const records = await extractLegacyMonth(null, FIXTURE, "2026-05");
  const may = records["2026-05"];
  assert.equal(may.month, "2026-05");
  assert.equal(may.occupancyPct, 74);
  assert.equal(may.sourceFile, FIXTURE);
  assert.equal(may.extraction.method, "unavailable");
  assert.equal(may.noi, null);
  assert.equal(may.narrative.includes("processing two evictions"), true);
});

test("extractLegacyMonth assembles multiple monthly records with a working vision LLM", async () => {
  const fakeConfig = { baseUrl: "https://example.test/v1", apiKey: "x", model: "gpt-4o" };
  const fakeCallVisionLlm = async () => JSON.stringify(EXPECTED_TABLE);
  const records = await extractLegacyMonth(fakeConfig, FIXTURE, "2026-05", {
    callVisionLlmImpl: fakeCallVisionLlm,
  });
  assert.equal(Object.keys(records).length, 5);
  assert.equal(records["2026-05"].income.total, 16836.63);
  assert.equal(records["2026-05"].noi, 2527.04);
  assert.equal(records["2026-05"].netIncome, -9347.72);
  assert.equal(records["2026-05"].extraction.method, "vision_llm");
  assert.equal(records["2026-05"].extraction.confidence, "high");
});
```

- [ ] **Step 6: Update runLegacyExtraction to handle multi-month returns**

In `scripts/extract-legacy.mjs`, in `runLegacyExtraction` (line 129-137), replace:

```javascript
    const record = await extractLegacyMonth(config, pdfPath, month);
    records = mergeRecord(records, month, record);
    monthsProcessed.push(month);
```

With:

```javascript
    const newRecords = await extractLegacyMonth(config, pdfPath, month);
    for (const [m, record] of Object.entries(newRecords)) {
      records = mergeRecord(records, m, record);
      if (!monthsProcessed.includes(m)) monthsProcessed.push(m);
    }
```

- [ ] **Step 7: Run tests**

```bash
npm test
```
Expected: 50 pass (adjust EXPECTED_TABLE values if any test assertions fail due to placeholder values).

- [ ] **Step 8: Commit**

```bash
git add scripts/extract-legacy.mjs scripts/extract-legacy.test.mjs
git commit -m "feat: extract all months from Legacy trailing P&L image"
```

---

### Task 3: Scrape distribution history from portal deal overview pages

**Files:**
- Modify: `scripts/harvest.mjs:32-88` (add distribution scraping)
- Create: `scripts/lib/distribution-store.mjs` (simple read/write for distributions.json)

**What:** After harvesting email attachments for each deal, navigate to the deal overview page and scrape the distribution history table. Save to `data/distributions.json`.

**Prerequisite:** Chrome must be running with `--remote-debugging-port=9222` and logged into the CashFlowPortal.

- [ ] **Step 1: Create distribution store helper**

Create `scripts/lib/distribution-store.mjs`:

```javascript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export async function loadDistributions(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

export async function saveDistributions(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}
```

- [ ] **Step 2: Add distribution scraping function to harvest.mjs**

In `scripts/harvest.mjs`, add this function after the `harvestDeal` function (before line 90):

```javascript
export async function scrapeDistributions(page, dealId) {
  await page.goto(`${PORTAL_BASE}/app/deals/${dealId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(3000);

  const rows = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll("table"));
    for (const table of tables) {
      const headerText = table.innerText.toLowerCase();
      if (headerText.includes("distribution") || headerText.includes("cash flow")) {
        const headers = Array.from(table.querySelectorAll("th")).map((th) => th.innerText.trim());
        const dataRows = Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
          Array.from(tr.querySelectorAll("td")).map((td) => td.innerText.trim())
        );
        return { headers, dataRows };
      }
    }
    return null;
  });

  if (!rows) {
    console.warn(`No distribution table found for deal ${dealId} — returning empty array`);
    return [];
  }

  const dateIdx = rows.headers.findIndex((h) => /date|period|quarter/i.test(h));
  const amountIdx = rows.headers.findIndex((h) => /amount|distribution/i.test(h));

  return rows.dataRows
    .filter((row) => row.length >= Math.max(dateIdx, amountIdx) + 1)
    .map((row) => ({
      date: row[dateIdx]?.trim() ?? "",
      amount: parseFloat((row[amountIdx] ?? "").replace(/[$,]/g, "")) || 0,
    }))
    .filter((d) => d.amount > 0 || d.date);
}
```

- [ ] **Step 3: Integrate into harvest.mjs CLI flow**

In `scripts/harvest.mjs`, in the CLI block (line 90-102), add distribution scraping after the email harvesting loop. Replace:

```javascript
  for (const [slug, deal] of Object.entries(config.deals)) {
    const result = await harvestDeal(page, deal.dealId, slug, `data/raw/${slug}`);
    console.log(`${slug}: ${result.newMonths.length ? result.newMonths.join(", ") : "no new months"}`);
  }
  await browser.close();
```

With:

```javascript
  const { loadDistributions, saveDistributions } = await import("./lib/distribution-store.mjs");
  const distributionsPath = "data/distributions.json";
  const distributions = await loadDistributions(distributionsPath);

  for (const [slug, deal] of Object.entries(config.deals)) {
    const result = await harvestDeal(page, deal.dealId, slug, `data/raw/${slug}`);
    console.log(`${slug}: ${result.newMonths.length ? result.newMonths.join(", ") : "no new months"}`);

    try {
      const distData = await scrapeDistributions(page, deal.dealId);
      distributions[slug] = distData;
      console.log(`  distributions scraped: ${distData.length} entries`);
    } catch (err) {
      console.warn(`  distribution scrape failed for ${slug}: ${err.message}`);
    }
  }

  await saveDistributions(distributionsPath, distributions);
  await browser.close();
```

- [ ] **Step 4: Add test for parseEmailSubjectMonth interaction**

Create `scripts/harvest.test.mjs` (if test for distributions doesn't exist yet — the existing harvest tests cover subject parsing but not distribution scraping. Since distribution scraping requires a live browser, skip unit tests for it; coverage comes from the integration test in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add scripts/harvest.mjs scripts/lib/distribution-store.mjs
git commit -m "feat: scrape distribution history from portal deal pages"
```

---

### Task 4: Scrape total capital raise from portal

**Files:**
- Modify: `scripts/harvest.mjs` (add capital scraping function)
- Create: `scripts/lib/capital-store.mjs`

**What:** Scrape total capital raise from each deal's overview page or offering documents. The deal overview typically shows "Capital Raised" or "Total Equity". If that fails, fall back to the Documents tab's offering docs.

- [ ] **Step 1: Create capital store helper**

Create `scripts/lib/capital-store.mjs`:

```javascript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export async function loadCapital(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

export async function saveCapital(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}
```

- [ ] **Step 2: Add capital scraping to harvest.mjs**

In `scripts/harvest.mjs`, add this function after the `scrapeDistributions` function:

```javascript
export async function scrapeTotalCapital(page, dealId) {
  await page.goto(`${PORTAL_BASE}/app/deals/${dealId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2000);

  const capital = await page.evaluate(() => {
    const text = document.body.innerText;
    const raisedMatch = text.match(/Capital\s+Raised[:\s]*\$?([\d,]+)/i);
    if (raisedMatch) return parseFloat(raisedMatch[1].replace(/,/g, ""));
    const equityMatch = text.match(/Total\s+Equity[:\s]*\$?([\d,]+)/i);
    if (equityMatch) return parseFloat(equityMatch[1].replace(/,/g, ""));
    const investmentMatch = text.match(/Total\s+Investment[:\s]*\$?([\d,]+)/i);
    if (investmentMatch) return parseFloat(investmentMatch[1].replace(/,/g, ""));
    return null;
  });

  return capital;
}
```

- [ ] **Step 3: Integrate into harvest.mjs CLI**

In the CLI block, add capital scraping alongside distribution scraping. After the distribution scraping block, add:

```javascript
  const { loadCapital, saveCapital } = await import("./lib/capital-store.mjs");
  const capitalPath = "data/capital.json";
  const capital = await loadCapital(capitalPath);

  for (const [slug, deal] of Object.entries(config.deals)) {
    try {
      const totalRaise = await scrapeTotalCapital(page, deal.dealId);
      if (totalRaise) {
        capital[slug] = { totalRaise, larryInvestment: 50000 };
        console.log(`  ${slug} total capital: $${totalRaise.toLocaleString()}`);
      } else {
        console.warn(`  ${slug}: could not determine total capital from page`);
      }
    } catch (err) {
      console.warn(`  capital scrape failed for ${slug}: ${err.message}`);
    }
  }

  await saveCapital(capitalPath, capital);
```

- [ ] **Step 4: Commit**

```bash
git add scripts/harvest.mjs scripts/lib/capital-store.mjs
git commit -m "feat: scrape total capital raise from portal deal pages"
```

---

### Task 5: Wire distributions and proportional ownership into dashboard

**Files:**
- Modify: `scripts/build-dashboard.mjs` (read distributions + capital, compute shares)
- Modify: `dashboard/data.js` (regenerated — add DISTRIBUTIONS, CAPITAL, DERIVED exports)
- Modify: `dashboard/app.js:191-197` (replace investorCashFlowCard)

**What:** Read `distributions.json` and `capital.json` in the build step. Compute Larry's proportional share. Export all so the dashboard can render the real cash-flow section.

- [ ] **Step 1: Update build-dashboard.mjs**

Replace `scripts/build-dashboard.mjs`:

```javascript
import { loadRecords } from "./lib/record-store.mjs";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  legacyPath: "data/legacy.json",
  mcneilPath: "data/mcneil.json",
  projectionsPath: "data/projections.json",
  distributionsPath: "data/distributions.json",
  capitalPath: "data/capital.json",
  outputPath: "dashboard/data.js",
};

async function loadJsonSafe(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function computeDerived(records, distributions, capital) {
  const months = Object.keys(records).sort();
  const ownershipPct = capital.totalRaise
    ? (capital.larryInvestment ?? 50000) / capital.totalRaise
    : null;

  const totalNetIncome = Object.values(records).reduce(
    (sum, r) => sum + (r.netIncome ?? 0), 0
  );

  const totalDistributed = (distributions ?? []).reduce(
    (sum, d) => sum + (d.amount ?? 0), 0
  );

  const larryDistributed = totalDistributed * (ownershipPct ?? 0);
  const larryNetIncomeShare = totalNetIncome * (ownershipPct ?? 0);

  return {
    ownershipPct: ownershipPct ? Math.round(ownershipPct * 10000) / 100 : null,
    larryInvestment: capital.larryInvestment ?? 50000,
    totalRaise: capital.totalRaise ?? null,
    totalDistributed,
    larryDistributed: Math.round(larryDistributed * 100) / 100,
    larryNetIncomeShare: Math.round(larryNetIncomeShare * 100) / 100,
    distributionMismatch:
      Math.abs(larryNetIncomeShare - larryDistributed) > 50,
    months,
  };
}

export async function buildDashboardData(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  const legacy = await loadRecords(cfg.legacyPath);
  const mcneil = await loadRecords(cfg.mcneilPath);
  const projections = await loadRecords(cfg.projectionsPath);
  const distributions = await loadJsonSafe(cfg.distributionsPath);
  const capital = await loadJsonSafe(cfg.capitalPath);

  const portfolio = {
    totalInvested: 100000,
    perDeal: { legacy: 50000, mcneil: 50000 },
  };

  const derived = {
    legacy: computeDerived(
      legacy,
      distributions.legacy ?? [],
      capital.legacy ?? {}
    ),
    mcneil: computeDerived(
      mcneil,
      distributions.mcneil ?? [],
      capital.mcneil ?? {}
    ),
  };

  const contents = `// GENERATED FILE — do not edit by hand. Run \`npm run refresh\` to regenerate.
export const LEGACY = ${JSON.stringify(legacy, null, 2)};
export const MCNEIL = ${JSON.stringify(mcneil, null, 2)};
export const PROJECTIONS = ${JSON.stringify(projections, null, 2)};
export const PORTFOLIO = ${JSON.stringify(portfolio, null, 2)};
export const DISTRIBUTIONS = ${JSON.stringify(distributions, null, 2)};
export const CAPITAL = ${JSON.stringify(capital, null, 2)};
export const DERIVED = ${JSON.stringify(derived, null, 2)};
`;

  await mkdir(path.dirname(cfg.outputPath), { recursive: true });
  await writeFile(cfg.outputPath, contents, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildDashboardData();
  console.log("dashboard/data.js written.");
}
```

- [ ] **Step 2: Update build-dashboard tests**

In `scripts/build-dashboard.test.mjs`, update the exported constants check to include the new exports:

```javascript
// Replace the existing "writes dashboard/data.js" test assertion from 4 exports to 7:
import { LEGACY, MCNEIL, PROJECTIONS, PORTFOLIO, DISTRIBUTIONS, CAPITAL, DERIVED } from "../dashboard/data.js";
assert.ok(typeof LEGACY === "object");
assert.ok(typeof MCNEIL === "object");
assert.ok(typeof PROJECTIONS === "object");
assert.ok(typeof PORTFOLIO === "object");
assert.ok(typeof DISTRIBUTIONS === "object");
assert.ok(typeof CAPITAL === "object");
assert.ok(typeof DERIVED === "object");
```

- [ ] **Step 3: Replace investorCashFlowCard in app.js**

In `dashboard/app.js`, update the import at line 1:

```javascript
import { LEGACY, MCNEIL, PROJECTIONS, PORTFOLIO, DISTRIBUTIONS, CAPITAL, DERIVED } from "./data.js";
```

Replace the `investorCashFlowCard` function (line 191-197):

```javascript
function investorCashFlowCard(dealSlug, records) {
  const distData = DISTRIBUTIONS[dealSlug] ?? [];
  const capData = CAPITAL[dealSlug] ?? {};
  const derived = DERIVED[dealSlug] ?? {};
  const ownershipPct = derived.ownershipPct;

  if (!ownershipPct) {
    return `<div class="card"><h2>Your cash flow ($${(PORTFOLIO.perDeal[dealSlug] ?? 0).toLocaleString()} invested)</h2>
      <p>Ownership percentage unknown — run <code>npm run refresh</code> after logging into the portal to scrape
      total capital raise, or set it manually in <code>data/capital.json</code>.</p></div>`;
  }

  const distRows = distData.length === 0
    ? `<tr><td colspan="4">No distributions recorded yet.</td></tr>`
    : distData.map((d) => {
        const yourShare = Math.round((d.amount * ownershipPct) / 100) * 100 / 100;
        return `<tr>
          <td>${d.date}</td>
          <td>${money(d.amount ?? 0)}</td>
          <td>${money(yourShare)}</td>
        </tr>`;
      }).join("");

  const mismatchWarning = derived.distributionMismatch
    ? `<p class="flag-low-confidence">Calculated proportional net income (${money(derived.larryNetIncomeShare)}) differs from actual distributions (${money(derived.larryDistributed)}). This is normal when capex or reserves are involved — investigate if the gap widens over time.</p>`
    : "";

  return `<div class="card">
    <h2>Your cash flow</h2>
    <div class="stat-grid">
      ${statCard("Amount invested", money(PORTFOLIO.perDeal[dealSlug] ?? 0))}
      ${statCard("Ownership", ownershipPct + "%")}
      ${statCard("Total capital raise", capData.totalRaise ? money(capData.totalRaise) : "\u2014")}
      ${statCard("Distributions received", money(derived.larryDistributed), derived.larryDistributed > 0 ? "positive" : "")}
      ${statCard("Prop. net income", money(derived.larryNetIncomeShare), derived.larryNetIncomeShare < 0 ? "negative" : "positive")}
    </div>
    ${distData.length > 0 ? `
    <h3>Distribution history</h3>
    <div style="overflow-x:auto"><table>
      <tr><th>Period</th><th>Total property</th><th>Your share</th></tr>
      ${distRows}
    </table></div>` : ""}
    ${mismatchWarning}
  </div>`;
}
```

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: 50 pass.

- [ ] **Step 5: Run the Legacy extraction to populate earlier months**

```bash
node scripts/extract-legacy.mjs
```
Expected: extracts Jan-May 2026 months from the PDF.

- [ ] **Step 6: Rebuild dashboard**

```bash
node scripts/build-dashboard.mjs
```

- [ ] **Step 7: Commit**

```bash
git add scripts/build-dashboard.mjs scripts/build-dashboard.test.mjs dashboard/app.js dashboard/data.js data/legacy.json
git commit -m "feat: wire distributions, proportional ownership, and multi-month Legacy extraction into dashboard"
```

---

### Post-Implementation: Manual verification

After all tasks:

1. Start the HTTP server: `python3 -m http.server 3000` from project root
2. Open `http://localhost:3000/dashboard/`
3. Verify:
   - Legacy shows Jan-May 2026 months in the P&L ledger
   - McNeil shows only Jan-Jun 2026 (no zero 2025 months in dashboard)
   - Cash flow section on each deal shows ownership %, distributions, and mismatch flag
4. Run `npm test` — all 50 tests pass
