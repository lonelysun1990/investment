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
  const q = Math.ceil(mo / 3);
  return `${y}-Q${q}`;
}

const DEALS = { legacy: LEGACY, mcneil: MCNEIL };
const DEAL_LABELS = { legacy: "The Legacy Apartment", mcneil: "McNeil Star Apartments" };

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
      const cells = months
        .map((m) => {
          const val = getter(m);
          return `<td>${money(val, { decimals: 2 })}</td>`;
        })
        .join("");
      return `<tr><td>${label}</td>${cells}</tr>`;
    })
    .join("");
  return `<div style="overflow-x:auto"><table>${header}${body}</table></div>`;
}

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

// ── Charting helpers ──

let chartInstances = [];
function destroyCharts() {
  chartInstances.forEach((c) => c.destroy());
  chartInstances = [];
}

function renderCumulativeWaterfallChart(canvasId, records) {
  const months = sortedMonths(records);
  if (months.length === 0) return;
  const totalIncome = sumField(records, "income.total");
  const totalExpense = sumField(records, "expense.total");
  const totalNoi = sumField(records, "noi");
  const totalDebt = sumField(records, "debtService");
  const totalCapex = sumField(records, "capitalImprovements");
  const totalNet = sumField(records, "netIncome");

  const ctx = document.getElementById(canvasId).getContext("2d");
  const steps = [
    { label: "Total income", value: totalIncome },
    { label: "\u2212 Expenses", value: -totalExpense },
    { label: "= NOI", value: totalNoi },
    { label: "\u2212 Debt service", value: -totalDebt },
    { label: "\u2212 Capital imp.", value: -totalCapex },
    { label: "= Net income", value: totalNet },
  ];
  chartInstances.push(
    new Chart(ctx, {
      type: "bar",
      data: {
        labels: steps.map((s) => s.label),
        datasets: [{ data: steps.map((s) => s.value), backgroundColor: steps.map((s) => (s.value < 0 ? "#dc2626" : "#16a34a")) }],
      },
      options: {
        plugins: {
          legend: { display: false },
          title: { display: true, text: `Cumulative across ${months.length} months (${months[0]} \u2013 ${months[months.length - 1]})`, font: { size: 12 }, color: "#6b7280" },
        },
        responsive: true,
      },
    })
  );
}

function renderOccupancyLineChart(canvasId, records) {
  const months = sortedMonths(records);
  const ctx = document.getElementById(canvasId).getContext("2d");
  chartInstances.push(
    new Chart(ctx, {
      data: {
        labels: months,
        datasets: [
          { type: "line", label: "Occupancy %", data: months.map((m) => records[m].occupancyPct ?? null), yAxisID: "y", borderColor: "#2563eb", backgroundColor: "#2563eb33", fill: true, tension: 0.1 },
          { type: "line", label: "Rental income", data: months.map((m) => records[m].income?.rental ?? null), yAxisID: "y1", borderColor: "#16a34a", fill: false, tension: 0.1 },
        ],
      },
      options: {
        scales: {
          y: { position: "left", min: 0, max: 100, title: { display: true, text: "Occupancy %", color: "#2563eb" }, ticks: { color: "#2563eb" } },
          y1: { position: "right", title: { display: true, text: "Rental income ($)", color: "#16a34a" }, grid: { drawOnChartArea: false }, ticks: { color: "#16a34a" } },
        },
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
  chartInstances.push(
    new Chart(ctx, {
      type: "bar",
      data: {
        labels: months,
        datasets: [...categories].map((cat) => ({
          label: cat,
          data: months.map((m) => records[m].expense?.[cat] ?? 0),
          stack: "expenses",
        })),
      },
      options: { scales: { x: { stacked: true }, y: { stacked: true, title: { display: true, text: "Expenses ($)" } } } },
    })
  );
}

function renderDistributionChart(canvasId, records, distData, ownershipPct) {
  if (!distData || distData.length === 0) return;
  const ctx = document.getElementById(canvasId).getContext("2d");

  const months = sortedMonths(records);
  const quarterlyNoi = {};
  months.forEach((m) => {
    const q = quarterFromMonth(m);
    quarterlyNoi[q] = (quarterlyNoi[q] ?? 0) + (records[m].noi ?? 0);
  });

  const distLabels = distData.map((d) => d.date);
  const distYourShare = distData.map((d) => d.amount);
  const distPropertyTotal = ownershipPct ? distData.map((d) => Math.round(d.amount / ownershipPct * 100) / 100) : [];

  const matchData = distData.map((d) => {
    const qNoi = quarterlyNoi[d.date] ?? null;
    return qNoi;
  });

  chartInstances.push(
    new Chart(ctx, {
      data: {
        labels: distLabels,
        datasets: [
          { type: "bar", label: "Your distribution", data: distYourShare, yAxisID: "y", backgroundColor: "#16a34a" },
          { type: "line", label: "Quarterly NOI (property)", data: matchData, yAxisID: "y1", borderColor: "#2563eb", fill: false, tension: 0.1 },
        ],
      },
      options: {
        scales: {
          y: { position: "left", title: { display: true, text: "Distribution ($)", color: "#16a34a" }, ticks: { color: "#16a34a" } },
          y1: { position: "right", title: { display: true, text: "Quarterly NOI ($)", color: "#2563eb" }, grid: { drawOnChartArea: false }, ticks: { color: "#2563eb" } },
        },
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
    ${rows
      .map(
        ([label, actual, projected, derived]) =>
          `<tr><td>${label}</td><td>${actual ?? "\u2014"}</td><td>${projected ?? "\u2014"}${derived ? " (derived)" : ""}</td></tr>`
      )
      .join("")}
  </table>`;
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
      <p>Ownership percentage unknown — run <code>npm run refresh</code> after logging into the portal to scrape
      total capital raise, or set it manually in <code>data/capital.json</code>.</p></div>`;
  }

  const quarterlyNoi = quarterlyNoiFromRecords(records);

  const distRows = distData.length === 0
    ? `<tr><td colspan="5">No distributions recorded yet.</td></tr>`
    : distData.map((d) => {
        const totalProp = ownershipPct ? Math.round(d.amount / ownershipPct * 100) / 100 : null;
        const qNoi = quarterlyNoi[d.date] ?? null;
        const distRatio = qNoi && totalProp ? pct(Math.round(totalProp / qNoi * 1000) / 10) : "\u2014";
        return `<tr>
          <td>${d.date}</td>
          <td>${money(d.amount ?? 0)}</td>
          <td>${totalProp ? money(totalProp) : "\u2014"}</td>
          <td>${qNoi ? money(qNoi) : "\u2014"}</td>
          <td>${distRatio}</td>
        </tr>`;
      }).join("");

  const hasMatchData = distData.some((d) => quarterlyNoi[d.date] != null);
  const matchNote = hasMatchData
    ? `<p style="font-size:12px;color:var(--muted);margin-top:8px">Distribution ratio = total property distribution / quarterly NOI. An 8–12% ratio is typical for LP investors receiving their proportional share of ~50% of NOI distributed after debt service and reserves.</p>`
    : `<p style="font-size:12px;color:var(--muted);margin-top:8px">Quarterly NOI not available for distribution periods — P&L data may not yet cover these dates.</p>`;

  return `<div class="card">
    <h2>Your cash flow</h2>
    <div class="stat-grid">
      ${statCard("Amount invested", money(PORTFOLIO.perDeal[dealSlug] ?? 0))}
      ${statCard("Ownership", ownershipPct + "%")}
      ${statCard("Total capital raise", capData.totalRaise ? money(capData.totalRaise) : "\u2014")}
      ${statCard("Distributions received", money(derived.larryDistributed), derived.larryDistributed > 0 ? "positive" : "")}
      ${statCard("Prop. net income to date", money(derived.larryNetIncomeShare), derived.larryNetIncomeShare < 0 ? "negative" : "positive")}
    </div>
    <h3>Distribution to NOI comparison</h3>
    <canvas id="distchart-${dealSlug}" height="140"></canvas>
    ${distData.length > 0 ? `
    <h3>Distribution history</h3>
    <div style="overflow-x:auto"><table>
      <tr><th>Period</th><th>Your share</th><th>Total property</th><th>Quarterly NOI</th><th>Dist/NOI %</th></tr>
      ${distRows}
    </table></div>` : ""}
    ${matchNote}
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

  root.innerHTML = `
    <div class="card"><h2>${DEAL_LABELS[dealSlug]} \u2014 Monthly P&L ledger</h2>${pnlLedgerTable(records)}</div>
    <div class="card"><h2>Revenue \u2192 NOI \u2192 Net income (cumulative)</h2><canvas id="waterfall-${dealSlug}" height="120"></canvas></div>
    <div class="card"><h2>Expense breakdown</h2><canvas id="expenses-${dealSlug}" height="140"></canvas></div>
    <div class="card"><h2>Occupancy & rental income</h2><canvas id="occupancy-${dealSlug}" height="120"></canvas></div>
    <div class="card"><h2>Break-even occupancy</h2>
      ${
        breakEven
          ? `<div class="stat-grid">
              ${statCard("Actual occupancy", pct(breakEven.actualPct))}
              ${statCard("Break-even for NOI = $0", pct(breakEven.noiBreakEvenPct))}
              ${statCard("Break-even for Net income = $0", pct(breakEven.netIncomeBreakEvenPct))}
            </div>`
          : "<p>Not enough data to compute break-even occupancy yet.</p>"
      }
    </div>
    <div class="card"><h2>Actual vs. projection</h2>${actualVsProjectionTable(dealSlug, records)}</div>
    ${investorCashFlowCard(dealSlug, records)}
  `;

  destroyCharts();
  renderCumulativeWaterfallChart(`waterfall-${dealSlug}`, records);
  renderExpenseBreakdownChart(`expenses-${dealSlug}`, records);
  renderOccupancyLineChart(`occupancy-${dealSlug}`, records);
  renderDistributionChart(`distchart-${dealSlug}`, records, distData, derived.ownershipPct);
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
