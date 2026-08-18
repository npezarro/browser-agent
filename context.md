# context.md — browser-agent

Last Updated: 2026-08-03 — v2.12.1 LIVE + validated against real bot protection (null result)

## 2026-08-03 (phase 2) — validated against real bot protection: the instrument saturated
- **Passive control passed outright.** `bot.sannysoft.com`: zero failed checks.
  `WebDriver (New): missing (passed)`, `WebDriver Advanced: passed`, `Chrome: present (passed)`,
  plugins 5, real `ANGLE (NVIDIA ... D3D11)` renderer; a programmatic sweep for failing/red cells
  returned empty. Independent confirmation of the v2.12.0 thesis that the passive surfaces are
  already clean and need no spoofing.
- **The behavioural A/B produced no signal, because the instrument has no resolution here.**
  Google's reCAPTCHA v3 score demo returned **0.9 (its practical ceiling) in every condition**:
  baseline with zero interaction, after `--fast` clicks, and after humanized clicks, interleaved
  to control for session-reputation drift.

  | arm | clicks | elapsed | score |
  |---|---|---|---|
  | baseline, no interaction | - | - | 0.9 |
  | round 1 `--fast` | 3/3 | 6s | 0.9 |
  | round 1 humanized | 3/3 | 6s | 0.9 |
  | round 2 `--fast` | 3/3 | 6s | 0.9 |

  Correct reading: **wrong measuring device.** Not "humanizing is pointless" and not "humanizing
  is proven". Humanized input remains UNPROVEN against a detector that actually scores behaviour.
  A useful next instrument must report a graded verdict with reasons rather than a saturated
  score (fingerprint.com playground, CreepJS trust score, DataDome/PerimeterX demo).

### Two cost facts worth knowing before writing any interaction loop
- **`cdp-type` is 3 CDP dispatches per character**, humanized or not (keyDown, char, keyUp). A
  25-character string is 75 round trips and will exceed the relay's 30s timeout on a
  non-composited tab. `keystrokeDelays` scales the *sleeps* to a budget but cannot reduce the
  RPC count. Prefer `form-fill` for anything long; reserve `cdp-type` for short fields.
- **CORRECTION to the earlier "+1.8s per humanized click" note: it was wrong.** Measured on a
  visible tab, `--fast` and humanized clicks are **both ~2s**. The transport dominates, not the
  waypoints. The original figure compared a `--fast` click on a composited window against a
  humanized click on an occluded one, i.e. it measured visibility, not method.
- Unrelated but cost me 20 minutes: piping a long-running **background** script through `tail`
  buffers all output until exit, so a healthy run looks hung and killing it loses everything.
  Write to a log file with `tee` instead.

Full closeout: `privateContext/deliverables/closeouts/2026-08-03-bot-protection-ab-test-and-credential-leak.md`


## 2026-08-03 — v2.12.1: the approach path must respect the transport
- **Caught in live verification, not review.** Each `chrome.debugger` Input dispatch costs
  ~1s+ against this relay (a bare 3-call `--fast` click takes ~6.7s end to end). The 2.12.0
  click used up to 26 awaited waypoints, which pushed a single click past the relay's **30s
  command timeout**.
- That failure is worse than slow: `withDebugger` then holds the debugger attached until its
  **55s safety timer**, so the *next* command dies with "Another debugger is already
  attached". One slow click poisons its successor.
- Fix: waypoints `clamp(dist/60, 5, 14)`; the inter-move gap is now a *remainder*
  (`waits[i]` minus the time the RPC already took, usually zero); a `moveBudgetMs` deadline
  (default 6s) abandons the rest of the path and jumps to the final point so the press still
  lands where aimed, reporting `pathTruncated: true` rather than truncating silently.
- **Rule this generalises to:** measure the transport before synthesising timing. Delays that
  assume a free channel BECOME the timeout when the channel costs more than the delay does.

### Live verification results (2026-08-03, ext 2.12.1 on the main profile)
- `ext-status`: `version 2.12.1 == expectedVersion`, `stale: false`, `connected: true`.
- Key descriptors on a real page: `H`→`KeyH` kc72 **SHIFT**, `@`→`Digit2` kc50 SHIFT,
  `.`→`Period` kc190, ` `→`Space` kc32. Value typed correctly (`Hi a@b.co 42!`).
- Keystroke intervals: `[139,90,126,109,168,77,139,186,166,114,217,108]` (was a flat 30).
- Click on a **visible** tab: 2.3s, 5-point decelerating path, landed 258,175 inside the
  button rect (205..321 x 139..212) and NOT its centroid (263,176), `holdMs: 61`,
  `isTrusted: true`, no truncation. Path started at the previous click's endpoint, proving
  `lastPointer` continuity.
- `fingerprint-audit` on this browser: `webdriver:false`, WebGL `ANGLE (NVIDIA GeForce GTX
  1060 6GB, D3D11)`, UA and UA-CH agree, `patchedNatives: []`, `cdpConsoleProbe: false`,
  `flags: []`. Empirical confirmation that the passive surfaces need no work.

### Two operational traps this session hit
- **`document.visibilityState` gates input, silently.** On a hidden/occluded tab, CDP mouse
  presses and keystrokes **do not land at all** while the command still reports success, and
  each Input dispatch slows from ~30ms to seconds. Always confirm `visible` before trusting a
  negative interaction result. Raising the Chrome window from WSL works:
  PowerShell `ShowWindow(hwnd, 9)` + `SetForegroundWindow`.
- **Restarting the relay wipes its in-memory `extLastHeartbeatByKey`,** so an `ext-reload`
  issued immediately after `pm2 restart browser-agent` sees `extAlive:false`, falls through to
  the content-script path, and fails "No browser tabs connected". Wait for a heartbeat
  (`until ext-status | grep connected: true`) before reloading.

## 2026-08-03 — v2.12.0: the hardware is real, so fix the hand (not the fingerprint)
- **Framing that drove the design:** asked how to make hardware "convincing" enough not to
  get blocked, the correct answer for THIS stack is that no hardware simulation is wanted.
  Real Chrome, real GPU, real display, residential IP, logged-in profile: every passive
  surface is already genuine, and bot mitigation scores *inconsistency*, so patching any of
  them strictly worsens the picture. `navigator.webdriver` is set by the
  `--enable-automation` launch switch, which an extension + `chrome.debugger` setup never
  uses, so it is already false here.
- **What was actually synthetic was the input**, and it carried two separate problems.
  1. A real bug: key descriptors were `Key${char.toUpperCase()}` + raw `charCode` for every
     character, so digits emitted `code:"Key1"`, space `"Key "`, period `"Key."`, lowercase
     `a` reported keyCode 97 instead of 65, and uppercase never set Shift. Pages reading
     `event.code`/`event.keyCode` saw impossible events. Fixed in `keyDescriptor()`.
  2. Mechanical kinematics: fixed 30ms keystroke metronome; clicks teleporting to the
     sub-pixel centroid (a float no mouse emits) with a **0ms** press-to-release hold.
- New `extension/human-input.js` (pure, dual-target like `tab-target.js`, 23 unit tests):
  lognormal keystroke timing with digraph effects, integral scattered landing points,
  bowed Bezier approach paths with overshoot-and-correct, dwell + hold, and `lastPointer`
  in `background.js` so the cursor has continuity between clicks.
- `--fast` opts back into the old path; `--seed N` pins the RNG for byte-identical replay.
  Long strings scale their mean down to fit an 18s budget rather than blowing the relay's
  30s timeout.
- New `browser-cli fingerprint-audit` **diagnoses and never spoofs**; its `patchedNatives`
  check exists to catch a previous "stealth" patch having created the tell it was hiding.
  Built on `cdpEval`, so it required **no relay change** and works against any relay.
- Relay untouched. Only the VM's copy of `extension/manifest.json` needed updating, since
  `/ext/status` reads it to compute `expectedVersion` for drift detection.

## 2026-08-01 — ext-reload serializes on a cross-session resource lock

## 2026-08-01 — ext-reload serializes on a cross-session resource lock
- **Why:** the browser is a SINGLETON. Two sessions reloading at once tear down each
  other's service worker mid-verify and then read the other's version back — which is
  exactly the drift `ext-status` exists to detect, so the failure disguises itself as
  the detector working.
- `browser-cli ext-reload` now re-execs itself under
  `agentGuidance/scripts/with-resource-lock.sh browser-extension --timeout 180`. The wrap
  is optional (skipped when agentGuidance is absent, as on the VM) and
  `BROWSER_AGENT_NO_LOCK=1` opts out — that variable is also how the re-exec avoids
  recursing into itself.
- `.gitignore` gained `.claude/worktrees/`: this repo is the trial for per-session git
  worktrees. Unignored, a worktree shows as `?? .claude/` in the canonical checkout and a
  stage-everything command there commits an entire nested worktree.
- Rationale and the rest of the design: `agentGuidance/guidance/concurrent-sessions.md`.
- **State:** working. Verified the lock is held during a live `ext-reload` and the reload
  still completes (2.10.1 -> 2.10.2, exit 0).

Full closeout: privateContext/deliverables/closeouts/2026-08-01-concurrent-sessions-worktrees-and-locks.md

## 2026-07-30/08-01 — Remote extension reload + two more wrong-tab bugs (ext 2.9.0 -> 2.10.2)
- **Why:** every extension deploy ended with "ask the user to open chrome://extensions",
  and the fail-closed pass above had missed a code path.
- **`ext-reload` (2.10.0):** a `reloadExtension` action calls `chrome.runtime.reload()`
  (no permissions, callable from an MV3 service worker; for an *unpacked* extension the
  reload is treated as an update and re-reads every file from disk). Deferred one tick so
  `executeCommand` POSTs the result before the worker is torn down. The extension reports
  its running version on each heartbeat; `/ext/status` returns `version` /
  `expectedVersion` (read from the checkout's manifest) / `stale`.
  - `stale` is **tri-state on purpose**: `null` = the running extension is too old to
    report a version, which is NOT the same as up to date. Reporting `false` there would
    hide exactly the drift the field exists to catch. `ext-reload` treats anything but an
    explicit `false` as failure.
  - **Limits:** cannot bootstrap itself (must exist in the RUNNING version, so one manual
    reload is needed once), and cannot revive a dead service worker.
  - **Rejected:** self-hosted CRX auto-update. Chrome no longer installs non-Web-Store
    extensions from a plain registry `update_url`; it now needs an enterprise
    `ExtensionSettings` force_installed policy, which also changes the extension ID and
    adds a signing key + update manifest to maintain.
- **`captureTab` (2.10.1):** the plain `screenshot` path kept its own ad-hoc resolution and
  was missed by the first fail-closed pass. Two defects: an unresolvable target fell
  through to the active tab, and when `chromeTabId` was supplied `windowId` stayed
  undefined so the focus block was skipped and `captureVisibleTab(undefined)` captured the
  FOCUSED tab **while the result still reported the requested tab id**. It also ignored the
  internal->chrome registry. Now routed through `resolveTarget`.
- **CDP screenshot fallback (2.10.2):** `captureVisibleTab` needs a composited window; it
  throws "image readback failed" or hangs otherwise, which made plain `screenshot` unusable
  here. `captureViaCdp(cmd, tgt)` was extracted taking an **already-resolved** target, and
  `cmdCaptureTab` races an 8s timeout (a try/catch cannot catch the hang) then falls back.
  - **Key design point:** the fallback reuses the SAME resolved target and never
    re-resolves. A re-resolve could land on a different tab than the primary attempt and
    would reintroduce the wrong-tab class this file spent 2.9.0-2.10.1 removing.
  - Results carry `method: "captureVisibleTab" | "cdp-fallback"` + `primaryError`; the
    switch is surfaced, not hidden.
- **Verified live:** `ext-reload` exercised 3x. Guard path (Windows checkout not pulled)
  came back stale and exited 1; happy path went 2.10.1 -> 2.10.2 exit 0 with no
  chrome://extensions visit. Plain `browser-cli screenshot out.png <tabid>` wrote a valid
  1280x569 PNG whose **content was the named tab** (confirmed by viewing the image, not the
  byte count) while a decoy was focused.
- **Concurrent-session note:** another session held the same working tree. My
  `captureViaCdp` change landed inside its commit `1c66cff`, and its `see` fix landed
  inside my `793bfad`. Content verified intact both ways; history not rewritten. Search by
  content, not commit message, for this date range.
- **State:** working. Extension 2.10.2 running (`stale:false`), relay 200, 207 tests pass.

Full closeout: privateContext/deliverables/closeouts/2026-08-01-browser-agent-fail-closed-tab-targeting.md

## 2026-07-30 — Security: cdp-eval/cdp-click silently ran against the focused tab
- **Symptom:** `cdp-eval` given an explicit relay tab id returned the content of a
  completely different, *focused* tab (reported against a `myaccount.google.com`
  page; reproduced live returning `app.brevo.com/security/authorised_ips`). No
  error, no signal — the caller could not tell it had read the wrong page.
- **Impact:** any `cdp-eval`/`cdp-click`/`cdp-type`/`screenshot`/`network-capture`
  could read or click whatever was focused, including logged-in credential and
  security-console pages the caller never named.
- **Root cause — three compounding bugs, not one:**
  1. `browser-cli.sh` passed `interactive ""` for *every* CDP command, so **no
     `tabId` ever reached the relay**. The v2.8.0 server-side fix
     (`agent-server.js` attaching `extCmd.tabId`) was gated on `if (tid)` and was
     therefore **dead code on this path** — it had been shipped and verified
     against `screenshot`/`focus`, never against `cdp-*`.
  2. The CDP commands' optional positional was parsed as a **URL substring**
     unconditionally, so a tab id was sent as `url:"<tab id>"` and matched no tab.
  3. `resolveTabId` then fell through to `chrome.tabs.query({active:true})`
     **silently**, and `cdpEval` echoed no target, so nothing surfaced the miss.
- **Fix (ext v2.9.0 + relay + CLI):**
  - `extension/tab-target.js` — new pure `resolveTargetCore`, `importScripts`-ed by
    the service worker and `require`-d by `node --test`. **Fails closed:** a named
    target that cannot be resolved returns an error; the active tab is used *only*
    when the caller named no target at all.
  - Relay attaches `expectUrl` (the URL it last recorded for that tab id); the
    extension cross-checks it **by origin** at resolution and again immediately
    before `chrome.debugger.attach`. Needed because relay tab ids live in the
    page's `sessionStorage` and **survive navigation** — an id captured on site A
    still resolves after that tab moved to site B.
  - `browser-cli.sh:split_target()` classifies the target argument as a relay tab
    id (`<epoch_ms>-<rand>`) or a URL substring, so tab ids actually reach the relay.
  - Every CDP result echoes `targetUrl` + `resolvedBy`.
- **Tests:** `test/tab-targeting.test.js`, 13 cases (205 total pass).
- **Lesson:** the v2.8.0 fix was real but unreachable. A tab-targeting fix must be
  verified through the **CLI entry point of each command family**, not just at the
  layer that was edited.

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

## 2026-07-30 — `see` fixed; `cdp-*` is the fallback when the window isn't composited
- **What changed:** `browser-cli see` was writing captures to a `.img` extension the vision
  step cannot render, so the command had never worked. Now derives the extension from
  `--format` (`browser-cli.sh:365-374`). Verified with an A/B on identical JPEG bytes.
- **Decision:** the fix rode along inside `793bfad`, whose message covers only ext-reload,
  because a concurrent session committed the shared working tree. Not rewriting pushed
  history; recorded here and in `progress.md` so it is findable by content.
- **Operational rule (the reusable part):** a minimized/occluded Chrome throttles the
  content script, not just captures. `ping`/`state`/`text`/`eval`/`click` all time out while
  `tabs` still shows healthy heartbeats. Do NOT conclude the browser is unreachable —
  retry as `cdp-eval`/`cdp-click`, which run through the service worker and keep working.
- **Open:** that rule lives in `progress.md` + memory only. It arguably belongs in
  `CLAUDE.md` so autonomous agents see it without reading history; deliberately not added
  while a concurrent session held uncommitted extension changes.
- **State:** working. Fix is on `origin/master`.

Full session closeout: privateContext/deliverables/closeouts/2026-07-30-brevo-mcp-setup-and-see-bug-fix.md

## 2026-08-01 — form-fill: atomic SPA form fill+submit
- **Added:** `browser-cli form-fill` (alias `ff`) in `browser-cli.sh` + `CLAUDE.md`, commit `88e4ac1`.
  Fills `{selector: value}` via the native `HTMLInputElement` value setter plus `input`/`change`,
  then clicks a `--submit` regex-matched visible button, all inside ONE `cdp-eval`. Returns
  `{filled, missing, submitted, url, body}`. Pure CLI change: no extension edit, no reload needed.
- **Why:** on Vue `v-model` / React controlled forms, filling in one CLI call and submitting in
  the next ALWAYS submits blank. The framework re-renders between calls and writes its empty
  model back over the DOM. The page returns "This field is required" on fields you just filled,
  which reads exactly like bot detection and is not.
- **Two traps documented in CLAUDE.md:** (1) `cdp-type` silently no-ops on tabs opened by
  `ensure` (`openTabBackground` -> `visibilityState:"hidden"` -> nothing holds focus) while still
  returning `typed:true` — always DOM-readback; focusing may not help if the Windows desktop is
  not rendering. (2) The visible submit button may not be the form's submit element: staples.com
  ships a hidden `input[type=submit]#loginButton_0` beside the real `button.btn-primary`, and
  clicking the hidden one fires validation only. Match visible text AND require `offsetParent`.
- **Boundary recorded:** this automates a real browser on the user's own session. It does not
  forge site anti-fraud telemetry (staples.com ships NuData `nds-pmd` behavioural biometrics)
  and must not be extended to. On CAPTCHA/step-up, stop and hand back to the user.
- **First consumer:** `privateContext/recurring-tasks/scripts/staples-giftcard-buy.py`.
- **Verified:** live DOM readback (17 chars into `#searchInput`, exact value confirmed) plus
  `missing` correctly reporting a bogus selector.
- **State:** working. On `origin/master`.

Full session closeout: privateContext/deliverables/closeouts/2026-08-01-staples-monthly-giftcard-automation.md

## Active Branch
`master`

## 2026-08-02 — ext 2.11.0: origin containment + durable tab registry

**State: WORKING**, deployed to both profiles (main + alt Brave), 217/217 tests pass.

- **Tab registry now survives the MV3 service worker.** It was a module-level
  `Map`; Chrome kills the worker after ~30s idle, and only a content-script
  `registerTab` repopulates it. The relay keeps LISTING tabs for 120s, so `tabs`
  looked healthy while every relay-tabId target failed. Now mirrored into
  `chrome.storage.session`.
- **Origin containment:** hard-deny list (identity/bank hosts, host-or-dot-suffix
  matched) + per-command `allowOrigins`. Hard-deny outranks allowOrigins.
  `unsafeAllowSensitive` is the logged escape hatch. Absent allowOrigins,
  behaviour is byte-identical to 2.10.2.
- **cmdCloseTab/cmdFocusTab** no longer bypass resolveTarget.
- **expectUrl** now sourced from the extension's heartbeat tab table, so it does
  not silently disable itself when the content script is throttled.
- **chromeTabId plumbed end to end** (CLI -> relay -> extension). Required,
  because `exclude_matches` removes the content script from chain domains so no
  relay tab id is ever minted there.
- New `browser-cli ext-health`: 4-state probe returning green | cdp-only | red.
  **cdp-only is the expected overnight state**, not an anomaly.

**Gotcha that bit three times:** when threading a new field through the CLI, grep
for EVERY command that builds its own action JSON. Fixing `split_target` did not
reach the cdp-* verbs; fixing those did not reach network-capture/extract-virtual;
fixing those did not reach `focus`/`close` (which were URL-only and silently
ignored tab ids, leaking a tab after every collector page).

Full closeout: privateContext/deliverables/closeouts/2026-08-02-travel-price-history-and-chain-award-collectors.md

## 2026-08-18 — `ensure` proves tab ownership; new `btabs` verb
- **The un-keyed registry is a trap.** `/agent/tabs` is ONE registry — every API key sees the union of tabs from BOTH browser profiles — while *commands* route per key to a single profile's extension. So a URL match was never proof the tab was yours to drive: `ensure` would hand back the other profile's tab and every later read on that id timed out. Cost: `browser-session-keepalive.sh alt` spent six weeks reading the MAIN profile's claude.ai tab and certifying it healthy while the ALT session died, taking seven bridge containers with it.
- `5541769` — `ensure` now probes with a keyed `ping` before reusing a tab; a timeout means another profile owns it, so it opens its own instead. Origins that refuse content scripts (`accounts.google.com`, `chrome://`) can never answer, so a matching tab is still returned there but tagged `ownership: unverified` rather than passed off as healthy. Callers must treat unverified as "cannot assert", not "fine".
- `839f016` — **new `btabs` verb**: tabs as `chrome.tabs.query` sees them (via the service worker), not as the content-script-fed registry sees them. Needed because ext 2.11.0's `exclude_matches` means a tab on any excluded origin can NEVER appear in `tabs`, which silently turned the OAuth account-chooser recovery in `scripts/lib/browser-google-login.sh` into unreachable code. Those tabs are real and CDP still drives them; they are merely invisible to `tabs`.
- **Two behaviours worth knowing when driving OAuth popups** (both measured this session): a popup opens as a separate WINDOW, and `focusTab` activates a tab *within* its window without raising the window — so the popup stays at `visibilityState: "hidden"` and Chrome never delivers CDP `Input` events to it. `{"clicked": true}` means an event was dispatched, never that the page reacted. Use a JS `el.click()` inside popups; reserve trusted cdp-clicks for buttons that need user activation (anything calling `window.open`).
- The `[SENSITIVE]` relay log line is the audit trail for `unsafeAllowSensitive`; confirmed live in the VM's PM2 log.
- **State: working.** Only `browser-session-keepalive.sh` consumes `ensure`, so the ownership probe's regression surface is one caller. Full closeout: privateContext/deliverables/closeouts/2026-08-18-relogin-recovery-and-credential-expiry-alarm.md
