// scripts/lib/batch-date.mjs
export function resolveBatchDate({ text, asOfDate, harvestedAt }) {
  if (asOfDate) {
    const match = asOfDate.match(/^(\d{4})-(\d{2})-\d{2}$/);
    if (match) return { batchKey: `${match[1]}-${match[2]}`, source: "content" };
  }
  if (text) {
    const printedMatch = text.match(/Printed\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (printedMatch) {
      const [, month, , year] = printedMatch;
      return { batchKey: `${year}-${month.padStart(2, "0")}`, source: "content" };
    }
  }
  return { batchKey: harvestedAt.slice(0, 7), source: "harvest-fallback" };
}
