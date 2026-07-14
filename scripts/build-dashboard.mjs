import { loadRecords } from "./lib/record-store.mjs";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  legacyPath: "data/legacy.json",
  mcneilPath: "data/mcneil.json",
  projectionsPath: "data/projections.json",
  outputPath: "dashboard/data.js",
};

export async function buildDashboardData(opts = {}) {
  const { legacyPath, mcneilPath, projectionsPath, outputPath } = { ...DEFAULTS, ...opts };

  const legacy = await loadRecords(legacyPath);
  const mcneil = await loadRecords(mcneilPath);
  const projections = await loadRecords(projectionsPath);

  const portfolio = {
    totalInvested: 100000,
    perDeal: { legacy: 50000, mcneil: 50000 },
  };

  const contents = `// GENERATED FILE — do not edit by hand. Run \`npm run refresh\` to regenerate.
export const LEGACY = ${JSON.stringify(legacy, null, 2)};
export const MCNEIL = ${JSON.stringify(mcneil, null, 2)};
export const PROJECTIONS = ${JSON.stringify(projections, null, 2)};
export const PORTFOLIO = ${JSON.stringify(portfolio, null, 2)};
`;

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, contents, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildDashboardData();
  console.log("dashboard/data.js written.");
}
