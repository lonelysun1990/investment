import { chromium } from "playwright";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveArchiveRoot, loadManifest } from "./lib/archive-store.mjs";
import { parseEmailSubjectMonth, captureOccupancyDocs } from "./harvest.mjs";

const PORTAL_BASE = "https://whitepagodagroup.cashflowportal.com";

export async function backfillMcneilOccupancy(page, dealId, rawDir) {
  const batchNames = (await readdir(rawDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  await page.goto(`${PORTAL_BASE}/app/documents/${dealId}?tab=emails`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForSelector("tbody tr", { timeout: 20000, state: "attached" });
  await page.waitForTimeout(3000);

  const rows = await page.$$eval("tbody tr", (trs) => trs.map((tr) => tr.innerText));

  const backfilled = [];
  for (let i = 0; i < rows.length; i++) {
    const subject = rows[i];
    const month = parseEmailSubjectMonth(subject);
    if (!month || !batchNames.includes(month)) continue;

    const manifest = await loadManifest(path.join(rawDir, month));
    if (manifest.files.some((f) => f.docType === "occupancy-narrative")) continue;

    const row = page.locator("tbody tr").nth(i);
    await row.locator("button").last().click();
    await page.waitForTimeout(3000);

    try {
      await captureOccupancyDocs(page, rawDir, month, subject);
      backfilled.push(month);
    } catch (err) {
      console.warn(`backfillMcneilOccupancy: occupancy capture failed for ${month}: ${err.message}`);
    }

    const doneButton = page.locator("text=Done").first();
    if (await doneButton.isVisible().catch(() => false)) await doneButton.click();
    await page.waitForTimeout(500);
  }

  return { backfilled };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("cashflowportal")) ?? ctx.pages()[0];

  const config = JSON.parse(await readFile("config.json", "utf8"));

  const result = await backfillMcneilOccupancy(page, config.deals.mcneil.dealId, path.join(resolveArchiveRoot(), "mcneil"));
  console.log(`Backfilled: ${result.backfilled.length ? result.backfilled.join(", ") : "(none)"}`);
  await browser.close();
}
