import { loadRecords, saveRecords } from "./lib/record-store.mjs";
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MONTH_NAMES = {
  jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
  apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07", july: "07",
  aug: "08", august: "08", sep: "09", september: "09", oct: "10", october: "10",
  nov: "11", november: "11", dec: "12", december: "12",
};

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
      const response = await page.request.get(href);
      const buffer = await response.body();
      const safeName = name.replace(/[^a-zA-Z0-9.\- ]/g, "_");
      await writeFile(path.join(monthDir, safeName), buffer);
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
