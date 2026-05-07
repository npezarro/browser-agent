// Browser Agent Tab Manager — Background Service Worker
// Polls relay server for tab-management commands, executes via chrome.tabs API

const POLL_MS = 2000;
const HEARTBEAT_MS = 10000;

let apiUrl = "";
let apiKey = "";
let connected = false;
let pollTimer = null;
let heartbeatTimer = null;

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

async function cmdCloseTab(cmd) {
  // Find tab by URL prefix or chromeTabId
  let tabId = cmd.chromeTabId;
  if (!tabId && cmd.url) {
    const tabs = await chrome.tabs.query({ url: cmd.url + "*" });
    if (tabs.length > 0) tabId = tabs[0].id;
  }
  if (!tabId) return { closed: false, error: "Tab not found" };

  await chrome.tabs.remove(tabId);
  return { closed: true, chromeTabId: tabId };
}

async function cmdFocusTab(cmd) {
  let tabId = cmd.chromeTabId;
  if (!tabId && cmd.url) {
    const tabs = await chrome.tabs.query({});
    const match = tabs.find((t) => t.url && t.url.includes(cmd.url));
    if (match) tabId = match.id;
  }
  if (!tabId) return { focused: false, error: "Tab not found" };

  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { focused: true, chromeTabId: tabId };
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
  // Find the tab to capture — by chromeTabId or URL, or use the active tab
  let tabId = cmd.chromeTabId;
  let windowId;
  if (!tabId && cmd.url) {
    const tabs = await chrome.tabs.query({});
    const match = tabs.find((t) => t.url && t.url.startsWith(cmd.url));
    if (match) {
      tabId = match.id;
      windowId = match.windowId;
    }
  }
  if (!tabId) {
    // Fallback: capture active tab in current window
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active) {
      tabId = active.id;
      windowId = active.windowId;
    }
  }
  if (!tabId) return { error: "No tab found to capture" };

  // Focus the tab first so captureVisibleTab captures the right content
  if (windowId) {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(windowId, { focused: true });
    // Brief delay for render
    await new Promise((r) => setTimeout(r, 500));
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: cmd.format || "png",
    quality: cmd.quality || 90,
  });
  return { dataUrl, chromeTabId: tabId };
}

// --- CDP Commands (trusted input via chrome.debugger) ---

// Helper: find Chrome tab ID by URL match or chromeTabId
async function resolveTabId(cmd) {
  if (cmd.chromeTabId) return cmd.chromeTabId;
  if (cmd.url) {
    const tabs = await chrome.tabs.query({});
    const match = tabs.find(
      (t) => t.url && t.url.includes(cmd.url)
    );
    if (match) return match.id;
  }
  // Fallback: active tab (only HTTP/HTTPS — chrome:// tabs can't be debugged)
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: ["http://*/*", "https://*/*"],
  });
  return active?.id;
}

// Attach debugger, run fn, detach
async function withDebugger(tabId, fn) {
  if (!tabId) return { error: "No debuggable tab found. Specify a target URL or ensure an HTTP/HTTPS tab is active." };
  // Validate tab URL is debuggable (chrome://, about:, edge:// cannot be debugged)
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && /^(chrome|chrome-extension|about|edge):/.test(tab.url)) {
      return { error: `Cannot debug internal browser page (${tab.url}). Navigate to an HTTP/HTTPS page first.` };
    }
  } catch (e) {
    return { error: `Tab ${tabId} not found: ${e.message}` };
  }
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    return await fn(target);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
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
 * cmd: { url?, chromeTabId?, text, selector?, delay? }
 */
async function cmdCdpType(cmd) {
  const tabId = await resolveTabId(cmd);
  if (!tabId) return { error: "Tab not found" };

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
    const delay = cmd.delay || 30;
    for (const char of cmd.text) {
      const keyCode = char.charCodeAt(0);
      // keyDown without text — text only in char event to avoid double insertion
      await cdp(target, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: char,
        code: `Key${char.toUpperCase()}`,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
      await cdp(target, "Input.dispatchKeyEvent", {
        type: "char",
        text: char,
        key: char,
        code: `Key${char.toUpperCase()}`,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
      await cdp(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: char,
        code: `Key${char.toUpperCase()}`,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
      await new Promise((r) => setTimeout(r, delay));
    }

    return { typed: true, length: cmd.text.length, method: "cdp-keyevent" };
  });
}

/**
 * Click at an element's position using CDP Input.dispatchMouseEvent.
 * Trusted click — bypasses isTrusted checks.
 *
 * cmd: { url?, chromeTabId?, selector, x?, y? }
 */
async function cmdCdpClick(cmd) {
  const tabId = await resolveTabId(cmd);
  if (!tabId) return { error: "Tab not found" };

  return withDebugger(tabId, async (target) => {
    // Get element position
    const evalResult = await cdp(target, "Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(cmd.selector)});
        if (!el) return JSON.stringify({error: 'not found'});
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()`,
      returnByValue: true,
    });

    const pos = JSON.parse(evalResult.result.value);
    if (pos.error) return { clicked: false, error: pos.error };

    const x = cmd.x || pos.x;
    const y = cmd.y || pos.y;

    // mouseMoved first — React event delegation needs this
    await cdp(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await new Promise((r) => setTimeout(r, 50));
    await cdp(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await cdp(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });

    return { clicked: true, x, y, method: "cdp" };
  });
}

/**
 * Evaluate JS in the page context via CDP Runtime.evaluate.
 * Bypasses CSP — works on Facebook, Google Photos, etc.
 *
 * cmd: { url?, chromeTabId?, expression }
 */
async function cmdCdpEval(cmd) {
  const tabId = await resolveTabId(cmd);
  if (!tabId) return { error: "Tab not found" };

  // Focus the tab before eval (needed for virtual rendering / IntersectionObserver)
  if (cmd.focus) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await new Promise((r) => setTimeout(r, cmd.focusDelay || 1500));
    } catch (_) { /* best effort */ }
  }

  return withDebugger(tabId, async (target) => {
    // Progressive scroll to trigger IntersectionObserver-based virtual rendering
    if (cmd.scroll) {
      const steps = cmd.scrollSteps || 6;
      const stepPx = cmd.scrollStep || 600;
      const delay = cmd.scrollDelay || 400;
      for (let i = 0; i <= steps; i++) {
        await cdp(target, "Runtime.evaluate", {
          expression: `window.scrollTo(0, ${i * stepPx})`,
          returnByValue: true,
        });
        // Force paint via double-rAF
        await cdp(target, "Runtime.evaluate", {
          expression: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
          returnByValue: true,
          awaitPromise: true,
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
    return { value: result.result.value };
  });
}

/**
 * Send special key events (ArrowDown, Enter, Tab, Escape, etc.) via CDP.
 * Each key in the array gets keyDown + keyUp dispatched.
 *
 * cmd: { url?, chromeTabId?, keys: [{key, code, keyCode}] }
 */
async function cmdCdpKeys(cmd) {
  const tabId = await resolveTabId(cmd);
  if (!tabId) return { error: "Tab not found" };

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
    return { sent: true, count: cmd.keys.length };
  });
}

/**
 * Capture network responses matching a URL pattern via CDP Network domain.
 * Bypasses virtual rendering entirely by intercepting the raw API response.
 *
 * cmd: { url?, chromeTabId?, urlPattern, reload?, timeout?, maxLen?, maxCaptures? }
 */
async function cmdCdpNetworkCapture(cmd) {
  const tabId = await resolveTabId(cmd);
  if (!tabId) return { error: "Tab not found" };

  // Focus tab first
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) { /* best effort */ }

  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");

  try {
    await cdp(target, "Network.enable", {});

    const captured = [];
    const urlPattern = cmd.urlPattern || "";
    const timeout = cmd.timeout || 30000;
    const maxCaptures = cmd.maxCaptures || 1;
    const maxLen = cmd.maxLen || 100000;

    const responsePromise = new Promise((resolve) => {
      const pendingRequests = new Map();

      const onEvent = (source, method, params) => {
        if (source.tabId !== tabId) return;

        if (method === "Network.responseReceived") {
          const respUrl = params.response.url;
          if (respUrl.includes(urlPattern)) {
            pendingRequests.set(params.requestId, respUrl);
          }
        }

        if (method === "Network.loadingFinished") {
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
        resolve(captured);
      }, timeout);
    });

    // Reload page to trigger network requests
    if (cmd.reload !== false) {
      await new Promise((r) => setTimeout(r, 500));
      await cdp(target, "Page.reload", {});
    }

    const results = await responsePromise;
    return { captured: results.length, responses: results };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
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

// Keepalive alarm for MV3 service worker
chrome.alarms?.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") poll();
});

start();
