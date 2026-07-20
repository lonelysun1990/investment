import { loadRecords, saveRecords } from "./lib/record-store.mjs";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const MONTH_NAMES = {
  jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
  apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07", july: "07",
  aug: "08", august: "08", sep: "09", september: "09", oct: "10", october: "10",
  nov: "11", november: "11", dec: "12", december: "12",
};

export function parseDistributionText(text) {
  const rows = [];
  const lineRegex = /(Q[1-4][\s-]*\d{4}|\d{4}[\s-]*Q[1-4])\D{0,10}\$?([\d,]+\.\d{2})/g;
  let match;
  while ((match = lineRegex.exec(text))) {
    const period = match[1].replace(/\s+/g, " ").trim();
    const parts = period.match(/Q([1-4])[\s-]*(\d{4})|(\d{4})[\s-]*Q([1-4])/);
    const quarter = parts[1] ?? parts[4];
    const year = parts[2] ?? parts[3];
    rows.push({ date: `${year}-Q${quarter}`, amount: parseFloat(match[2].replace(/,/g, "")) });
  }
  return rows;
}

export function parseOwnershipPct(text) {
  const match = text.match(/([\d.]+)\s*%\s*(?:ownership|equity|of the deal)/i);
  return match ? parseFloat(match[1]) : null;
}

export function parseEmailSubjectMonth(subject) {
  const match = subject.match(/([A-Za-z]+)\s+(\d{4})/);
  if (!match) return null;
  const monthKey = MONTH_NAMES[match[1].toLowerCase()];
  if (!monthKey) return null;
  if (/K-1|Closing Update/i.test(subject)) return null;
  return `${match[2]}-${monthKey}`;
}

export async function loadSeenManifest(path) {
  return loadRecords(path);
}

export async function saveSeenManifest(path, seen) {
  return saveRecords(path, seen);
}

const PORTAL_BASE = "https://whitepagodagroup.cashflowportal.com";

export async function harvestDeal(page, dealId, dealSlug, rawDir) {
  const seenPath = path.join(rawDir, "_seen.json");
  const seen = await loadSeenManifest(seenPath);

  await page.goto(`${PORTAL_BASE}/app/documents/${dealId}?tab=emails`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForSelector("tbody tr", { timeout: 20000 });

  const rows = await page.$$eval("tbody tr", (trs) =>
    trs.map((tr) => tr.innerText.split("\n")[0] + "|||" + tr.innerText)
  );

  const newMonths = [];
  for (const rowText of rows) {
    const subject = rowText.split("|||")[1] ?? "";
    const month = parseEmailSubjectMonth(subject);
    if (!month || seen[month]) continue;

    const row = page.locator("tbody tr", { hasText: subject.split("\n")[0] }).first();
    await row.locator("button").last().click();
    await page.waitForTimeout(3000);

    const attachmentLinks = await page.evaluate(() => {
      const overlays = Array.from(document.querySelectorAll("div,section,aside")).filter((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return (s.position === "fixed" || s.position === "absolute") && r.width > 350 && r.height > 250;
      });
      const scope = overlays.sort((a, b) => a.innerText.length - b.innerText.length)[0];
      if (!scope) return [];
      return Array.from(scope.querySelectorAll("a"))
        .map((a) => ({ name: a.innerText.trim(), href: a.href }))
        .filter((a) => a.href && /\.(pdf|xlsx)(\?|$)/i.test(a.href));
    });

    const monthDir = path.join(rawDir, month);
    await mkdir(monthDir, { recursive: true });
    for (const { name, href } of attachmentLinks) {
      const safeName = name.replace(/[^a-zA-Z0-9.\- ]/g, "_");
      const link = page.locator(`a[href="${href}"]`).first();
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        link.click(),
      ]);
      await download.saveAs(path.join(monthDir, safeName));
    }

    seen[month] = { harvestedAt: new Date().toISOString(), files: attachmentLinks.map((a) => a.name) };
    newMonths.push(month);

    const doneButton = page.locator("text=Done").first();
    if (await doneButton.isVisible().catch(() => false)) await doneButton.click();
    await page.waitForTimeout(500);
  }

  await saveSeenManifest(seenPath, seen);
  return { newMonths };
}

export async function scrapeDistributions(page, dealId) {
  await page.goto(`${PORTAL_BASE}/app/deals/${dealId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  const viewAll = page.locator("text=View all").first();
  if (await viewAll.isVisible().catch(() => false)) {
    await viewAll.click();
    await page.waitForTimeout(1000);
  }
  const text = await page.evaluate(() => document.body.innerText);
  return parseDistributionText(text);
}

export async function scrapeOwnershipPct(page, dealId) {
  await page.goto(`${PORTAL_BASE}/app/deals/${dealId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  const text = await page.evaluate(() => document.body.innerText);
  return parseOwnershipPct(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("cashflowportal")) ?? ctx.pages()[0];

  const configRaw = await (await import("node:fs/promises")).readFile("config.json", "utf8");
  const config = JSON.parse(configRaw);

  for (const [slug, deal] of Object.entries(config.deals)) {
    const result = await harvestDeal(page, deal.dealId, slug, `data/raw/${slug}`);
    console.log(`${slug}: ${result.newMonths.length ? result.newMonths.join(", ") : "no new months"}`);
  }
  await browser.close();
}
