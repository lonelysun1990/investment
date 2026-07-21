import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import path from "node:path";
import { harvestDeal, scrapeDistributions, scrapeOwnershipPct } from "./harvest.mjs";
import { runLegacyExtraction } from "./extract-legacy.mjs";
import { runMcneilExtraction } from "./extract-mcneil.mjs";
import { buildDashboardData } from "./build-dashboard.mjs";
import { loadRecords } from "./lib/record-store.mjs";
import { aggregateDistributionByQuarter } from "./lib/quarter.mjs";
import { mergeDistributions } from "./lib/merge-distributions.mjs";
import { resolveArchiveRoot } from "./lib/archive-store.mjs";

export function formatRefreshSummary(results) {
  const lines = [];
  for (const [deal, result] of Object.entries(results)) {
    const months = result.monthsProcessed.length ? result.monthsProcessed.join(", ") : "(none)";
    lines.push(`${deal}: ${months}`);
  }
  return lines.join("\n");
}

async function main() {
  const config = JSON.parse(await readFile("config.json", "utf8"));

  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("cashflowportal")) ?? ctx.pages()[0];

  for (const [slug, deal] of Object.entries(config.deals)) {
    const dealConfig = await import(`./deals/${slug}.config.mjs`);
    await harvestDeal(page, deal.dealId, slug, path.join(resolveArchiveRoot(), slug), dealConfig);
  }

  const legacyResult = await runLegacyExtraction(config.vision_llm ?? null, path.join(resolveArchiveRoot(), "legacy"), "data/legacy.json");
  const mcneilResult = await runMcneilExtraction(config.vision_llm ?? null, path.join(resolveArchiveRoot(), "mcneil"), "data/mcneil.json");

  console.log(formatRefreshSummary({ legacy: legacyResult, mcneil: mcneilResult }));

  // Refresh distributions (my share via DOM, total via the deterministic
  // per-month `distribution` field already extracted into legacy.json/
  // mcneil.json) and an ownership cross-check -- all DOM-only, per
  // CLAUDE.md. Total capital raise is captured once, manually, from each
  // deal's offering document (see README) -- it's static and isn't
  // re-scraped on every refresh.
  const distributions = JSON.parse(await readFile("data/distributions.json", "utf8").catch(() => "{}"));
  const capital = JSON.parse(await readFile("data/capital.json", "utf8").catch(() => "{}"));
  const recordsBySlug = {
    legacy: await loadRecords("data/legacy.json"),
    mcneil: await loadRecords("data/mcneil.json"),
  };

  for (const [slug, deal] of Object.entries(config.deals)) {
    const domDistributions = await scrapeDistributions(page, deal.dealId);
    const totalByQuarter = aggregateDistributionByQuarter(recordsBySlug[slug] ?? {});
    distributions[slug] = mergeDistributions(distributions[slug] ?? [], domDistributions, totalByQuarter);

    const ownershipPctCheck = await scrapeOwnershipPct(page, deal.dealId);
    capital[slug] = { ...(capital[slug] ?? {}), ownershipPctCheck };
  }

  await writeFile("data/distributions.json", JSON.stringify(distributions, null, 2) + "\n", "utf8");
  await writeFile("data/capital.json", JSON.stringify(capital, null, 2) + "\n", "utf8");

  await browser.close();

  await buildDashboardData();
  console.log("Dashboard data rebuilt: dashboard/data.js");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
