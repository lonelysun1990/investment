import { LEGACY, MCNEIL, PROJECTIONS, PORTFOLIO, DISTRIBUTIONS, CAPITAL, DERIVED } from "./data.js";

const root = document.getElementById("view-root");
const navButtons = document.querySelectorAll("#nav button");

function money(n, opts = {}) {
  if (n === null || n === undefined) return "\u2014";
  const dec = opts.decimals ?? 0;
  const formatted = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: dec, minimumFractionDigits: dec });
  return n < 0 ? `($${formatted})` : `$${formatted}`;
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
  return Object.keys(records).sort().reverse();
}

function hasData(record) {
  return (record.income?.total ?? 0) !== 0 ||
         (record.expense?.total ?? 0) !== 0 ||
         record.occupancyPct != null;
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

function moneyBracketed(n, opts = {}) {
  if (n === null || n === undefined) return "—";
  const dec = opts.decimals ?? 0;
  const formatted = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: dec, minimumFractionDigits: dec });
  return `($${formatted})`;
}

function pnlLedgerTable(records) {
  const months = sortedMonths(records).filter(m => hasData(records[m]));
  if (months.length === 0) return "<p>No monthly records yet.</p>";
  const rows = [
    { label: "Rental income", getter: (m) => records[m].income?.rental },
    { label: "Other income", getter: (m) => records[m].income?.other },
    { label: "Total income", getter: (m) => records[m].income?.total, highlight: true },
    { label: "Total operating expense", getter: (m) => records[m].expense?.total, alwaysBracket: true },
    { label: "NOI", getter: (m) => records[m].noi, highlight: true },
    { label: "Non-operating expense", getter: (m) => records[m].nonOperatingExpense?.total, alwaysBracket: true },
    { label: "Net income", getter: (m) => records[m].netIncome, highlight: true },
  ];
  const unreconciledMonths = months.filter((m) => records[m].reconciled === false);
  const header = `<tr><th>Account</th>${months
    .map((m) =>
      unreconciledMonths.includes(m)
        ? `<th class="flag-low-confidence" title="This month's figures don't fully reconcile (income - expense should equal NOI, and NOI - non-operating expense should equal net income) -- likely a transcription error in the source document. Treat with caution.">${m} ⚠</th>`
        : `<th>${m}</th>`
    )
    .join("")}</tr>`;
  const body = rows
    .map(({ label, getter, highlight, alwaysBracket }) => {
      const cells = months
        .map((m) => {
          const value = getter(m);
          const display = alwaysBracket
            ? value == null ? "—" : moneyBracketed(value, { decimals: 2 })
            : money(value, { decimals: 2 });
          const cellClass = unreconciledMonths.includes(m) ? " class=\"flag-low-confidence\"" : "";
          return `<td${cellClass}>${display}</td>`;
        })
        .join("");
      const rowClass = highlight ? " class=\"row-highlight\"" : "";
      return `<tr${rowClass}><td class="row-label">${label}</td>${cells}</tr>`;
    })
    .join("");
  const footnote = unreconciledMonths.length
    ? `<p class="flag-low-confidence" style="font-size:12px;margin-top:8px;">⚠ ${unreconciledMonths.join(", ")}: figures don't fully reconcile in the source document -- likely a transcription error. Treat with caution.</p>`
    : "";
  return tableScrollWrapper(months.length, `<table>${header}${body}</table>`) + footnote;
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

function renderExpenseBreakdownChart(canvasId, records) {
  const months = sortedMonths(records).filter(m => hasData(records[m]));
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
  const months = sortedMonths(records).filter(m => hasData(records[m]));
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
    return qNoi != null ? Math.round(qNoi * (ownershipPct / 100) * 100) / 100 : null;
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
  const months = sortedMonths(records).filter(m => hasData(records[m]));
  if (months.length === 0) return `<p>No monthly records yet.</p>`;
  const latest = records[months[0]];
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
  const otherIncome = record.income?.other ?? 0;
  const noiBreakEvenPct = ((record.expense?.total ?? 0) - otherIncome) / rentalIncomePerOccupancyPoint;

  let netIncomeBreakEvenPct = null;
  if (record.nonOperatingExpense) {
    const fixedOutflow = (record.expense?.total ?? 0) + record.nonOperatingExpense.total;
    netIncomeBreakEvenPct = Math.round(((fixedOutflow - otherIncome) / rentalIncomePerOccupancyPoint) * 10) / 10;
  }

  return {
    noiBreakEvenPct: Math.round(noiBreakEvenPct * 10) / 10,
    netIncomeBreakEvenPct,
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
        const yourNoiShare = qNoi ? Math.round(qNoi * (ownershipPct / 100) * 100) / 100 : null;
        return `<tr>
          <td>${d.date}</td>
          <td>${money(d.myDistribution)}</td>
          <td>${money(d.totalDistribution)}</td>
          <td>${qNoi ? money(qNoi) : "\u2014"}</td>
          <td>${yourNoiShare ? money(yourNoiShare) : "\u2014"}</td>
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
      <tr><th>Period</th><th>Your distribution</th><th>Total distribution</th><th>Quarterly NOI</th><th>Your NOI share</th></tr>
      ${distRows}
    </table></div>
    <p style="font-size:12px;color:var(--muted);margin-top:8px">Total distribution is the sponsor-reported total for that period (shown as — when not yet available).</p>
  </div>`;
}

// ── renderDealView ──

function renderDealView(dealSlug) {
  const records = DEALS[dealSlug];
  const months = sortedMonths(records).filter(m => hasData(records[m]));
  const latestMonth = months[0];
  const latest = latestMonth ? records[latestMonth] : null;
  const breakEven = latest ? breakEvenOccupancy(latest) : null;
  const distData = DISTRIBUTIONS[dealSlug] ?? [];
  const derived = DERIVED[dealSlug] ?? {};
  const nMonths = months.length;

  root.innerHTML = `
    <div class="card"><h2>${DEAL_LABELS[dealSlug]} \u2014 Monthly P&L ledger</h2>${pnlLedgerTable(records)}</div>
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
