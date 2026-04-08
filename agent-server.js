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
const API_KEY = process.env.BROWSER_AGENT_KEY;
if (!API_KEY) {
  console.error("[Browser Agent] BROWSER_AGENT_KEY not set in environment. Exiting.");
  process.exit(1);
}

const fs = require("fs");
const path = require("path");

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

// ── Cowork State ──

const COWORK_DIR = process.env.COWORK_SESSION_DIR || "/home/deployuser/cowork-sessions";
const coworkSessions = {};   // sessionId -> { slug, goal, startedAt, status, turns, lastHeartbeat, capturedAt }
let coworkPending = null;    // CLI-queued session start request

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

// ── Cowork Persistence ──

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function persistCoworkSession(sessionId) {
  const session = coworkSessions[sessionId];
  if (!session) return;

  const date = (session.startedAt || new Date().toISOString()).slice(0, 10);
  const dir = path.join(COWORK_DIR, date);
  ensureDir(dir);

  const filePath = path.join(dir, `${session.slug || sessionId}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify({ id: sessionId, ...session }, null, 2));
  } catch (err) {
    console.error(`[Cowork] Failed to persist JSON: ${err.message}`);
  }
}

function persistCoworkMarkdown(sessionId) {
  const session = coworkSessions[sessionId];
  if (!session || !session.turns?.length) return;

  const date = (session.startedAt || new Date().toISOString()).slice(0, 10);
  const dir = path.join(COWORK_DIR, date);
  ensureDir(dir);

  const md = snapshotToMarkdown(sessionId, session);
  const filePath = path.join(dir, `${session.slug || sessionId}.md`);
  try {
    fs.writeFileSync(filePath, md);
    console.log(`[Cowork] Wrote markdown: ${filePath}`);
  } catch (err) {
    console.error(`[Cowork] Failed to persist markdown: ${err.message}`);
  }
}

function snapshotToMarkdown(sessionId, session) {
  const started = session.startedAt
    ? new Date(session.startedAt).toISOString().replace("T", " ").slice(0, 16)
    : "unknown";

  let md = `# Session: ${session.slug || sessionId}\n`;
  md += `- **Started**: ${started}\n`;
  md += `- **Goal**: ${session.goal || "Cowork session"}\n`;
  md += `- **Status**: ${session.status || "unknown"}\n`;
  md += `- **Source**: cowork-bridge (auto-captured)\n\n`;

  md += `## Turns\n\n`;

  let turnNum = 0;
  for (const turn of session.turns) {
    turnNum++;
    const time = turn.ts
      ? new Date(turn.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
      : "--:--";

    md += `### Turn ${turnNum} — ${time}\n`;
    md += `**${turn.role === "human" ? "User" : "Assistant"}**: ${turn.content.slice(0, 2000)}\n\n`;
  }

  if (session.status === "completed" || session.status === "interrupted") {
    md += `## Final Summary\n`;
    md += `Session ${session.status} with ${session.turns.length} turns. `;
    md += `Reason: ${session.reason || "normal end"}.\n`;
  }

  return md;
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
        // Pick the most recently active tab
        tabIds.sort((a, b) => (agentTabs[b].receivedAt || 0) - (agentTabs[a].receivedAt || 0));
        target = tabIds[0];
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

  // ── Cowork endpoints (no auth — called by Chrome extension) ──

  // Heartbeat
  if (req.method === "POST" && path === "/cowork/heartbeat") {
    try {
      const data = await readBody(req);
      if (data.sessionId && coworkSessions[data.sessionId]) {
        coworkSessions[data.sessionId].lastHeartbeat = Date.now();
        coworkSessions[data.sessionId].status = data.status || "active";
      }
    } catch {}
    return json(res, { ok: true });
  }

  // Snapshot — full session state from extension
  if (req.method === "POST" && path === "/cowork/snapshot") {
    try {
      const data = await readBody(req);
      const sid = data.sessionId;
      if (!sid) return json(res, { error: "sessionId required" }, 400);

      coworkSessions[sid] = {
        ...coworkSessions[sid],
        slug: data.slug,
        goal: data.goal,
        startedAt: data.startedAt,
        status: data.status || "in-progress",
        turns: data.turns || [],
        turnCount: data.turnCount || (data.turns || []).length,
        url: data.url,
        capturedAt: data.capturedAt || new Date().toISOString(),
        lastHeartbeat: Date.now(),
      };

      // Persist to disk
      persistCoworkSession(sid);

      console.log(`[Cowork] Snapshot: ${data.slug} (${(data.turns || []).length} turns)`);
    } catch (err) {
      console.error("[Cowork] Snapshot error:", err.message);
    }
    return json(res, { ok: true });
  }

  // Turn — incremental turn update
  if (req.method === "POST" && path === "/cowork/turn") {
    try {
      const data = await readBody(req);
      const sid = data.sessionId;
      if (sid && coworkSessions[sid] && data.turn) {
        const session = coworkSessions[sid];
        // Add turn if it's genuinely new
        if (data.turnIndex >= session.turns.length) {
          session.turns.push(data.turn);
          session.turnCount = session.turns.length;
          console.log(`[Cowork] Turn ${data.turnIndex}: ${data.turn.role} (${data.turn.content.slice(0, 60)}...)`);
        }
      }
    } catch {}
    return json(res, { ok: true });
  }

  // End — session ended
  if (req.method === "POST" && path === "/cowork/end") {
    try {
      const data = await readBody(req);
      const sid = data.sessionId;
      if (!sid) return json(res, { error: "sessionId required" }, 400);

      // Update or create session record
      coworkSessions[sid] = {
        ...coworkSessions[sid],
        slug: data.slug || coworkSessions[sid]?.slug,
        goal: data.goal || coworkSessions[sid]?.goal,
        startedAt: data.startedAt || coworkSessions[sid]?.startedAt,
        status: data.reason === "page-unload" ? "interrupted" : "completed",
        turns: data.turns || coworkSessions[sid]?.turns || [],
        reason: data.reason,
        endedAt: new Date().toISOString(),
      };
      coworkSessions[sid].turnCount = coworkSessions[sid].turns.length;

      // Persist JSON + markdown
      persistCoworkSession(sid);
      persistCoworkMarkdown(sid);

      console.log(`[Cowork] Session ended: ${coworkSessions[sid].slug} (${data.reason}, ${coworkSessions[sid].turns.length} turns)`);
    } catch (err) {
      console.error("[Cowork] End error:", err.message);
    }
    return json(res, { ok: true });
  }

  // Poll for pending CLI-initiated sessions
  if (req.method === "GET" && path === "/cowork/pending") {
    return json(res, { ok: true, pending: coworkPending });
  }

  // Acknowledge pending session pickup
  if (req.method === "POST" && path === "/cowork/pending/ack") {
    try {
      const data = await readBody(req);
      if (coworkPending && data.requestId === coworkPending.requestId) {
        console.log(`[Cowork] Pending session acknowledged: ${coworkPending.goal}`);
        coworkPending = null;
      }
    } catch {}
    return json(res, { ok: true });
  }

  // Summary — unauthenticated, lightweight session list for the popup
  if (req.method === "GET" && path === "/cowork/summary") {
    const sessions = Object.entries(coworkSessions)
      .map(([id, s]) => ({
        id,
        slug: s.slug,
        goal: s.goal,
        status: s.status,
        turnCount: s.turnCount || 0,
        startedAt: s.startedAt,
      }))
      .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
      .slice(0, 10);
    return json(res, { sessions, count: sessions.length });
  }

  // Config — unauthenticated, serves remote selectors + settings to the extension
  if (req.method === "GET" && path === "/cowork/config") {
    return json(res, {
      selectors: {
        turnElements: '[data-test-id="user-message"], [data-test-id="assistant-message"], [data-testid="user-message"], [data-testid="assistant-message"]',
        userMessage: '[data-test-id="user-message"], [data-testid="user-message"]',
        assistantMessage: '[data-test-id="assistant-message"], [data-testid="assistant-message"]',
        inputField: '[data-test-id="message-input"]',
        sendButton: '[data-test-id="send-button"]',
        modelSelector: 'button[aria-label*="Model selector"]',
      },
      scrapeIntervalMs: 30000,
      version: "1.2.0",
    });
  }

  // ── Cowork control endpoints (auth required — called by CLI) ──

  // List sessions
  if (req.method === "GET" && path === "/cowork/sessions") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    const today = parsed?.searchParams?.get("date") || "";
    const sessions = Object.entries(coworkSessions)
      .filter(([_, s]) => !today || (s.startedAt || "").startsWith(today))
      .map(([id, s]) => ({
        id,
        slug: s.slug,
        goal: s.goal,
        status: s.status,
        turnCount: s.turnCount || 0,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
      }))
      .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    return json(res, { sessions, count: sessions.length });
  }

  // Read specific session
  if (req.method === "GET" && path.startsWith("/cowork/session/")) {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    const sid = path.replace("/cowork/session/", "");
    const session = coworkSessions[sid];
    if (!session) return json(res, { error: "Session not found" }, 404);
    return json(res, { session: { id: sid, ...session } });
  }

  // Check if Cowork is active
  if (req.method === "GET" && path === "/cowork/status") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    const activeSessions = Object.entries(coworkSessions)
      .filter(([_, s]) => s.status === "active" || s.status === "in-progress")
      .filter(([_, s]) => Date.now() - (s.lastHeartbeat || 0) < 60_000)
      .map(([id, s]) => ({ id, slug: s.slug, goal: s.goal, turnCount: s.turnCount }));
    return json(res, {
      active: activeSessions.length > 0,
      sessions: activeSessions,
      pending: !!coworkPending,
    });
  }

  // Queue a new session start request
  if (req.method === "POST" && path === "/cowork/start") {
    if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
    try {
      const data = await readBody(req);
      coworkPending = {
        requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        goal: data.goal || "CLI-initiated session",
        instructions: data.instructions || "",
        queuedAt: new Date().toISOString(),
      };
      console.log(`[Cowork] Session queued by CLI: ${coworkPending.goal}`);
      return json(res, { ok: true, requestId: coworkPending.requestId });
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
