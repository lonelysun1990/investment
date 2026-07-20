import { loadRecords } from "./lib/record-store.mjs";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  legacyPath: "data/legacy.json",
  mcneilPath: "data/mcneil.json",
  projectionsPath: "data/projections.json",
  distributionsPath: "data/distributions.json",
  capitalPath: "data/capital.json",
  outputPath: "dashboard/data.js",
};

async function loadJsonSafe(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function computeDerived(records, distributions, capital) {
  const months = Object.keys(records).sort();
  const ownershipPct = capital.totalRaise
    ? (capital.larryInvestment ?? 50000) / capital.totalRaise
    : null;

  const totalNetIncome = Object.values(records).reduce(
    (sum, r) => sum + (r.netIncome ?? 0), 0
  );

  const larrySumDistributed = (distributions ?? []).reduce(
    (sum, d) => sum + (d.myDistribution ?? 0), 0
  );

  const knownTotalDistributions = (distributions ?? []).filter(
    (d) => d.totalDistribution != null
  );
  const totalPropertyDistributed = knownTotalDistributions.length > 0
    ? Math.round(
        knownTotalDistributions.reduce((sum, d) => sum + d.totalDistribution, 0) * 100
      ) / 100
    : null;

  const larryDistributed = larrySumDistributed;
  const larryNetIncomeShare = totalNetIncome * (ownershipPct ?? 0);

  return {
    ownershipPct: ownershipPct ? Math.round(ownershipPct * 10000) / 100 : null,
    larryInvestment: capital.larryInvestment ?? 50000,
    totalRaise: capital.totalRaise ?? null,
    totalPropertyDistributed,
    larryDistributed: Math.round(larryDistributed * 100) / 100,
    larryNetIncomeShare: Math.round(larryNetIncomeShare * 100) / 100,
    distributionMismatch:
      Math.abs(larryNetIncomeShare - larryDistributed) > 50,
    months,
  };
}

export async function buildDashboardData(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  const legacy = await loadRecords(cfg.legacyPath);
  const mcneil = await loadRecords(cfg.mcneilPath);
  const projections = await loadRecords(cfg.projectionsPath);
  const distributions = await loadJsonSafe(cfg.distributionsPath);
  const capital = await loadJsonSafe(cfg.capitalPath);

  const portfolio = {
    totalInvested: 100000,
    perDeal: { legacy: 50000, mcneil: 50000 },
  };

  const derived = {
    legacy: computeDerived(
      legacy,
      distributions.legacy ?? [],
      capital.legacy ?? {}
    ),
    mcneil: computeDerived(
      mcneil,
      distributions.mcneil ?? [],
      capital.mcneil ?? {}
    ),
  };

  const contents = `// GENERATED FILE — do not edit by hand. Run \`npm run refresh\` to regenerate.
export const LEGACY = ${JSON.stringify(legacy, null, 2)};
export const MCNEIL = ${JSON.stringify(mcneil, null, 2)};
export const PROJECTIONS = ${JSON.stringify(projections, null, 2)};
export const PORTFOLIO = ${JSON.stringify(portfolio, null, 2)};
export const DISTRIBUTIONS = ${JSON.stringify(distributions, null, 2)};
export const CAPITAL = ${JSON.stringify(capital, null, 2)};
export const DERIVED = ${JSON.stringify(derived, null, 2)};
`;

  await mkdir(path.dirname(cfg.outputPath), { recursive: true });
  await writeFile(cfg.outputPath, contents, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildDashboardData();
  console.log("dashboard/data.js written.");
}
