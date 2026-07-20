import { test } from "node:test";
import assert from "node:assert/strict";
import { quarterFromMonth, aggregateDistributionByQuarter } from "./quarter.mjs";

test("quarterFromMonth maps a month to its calendar quarter", () => {
  assert.equal(quarterFromMonth("2026-01"), "2026-Q1");
  assert.equal(quarterFromMonth("2026-03"), "2026-Q1");
  assert.equal(quarterFromMonth("2026-04"), "2026-Q2");
  assert.equal(quarterFromMonth("2025-09"), "2025-Q3");
  assert.equal(quarterFromMonth("2025-12"), "2025-Q4");
});

test("aggregateDistributionByQuarter sums per-month distributions within a quarter", () => {
  const result = aggregateDistributionByQuarter({
    "2026-01": { distribution: 100 },
    "2026-02": { distribution: 0 },
    "2026-03": { distribution: 50 },
  });
  assert.equal(result.get("2026-Q1"), 150);
});

test("aggregateDistributionByQuarter keeps distinct quarters separate", () => {
  const result = aggregateDistributionByQuarter({
    "2026-01": { distribution: 118999.45 },
    "2026-02": { distribution: 0 },
    "2026-03": { distribution: 0 },
    "2026-04": { distribution: 24999.86 },
    "2026-05": { distribution: 0 },
    "2026-06": { distribution: 0 },
  });
  assert.equal(result.get("2026-Q1"), 118999.45);
  assert.equal(result.get("2026-Q2"), 24999.86);
});

test("aggregateDistributionByQuarter rounds to cents to avoid float drift", () => {
  const result = aggregateDistributionByQuarter({
    "2026-01": { distribution: 0.1 },
    "2026-02": { distribution: 0.2 },
  });
  assert.equal(result.get("2026-Q1"), 0.3);
});

test("aggregateDistributionByQuarter skips records missing the distribution field entirely", () => {
  const result = aggregateDistributionByQuarter({
    "2026-01": { noi: 5000 },
    "2026-02": { distribution: null },
    "2026-03": { distribution: 50 },
  });
  // Only 2026-03 contributes; no phantom quarter is fabricated for the
  // months that carry no explicit distribution value.
  assert.equal(result.has("2026-Q1"), true);
  assert.equal(result.get("2026-Q1"), 50);
  assert.equal(result.size, 1);
});

test("aggregateDistributionByQuarter yields an empty map when nothing has a distribution", () => {
  const result = aggregateDistributionByQuarter({
    "2026-01": { noi: 1 },
    "2026-02": {},
  });
  assert.equal(result.size, 0);
});
