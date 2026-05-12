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

const http = require("http");
const fs = require("fs");
const pathMod = require("path");
const { execFile } = require("child_process");
const {
  snapshotToMarkdown,
  buildDiscordPayload,
  buildLogEntry,
  pickMostRecentTab,
  pruneByAge,
  pushResult: pushResultCore,
  pruneCommandQueues: pruneCommandQueuesCore,
  appendLog,
  pruneBlobs: pruneBlobsCore,
  buildSessionSummary,
  shouldRouteToExtension,
} = require("./lib/core");

/**
 * Create a Browser Agent server instance with isolated state.
 * @param {object} opts
 * @param {string} opts.apiKey - Required API key for authenticated endpoints
 * @param {string} [opts.agentSecret] - Shared secret for agent endpoints (heartbeat, commands, result, log)
 * @param {number} [opts.port=3102] - Port to listen on
 * @param {string} [opts.coworkDir] - Directory for cowork session persistence
 * @param {string} [opts.coworkRepo] - Directory for cowork git repo sync
 * @param {string} [opts.coworkWebhook] - Discord webhook URL for cowork notifications
 * @returns {{ server: http.Server, state: object, cleanup: () => void }}
 */
function createApp(opts = {}) {
  const API_KEY = opts.apiKey;
  const AGENT_SECRET = opts.agentSecret;
  const homeDir = process.env.HOME || "/tmp";
  const COWORK_DIR = opts.coworkDir || `${homeDir}/cowork-sessions`;
  const COWORK_REPO = opts.coworkRepo || `${homeDir}/my-claude-cowork`;
  const COWORK_WEBHOOK = opts.coworkWebhook || "";

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

  // ── Extension State ──
  let extLastHeartbeat = 0;
  const EXT_TTL = 30_000;      // 30s — extension heartbeat timeout
  const extCommands = [];       // queued commands for extension

  // ── Upload Blob Store ──
  const uploadBlobs = {};      // blobId -> { base64, filename, mimetype, ts }
  const BLOB_TTL = 300_000;    // 5 min

  function pruneBlobs() {
    pruneBlobsCore(uploadBlobs, BLOB_TTL);
  }

  // ── Periodic cleanup for leaked state ──

  const WAITER_TTL = 600_000;     // 10 min — max time a resultWaiter can live

  function pruneResultWaiters() {
    const now = Date.now();
    for (const [id, w] of Object.entries(resultWaiters)) {
      if (w.createdAt && now - w.createdAt > WAITER_TTL) {
        clearTimeout(w.timer);
        delete resultWaiters[id];
        console.log(`[Cleanup] Expired stale resultWaiter: ${id}`);
      }
    }
  }

  function pruneCommandQueues() {
    pruneTabs();
    const dropped = pruneCommandQueuesCore(agentCommands, Object.keys(agentTabs));
    for (const [tabId, count] of Object.entries(dropped)) {
      console.log(`[Cleanup] Dropped ${count} orphaned commands for dead tab ${tabId.substring(0, 8)}`);
    }
  }

  // Timers (stored for cleanup)
  const timers = [];
  if (!opts._skipTimers) {
    timers.push(setInterval(pruneBlobs, 60_000));
    timers.push(setInterval(() => {
      pruneTabs();
      pruneResultWaiters();
      pruneCommandQueues();
    }, 30_000));
  }

  // ── Cowork State ──
  const coworkSessions = {};
  let coworkPending = null;

  // ── Helpers ──

  function parseUrl(req) {
    try { return new URL(req.url, `http://${req.headers.host || "localhost"}`); }
    catch { return null; }
  }

  function checkAuth(req) {
    const auth = req.headers.authorization || "";
    return auth === `Bearer ${API_KEY}`;
  }

  function checkAgentAuth(req) {
    if (!AGENT_SECRET) return true; // No secret configured = open (backwards compatible)
    const provided = req.headers["x-agent-secret"] || "";
    return provided === AGENT_SECRET;
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

  function readBodyLarge(req, maxBytes = 10e6) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > maxBytes) { req.destroy(); reject(new Error("too large")); }
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
    pruneByAge(agentTabs, TAB_TTL, "receivedAt");
  }

  function pushResult(result) {
    pushResultCore(result, agentResults, MAX_RESULTS, resultWaiters);
  }

  // ── Cowork Persistence ──

  function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignored */ }
  }

  function persistCoworkSession(sessionId) {
    const session = coworkSessions[sessionId];
    if (!session) return;

    const date = (session.startedAt || new Date().toISOString()).slice(0, 10);
    const dir = pathMod.join(COWORK_DIR, date);
    ensureDir(dir);

    const filePath = pathMod.join(dir, `${session.slug || sessionId}.json`);
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
    const dir = pathMod.join(COWORK_DIR, date);
    ensureDir(dir);

    const md = snapshotToMarkdown(sessionId, session);
    const filePath = pathMod.join(dir, `${session.slug || sessionId}.md`);
    try {
      fs.writeFileSync(filePath, md);
      console.log(`[Cowork] Wrote markdown: ${filePath}`);
    } catch (err) {
      console.error(`[Cowork] Failed to persist markdown: ${err.message}`);
    }
  }

  // ── Cowork Discord Posting ──

  function postToDiscord(session) {
    if (!COWORK_WEBHOOK) {
      console.log("[Cowork] No DISCORD_COWORK_WEBHOOK_URL set, skipping Discord post");
      return;
    }

    const embed = buildDiscordPayload(session);
    embed.embeds[0].timestamp = new Date().toISOString();
    const payload = JSON.stringify(embed);

    const url = new URL(`${COWORK_WEBHOOK}?wait=true`);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    };

    const https = require("https");
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[Cowork] Discord posted: ${session.slug}`);
        } else {
          console.error(`[Cowork] Discord post failed (${res.statusCode}): ${body.slice(0, 200)}`);
        }
      });
    });
    req.on("error", (err) => console.error(`[Cowork] Discord post error: ${err.message}`));
    req.write(payload);
    req.end();
  }

  // ── Cowork Git Sync ──

  function syncToGitRepo(sessionId) {
    const session = coworkSessions[sessionId];
    if (!session || !session.turns?.length) return;

    try {
      if (!fs.existsSync(pathMod.join(COWORK_REPO, ".git"))) {
        console.log(`[Cowork] Git repo not found at ${COWORK_REPO}, cloning...`);
        const coworkRepoUrl = process.env.COWORK_REPO_URL || `https://github.com/${process.env.GITHUB_USER || "npezarro"}/my-claude-cowork.git`;
        execFile("git", ["clone", coworkRepoUrl, COWORK_REPO], (err) => {
          if (err) console.error(`[Cowork] Git clone failed: ${err.message}`);
          else doGitSync(sessionId);
        });
        return;
      }
    } catch { /* ignored */ }

    doGitSync(sessionId);
  }

  function doGitSync(sessionId) {
    const session = coworkSessions[sessionId];
    if (!session) return;

    const date = (session.startedAt || new Date().toISOString()).slice(0, 10);
    const sessionDir = pathMod.join(COWORK_REPO, "sessions", date);
    ensureDir(sessionDir);

    const md = snapshotToMarkdown(sessionId, session);
    const mdPath = pathMod.join(sessionDir, `${session.slug || sessionId}.md`);

    try {
      fs.writeFileSync(mdPath, md);
    } catch (err) {
      console.error(`[Cowork] Failed to write session to repo: ${err.message}`);
      return;
    }

    const gitOpts = { cwd: COWORK_REPO };
    execFile("git", ["add", "sessions/"], gitOpts, (err) => {
      if (err) { console.error(`[Cowork] git add failed: ${err.message}`); return; }

      const msg = `Auto-capture: ${session.slug} (${session.turns.length} turns)`;
      execFile("git", ["commit", "-m", msg], gitOpts, (err) => {
        if (err) {
          if (err.message.includes("nothing to commit")) {
            console.log("[Cowork] Git: nothing new to commit");
          } else {
            console.error(`[Cowork] git commit failed: ${err.message}`);
          }
          return;
        }

        execFile("git", ["push", "origin", "master"], gitOpts, (err) => {
          if (err) {
            execFile("git", ["push", "origin", "main"], gitOpts, (err2) => {
              if (err2) console.error(`[Cowork] git push failed: ${err2.message}`);
              else console.log(`[Cowork] Git synced: ${session.slug} → main`);
            });
          } else {
            console.log(`[Cowork] Git synced: ${session.slug} → master`);
          }
        });
      });
    });
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
        status: "ok",
        service: "browser-agent",
        uptime: Math.floor(process.uptime()),
        connectedClients: Object.keys(agentTabs).length,
        pendingCommands: Object.values(agentCommands).reduce((s, c) => s + c.length, 0),
        results: agentResults.length,
      });
    }

    // ── Agent endpoints (shared secret auth — called by TM script / extension) ──

    // Heartbeat
    if (req.method === "POST" && path === "/agent/heartbeat") {
      if (!checkAgentAuth(req)) return json(res, { error: "Unauthorized" }, 401);
      try {
        const state = await readBody(req);
        const tid = state.tabId || "default";
        agentTabs[tid] = { ...state, receivedAt: Date.now() };
        pruneTabs();
      } catch { /* ignored */ }
      return json(res, { ok: true });
    }

    // Log
    if (req.method === "POST" && path === "/agent/log") {
      if (!checkAgentAuth(req)) return json(res, { error: "Unauthorized" }, 401);
      try {
        const { tabId, msg, ts } = await readBody(req);
        const entry = buildLogEntry(tabId, msg, ts);
        appendLog(remoteLogs, entry, MAX_LOGS);
        console.log(`[Agent] ${msg}`);
      } catch { /* ignored */ }
      return json(res, { ok: true });
    }

    // Poll for commands
    if (req.method === "GET" && path === "/agent/commands") {
      if (!checkAgentAuth(req)) return json(res, { error: "Unauthorized" }, 401);
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
      if (!checkAgentAuth(req)) return json(res, { error: "Unauthorized" }, 401);
      try {
        const result = await readBody(req);
        pushResult(result);
        console.log(`[Result] cmd=${result.id} ok=${result.ok}`);
      } catch { /* ignored */ }
      return json(res, { ok: true });
    }

    // ── Upload blob endpoints ──

    // Store blob for TM script to fetch (auth required — called by CLI)
    if (req.method === "POST" && path === "/agent/upload-blob") {
      if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
      try {
        const { blobId, base64, filename, mimetype } = await readBodyLarge(req);
        if (!blobId || !base64) return json(res, { error: "blobId and base64 required" }, 400);
        uploadBlobs[blobId] = { base64, filename: filename || "file", mimetype: mimetype || "application/octet-stream", ts: Date.now() };
        pruneBlobs();
        console.log(`[Upload] Stored blob ${blobId} (${(base64.length * 0.75 / 1024).toFixed(0)}KB, ${filename})`);
        return json(res, { ok: true, blobId });
      } catch (err) {
        return json(res, { error: err.message }, 400);
      }
    }

    // Serve blob to agent scripts (auth via agent secret)
    if (req.method === "GET" && path.startsWith("/agent/blob/")) {
      if (!checkAgentAuth(req)) return json(res, { error: "Unauthorized" }, 401);
      const blobId = path.replace("/agent/blob/", "");
      const blob = uploadBlobs[blobId];
      if (!blob) return json(res, { error: "Blob not found or expired" }, 404);
      return json(res, { ok: true, base64: blob.base64, filename: blob.filename, mimetype: blob.mimetype });
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
        const timeoutMs = Math.min(timeout || 30000, 300000);

        // Check if this is a tab-management command and extension is connected
        if (shouldRouteToExtension(command.action, extLastHeartbeat, EXT_TTL)) {
          // Route to extension instead of TM script
          const cmd = { ...command };
          cmd.id = `cmd-${++cmdIdCounter}`;
          extCommands.push(cmd);
          console.log(`[Ext Route] ${cmd.action} → extension (cmd=${cmd.id})`);

          const result = await new Promise((resolve) => {
            const timer = setTimeout(() => {
              delete resultWaiters[cmd.id];
              resolve({ id: cmd.id, ok: false, error: "Timeout waiting for extension response", timedOut: true });
            }, timeoutMs);
            resultWaiters[cmd.id] = { resolve, timer, createdAt: Date.now() };
          });

          return json(res, result);
        }

        // Pick target tab (standard TM script routing)
        pruneTabs();
        let target = tid;
        if (!target) {
          target = pickMostRecentTab(agentTabs);
          if (!target) return json(res, { error: "No browser tabs connected" }, 503);
        }

        // Assign ID and queue (pass timeout to TM script so it doesn't kill slow commands)
        const cmd = { ...command };
        cmd.id = `cmd-${++cmdIdCounter}`;
        cmd.timeout = timeoutMs;
        if (!agentCommands[target]) agentCommands[target] = [];
        agentCommands[target].push(cmd);

        // Wait for result
        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            delete resultWaiters[cmd.id];
            resolve({ id: cmd.id, ok: false, error: "Timeout waiting for browser response", timedOut: true });
          }, timeoutMs);
          resultWaiters[cmd.id] = { resolve, timer, createdAt: Date.now() };
        });

        return json(res, result);
      } catch (err) {
        return json(res, { error: err.message }, 400);
      }
    }

    // ── Extension endpoints (auth required) ──

    if (req.method === "POST" && path === "/ext/heartbeat") {
      if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
      try {
        const state = await readBody(req);
        extLastHeartbeat = Date.now();
        console.log(`[Ext] Heartbeat — tabs: ${state.tabCount || "?"}`);
      } catch { /* ignored */ }
      return json(res, { ok: true });
    }

    if (req.method === "GET" && path === "/ext/commands") {
      if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
      const cmds = extCommands.splice(0, extCommands.length);
      return json(res, { commands: cmds });
    }

    if (req.method === "POST" && path === "/ext/result") {
      if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
      try {
        const result = await readBody(req);
        pushResult(result);
        console.log(`[Ext Result] cmd=${result.id} ok=${result.ok}`);
      } catch { /* ignored */ }
      return json(res, { ok: true });
    }

    if (req.method === "GET" && path === "/ext/status") {
      if (!checkAuth(req)) return json(res, { error: "Unauthorized" }, 401);
      const alive = Date.now() - extLastHeartbeat < EXT_TTL;
      return json(res, { connected: alive, lastHeartbeat: extLastHeartbeat });
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
      } catch { /* ignored */ }
      return json(res, { ok: true });
    }

    // Snapshot — full session state from extension
    if (req.method === "POST" && path === "/cowork/snapshot") {
      try {
        const data = await readBody(req);
        const sid = data.sessionId;
        if (!sid) return json(res, { error: "sessionId required" }, 400);

        const newTurnCount = (data.turns || []).length;
        const existing = coworkSessions[sid];

        // Multi-session detection: if turn count dropped, user cleared chat
        if (existing && existing.turns?.length > 0 && newTurnCount < existing.turns.length) {
          console.log(`[Cowork] Chat cleared detected (${existing.turns.length} → ${newTurnCount}). Ending previous session.`);

          // End the old session
          existing.status = "completed";
          existing.reason = "chat-cleared";
          existing.endedAt = new Date().toISOString();
          persistCoworkSession(sid);
          persistCoworkMarkdown(sid);
          postToDiscord(existing);
          syncToGitRepo(sid);

          // Start fresh — create new session ID by appending a counter
          const newSid = `${sid}-${Date.now()}`;
          coworkSessions[newSid] = {
            slug: `${data.slug}-${Date.now().toString(36).slice(-4)}`,
            goal: data.goal,
            startedAt: data.capturedAt || new Date().toISOString(),
            status: "in-progress",
            turns: data.turns || [],
            turnCount: newTurnCount,
            model: data.model,
            url: data.url,
            capturedAt: data.capturedAt || new Date().toISOString(),
            lastHeartbeat: Date.now(),
          };
          persistCoworkSession(newSid);
          console.log(`[Cowork] New session after clear: ${coworkSessions[newSid].slug}`);
          return json(res, { ok: true, newSessionId: newSid });
        }

        coworkSessions[sid] = {
          ...existing,
          slug: data.slug,
          goal: data.goal,
          startedAt: data.startedAt || existing?.startedAt,
          status: data.status || "in-progress",
          turns: data.turns || [],
          turnCount: newTurnCount,
          model: data.model,
          url: data.url,
          capturedAt: data.capturedAt || new Date().toISOString(),
          lastHeartbeat: Date.now(),
        };

        // Persist to disk
        persistCoworkSession(sid);

        console.log(`[Cowork] Snapshot: ${data.slug} (${newTurnCount} turns)`);
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
      } catch { /* ignored */ }
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

        // Post to Discord #cowork
        postToDiscord(coworkSessions[sid]);

        // Sync to my-claude-cowork git repo
        syncToGitRepo(sid);

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
      } catch { /* ignored */ }
      return json(res, { ok: true });
    }

    // Summary — unauthenticated, lightweight session list for the popup
    if (req.method === "GET" && path === "/cowork/summary") {
      const sessions = buildSessionSummary(coworkSessions, 10);
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

  return {
    server,
    state: { agentCommands, agentResults, agentTabs, remoteLogs, resultWaiters, extCommands, uploadBlobs, coworkSessions, get extLastHeartbeat() { return extLastHeartbeat; }, set extLastHeartbeat(v) { extLastHeartbeat = v; }, get coworkPending() { return coworkPending; }, set coworkPending(v) { coworkPending = v; } },
    cleanup() {
      for (const t of timers) clearInterval(t);
      // Clear any pending result waiters
      for (const [id, w] of Object.entries(resultWaiters)) {
        clearTimeout(w.timer);
        delete resultWaiters[id];
      }
    },
  };
}

// ── Auto-start when run directly ──

if (require.main === module) {
  require("dotenv").config();

  const PORT = process.env.BROWSER_AGENT_PORT || 3102;
  const API_KEY = process.env.BROWSER_AGENT_KEY;
  if (!API_KEY) {
    console.error("[Browser Agent] BROWSER_AGENT_KEY not set in environment. Exiting.");
    process.exit(1);
  }

  const AGENT_SECRET = process.env.BROWSER_AGENT_AGENT_SECRET;
  if (!AGENT_SECRET) {
    console.warn("[Browser Agent] BROWSER_AGENT_AGENT_SECRET not set. Agent endpoints are unauthenticated.");
  }

  const app = createApp({
    apiKey: API_KEY,
    agentSecret: AGENT_SECRET,
    port: PORT,
    coworkDir: process.env.COWORK_SESSION_DIR,
    coworkRepo: process.env.COWORK_REPO_DIR,
    coworkWebhook: process.env.DISCORD_COWORK_WEBHOOK_URL,
  });

  app.server.listen(PORT, "127.0.0.1", () => {
    console.log(`[Browser Agent] Listening on http://127.0.0.1:${PORT}`);
  });
}

module.exports = { createApp };
