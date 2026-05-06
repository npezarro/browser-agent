# progress.md — browser-agent

## 2026-05-05 — v2.2.1 CDP Eval Fix
- b173dd7 — Fix CDP eval "Cannot access chrome:// URL" error
  - resolveTabId() fallback filters to HTTP/HTTPS tabs only
  - withDebugger() validates tab URL before attach, clear error for internal pages
  - Manifest version bumped 2.2.0 -> 2.2.1
  - Tested: CDP eval on Hilton hotel sites, typed into search fields, extracted room pricing

## 2026-05-05 — Public Release
- 467ad49 — Scrub hardcoded infrastructure details for public release
  - Parameterized deploy.sh, sync-tm-scripts.sh, browser-cli.sh with env vars
  - agent-server.js cowork paths use $HOME instead of hardcoded user dir
  - Cleaned context.md of Windows paths and privateContext references
  - Git history rewritten via filter-repo (generatedByTermius -> deployuser, email normalized)
  - Repo visibility flipped to public

## 2026-04-10 — v1.8.0 Performance Fixes
- 8645c0a — Fix memory leaks and reduce DOM polling to prevent Edge hangs
  - Merged two polling loops into single 3s tick
  - Cached getPageState() with 2s TTL
  - Cleared command timeout timers on completion
  - Replaced console buffer with O(1) ring buffer
  - Added server-side periodic cleanup for resultWaiters, command queues, dead tabs

## 2026-04-09 — v1.7.0 File Upload + clickAny
- ea920d8 — Document clickAny, CSP limits, React gotchas in CLAUDE.md
- 87852ac — Add clickAny command + per-command timeout (v1.7.0)
- 49aa6c1 — Fix textarea Illegal invocation + upload arg-too-long (v1.6.1)
