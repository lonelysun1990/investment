---
name: cashflowportal-chrome-debug
description: Use whenever you need a live, scriptable Chrome session for this repo's CashFlowPortal scraping work (harvest.mjs, refresh.mjs, or any live verification against whitepagodagroup.cashflowportal.com) and the CDP debug port (localhost:9222) is unreachable, hung, or the browser was closed/crashed. Also use proactively at the start of any such live-scraping task to launch the session correctly the first time, instead of discovering the failure mode again.
---

# CashFlowPortal Chrome debug session (CDP)

## The one thing that breaks this every time

Chrome refuses to open its remote-debugging port unless `--user-data-dir`
points to a directory Chrome considers **non-default** — and it still treats
the real default profile path as "default" even if you pass that exact path
explicitly via `--user-data-dir`. Launching Chrome any other way (via `open
-a "Google Chrome" --args ...`, or without `--user-data-dir` at all, or with
`--user-data-dir` pointing at the user's normal profile) will start Chrome
successfully but **silently never bind the debug port** — `curl
http://localhost:9222/json/version` just hangs or connection-refuses, with
no error visible unless you capture Chrome's own stdout/stderr (which `open
-a` swallows).

The fix: use a **dedicated automation profile directory** (created once,
reused every time), and launch the actual binary directly (not `open -a`) so
you can see Chrome's own startup log if something's still wrong.

## Procedure

1. **Check if a debug session is already up** before doing anything else:
   ```bash
   curl -s --max-time 3 http://localhost:9222/json/version
   ```
   If this returns a JSON object with `webSocketDebuggerUrl`, you're done —
   skip straight to navigating (Step 4).

2. **Fully quit any existing Chrome** (a second instance launched without
   the right flags will not pick them up, and a stale instance holding the
   profile lock will block the new one):
   ```bash
   osascript -e 'tell application "Google Chrome" to quit' 2>/dev/null
   sleep 2
   ps aux | grep -i "Google Chrome.app/Contents/MacOS/Google Chrome " | grep -v grep || echo "Chrome fully quit"
   ```

3. **Launch Chrome directly (not via `open -a`) with a dedicated profile
   directory**, capturing its log so any new failure mode is visible instead
   of silent:
   ```bash
   mkdir -p "$HOME/.chrome-automation-profile"
   nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.chrome-automation-profile" \
     > /tmp/chrome-launch.log 2>&1 &
   disown
   sleep 6
   cat /tmp/chrome-launch.log
   curl -s --max-time 5 http://localhost:9222/json/version
   ```
   Success looks like `DevTools listening on ws://127.0.0.1:9222/...` in the
   log and a JSON response from curl. If you instead see `DevTools remote
   debugging requires a non-default data directory...`, the profile path
   you used still resolved to Chrome's real default — double-check you're
   using `~/.chrome-automation-profile`, not the real profile path.

4. **Navigate to the portal and hand off to the human to log in** — this is
   a fresh, separate profile, so it starts with no cookies. Every time this
   profile's Chrome instance is freshly launched (or its session has
   expired), the human needs to log in manually before any scraping can
   proceed:
   ```js
   import { chromium } from "playwright";
   const browser = await chromium.connectOverCDP("http://localhost:9222");
   const ctx = browser.contexts()[0];
   const page = ctx.pages()[0] ?? (await ctx.newPage());
   await page.bringToFront();
   await page.goto("https://whitepagodagroup.cashflowportal.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
   ```
   Then tell the human the login page is up and wait for them to confirm
   they're logged in before running any harvest/scraping script.

## Symptoms that mean "go run this procedure"

- `curl http://localhost:9222/json/version` hangs, times out, or returns
  connection-refused.
- `chromium.connectOverCDP("http://localhost:9222")` in a Playwright script
  hangs or throws `ECONNREFUSED`.
- The human says the browser was closed, or a previously-working live
  scraping session suddenly can't reach the portal.
- `ps aux` shows Chrome running but `lsof -iTCP -sTCP:LISTEN -n -P | grep -i
  chrome` shows nothing — Chrome is up but the debug port never bound.

## Notes

- This is a real, disposable, human-controlled login profile — never fill
  in credentials programmatically, never try to restore cookies from the
  user's regular profile into it. The human logs in by hand each time,
  exactly as they would on any fresh browser.
- Do not spend time re-deriving this from scratch (trying `open -a` first,
  guessing at Local Network permission dialogs, checking for managed
  preferences, etc.) — go straight to Step 2/3 above.
