import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeDistributions } from "./merge-distributions.mjs";

test("populates both fields when a fresh DOM entry has real aggregated total data", () => {
  const result = mergeDistributions(
    [],
    [{ date: "2026-Q1", amount: 648.14 }],
    new Map([["2026-Q1", 118999.45]])
  );
  assert.deepEqual(result, [
    { date: "2026-Q1", myDistribution: 648.14, totalDistribution: 118999.45 },
  ]);
});

test("preserves an existing non-null totalDistribution when no aggregated data exists for that quarter", () => {
  const result = mergeDistributions(
    [{ date: "2025-Q2", myDistribution: 600, totalDistribution: 90000 }],
    [{ date: "2025-Q2", amount: 648.14 }],
    new Map() // nothing aggregated for this quarter
  );
  assert.deepEqual(result, [
    { date: "2025-Q2", myDistribution: 648.14, totalDistribution: 90000 },
  ]);
});

test("preserves an existing null totalDistribution rather than resetting it, when no aggregated data exists", () => {
  const result = mergeDistributions(
    [{ date: "2025-Q3", myDistribution: 699.99, totalDistribution: null }],
    [{ date: "2025-Q3", amount: 699.99 }],
    new Map()
  );
  assert.deepEqual(result, [
    { date: "2025-Q3", myDistribution: 699.99, totalDistribution: null },
  ]);
});

test("a confirmed aggregated 0 overwrites a stale non-null total (null-vs-zero distinction)", () => {
  const result = mergeDistributions(
    [{ date: "2024-Q4", myDistribution: 518.51, totalDistribution: 12345 }],
    [{ date: "2024-Q4", amount: 518.51 }],
    new Map([["2024-Q4", 0]]) // a genuine, confirmed zero should win
  );
  assert.deepEqual(result, [
    { date: "2024-Q4", myDistribution: 518.51, totalDistribution: 0 },
  ]);
});

test("merges new DOM quarters alongside existing ones and sorts by date", () => {
  const result = mergeDistributions(
    [{ date: "2026-Q2", myDistribution: 648.14, totalDistribution: 24999.86 }],
    [
      { date: "2025-Q4", amount: 648.14 },
      { date: "2026-Q1", amount: 648.14 },
    ],
    new Map([["2026-Q1", 118999.45]])
  );
  assert.deepEqual(result, [
    { date: "2025-Q4", myDistribution: 648.14, totalDistribution: null },
    { date: "2026-Q1", myDistribution: 648.14, totalDistribution: 118999.45 },
    { date: "2026-Q2", myDistribution: 648.14, totalDistribution: 24999.86 },
  ]);
});
