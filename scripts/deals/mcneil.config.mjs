export const dealSlug = "mcneil";

const SECTION_PATTERNS = [
  { docType: "offering-doc", pattern: /subscription agreement|offering memorandum|private placement/i },
  { docType: "trailing-pnl-detail", pattern: /trailing profit and loss detail/i },
  { docType: "cashflow-t12", pattern: /twelve month (profit and loss|cash flow)/i },
  { docType: "balance-sheet", pattern: /balance sheet/i },
  { docType: "rentroll-pdf", pattern: /rent roll summary/i },
  { docType: "aged-receivables", pattern: /aged receivables summary/i },
  { docType: "cashflow-detail", pattern: /cash flow statement detail/i },
];

export function classifyDoc({ filename, pages }) {
  if (filename.toLowerCase().endsWith(".xlsx")) return [{ docType: "rentroll", pageRange: null }];

  const sections = [];
  for (let i = 0; i < pages.length; i++) {
    const pageNum = i + 1;
    const match = SECTION_PATTERNS.find(({ pattern }) => pattern.test(pages[i]));
    const docType = match ? match.docType : "unknown";
    const last = sections[sections.length - 1];
    if (last && last.docType === docType) last.pageRange[1] = pageNum;
    else sections.push({ docType, pageRange: [pageNum, pageNum] });
  }
  return sections.length ? sections : [{ docType: "unknown", pageRange: null }];
}

export const distributionLabel = /^Member's Distribution$/i;
export const totalRaiseLabel = /Total (Offering Amount|Capital Rais(?:e|ed))|Equity.*proceeds of this Offering/i;
export const investmentDeckRaiseLabel = /Total Member Capital Needed to Close/i;
export const occupancySource = "email";

// Source: McNeil Investment Deck, ACQUSITION SUMMARY table, "# Units: 32"
export const totalUnits = 32;

export const capturesEmailOccupancy = true;
