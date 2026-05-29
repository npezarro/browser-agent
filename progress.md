# progress.md — browser-agent

## 2026-05-28 — Multi-Key Auth
- 4226629 — Accept multiple BROWSER_AGENT_KEY values for alt-account profile
  - apiKey + agentSecret in createApp now accept string OR string[]
  - Bootstrap reads BROWSER_AGENT_KEY + BROWSER_AGENT_KEY_ALT, filters and passes as array
  - checkAuth: API_KEYS.some((k) => auth === `Bearer ${k}`)
  - checkAgentAuth: AGENT_SECRETS.includes(provided), open if list empty
  - VM .env updated with alt key; service restarted, `pm2 save` run
  - Verified: primary -> 200, alt -> 200, bad -> 401 on GET /agent/tabs
  - Backwards compatible: existing string-form `apiKey: "..."` test calls untouched

## 2026-05-07 — v2.4.0-v2.5.0 Virtual Extraction
- ff2d216 — v2.4.0: Fix focus URL matching, add --focus/--scroll to cdp-eval, add network-capture
  - cmdFocusTab: .startsWith() -> .includes() for bare domain URLs
  - cdpEval: --focus and --scroll flags with manual debugger lifecycle
  - network-capture: CDP Network domain capture with --list mode
- 1621772 — v2.4.1: Fix debugger leak on timeout in focus+scroll cdp-eval
  - Replaced withDebugger wrapper with manual lifecycle + 25s safety timer
- 06166ee — v2.4.2: Remove rAF from scroll (hangs on unfocused tabs)
- a3b817c — v2.4.3: Add --list mode to network-capture for URL discovery
- 63b6cc6 — v2.5.0: Add extractVirtual with 10 extraction approaches
  - Progressive scroll + aria-label extraction works for Amex Travel
  - 55s safety timer for guaranteed debugger cleanup
  - Manifest bumped to 2.5.0
- bb7aa40 — doc: add v2.4.0-v2.5.0 features to CLAUDE.md (on claude/learnings-510)

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

## 2026-05-28 — v2.6.0 Per-Key Routing
- 895ec78 — Route extension commands per API key so each browser only sees its own queue
