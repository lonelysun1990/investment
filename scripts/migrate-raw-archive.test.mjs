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
