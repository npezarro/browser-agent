# Browser Agent

Generic remote browser control system. Lets Claude CLI send commands to the user's live Chrome browser via a Manifest V3 extension.

## Architecture

```
browser-cli.sh → (HTTPS) → agent-server.js (VM:3102) → (poll) → extension/content.js (Chrome)
                                                       → (poll) → extension/background.js (tab mgmt, CDP)
```

- **extension/content.js** — Content script, matches all pages, polls `/agent/commands` every 3s (replaces TM userscript as of v2.0.0)
- **extension/background.js** — MV3 service worker for tab management, CDP trusted input, screenshots
- **agent-server.js** — Node.js relay server, PM2 `browser-agent`, port 3102
- **browser-cli.sh** — Bash CLI wrapper, symlinked at `~/bin/browser-cli`
- **browser-agent.user.js** — Legacy TM userscript (deprecated, kept for reference)

## Key Endpoints

- `POST /agent/interactive` — Synchronous: send command, block until result (used by CLI)
- `GET /agent/commands` — Content script polls this
- `POST /agent/result` — Content script posts results here

## Deploy

```bash
bash deploy.sh   # copies files to VM, restarts PM2
```

After deploy, reload the extension. **Prefer the remote path — no chrome://extensions visit needed:**

```bash
cd /mnt/c/Users/npeza/Documents/repos/browser-agent && git pull   # Chrome loads from HERE, not WSL
browser-cli ext-reload                                            # chrome.runtime.reload() via the relay
```

`ext-reload` blocks until the extension reconnects and exits non-zero if it comes back still stale.
`ext-status` reports `version` (what the browser is running) vs `expectedVersion` (what this checkout
ships) plus a `stale` boolean, so post-deploy drift is visible rather than assumed.

Manual fallback (`chrome://extensions` > Browser Agent > reload icon) is only needed to **bootstrap**:
`ext-reload` must already exist in the *running* version, so a browser on pre-2.10.0 code needs one
manual reload. It also can't recover an extension whose service worker is dead — `ext-status` shows
`connected:false` in that case.

Why this works: for an unpacked extension `chrome.runtime.reload()` is treated as an update and
re-reads every file from disk. It needs no permissions and is callable from an MV3 service worker.
Pulling the Windows checkout first is what makes it pick up new code rather than reload the same code.

**Version bump:** Always increment the version in `extension/manifest.json` when changing extension files (background.js, content.js, popup.html). The user checks the version number in chrome://extensions after reloading to confirm the new code loaded. Use semver: patch for fixes, minor for new features.

**CRITICAL: Extension lives on Windows filesystem.** Chrome loads the extension from `C:\Users\npeza\Documents\repos\browser-agent\extension\` (WSL path: `/mnt/c/Users/npeza/Documents/repos/browser-agent/extension/`). After changing extension files in WSL, you MUST:
1. `git push` from WSL
2. `cd /mnt/c/Users/npeza/Documents/repos/browser-agent && git pull`
3. Then ask user to reload the extension
Skipping step 2 means Chrome still sees the old code.

## Environment

- `BROWSER_AGENT_KEY` — Required. API key for auth on CLI/ext endpoints. Set in `.env` on VM and `~/.bashrc` locally.
- `BROWSER_AGENT_KEY_ALT` — Optional. Second accepted API key for a separate Chrome profile (e.g., alt Google account). Server accepts a Bearer match against either key.
- `BROWSER_AGENT_AGENT_SECRET` — Shared secret for agent endpoints (heartbeat, commands, result, log, blob). Sent via `X-Agent-Secret` header by content script and TM script. Backwards compatible: if unset, agent endpoints remain open.
- `BROWSER_AGENT_AGENT_SECRET_ALT` — Optional. Second accepted agent secret, paired with `BROWSER_AGENT_KEY_ALT` for the alt-profile extension.
- `BROWSER_AGENT_PORT` — Server port (default 3102)
- `BROWSER_AGENT_URL` — CLI override for server URL (default `https://pezant.ca/api/browser-agent`)

## Design Decisions

- **sessionStorage for tab IDs** — chrome.storage.local is shared across tabs; sessionStorage is per-tab
- **Fire-and-forget navigation** — `navigate`/`back`/`reload` post result with `keepalive: true` before executing (page unload kills the content script)
- **iframe filter** — `all_frames: false` in manifest.json prevents injection into iframes
- **Most-recent-tab default** — When no tabId specified, server picks the tab with the latest heartbeat
- **No hardcoded API key** — Server exits if `BROWSER_AGENT_KEY` is unset; CLI fails with clear error
- **Content script over TM** — Eliminated Tampermonkey dependency (v2.0.0). Content scripts are injected reliably by Chrome without a third-party extension. Uses `fetch()` instead of `GM_xmlhttpRequest`, `chrome.storage.local` instead of `GM_setValue`.

## Cowork Session Capture

The relay server hosts `/cowork/*` endpoints for capturing Claude Cowork browser extension sessions:

- `POST /cowork/snapshot` — Receive conversation snapshots from cowork-bridge extension
- `POST /cowork/end` — Mark session as ended
- `GET /cowork/sessions` — List captured sessions
- `GET /cowork/read/:id` — Read a specific session
- `GET /cowork/pending` — Poll for CLI-initiated sessions
- `POST /cowork/start` — Queue a new Cowork session from CLI
- `GET /cowork/summary` — Session summary
- `GET /cowork/config` — Extension config
- `POST /cowork/attach` / `POST /cowork/detach` — Remote debugger attach/detach

Sessions persisted to disk as JSON + markdown. See `~/repos/cowork-bridge/` for the Chrome extension.

## Multi-Tab Orchestration (v1.5.0+)

The CLI supports multi-tab workflows beyond single-tab command execution:

- **`browser-cli ensure <url>`** — Idempotent tab creation. Reuses an existing tab if the URL is already open, otherwise opens a new one. Returns the tabId for subsequent commands. Use this instead of `openTab` when you want at-most-one-tab-per-URL semantics.
- **`browser-cli close [tabId]`** — Closes a tab opened by the script. If no tabId, closes the most recent tab.
- **`browser-cli openTab <url>`** — Opens a new tab unconditionally via `window.open()`.

**Why this matters:** Agents running multi-step browser workflows (e.g., claim a game on one site, redeem a code on another) can now manage tab lifecycle without manual intervention. The `ensure` pattern prevents duplicate tabs when retrying failed flows.

## File Upload (v1.6.0+)

The CLI supports uploading local files to browser file inputs and drag-drop targets:

- **`browser-cli upload <selector> <filepath> [tabId] [--drag-drop]`** — Base64-encodes a local file, stores it on the relay server as a temporary blob (5-min TTL, 10MB limit), then triggers the browser to inject it into the target element.
- **Standard mode** (default) — Sets the file on an `<input type="file">` element and dispatches `change`/`input` events.
- **Drag-drop mode** (`--drag-drop`) — Simulates `dragenter`/`dragover`/`drop` events on the target element for sites that use drag-drop upload UIs.

**Server endpoints:** `POST /agent/upload-blob` (store), `GET /agent/blob/:id` (retrieve). Blobs auto-expire after 5 minutes.

**Use case:** Automating image uploads (e.g., FB Marketplace listing photos) without manual intervention.

## clickAny + Per-Command Timeout (v1.7.0+)

- **`browser-cli click-any <"text"> [tabId]`** — Searches ALL visible elements for matching text (not just buttons/links). Essential for custom React dropdowns (e.g., FB Marketplace category/condition) that render options as plain `<div>` or `<span>` elements.
- Via API, supports `scope` parameter to narrow search (e.g., `"span, a, [role=option]"`) and `exact: true` for exact text matching.

**Per-command timeout:** Each command has a 20s execution timeout via `Promise.race` in the poll loop. If a command hangs (e.g., `setInput` triggering an infinite React re-render), it fails gracefully instead of poisoning the entire command queue for that tab.

**CSP limitations:** Both Facebook and Google Photos block `eval`/`new Function()` via Content Security Policy. All automation must use built-in commands — no arbitrary JS execution on these sites.

**React gotchas:**
- `setInput` uses native value setters which bypass React's `onChange` — breaks autocomplete fields. Use `type` for searchable inputs.
- Newlines and double-quote chars in `setInput` values can cause timeouts on FB.
- Category dropdowns: must click the SPAN leaf element, not the parent DIV container, for React to register the selection.

## Nth-Match Click + SPA Wait (v1.9.0+)

- **`browser-cli click "text" [tabId] --nth N`** — Click the Nth element matching text. Solves duplicate-text buttons (e.g., a page header and dialog footer both named "Create Key"). Default: `--nth 1` (first match).
- **`browser-cli click-any "text" [tabId] --nth N`** — Same for clickAny.
- **`browser-cli click "selector" [tabId] --nth N`** — Also works with CSS selectors via `querySelectorAll[N-1]`.
- **`browser-cli wait-render [minLen] [timeout] [tabId]`** — Wait until `body.innerText` reaches `minLen` characters (default 50). Useful for SPAs that render empty then hydrate (e.g., Deepgram console). Default timeout 15s.
- **Button deduplication removed** — `getPageState` no longer hides duplicate-text buttons. Each button now includes an `nth` field showing its occurrence number, so agents can see "Create Key (nth:1)" vs "Create Key (nth:2)".

**CSP note:** Deepgram's console also blocks `eval`. Added to the list of CSP-restricted sites alongside Facebook and Google Photos.

## Extension Architecture (v2.0.0+)

A Manifest V3 Chrome extension (`extension/`) that provides the complete browser agent:

**Content script** (`content.js`) — injected into all top-level pages:
- Polls `/agent/commands` every 3s, executes 30+ commands (click, type, setInput, upload, etc.)
- Sends heartbeats and results to relay server
- Replaces the former Tampermonkey userscript entirely

**Background service worker** (`background.js`) — provides capabilities unavailable to content scripts:
- **Background tab creation** — `chrome.tabs.create({active: false})` — no focus stealing
- **Tab focus management** — `chrome.tabs.update` + `chrome.windows.update`
- **Direct tab queries** — `chrome.tabs.query()` without heartbeat polling
- **CDP trusted input** — `chrome.debugger` for trusted keyboard/mouse events on sites with `isTrusted` checks
- **Screenshots** — `chrome.tabs.captureVisibleTab()`

**Server routing**: Tab-management and CDP commands go to `/ext/commands` (background.js). All page-interaction commands go to `/agent/commands` (content.js).

**CLI commands**:
- `browser-cli open --bg <url>` — Open tab in background
- `browser-cli focus <target>` — Focus a tab by chrome tab id, relay tab id, or URL substring (routes through `split_target`/`target_json` as of 2026-08-02; was URL-only before)
- `browser-cli close <target>` — Close a tab by chrome tab id, relay tab id, or URL substring (same targeting, same fix date). Always close by target after a chain/loop iteration — an unresolved target here fails silently and leaks the tab.
- `browser-cli ext-status` — Check extension connection status

**Install**: Load `extension/` as unpacked extension in Chrome, configure API URL and key in popup.

## CDP Trusted Input (v1.2.0 ext, enhanced v2.2.0)

The extension uses `chrome.debugger` (Chrome DevTools Protocol) to send **trusted** keyboard and mouse events that bypass `isTrusted` checks on sites like Facebook.

- **`browser-cli cdp-type <selector> <text> [target]`** — Type text via CDP `Input.dispatchKeyEvent` (keyDown/char/keyUp per character). Focuses selector first, clears existing content (Ctrl+A, Backspace), then types character-by-character with 30ms delay. Uses `dispatchKeyEvent` instead of `insertText` because React controlled inputs respond to keyboard events but ignore `insertText`.
- **`browser-cli cdp-click <selector> [target]`** — Click via CDP `Input.dispatchMouseEvent` at element center coordinates. Sends `mouseMoved` before press/release (required for React event delegation).
- **`browser-cli cdp-eval <expression> [target]`** — Evaluate JS via CDP `Runtime.evaluate`. Bypasses CSP, enabling DOM inspection on Facebook, Google Photos, and other restrictive sites.
- **`browser-cli cdp-keys <keys-json> [target]`** — Send special keystrokes (ArrowDown, Enter, Tab, Escape) via CDP `Input.dispatchKeyEvent`.
- **`browser-cli form-fill <fields-json> [target] [--submit <regex>] [--settle MS] [--wait MS]`** (alias `ff`) — Fill framework-controlled inputs **and** submit inside a single CDP evaluation. Values go in through the native `HTMLInputElement.value` setter plus `input`/`change` events; `--submit` matches a case-insensitive regex against visible button text. Returns `{filled:{selector:length}, missing:[], submitted:bool, url, body}`. Use this for any Vue/React login or checkout form — see the atomicity rule below.

`[target]` is either a **relay tab id** (from `tabs` / `ensure`, shaped `<epoch_ms>-<rand>`) or a **URL substring**. `split_target` in `browser-cli.sh` classifies it; omitting it uses `$BROWSER_AGENT_TAB`, and omitting that too uses the active tab. Same argument for `screenshot`, `network-capture`, and `extract-virtual`.

## Tab Targeting Is Fail-Closed (v2.9.0 ext)

**Every `cdp-*` / native command refuses to run when a named target can't be resolved.** It never silently retargets the focused tab. `extension/tab-target.js:resolveTargetCore` is the single decision point (pure, unit-tested in `test/tab-targeting.test.js`); `background.js` pulls it in via `importScripts`.

Resolution order: `chromeTabId` -> relay `tabId` via the `internalToChrome` registry -> `url` substring match -> **error**. The active tab is used *only* when the caller named no target at all. Results echo `targetUrl` and `resolvedBy` (`registry` / `url` / `chromeTabId` / `activeTab`) so a wrong-tab hit is visible rather than silent.

The relay also attaches `expectUrl` (the URL it last recorded for that tab id). The extension cross-checks it **by origin** at resolution *and* again immediately before `chrome.debugger.attach`, because a relay tab id lives in the page's `sessionStorage` and therefore **survives navigation** — an id captured on site A still resolves after that tab has moved to site B.

**Why this matters (2026-07-30):** a `cdp-eval` given an explicit tab id returned the contents of a focused `myaccount.google.com` tab instead. Three bugs compounded:
1. `browser-cli.sh` passed `interactive ""` for every CDP command, so **no `tabId` ever reached the relay** — the v2.8.0 server-side fix was dead code on this path.
2. The CDP commands' optional positional was read as a URL substring unconditionally, so a tab id became `url:"<tab id>"` and matched nothing.
3. `resolveTabId` then fell through to `chrome.tabs.query({active:true})` **silently**, and `cdpEval` echoed no target, so the caller had no signal.

Net effect: any `cdp-eval`/`cdp-click` could read or click a credential page the caller never named. Treat a change to `resolveTargetCore` as a security change, and keep `test/tab-targeting.test.js` green.

**Why:** Facebook (and other sites) check `event.isTrusted` on input events. Content script synthetic events are marked `isTrusted: false` and get silently ignored. CDP events go through the browser's input pipeline and are treated as real user input.

**Architecture:** CLI sends `cdpType`/`cdpClick`/`cdpEval`/`cdpKeys` action to relay server -> extension polls `/ext/commands` -> extension attaches `chrome.debugger` to tab, sends CDP commands, detaches. The debugger attaches/detaches per command to minimize interference.

**When to use:** Use CDP commands on sites that block synthetic events (Facebook, sites with `isTrusted` guards) or CSP-restricted sites where eval is blocked. For most sites, regular `type`/`click` commands via content script are simpler and sufficient.

**CDP gotchas:**
- `keyDown` must NOT include `text` property; only `char` event should have `text`. Otherwise characters are inserted twice.
- `cdpClick` must send `mouseMoved` before `mousePressed` for React handlers to fire on dialog items.
- **`cdpClick` (Input.dispatchMouseEvent) does NOT trigger FB React handlers on comboboxes.** For FB form controls (category, condition dropdowns), use `element.click()` via `cdpEval` instead. This is a fundamental React event delegation issue on Facebook specifically.
- `cdpEval` returns values via `returnByValue: true`. Promises supported via `--await` flag: `browser-cli cdp-eval "expr" url --await`.
- **Never use `requestAnimationFrame` in CDP scroll sequences.** rAF promises never resolve on unfocused or un-painted tabs, causing the entire cdpEval to hang until the safety timer fires. Use `setTimeout` delays between scroll steps instead.
- **Debugger leak on timeout:** When using `--focus` or `--scroll` with cdpEval, the debugger lifecycle is managed manually (not via `withDebugger` helper) with a 55s safety timer that guarantees `chrome.debugger.detach` even if the server-side timeout fires first. This prevents "Another debugger is already attached" errors.

## v2.11.0 ext: Origin Containment, Durable Tab Registry, close/focus Fail-Closed (2026-08-02)

Hardening required before any **unattended** job (overnight/cron-driven browser-agent use) drives this extension. Five findings from commit `8b40b5d`, in descending order of how badly each would bite an unattended run:

1. **The tab registry did not survive the MV3 service worker.** `internalToChrome` was a module-level `Map`, and Chrome kills idle service workers after ~30s. Only a content-script `ba-register-tab` repopulated it — on a throttled (minimized/display-off) browser the content script never re-registers, so the registry silently stays empty while the relay keeps listing the tab as healthy for its own 120s TTL. Fix: mirrored into `chrome.storage.session`, which survives worker restarts and clears on browser exit.
2. **No origin containment existed.** The v2.9.0 fail-closed resolver (above) stops a *stale* target from landing somewhere unnamed, but does nothing about a *correctly-resolved* one. Added a hard-deny list (identity/bank/credential hosts, matched by host or dot-suffix so `notchase.com` can't match `chase.com`) plus a per-command `allowOrigins`. Hard-deny outranks `allowOrigins` — a job cannot allowlist its way onto a credential page, even when the tab is named by `chromeTabId`. `unsafeAllowSensitive` is the logged escape hatch for existing OAuth skills. Absent `allowOrigins`, behavior is byte-identical to v2.10.2.
3. **`cmdCloseTab`/`cmdFocusTab` bypassed `resolveTarget` entirely.** `close` did `chrome.tabs.query({url: cmd.url + "*"})` and took `tabs[0]` — a shared URL prefix closed whichever tab Chrome listed first, and an explicit `tabId` was ignored outright. A nightly job closing its own tab could close the operator's. Both now route through the same fail-closed resolver as every other command.
4. **`expectUrl` silently disabled itself in exactly the overnight condition.** The relay sourced it only from `agentTabs` (populated by content-script traffic, pruned at 120s); display off → pruned → no `expectUrl` → `originMismatch()` returns `null` → the guard is a no-op. The heartbeat now also carries the extension's own tab table (query strings stripped), which the relay prefers, because the service worker is alive whenever the browser is.
5. **`chromeTabId` was unreachable.** `resolveTargetCore` accepts and fail-closes on it, and `openTab`/`queryTabs` return it, but neither the CLI nor the relay ever forwarded one — every unattended command was forced onto the weaker relay tab id. Now plumbed end to end; had to ship with the manifest change (`exclude_matches` removes the content script from credential/chain-hotel domains, so no relay tab id is ever minted there and `chromeTabId` is the only usable primitive).

Also: `attachLock` (concurrent `cdp-*` calls raced to "Another debugger is already attached"), and `manifest.json` `exclude_matches` for credential origins + the four hotel chains (removes 3 of 4 bot fingerprints — cross-origin beacon, console monkey-patch, sessionStorage key — from sites that scan for them).

**New `browser-cli health`:** a four-state probe (background / worker-exec / content-script / cdp+targeting) → `green` | `cdp-only` | `red`. `cdp-only` is the **expected** overnight state, not an anomaly — its step 4 is the standing anti-regression gate for the wrong-tab bug from v2.9.0. Its probe origin derives from the configured relay URL, not hardcoded.

**Test change, deliberate:** "active tab is used only when no target is named at all" now asserts against `myaccount.google.com`, which the hard-deny refuses — the refusal is the point.

## Virtual Rendering (v2.4.0+)

SPAs that use IntersectionObserver-based lazy rendering (e.g., Amex Travel) require the tab to be focused and scrolled before content appears in the DOM.

- **`browser-cli cdp-eval <expr> <url> --focus --scroll`** — Focus the tab and progressively scroll the page before evaluating the expression. Forces virtual content to render by triggering IntersectionObserver callbacks. Uses `setTimeout` delays between scroll steps (not rAF).
- **`browser-cli network-capture <urlPattern> [tabUrl]`** — Intercept XHR/fetch responses via CDP Network domain. Captures response bodies matching a URL pattern after triggering a page reload. Bypasses DOM rendering entirely when the data is available via API.
- **`browser-cli network-capture --list [tabUrl]`** — Discover all network response URLs (with type, mime, status) without fetching bodies. Use to find API endpoints before targeted capture.
- **`browser-cli extract-virtual [tabUrl]`** — Tries 10 extraction approaches in sequence, returning the first that yields data: (1) direct DOM read, (2) progressive scroll+extract, (3) screenshot force-paint, (4) scrollIntoView on child cards, (5) MutationObserver wait, (6) container innerText fallback, (7) fetch monkey-patch, (8) `__NEXT_DATA__` SSR extraction, (9) XHR intercept, (10) full body text. Focuses tab via `chrome.tabs` API first. 55s safety timer guarantees debugger cleanup.

**focusTab URL matching:** Uses `.includes()` (not `.startsWith()`) so bare domain names match actual tab URLs that include the protocol prefix.

## Screenshot Capture (v2.7.0+)

Two capture paths, both via the extension:

- **Fast path** — `chrome.tabs.captureVisibleTab` (`captureTab` action). Viewport only, png/jpeg. No debugger attach. Used when no advanced flags are passed.
- **Advanced path** — CDP `Page.captureScreenshot` (`captureAdvanced` action). Supports full-page (`captureBeyondViewport`), element clipping (via `Runtime.evaluate` on `getBoundingClientRect`), and png/jpeg/webp formats. Routed through `withDebugger`.

CLI:

```
browser-cli screenshot [out] [url] [--full] [--selector CSS] [--format png|jpeg|webp] [--quality N] [--blob]
```

- `--full` — capture entire scrollable page, not just viewport.
- `--selector` — capture only the bounding box of the first matching element (scrolls into view first).
- `--format` / `--quality` — picks the right path automatically; webp/jpeg-with-quality forces CDP.
- `--blob` — store on the relay (`/agent/upload-blob`, 5min TTL) and return `{blobId, url, expiresInSec}` instead of writing a local file. Retrieval requires `X-Agent-Secret`.

```
browser-cli see "<question>" [url] [--full] [--selector CSS] [--format jpeg|png|webp] [--quality N]
```

Captures a screenshot to a temp file, then invokes `claude -p --allowedTools Read` with a prompt that points at the file. Defaults to jpeg for faster vision turnaround (override via `BROWSER_AGENT_VISION_FORMAT`). Pattern matches `fb-marketplace-poster/lib/analyze.js`.

**Routing allowlist:** `captureAdvanced` is in `EXT_TAB_ACTIONS` in `lib/core.js` alongside `captureTab` — required for the server to forward to the extension.

## Upload Timeout

The `upload` command uses the `TIMEOUT` env var (default 120s) instead of hardcoded timeout. Set `TIMEOUT=300 browser-cli upload ...` for large files.

## Site Compatibility Notes

### Reddit
New Reddit (reddit.com) uses Web Components with closed shadow DOM. Content script selectors cannot pierce the shadow boundary, and even CDP interactions are unreliable due to the component architecture. **Use old.reddit.com** for all Reddit automation:
- old.reddit.com uses standard HTML forms (textareas, buttons)
- `cdp-type` does not work on old Reddit textareas (use `cdp-eval` with direct `.value` assignment + dispatch `input` event)
- `cdp-click` has viewport calculation issues on old Reddit (use `cdp-eval` with `element.click()`)
- Navigate via `cdp-eval` with `window.location.assign()`, not the `navigate` command (content script timeouts on Reddit)

Consumer: `reddit-referral-poster`

## Running from the VM (residential-IP browsing)

The relay runs **on the VM**, but commands execute in the **home** browser. So a VM process can browse from a residential IP, bypassing datacenter-IP bot blocks (e.g. eBay returns `HTTP 403` to the GCP IP directly, but loads fine through the home browser).

`vm-browser-cli.sh` is the VM wrapper: it sources `~/browser-agent/.env` (both keys), sets `BROWSER_AGENT_URL=http://127.0.0.1:3102` (loopback, skips Apache), and execs `browser-cli.sh`. Install on the VM with `ln -sf ~/browser-agent/vm-browser-cli.sh ~/bin/browser-cli`.

- Default routes to the **main** Chrome profile; `BROWSER_AGENT_PROFILE=alt browser-cli ...` routes to the **Brave/alt** profile.
- Use `cdp-eval`, not `eval`, on CSP-locked sites — content-script eval returns `{"value":"undefined","fallback":"cdp"}`.
- Neither automation browser is logged into Discord (both redirect to `/login`); read Discord messages via the bot token + `discord.com/api/v10`, not by scraping.

## TM Scripts Install Page

TM scripts for other projects are hosted at the server's `/tm-scripts/` path (OAuth-gated). The browser-agent itself no longer uses Tampermonkey (migrated to extension content script in v2.0.0).

## Remote-browser tab targeting must fail closed

Cross-cutting rule, see **Tab Targeting Is Fail-Closed (v2.9.0 ext)** above for the
implementation. A command that names a target tab must ERROR when that target can't be
resolved, never retarget whatever is focused. Three lessons from the 2026-07-30 incident:

1. **Fail closed on named targets.** An implicit default (active tab) is legitimate only
   when the caller named nothing at all. Echo what was actually targeted (`targetUrl`,
   `resolvedBy`) so a wrong-tab hit is visible rather than silent.
2. **Verify a fix through each command family's real entry point.** The v2.8.0 fix for this
   exact bug class was correct but dead code for `cdp-*`: the CLI passed an empty tab id, so
   the server's `if (tid)` guard never fired. It had been verified against `screenshot`/`focus`
   only. Editing the layer where the bug appears is not the same as exercising the path a
   user actually invokes.
3. **A session-scoped id is not a page id.** The relay tab id lives in the page's
   `sessionStorage` and survives navigation. Cross-check a recorded URL by origin before
   acting, and re-check immediately before attaching.

## A non-composited Chrome throttles the content script, not just captures: use cdp-eval/cdp-click before declaring the browser unreachable
When the Chrome window is minimized, occluded, or the display is off, browser-agent degrades in a way that mimics a dead browser but is not one.

Symptoms seen together (2026-07-30):
- 'tabs' still lists the tab with fresh-looking heartbeats (they batch through), so the tab looks healthy.
- ping, state, text, eval, click ALL return 'Timeout waiting for browser response', on every retry.
- screenshot USED to fail with 'ERROR: Failed to capture tab: image readback failed' (captureVisibleTab needs a composited surface). **Fixed in ext v2.10.2** — `cmdCaptureTab` now races an 8s timeout and falls back to CDP `Page.captureScreenshot`, so screenshots keep working on a non-composited window. The result reports `method: "cdp-fallback"` and `primaryError`, so this symptom is now a visible field rather than a failure. If you see the raw error again, the extension is older than 2.10.2 — check `ext-status`.
- ensure, focus, ext-status keep working (service-worker side).

Cause: Chrome throttles timers in backgrounded tabs, stalling the content script's poll loop. The service worker is unaffected.

Rule: do NOT conclude the browser is unreachable from content-script timeouts. Retry the same operation as cdp-eval (alias ce) / cdp-click (cc), which route through background.js/CDP. A full multi-step form (open modal, set a React textarea via the native value setter, submit, reload, verify) was driven entirely with cdp-* against a backgrounded window.

Gotcha: cdp-eval returns its result in a 'value' field alongside targetUrl/resolvedBy. Piping to 'tail -3' cuts the value off and makes a successful call look empty; grep for '"value"' instead.

Related: browser-agent progress.md 2026-07-30 entries; memory rollup_browser_agent_gotchas.

## A timeout during a Material overlay is not a failed click — screenshot before concluding
Distinct from the throttling case above: on **Google Cloud Console** the content script
answers `ping` normally, but the moment a Material overlay opens (the `cfc-select`
Application-type dropdown on the Create-OAuth-client form), `click`/`text`/`queryall` start
returning `Timeout waiting for browser response` — **while the click itself has already
landed**. A screenshot taken right after shows the dropdown open and the option selectable.

This false timeout had real cost: two prior sessions (2026-07-01, 2026-07-11) read it as
"the Cloud Console create-client form is not automatable", recorded that in three guidance
files, and left a production Android sign-in outage unfixed for 19 days. The form is fully
automatable (verified 2026-07-30 by creating two Android OAuth clients end to end).

Rules:
- **Never infer "unautomatable" from a command timeout.** Take a `screenshot` and look.
  Exit codes describe the transport, not the page.
- `click` matches CSS **class** selectors but NOT custom element tag names
  (`material-select-item`, `developer-item` -> "Element not found"; `.business-name` works).
- A bare text match can hit a heading instead of the button: `click "Create"` matched the
  "Create client" page title. Target a distinguishing class (`.mdc-button--unelevated`)
  and confirm it is unique with `queryall` first.
- Google Play Console **is** readable via plain `text` — the older "cert is in an
  unreadable iframe" note was wrong.
- When you must transcribe an exact string (cert fingerprint, key, id), use
  `screenshot --selector <input>` for a native-resolution crop, or read it from DOM text.
  On a downscaled full-page screenshot, hex glyphs are genuinely ambiguous (`48` vs `A8`)
  and `see` will confidently misread them — it did, on a SHA-1, in this same session.
- Prefer reading identifiers from `href` attributes (`queryall "table a"`) over OCR when
  the page links to the resource.

## SPA forms must be filled and submitted in ONE call (`form-fill`)

Discovered driving staples.com checkout, 2026-08-01.

On a framework-controlled form (Vue `v-model`, React controlled inputs), filling a
field in one `browser-cli` call and clicking submit in the **next** call always
fails. Between the two calls the framework re-renders and writes its own model
back over the DOM, so the value you set is gone by the time submit fires. The
symptom is misleading: the click *does* work, and the page comes back with
"This field is required" on fields you just populated. It looks like bot
detection. It is not.

Two further traps on the same page:

- **`cdp-type` silently no-ops on background tabs.** `ensure` opens tabs with
  `openTabBackground`, so `visibilityState` is `"hidden"`, nothing can take focus,
  and `Input.dispatchKeyEvent` has no target. It still returns
  `{"typed":true,"length":23}`. Always confirm with a DOM readback, never trust
  `typed:true`. Focusing the tab does not necessarily fix it: if the Windows
  desktop is not rendering, the tab stays `hidden` even after `AppActivate`.
- **The visible submit button may not be the form's submit element.** Staples
  ships a hidden `input[type=submit]#loginButton_0` alongside the real
  `button.btn-primary`. Clicking the hidden one fires validation and nothing else.
  Match on visible text and require `offsetParent`.

Do this instead:

```bash
browser-cli form-fill '{"input[name=callback_2]":"user@example.com","input[name=callback_4]":"pw"}' \
  "$TAB" --submit '^sign in$'
```

Check `filled` (per-selector character counts) and `missing` in the response
before believing it worked. A real consumer of this pattern lives at
`privateContext/recurring-tasks/scripts/staples-giftcard-buy.py`.

**Scope note:** this is ordinary automation of a real browser on the user's own
logged-in session. It does not forge the site's anti-fraud telemetry (Staples
ships NuData `nds-pmd` behavioural biometrics), and it should not be extended to.
If a site escalates to a CAPTCHA or a step-up challenge, stop and hand back to the
user rather than trying to defeat it.

## A negative result only means something if you first PROVE you reached the state you are testing; on an SPA a URL param is not a state change
Before reporting 'source X does not expose Y', you must show evidence that the client actually entered the state where Y would appear. Otherwise you are reporting on your own setup, not on the source.

2026-08-02, Hyatt award rates: loaded /shop/rooms/<id>?rateFilter=WORLD_OF_HYATT_AWARD, saw no point values, and concluded across several rounds that Hyatt withholds award pricing. The URL parameter never activated award mode. The page has a real control -- input[type=checkbox][aria-label='Use Points'] -- and only after clicking it did the cards re-render into 'Points/Night' rows. The eventual conclusion happened to hold, but it was unearned for most of the investigation, and the same mistake could as easily have produced a confident WRONG answer.

The knowledge was already written down. travel-assistant's own notes record that direct navigation to Amex FHR /search-results returns 0 results because server-side session state is never established, and that the SPA form must be driven in the same tab. Same class, previously documented, not applied. So the rule is not 'learn this fact', it is 'run this check'.

THE CHECK, before any 'X is not available / not exposed / blocked' claim:
1. Name the state the data requires (filter on, tab selected, logged in, consent accepted).
2. ASSERT that state from the DOM, not from the URL and not from the action's return value. Read back the control: input.checked, aria-pressed, aria-selected, the active class.
3. Only then interpret an empty result.

State the assertion in the report: 'toggle confirmed checked:true, award rows rendered, values blank' is a finding. 'I passed the filter param and saw nothing' is not.

Corollaries from the same session:
- A URL/query parameter is a REQUEST for state on an SPA, never proof of it. Frameworks routinely ignore params they only emit.
- An action returning success is not proof it acted. cdp-click returned clicked:true on every attempt while the checkbox stayed unchecked, because a --bg tab put the element outside the rendered viewport and document.elementFromPoint() at its own centre returned null. Verify by re-reading the control's state.
- Prefer the element's native activation (input.click() on a checkbox) over synthesized coordinate clicks; it is what actually flipped the control here.
- When several similar controls exist, a generic selector silently hits the first. This page had TWO label.switch>span.slider pairs ('Accessible Room' and 'Use Points'). Scope with :has(), e.g. label.switch:has(input[aria-label='Use Points']) span.slider.
- Placeholder text mimics data. The only points-like string while loading was '1234 Points', a skeleton. Do not accept the first regex hit as a value.
