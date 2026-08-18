# progress.md — browser-agent

## 2026-08-18 — ensure proves tab ownership; btabs added
- `a9212c6` / `5541769`: `/agent/tabs` is one un-keyed registry (union of both profiles) while commands
  route per key, so a URL match never proved ownership. `ensure` now probes with a keyed `ping` and opens
  its own tab when the match belongs to another profile; content-script-blocked origins are returned
  tagged `ownership: unverified`. This bug let the alt keepalive certify the MAIN profile for six weeks.
- `839f016`: new `btabs` verb (chrome.tabs.query via the service worker). ext 2.11.0's `exclude_matches`
  means a tab on an excluded origin can never enter the registry, which had silently made the OAuth
  account-chooser recovery unreachable code since 2026-08-02.
- Measured: an OAuth popup is a separate WINDOW; `focusTab` does not raise it, so it stays
  `visibilityState: hidden` and CDP Input events are never delivered. Twelve cdp-clicks reported
  `{"clicked": true}` with no page change; one `el.click()` advanced it.


## 2026-08-03 (phase 2) — humanized input tested against real bot protection: null result
- Closed out phase 1's open item ("unproven against a site that scores behaviour") by actually
  running it. It half-closed: the test ran, the instrument had no resolution.
- **Control passed:** `bot.sannysoft.com` returned zero failed checks (WebDriver missing/passed,
  WebDriver Advanced passed, real ANGLE/NVIDIA renderer, plugins 5). Independent confirmation
  that the passive surfaces are clean, which is the v2.12.0 thesis.
- **Treatment saturated:** reCAPTCHA v3 returned **0.9 in all four conditions** (no interaction,
  `--fast`, humanized, `--fast` again; interleaved to control for session drift). 0.9 is its
  practical ceiling, so there is no headroom to show improvement and `--fast` cost nothing.
  Reading: wrong measuring device. Humanized input is still UNPROVEN behaviourally.
- **Correction to a phase 1 claim:** "+1.8s per humanized click" was wrong. Both methods are
  ~2s on a visible tab; the original number compared a composited `--fast` click against an
  occluded humanized one, so it measured visibility rather than method.
- **New cost fact:** `cdp-type` is 3 CDP dispatches per character regardless of method, so a
  25-char string is 75 round trips. `keystrokeDelays` bounds the sleeps, not the RPC count.
  Prefer `form-fill` for long inputs.
- No code changed this phase. Docs only.
- Full closeout: `privateContext/deliverables/closeouts/2026-08-03-bot-protection-ab-test-and-credential-leak.md`

## 2026-08-03 — v2.12.0 humanized input; the "hardware simulation" ask resolved as a no-op
- Asked to make hardware simulation convincing enough to avoid blocks. Investigated and
  concluded **no hardware simulation should be built**: this stack drives a real Chrome on
  real hardware from a residential IP, so the passive surfaces are genuine and any patch
  would manufacture the inconsistency that mitigation actually scores.
- Shipped the change that the evidence supported instead: humanized *input* kinematics
  (`extension/human-input.js`) and a read-only `fingerprint-audit` that reports
  incoherence rather than hiding it.
- Found and fixed a real correctness bug along the way: `cdp-type` emitted DOM `code`
  values no keyboard produces (`"Key1"`, `"Key "`, `"Key."`) and the wrong `keyCode` for
  lowercase letters. Any page keying off `event.code` had been receiving impossible events
  since CDP typing was introduced.
- 23 new unit tests; 240 tests pass repo-wide; lint clean (the 3 remaining `no-empty`
  errors pre-date this change, verified by linting the base commit).
- `c349d42` merge (2.12.0), `caefe16` fix, `e48b2ef` merge (2.12.1). 241 tests pass.

### Live verification caught a regression that review did not (`caefe16`, ext 2.12.1)
- Deployed 2.12.0, then exercised it against a real page. `cdp-click` returned
  **"Timeout waiting for extension response"** even though the click itself had landed
  correctly (inside the button, off-centroid, `holdMs:61`, `isTrusted:true`).
- Cause: each `chrome.debugger` Input dispatch costs ~1s+ here — a bare `--fast` click
  (3 CDP calls) takes ~6.7s end to end — so a 26-waypoint path blew the relay's 30s command
  timeout. `withDebugger` then held the debugger until its 55s safety timer, so the NEXT
  command failed "Another debugger is already attached".
- Fixed by capping waypoints to `clamp(dist/60, 5, 14)`, sleeping only the remainder of the
  intended gap after the RPC's own cost, and adding a 6s `moveBudgetMs` deadline that reports
  `pathTruncated: true` instead of truncating silently.
- Re-verified after the fix: visible tab, 2.3s, 5-point path, no truncation, correct landing.
- Deploy verified all three tiers on `2.12.1`: WSL, VM relay (health 200), Windows checkout,
  and `ext-status` reporting `stale: false`.
- Two traps recorded in `context.md`: hidden tabs silently swallow CDP input (and slow each
  dispatch to seconds), and a relay restart wipes its heartbeat table so an immediate
  `ext-reload` fails "No browser tabs connected".

## 2026-07-30 — `see` wrote an unreadable `.img` extension (fix rode along in `793bfad`)
- `browser-cli see` captured to `/tmp/see-<ts>-<pid>.img`. The vision step hands that path
  to `claude -p --allowedTools Read`, and `.img` is not a recognized image extension, so
  Read returned raw JFIF bytes as text. **Every `see` invocation had been failing**, not
  just in degraded conditions.
- Fixed by deriving the extension from the format (`browser-cli.sh:365-374`):
  `jpeg|jpg -> .jpg`, everything else uses the format verbatim. Default (unset) is jpeg,
  so the common path is now `.jpg`.
- Proven, not assumed: identical JPEG bytes written twice, once `.jpg` and once `.img`.
  The `.jpg` copy rendered as an image; the `.img` copy dumped ~54k tokens of raw JFIF.
  Also checked the derivation for unset/jpeg/jpg/png/webp, and `bash -n` is clean.
- **Provenance note:** this edit was uncommitted in the working tree when a concurrent
  session committed everything as `793bfad` ("Add remote extension reload..."). The fix is
  live on `origin/master` but that message does not mention it. Search by content, not message.

### Operational: when the window isn't composited, use `cdp-*` and stop diagnosing
Complements the `captureTab` "image readback failed" note below. When Chrome is
minimized/occluded, the failure is not limited to captures — the **content script is
throttled too**, so its poll loop stalls:
- `tabs` still lists the tab with fresh-looking heartbeats (they batch through), so the
  tab looks healthy and the situation reads as "browser is gone". It isn't.
- `ping`, `state`, `text`, `eval`, `click` all return `Timeout waiting for browser response`
  on every retry.
- `ensure`, `focus`, `ext-status` keep working (service-worker side).
- `cdp-eval` / `cdp-click` keep working throughout. A full multi-step form (open modal, set
  a React textarea via the native value setter, submit, reload, verify) was driven entirely
  with `cdp-*` against a backgrounded window on 2026-07-30.
- Gotcha: `cdp-eval` returns its result in `"value"` alongside `targetUrl`/`resolvedBy`.
  `| tail -3` cuts the value off and makes a successful call look empty; grep `'"value"'`.

Full session closeout: privateContext/deliverables/closeouts/2026-07-30-brevo-mcp-setup-and-see-bug-fix.md

## 2026-07-30 — screenshot: CDP fallback when captureVisibleTab fails (ext v2.10.2)
- `chrome.tabs.captureVisibleTab` needs the window composited; when Chrome is minimized,
  occluded, or the display is off it either throws "image readback failed" or hangs. Both
  observed here, which made plain `browser-cli screenshot` unusable while `--full` /
  `--selector` (CDP path) worked.
- Extracted `captureViaCdp(cmd, tgt)` taking an **already-resolved** target;
  `cmdCaptureAdvanced` and the fallback both call it. Passing the resolved target rather
  than re-resolving is deliberate — a re-resolve in the fallback could land on a different
  tab than the primary attempt and would reintroduce the wrong-tab class removed in
  2.9.0-2.10.1.
- `cmdCaptureTab` races captureVisibleTab against an 8s timeout (a try/catch alone cannot
  catch the hang), then falls back. Results carry `method: "captureVisibleTab" | "cdp-fallback"`
  plus `primaryError`; the switch is surfaced, not hidden. If both fail the error names both.
- Verified live end-to-end: `{"ok":true,"method":"cdp-fallback","targetUrl":"https://example.com/",
  "resolvedBy":"registry","primaryError":"Failed to capture tab: image readback failed","bytes":14506}`,
  and `browser-cli screenshot out.png <tabid>` wrote a valid 1280x569 PNG whose **content was the
  named tab**, not the focused one (confirmed by viewing the image, not just the byte count).
- Deployed via the new remote route: relay pulled + restarted, Windows checkout pulled,
  `ext-reload` 2.10.1 -> 2.10.2, exit 0, no chrome://extensions visit.

## 2026-07-30 — captureTab fail-closed + verified remote reload (`ext v2.10.1`)
- Found a THIRD instance of the wrong-tab bug, missed by the first pass: `cmdCaptureTab`
  (the plain `screenshot` path) kept its own ad-hoc resolution. Two defects: an
  unresolvable target fell through to the active tab, and when `chromeTabId` was supplied
  `windowId` stayed undefined, so the focus block was skipped and
  `captureVisibleTab(undefined)` captured the FOCUSED tab while the result still reported
  the requested tab id. It also ignored the internal->chrome registry entirely.
- Now routes through `resolveTarget`, always resolves `windowId` and foregrounds the
  target, and echoes `targetUrl` + `resolvedBy`.
- **Used as the end-to-end test of the `ext-reload` route, both paths verified:**
  - guard: reload WITHOUT pulling the Windows checkout → came back 2.10.0, `stale:true`,
    clear error, exit 1.
  - happy path: pull Windows → `ext-reload` → 2.10.0 → 2.10.1, `stale:false`, exit 0,
    no chrome://extensions visit.
  - proof the CODE reloaded (not just the manifest): bogus `chromeTabId` now returns
    "Refusing to fall back to the active tab" with no `dataUrl`, which only exists in 2.10.1.
- **Open, pre-existing (not a regression):** `chrome.tabs.captureVisibleTab` returns
  "image readback failed" / times out in this environment (fires when the Chrome window
  isn't composited — minimized/occluded/display off). It failed the same way on pre-2.10.1
  code. The CDP path (`captureAdvanced`, used by `--full`/`--selector`) works fine and
  returned a correct 14.5KB capture of the named tab. Since plain `screenshot` defaults to
  `captureTab`, it is effectively broken here; candidate fix is to fall back to the CDP
  path when `captureVisibleTab` errors.

## 2026-07-30 — Remote extension reload, `ext-reload` (`793bfad`, ext v2.10.0)
- Chrome never auto-reloads unpacked extensions, so every extension deploy ended with
  "ask the user to open chrome://extensions". Added a remote route.
- `reloadExtension` action calls `chrome.runtime.reload()` (no permissions, callable from
  an MV3 SW; for unpacked extensions it is treated as an update and re-reads files from
  disk). Deferred one tick so `executeCommand` POSTs the result before the worker dies.
- Extension reports its running version on every heartbeat; `/ext/status` returns
  `version` / `expectedVersion` (read from the checkout's manifest) / `stale`.
  `stale` is **tri-state** — `null` = running code too old to report a version, which is
  not the same as up to date. `ext-reload` treats anything but explicit `false` as failure.
- Limits: cannot bootstrap itself (must exist in the RUNNING version, so one manual reload
  is still needed once), and cannot revive a dead service worker.
- Rejected self-hosted CRX auto-update: Chrome now requires an enterprise `ExtensionSettings`
  force_installed policy for non-Web-Store extensions; changes the extension ID and adds a
  signing key + update manifest to maintain.
- 207 tests pass, lint at baseline. Relay deployed to VM (health 200), Windows copy at 2.10.0.

## 2026-07-30 — Fail-closed tab targeting for CDP commands (`d43258f`, ext v2.9.0)
- Security fix: `cdp-eval` with an explicit tab id returned a *focused* unrelated tab's
  content (live repro leaked `app.brevo.com/security/authorised_ips`). Any `cdp-*` could
  read/click a credential page the caller never named.
- Three compounding causes: (1) `browser-cli.sh` sent `interactive ""` for every CDP
  command so no `tabId` reached the relay — the v2.8.0 server fix was dead code here;
  (2) the target positional was parsed as a URL substring, so a tab id matched nothing;
  (3) `resolveTabId` silently fell back to the active tab and `cdpEval` echoed no target.
- Fix: new `extension/tab-target.js` (`resolveTargetCore`, pure + unit-tested) fails closed
  on any unresolvable *named* target; relay sends `expectUrl` and the extension cross-checks
  it by origin at resolution and pre-attach (relay tab ids live in sessionStorage and survive
  navigation); `split_target()` in the CLI routes tab ids properly; all CDP results echo
  `targetUrl` + `resolvedBy`.
- 13 new tests (205 total pass), lint clean vs baseline. Relay deployed to VM (`pm2 restart
  browser-agent`, health 200); Windows extension copy synced to 2.9.0.
- Verified live: old CLI + tab id → `app.brevo.com/security/authorised_ips` (wrong tab);
  new CLI + same tab id → `https://example.com/` (correct tab).

## 2026-06-30 — Fix background-tab command timeouts (`55d1a74`, `d684356`)
- Root cause: content actions (eval/navigate/click/type) route to the content-script
  poll path, which Chrome throttles on background tabs (~1/min) → commands time out.
- Fix (relay-only, no extension reload): `translateToExtension` in `lib/core.js` maps
  content cmds → `cdpEval`/`cdpClick`/`cdpType` (resolved by tab URL); `/agent/interactive`
  diverts to the extension when the target tab is stale (>`TAB_STALE_MS`=10s). Fresh
  foreground tabs keep the content-script path.
- 7 new tests (192 total pass). Deployed: scp `agent-server.js`+`lib/core.js` to VM
  `~/browser-agent` + `pm2 restart browser-agent`; WSL relay restarted. Verified live:
  eval returned real DOM and navigate executed on previously-timing-out tabs.
- Full closeout: `privateContext/deliverables/closeouts/2026-06-30-browser-agent-background-tab-throttle-fix.md`

## 2026-06-24 — VM-side CLI client
- Added `vm-browser-cli.sh` — VM wrapper that sources `~/browser-agent/.env`, points at the loopback relay (`127.0.0.1:3102`), and execs `browser-cli.sh`. `BROWSER_AGENT_PROFILE=alt` → Brave/alt profile.
- Deployed on VM: `~/bin/browser-cli` symlink + `~/bin` added to PATH in `.bashrc`.
- Verified residential-IP bypass: VM direct `curl` to eBay = HTTP 403; via browser-agent pulled 240 Oura Ring 4 listings and tallied colour/size (used `cdp-eval` for eBay CSP).
- Docs: CLAUDE.md + context.md sections added; KB `integrations/browser-agent.md` updated (b6bb34c).
- Deploy-hygiene: VM `~/browser-agent` was ~9 commits behind master with stale-base uncommitted edits (already upstream). Fast-forwarded to master (running relay already == master, no PM2 restart); `vm-browser-cli.sh` marked executable in repo (95917d6). VM now tracks master clean, heap cap + LIBGL config intact.

## 2026-05-29 — v2.7.0 Screenshot Expansion
- 1a0fb78 — v2.7.0: full-page + element-clip screenshots, blob output, vision wrapper
  - `cmdCaptureAdvanced` in extension/background.js: CDP `Page.captureScreenshot` with `captureBeyondViewport`, selector→`getBoundingClientRect` clip, png/jpeg/webp
  - CLI screenshot flags: `--full`, `--selector`, `--format`, `--quality`, `--blob`
  - New `browser-cli see "<q>"` vision wrapper (`claude -p --allowedTools Read`)
  - `captureAdvanced` added to `EXT_TAB_ACTIONS` in lib/core.js
  - Manifest 2.6.0 → 2.7.0
  - Tests: 185 pass (new core.test.js assertion for captureAdvanced routing)
  - Deployed: `BROWSER_AGENT_VM=... bash deploy.sh`, PM2 saved
  - Open: extension reload required to exercise CDP path; rotate BROWSER_AGENT_KEY (leaked in session transcript)

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
  - Git history rewritten via filter-repo (old VM username -> deployuser, email normalized)
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

## 2026-08-02 — Worktree gitignore + a test artifact reverted off master (`b06111f`)
- `.claude/worktrees/` gitignore prerequisite (this repo is the worktree trial). Without it
  the canonical checkout lists `?? .claude/` and a stage-everything command there commits an
  entire nested worktree.
- **Self-inflicted, disclosed:** while verifying the push gate goes quiet once worktree work
  is merged, a real `git merge` + `git push` put a test file (`wt-test.md`) on `origin/master`.
  Removed by a forward revert (`b06111f`) rather than a history rewrite, since the commits
  were already pushed and other sessions are live in this repo. The agentGuidance suite now
  runs that scenario in a `mktemp -d` throwaway repo.
- Deploys read the CANONICAL checkout, so merge and push before `deploy.sh` or `ext-reload`
  from a worktree. Context: `agentGuidance/guidance/concurrent-sessions.md`.

## 2026-08-01 — form-fill (atomic SPA form fill+submit)
- 88e4ac1 — feat(cli): add form-fill for atomic SPA form fill+submit; documents the
  background-tab cdp-type no-op and the hidden-decoy submit button. CLI-only, no reload.

## 2026-08-05 — poll loop was writing 330MB/day of Apache log
- The userscript re-sent the full `window.location.href` as a query param on every 3s poll.
  Apache logs the whole query string, so one tab parked on a long URL wrote ~1.5KB per poll
  (~43MB/day/tab). Eight abandoned OAuth tabs took `other_vhosts_access.log` to 662MB in two
  days and pushed the VM to 82% disk.
- The param was redundant: `/heartbeat` already refreshes `agentTabs[tid].url` on every
  navigation. Client now sends `url` only when it changed since the last accepted poll, and the
  server treats an absent param as "unchanged" rather than blank so `expectUrl` tab targeting
  keeps working.
- Added idle backoff. A tab abandoned mid-flow polled every 3s forever (28,800 empty
  requests/day); after ~1min of empty polls the interval stretches toward 30s, and any command,
  navigation, or user activity snaps it back to 3s.
- Userscript 1.16.0 -> 1.17.0. 217/217 tests pass. Commit 6109fe1.
- **Belt-and-braces at the Apache layer** (VM-side, not this repo): browser-agent poll endpoints
  now log to `/var/log/apache2/poll/` with `%U` (path only, no query string), so no future long
  URL can do this again regardless of what version clients run. Measured 817 -> 242 bytes/line,
  ~330MB/day -> 82MB/day.

Full closeout: privateContext/deliverables/closeouts/2026-08-05-vm-disk-reclamation-runeval-outage-pnpm-migration.md
