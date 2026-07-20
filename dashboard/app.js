import { LEGACY, MCNEIL, PROJECTIONS, PORTFOLIO, DISTRIBUTIONS, CAPITAL, DERIVED } from "./data.js";

const root = document.getElementById("view-root");
const navButtons = document.querySelectorAll("#nav button");

function money(n, opts = {}) {
  if (n === null || n === undefined) return "\u2014";
  const dec = opts.decimals ?? 0;
  return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: dec, minimumFractionDigits: dec });
}

function pct(n) {
  if (n === null || n === undefined) return "\u2014";
  return n + "%";
}

function statCard(label, value, cls) {
  return `<div class="stat"><div class="label">${label}</div><div class="value ${cls || ""}">${value}</div></div>`;
}

function sumField(records, field) {
  return Object.values(records).reduce((acc, r) => acc + (r[field] ?? 0), 0);
}

function sortedMonths(records) {
  return Object.keys(records).sort();
}

function quarterFromMonth(m) {
  const y = m.slice(0, 4);
  const mo = parseInt(m.slice(5, 7));
  return `${y}-Q${Math.ceil(mo / 3)}`;
}

const DEALS = { legacy: LEGACY, mcneil: MCNEIL };
const DEAL_LABELS = { legacy: "The Legacy Apartment", mcneil: "McNeil Star Apartments" };

// ── Shared scroll state ──
let scrollSynced = [];
function syncScrolls(source) {
  const left = source.scrollLeft;
  scrollSynced.forEach((el) => { if (el !== source) el.scrollLeft = left; });
}

// ── Portfolio view ──

function renderPortfolio() {
  const legacyNetIncome = sumField(LEGACY, "netIncome");
  const mcneilNetIncome = sumField(MCNEIL, "netIncome");
  root.innerHTML = `
    <div class="card">
      <h2>Portfolio</h2>
      <div class="stat-grid">
        ${statCard("Total invested", money(PORTFOLIO.totalInvested))}
        ${statCard("Legacy \u2014 net income to date", money(legacyNetIncome), legacyNetIncome < 0 ? "negative" : "positive")}
        ${statCard("McNeil \u2014 net income to date", money(mcneilNetIncome), mcneilNetIncome < 0 ? "negative" : "positive")}
      </div>
    </div>
  `;
}

// ── Per-deal helpers ──

function pnlLedgerTable(records) {
  const months = sortedMonths(records);
  if (months.length === 0) return "<p>No monthly records yet.</p>";
  const rows = [
    ["Rental income", (m) => records[m].income?.rental],
    ["Other income", (m) => records[m].income?.other],
    ["Total income", (m) => records[m].income?.total],
    ["Total expense", (m) => records[m].expense?.total],
    ["NOI", (m) => records[m].noi],
    ["Debt service", (m) => records[m].debtService],
    ["Capital improvements", (m) => records[m].capitalImprovements],
    ["Net income", (m) => records[m].netIncome],
  ];
  const header = `<tr><th>Account</th>${months.map((m) => `<th>${m}</th>`).join("")}</tr>`;
  const body = rows
    .map(([label, getter]) => {
      const cells = months.map((m) => `<td>${money(getter(m), { decimals: 2 })}</td>`).join("");
      return `<tr><td class="row-label">${label}</td>${cells}</tr>`;
    })
    .join("");
  return tableScrollWrapper(months.length, `<table>${header}${body}</table>`);
}

function tableScrollWrapper(colCount, inner) {
  const minW = Math.max(colCount * 120, 400);
  return `<div class="scroll-sync" style="overflow-x:auto;max-width:100%" onscroll="this._sync&&this._sync(this)"><div style="min-width:${minW}px">${inner}</div></div>`;
}

function chartScrollWrapper(colCount, inner) {
  const w = Math.max(colCount * 100, 500);
  return `<div class="scroll-sync" style="overflow-x:auto;max-width:100%"><div style="min-width:${w}px;height:240px">${inner}</div></div>`;
}

// ── Charting ──

let chartInstances = [];
function destroyCharts() {
  chartInstances.forEach((c) => c.destroy());
  chartInstances = [];
  scrollSynced = [];
}

const CHART_COLORS = ["#16a34a", "#dc2626", "#2563eb", "#eab308", "#8b5cf6", "#f97316", "#06b6d4", "#ec4899", "#84cc16", "#6366f1", "#14b8a6", "#f43f5e"];

function renderMonthlyWaterfallChart(canvasId, records) {
  const months = sortedMonths(records);
  if (months.length === 0) return;
  const ctx = document.getElementById(canvasId).getContext("2d");
  const incomeVals = months.map((m) => records[m].income?.total ?? 0);
  const expenseVals = months.map((m) => -(records[m].expense?.total ?? 0));
  const noiVals = months.map((m) => records[m].noi ?? 0);
  const debtVals = months.map((m) => -(records[m].debtService ?? 0));
  const capexVals = months.map((m) => -(records[m].capitalImprovements ?? 0));
  const netVals = months.map((m) => records[m].netIncome ?? 0);

  chartInstances.push(
    new Chart(ctx, {
      type: "bar",
      data: {
        labels: months,
        datasets: [
          { label: "Total income", data: incomeVals, backgroundColor: CHART_COLORS[0] },
          { label: "Expenses", data: expenseVals, backgroundColor: CHART_COLORS[1] },
          { label: "NOI", data: noiVals, backgroundColor: CHART_COLORS[2] },
          { label: "Debt service", data: debtVals, backgroundColor: CHART_COLORS[3] },
          { label: "Capital imp.", data: capexVals, backgroundColor: CHART_COLORS[4] },
          { label: "Net income", data: netVals, backgroundColor: CHART_COLORS[5], borderColor: "#000", borderWidth: 1, type: "bar" },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
      },
    })
  );
}

function renderExpenseBreakdownChart(canvasId, records) {
  const months = sortedMonths(records);
  const categories = new Set();
  months.forEach((m) => Object.keys(records[m].expense ?? {}).forEach((c) => c !== "total" && categories.add(c)));
  if (categories.size === 0) return;
  const ctx = document.getElementById(canvasId).getContext("2d");
  const catArr = [...categories];
  chartInstances.push(
    new Chart(ctx, {
      type: "bar",
      data: {
        labels: months,
        datasets: catArr.map((cat, i) => ({
          label: cat,
          data: months.map((m) => records[m].expense?.[cat] ?? 0),
          stack: "expenses",
          backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { x: { stacked: true }, y: { stacked: true, title: { display: true, text: "$" } } },
        plugins: { legend: { position: "bottom" } },
      },
    })
  );
}

function renderOccupancyOverlayChart(canvasId, records) {
  const months = sortedMonths(records);
  const ctx = document.getElementById(canvasId).getContext("2d");
  chartInstances.push(
    new Chart(ctx, {
      data: {
        labels: months,
        datasets: [
          { type: "bar", label: "Rental income", data: months.map((m) => records[m].income?.rental ?? 0), yAxisID: "y", backgroundColor: "#93c5fd80", order: 2 },
          { type: "line", label: "Occupancy %", data: months.map((m) => records[m].occupancyPct ?? null), yAxisID: "y1", borderColor: "#2563eb", backgroundColor: "#2563eb", fill: false, tension: 0.1, order: 1, pointRadius: 4 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { position: "left", title: { display: true, text: "Rental income ($)", color: "#93c5fd" }, ticks: { color: "#93c5fd" }, grid: { drawOnChartArea: true } },
          y1: { position: "right", min: 0, max: 100, title: { display: true, text: "Occupancy %", color: "#2563eb" }, ticks: { color: "#2563eb" }, grid: { drawOnChartArea: false } },
        },
        plugins: { legend: { position: "bottom" } },
      },
    })
  );
}

function renderDistributionChart(canvasId, records, distData, ownershipPct) {
  if (!distData || distData.length === 0 || !ownershipPct) return;
  const ctx = document.getElementById(canvasId).getContext("2d");

  const months = sortedMonths(records);
  const quarterlyNoi = {};
  months.forEach((m) => {
    const q = quarterFromMonth(m);
    quarterlyNoi[q] = (quarterlyNoi[q] ?? 0) + (records[m].noi ?? 0);
  });

  const labels = distData.map((d) => d.date);
  const yourDist = distData.map((d) => d.myDistribution);
  const yourNoiShare = distData.map((d) => {
    const qNoi = quarterlyNoi[d.date];
    return qNoi != null ? Math.round(qNoi * ownershipPct * 100) / 100 : null;
  });

  chartInstances.push(
    new Chart(ctx, {
      data: {
        labels,
        datasets: [
          { type: "bar", label: "Your distribution", data: yourDist, backgroundColor: "#16a34a", order: 1 },
          { type: "line", label: "Your NOI share", data: yourNoiShare, borderColor: "#2563eb", backgroundColor: "#2563eb", fill: false, tension: 0.1, order: 0, pointRadius: 5 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { title: { display: true, text: "$" } },
        },
        plugins: { legend: { position: "bottom" } },
      },
    })
  );
}

// ── Actual vs projection ──

function actualVsProjectionTable(dealSlug, records) {
  const projection = PROJECTIONS[dealSlug];
  if (!projection) return `<p>No projection data extracted yet for this deal.</p>`;
  const months = sortedMonths(records);
  if (months.length === 0) return `<p>No monthly records yet.</p>`;
  const latest = records[months[months.length - 1]];
  const rows = [
    ["Occupancy %", pct(latest.occupancyPct), pct(projection.stabilizedOccupancyPct), projection.isDerived],
  ];
  return `<table>
    <tr><th>Metric</th><th>Actual (latest month)</th><th>Projected</th></tr>
    ${rows.map(([label, actual, projected, derived]) => `<tr><td>${label}</td><td>${actual ?? "\u2014"}</td><td>${projected ?? "\u2014"}${derived ? " (derived)" : ""}</td></tr>`).join("")}
  </table>`;
}

// ── Break-even ──

function breakEvenOccupancy(record) {
  if (!record.occupancyPct || !record.income?.rental || record.occupancyPct === 0) return null;
  const rentalIncomePerOccupancyPoint = record.income.rental / record.occupancyPct;
  const fixedOutflow = (record.expense?.total ?? 0) + (record.debtService ?? 0) + (record.capitalImprovements ?? 0);
  const otherIncome = record.income?.other ?? 0;
  const noiBreakEvenPct = ((record.expense?.total ?? 0) - otherIncome) / rentalIncomePerOccupancyPoint;
  const netIncomeBreakEvenPct = (fixedOutflow - otherIncome) / rentalIncomePerOccupancyPoint;
  return {
    noiBreakEvenPct: Math.round(noiBreakEvenPct * 10) / 10,
    netIncomeBreakEvenPct: Math.round(netIncomeBreakEvenPct * 10) / 10,
    actualPct: record.occupancyPct,
  };
}

// ── Investor cash flow ──

function quarterlyNoiFromRecords(records) {
  const months = sortedMonths(records);
  const result = {};
  months.forEach((m) => {
    const q = quarterFromMonth(m);
    result[q] = (result[q] ?? 0) + (records[m].noi ?? 0);
  });
  return result;
}

function investorCashFlowCard(dealSlug, records) {
  const distData = DISTRIBUTIONS[dealSlug] ?? [];
  const capData = CAPITAL[dealSlug] ?? {};
  const derived = DERIVED[dealSlug] ?? {};
  const ownershipPct = derived.ownershipPct;

  if (!ownershipPct) {
    return `<div class="card"><h2>Your cash flow ($${(PORTFOLIO.perDeal[dealSlug] ?? 0).toLocaleString()} invested)</h2>
      <p>Ownership percentage unknown — log into the portal and run <code>npm run refresh</code>, or set total raise in <code>data/capital.json</code>.</p></div>`;
  }

  const quarterlyNoi = quarterlyNoiFromRecords(records);

  const distRows = distData.length === 0
    ? `<tr><td colspan="5">No distributions recorded yet.</td></tr>`
    : distData.map((d) => {
        const qNoi = quarterlyNoi[d.date];
        const distRatio = qNoi && d.totalDistribution != null ? pct(Math.round(d.totalDistribution / qNoi * 1000) / 10) : "\u2014";
        const yourNoiShare = qNoi ? Math.round(qNoi * ownershipPct * 100) / 100 : null;
        return `<tr>
          <td>${d.date}</td>
          <td>${money(d.myDistribution)}</td>
          <td>${money(d.totalDistribution)}</td>
          <td>${qNoi ? money(qNoi) : "\u2014"}</td>
          <td>${yourNoiShare ? money(yourNoiShare) : "\u2014"}</td>
          <td>${distRatio}</td>
        </tr>`;
      }).join("");

  return `<div class="card">
    <h2>Your cash flow</h2>
    <div class="stat-grid">
      ${statCard("Amount invested", money(PORTFOLIO.perDeal[dealSlug] ?? 0))}
      ${statCard("Ownership", ownershipPct + "%")}
      ${statCard("Total capital raise", capData.totalRaise ? money(capData.totalRaise) : "\u2014")}
      ${statCard("Distributions received", money(derived.larryDistributed), derived.larryDistributed > 0 ? "positive" : "")}
      ${statCard("Prop. net income to date", money(derived.larryNetIncomeShare), derived.larryNetIncomeShare < 0 ? "negative" : "positive")}
    </div>
    <h3>Distribution vs. your NOI share</h3>
    <div style="height:240px"><canvas id="distchart-${dealSlug}"></canvas></div>
    <h3>Distribution history</h3>
    <div style="overflow-x:auto;max-width:100%"><table>
      <tr><th>Period</th><th>Your share</th><th>Total property</th><th>Quarterly NOI</th><th>Your NOI share</th><th>Dist / NOI %</th></tr>
      ${distRows}
    </table></div>
    <p style="font-size:12px;color:var(--muted);margin-top:8px">Total property distribution is the sponsor-reported total for that period (shown as — when not yet available). Dist/NOI % = how much of quarterly NOI is distributed to investors. A 40–60% ratio is typical (rest goes to debt service, capex, and reserves).</p>
  </div>`;
}

// ── renderDealView ──

function renderDealView(dealSlug) {
  const records = DEALS[dealSlug];
  const months = sortedMonths(records);
  const latestMonth = months[months.length - 1];
  const latest = latestMonth ? records[latestMonth] : null;
  const breakEven = latest ? breakEvenOccupancy(latest) : null;
  const distData = DISTRIBUTIONS[dealSlug] ?? [];
  const derived = DERIVED[dealSlug] ?? {};
  const nMonths = months.length;

  root.innerHTML = `
    <div class="card"><h2>${DEAL_LABELS[dealSlug]} \u2014 Monthly P&L ledger</h2>${pnlLedgerTable(records)}</div>
    <div class="card"><h2>Revenue \u2192 NOI \u2192 Net income (${nMonths} months)</h2>${chartScrollWrapper(nMonths, `<canvas id="waterfall-${dealSlug}"></canvas>`)}</div>
    <div class="card"><h2>Expense breakdown</h2>${chartScrollWrapper(nMonths, `<canvas id="expenses-${dealSlug}"></canvas>`)}</div>
    <div class="card"><h2>Occupancy & rental income</h2>${chartScrollWrapper(nMonths, `<canvas id="occupancy-${dealSlug}"></canvas>`)}</div>
    <div class="card"><h2>Break-even occupancy</h2>
      ${breakEven
        ? `<div class="stat-grid">
            ${statCard("Actual occupancy", pct(breakEven.actualPct))}
            ${statCard("Break-even for NOI = $0", pct(breakEven.noiBreakEvenPct))}
            ${statCard("Break-even for Net income = $0", pct(breakEven.netIncomeBreakEvenPct))}
          </div>`
        : "<p>Not enough data to compute break-even occupancy yet.</p>"}
    </div>
    <div class="card"><h2>Actual vs. projection</h2>${actualVsProjectionTable(dealSlug, records)}</div>
    ${investorCashFlowCard(dealSlug, records)}
  `;

  destroyCharts();
  renderMonthlyWaterfallChart(`waterfall-${dealSlug}`, records);
  renderExpenseBreakdownChart(`expenses-${dealSlug}`, records);
  renderOccupancyOverlayChart(`occupancy-${dealSlug}`, records);
  renderDistributionChart(`distchart-${dealSlug}`, records, distData, derived.ownershipPct);

  // Wire up scroll sync
  document.querySelectorAll(".scroll-sync").forEach((el) => {
    el._sync = syncScrolls;
    scrollSynced.push(el);
    el.addEventListener("scroll", () => el._sync(el), { passive: true });
  });
}

// ── Router ──

const VIEWS = {
  portfolio: renderPortfolio,
  legacy: () => renderDealView("legacy"),
  mcneil: () => renderDealView("mcneil"),
};

function navigate(viewName) {
  navButtons.forEach((b) => b.classList.toggle("active", b.dataset.view === viewName));
  destroyCharts();
  (VIEWS[viewName] ?? renderPortfolio)();
}

navButtons.forEach((btn) => btn.addEventListener("click", () => navigate(btn.dataset.view)));
navigate("portfolio");
