# context.md — browser-agent

Last Updated: 2026-06-30 — background-tab throttle fix (content cmds → extension)

## 2026-06-30 — Fix: eval/navigate/click time out on background tabs
- **Symptom:** `eval`/`navigate`/`ensure` return "Timeout waiting for browser
  response" or `{value:undefined,fallback:cdp}` even though `/health` shows
  connected clients and `/agent/tabs` lists fresh tabs. Only the active/foreground
  tab responds; background tabs time out.
- **Root cause:** content actions (eval/navigate/click/type) route to the
  **Tampermonkey userscript** path (`/agent/commands` poll). Chrome throttles the
  userscript's page timers on background/unfocused tabs to ~1/min, so those
  commands sit unpolled and time out. Tab-state still looks fresh because any
  active tab (e.g. auth-callback tabs) keeps polling. The MV3 extension polls via
  `chrome.alarms` (not throttled) and acts on any tab via `chrome.debugger`.
- **Fix (server-side only, no extension/userscript update):** `translateToExtension`
  in `lib/core.js` maps a content command to the extension's CDP equivalent
  (`cdpEval`/`cdpClick`/`cdpType`), resolving the target tab **by URL** (which the
  relay already stores per tab). `/agent/interactive` diverts to the extension
  when the target userscript tab is stale (>`TAB_STALE_MS`=10s); fresh foreground
  tabs keep the userscript path (no debugger banner). Verified live: eval returns
  real DOM and navigate executes on tabs that previously timed out. Commit `55d1a74`.
- **Deploy:** scp `agent-server.js` + `lib/core.js` to the VM relay
  (`~/browser-agent`) + `pm2 restart browser-agent`; WSL relay restarted too. The
  VM copy is an scp target (deploy.sh), not kept in git-sync.

## 2026-06-24 — VM as a browser-agent client
- The relay runs on the VM but had no CLI client there. Added `vm-browser-cli.sh` (committed) + installed on VM as `~/bin/browser-cli` (symlink to the repo copy). It sources `~/browser-agent/.env`, sets `BROWSER_AGENT_URL=http://127.0.0.1:3102` (loopback), and execs `browser-cli.sh`. `BROWSER_AGENT_PROFILE=alt` swaps to `BROWSER_AGENT_KEY_ALT` (Brave/alt profile).
- Purpose: VM processes can now drive the home **residential** browser, bypassing datacenter-IP bot blocks. Verified: VM `curl` to eBay = HTTP 403, but via browser-agent it pulled 240 Oura Ring 4 listings (used `cdp-eval`; content-script eval is CSP-blocked on eBay).
- Discord note: neither automation browser is logged into Discord (both bounce to `/login`); read messages via the bot token + `discord.com/api/v10` instead.
- Full closeout: `privateContext/deliverables/closeouts/2026-06-24-vm-browser-agent-client.md`
- State: working.

## 2026-05-28 — multi-key auth for alt-account profile (prior)

## Current State
- **Extension v2.5.0** — MV3 content script + background service worker
- Server running via PM2 (`browser-agent`) on port 3102, **accepts primary + alt API key** (BROWSER_AGENT_KEY + BROWSER_AGENT_KEY_ALT)
- 30+ commands: navigate, click, type, setInput, fill, upload, clickAny, wait-for, assert, cdpEval, extractVirtual, network-capture, etc.
- Background service worker handles tab management, CDP trusted input, screenshots, JS eval (bypasses CSP)
- Content script uses `fetch()` instead of `GM_xmlhttpRequest`, `chrome.storage.local` instead of `GM_setValue`
- **Branch note:** `claude/learnings-510` has one CLAUDE.md doc commit ahead of master; merge pending

## 2026-05-28 — Multi-Key Auth
- `createApp({ apiKey })` and `({ agentSecret })` now accept string OR string[]; string form preserved for backwards compat with existing tests.
- Bootstrap reads `BROWSER_AGENT_KEY` + optional `BROWSER_AGENT_KEY_ALT` from env. Same pattern for the agent secret pair.
- Use case: alt Google account (`nickthepezant@gmail.com`) runs the extension in a separate Chrome profile and authenticates with its own key. Keeps that profile's Google session warm and gives an independent revocation handle.
- **Known limitation:** Relay does NOT partition `agentTabs` by which key heartbeated. Both keys see the union of tabs on `GET /agent/tabs`. Address only if a use case appears.
- Full closeout: `privateContext/deliverables/closeouts/2026-05-28-browser-agent-multi-key.md`

## v2.4.0-v2.5.0 Changes (2026-05-07)
- **`extractVirtual`**: 10-approach extraction for virtually-rendered SPAs (IntersectionObserver-based lazy DOM). Progressive scroll + aria-label extraction is the winning approach for Amex Travel. 55s safety timer guarantees debugger cleanup.
- **`network-capture`**: Capture XHR responses via CDP Network domain. `--list` mode for URL discovery.
- **`cdpEval --focus --scroll`**: Focus tab + scroll before eval. Manual debugger lifecycle with safety timer.
- **`focusTab` fix**: Changed `.startsWith()` to `.includes()` for bare domain URL matching.
- **Debugger safety pattern**: All CDP operations use `let detached = false; const cleanup = ...` with safety timer to prevent "Another debugger is already attached" errors when server timeout fires before extension completes.
- **rAF removed from scroll**: `requestAnimationFrame` promises hang on unfocused tabs; replaced with `setTimeout` delays.
- **Routing**: `cdpNetworkCapture` and `extractVirtual` added to `EXT_TAB_ACTIONS` in `lib/core.js`.

## v2.2.0 Changes (2026-04-25)
- **`cdpEval`**: Run arbitrary JS via CDP Runtime.evaluate, bypasses CSP on FB/Google Photos/Deepgram. CLI supports `--await` flag for promise-returning expressions. (Bugfix `0eec567`: fixed double-shift in arg parsing that broke all cdp-eval calls.)
- **`cdpKeys`**: Send special keystrokes (ArrowDown, Enter, Tab, Escape) via CDP Input.dispatchKeyEvent
- **`mouseMoved` in CDP click**: React event delegation requires mouseMoved before mousePressed; without it, dialog items don't respond
- **Fixed double char insertion**: CDP `keyDown` with `text` + `char` event both inserted; removed `text` from `keyDown`
- **Default typing delay**: Reduced from 50ms to 30ms per character

## v2.0.0 Changes (2026-04-24)
- Eliminated Tampermonkey dependency: content script replaces userscript
- `fetch()` for networking, `chrome.storage.local` for persistent storage
- `keepalive: true` for pre-unload result posts
- Fixed deploy.sh: now copies `lib/core.js` to VM

## Key Issues Learned
- **CSP blocks eval** on FB, Google Photos, Deepgram — use `cdpEval` instead (bypasses CSP via debugger)
- **CDP keyDown text field** causes double character insertion — only set `text` on `char` event type
- **React mouseMoved requirement**: CDP click must send `mouseMoved` before `mousePressed` for React handlers to fire
- **CDP Input.dispatchMouseEvent does NOT work for FB comboboxes**: Must use `element.click()` via `cdpEval` instead. CDP mouse events fire but FB's React event delegation ignores them on combobox elements.
- **FB Category is a dialog picker**, not autocomplete. Open via `cdpEval` `combo.click()` -> dialog with `[role="button"]` items -> `button.click()`. NOT `[role="option"]`.
- **FB Condition IS a standard dropdown** with `[role="option"]` elements. Title case: "Used - Good" (not lowercase).
- **Content script timer throttling**: Chrome throttles `setTimeout` in unfocused tabs. CDP commands (routed through background worker) bypass this.
- **Content script isolated world:** DOM access works, page JS globals don't.
- **setInput** bypasses React onChange — use `type` or `cdp-type` for React inputs.
- **Large file uploads:** base64 must go to temp file, not CLI argument (ARG_MAX limit)
- **VM deploy:** Directory is NOT a git repo — deploy via SCP, not git pull.
- **Always bump manifest version** on extension changes for easy visual verification after reload.

## Environment Notes
- **Deploy target:** See `deploy.sh` and `BROWSER_AGENT_VM` env var
- **Process manager:** PM2 (`browser-agent`)
- **Port:** Configured via `BROWSER_AGENT_PORT` env var (see CLAUDE.md)
- **Browser:** Chrome (extension loaded from Windows path, not WSL)
- **Extension path:** Load `extension/` as unpacked in Chrome
- **Extension reload:** `chrome://extensions` > Browser Agent > reload icon
- **After WSL changes:** Must `git push` from WSL, then `git pull` in Windows repo


## 2026-05-05 — v2.2.1 CDP Eval Fix
- Fixed "Cannot access a chrome:// URL" error in CDP eval commands
- `resolveTabId()` fallback now filters to HTTP/HTTPS tabs only (was falling back to chrome:// tabs which can't be debugged)
- `withDebugger()` validates tab URL before attaching debugger, returns clear error for internal pages
- Verified working: CDP eval successfully reads hotel site content (Hilton), types into search fields, extracts structured pricing data
- Windows extension path confirmed: `/mnt/c/Users/npeza/Documents/repos/browser-agent/extension/`
- After WSL changes, must `git pull` in Windows repo (or `git reset --hard origin/master` if diverged) then reload extension

Full session closeout: privateContext/deliverables/closeouts/2026-05-05-browser-agent-cdp-fix-hotel-research.md

## 2026-05-05 — Public Release
- Repo flipped from private to public
- Scrubbed all hardcoded SSH usernames, VM paths, Windows paths, alumni email from working tree and git history
- Deploy scripts now use `$BROWSER_AGENT_VM` env var instead of hardcoded connection strings
- `agent-server.js` cowork paths default to `$HOME/` instead of hardcoded user dir
- Git history rewritten via `git filter-repo --replace-text` (all 78 commits preserved, hashes changed)
- Open: add `export BROWSER_AGENT_VM=...` to `.bashrc`; consider adding a README.md

Full session closeout: privateContext/deliverables/closeouts/2026-05-05-browser-agent-public-release.md

## 2026-05-07 — v2.4.0-v2.5.0 Virtual Extraction + Amex FHR Research
- Built extractVirtual command (10 approaches) for Amex Travel's virtually-rendered hotel cards
- Fixed debugger lifecycle: safety timers prevent leak when server timeout fires first
- Fixed focusTab URL matching for bare domains
- Removed rAF from scroll loop (hangs on unfocused tabs)
- Added network-capture command with --list mode
- Successfully extracted pricing from 6 different Amex Travel searches (Lisbon, Granada, Seville, Madrid x2, Mexico City)
- SPA form manipulation pattern: edit button -> clear destination -> type -> autocomplete -> dates -> Update
- Amex Travel requires prebooking OAuth redirect flow; direct URL navigation returns 0 results

Full session closeout: privateContext/deliverables/closeouts/2026-05-07-amex-fhr-research-browser-agent-extraction.md

## Active Branch
`master` (with `claude/learnings-510` one commit ahead for CLAUDE.md docs)

## 2026-05-28 — Per-API-Key Routing
- Patched `agent-server.js` so heartbeats and command queues are split per-key (`extLastHeartbeatByKey`, `extCommandsByKey`). Before: dual-key support was auth-only — whichever extension heartbeated last received every command, regardless of which key the CLI caller used.
- New helper `getKeyIdx(req)` returns the matching key index (or -1). `checkAuth(req)` now wraps that for callers that only need bool.
- `/ext/{heartbeat,commands,status}` and `/agent/interactive`'s extension-routing branch all scope to the caller's key index.
- Backward-compat shims on `state.extCommands` / `state.extLastHeartbeat` alias key idx 0 so existing tests and consumers keep working.
- Two new tests under `describe("Per-key extension routing")` verify isolation. 182 → 184 pass.
- Verified live: main key (`a9a46…`) sees Chrome tabs only (Garmin portal, foodie); alt key (`74ab3…`) sees Brave tabs only (claude.ai, alt-account OAuth callbacks). Confirmed Brave specifically by opening `brave://version/` (Chrome rejects that scheme).
- Deployed via `./deploy.sh` to VM. Note: `deploy.sh` scp's local `.env` to the VM; if `BROWSER_AGENT_KEY_ALT` is missing locally it'll get clobbered on the VM. Added to local `.env` to prevent recurrence.

Full session closeout: privateContext/deliverables/closeouts/2026-05-28-oauth-refresh-automation.md

## 2026-05-29 — v2.7.0 Screenshot Expansion
- Two capture paths now: `captureTab` (fast, `chrome.tabs.captureVisibleTab`, viewport+png/jpeg) and `captureAdvanced` (CDP `Page.captureScreenshot`, full-page via `captureBeyondViewport`, element clipping via `Runtime.evaluate` + `scrollIntoView`, webp support).
- CLI `screenshot` accepts `--full`, `--selector`, `--format`, `--quality`, `--blob`. Auto-routes to the CDP path when any of those (or webp) are requested.
- New `browser-cli see "<question>" [url] [flags]` — captures then invokes `claude -p --allowedTools Read`. Matches `fb-marketplace-poster/lib/analyze.js` pattern.
- `captureAdvanced` added to `EXT_TAB_ACTIONS` allowlist in `lib/core.js`.
- 185/185 tests passing. Deployed via `deploy.sh`.
- **Open: extension reload to v2.7.0 in Chrome required before `captureAdvanced` calls succeed end-to-end.**
- **Open: `BROWSER_AGENT_KEY` was echoed into the session transcript; rotate before next sensitive flow.** (Key prefix was already visible in this file's prior commits.)

Full session closeout: privateContext/deliverables/closeouts/2026-05-29-browser-agent-screenshot-expansion.md

## 2026-06-29 — Window Resizer TM Script Install Page
- Added Window Resizer userscript entry to `tm-scripts/index.html` and source mapping in `sync-tm-scripts.sh`
- No server code changes; only static install page files
- Deployed via `sync-tm-scripts.sh` (install page) + `deploy.sh` (full redeploy, PM2 restarted and saved)
- State: deployed, online

## Active Branch
`master`
