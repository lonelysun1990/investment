export const dealSlug = "mcneil";

export function classifyDoc({ filename, text }) {
  if (filename.toLowerCase().endsWith(".xlsx")) return "rentroll";
  if (/twelve month (profit and loss|cash flow)/i.test(text)) return "cashflow-t12";
  if (/balance sheet/i.test(text)) return "balance-sheet";
  if (/subscription agreement|offering memorandum|private placement/i.test(text)) return "offering-doc";
  return "unknown";
}

export const distributionLabel = /^Member's Distribution$/i;
export const totalRaiseLabel = /Total (Offering Amount|Capital Rais(?:e|ed))/i;
export const occupancySource = "rentroll";
