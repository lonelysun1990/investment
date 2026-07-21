import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadManifest } from "./archive-store.mjs";
import { foldMonths } from "./merge-months.mjs";
import { saveRecords } from "./record-store.mjs";
import { reconcilePnlRecord } from "./reconcile-pnl.mjs";

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
  for (const [month, record] of merged) {
    const { reconciled, notes } = reconcilePnlRecord(record);
    if (reconciled) {
      records[month] = record;
    } else {
      for (const note of notes) console.warn(`${month}: ${note}`);
      records[month] = { ...record, reconciled: false };
    }
  }
  await saveRecords(outputPath, records);

  return { monthsProcessed: [...merged.keys()].sort(), batchesProcessed: batchNames };
}
