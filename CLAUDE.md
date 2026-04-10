# Browser Agent

Generic remote browser control system. Lets Claude CLI send commands to the user's live Edge browser via a Tampermonkey userscript.

## Architecture

```
browser-cli.sh → (HTTPS) → agent-server.js (VM:3102) → (poll) → browser-agent.user.js (Edge)
```

- **browser-agent.user.js** — TM userscript, matches all pages, polls `/agent/commands` every 3s
- **agent-server.js** — Node.js relay server, PM2 `browser-agent`, port 3102
- **browser-cli.sh** — Bash CLI wrapper, symlinked at `~/bin/browser-cli`
- **install.html** — Centralized TM script install page, deployed to `/var/www/html/install.html`

## Key Endpoints

- `POST /agent/interactive` — Synchronous: send command, block until result (used by CLI)
- `GET /agent/commands` — TM script polls this
- `POST /agent/result` — TM script posts results here

## Deploy

```bash
bash deploy.sh   # copies files to VM, restarts PM2, deploys TM script + install.html
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

- **`browser-cli click-any "text" [tabId]`** (alias `ca`) — Searches ALL visible elements for text match, not just buttons. Essential for custom React dropdowns that use plain `<div>`/`<span>` instead of `<button>`. Supports `exact` match, `excludeText` filter, and `scope` selector narrowing.
- **Per-command timeout** — Each command has a 20s default timeout (configurable via `cmd.timeout`). Prevents queue poisoning when a command hangs (e.g., React re-render loop on `setInput`). Timed-out commands return `{ok: false, error: "Command execution timeout"}`.

## install.html

Version-controlled in this repo. Deploy script copies it to `/var/www/html/install.html`. When adding new TM scripts to the ecosystem, add them here.
