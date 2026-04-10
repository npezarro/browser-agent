# context.md — browser-agent

Last Updated: 2026-04-10 — v1.8.0: performance fixes for Edge hanging

## Current State
- **v1.8.0** deployed to VM and pezant.ca/browser-agent.user.js
- Server running via PM2 (`browser-agent`) on port 3102
- 40+ commands: navigate, click, type, setInput, fill, upload, clickAny, wait-for, assert, etc.
- File upload: blob relay (CLI → server → TM script) with 10MB limit, 5-min TTL
- `clickAny`: searches ALL elements for text (not just buttons) — essential for React custom dropdowns
- Per-command 20s timeout prevents queue poisoning from hung commands

## v1.8.0 Changes (2026-04-10)
- **Merged polling loops:** Two separate timers (2s SPA watcher + 3s command poller) → single 3s `tick()`. Cuts DOM polling ~40%.
- **Cached getPageState():** 2s TTL cache prevents redundant DOM traversal on heartbeats. Explicit `getState` commands still get fresh data.
- **Command timeout cleanup:** `Promise.race` timers now cleared on completion, preventing timer accumulation.
- **Circular console buffer:** O(1) ring buffer replaces O(n) `.shift()` on every log entry.
- **Server cleanup routines:** 30s interval prunes dead tabs, expired resultWaiters (10min TTL), and orphaned command queues.

## Key Issues Learned
- **CSP blocks eval** on FB, Google Photos, and many modern sites — `new Function()` fails
- **setInput** uses native value setters which bypass React onChange — this breaks autocomplete fields. Use `type` for searchable inputs.
- **Textarea setInput** must use `HTMLTextAreaElement.prototype.value.set`, not `HTMLInputElement` — causes "Illegal invocation"
- **Queue poisoning:** if a command hangs (React re-render loop), all subsequent commands timeout. Fixed with per-command timeout in v1.7.0.
- **Large file uploads:** base64 must go to temp file, not CLI argument (ARG_MAX limit)
- **VM deploy:** Directory is NOT a git repo — deploy via SCP, not git pull. TM script at `/var/www/html/` requires sudo.

## Open Work
- Monitor Edge stability after v1.8.0 perf fixes
- If still hanging: consider `requestIdleCallback` wrapper, `MutationObserver` for SPA detection, or increasing POLL_MS to 5s
- No scroll command exposed in CLI (action exists in TM script)
- eval alternative needed for CSP-restricted sites (consider GM_addElement with page nonce)

## Environment Notes
- **Deploy target:** VM (pezant.ca)
- **SSH:** generatedByTermius@pezant.ca, key: ~/.ssh/vm_key
- **Process manager:** PM2 (`browser-agent`)
- **Port:** 3102 (behind Apache at /api/browser-agent/)
- **TM script:** /var/www/html/browser-agent.user.js (install via pezant.ca/install.html)

## Active Branch
`master`

Full session closeout: privateContext/deliverables/closeouts/2026-04-10-browser-agent-perf-fixes.md
