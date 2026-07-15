import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDashboardData } from "./build-dashboard.mjs";

test("writes dashboard/data.js as valid, importable JS with the seven expected exports", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "build-dashboard-test-"));
  const legacyPath = path.join(dir, "legacy.json");
  const mcneilPath = path.join(dir, "mcneil.json");
  const projectionsPath = path.join(dir, "projections.json");
  const distributionsPath = path.join(dir, "distributions.json");
  const capitalPath = path.join(dir, "capital.json");
  const outputPath = path.join(dir, "data.js");

  await writeFile(legacyPath, JSON.stringify({ "2026-05": { noi: 2527.04 } }));
  await writeFile(mcneilPath, JSON.stringify({ "2026-06": { noi: 13812.52 } }));
  await writeFile(projectionsPath, JSON.stringify({ legacy: { stabilizedOccupancyPct: 93 } }));
  await writeFile(distributionsPath, JSON.stringify({}));
  await writeFile(capitalPath, JSON.stringify({}));

  await buildDashboardData({ legacyPath, mcneilPath, projectionsPath, distributionsPath, capitalPath, outputPath });

  const imported = await import(`file://${outputPath}`);
  assert.equal(imported.LEGACY["2026-05"].noi, 2527.04);
  assert.equal(imported.MCNEIL["2026-06"].noi, 13812.52);
  assert.equal(imported.PROJECTIONS.legacy.stabilizedOccupancyPct, 93);
  assert.equal(imported.PORTFOLIO.totalInvested, 100000);
  assert.ok(typeof imported.DISTRIBUTIONS === "object");
  assert.ok(typeof imported.CAPITAL === "object");
  assert.ok(typeof imported.DERIVED === "object");
  assert.equal(imported.DERIVED.legacy.ownershipPct, null);
  assert.deepEqual(imported.DERIVED.legacy.months, ["2026-05"]);

  await rm(dir, { recursive: true });
});

test("handles missing distributions.json and capital.json gracefully (empty objects, no crash)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "build-dashboard-test-"));
  const legacyPath = path.join(dir, "legacy.json");
  const mcneilPath = path.join(dir, "mcneil.json");
  const outputPath = path.join(dir, "data.js");
  await writeFile(legacyPath, "{}");
  await writeFile(mcneilPath, "{}");

  await buildDashboardData({
    legacyPath,
    mcneilPath,
    projectionsPath: path.join(dir, "does-not-exist.json"),
    distributionsPath: path.join(dir, "does-not-exist.json"),
    capitalPath: path.join(dir, "does-not-exist.json"),
    outputPath,
  });

  const imported = await import(`file://${outputPath}`);
  assert.deepEqual(imported.DISTRIBUTIONS, {});
  assert.deepEqual(imported.CAPITAL, {});
  assert.equal(imported.DERIVED.legacy.ownershipPct, null);
  await rm(dir, { recursive: true });
});

test("handles a missing projections.json gracefully (empty object, no crash)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "build-dashboard-test-"));
  const legacyPath = path.join(dir, "legacy.json");
  const mcneilPath = path.join(dir, "mcneil.json");
  const outputPath = path.join(dir, "data.js");
  await writeFile(legacyPath, "{}");
  await writeFile(mcneilPath, "{}");

  await buildDashboardData({
    legacyPath,
    mcneilPath,
    projectionsPath: path.join(dir, "does-not-exist.json"),
    outputPath,
  });

  const imported = await import(`file://${outputPath}`);
  assert.deepEqual(imported.PROJECTIONS, {});
  await rm(dir, { recursive: true });
});

test("computeDerived calculates ownershipPct and larry share when capital data is present", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "build-dashboard-test-"));
  const legacyPath = path.join(dir, "legacy.json");
  const mcneilPath = path.join(dir, "mcneil.json");
  const distributionsPath = path.join(dir, "distributions.json");
  const capitalPath = path.join(dir, "capital.json");
  const outputPath = path.join(dir, "data.js");

  await writeFile(legacyPath, JSON.stringify({ "2026-05": { netIncome: -9347.72 } }));
  await writeFile(mcneilPath, JSON.stringify({}));
  await writeFile(distributionsPath, JSON.stringify({
    legacy: [{ date: "2026-06", amount: 1000 }],
  }));
  await writeFile(capitalPath, JSON.stringify({
    legacy: { larryInvestment: 50000, totalRaise: 200000 },
  }));

  await buildDashboardData({
    legacyPath, mcneilPath,
    projectionsPath: path.join(dir, "does-not-exist.json"),
    distributionsPath, capitalPath, outputPath,
  });

  const imported = await import(`file://${outputPath}`);
  assert.equal(imported.DERIVED.legacy.ownershipPct, 25);
  assert.equal(imported.DERIVED.legacy.larryInvestment, 50000);
  assert.equal(imported.DERIVED.legacy.totalRaise, 200000);
  assert.equal(imported.DERIVED.legacy.totalDistributed, 1000);
  assert.equal(imported.DERIVED.legacy.larryDistributed, 250);
  assert.equal(imported.DERIVED.legacy.larryNetIncomeShare, -2336.93);
  assert.equal(imported.DERIVED.legacy.distributionMismatch, true);

  await rm(dir, { recursive: true });
});
