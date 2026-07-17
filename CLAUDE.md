# Portal scraping compliance (hard rule)

This repo scrapes CashFlowPortal (whitepagodagroup.cashflowportal.com) via a
real, logged-in browser session (Playwright connected over Chrome DevTools
Protocol — see `scripts/harvest.mjs`). CashFlowPortal's engineering team has
directly asked (July 2026) that this stay within normal website usage:

- **Allowed:** page navigation (`page.goto`), reading the rendered DOM
  (`page.evaluate(() => document.body.innerText)` or similar), clicking
  real UI elements — including "View all" / expand-to-load-more controls
  to reveal rows that aren't rendered by default — and downloading files
  via the exact `href`/link the page itself renders. i.e., anything a
  human clicking around in the site would also trigger.
- **Never allowed:** calling CashFlowPortal's internal REST/GraphQL API
  directly, in any form:
  - Issuing requests yourself — via curl, `fetch`, `page.request.get/post`,
    or a standalone script — to `api.cashflowportal.com/...` (a different
    domain from the `whitepagodagroup.cashflowportal.com` app domain).
  - Reusing session material (e.g. the `__access_token` cookie) as a
    `Bearer` header to replay/forge a request outside the page.
  - Passively sniffing the API traffic the page generates on its own via
    `page.on("response", ...)` / `page.on("request", ...)` and reading
    the raw JSON — even though no request was forged, this still pulls
    API data instead of rendered content, and blurs the line. Read only
    what's visibly rendered.
  - GraphQL introspection (`__schema`, `IntrospectionQuery`) against
    their endpoint, for any reason, including "just exploring the shape."
  - Hand-editing `data/*.json` with numbers pulled from any of the above,
    instead of running them through the real scraping pipeline.

  Specific endpoints already hit this way and now off-limits — GET
  `/v1/deals/{id}`, `/v1/deals/{id}/investor/investments`,
  `/v1/deals/{id}/transactions`, `/v1/deals/{id}/metrics`, POST
  `/graphql/` (`getChangelog` and any other query). This list is
  illustrative, not exhaustive — the rule covers the whole
  `api.cashflowportal.com` origin, not just these paths.

  **Why this is the rule and not just "use DOM instead of API":** when
  you navigate to a page, the site's own frontend calls these same
  backend endpoints to render itself — that's expected and unavoidable.
  The rule isn't that the API can never be hit at all; it's that *we*
  never issue, replay, or eavesdrop on that call ourselves. Let the site
  call its own API to render the page, then read what actually renders.

- If a number can't be obtained by rendering a page or document and
  reading its visible content, scrape the rendered version of whatever
  page/document actually shows it (clicking through expand/pagination
  controls as needed), or ask the user to provide it manually. Do not
  "fill the gap" with a direct API call.

This is a hard constraint, not a style preference — CashFlowPortal's
engineering team has already flagged real violations of it (direct REST
calls in commit `d3611da`, a GraphQL `getChangelog` call in `02e0b09`,
and several uncommitted one-off scripts that hit `/transactions`,
`/metrics`, and intercepted network traffic directly).
