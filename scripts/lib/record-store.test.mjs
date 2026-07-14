import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRecords, saveRecords, mergeRecord } from "./record-store.mjs";

test("loadRecords returns empty object when file does not exist", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "record-store-test-"));
  const result = await loadRecords(path.join(dir, "nonexistent.json"));
  assert.deepEqual(result, {});
  await rm(dir, { recursive: true });
});

test("saveRecords then loadRecords round-trips data", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "record-store-test-"));
  const file = path.join(dir, "data.json");
  await saveRecords(file, { "2026-05": { noi: 2527.04 } });
  const loaded = await loadRecords(file);
  assert.deepEqual(loaded, { "2026-05": { noi: 2527.04 } });
  await rm(dir, { recursive: true });
});

test("mergeRecord overwrites an existing month, leaves others untouched", () => {
  const before = { "2026-04": { noi: 8721.76 }, "2026-05": { noi: 1 } };
  const after = mergeRecord(before, "2026-05", { noi: 2527.04 });
  assert.deepEqual(after, {
    "2026-04": { noi: 8721.76 },
    "2026-05": { noi: 2527.04 },
  });
});

test("mergeRecord does not mutate the input object", () => {
  const before = { "2026-04": { noi: 8721.76 } };
  mergeRecord(before, "2026-05", { noi: 2527.04 });
  assert.deepEqual(before, { "2026-04": { noi: 8721.76 } });
});

test("saveRecords writes keys sorted ascending", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "record-store-test-"));
  const file = path.join(dir, "data.json");
  await saveRecords(file, { "2026-05": {}, "2026-01": {}, "2025-11": {} });
  const raw = await (await import("node:fs/promises")).readFile(file, "utf8");
  const keys = Object.keys(JSON.parse(raw));
  assert.deepEqual(keys, ["2025-11", "2026-01", "2026-05"]);
  await rm(dir, { recursive: true });
});
