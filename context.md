# context.md — browser-agent

Last Updated: 2026-04-25 — v2.2.0: CDP enhancements for CSP-restricted sites

## Current State
- **Extension v2.2.0** — MV3 content script + background service worker
- Server running via PM2 (`browser-agent`) on port 3102
- 30+ commands: navigate, click, type, setInput, fill, upload, clickAny, wait-for, assert, etc.
- Background service worker handles tab management, CDP trusted input, screenshots, JS eval (bypasses CSP)
- Content script uses `fetch()` instead of `GM_xmlhttpRequest`, `chrome.storage.local` instead of `GM_setValue`

## v2.2.0 Changes (2026-04-25)
- **`cdpEval`**: Run arbitrary JS via CDP Runtime.evaluate, bypasses CSP on FB/Google Photos/Deepgram
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
- **FB Category is a dialog picker**, not autocomplete. Click combobox -> dialog with `[role="button"]` items -> click the button. NOT `[role="option"]`.
- **FB Condition IS a standard dropdown** with `[role="option"]` elements
- **Content script timer throttling**: Chrome throttles `setTimeout` in unfocused tabs. CDP commands (routed through background worker) bypass this.
- **Content script isolated world:** DOM access works, page JS globals don't.
- **setInput** bypasses React onChange — use `type` or `cdp-type` for React inputs.
- **Large file uploads:** base64 must go to temp file, not CLI argument (ARG_MAX limit)
- **VM deploy:** Directory is NOT a git repo — deploy via SCP, not git pull.
- **Always bump manifest version** on extension changes for easy visual verification after reload.

## Environment Notes
- **Deploy target:** VM (pezant.ca)
- **Process manager:** PM2 (`browser-agent`)
- **Port:** 3102 (behind Apache at /api/browser-agent/)
- **Browser:** Chrome (extension loaded from Windows path, not WSL)
- **Extension path:** `/path/to/browser-agent/extension/`
- **Extension reload:** `chrome://extensions` > Browser Agent > reload icon
- **After WSL changes:** Must `git push` from WSL, then `git pull` in Windows repo

Full session closeout: privateContext/deliverables/closeouts/2026-04-25-browser-agent-cdp-enhancements.md

## Active Branch
`master`
