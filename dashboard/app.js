import { LEGACY, MCNEIL, PROJECTIONS, PORTFOLIO } from "./data.js";

const root = document.getElementById("view-root");
const navButtons = document.querySelectorAll("#nav button");

function money(n) {
  if (n === null || n === undefined) return "\u2014";
  return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function statCard(label, value, opts = {}) {
  const cls = opts.negative ? "negative" : opts.positive ? "positive" : "";
  return `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
}

function sumField(records, field) {
  return Object.values(records).reduce((acc, r) => acc + (r[field] ?? 0), 0);
}

function renderPortfolio() {
  const legacyNetIncome = sumField(LEGACY, "netIncome");
  const mcneilNetIncome = sumField(MCNEIL, "netIncome");
  root.innerHTML = `
    <div class="card">
      <h2>Portfolio</h2>
      <div class="stat-grid">
        ${statCard("Total invested", money(PORTFOLIO.totalInvested))}
        ${statCard("Legacy \u2014 net income to date", money(legacyNetIncome), { negative: legacyNetIncome < 0, positive: legacyNetIncome > 0 })}
        ${statCard("McNeil \u2014 net income to date", money(mcneilNetIncome), { negative: mcneilNetIncome < 0, positive: mcneilNetIncome > 0 })}
      </div>
    </div>
  `;
}

const VIEWS = { portfolio: renderPortfolio };

function navigate(viewName) {
  navButtons.forEach((b) => b.classList.toggle("active", b.dataset.view === viewName));
  (VIEWS[viewName] ?? renderPortfolio)();
}

navButtons.forEach((btn) => btn.addEventListener("click", () => navigate(btn.dataset.view)));
navigate("portfolio");
