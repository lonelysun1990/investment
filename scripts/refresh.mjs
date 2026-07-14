import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { harvestDeal } from "./harvest.mjs";
import { runLegacyExtraction } from "./extract-legacy.mjs";
import { runMcneilExtraction } from "./extract-mcneil.mjs";
import { buildDashboardData } from "./build-dashboard.mjs";

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
    await harvestDeal(page, deal.dealId, slug, `data/raw/${slug}`);
  }
  await browser.close();

  const legacyResult = await runLegacyExtraction(config.vision_llm ?? null, "data/raw/legacy", "data/legacy.json");
  const mcneilResult = await runMcneilExtraction("data/raw/mcneil", "data/mcneil.json");

  console.log(formatRefreshSummary({ legacy: legacyResult, mcneil: mcneilResult }));

  await buildDashboardData();
  console.log("Dashboard data rebuilt: dashboard/data.js");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
