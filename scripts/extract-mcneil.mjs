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
  const lines = text.split("\n");

  // Usual layout: "Account   Jul 2025   Aug 2025   ...   Total" on one line.
  const inlineHeaderLine = lines.find((l) => /^Account\s+\w{3} \d{4}/.test(l.trim()));
  if (inlineHeaderLine) {
    const monthLabels = inlineHeaderLine
      .replace(/^Account/, "")
      .trim()
      .split(/\s{2,}/)
      .filter(Boolean);
    return monthLabels.slice(0, -1).map(toMonthKey);
  }

  // Older report layout: a lone "Account" line, with the month/year labels
  // on the line immediately before it instead of sharing the same line.
  const accountLineIndex = lines.findIndex((l) => l.trim() === "Account");
  if (accountLineIndex > 0) {
    const monthLabels = lines[accountLineIndex - 1]
      .trim()
      .split(/\s{2,}/)
      .filter(Boolean);
    if (monthLabels.length > 1 && /^\w{3} \d{4}$/.test(monthLabels[0])) {
      return monthLabels.slice(0, -1).map(toMonthKey);
    }
  }

  throw new Error("extract-mcneil: could not find table header row");
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

  // Older annual reports only give one aggregate "TOTAL EXPENSE" figure
  // with no itemized categories underneath, and roll debt service +
  // capital improvements into a single "TOTAL NON-OPERATING EXPENSE" line
  // instead of reporting them separately. Track which months hit these
  // aggregate-only lines so their expense.total isn't clobbered by the
  // itemized-category recompute below, and so callers can mark those
  // months' breakdown as lower-confidence rather than silently showing
  // zeros for debtService/capitalImprovements.
  const aggregateExpenseMonths = new Set();
  const aggregateOnlyMonths = new Set();

  let reachedNetIncome = false;
  for (const rawLine of lines) {
    if (reachedNetIncome) break;
    let row;
    try {
      row = splitRow(rawLine);
    } catch {
      // A bare category-header row (no values, just an account code + label,
      // e.g. "4001.000 Net Rental Income") can coincidentally look like a
      // money token when its leading indentation collapses against the
      // "X.XXX" account code. Skip it — a real data row always has real
      // trailing values that survive splitRow.
      continue;
    }
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
      } else if (row.label === "TOTAL EXPENSE") {
        rec.expense.total = value;
        aggregateExpenseMonths.add(key);
      } else if (row.label === "TOTAL NON-OPERATING EXPENSE") {
        aggregateOnlyMonths.add(key);
      } else if (/^Total /.test(row.label)) {
        rec.expense[row.label.replace(/^Total /, "")] = value;
      }
    });

    if (row.label === "NET INCOME") reachedNetIncome = true;
  }

  for (const [key, rec] of months) {
    if (aggregateExpenseMonths.has(key)) continue;
    const expenseTotal = Object.entries(rec.expense)
      .filter(([k]) => k !== "total")
      .reduce((sum, [, v]) => sum + v, 0);
    rec.expense.total = Math.round(expenseTotal * 100) / 100;
  }

  for (const [key, rec] of months) {
    if (aggregateOnlyMonths.has(key)) rec.expenseIsAggregateOnly = true;
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
  if (!pdfEntry) {
    const rentrollOnlyEntry = manifest.files.find((f) => f.docType === "rentroll");
    if (!rentrollOnlyEntry) return months;

    const rentRollOnly = await extractRentRoll(path.join(batchDir, rentrollOnlyEntry.fileName));
    if (rentRollOnly.asOfDate) {
      const month = rentRollOnly.asOfDate.slice(0, 7);
      months.set(month, {
        month,
        occupancyPct: rentRollOnly.occupancyPct,
        rentRoll: rentRollOnly,
      });
    }
    return months;
  }

  const pdfPath = path.join(batchDir, pdfEntry.fileName);
  const pnlByMonth = await extractMcneilPnl(pdfPath);
  const distributionByMonth = await extractMcneilDistributions(pdfPath, /Member's Distribution/i);

  const rentrollEntry = manifest.files.find((f) => f.docType === "rentroll");
  const rentRoll = rentrollEntry ? await extractRentRoll(path.join(batchDir, rentrollEntry.fileName)) : null;

  for (const [month, pnl] of pnlByMonth) {
    const { expenseIsAggregateOnly, ...pnlFields } = pnl;
    const record = {
      ...pnlFields,
      month,
      distribution: distributionByMonth.get(month) ?? 0,
      sourceFile: pdfPath,
      extraction: {
        method: "deterministic",
        confidence: expenseIsAggregateOnly ? "low" : "high",
      },
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
