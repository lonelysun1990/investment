import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://localhost:9222");
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes("cashflowportal")) ?? ctx.pages()[0];
const cookies = await ctx.cookies();
const token = cookies.find(c => c.name === "__access_token")?.value;

const resp = await page.request.post("https://api.cashflowportal.com/graphql/", {
  headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  data: {
    operationName: "GetInvestorDealUpdatesQuery",
    variables: { dealId: "f8929e29-285b-4904-b4e9-5b41b035535b", teamSlug: "whitepagodagroup", offset: 0, limit: 25, investmentId: null },
    query: "query GetInvestorDealUpdatesQuery($dealId: ID!, $teamSlug: String, $offset: Int!, $limit: Int!, $investmentId: ID) { getInvestorDealUpdates(dealId: $dealId, teamSlug: $teamSlug, offset: $offset, limit: $limit, investmentId: $investmentId) { dealUpdates { id subjectLine publishedAt documents { fileName fileUrl } } } }"
  }
});
const data = await resp.json();
const updates = data.data?.getInvestorDealUpdates?.dealUpdates || [];

// List ALL unique documents across ALL updates
const seen = new Set();
for (const u of updates) {
  for (const d of (u.documents || [])) {
    if (!seen.has(d.fileUrl)) {
      seen.add(d.fileUrl);
      const ts = u.publishedAt ? new Date(parseInt(u.publishedAt) * 1000).toISOString().substring(0, 10) : "?";
      console.log(ts + " | " + u.subjectLine?.substring(0, 40) + " | " + d.fileName);
    }
  }
}
console.log("\nTotal unique documents:", seen.size);

await browser.close();
