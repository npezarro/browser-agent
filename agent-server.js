/**
 * Browser Agent Relay Server
 *
 * Generic command relay between Claude CLI and a Tampermonkey userscript
 * running in the user's real browser. No application-specific logic —
 * just queue commands, collect results, track tabs.
 *
 * PM2: pm2 start agent-server.js --name browser-agent
 * Port: 3102 (behind Apache reverse proxy at /api/browser-agent/)
 */
require("dotenv").config();
const http = require("http");

const PORT = process.env.BROWSER_AGENT_PORT || 3102;
const API_KEY = process.env.BROWSER_AGENT_KEY || "browser-agent-key";

// ── State ──

const agentCommands = {};    // tabId -> [commands]
const agentResults = [];     // circular buffer of results
const MAX_RESULTS = 1000;
const agentTabs = {};        // tabId -> last heartbeat state
const TAB_TTL = 120_000;     // 2 min
const remoteLogs = [];
const MAX_LOGS = 500;
let cmdIdCounter = 0;

// Waiters for synchronous /interactive endpoint
const resultWaiters = {};    // cmdId -> { resolve, timer }

// ── Helpers ──

function parseUrl(req) {
  try { return new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch { return null; }
}

function checkAuth(req) {
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${API_KEY}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 2e6) { req.destroy(); reject(new Error("too large")); }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data));
}

function pruneTabs() {
  const now = Date.now();
  for (const [id, s] of Object.entries(agentTabs)) {
    if (now - s.receivedAt > TAB_TTL) delete agentTabs[id];
  }
}

function pushResult(result) {
  result.ts = Date.now();
  agentResults.push(result);
  if (agentResults.length > MAX_RESULTS) agentResults.shift();

  // Wake any synchronous waiter
  const waiter = resultWaiters[result.id];
  if (waiter) {
    clearTimeout(waiter.timer);
    delete resultWaiters[result.id];
    waiter.resolve(result);
  }
}

// ── Server ──

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  const parsed = parseUrl(req);
  const path = parsed?.pathname || req.url;

  // ── Health ──
  if (req.method === "GET" && path === "/health") {
    pruneTabs();
    return json(res, {
      ok: true,
      tabs: Object.keys(agentTabs).length,
      pendingCommands: Object.values(agentCommands).reduce((s, c) => s + c.length, 0),
      results: agentResults.length,
    });
  }

  // ── Agent endpoints (no auth — called by TM script) ──

  // Heartbeat
  if (req.method === "POST" && path === "/agent/heartbeat") {
    try {
      const state = await readBody(req);
      const tid = state.tabId || "default";
      agentTabs[tid] = { ...state, receivedAt: Date.now() };
      pruneTabs();
    } catch {}
    return json(res, { ok: true });
  }

  // Log
  if (req.method === "POST" && path === "/agent/log") {
    try {
      const { tabId, msg, ts } = await readBody(req);
      const entry = `[${new Date(ts || Date.now()).toISOString()}] [${(tabId || "?").substring(0, 8)}] ${msg}`;
      remoteLogs.push(entry);
      if (remoteLogs.length > MAX_LOGS) remoteLogs.shift();
      console.log(`[Agent] ${msg}`);
    } catch {}
    return json(res, { ok: true });
  }

  // Poll for commands
  if (req.method === "GET" && path === "/agent/commands") {
    const tid = parsed?.searchParams?.get("tabId") || "default";
    const url = parsed?.searchParams?.get("url") || "";
    if (agentTabs[tid]) {
      agentTabs[tid].url = url;
      agentTabs[tid].receivedAt = Date.now();
    }
    const cmds = [...(agentCommands[tid] || []), ...(agentCommands["all"] || [])];
    agentCommands[tid] = [];
    agentCommands["all"] = [];
    return json(res, { commands: cmds });
  }

  // Report result
  if (req.method === "POST" && path === "/agent/result") {
    try {
      const result = await readBody(req);
      pushResult(result);
      console.log(`[Result] cmd=${result.id} ok=${result.ok}`);
    } catch {}
    return json(res, { ok: true });
  }

  // ── Control endpoints (auth required — called by CLI) ──

  // List tabs
  if (req.method === "GET" && path === "/agent/tabs") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    pruneTabs();
    return json(res, { tabs: agentTabs, count: Object.keys(agentTabs).length });
  }

  // Read results
  if (req.method === "GET" && path === "/agent/results") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    const since = parseInt(parsed?.searchParams?.get("since") || "0", 10);
    const cmdId = parsed?.searchParams?.get("cmdId");
    let results = agentResults.slice(since);
    if (cmdId) results = results.filter((r) => r.id === cmdId);
    return json(res, { results, total: agentResults.length });
  }

  // Read logs
  if (req.method === "GET" && path === "/agent/logs") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    const since = parseInt(parsed?.searchParams?.get("since") || "0", 10);
    return json(res, { logs: remoteLogs.slice(since), total: remoteLogs.length });
  }

  // Push command (async — returns immediately)
  if (req.method === "POST" && path === "/agent/command") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    try {
      const { tabId: tid, commands } = await readBody(req);
      const target = tid || "all";
      if (!agentCommands[target]) agentCommands[target] = [];
      const cmds = Array.isArray(commands) ? commands : [commands];
      for (const cmd of cmds) {
        cmd.id = cmd.id || `cmd-${++cmdIdCounter}`;
        agentCommands[target].push(cmd);
      }
      return json(res, { ok: true, queued: cmds.length, ids: cmds.map((c) => c.id) });
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  }

  // Interactive command (synchronous — blocks until result arrives or timeout)
  if (req.method === "POST" && path === "/agent/interactive") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    try {
      const { tabId: tid, command, timeout } = await readBody(req);
      const timeoutMs = Math.min(timeout || 30000, 60000);

      // Pick target tab
      pruneTabs();
      let target = tid;
      if (!target) {
        const tabIds = Object.keys(agentTabs);
        if (tabIds.length === 0) return json(res, { error: "No browser tabs connected" }, 503);
        target = tabIds[0]; // default to first active tab
      }

      // Assign ID and queue
      const cmd = { ...command };
      cmd.id = `cmd-${++cmdIdCounter}`;
      if (!agentCommands[target]) agentCommands[target] = [];
      agentCommands[target].push(cmd);

      // Wait for result
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          delete resultWaiters[cmd.id];
          resolve({ id: cmd.id, ok: false, error: "Timeout waiting for browser response", timedOut: true });
        }, timeoutMs);
        resultWaiters[cmd.id] = { resolve, timer };
      });

      return json(res, result);
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  }

  // ── 404 ──
  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Browser Agent] Listening on http://127.0.0.1:${PORT}`);
});
