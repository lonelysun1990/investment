import ExcelJS from "exceljs";

const COL = {
  UNIT: 1, TYPE: 2, STATUS: 9, MARKET_RENT: 11, RENT: 15,
};

export async function extractRentRoll(xlsxPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);
  const sheet = workbook.worksheets[0];

  let asOfDate = null;
  let headerRowNum = null;
  sheet.eachRow((row, rowNumber) => {
    if (headerRowNum) return;
    const col8 = row.getCell(8).value;
    if (typeof col8 === "string" && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(col8)) {
      const [m, d, y] = col8.split("/");
      asOfDate = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
    if (row.getCell(COL.UNIT).value === "Unit") {
      headerRowNum = rowNumber;
    }
  });
  if (!headerRowNum) throw new Error(`extract-mcneil-rentroll: no header row found in ${xlsxPath}`);

  let totalUnits = 0, occupiedUnits = 0, vacantUnits = 0;
  const otherStatusUnits = [];
  let marketRentSum = 0, actualRentSum = 0, occupiedCount = 0;

  for (let r = headerRowNum + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const unit = row.getCell(COL.UNIT).value;
    if (unit === null || unit === undefined || unit === "") break;

    totalUnits++;
    const status = row.getCell(COL.STATUS).value;
    const marketRent = Number(row.getCell(COL.MARKET_RENT).value) || 0;
    const actualRent = Number(row.getCell(COL.RENT).value) || 0;

    if (status === "C") {
      occupiedUnits++;
      marketRentSum += marketRent;
      actualRentSum += actualRent;
      occupiedCount++;
    } else if (status === null || status === undefined || status === "") {
      vacantUnits++;
    } else {
      otherStatusUnits.push({ unit: String(unit), status: String(status) });
    }
  }

  const lossToLeaseTotal = marketRentSum - actualRentSum;

  return {
    asOfDate,
    totalUnits,
    occupiedUnits,
    occupancyPct: Math.round((occupiedUnits / totalUnits) * 1000) / 10,
    vacantUnits,
    otherStatusUnits,
    avgMarketRent: occupiedCount ? Math.round((marketRentSum / occupiedCount) * 100) / 100 : 0,
    avgActualRent: occupiedCount ? Math.round((actualRentSum / occupiedCount) * 100) / 100 : 0,
    lossToLeaseTotal: Math.round(lossToLeaseTotal * 100) / 100,
  };
}
