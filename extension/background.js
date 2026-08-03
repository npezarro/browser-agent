// Browser Agent Tab Manager — Background Service Worker
// Polls relay server for tab-management commands, executes via chrome.tabs API

// Pure tab-target resolution, shared with `node --test` (see tab-target.js).
// Human input kinematics, same dual-load arrangement (see human-input.js).
importScripts("tab-target.js", "human-input.js");

// Where the synthetic cursor was left in each tab, keyed by Chrome tab id.
// A real pointer has continuity between interactions: it is wherever the last
// click left it, and the next click travels from there. Without this, every
// click began from the same nowhere, which is a trivially detectable pattern
// across a session even when each individual path looks plausible.
// Deliberately NOT persisted to storage.session: a cursor position is only
// meaningful within one run of a page, and a stale one would teleport.
const lastPointer = new Map();

const POLL_MS = 2000;
const HEARTBEAT_MS = 10000;

let apiUrl = "";
let apiKey = "";
let connected = false;
let pollTimer = null;
let heartbeatTimer = null;

// Maps the relay's internal tab id (minted in content.js as `<ts>-<rand>`) to the
// real Chrome numeric tab id. Content scripts register themselves via a
// `ba-register-tab` message (background reads sender.tab.id). This lets
// resolveTabId() target the EXACT tab a command names, instead of falling back to
// whatever tab is merely active — the fix for screenshot/click/close/focus acting
// on the wrong tab, especially when multiple tabs share a URL.
const internalToChrome = new Map();

// The Map above is module state in an MV3 SERVICE WORKER, which Chrome
// terminates after ~30s idle. Every termination wiped the registry, and it is
// only repopulated when a content script sends `ba-register-tab`.
//
// That produces a failure that looks exactly like a dead browser but is not:
// the relay keeps LISTING a tab for its own 120s TTL, so `tabs` looks healthy,
// while every relay-tabId target fails "Target tab not found". And when the
// content script is throttled (minimised / occluded / display off -- i.e. every
// overnight run) it never re-registers, so the registry stays empty
// indefinitely. Reproduced live 2026-08-01.
//
// chrome.storage.session survives worker restarts, is memory-backed, and clears
// on browser exit -- the correct lifetime for a tab-id map.
const REGISTRY_KEY = "internalToChrome";
let registryLoaded = false;

async function loadRegistry() {
  if (registryLoaded) return;
  try {
    const stored = await chrome.storage.session.get(REGISTRY_KEY);
    for (const [k, v] of Object.entries(stored?.[REGISTRY_KEY] || {})) {
      if (!internalToChrome.has(k)) internalToChrome.set(k, v);
    }
  } catch (_e) { /* storage.session unavailable: degrade to in-memory */ }
  registryLoaded = true;
}

async function persistRegistry() {
  try {
    await chrome.storage.session.set({
      [REGISTRY_KEY]: Object.fromEntries(internalToChrome),
    });
  } catch (_e) { /* best effort; the in-memory Map still works this session */ }
}

/**
 * Containment options carried by a command, in one place so every call site
 * forwards the same fields. A gate enforced only at resolution is not a gate:
 * the tab can navigate before the debugger attaches.
 */
function opt(cmd) {
  return { allowOrigins: cmd.allowOrigins, unsafeAllowSensitive: cmd.unsafeAllowSensitive };
}

// Tabs with an in-flight chrome.debugger attach. Chrome allows exactly one
// debugger client per tab, so concurrent cdp-* commands must queue, not race
// to "Another debugger is already attached".
const attachLock = new Set();

// --- Config ---

async function loadConfig() {
  const cfg = await chrome.storage.local.get(["apiUrl", "apiKey"]);
  apiUrl = cfg.apiUrl || "https://pezant.ca/api/browser-agent";
  apiKey = cfg.apiKey || "";
  return !!apiKey;
}

// --- Relay Communication ---

async function post(path, body) {
  const resp = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function get(path) {
  const resp = await fetch(`${apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return resp.json();
}

// --- Heartbeat ---

async function sendHeartbeat() {
  try {
    const tabs = await chrome.tabs.query({});
    await post("/ext/heartbeat", {
      type: "extension",
      tabCount: tabs.length,
      ts: Date.now(),
      // The extension's own view of open tabs. The relay previously sourced
      // `expectUrl` only from content-script traffic, which is pruned after
      // 120s -- so on a throttled (minimised / display-off) browser the origin
      // guard silently became a no-op exactly when it mattered most. Query
      // strings are stripped: they carry tokens far more often than paths do.
      tabs: tabs.slice(0, 200).map((t) => ({
        chromeTabId: t.id,
        url: t.url ? t.url.split("?")[0] : null,
      })),
      // Chrome never auto-reloads an unpacked extension, so the relay needs to be
      // told which code is actually running to detect post-deploy drift.
      version: chrome.runtime.getManifest().version,
    });
    if (!connected) {
      connected = true;
      updateBadge();
    }
  } catch (_e) {
    connected = false;
    updateBadge();
  }
}

// --- Command Polling ---

async function poll() {
  if (!apiKey) return;
  try {
    const data = await get(`/ext/commands`);
    if (data.commands && data.commands.length > 0) {
      for (const cmd of data.commands) {
        await executeCommand(cmd);
      }
    }
  } catch (e) {
    console.error("[ext] poll error:", e.message);
  }
}

// --- Command Execution ---

async function executeCommand(cmd) {
  let result;
  try {
    switch (cmd.action) {
      case "openTab":
        result = await cmdOpenTab(cmd);
        break;
      case "openTabBackground":
        result = await cmdOpenTab({ ...cmd, active: false });
        break;
      case "closeTab":
        result = await cmdCloseTab(cmd);
        break;
      case "focusTab":
        result = await cmdFocusTab(cmd);
        break;
      case "queryTabs":
        result = await cmdQueryTabs(cmd);
        break;
      case "createTab":
        result = await cmdOpenTab(cmd);
        break;
      case "captureTab":
        result = await cmdCaptureTab(cmd);
        break;
      case "captureAdvanced":
        result = await cmdCaptureAdvanced(cmd);
        break;
      case "cdpType":
        result = await cmdCdpType(cmd);
        break;
      case "cdpClick":
        result = await cmdCdpClick(cmd);
        break;
      case "cdpEval":
        result = await cmdCdpEval(cmd);
        break;
      case "cdpKeys":
        result = await cmdCdpKeys(cmd);
        break;
      case "cdpNetworkCapture":
        result = await cmdCdpNetworkCapture(cmd);
        break;
      case "extractVirtual":
        result = await cmdExtractVirtual(cmd);
        break;
      case "reloadExtension":
        result = await cmdReloadExtension();
        break;
      default:
        result = { error: `Unknown extension command: ${cmd.action}` };
    }
    await post("/ext/result", { id: cmd.id, ok: true, result });
  } catch (e) {
    await post("/ext/result", {
      id: cmd.id,
      ok: false,
      error: e.message,
    });
  }
}

async function cmdOpenTab(cmd) {
  const active = cmd.active !== undefined ? cmd.active : true;
  const tab = await chrome.tabs.create({
    url: cmd.url,
    active,
  });
  return {
    opened: true,
    url: cmd.url,
    active,
    chromeTabId: tab.id,
    windowId: tab.windowId,
  };
}

// close/focus previously bypassed resolveTarget entirely: close did
// `chrome.tabs.query({url: cmd.url + "*"})` and took tabs[0], so a URL PREFIX
// shared by two tabs closed whichever Chrome listed first, and an explicitly
// passed relay `tabId` was ignored outright. A nightly job that ends by closing
// its own tab could therefore close one of the operator's. Both now go through
// the same fail-closed resolver as every other targeted command.
async function cmdCloseTab(cmd) {
  const t = await resolveTarget(cmd);
  if (t.error) return { closed: false, ...t };
  await chrome.tabs.remove(t.tabId);
  return { closed: true, chromeTabId: t.tabId, targetUrl: t.targetUrl, resolvedBy: t.resolvedBy };
}

async function cmdFocusTab(cmd) {
  const t = await resolveTarget(cmd);
  if (t.error) return { focused: false, ...t };
  const tab = await chrome.tabs.update(t.tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { focused: true, chromeTabId: t.tabId, targetUrl: t.targetUrl, resolvedBy: t.resolvedBy };
}

/**
 * Reload this extension so a deployed code change takes effect without anyone
 * opening chrome://extensions.
 *
 * For an unpacked extension chrome.runtime.reload() is treated as an update and
 * re-reads every file from disk, so the Windows checkout must already be pulled
 * (see the WSL/Windows sync rule in CLAUDE.md) or this reloads the same code.
 * `ext-status` reports `version` vs `expectedVersion` to confirm afterwards.
 *
 * The reload is deferred one tick so executeCommand can POST this result first —
 * reloading tears down the service worker mid-flight, and a synchronous reload
 * would leave the caller waiting for a result that can never arrive.
 */
async function cmdReloadExtension() {
  const from = chrome.runtime.getManifest().version;
  setTimeout(() => chrome.runtime.reload(), 500);
  return { reloading: true, fromVersion: from };
}

async function cmdQueryTabs(cmd) {
  const query = {};
  if (cmd.url) query.url = cmd.url + "*";
  if (cmd.active !== undefined) query.active = cmd.active;
  if (cmd.currentWindow) query.currentWindow = true;

  const tabs = await chrome.tabs.query(query);
  return {
    tabs: tabs.map((t) => ({
      chromeTabId: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      windowId: t.windowId,
    })),
  };
}

async function cmdCaptureTab(cmd) {
  // Use the same fail-closed resolver as the CDP commands. This path used to do
  // its own chromeTabId-or-URL lookup and carried two silent wrong-tab bugs:
  //   1. an unresolvable target fell through to the active tab, and
  //   2. when `chromeTabId` was supplied, `windowId` stayed undefined, so the
  //      focus block was skipped and captureVisibleTab(undefined) grabbed the
  //      FOCUSED tab — while the result still reported the requested tab id.
  // A screenshot that misreports what it captured is the worst version of this
  // bug class, since the image is the evidence.
  const tgt = await resolveTarget(cmd);
  if (tgt.error) return tgt;
  const tabId = tgt.tabId;

  let windowId;
  try {
    windowId = (await chrome.tabs.get(tabId)).windowId;
  } catch (e) {
    return { error: `Tab ${tabId} not found: ${e.message}` };
  }

  // captureVisibleTab grabs whatever is VISIBLE in the window, so the target has
  // to be foregrounded first — this is not optional.
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(windowId, { focused: true });
  await new Promise((r) => setTimeout(r, 500));

  // captureVisibleTab needs the window to actually be composited. When Chrome is
  // minimized, occluded, or the display is off it either throws "image readback
  // failed" or hangs outright — both observed on this machine 2026-07-30. CDP
  // Page.captureScreenshot has no such constraint, so fall back to it instead of
  // failing the command. The race covers the hang, which a try/catch cannot.
  const CAPTURE_TIMEOUT_MS = 8000;
  try {
    const dataUrl = await Promise.race([
      chrome.tabs.captureVisibleTab(windowId, {
        format: cmd.format || "png",
        quality: cmd.quality || 90,
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`captureVisibleTab timed out after ${CAPTURE_TIMEOUT_MS}ms`)),
          CAPTURE_TIMEOUT_MS
        )
      ),
    ]);
    return {
      dataUrl,
      chromeTabId: tabId,
      targetUrl: tgt.targetUrl,
      resolvedBy: tgt.resolvedBy,
      method: "captureVisibleTab",
    };
  } catch (e) {
    // Reuse the SAME resolved target — never re-resolve — so the fallback cannot
    // capture a different tab than the primary attempt aimed at.
    const viaCdp = await captureViaCdp(cmd, tgt);
    if (viaCdp.error) {
      return {
        error: `captureVisibleTab failed (${e.message}); CDP fallback also failed: ${viaCdp.error}`,
      };
    }
    // Surface the fallback rather than hiding it: a silent switch would mask a
    // browser that can no longer composite, which is worth knowing about.
    return { ...viaCdp, method: "cdp-fallback", primaryError: e.message };
  }
}

/**
 * Advanced capture via CDP Page.captureScreenshot.
 * Supports full-page (captureBeyondViewport), element clipping via selector,
 * and png/jpeg/webp formats.
 *
 * cmd: { url?, chromeTabId?, fullPage?, selector?, format?, quality? }
 */
async function cmdCaptureAdvanced(cmd) {
  const tgt = await resolveTarget(cmd);
  if (tgt.error) return tgt;
  return captureViaCdp(cmd, tgt);
}

/**
 * CDP Page.captureScreenshot against an ALREADY-RESOLVED target.
 *
 * Takes `tgt` instead of resolving again so the captureVisibleTab fallback in
 * cmdCaptureTab cannot drift to a different tab between the two attempts — a
 * re-resolve there would reintroduce exactly the wrong-tab class of bug this
 * file spent v2.9.0-2.10.1 removing.
 */
async function captureViaCdp(cmd, tgt) {
  const tabId = tgt.tabId;

  // Focus tab so layout/scroll state is correct
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await new Promise((r) => setTimeout(r, 300));
  } catch (_) { /* tab may be gone */ }

  const format = (cmd.format || "png").toLowerCase();
  if (!["png", "jpeg", "webp"].includes(format)) {
    return { error: `Unsupported format: ${format} (use png/jpeg/webp)` };
  }
  const params = {
    format,
    captureBeyondViewport: !!cmd.fullPage,
  };
  if (format !== "png" && typeof cmd.quality === "number") {
    params.quality = Math.max(0, Math.min(100, cmd.quality));
  } else if (format !== "png") {
    params.quality = 85;
  }

  return await withDebugger(tabId, async (target) => {
    // Resolve selector → clip rect if requested
    if (cmd.selector) {
      const sel = String(cmd.selector);
      const evalRes = await cdp(target, "Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return null;
          el.scrollIntoView({ block: "start", inline: "start" });
          const r = el.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          return {
            x: r.left + window.scrollX,
            y: r.top + window.scrollY,
            width: r.width,
            height: r.height,
            scale: dpr,
          };
        })()`,
        returnByValue: true,
      });
      const rect = evalRes?.result?.value;
      if (!rect) return { error: `Selector not found: ${sel}` };
      if (rect.width < 1 || rect.height < 1) {
        return { error: `Selector matched zero-size element: ${sel}` };
      }
      // Brief settle after scrollIntoView
      await new Promise((r) => setTimeout(r, 200));
      params.clip = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        scale: 1,
      };
    }

    const { data } = await cdp(target, "Page.captureScreenshot", params);
    const mime =
      format === "jpeg" ? "image/jpeg" :
      format === "webp" ? "image/webp" : "image/png";
    return {
      dataUrl: `data:${mime};base64,${data}`,
      chromeTabId: tabId,
      targetUrl: tgt.targetUrl,
      resolvedBy: tgt.resolvedBy,
      format,
      fullPage: !!cmd.fullPage,
      selector: cmd.selector || null,
    };
  }, cmd.expectUrl, opt(cmd));
}

// --- CDP Commands (trusted input via chrome.debugger) ---

/**
 * Resolve the Chrome tab a command may act on, against live tab state.
 * Returns { tabId, resolvedBy, targetUrl } or { error, resolvedBy }.
 */
async function resolveTarget(cmd) {
  // The service worker may have been recycled since the last command, taking
  // the in-memory registry with it. Rehydrate before resolving.
  await loadRegistry();
  const tabs = await chrome.tabs.query({});
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: ["http://*/*", "https://*/*"],
  });
  const out = resolveTargetCore(cmd, tabs, internalToChrome, active?.id);

  // Evict a registry entry that pointed at a tab which no longer exists, so the
  // next call re-registers instead of retrying a dead mapping.
  if (out.error && cmd.tabId && internalToChrome.has(cmd.tabId)) {
    const chromeId = internalToChrome.get(cmd.tabId);
    if (!tabs.some((t) => t.id === chromeId)) {
      internalToChrome.delete(cmd.tabId);
      persistRegistry();
    }
  }
  return out;
}

// The URL of a resolved tab, for echoing back in command results so the caller
// can confirm the command hit the intended tab (never throws).
async function tabUrlOf(chromeTabId) {
  try {
    const t = await chrome.tabs.get(chromeTabId);
    return t?.url || null;
  } catch {
    return null;
  }
}

/**
 * Pre-attach guard for the handlers that drive chrome.debugger by hand
 * (cdpEval / cdpNetworkCapture / extractVirtual). Mirrors the check inside
 * withDebugger: a tab can navigate between resolution and attach, and the
 * debugger must never land on an origin the caller did not name.
 */
async function guardTarget(tabId, expectUrl, opts = {}) {
  const url = await tabUrlOf(tabId);
  if (expectUrl) {
    const mismatch = originMismatch(expectUrl, url);
    if (mismatch) return mismatch;
  }
  // Re-check containment here too: resolution and attach are separate moments
  // and the tab can navigate in between.
  if (isSensitiveOrigin(url) && opts.unsafeAllowSensitive !== true) {
    return {
      error: `Refusing to act on sensitive origin ${originOf(url)} (re-checked before attach).`,
      deniedOrigin: originOf(url), sensitive: true,
    };
  }
  return allowlistViolation(opts.allowOrigins, url);
}

// Attach debugger, run fn, detach. `expectUrl` is re-checked immediately before
// attaching: a tab can navigate between resolution and attach, and the debugger
// must never land on an origin the caller did not name.
async function withDebugger(tabId, fn, expectUrl, opts = {}) {
  if (!tabId) return { error: "No debuggable tab found. Specify a target URL or ensure an HTTP/HTTPS tab is active." };
  // Validate tab URL is debuggable (chrome://, about:, edge:// cannot be debugged)
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && /^(chrome|chrome-extension|about|edge):/.test(tab.url)) {
      return { error: `Cannot debug internal browser page (${tab.url}). Navigate to an HTTP/HTTPS page first.` };
    }
    const mismatch = originMismatch(expectUrl, tab.url);
    if (mismatch) return mismatch;
    if (isSensitiveOrigin(tab.url) && opts.unsafeAllowSensitive !== true) {
      return {
        error: `Refusing to attach the debugger to sensitive origin ${originOf(tab.url)}.`,
        deniedOrigin: originOf(tab.url), sensitive: true,
      };
    }
    const denied = allowlistViolation(opts.allowOrigins, tab.url);
    if (denied) return denied;
  } catch (e) {
    return { error: `Tab ${tabId} not found: ${e.message}` };
  }
  // Serialise attaches. Concurrent cdp-* calls on the same tab previously raced
  // to "Another debugger is already attached", which surfaced as a random
  // failure rather than a queued call.
  if (attachLock.has(tabId)) {
    return { error: `Debugger already attached to tab ${tabId} by another in-flight command.` };
  }
  attachLock.add(tabId);
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    attachLock.delete(tabId);
    return { error: `debugger attach failed: ${e.message}` };
  }
  try {
    return await fn(target);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
    attachLock.delete(tabId);
  }
}

// Send a CDP command
function cdp(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
}

/**
 * Type text into the focused element using CDP Input.dispatchKeyEvent.
 * These are trusted events — React/FB will process them like real user input.
 *
 * Key descriptors and inter-key timing come from human-input.js. Two things
 * changed there and both matter outside of any detection concern:
 *   - `event.code` / `event.keyCode` are now the values a real US keyboard
 *     reports. The old inline `Key${char.toUpperCase()}` emitted "Digit"-less
 *     nonsense like "Key1", "Key " and "Key." and reported charCode 97 for a
 *     lowercase "a" where a keyboard reports 65, so any page keying off those
 *     (shortcut handlers, code inputs, games) saw impossible events.
 *   - the interval is drawn from a lognormal instead of being a fixed 30ms.
 *
 * cmd: { url?, chromeTabId?, text, selector?, delay?, humanize?, seed?, budgetMs? }
 *   delay:    MEAN inter-key interval in ms (default 105), not a constant.
 *   humanize: false restores the old fixed-interval path for speed-critical or
 *             byte-exact callers. Descriptors stay correct either way.
 *   seed:     pin for reproducible replay of a failing interaction.
 */
async function cmdCdpType(cmd) {
  const tgt = await resolveTarget(cmd);
  if (tgt.error) return tgt;
  const tabId = tgt.tabId;

  return withDebugger(tabId, async (target) => {
    // If a selector is provided, focus it first via DOM methods
    if (cmd.selector) {
      await cdp(target, "Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(cmd.selector)});
          if (el) { el.focus(); el.select?.(); return 'focused'; }
          return 'not found';
        })()`,
        returnByValue: true,
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    // Clear existing content if field has value
    if (!cmd.append) {
      await cdp(target, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 2, // Ctrl
      });
      await cdp(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
      await cdp(target, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      });
      await cdp(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      });
      await new Promise((r) => setTimeout(r, 300));
    }

    // Type each character using dispatchKeyEvent (not insertText).
    // dispatchKeyEvent generates real keyboard events that React's
    // controlled inputs respond to. insertText bypasses React state.
    const humanize = cmd.humanize !== false;
    const rng = makeRng(cmd.seed || Date.now());
    const delays = humanize
      ? keystrokeDelays(cmd.text, { rng, meanMs: cmd.delay || 105, budgetMs: cmd.budgetMs })
      : new Array(cmd.text.length).fill(cmd.delay || 30);

    for (let i = 0; i < cmd.text.length; i++) {
      const char = cmd.text[i];
      const d = keyDescriptor(char);

      if (d) {
        const base = {
          key: d.key,
          code: d.code,
          windowsVirtualKeyCode: d.windowsVirtualKeyCode,
          nativeVirtualKeyCode: d.windowsVirtualKeyCode,
          modifiers: d.modifiers,
        };
        // keyDown without text — text only in char event to avoid double insertion
        await cdp(target, "Input.dispatchKeyEvent", { type: "keyDown", ...base });
        await cdp(target, "Input.dispatchKeyEvent", { type: "char", text: char, ...base });
        await cdp(target, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
      } else {
        // No US-layout physical key produces this character (accented, CJK,
        // emoji). Emit the text-bearing event only; inventing a `code` here is
        // what produced "Key漢" before.
        await cdp(target, "Input.dispatchKeyEvent", { type: "char", text: char, key: char });
      }

      await new Promise((r) => setTimeout(r, delays[i]));
    }

    return {
      typed: true,
      length: cmd.text.length,
      method: humanize ? "cdp-keyevent-humanized" : "cdp-keyevent",
      targetUrl: tgt.targetUrl,
      resolvedBy: tgt.resolvedBy,
    };
  }, cmd.expectUrl, opt(cmd));
}

/**
 * Click at an element's position using CDP Input.dispatchMouseEvent.
 * Trusted click — bypasses isTrusted checks.
 *
 * The click is given the kinematics a hand produces (see human-input.js): an
 * approach path that bows off-axis from wherever the cursor was last left in
 * this tab, an integral landing point scattered inside the element rather than
 * its sub-pixel centroid, a hover dwell before the button goes down, and a
 * non-zero hold between press and release. Previously this was one mouseMoved
 * teleport to `r.x + r.width/2` (a float CDP accepts but no mouse emits),
 * a fixed 50ms, then press and release awaited back to back, i.e. a 0ms hold.
 *
 * cmd: { url?, chromeTabId?, selector, x?, y?, humanize?, seed? }
 *   humanize: false restores the old direct path (fast, deterministic).
 *   x/y:      explicit viewport coordinates, still approached and dwelled on.
 */
async function cmdCdpClick(cmd) {
  const tgt = await resolveTarget(cmd);
  if (tgt.error) return tgt;
  const tabId = tgt.tabId;

  return withDebugger(tabId, async (target) => {
    // Get the element's full rect (not just its centre) plus the viewport, so
    // the landing point can be scattered inside the target and an unknown
    // cursor can start from a plausible resting position.
    const evalResult = await cdp(target, "Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(cmd.selector)});
        if (!el) return JSON.stringify({error: 'not found'});
        const r = el.getBoundingClientRect();
        return JSON.stringify({
          x: r.x, y: r.y, width: r.width, height: r.height,
          vw: window.innerWidth, vh: window.innerHeight,
        });
      })()`,
      returnByValue: true,
    });

    const rect = JSON.parse(evalResult.result.value);
    if (rect.error) return { clicked: false, error: rect.error };

    const humanize = cmd.humanize !== false;
    const rng = makeRng(cmd.seed || Date.now());
    const viewport = { width: rect.vw, height: rect.vh };

    let to;
    if (cmd.x != null && cmd.y != null) {
      to = { x: Math.round(cmd.x), y: Math.round(cmd.y) };
    } else if (humanize) {
      to = pointInRect(rect, rng);
    } else {
      to = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }

    let pathLen = 1;
    let pathTruncated = false;
    if (humanize) {
      const from = lastPointer.get(tabId) || idlePointer(viewport, rng);
      const pts = mousePath(from, to, rng);
      const waits = moveDelays(pts.length, rng);
      // Each dispatch is a full chrome.debugger round trip, measured at roughly
      // a second each against this relay, which is already longer than any gap
      // we would have inserted. So sleep only the REMAINDER of the intended gap
      // (usually zero in practice), and abandon the rest of the path outright
      // if the approach is eating the command timeout. An approach path is a
      // nicety; a timed-out click is a broken command, and worse, one that
      // leaves the debugger attached until the 55s safety timer fires.
      const deadline = Date.now() + (cmd.moveBudgetMs || 6000);
      for (let i = 0; i < pts.length; i++) {
        const started = Date.now();
        await cdp(target, "Input.dispatchMouseEvent", {
          type: "mouseMoved", x: pts[i].x, y: pts[i].y, buttons: 0,
        });
        pathLen = i + 1;
        const remaining = waits[i] - (Date.now() - started);
        if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));

        if (Date.now() > deadline && i < pts.length - 1) {
          // Jump to the final point so the press still lands where we aimed.
          await cdp(target, "Input.dispatchMouseEvent", {
            type: "mouseMoved", x: to.x, y: to.y, buttons: 0,
          });
          pathLen = i + 2;
          pathTruncated = true;
          break;
        }
      }

      const { settleMs, holdMs } = clickTiming(rng);
      await new Promise((r) => setTimeout(r, settleMs));
      await cdp(target, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: to.x, y: to.y, button: "left", buttons: 1, clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, holdMs));
      await cdp(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1,
      });
    } else {
      // mouseMoved first — React event delegation needs this
      await cdp(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y });
      await new Promise((r) => setTimeout(r, 50));
      await cdp(target, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: to.x, y: to.y, button: "left", clickCount: 1,
      });
      await cdp(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1,
      });
    }

    // Remember where the cursor ended up so the next click starts from here.
    lastPointer.set(tabId, { x: to.x, y: to.y });

    return {
      clicked: true,
      x: to.x,
      y: to.y,
      method: humanize ? "cdp-humanized" : "cdp",
      pathPoints: pathLen,
      // Surfaced, not silent: a truncated approach means the transport was slow
      // enough to eat the budget, which is worth seeing in a log.
      ...(pathTruncated ? { pathTruncated: true } : {}),
      targetUrl: tgt.targetUrl,
      resolvedBy: tgt.resolvedBy,
    };
  }, cmd.expectUrl, opt(cmd));
}

/**
 * Evaluate JS in the page context via CDP Runtime.evaluate.
 * Bypasses CSP — works on Facebook, Google Photos, etc.
 *
 * cmd: { url?, chromeTabId?, expression }
 */
async function cmdCdpEval(cmd) {
  const tgt = await resolveTarget(cmd);
  if (tgt.error) return tgt;
  const tabId = tgt.tabId;

  // Focus the tab before eval (needed for virtual rendering / IntersectionObserver)
  if (cmd.focus) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await new Promise((r) => setTimeout(r, cmd.focusDelay || 1500));
    } catch (_) { /* best effort */ }
  }

  // Use manual debugger management with guaranteed cleanup timeout
  const drift = await guardTarget(tabId, cmd.expectUrl, opt(cmd));
  if (drift) return drift;

  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");

  // Self-timeout to guarantee detach even if server times out first
  const selfTimeout = cmd.focus || cmd.scroll ? 25000 : 15000;
  let detached = false;
  const cleanup = () => {
    if (!detached) {
      detached = true;
      chrome.debugger.detach(target).catch(() => {});
    }
  };
  const safetyTimer = setTimeout(cleanup, selfTimeout);

  try {
    // Progressive scroll to trigger IntersectionObserver-based virtual rendering
    if (cmd.scroll) {
      const steps = cmd.scrollSteps || 6;
      const stepPx = cmd.scrollStep || 600;
      const delay = cmd.scrollDelay || 300;
      for (let i = 0; i <= steps; i++) {
        await cdp(target, "Runtime.evaluate", {
          expression: `window.scrollTo(0, ${i * stepPx})`,
          returnByValue: true,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
      // Scroll back to top
      await cdp(target, "Runtime.evaluate", {
        expression: "window.scrollTo(0, 0)",
        returnByValue: true,
      });
      await new Promise((r) => setTimeout(r, 300));
    }

    const result = await cdp(target, "Runtime.evaluate", {
      expression: cmd.expression,
      returnByValue: true,
      awaitPromise: !!cmd.awaitPromise,
    });
    if (result.exceptionDetails) {
      return { error: result.exceptionDetails.text || "Eval error" };
    }
    return { value: result.result.value, targetUrl: tgt.targetUrl, resolvedBy: tgt.resolvedBy };
  } finally {
    clearTimeout(safetyTimer);
    cleanup();
  }
}

/**
 * Send special key events (ArrowDown, Enter, Tab, Escape, etc.) via CDP.
 * Each key in the array gets keyDown + keyUp dispatched.
 *
 * cmd: { url?, chromeTabId?, keys: [{key, code, keyCode}] }
 */
async function cmdCdpKeys(cmd) {
  const tgt = await resolveTarget(cmd);
  if (tgt.error) return tgt;
  const tabId = tgt.tabId;

  return withDebugger(tabId, async (target) => {
    for (const k of cmd.keys) {
      await cdp(target, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: k.key,
        code: k.code || "",
        windowsVirtualKeyCode: k.keyCode || 0,
      });
      await cdp(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: k.key,
        code: k.code || "",
        windowsVirtualKeyCode: k.keyCode || 0,
      });
      await new Promise((r) => setTimeout(r, k.delay || 100));
    }
    return { sent: true, count: cmd.keys.length, targetUrl: tgt.targetUrl, resolvedBy: tgt.resolvedBy };
  }, cmd.expectUrl, opt(cmd));
}

/**
 * Capture network responses matching a URL pattern via CDP Network domain.
 * Bypasses virtual rendering entirely by intercepting the raw API response.
 *
 * cmd: { url?, chromeTabId?, urlPattern, reload?, timeout?, maxLen?, maxCaptures? }
 */
async function cmdCdpNetworkCapture(cmd) {
  const tgt = await resolveTarget(cmd);
  if (tgt.error) return tgt;
  const tabId = tgt.tabId;

  // Focus tab first
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) { /* best effort */ }

  const drift = await guardTarget(tabId, cmd.expectUrl, opt(cmd));
  if (drift) return drift;

  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");

  try {
    await cdp(target, "Network.enable", {});

    const captured = [];
    const allUrls = [];
    const urlPattern = cmd.urlPattern || "";
    const timeout = cmd.timeout || 30000;
    const maxCaptures = cmd.maxCaptures || 1;
    const maxLen = cmd.maxLen || 100000;
    const listOnly = cmd.listUrls || false;

    const responsePromise = new Promise((resolve) => {
      const pendingRequests = new Map();

      const onEvent = (source, method, params) => {
        if (source.tabId !== tabId) return;

        if (method === "Network.responseReceived") {
          const respUrl = params.response.url;
          const mimeType = params.response.mimeType || "";
          if (listOnly) {
            allUrls.push({ url: respUrl.substring(0, 300), type: params.type, mime: mimeType, status: params.response.status });
          }
          if (respUrl.includes(urlPattern)) {
            pendingRequests.set(params.requestId, respUrl);
          }
        }

        if (method === "Network.loadingFinished" && !listOnly) {
          const reqUrl = pendingRequests.get(params.requestId);
          if (reqUrl) {
            pendingRequests.delete(params.requestId);
            cdp(target, "Network.getResponseBody", { requestId: params.requestId })
              .then((body) => {
                captured.push({
                  url: reqUrl,
                  body: (body.body || "").substring(0, maxLen),
                  base64Encoded: body.base64Encoded,
                  size: (body.body || "").length,
                });
                if (captured.length >= maxCaptures) {
                  chrome.debugger.onEvent.removeListener(onEvent);
                  resolve(captured);
                }
              })
              .catch(() => {
                pendingRequests.delete(params.requestId);
              });
          }
        }
      };

      chrome.debugger.onEvent.addListener(onEvent);

      setTimeout(() => {
        chrome.debugger.onEvent.removeListener(onEvent);
        resolve(listOnly ? allUrls : captured);
      }, timeout);
    });

    // Reload page to trigger network requests
    if (cmd.reload !== false) {
      await new Promise((r) => setTimeout(r, 500));
      await cdp(target, "Page.reload", {});
    }

    const results = await responsePromise;
    const meta = { targetUrl: tgt.targetUrl, resolvedBy: tgt.resolvedBy };
    return listOnly
      ? { urlCount: results.length, urls: results, ...meta }
      : { captured: results.length, responses: results, ...meta };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

/**
 * Extract data from a virtually-rendered page using 10 approaches in sequence.
 * Returns the first approach that yields results. Designed for SPAs with
 * IntersectionObserver-based lazy rendering (e.g., Amex Travel hotel cards).
 *
 * cmd: { url?, chromeTabId?, selector (container), extract (JS expression), waitMs? }
 */
async function cmdExtractVirtual(cmd) {
  const tgt = await resolveTarget(cmd);
  if (tgt.error) return tgt;
  const tabId = tgt.tabId;

  const selector = cmd.selector || "[data-testid='hotels-list']";
  const extract = cmd.extract || "var h=document.querySelector('" + selector.replace(/'/g, "\\'") + "');var html=h?h.innerHTML:'';var m=html.match(/aria-label=\"Select Hotel [^\"]+\"/g);m?m.join('|||'):'NONE'";
  const waitMs = cmd.waitMs || 2000;
  const results = { approaches: {}, targetUrl: tgt.targetUrl, resolvedBy: tgt.resolvedBy };

  // Step 1: Focus the tab
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {}
  await new Promise((r) => setTimeout(r, waitMs));

  const drift = await guardTarget(tabId, cmd.expectUrl, opt(cmd));
  if (drift) return drift;

  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");

  let detached = false;
  const cleanup = () => { if (!detached) { detached = true; chrome.debugger.detach(target).catch(() => {}); } };
  const safetyTimer = setTimeout(cleanup, 55000);

  try {
    // Helper: eval in page and return string result
    async function evalPage(expr) {
      const r = await cdp(target, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: false });
      if (r.exceptionDetails) return null;
      return r.result.value;
    }

    async function evalPageAsync(expr) {
      const r = await cdp(target, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return null;
      return r.result.value;
    }

    // Approach 1: Direct extraction (no scroll)
    let data = await evalPage(extract);
    if (data && data !== "NONE" && data.length > 10) {
      results.method = "direct";
      results.data = data;
      results.approaches.direct = "success";
      return results;
    }
    results.approaches.direct = "no data";

    // Approach 2: Progressive scroll then extract
    for (let i = 0; i <= 8; i++) {
      await evalPage(`window.scrollTo(0, ${i * 500})`);
      await new Promise((r) => setTimeout(r, 250));
    }
    await evalPage("window.scrollTo(0, 0)");
    await new Promise((r) => setTimeout(r, 500));
    data = await evalPage(extract);
    if (data && data !== "NONE" && data.length > 10) {
      results.method = "scroll";
      results.data = data;
      results.approaches.scroll = "success";
      return results;
    }
    results.approaches.scroll = "no data";

    // Approach 3: Screenshot to force paint, then extract
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 10 });
      await new Promise((r) => setTimeout(r, 500));
      data = await evalPage(extract);
      if (data && data !== "NONE" && data.length > 10) {
        results.method = "screenshot";
        results.data = data;
        results.approaches.screenshot = "success";
        return results;
      }
    } catch (_) {}
    results.approaches.screenshot = "no data";

    // Approach 4: Scroll each card into view via scrollIntoView
    data = await evalPage(`
      var container = document.querySelector('${selector.replace(/'/g, "\\'")}');
      if (container) {
        var children = container.querySelectorAll('[class*="card"], [class*="Card"], [data-testid*="hotel"], [class*="offer"]');
        for (var i = 0; i < children.length; i++) {
          children[i].scrollIntoView({block: 'center'});
        }
      }
      'scrolled ' + (container ? container.querySelectorAll('[class*="card"], [class*="Card"]').length : 0) + ' cards'
    `);
    results.approaches.scrollCards = data;
    await new Promise((r) => setTimeout(r, 500));
    data = await evalPage(extract);
    if (data && data !== "NONE" && data.length > 10) {
      results.method = "scrollCards";
      results.data = data;
      return results;
    }

    // Approach 5: MutationObserver — scroll and wait for DOM changes
    data = await evalPageAsync(`
      new Promise(resolve => {
        var container = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (!container) return resolve('no container');
        var changed = false;
        var obs = new MutationObserver(() => { changed = true; });
        obs.observe(container, {childList: true, subtree: true});
        window.scrollTo(0, 500);
        setTimeout(() => {
          obs.disconnect();
          resolve(changed ? 'mutations detected' : 'no mutations');
        }, 2000);
      })
    `);
    results.approaches.mutationObserver = data;
    if (data === "mutations detected") {
      data = await evalPage(extract);
      if (data && data !== "NONE" && data.length > 10) {
        results.method = "mutation";
        results.data = data;
        return results;
      }
    }

    // Approach 6: Read innerText of the container for fallback text parsing
    data = await evalPage(`
      var container = document.querySelector('${selector.replace(/'/g, "\\'")}');
      container ? container.innerText.substring(0, 5000) : 'no container'
    `);
    if (data && data !== "no container" && data.length > 50) {
      results.method = "innerText";
      results.data = data;
      results.approaches.innerText = "success (" + data.length + " chars)";
      return results;
    }
    results.approaches.innerText = "no data";

    // Approach 7: Fetch intercept — monkey-patch fetch, trigger search via URL change
    await evalPage(`
      window.__capturedResponses = [];
      var _origFetch = window.fetch;
      window.fetch = function(url, opts) {
        var p = _origFetch.apply(this, arguments);
        p.then(function(r) {
          if (r.url && (r.url.includes('hotel') || r.url.includes('offer') || r.url.includes('search') || r.url.includes('accommodation'))) {
            r.clone().text().then(function(t) { window.__capturedResponses.push({url: r.url, body: t.substring(0, 50000)}); });
          }
        }).catch(function(){});
        return p;
      };
      'fetch intercepted'
    `);
    // Trigger a re-search by scrolling or clicking Update
    await evalPage(`
      var btn = document.querySelector('button');
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].textContent.trim() === 'Update') { btns[i].click(); break; }
      }
      'clicked update'
    `);
    await new Promise((r) => setTimeout(r, 5000));
    data = await evalPage("JSON.stringify(window.__capturedResponses || [])");
    if (data && data !== "[]") {
      results.method = "fetchIntercept";
      results.data = data;
      results.approaches.fetchIntercept = "success";
      return results;
    }
    results.approaches.fetchIntercept = "no captures";

    // Approach 8: __NEXT_DATA__ extraction
    data = await evalPage(`
      var nd = document.getElementById('__NEXT_DATA__');
      nd ? nd.textContent.substring(0, 3000) : 'no __NEXT_DATA__'
    `);
    results.approaches.nextData = data && data.length > 100 ? "found (" + data.length + " chars)" : "no data";

    // Approach 9: XHR intercept
    await evalPage(`
      window.__xhrCaptures = [];
      var _origOpen = XMLHttpRequest.prototype.open;
      var _origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(m, u) { this._url = u; _origOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function() {
        this.addEventListener('load', function() {
          if (this._url && (this._url.includes('hotel') || this._url.includes('offer') || this._url.includes('search'))) {
            window.__xhrCaptures.push({url: this._url, body: this.responseText?.substring(0, 50000)});
          }
        });
        _origSend.apply(this, arguments);
      };
      'xhr intercepted'
    `);
    await new Promise((r) => setTimeout(r, 3000));
    data = await evalPage("JSON.stringify(window.__xhrCaptures || [])");
    if (data && data !== "[]") {
      results.method = "xhrIntercept";
      results.data = data;
      results.approaches.xhrIntercept = "success";
      return results;
    }
    results.approaches.xhrIntercept = "no captures";

    // Approach 10: Full body text as last resort
    data = await evalPage("document.body.innerText.substring(0, 8000)");
    results.method = "bodyText";
    results.data = data;
    results.approaches.bodyText = data ? data.length + " chars" : "empty";

    return results;
  } finally {
    clearTimeout(safetyTimer);
    cleanup();
  }
}

// --- Badge ---

function updateBadge() {
  chrome.action.setBadgeText({ text: connected ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({
    color: connected ? "#22c55e" : "#ef4444",
  });
}

// --- Content Script Messages ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Register the content script's relay tab id -> its Chrome tab id, so
  // resolveTabId() can target the exact tab. sender.tab.id is the authoritative
  // Chrome id of the tab the message came from.
  if (request.type === "ba-register-tab" && request.tabId && sender.tab?.id) {
    internalToChrome.set(request.tabId, sender.tab.id);
    persistRegistry();
    sendResponse({ registered: true, chromeTabId: sender.tab.id });
    return false;
  }

  if (request.type === "ba-notify") {
    const id = `ba-${Date.now()}`;
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: request.title || "Browser Agent",
      message: request.text || "",
    });
    if (request.timeout) {
      setTimeout(() => chrome.notifications.clear(id).catch(() => {}), request.timeout);
    }
    sendResponse({ sent: true });
    return false;
  }

  // CSP eval fallback — content script delegates eval to background via CDP
  if (request.type === "ba-eval-fallback" && sender.tab?.id) {
    const tabId = sender.tab.id;
    (async () => {
      try {
        const target = { tabId };
        await chrome.debugger.attach(target, "1.3");
        try {
          const evalResult = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
            expression: `(() => { ${request.code} })()`,
            returnByValue: true,
            awaitPromise: true,
          });
          if (evalResult.exceptionDetails) {
            sendResponse({ error: evalResult.exceptionDetails.text || "CDP eval error" });
          } else {
            const v = evalResult.result.value;
            if (typeof v === "object" && v !== null) {
              sendResponse({ value: JSON.stringify(v).substring(0, request.maxLen || 5000) });
            } else {
              sendResponse({ value: v });
            }
          }
        } finally {
          await chrome.debugger.detach(target).catch(() => {});
        }
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true; // async sendResponse
  }
});

// --- Lifecycle ---

async function start() {
  const hasConfig = await loadConfig();
  if (!hasConfig) {
    updateBadge();
    return;
  }
  await sendHeartbeat();
  pollTimer = setInterval(poll, POLL_MS);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
}

// Listen for config changes (from popup)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.apiUrl || changes.apiKey)) {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    connected = false;
    start();
  }
});

// Service worker wakeup
chrome.runtime.onInstalled.addListener(() => start());
chrome.runtime.onStartup.addListener(() => start());

// Drop registry entries for closed tabs so a recycled Chrome tab id can't be
// mistaken for a stale relay tab id.
chrome.tabs.onRemoved.addListener((closedId) => {
  let changed = false;
  for (const [internalId, chromeId] of internalToChrome) {
    if (chromeId === closedId) { internalToChrome.delete(internalId); changed = true; }
  }
  if (changed) persistRegistry();
  // Same reasoning for the cursor: Chrome recycles tab ids, and inheriting a
  // dead tab's pointer position would start the next path from a stale point.
  lastPointer.delete(closedId);
});

// Keepalive alarm for MV3 service worker
chrome.alarms?.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") poll();
});

start();

