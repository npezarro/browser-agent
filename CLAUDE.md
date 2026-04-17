# Browser Agent

Generic remote browser control system. Lets Claude CLI send commands to the user's live Edge browser via a Tampermonkey userscript.

## Architecture

```
browser-cli.sh → (HTTPS) → agent-server.js (VM:3102) → (poll) → browser-agent.user.js (Edge)
```

- **browser-agent.user.js** — TM userscript, matches all pages, polls `/agent/commands` every 3s
- **agent-server.js** — Node.js relay server, PM2 `browser-agent`, port 3102
- **browser-cli.sh** — Bash CLI wrapper, symlinked at `~/bin/browser-cli`
- **tm-scripts/index.html** — OAuth-gated TM scripts install page, deployed to `/var/www/html/tm-scripts/`
- **sync-tm-scripts.sh** — Deploys all TM scripts from source repos to VM, syncs install page

## Key Endpoints

- `POST /agent/interactive` — Synchronous: send command, block until result (used by CLI)
- `GET /agent/commands` — TM script polls this
- `POST /agent/result` — TM script posts results here

## Deploy

```bash
bash deploy.sh   # copies files to VM, restarts PM2, deploys TM script
bash sync-tm-scripts.sh  # syncs all TM scripts + install page to VM
```

After deploy, update the TM script in Edge (auto-update or reinstall from `pezant.ca/browser-agent.user.js`).

## Environment

- `BROWSER_AGENT_KEY` — Required. API key for auth. Set in `.env` on VM and `~/.bashrc` locally.
- `BROWSER_AGENT_PORT` — Server port (default 3102)
- `BROWSER_AGENT_URL` — CLI override for server URL (default `https://pezant.ca/api/browser-agent`)

## Design Decisions

- **sessionStorage for tab IDs** — `GM_setValue` is shared across tabs; sessionStorage is per-tab
- **Fire-and-forget navigation** — `navigate`/`back`/`reload` post result before executing (page unload kills the script)
- **iframe filter** — `window.self !== window.top` check skips iframes (e.g. Walmart partytown)
- **Most-recent-tab default** — When no tabId specified, server picks the tab with the latest heartbeat
- **No hardcoded API key** — Server exits if `BROWSER_AGENT_KEY` is unset; CLI fails with clear error

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

## Companion Extension (v2.0.0+)

A Manifest V3 Edge/Chrome extension (`extension/`) that provides capabilities unavailable to Tampermonkey:

- **Background tab creation** — `chrome.tabs.create({active: false})` — no focus stealing
- **Tab focus management** — `chrome.tabs.update` + `chrome.windows.update`
- **Direct tab queries** — `chrome.tabs.query()` without heartbeat polling

**Architecture**: Extension polls `/ext/commands` on the relay server (2s interval). Server routes tab-management commands (`openTab`, `openTabBackground`, `closeTab`, `focusTab`, `queryTabs`) to extension when connected, falls back to TM script when not.

**Graceful degradation**: TM script handles `openTabBackground` as regular `openTab` (focus-stealing) when extension is absent. All existing functionality works without the extension.

**CLI commands**:
- `browser-cli open --bg <url>` — Open tab in background (extension)
- `browser-cli focus <url>` — Focus existing tab by URL (extension)
- `browser-cli ext-status` — Check extension connection status

**Install**: Load `extension/` as unpacked extension in Edge, configure API URL and key in popup.

## TM Scripts Install Page

OAuth-gated install hub at `pezant.ca/tm-scripts/` (source: `tm-scripts/index.html`). Old `install.html` redirects here.

When adding a new TM script:
1. Add entry to `SCRIPTS` array in `tm-scripts/index.html`
2. Add source path mapping to `SOURCES` in `sync-tm-scripts.sh`
3. If script needs ungated auto-update hosting, add to `UNGATED` array
4. Run `sync-tm-scripts.sh` to deploy
