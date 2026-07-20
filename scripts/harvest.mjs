import { loadRecords, saveRecords } from "./lib/record-store.mjs";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveArchiveRoot } from "./lib/archive-store.mjs";

const MONTH_NAMES = {
  jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
  apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07", july: "07",
  aug: "08", august: "08", sep: "09", september: "09", oct: "10", october: "10",
  nov: "11", november: "11", dec: "12", december: "12",
};

export function parseDistributionText(rowTexts) {
  const rows = [];
  for (const rowText of rowTexts) {
    const quarterMatch = rowText.match(/(\d{4})\s*Q([1-4])|Q([1-4])\s*(\d{4})/);
    const amountMatch = rowText.match(/\$([\d,]+\.\d{2})/);
    if (!quarterMatch || !amountMatch) continue;
    const year = quarterMatch[1] ?? quarterMatch[4];
    const q = quarterMatch[2] ?? quarterMatch[3];
    rows.push({ date: `${year}-Q${q}`, amount: parseFloat(amountMatch[1].replace(/,/g, "")) });
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
  // "visible" (the default) can time out even once rows exist: this table's
  // rows keep re-rendering as more lazy-load in, and Playwright's visibility
  // stability check never settles. "attached" only needs the row to exist,
  // but the table renders "Loading..." placeholder rows first — wait past
  // those for the real content to arrive.
  await page.waitForSelector("tbody tr", { timeout: 20000, state: "attached" });
  await page.waitForTimeout(3000);

  const rows = await page.$$eval("tbody tr", (trs) => trs.map((tr) => tr.innerText));

  const newMonths = [];
  for (let i = 0; i < rows.length; i++) {
    const subject = rows[i];
    const month = parseEmailSubjectMonth(subject);
    if (!month || seen[month]) continue;

    // Re-locate by index, not by text: some rows (e.g. monthly update
    // emails) render their date+subject on one line joined by tab
    // characters rather than newlines, which never matches hasText's
    // whitespace-normalized substring check and silently resolves to
    // zero elements.
    const row = page.locator("tbody tr").nth(i);
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
    const downloaded = [];
    let hadFailure = false;
    for (const { name, href } of attachmentLinks) {
      const safeName = name.replace(/[^a-zA-Z0-9.\- ]/g, "_");
      try {
        const link = page.locator(`a[href="${href}"]`).first();
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 30000 }),
          link.click(),
        ]);
        await download.saveAs(path.join(monthDir, safeName));
        downloaded.push(name);
      } catch (err) {
        hadFailure = true;
        console.warn(
          `harvestDeal: download failed for ${dealSlug} ${month} "${name}" (${href}): ${err.message}`
        );
      }
    }

    // Only mark a month as seen once every attachment for it has downloaded
    // successfully. A partially-downloaded month (some attachments failed)
    // must NOT be recorded as seen, so the whole month is retried on the
    // next run rather than silently leaving missing files on disk forever.
    if (!hadFailure) {
      seen[month] = { harvestedAt: new Date().toISOString(), files: downloaded };
      newMonths.push(month);
      await saveSeenManifest(seenPath, seen);
    }

    const doneButton = page.locator("text=Done").first();
    if (await doneButton.isVisible().catch(() => false)) await doneButton.click();
    await page.waitForTimeout(500);
  }

  return { newMonths };
}

export async function scrapeDistributions(page, dealId) {
  await page.goto(`${PORTAL_BASE}/app/deals/${dealId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);

  // "View all" appears in several sections (Images, Deal updates,
  // Distributions, Documents, ...) in DOM order -- find the one specifically
  // inside the Distributions section by walking up to its nearest heading,
  // rather than blindly clicking the first match on the page.
  const viewAllHandle = await page.evaluateHandle(() => {
    const candidates = Array.from(document.querySelectorAll("*")).filter(
      (el) => el.children.length === 0 && /View all/.test(el.textContent || "")
    );
    for (const el of candidates) {
      let node = el;
      for (let hop = 0; hop < 8 && node; hop++) {
        node = node.parentElement;
        if (!node) break;
        const heading = node.querySelector("h1,h2,h3,h4,[class*=title],[class*=heading]");
        if (heading && heading.textContent.trim().startsWith("Distributions")) return el;
      }
    }
    return null;
  });
  const viewAllEl = viewAllHandle.asElement();
  if (viewAllEl) {
    await viewAllEl.click();
    await page.waitForTimeout(1500);
  }

  const rowTexts = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll("table"));
    for (const table of tables) {
      if (/Distribution recorded date/.test(table.innerText) || /Memo/.test(table.innerText)) {
        return Array.from(table.querySelectorAll("tbody tr")).map((tr) => tr.innerText);
      }
    }
    return [];
  });

  return parseDistributionText(rowTexts);
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
    const result = await harvestDeal(page, deal.dealId, slug, path.join(resolveArchiveRoot(), slug));
    console.log(`${slug}: ${result.newMonths.length ? result.newMonths.join(", ") : "no new months"}`);
  }
  await browser.close();
}
