# progress.md — browser-agent

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
