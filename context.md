# context.md — browser-agent

Last Updated: 2026-04-24 — v2.0.0: migrated from Tampermonkey to extension content script

## Current State
- **Extension v2.0.0** — all page automation via MV3 content script (replaces TM userscript)
- Server running via PM2 (`browser-agent`) on port 3102
- 30+ commands: navigate, click, type, setInput, fill, upload, clickAny, wait-for, assert, etc.
- Background service worker handles tab management, CDP trusted input, screenshots
- Content script uses `fetch()` instead of `GM_xmlhttpRequest`, `chrome.storage.local` instead of `GM_setValue`

## v2.0.0 Changes (2026-04-24)
- **Eliminated Tampermonkey dependency:** Content script (`extension/content.js`) replaces `browser-agent.user.js`
- **Reliable injection:** Chrome manages content script lifecycle natively, no third-party extension needed
- **`fetch()` for networking:** Content scripts can make cross-origin requests via `host_permissions`
- **`keepalive: true`** for pre-unload result posts (navigate, back, reload, closeTab)
- **`chrome.storage.local`** replaces `GM_setValue`/`GM_getValue` for persistent storage
- **`chrome.notifications`** via background message replaces `GM_notification`
- **Fixed deploy.sh:** Now copies `lib/core.js` to VM (missing since April 18 crash)
- **Console capture limitation:** Only captures content script's own console calls, not page JS console. Acceptable regression for diagnostics.

## Key Issues Learned
- **CSP blocks eval** on FB, Google Photos, and many modern sites — `new Function()` fails in MAIN world
- **Content script isolated world:** DOM access works, page JS globals don't. `el._valueTracker` (React) IS accessible since it's a DOM node property.
- **setInput** uses native value setters which bypass React onChange — this breaks autocomplete fields. Use `type` for searchable inputs.
- **Large file uploads:** base64 must go to temp file, not CLI argument (ARG_MAX limit)
- **VM deploy:** Directory is NOT a git repo — deploy via SCP, not git pull.

## Environment Notes
- **Deploy target:** VM (pezant.ca)
- **Process manager:** PM2 (`browser-agent`)
- **Port:** 3102 (behind Apache at /api/browser-agent/)
- **Browser:** Chrome (extension loaded as unpacked from `extension/` directory)
- **Extension reload:** `chrome://extensions` > Browser Agent > reload icon

## Active Branch
`master`
