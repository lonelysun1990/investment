import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseMoney } from "./lib/money.mjs";

const execFileAsync = promisify(execFile);

const MONTH_ABBR = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

function toMonthKey(label) {
  const match = label.match(/^(\w{3})\s+(\d{4})$/);
  if (!match) throw new Error(`extract-mcneil: unrecognized month header "${label}"`);
  return `${match[2]}-${MONTH_ABBR[match[1]]}`;
}

async function fullText(pdfPath) {
  const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"]);
  return stdout;
}

function splitRow(line) {
  const moneyToken = /-?\(?\$?[\d,]+\.\d{2}\)?/;
  const firstMoneyMatch = line.match(new RegExp(`\\s{2,}${moneyToken.source}`));
  if (!firstMoneyMatch) return null;
  const label = line.slice(0, firstMoneyMatch.index).trim();
  const rest = line.slice(firstMoneyMatch.index).trim();
  const values = rest.split(/\s{2,}/).filter(Boolean).map(parseMoney);
  return { label, values };
}

export function parseMonthHeader(text) {
  const headerLine = text.split("\n").find((l) => /^Account\s+\w{3} \d{4}/.test(l.trim()));
  if (!headerLine) throw new Error("extract-mcneil: could not find table header row");
  const monthLabels = headerLine
    .replace(/^Account/, "")
    .trim()
    .split(/\s{2,}/)
    .filter(Boolean);
  return monthLabels.slice(0, -1).map(toMonthKey);
}

export async function extractMcneilPnl(pdfPath) {
  const text = await fullText(pdfPath);
  const lines = text.split("\n");
  const monthKeys = parseMonthHeader(text);

  const months = new Map();
  for (const key of monthKeys) {
    months.set(key, {
      income: { rental: 0, other: 0, total: 0 },
      expense: { total: 0 },
      noi: 0,
      debtService: 0,
      capitalImprovements: 0,
      netIncome: 0,
    });
  }

  let reachedNetIncome = false;
  for (const rawLine of lines) {
    if (reachedNetIncome) break;
    const row = splitRow(rawLine);
    if (!row) continue;
    const perMonth = row.values.slice(0, monthKeys.length);
    if (perMonth.length !== monthKeys.length) continue;

    monthKeys.forEach((key, i) => {
      const rec = months.get(key);
      const value = perMonth[i];
      if (row.label === "Total Rental Income") rec.income.rental = value;
      else if (row.label === "Total Other Income") rec.income.other = value;
      else if (row.label === "TOTAL INCOME") rec.income.total = value;
      else if (row.label === "NET OPERATING INCOME") rec.noi = value;
      else if (row.label === "Total Debt Service") rec.debtService = value;
      else if (row.label === "Total Capital Improvements") rec.capitalImprovements = value;
      else if (row.label === "NET INCOME") {
        rec.netIncome = value;
      } else if (/^Total /.test(row.label)) {
        rec.expense[row.label.replace(/^Total /, "")] = value;
      }
    });

    if (row.label === "NET INCOME") reachedNetIncome = true;
  }

  for (const [, rec] of months) {
    const expenseTotal = Object.entries(rec.expense)
      .filter(([k]) => k !== "total")
      .reduce((sum, [, v]) => sum + v, 0);
    rec.expense.total = Math.round(expenseTotal * 100) / 100;
  }

  for (const [key, rec] of months) {
    const allZero =
      rec.income.rental === 0 &&
      rec.income.other === 0 &&
      rec.income.total === 0 &&
      Object.values(rec.expense).every((v) => v === 0) &&
      rec.noi === 0 &&
      rec.debtService === 0 &&
      rec.capitalImprovements === 0 &&
      rec.netIncome === 0;
    if (allZero) months.delete(key);
  }
  return months;
}

export async function extractMcneilDistributions(pdfPath, labelPattern) {
  const text = await fullText(pdfPath);
  const monthKeys = parseMonthHeader(text);
  const result = new Map(monthKeys.map((key) => [key, 0]));

  for (const rawLine of text.split("\n")) {
    let row;
    try {
      row = splitRow(rawLine);
    } catch {
      // pdftotext occasionally collapses the space between two adjacent
      // wide dollar values (e.g. large negative amounts in unrelated
      // sections), which splitRow cannot parse. Skip those rows — they
      // are never the distribution row we're looking for.
      continue;
    }
    if (!row) continue;
    if (row.label.startsWith("Total ")) continue;
    if (!labelPattern.test(row.label)) continue;
    const perMonth = row.values.slice(0, monthKeys.length);
    if (perMonth.length !== monthKeys.length) continue;
    monthKeys.forEach((key, i) => {
      result.set(key, result.get(key) + Math.abs(perMonth[i]));
    });
  }
  return result;
}

import path from "node:path";
import { extractRentRoll } from "./extract-mcneil-rentroll.mjs";
import { runGenericExtraction } from "./lib/run-extraction.mjs";

export async function extractMcneilBatch(batchDir, manifest) {
  const pdfEntry = manifest.files.find((f) => f.docType === "cashflow-t12");
  const months = new Map();
  if (!pdfEntry) return months;

  const pdfPath = path.join(batchDir, pdfEntry.fileName);
  const pnlByMonth = await extractMcneilPnl(pdfPath);
  const distributionByMonth = await extractMcneilDistributions(pdfPath, /Member's Distribution/i);

  const rentrollEntry = manifest.files.find((f) => f.docType === "rentroll");
  const rentRoll = rentrollEntry ? await extractRentRoll(path.join(batchDir, rentrollEntry.fileName)) : null;

  for (const [month, pnl] of pnlByMonth) {
    const record = {
      ...pnl,
      month,
      distribution: distributionByMonth.get(month) ?? 0,
      sourceFile: pdfPath,
      extraction: { method: "deterministic", confidence: "high" },
    };
    if (rentRoll && rentRoll.asOfDate?.startsWith(month)) {
      record.occupancyPct = rentRoll.occupancyPct;
      record.rentRoll = rentRoll;
    }
    months.set(month, record);
  }
  return months;
}

export async function runMcneilExtraction(rawDir, outputPath) {
  return runGenericExtraction(rawDir, outputPath, extractMcneilBatch);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runMcneilExtraction("data/raw/mcneil", "data/mcneil.json");
  console.log(`Processed months: ${result.monthsProcessed.join(", ") || "(none)"}`);
}
