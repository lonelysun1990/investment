const TOLERANCE = 1; // matches the existing NOI_CROSS_CHECK_TOLERANCE precedent in extract-legacy.mjs

export function reconcilePnlRecord(record) {
  const notes = [];

  const expectedNoi = (record.income?.total ?? 0) - (record.expense?.total ?? 0);
  if (record.noi != null && Math.abs(expectedNoi - record.noi) > TOLERANCE) {
    notes.push(
      `NOI mismatch: income.total (${record.income?.total}) - expense.total (${record.expense?.total}) = ${expectedNoi}, but noi is ${record.noi}`
    );
  }

  const expectedNetIncome = (record.noi ?? 0) - (record.nonOperatingExpense?.total ?? 0);
  if (record.netIncome != null && Math.abs(expectedNetIncome - record.netIncome) > TOLERANCE) {
    notes.push(
      `Net income mismatch: noi (${record.noi}) - nonOperatingExpense.total (${record.nonOperatingExpense?.total}) = ${expectedNetIncome}, but netIncome is ${record.netIncome}`
    );
  }

  return { reconciled: notes.length === 0, notes };
}
