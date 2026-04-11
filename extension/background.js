// Browser Agent Tab Manager — Background Service Worker
// Polls relay server for tab-management commands, executes via chrome.tabs API

const POLL_MS = 2000;
const HEARTBEAT_MS = 10000;
const TAB_ID = "extension";

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
  } catch (e) {
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
    const match = tabs.find((t) => t.url && t.url.startsWith(cmd.url));
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

// --- Badge ---

function updateBadge() {
  chrome.action.setBadgeText({ text: connected ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({
    color: connected ? "#22c55e" : "#ef4444",
  });
}

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
