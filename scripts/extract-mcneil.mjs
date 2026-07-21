import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseMoney } from "./lib/money.mjs";
import { extractPdfText } from "./lib/pdf-pages.mjs";

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

function splitRow(line) {
  const moneyToken = /-?\(?\$?[\d,]+\.\d{2}(?!\d)\)?/;
  const firstMoneyMatch = line.match(new RegExp(`\\s{2,}${moneyToken.source}`));
  if (!firstMoneyMatch) return null;
  const label = line.slice(0, firstMoneyMatch.index).trim();
  // pdftotext occasionally glues a short "0.00" value directly onto the
  // label with zero or one separating space when the layout leaves no room
  // for a real 2+-space gap before it -- that glued value would otherwise
  // get absorbed into the label, shifting every later column by one. A
  // trailing money-shaped token in the label is a more reliable signal of
  // this than trying to recover its exact value, so skip the row rather
  // than guess -- same philosophy as the account-code false-positive case
  // handled by the (?!\d) lookahead above.
  if (new RegExp(`${moneyToken.source}$`).test(label)) return null;
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

  // Trailing Profit And Loss Detail layout: "Account   Actual   Actual  ...
  // Total   Variance", with month/year labels on the line immediately
  // before it, ending in "Adjusted" (for "Adjusted Total") instead of a
  // bare "Total".
  const accountActualLineIndex = lines.findIndex((l) => /^Account\s+Actual(\s+Actual)*/.test(l.trim()));
  if (accountActualLineIndex > 0) {
    const monthLabels = lines[accountActualLineIndex - 1]
      .trim()
      .split(/\s{2,}/)
      .filter(Boolean);
    if (monthLabels.length > 1 && /^\w{3} \d{4}$/.test(monthLabels[0])) {
      return monthLabels.slice(0, -1).map(toMonthKey);
    }
  }

  throw new Error("extract-mcneil: could not find table header row");
}

export async function extractMcneilPnl(pdfPath, pageRange) {
  const text = await extractPdfText(pdfPath, pageRange);
  const lines = text.split("\n");
  const monthKeys = parseMonthHeader(text);

  const months = new Map();
  for (const key of monthKeys) {
    months.set(key, {
      income: { rental: 0, other: 0, total: 0 },
      expense: { total: 0 },
      noi: 0,
      nonOperatingExpense: { debtService: 0, otherNonOperating: 0, capitalImprovements: 0, total: 0 },
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
  const nonOperatingTotalCaptured = new Set();

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
    const label = row.label.replace(/^\d+\.\d+\s+/, "");
    const perMonth = row.values.slice(0, monthKeys.length);
    if (perMonth.length !== monthKeys.length) continue;

    monthKeys.forEach((key, i) => {
      const rec = months.get(key);
      const value = perMonth[i];
      if (label === "Total Rental Income" || label === "Total Net Rental Income") rec.income.rental = value;
      else if (label === "Total Other Income" || label === "Total Other Rental Income") rec.income.other = value;
      else if (label === "TOTAL INCOME") rec.income.total = value;
      else if (label === "NET OPERATING INCOME") rec.noi = value;
      else if (label === "Total Debt Service") rec.nonOperatingExpense.debtService = value;
      else if (label === "Total Capital Improvements") rec.nonOperatingExpense.capitalImprovements = value;
      else if (label === "NET INCOME") {
        rec.netIncome = value;
      } else if (label === "TOTAL EXPENSE") {
        rec.expense.total = value;
        aggregateExpenseMonths.add(key);
      } else if (label === "TOTAL NON-OPERATING EXPENSE") {
        rec.nonOperatingExpense.total = value;
        aggregateOnlyMonths.add(key);
        nonOperatingTotalCaptured.add(key);
      } else if (label === "TOTAL NON-OPERATING") {
        rec.nonOperatingExpense.total = value;
        nonOperatingTotalCaptured.add(key);
      } else if (/^Total /.test(label)) {
        rec.expense[label.replace(/^Total /, "")] = value;
      }
    });

    if (label === "NET INCOME") reachedNetIncome = true;
  }

  for (const [key, rec] of months) {
    if (aggregateExpenseMonths.has(key)) continue;
    const expenseTotal = Object.entries(rec.expense)
      .filter(([k]) => k !== "total")
      .reduce((sum, [, v]) => sum + v, 0);
    rec.expense.total = Math.round(expenseTotal * 100) / 100;
  }

  for (const [key, rec] of months) {
    if (nonOperatingTotalCaptured.has(key)) continue;
    const nonOpTotal =
      rec.nonOperatingExpense.debtService +
      rec.nonOperatingExpense.otherNonOperating +
      rec.nonOperatingExpense.capitalImprovements;
    rec.nonOperatingExpense.total = Math.round(nonOpTotal * 100) / 100;
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
      Object.values(rec.nonOperatingExpense).every((v) => v === 0) &&
      rec.netIncome === 0;
    if (allZero) months.delete(key);
  }
  return months;
}

export async function extractMcneilDistributions(pdfPath, labelPattern, pageRange) {
  const text = await extractPdfText(pdfPath, pageRange);
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
import { extractRentRollPdf } from "./extract-mcneil-rentroll-pdf.mjs";
import { runGenericExtraction } from "./lib/run-extraction.mjs";
import { distributionLabel } from "./deals/mcneil.config.mjs";
import { resolveArchiveRoot } from "./lib/archive-store.mjs";

function findSections(manifest, docTypes) {
  const results = [];
  for (const file of manifest.files) {
    const sections = file.sections ?? [{ docType: file.docType, pageRange: null }];
    for (const section of sections) {
      if (docTypes.includes(section.docType)) {
        results.push({ fileName: file.fileName, pageRange: section.pageRange, docType: section.docType });
      }
    }
  }
  return results;
}

export async function extractMcneilBatch(batchDir, manifest) {
  const months = new Map();

  const rentRolls = [];
  for (const { fileName } of findSections(manifest, ["rentroll"])) {
    rentRolls.push(await extractRentRoll(path.join(batchDir, fileName)));
  }
  for (const { fileName, pageRange } of findSections(manifest, ["rentroll-pdf"])) {
    rentRolls.push(await extractRentRollPdf(path.join(batchDir, fileName), pageRange));
  }

  const pnlSections = findSections(manifest, ["cashflow-t12", "trailing-pnl-detail"]);

  if (pnlSections.length === 0) {
    for (const rentRoll of rentRolls) {
      if (!rentRoll.asOfDate) continue;
      const month = rentRoll.asOfDate.slice(0, 7);
      months.set(month, { month, occupancyPct: rentRoll.occupancyPct, rentRoll });
    }
    return months;
  }

  for (const { fileName, pageRange, docType } of pnlSections) {
    const pdfPath = path.join(batchDir, fileName);
    const pnlByMonth = await extractMcneilPnl(pdfPath, pageRange);
    const distributionByMonth =
      docType === "cashflow-t12"
        ? await extractMcneilDistributions(pdfPath, distributionLabel, pageRange)
        : new Map();

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
      const matchingRentRoll = rentRolls.find((r) => r.asOfDate?.startsWith(month));
      if (matchingRentRoll) {
        record.occupancyPct = matchingRentRoll.occupancyPct;
        record.rentRoll = matchingRentRoll;
      }
      months.set(month, record);
    }
  }
  return months;
}

export async function runMcneilExtraction(rawDir, outputPath) {
  return runGenericExtraction(rawDir, outputPath, extractMcneilBatch);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runMcneilExtraction(path.join(resolveArchiveRoot(), "mcneil"), "data/mcneil.json");
  console.log(`Processed months: ${result.monthsProcessed.join(", ") || "(none)"}`);
}
