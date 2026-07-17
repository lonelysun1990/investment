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
