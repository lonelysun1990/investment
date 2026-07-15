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
          const flag = records[m].extraction?.confidence === "low" ? ' <span class="flag-low-confidence">\u26A0</span>' : "";
          return `<td>${money(val, { decimals: 2 })}${flag}</td>`;
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

function renderWaterfallChart(canvasId, record) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  const steps = [
    { label: "Total income", value: record.income?.total ?? 0 },
    { label: "\u2212 Expenses", value: -(record.expense?.total ?? 0) },
    { label: "= NOI", value: record.noi ?? 0 },
    { label: "\u2212 Debt service", value: -(record.debtService ?? 0) },
    { label: "\u2212 Capital improvements", value: -(record.capitalImprovements ?? 0) },
    { label: "= Net income", value: record.netIncome ?? 0 },
  ];
  chartInstances.push(
    new Chart(ctx, {
      type: "bar",
      data: {
        labels: steps.map((s) => s.label),
        datasets: [{ data: steps.map((s) => s.value), backgroundColor: steps.map((s) => (s.value < 0 ? "#dc2626" : "#16a34a")) }],
      },
      options: { plugins: { legend: { display: false } }, responsive: true },
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
          { type: "bar", label: "Rental income", data: months.map((m) => records[m].income?.rental ?? 0), yAxisID: "y", backgroundColor: "#93c5fd" },
          { type: "line", label: "Occupancy %", data: months.map((m) => records[m].occupancyPct ?? null), yAxisID: "y1", borderColor: "#2563eb", fill: false },
        ],
      },
      options: {
        scales: {
          y: { position: "left", title: { display: true, text: "Rental income ($)" } },
          y1: { position: "right", min: 0, max: 100, title: { display: true, text: "Occupancy %" }, grid: { drawOnChartArea: false } },
        },
      },
    })
  );
}

function renderExpenseBreakdownChart(canvasId, records) {
  const months = sortedMonths(records);
  const categories = new Set();
  months.forEach((m) => Object.keys(records[m].expense ?? {}).forEach((c) => c !== "total" && categories.add(c)));
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
      options: { scales: { x: { stacked: true }, y: { stacked: true } } },
    })
  );
}

// ── Actual vs projection (view 5) ──

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

// ── Investor cash flow (view 7) ──

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

  const distRows = distData.length === 0
    ? `<tr><td colspan="3">No distributions recorded yet.</td></tr>`
    : distData.map((d) => {
        const yourShare = Math.round(d.amount * ownershipPct) / 100;
        return `<tr>
          <td>${d.date}</td>
          <td>${money(d.amount ?? 0)}</td>
          <td>${money(yourShare)}</td>
        </tr>`;
      }).join("");

  const mismatchWarning = derived.distributionMismatch
    ? `<p class="flag-low-confidence">Calculated proportional net income (${money(derived.larryNetIncomeShare)}) differs from actual distributions (${money(derived.larryDistributed)}). This is normal when capex or reserves are involved — investigate if the gap widens over time.</p>`
    : "";

  return `<div class="card">
    <h2>Your cash flow</h2>
    <div class="stat-grid">
      ${statCard("Amount invested", money(PORTFOLIO.perDeal[dealSlug] ?? 0))}
      ${statCard("Ownership", ownershipPct + "%")}
      ${statCard("Total capital raise", capData.totalRaise ? money(capData.totalRaise) : "\u2014")}
      ${statCard("Distributions received", money(derived.larryDistributed), derived.larryDistributed > 0 ? "positive" : "")}
      ${statCard("Prop. net income", money(derived.larryNetIncomeShare), derived.larryNetIncomeShare < 0 ? "negative" : "positive")}
    </div>
    ${distData.length > 0 ? `
    <h3>Distribution history</h3>
    <div style="overflow-x:auto"><table>
      <tr><th>Period</th><th>Total property</th><th>Your share</th></tr>
      ${distRows}
    </table></div>` : ""}
    ${mismatchWarning}
  </div>`;
}

// ── renderDealView (views 1-7) ──

function renderDealView(dealSlug) {
  const records = DEALS[dealSlug];
  const months = sortedMonths(records);
  const latestMonth = months[months.length - 1];
  const latest = latestMonth ? records[latestMonth] : null;
  const breakEven = latest ? breakEvenOccupancy(latest) : null;

  root.innerHTML = `
    <div class="card"><h2>${DEAL_LABELS[dealSlug]} \u2014 Monthly P&L ledger</h2>${pnlLedgerTable(records)}</div>
    <div class="card"><h2>Revenue \u2192 NOI \u2192 Net income (latest month: ${latestMonth ?? "\u2014"})</h2><canvas id="waterfall-${dealSlug}" height="120"></canvas></div>
    <div class="card"><h2>Occupancy vs. rental income</h2><canvas id="occupancy-${dealSlug}" height="120"></canvas></div>
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
    <div class="card"><h2>Expense breakdown</h2><canvas id="expenses-${dealSlug}" height="140"></canvas></div>
    ${investorCashFlowCard(dealSlug, records)}
  `;

  destroyCharts();
  if (latest) renderWaterfallChart(`waterfall-${dealSlug}`, latest);
  renderOccupancyOverlayChart(`occupancy-${dealSlug}`, records);
  renderExpenseBreakdownChart(`expenses-${dealSlug}`, records);
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
