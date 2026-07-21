import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeOccupancySources } from "./merge-occupancy.mjs";

test("takes the highest-priority source's value when only one source has a month", () => {
  const result = mergeOccupancySources(
    [new Map([["2024-10", 87.5]]), new Map(), new Map()],
    ["direct statement", "vacant-unit narrative", "chart"]
  );
  assert.deepEqual([...result], [["2024-10", 87.5]]);
});

test("prefers the highest-priority source's value even when a lower-priority source disagrees", () => {
  const result = mergeOccupancySources(
    [new Map([["2026-06", 90.6]]), new Map(), new Map([["2026-06", 84.0]])],
    ["direct statement", "vacant-unit narrative", "chart"]
  );
  assert.equal(result.get("2026-06"), 90.6);
});

test("logs a warning when a lower-priority source disagrees by more than 1 percentage point", () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    mergeOccupancySources(
      [new Map([["2026-06", 90.6]]), new Map(), new Map([["2026-06", 84.0]])],
      ["direct statement", "vacant-unit narrative", "chart"]
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2026-06/);
  assert.match(warnings[0], /90\.6/);
  assert.match(warnings[0], /84/);
});

test("does not warn when sources disagree by 1 percentage point or less", () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    mergeOccupancySources(
      [new Map([["2026-06", 90.6]]), new Map(), new Map([["2026-06", 89.7]])],
      ["direct statement", "vacant-unit narrative", "chart"]
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 0);
});

test("returns an empty map when no source has any data", () => {
  const result = mergeOccupancySources([new Map(), new Map(), new Map()], ["a", "b", "c"]);
  assert.equal(result.size, 0);
});

test("merges months from different sources into the union of all covered months", () => {
  const result = mergeOccupancySources(
    [new Map([["2024-10", 87.5], ["2024-09", 90.6]]), new Map(), new Map([["2024-11", 88.0]])],
    ["direct statement", "vacant-unit narrative", "chart"]
  );
  assert.deepEqual(
    [...result.entries()].sort(),
    [["2024-09", 90.6], ["2024-10", 87.5], ["2024-11", 88.0]]
  );
});
