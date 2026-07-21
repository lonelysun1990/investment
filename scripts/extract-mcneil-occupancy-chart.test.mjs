import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTrailingMonths, extractOccupancyChart } from "./extract-mcneil-occupancy-chart.mjs";

const CHART_FIXTURE = "scripts/__fixtures__/mcneil-emails/2026-06-occupancy-chart.png";

test("resolveTrailingMonths resolves the real 12-label trailing window ending at the anchor month", () => {
  const labels = ["Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun"];
  const result = resolveTrailingMonths(labels, "2026-06");
  assert.deepEqual(result, [
    "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12",
    "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
  ]);
});

test("resolveTrailingMonths handles a window that crosses a year rollover mid-window", () => {
  const result = resolveTrailingMonths(["Nov", "Dec", "Jan"], "2026-01");
  assert.deepEqual(result, ["2025-11", "2025-12", "2026-01"]);
});

test("resolveTrailingMonths throws when labels are not a consecutive trailing run ending at the anchor month", () => {
  assert.throws(() => resolveTrailingMonths(["Jul", "Aug", "Jun"], "2026-06"));
});

test("resolveTrailingMonths throws on an unrecognized month abbreviation", () => {
  assert.throws(() => resolveTrailingMonths(["Xyz"], "2026-06"));
});

test("extractOccupancyChart returns null with no config, never throws", async () => {
  const result = await extractOccupancyChart(null, CHART_FIXTURE, "2026-06");
  assert.equal(result, null);
});

test("extractOccupancyChart parses the vision LLM's month/occupancy pairs and resolves them to YYYY-MM keys", async () => {
  const fakeConfig = { baseUrl: "https://example.test/v1", apiKey: "x", model: "gpt-4o" };
  const fakeResponse = JSON.stringify({
    months: [
      { label: "Jun", occupancyPct: 97 },
      { label: "Jul", occupancyPct: 93 },
      { label: "Aug", occupancyPct: 88 },
    ],
  });
  const fakeCallVisionLlm = async () => fakeResponse;
  const result = await extractOccupancyChart(fakeConfig, CHART_FIXTURE, "2025-08", {
    callVisionLlmImpl: fakeCallVisionLlm,
  });
  assert.deepEqual(result, { "2025-06": 97, "2025-07": 93, "2025-08": 88 });
});

test("extractOccupancyChart strips a markdown code fence from the vision LLM response before parsing", async () => {
  const fakeConfig = { baseUrl: "https://example.test/v1", apiKey: "x", model: "gpt-4o" };
  const fakeResponse = "```json\n" + JSON.stringify({ months: [{ label: "Jun", occupancyPct: 88 }] }) + "\n```";
  const fakeCallVisionLlm = async () => fakeResponse;
  const result = await extractOccupancyChart(fakeConfig, CHART_FIXTURE, "2026-06", {
    callVisionLlmImpl: fakeCallVisionLlm,
  });
  assert.deepEqual(result, { "2026-06": 88 });
});
