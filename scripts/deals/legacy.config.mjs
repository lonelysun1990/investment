export const dealSlug = "legacy";

export function classifyDoc({ filename, text }) {
  if (/update\.pdf$/i.test(filename) || /\w+ Update\b/i.test(text)) return "monthly-update";
  if (/subscription agreement|offering memorandum|private placement/i.test(text)) return "offering-doc";
  return "unknown";
}

export const distributionLabel = null;
export const totalRaiseLabel = /Total (Offering Amount|Capital Rais(?:e|ed))/i;
export const occupancySource = "narrative";
