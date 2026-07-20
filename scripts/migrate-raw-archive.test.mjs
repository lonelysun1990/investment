// scripts/migrate-raw-archive.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import path from "node:path";
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

test("second migration run over the same source detects duplicates already archived by the first run", async () => {
  const NEW_DIR = "scripts/__fixtures__/tmp-migrated-mcneil-dedup";
  await rm(NEW_DIR, { recursive: true, force: true });

  const firstResults = await runMigration("scripts/__fixtures__/raw-mcneil", NEW_DIR, mcneilConfig);
  assert.ok(firstResults.length > 0);
  assert.ok(firstResults.every((r) => r.written === true));

  const secondResults = await runMigration("scripts/__fixtures__/raw-mcneil", NEW_DIR, mcneilConfig);
  assert.equal(secondResults.length, firstResults.length);
  for (const second of secondResults) {
    const first = firstResults.find((r) => r.oldPath === second.oldPath);
    assert.equal(second.written, false, `expected ${second.oldPath} to be detected as a duplicate on the second run`);
    assert.equal(second.duplicateOf, first.batchKey);
  }

  await rm(NEW_DIR, { recursive: true, force: true });
});

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

test("falls back to harvest-fallback batchDateSource for the xlsx fixture (never contains a Printed date)", async () => {
  const NEW_DIR = "scripts/__fixtures__/tmp-migrated-mcneil-fallback";
  await rm(NEW_DIR, { recursive: true, force: true });

  const results = await runMigration("scripts/__fixtures__/raw-mcneil", NEW_DIR, mcneilConfig);
  const rentrollResult = results.find((r) => r.oldPath.endsWith("rentroll.xlsx"));
  assert.ok(rentrollResult, "expected a result for rentroll.xlsx");

  const manifestPath = path.join(NEW_DIR, rentrollResult.batchKey, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifestEntry = manifest.files.find((f) => f.fileName === `rentroll.${rentrollResult.ext}`);
  assert.ok(manifestEntry, "expected a manifest entry for rentroll.xlsx");
  assert.equal(manifestEntry.batchDateSource, "harvest-fallback");

  await rm(NEW_DIR, { recursive: true, force: true });
});
