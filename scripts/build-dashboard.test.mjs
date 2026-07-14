import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDashboardData } from "./build-dashboard.mjs";

test("writes dashboard/data.js as valid, importable JS with the four expected exports", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "build-dashboard-test-"));
  const legacyPath = path.join(dir, "legacy.json");
  const mcneilPath = path.join(dir, "mcneil.json");
  const projectionsPath = path.join(dir, "projections.json");
  const outputPath = path.join(dir, "data.js");

  await writeFile(legacyPath, JSON.stringify({ "2026-05": { noi: 2527.04 } }));
  await writeFile(mcneilPath, JSON.stringify({ "2026-06": { noi: 13812.52 } }));
  await writeFile(projectionsPath, JSON.stringify({ legacy: { stabilizedOccupancyPct: 93 } }));

  await buildDashboardData({ legacyPath, mcneilPath, projectionsPath, outputPath });

  const imported = await import(`file://${outputPath}`);
  assert.equal(imported.LEGACY["2026-05"].noi, 2527.04);
  assert.equal(imported.MCNEIL["2026-06"].noi, 13812.52);
  assert.equal(imported.PROJECTIONS.legacy.stabilizedOccupancyPct, 93);
  assert.equal(imported.PORTFOLIO.totalInvested, 100000);

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
