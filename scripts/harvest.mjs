import { loadRecords, saveRecords } from "./lib/record-store.mjs";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { archiveFile, resolveArchiveRoot } from "./lib/archive-store.mjs";
import { resolveBatchDate } from "./lib/batch-date.mjs";
import { extractPagesFromPdf } from "./lib/pdf-pages.mjs";

const execFileAsync = promisify(execFile);

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

async function downloadOrCaptureAttachment(page, href) {
  const context = page.context();

  let popupHandler;
  let popupPageRef = null;
  const popupPdf = new Promise((resolve, reject) => {
    popupHandler = (newPage) => {
      popupPageRef = newPage;
      newPage.on("response", (r) => {
        if (r.headers()["content-type"] === "application/pdf") {
          r.body().then(resolve, reject);
        }
      });
    };
    context.on("page", popupHandler);
  });
  popupPdf.catch(() => {});

  const downloadEvent = page.waitForEvent("download", { timeout: 30000 });
  downloadEvent.catch(() => {});

  try {
    const link = page.locator(`a[href="${href}"]`).first();
    await link.click();

    const winner = await Promise.race([
      downloadEvent.then((download) => ({ type: "download", download })),
      popupPdf.then((buffer) => ({ type: "popup", buffer })),
    ]);

    if (winner.type === "download") {
      const tmpPath = await winner.download.path();
      return await readFile(tmpPath);
    }
    return winner.buffer;
  } finally {
    context.off("page", popupHandler);
    if (popupPageRef && !popupPageRef.isClosed()) await popupPageRef.close().catch(() => {});
  }
}

async function withForegroundRestored(action) {
  let frontApp = null;
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ]);
    frontApp = stdout.trim();
  } catch {
    // Not on macOS, or System Events unavailable -- skip silently, don't fail the harvest over this.
  }

  try {
    return await action();
  } finally {
    if (frontApp) {
      await execFileAsync("osascript", ["-e", `tell application "${frontApp}" to activate`]).catch(() => {});
    }
  }
}

export async function harvestDeal(page, dealId, dealSlug, rawDir, dealConfig) {
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
      return Array.from(document.querySelectorAll("a"))
        .map((a) => ({ name: a.innerText.trim(), href: a.href }))
        .filter((a) => a.href && /\.(pdf|xlsx)(\?|$)/i.test(a.href));
    });

    const downloaded = [];
    let hadFailure = false;
    for (const { name, href } of attachmentLinks) {
      const safeName = name.replace(/[^a-zA-Z0-9.\- ]/g, "_");
      try {
        const buffer = await withForegroundRestored(() => downloadOrCaptureAttachment(page, href));
        const ext = path.extname(safeName).replace(".", "");
        let pages = [];
        if (ext.toLowerCase() === "pdf") {
          const tmpPath = path.join(tmpdir(), `${randomUUID()}.pdf`);
          await writeFile(tmpPath, buffer);
          try {
            pages = await extractPagesFromPdf(tmpPath).catch(() => []);
          } finally {
            await unlink(tmpPath).catch(() => {});
          }
        }
        const text = pages.join("\n");
        const rawResult = dealConfig.classifyDoc({ filename: safeName, pages, text });
        const sections = Array.isArray(rawResult) ? rawResult : [{ docType: rawResult, pageRange: null }];
        const docType = sections[0].docType;
        if (docType === "unknown") {
          console.warn(`harvestDeal: could not classify "${name}" (${dealSlug} ${month}) -- archived as unknown`);
        }
        const { batchKey: resolvedBatchKey, source } = resolveBatchDate({ text, harvestedAt: new Date().toISOString() });
        const batchKey = source === "harvest-fallback" ? month : resolvedBatchKey;
        await archiveFile(rawDir, batchKey, docType, ext, buffer, {
          sourceEmailSubject: subject,
          sections,
          batchDateSource: source,
        });
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

export async function harvestStaticDocument(page, dealId, docLabel, docType, rawDir, batchKey = "offering") {
  await page.goto(`${PORTAL_BASE}/app/documents/${dealId}?tab=documents`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(2500);

  const rows = page.locator("tbody tr");
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const rowText = await row.innerText();
    if (!rowText.includes(docLabel)) continue;

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      row.locator("button").nth(2).click(),
    ]);
    const tmpPath = await download.path();
    const buffer = await readFile(tmpPath);
    const result = await archiveFile(rawDir, batchKey, docType, "pdf", buffer, {
      sourceEmailSubject: docLabel,
    });
    return { found: true, ...result };
  }
  return { found: false };
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
    const dealConfig = await import(`./deals/${slug}.config.mjs`);
    const result = await harvestDeal(page, deal.dealId, slug, path.join(resolveArchiveRoot(), slug), dealConfig);
    console.log(`${slug}: ${result.newMonths.length ? result.newMonths.join(", ") : "no new months"}`);
  }
  await browser.close();
}
