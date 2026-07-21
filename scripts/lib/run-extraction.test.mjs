import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
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

test("stamps a mismatched month with reconciled:false and logs a warning, but still saves every other month", async () => {
  const rawDir = "scripts/__fixtures__/tmp-run-extraction-reconcile-raw";
  const outputPath = "scripts/__fixtures__/tmp-run-extraction-reconcile-output.json";
  await rm(rawDir, { recursive: true, force: true });
  await rm(outputPath, { force: true });
  await mkdir(`${rawDir}/2026-01`, { recursive: true });
  await mkdir(`${rawDir}/2026-02`, { recursive: true });
  await saveManifest(`${rawDir}/2026-01`, { files: [] });
  await saveManifest(`${rawDir}/2026-02`, { files: [] });

  const fakeExtractBatch = async (batchDir) => {
    const month = path.basename(batchDir);
    if (month === "2026-01") {
      return new Map([[month, {
        month,
        income: { rental: 1000, other: 0, total: 1000 },
        expense: { total: 500 },
        noi: 999999, // deliberately wrong
        nonOperatingExpense: { debtService: 0, otherNonOperating: 0, capitalImprovements: 0, total: 0 },
        netIncome: 999999,
      }]]);
    }
    return new Map([[month, {
      month,
      income: { rental: 1000, other: 0, total: 1000 },
      expense: { total: 500 },
      noi: 500,
      nonOperatingExpense: { debtService: 0, otherNonOperating: 0, capitalImprovements: 0, total: 0 },
      netIncome: 500,
    }]]);
  };

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    await runGenericExtraction(rawDir, outputPath, fakeExtractBatch);
  } finally {
    console.warn = originalWarn;
  }

  const written = JSON.parse(await readFile(outputPath, "utf8"));
  const mismatchedMonth = Object.keys(written).find((m) => written[m].reconciled === false);
  assert.ok(mismatchedMonth, "expected exactly one month flagged reconciled:false");
  assert.ok(warnings.some((w) => w.includes(mismatchedMonth)), "expected a console.warn naming the mismatched month");

  const cleanMonths = Object.keys(written).filter((m) => m !== mismatchedMonth);
  assert.ok(cleanMonths.length > 0, "other months must still be saved");
  for (const m of cleanMonths) {
    assert.equal("reconciled" in written[m], false, "clean months should not gain a reconciled field");
  }

  await rm(rawDir, { recursive: true, force: true });
  await rm(outputPath, { force: true });
});
