import { extractPdfText } from "./lib/pdf-pages.mjs";

export async function extractRentRollPdf(pdfPath, pageRange) {
  const text = await extractPdfText(pdfPath, pageRange);

  const asOfMatch = text.match(/Rent Roll Summary\s*\n\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const asOfDate = asOfMatch
    ? `${asOfMatch[3]}-${asOfMatch[1].padStart(2, "0")}-${asOfMatch[2].padStart(2, "0")}`
    : null;

  const occupiedMatch = text.match(/^Total\s+Occupied\s+[\d,]+\.\d{2}\s+[\d.]+%\s+(\d+)\s+([\d.]+)%/m);
  const vacantMatch = text.match(/^Total\s+Vacant\s+[\d,]+\.\d{2}\s+[\d.]+%\s+(\d+)\s+([\d.]+)%/m);
  if (!occupiedMatch || !vacantMatch) {
    throw new Error(`extract-mcneil-rentroll-pdf: could not find Property Occupancy summary in ${pdfPath}`);
  }

  const occupiedUnits = Number(occupiedMatch[1]);
  const vacantUnits = Number(vacantMatch[1]);
  return {
    asOfDate,
    totalUnits: occupiedUnits + vacantUnits,
    occupiedUnits,
    vacantUnits,
    occupancyPct: Number(occupiedMatch[2]),
  };
}
