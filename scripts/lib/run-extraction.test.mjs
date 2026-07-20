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
