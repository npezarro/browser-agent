# context.md — browser-agent

Last Updated: 2026-05-28 — multi-key auth for alt-account profile

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
