// Pure tab-target resolution for CDP/native extension commands.
//
// Lives in its own file so the same code runs in the MV3 service worker (loaded
// via importScripts from background.js) and under `node --test`, which cannot
// require background.js because that file calls chrome.* at load time.

/** Origin of a URL string, or null when it isn't a parseable absolute URL. */
function originOf(u) {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

/**
 * Error object when `actualUrl` sits on a different origin than the caller
 * expected, else null. Skipped when either side isn't an absolute URL, because
 * the CLI's `url` argument is a substring ("facebook.com"), not a URL — only
 * the relay-supplied `expectUrl` is authoritative here.
 */
function originMismatch(expectUrl, actualUrl) {
  if (!expectUrl || !actualUrl) return null;
  const want = originOf(expectUrl);
  const got = originOf(actualUrl);
  if (!want || !got || want === got) return null;
  return {
    error: `Target tab changed origin: expected ${want}, tab is now ${got}. Refusing to act on it — re-resolve with \`tabs\` or \`ensure <url>\`.`,
    expectedOrigin: want,
    actualOrigin: got,
  };
}

/**
 * Pure target-resolution core (no chrome.* calls, so it is unit-testable).
 *
 * SECURITY — this FAILS CLOSED. When the caller names a target (relay `tabId`,
 * explicit `chromeTabId`, or a `url` substring) and that target cannot be
 * resolved, it returns an error instead of falling back to the active tab.
 *
 * The previous behaviour silently attached the debugger to whatever tab was
 * focused, so a stale, mistyped, or other-profile target read an arbitrary
 * page: a caller that named a shopping tab got the contents of a logged-in
 * myaccount.google.com tab instead. Every cdp-* command could therefore read or
 * click a credential page the caller never asked for, with no error to signal
 * it. The active tab is now used ONLY when the caller named no target at all.
 *
 * `expectUrl` (the URL the relay last recorded for the named tab) is
 * cross-checked by origin, because a relay tab id lives in sessionStorage and
 * so survives navigation: an id captured on site A still resolves after that
 * tab has moved to site B.
 *
 * @param {object} cmd  { chromeTabId?, tabId?, url?, expectUrl? }
 * @param {Array}  tabs  [{ id, url }] snapshot of live tabs
 * @param {Map|object} registry  relay internal tab id -> Chrome tab id
 * @param {number|undefined} activeTabId  the focused tab, for the unnamed case
 * @returns {{tabId, resolvedBy, targetUrl}|{error, resolvedBy}}
 */
function resolveTargetCore(cmd, tabs, registry, activeTabId) {
  const named = !!(cmd.chromeTabId || cmd.tabId || cmd.url);
  const byId = (id) => tabs.find((t) => t.id === id);
  const mapped = (k) => (registry instanceof Map ? registry.get(k) : registry?.[k]);

  let tab = null;
  let resolvedBy = null;

  if (cmd.chromeTabId) {
    tab = byId(cmd.chromeTabId);
    if (!tab) {
      return {
        error: `Target tab not found: chromeTabId ${cmd.chromeTabId} is not open. Refusing to fall back to the active tab.`,
        resolvedBy: "unresolved",
      };
    }
    resolvedBy = "chromeTabId";
  }

  if (!tab && cmd.tabId) {
    const chromeId = mapped(cmd.tabId);
    if (chromeId !== undefined) {
      tab = byId(chromeId);
      if (tab) resolvedBy = "registry";
    }
  }

  // Secondary path for a named tab: the relay attaches that tab's last recorded
  // URL, so a match still lands on the intended tab when the MV3 service
  // worker's in-memory registry has been evicted.
  if (!tab && cmd.url) {
    tab = tabs.find((t) => t.url && t.url.includes(cmd.url));
    if (tab) resolvedBy = "url";
  }

  if (!tab && named) {
    const asked = cmd.tabId ? `tabId ${cmd.tabId}` : `url match "${cmd.url}"`;
    return {
      error: `Target tab not found (${asked}). Refusing to fall back to the active tab. Run \`tabs\` to list live tabs, or \`ensure <url>\` to open one. The tab may have been closed, or it may belong to the other browser profile.`,
      resolvedBy: "unresolved",
    };
  }

  if (!tab) {
    // Nothing named: the active tab is the documented default for this case.
    tab = byId(activeTabId);
    if (!tab) {
      return {
        error: "No debuggable tab found. Name a target tab, or ensure an HTTP/HTTPS tab is active.",
        resolvedBy: "unresolved",
      };
    }
    resolvedBy = "activeTab";
  }

  const mismatch = originMismatch(cmd.expectUrl, tab.url);
  if (mismatch) return { ...mismatch, resolvedBy };

  return { tabId: tab.id, resolvedBy, targetUrl: tab.url || null };
}

// Node (`node --test`) only; in the service worker `module` is undefined and the
// declarations above are already globals reachable from background.js.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { resolveTargetCore, originMismatch, originOf };
}
