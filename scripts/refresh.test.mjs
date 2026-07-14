import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRefreshSummary } from "./refresh.mjs";

test("formats a summary line when new months were found", () => {
  const summary = formatRefreshSummary({
    legacy: { monthsProcessed: ["2026-06"] },
    mcneil: { monthsProcessed: ["2026-06"] },
  });
  assert.match(summary, /legacy: 2026-06/);
  assert.match(summary, /mcneil: 2026-06/);
});

test("formats a summary line when nothing new was found", () => {
  const summary = formatRefreshSummary({
    legacy: { monthsProcessed: [] },
    mcneil: { monthsProcessed: [] },
  });
  assert.match(summary, /legacy: \(none\)/);
});
