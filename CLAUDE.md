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

After deploy, reload the extension in Chrome (`chrome://extensions` > Browser Agent > reload icon).

**Version bump:** Always increment the version in `extension/manifest.json` when changing extension files (background.js, content.js, popup.html). The user checks the version number in chrome://extensions after reloading to confirm the new code loaded. Use semver: patch for fixes, minor for new features.

**CRITICAL: Extension lives on Windows filesystem.** Chrome loads the extension from `C:\Users\npeza\Documents\repos\browser-agent\extension\` (WSL path: `/mnt/c/Users/npeza/Documents/repos/browser-agent/extension/`). After changing extension files in WSL, you MUST:
1. `git push` from WSL
2. `cd /mnt/c/Users/npeza/Documents/repos/browser-agent && git pull`
3. Then ask user to reload the extension
Skipping step 2 means Chrome still sees the old code.

## Environment

- `BROWSER_AGENT_KEY` — Required. API key for auth on CLI/ext endpoints. Set in `.env` on VM and `~/.bashrc` locally.
- `BROWSER_AGENT_AGENT_SECRET` — Shared secret for agent endpoints (heartbeat, commands, result, log, blob). Sent via `X-Agent-Secret` header by content script and TM script. Backwards compatible: if unset, agent endpoints remain open.
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
- `browser-cli focus <url>` — Focus existing tab by URL
- `browser-cli ext-status` — Check extension connection status

**Install**: Load `extension/` as unpacked extension in Chrome, configure API URL and key in popup.

## CDP Trusted Input (v1.2.0 ext, enhanced v2.2.0)

The extension uses `chrome.debugger` (Chrome DevTools Protocol) to send **trusted** keyboard and mouse events that bypass `isTrusted` checks on sites like Facebook.

- **`browser-cli cdp-type <selector> <text> [tabUrl]`** — Type text via CDP `Input.dispatchKeyEvent` (keyDown/char/keyUp per character). Focuses selector first, clears existing content (Ctrl+A, Backspace), then types character-by-character with 30ms delay. Uses `dispatchKeyEvent` instead of `insertText` because React controlled inputs respond to keyboard events but ignore `insertText`.
- **`browser-cli cdp-click <selector> [tabUrl]`** — Click via CDP `Input.dispatchMouseEvent` at element center coordinates. Sends `mouseMoved` before press/release (required for React event delegation).
- **`browser-cli cdp-eval <expression> [tabUrl]`** — Evaluate JS via CDP `Runtime.evaluate`. Bypasses CSP, enabling DOM inspection on Facebook, Google Photos, and other restrictive sites.
- **`browser-cli cdp-keys <keys-json> [tabUrl]`** — Send special keystrokes (ArrowDown, Enter, Tab, Escape) via CDP `Input.dispatchKeyEvent`.

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

## Virtual Rendering (v2.4.0+)

SPAs that use IntersectionObserver-based lazy rendering (e.g., Amex Travel) require the tab to be focused and scrolled before content appears in the DOM.

- **`browser-cli cdp-eval <expr> <url> --focus --scroll`** — Focus the tab and progressively scroll the page before evaluating the expression. Forces virtual content to render by triggering IntersectionObserver callbacks. Uses `setTimeout` delays between scroll steps (not rAF).
- **`browser-cli network-capture <urlPattern> [tabUrl]`** — Intercept XHR/fetch responses via CDP Network domain. Captures response bodies matching a URL pattern after triggering a page reload. Bypasses DOM rendering entirely when the data is available via API.
- **`browser-cli network-capture --list [tabUrl]`** — Discover all network response URLs (with type, mime, status) without fetching bodies. Use to find API endpoints before targeted capture.
- **`browser-cli extract-virtual [tabUrl]`** — Tries 10 extraction approaches in sequence, returning the first that yields data: (1) direct DOM read, (2) progressive scroll+extract, (3) screenshot force-paint, (4) scrollIntoView on child cards, (5) MutationObserver wait, (6) container innerText fallback, (7) fetch monkey-patch, (8) `__NEXT_DATA__` SSR extraction, (9) XHR intercept, (10) full body text. Focuses tab via `chrome.tabs` API first. 55s safety timer guarantees debugger cleanup.

**focusTab URL matching:** Uses `.includes()` (not `.startsWith()`) so bare domain names match actual tab URLs that include the protocol prefix.

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

## TM Scripts Install Page

TM scripts for other projects are hosted at the server's `/tm-scripts/` path (OAuth-gated). The browser-agent itself no longer uses Tampermonkey (migrated to extension content script in v2.0.0).
