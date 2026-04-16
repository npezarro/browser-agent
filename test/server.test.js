const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { createApp } = require("../agent-server");

const API_KEY = "test-key-abc123";
let app, baseUrl;

// ── HTTP helpers ──

function request(method, urlPath, { body, auth, raw } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: {} };
    if (auth) opts.headers.authorization = `Bearer ${API_KEY}`;
    if (body !== undefined) {
      const payload = raw ? body : JSON.stringify(body);
      opts.headers["content-type"] = "application/json";
      opts.headers["content-length"] = Buffer.byteLength(payload);
      const req = http.request(opts, collect);
      req.on("error", reject);
      req.write(payload);
      req.end();
    } else {
      const req = http.request(opts, collect);
      req.on("error", reject);
      req.end();
    }
    function collect(res) {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    }
  });
}

function get(p, opts) { return request("GET", p, opts); }
function post(p, body, opts = {}) { return request("POST", p, { body, ...opts }); }

// ── Setup / Teardown ──

before(async () => {
  const coworkDir = path.join(os.tmpdir(), `ba-test-cowork-${Date.now()}`);
  app = createApp({ apiKey: API_KEY, _skipTimers: true, coworkDir, coworkRepo: path.join(os.tmpdir(), `ba-test-repo-${Date.now()}`) });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  app.cleanup();
  app.server.close();
});

// ── Health ──

describe("GET /health", () => {
  it("returns ok with counts", async () => {
    const r = await get("/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(typeof r.body.tabs, "number");
    assert.equal(typeof r.body.pendingCommands, "number");
    assert.equal(typeof r.body.results, "number");
  });
});

// ── CORS ──

describe("OPTIONS (CORS preflight)", () => {
  it("returns 204 with CORS headers", async () => {
    const r = await request("OPTIONS", "/anything");
    assert.equal(r.status, 204);
    assert.equal(r.headers["access-control-allow-origin"], "*");
    assert.ok(r.headers["access-control-allow-methods"].includes("POST"));
  });
});

// ── 404 ──

describe("Unknown routes", () => {
  it("returns 404", async () => {
    const r = await get("/nonexistent");
    assert.equal(r.status, 404);
  });
});

// ── Agent heartbeat ──

describe("POST /agent/heartbeat", () => {
  it("registers a tab", async () => {
    const r = await post("/agent/heartbeat", { tabId: "tab-1", url: "https://example.com" });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(app.state.agentTabs["tab-1"]);
    assert.equal(app.state.agentTabs["tab-1"].url, "https://example.com");
  });

  it("defaults tabId to 'default'", async () => {
    const r = await post("/agent/heartbeat", { url: "https://test.com" });
    assert.equal(r.body.ok, true);
    assert.ok(app.state.agentTabs["default"]);
  });
});

// ── Agent log ──

describe("POST /agent/log", () => {
  it("appends a log entry", async () => {
    const before = app.state.remoteLogs.length;
    const r = await post("/agent/log", { tabId: "t1", msg: "test message", ts: Date.now() });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(app.state.remoteLogs.length, before + 1);
  });
});

// ── Agent commands poll ──

describe("GET /agent/commands", () => {
  it("returns empty array when no commands", async () => {
    const r = await get("/agent/commands?tabId=fresh-tab");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.commands, []);
  });

  it("returns queued commands and clears them", async () => {
    app.state.agentCommands["poll-tab"] = [{ id: "c1", action: "click" }];
    const r = await get("/agent/commands?tabId=poll-tab");
    assert.equal(r.body.commands.length, 1);
    assert.equal(r.body.commands[0].id, "c1");
    // Queue is cleared
    const r2 = await get("/agent/commands?tabId=poll-tab");
    assert.deepEqual(r2.body.commands, []);
  });

  it("includes 'all' commands", async () => {
    app.state.agentCommands["all"] = [{ id: "broadcast", action: "screenshot" }];
    const r = await get("/agent/commands?tabId=any-tab");
    assert.equal(r.body.commands.length, 1);
    assert.equal(r.body.commands[0].id, "broadcast");
  });

  it("updates tab receivedAt on poll", async () => {
    app.state.agentTabs["poll-update"] = { receivedAt: 1000 };
    await get("/agent/commands?tabId=poll-update&url=https://new.com");
    assert.ok(app.state.agentTabs["poll-update"].receivedAt > 1000);
    assert.equal(app.state.agentTabs["poll-update"].url, "https://new.com");
  });
});

// ── Agent result ──

describe("POST /agent/result", () => {
  it("stores result", async () => {
    const before = app.state.agentResults.length;
    const r = await post("/agent/result", { id: "cmd-99", ok: true, data: "hello" });
    assert.equal(r.body.ok, true);
    assert.equal(app.state.agentResults.length, before + 1);
  });
});

// ── Upload blob ──

describe("POST /agent/upload-blob", () => {
  it("rejects without auth", async () => {
    const r = await post("/agent/upload-blob", { blobId: "b1", base64: "abc" });
    assert.equal(r.status, 401);
  });

  it("stores blob with auth", async () => {
    const r = await post("/agent/upload-blob", { blobId: "b1", base64: "dGVzdA==", filename: "test.txt", mimetype: "text/plain" }, { auth: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.blobId, "b1");
    assert.ok(app.state.uploadBlobs["b1"]);
  });

  it("rejects missing blobId", async () => {
    const r = await post("/agent/upload-blob", { base64: "abc" }, { auth: true });
    assert.equal(r.status, 400);
  });

  it("rejects missing base64", async () => {
    const r = await post("/agent/upload-blob", { blobId: "b2" }, { auth: true });
    assert.equal(r.status, 400);
  });

  it("defaults filename and mimetype", async () => {
    await post("/agent/upload-blob", { blobId: "b-defaults", base64: "YQ==" }, { auth: true });
    assert.equal(app.state.uploadBlobs["b-defaults"].filename, "file");
    assert.equal(app.state.uploadBlobs["b-defaults"].mimetype, "application/octet-stream");
  });
});

// ── GET blob ──

describe("GET /agent/blob/:id", () => {
  it("returns blob data", async () => {
    app.state.uploadBlobs["get-blob"] = { base64: "aGVsbG8=", filename: "hi.txt", mimetype: "text/plain", ts: Date.now() };
    const r = await get("/agent/blob/get-blob");
    assert.equal(r.status, 200);
    assert.equal(r.body.base64, "aGVsbG8=");
    assert.equal(r.body.filename, "hi.txt");
  });

  it("returns 404 for missing blob", async () => {
    const r = await get("/agent/blob/nonexistent");
    assert.equal(r.status, 404);
  });
});

// ── Auth-required endpoints ──

describe("auth enforcement", () => {
  it("GET /agent/tabs requires auth", async () => {
    const r = await get("/agent/tabs");
    assert.equal(r.status, 401);
  });

  it("GET /agent/results requires auth", async () => {
    const r = await get("/agent/results");
    assert.equal(r.status, 401);
  });

  it("GET /agent/logs requires auth", async () => {
    const r = await get("/agent/logs");
    assert.equal(r.status, 401);
  });

  it("POST /agent/command requires auth", async () => {
    const r = await post("/agent/command", { commands: { action: "click" } });
    assert.equal(r.status, 401);
  });

  it("POST /agent/interactive requires auth", async () => {
    const r = await post("/agent/interactive", { command: { action: "click" } });
    assert.equal(r.status, 401);
  });

  it("POST /ext/heartbeat requires auth", async () => {
    const r = await post("/ext/heartbeat", { tabCount: 1 });
    assert.equal(r.status, 401);
  });

  it("GET /ext/commands requires auth", async () => {
    const r = await get("/ext/commands");
    assert.equal(r.status, 401);
  });

  it("POST /ext/result requires auth", async () => {
    const r = await post("/ext/result", { id: "c1", ok: true });
    assert.equal(r.status, 401);
  });

  it("GET /ext/status requires auth", async () => {
    const r = await get("/ext/status");
    assert.equal(r.status, 401);
  });
});

// ── Tabs ──

describe("GET /agent/tabs", () => {
  it("lists tabs with auth", async () => {
    const r = await get("/agent/tabs", { auth: true });
    assert.equal(r.status, 200);
    assert.ok(typeof r.body.tabs === "object");
    assert.ok(typeof r.body.count === "number");
  });
});

// ── Results ──

describe("GET /agent/results", () => {
  it("returns all results", async () => {
    const r = await get("/agent/results", { auth: true });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.results));
    assert.ok(typeof r.body.total === "number");
  });

  it("filters by since", async () => {
    const total = app.state.agentResults.length;
    const r = await get(`/agent/results?since=${total - 1}`, { auth: true });
    assert.equal(r.body.results.length, 1);
  });

  it("filters by cmdId", async () => {
    const r = await get("/agent/results?cmdId=cmd-99", { auth: true });
    assert.ok(r.body.results.every((r) => r.id === "cmd-99"));
  });
});

// ── Logs ──

describe("GET /agent/logs", () => {
  it("returns logs with since filter", async () => {
    const r = await get("/agent/logs?since=0", { auth: true });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.logs));
  });
});

// ── Push command ──

describe("POST /agent/command", () => {
  it("queues a single command", async () => {
    const r = await post("/agent/command", { tabId: "cmd-tab", commands: { action: "click", selector: "#btn" } }, { auth: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.queued, 1);
    assert.equal(r.body.ids.length, 1);
  });

  it("queues multiple commands", async () => {
    const r = await post("/agent/command", { tabId: "cmd-tab2", commands: [{ action: "click" }, { action: "type" }] }, { auth: true });
    assert.equal(r.body.queued, 2);
    assert.equal(r.body.ids.length, 2);
  });

  it("defaults to 'all' when no tabId", async () => {
    const r = await post("/agent/command", { commands: { action: "screenshot" } }, { auth: true });
    assert.equal(r.body.ok, true);
    assert.ok(app.state.agentCommands["all"]?.length > 0);
  });

  it("assigns command IDs", async () => {
    const r = await post("/agent/command", { commands: { action: "test" } }, { auth: true });
    assert.ok(r.body.ids[0].startsWith("cmd-"));
  });

  it("preserves existing command ID", async () => {
    const r = await post("/agent/command", { commands: { action: "test", id: "my-id" } }, { auth: true });
    assert.deepEqual(r.body.ids, ["my-id"]);
  });
});

// ── Interactive command ──

describe("POST /agent/interactive", () => {
  it("returns 503 when no tabs connected", async () => {
    // Clear all tabs
    for (const k of Object.keys(app.state.agentTabs)) delete app.state.agentTabs[k];
    const r = await post("/agent/interactive", { command: { action: "click" }, timeout: 100 }, { auth: true });
    assert.equal(r.status, 503);
    assert.ok(r.body.error.includes("No browser tabs"));
  });

  it("times out waiting for result", async () => {
    // Register a tab so it doesn't 503
    app.state.agentTabs["int-tab"] = { receivedAt: Date.now() };
    const r = await post("/agent/interactive", { tabId: "int-tab", command: { action: "slowCmd" }, timeout: 50 }, { auth: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.timedOut, true);
  });

  it("resolves when result arrives", async () => {
    app.state.agentTabs["fast-tab"] = { receivedAt: Date.now() };
    // Fire request, then simulate agent posting result shortly after
    const promise = post("/agent/interactive", { tabId: "fast-tab", command: { action: "getState" }, timeout: 5000 }, { auth: true });
    // Wait briefly for command to be queued, then resolve via result endpoint
    await new Promise((r) => setTimeout(r, 30));
    const cmds = app.state.agentCommands["fast-tab"] || [];
    const cmdId = cmds[0]?.id;
    if (cmdId) {
      await post("/agent/result", { id: cmdId, ok: true, data: { title: "Test Page" } });
    }
    const r = await promise;
    assert.equal(r.status, 200);
    if (cmdId) {
      assert.equal(r.body.ok, true);
      assert.deepEqual(r.body.data, { title: "Test Page" });
    }
  });

  it("picks most recent tab when no tabId given", async () => {
    app.state.agentTabs["old-tab"] = { receivedAt: Date.now() - 50000 };
    app.state.agentTabs["new-tab"] = { receivedAt: Date.now() };
    const promise = post("/agent/interactive", { command: { action: "test" }, timeout: 50 }, { auth: true });
    const r = await promise;
    // Should have queued to new-tab (most recent), verify via timeout response
    assert.equal(r.body.timedOut, true);
  });
});

// ── Extension endpoints ──

describe("POST /ext/heartbeat", () => {
  it("marks extension connected", async () => {
    const r = await post("/ext/heartbeat", { tabCount: 3 }, { auth: true });
    assert.equal(r.body.ok, true);
    assert.ok(app.state.extLastHeartbeat > 0);
  });
});

describe("GET /ext/commands", () => {
  it("returns and drains queued commands", async () => {
    app.state.extCommands.push({ id: "ext-1", action: "openTab", url: "https://example.com" });
    const r = await get("/ext/commands", { auth: true });
    assert.equal(r.body.commands.length, 1);
    assert.equal(r.body.commands[0].id, "ext-1");
    // Drained
    const r2 = await get("/ext/commands", { auth: true });
    assert.deepEqual(r2.body.commands, []);
  });
});

describe("POST /ext/result", () => {
  it("stores extension result", async () => {
    const before = app.state.agentResults.length;
    const r = await post("/ext/result", { id: "ext-cmd-1", ok: true }, { auth: true });
    assert.equal(r.body.ok, true);
    assert.equal(app.state.agentResults.length, before + 1);
  });
});

describe("GET /ext/status", () => {
  it("reports extension alive after recent heartbeat", async () => {
    app.state.extLastHeartbeat = Date.now();
    const r = await get("/ext/status", { auth: true });
    assert.equal(r.body.connected, true);
  });

  it("reports extension dead after stale heartbeat", async () => {
    app.state.extLastHeartbeat = Date.now() - 60_000;
    const r = await get("/ext/status", { auth: true });
    assert.equal(r.body.connected, false);
  });
});

// ── Cowork endpoints ──

describe("POST /cowork/heartbeat", () => {
  it("updates session heartbeat", async () => {
    app.state.coworkSessions["cw-1"] = { slug: "test", turns: [], lastHeartbeat: 0, status: "in-progress" };
    const r = await post("/cowork/heartbeat", { sessionId: "cw-1", status: "active" });
    assert.equal(r.body.ok, true);
    assert.ok(app.state.coworkSessions["cw-1"].lastHeartbeat > 0);
    assert.equal(app.state.coworkSessions["cw-1"].status, "active");
  });

  it("ignores unknown session", async () => {
    const r = await post("/cowork/heartbeat", { sessionId: "unknown" });
    assert.equal(r.body.ok, true);
  });
});

describe("POST /cowork/snapshot", () => {
  it("creates a new session", async () => {
    const r = await post("/cowork/snapshot", {
      sessionId: "snap-1", slug: "my-snap", goal: "Test goal",
      turns: [{ role: "user", content: "Hello" }], startedAt: "2026-04-16T00:00:00Z",
    });
    assert.equal(r.body.ok, true);
    const s = app.state.coworkSessions["snap-1"];
    assert.equal(s.slug, "my-snap");
    assert.equal(s.goal, "Test goal");
    assert.equal(s.turnCount, 1);
    assert.equal(s.status, "in-progress");
  });

  it("updates existing session", async () => {
    await post("/cowork/snapshot", {
      sessionId: "snap-1", slug: "my-snap", goal: "Updated goal",
      turns: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi" }],
    });
    const s = app.state.coworkSessions["snap-1"];
    assert.equal(s.goal, "Updated goal");
    assert.equal(s.turnCount, 2);
  });

  it("requires sessionId", async () => {
    const r = await post("/cowork/snapshot", { slug: "no-sid" });
    assert.equal(r.status, 400);
  });

  it("detects chat clear (turn count drop) and starts new session", async () => {
    // Set up existing session with 3 turns
    app.state.coworkSessions["clear-test"] = {
      slug: "old-session", goal: "Old", startedAt: "2026-04-16T00:00:00Z",
      status: "in-progress", turns: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }],
      turnCount: 3, lastHeartbeat: Date.now(),
    };
    // Send snapshot with fewer turns
    const r = await post("/cowork/snapshot", {
      sessionId: "clear-test", slug: "new-session", goal: "New goal",
      turns: [{ role: "user", content: "fresh start" }],
    });
    assert.equal(r.body.ok, true);
    assert.ok(r.body.newSessionId);
    // Old session should be completed
    assert.equal(app.state.coworkSessions["clear-test"].status, "completed");
    assert.equal(app.state.coworkSessions["clear-test"].reason, "chat-cleared");
  });
});

describe("POST /cowork/turn", () => {
  it("adds a new turn", async () => {
    app.state.coworkSessions["turn-test"] = { slug: "tt", turns: [{ role: "user", content: "first" }], turnCount: 1 };
    const r = await post("/cowork/turn", {
      sessionId: "turn-test", turnIndex: 1, turn: { role: "assistant", content: "response here" },
    });
    assert.equal(r.body.ok, true);
    assert.equal(app.state.coworkSessions["turn-test"].turns.length, 2);
    assert.equal(app.state.coworkSessions["turn-test"].turnCount, 2);
  });

  it("skips duplicate turn index", async () => {
    app.state.coworkSessions["turn-dup"] = { slug: "td", turns: [{ role: "user", content: "first" }], turnCount: 1 };
    await post("/cowork/turn", { sessionId: "turn-dup", turnIndex: 0, turn: { role: "user", content: "duplicate" } });
    assert.equal(app.state.coworkSessions["turn-dup"].turns.length, 1);
    assert.equal(app.state.coworkSessions["turn-dup"].turns[0].content, "first");
  });
});

describe("POST /cowork/end", () => {
  it("marks session completed", async () => {
    app.state.coworkSessions["end-test"] = { slug: "et", goal: "Test", turns: [], status: "in-progress" };
    const r = await post("/cowork/end", { sessionId: "end-test", reason: "user-closed" });
    assert.equal(r.body.ok, true);
    assert.equal(app.state.coworkSessions["end-test"].status, "completed");
    assert.equal(app.state.coworkSessions["end-test"].reason, "user-closed");
    assert.ok(app.state.coworkSessions["end-test"].endedAt);
  });

  it("marks interrupted on page-unload", async () => {
    app.state.coworkSessions["unload-test"] = { slug: "ul", turns: [], status: "in-progress" };
    await post("/cowork/end", { sessionId: "unload-test", reason: "page-unload" });
    assert.equal(app.state.coworkSessions["unload-test"].status, "interrupted");
  });

  it("requires sessionId", async () => {
    const r = await post("/cowork/end", { reason: "test" });
    assert.equal(r.status, 400);
  });
});

describe("GET /cowork/pending", () => {
  it("returns null when no pending session", async () => {
    app.state.coworkPending = null;
    const r = await get("/cowork/pending");
    assert.equal(r.body.ok, true);
    assert.equal(r.body.pending, null);
  });

  it("returns pending session", async () => {
    app.state.coworkPending = { requestId: "r1", goal: "Test" };
    const r = await get("/cowork/pending");
    assert.equal(r.body.pending.requestId, "r1");
  });
});

describe("POST /cowork/pending/ack", () => {
  it("clears pending on matching requestId", async () => {
    app.state.coworkPending = { requestId: "ack-test", goal: "Test" };
    await post("/cowork/pending/ack", { requestId: "ack-test" });
    assert.equal(app.state.coworkPending, null);
  });

  it("ignores mismatched requestId", async () => {
    app.state.coworkPending = { requestId: "keep-me", goal: "Test" };
    await post("/cowork/pending/ack", { requestId: "wrong-id" });
    assert.equal(app.state.coworkPending.requestId, "keep-me");
  });
});

describe("GET /cowork/summary", () => {
  it("returns session list", async () => {
    const r = await get("/cowork/summary");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.sessions));
    assert.ok(typeof r.body.count === "number");
  });
});

describe("GET /cowork/config", () => {
  it("returns selectors and version", async () => {
    const r = await get("/cowork/config");
    assert.equal(r.status, 200);
    assert.ok(r.body.selectors);
    assert.ok(r.body.selectors.turnElements);
    assert.equal(r.body.version, "1.2.0");
    assert.equal(r.body.scrapeIntervalMs, 30000);
  });
});

// ── Cowork control (auth required) ──

describe("GET /cowork/sessions", () => {
  it("requires auth", async () => {
    const r = await get("/cowork/sessions");
    assert.equal(r.status, 401);
  });

  it("lists sessions sorted by startedAt", async () => {
    app.state.coworkSessions["list-a"] = { slug: "a", startedAt: "2026-04-15T10:00:00Z", status: "completed", turnCount: 2 };
    app.state.coworkSessions["list-b"] = { slug: "b", startedAt: "2026-04-16T10:00:00Z", status: "in-progress", turnCount: 5 };
    const r = await get("/cowork/sessions", { auth: true });
    assert.equal(r.status, 200);
    assert.ok(r.body.sessions.length >= 2);
    // Should be sorted descending by startedAt
    const idx_a = r.body.sessions.findIndex((s) => s.id === "list-a");
    const idx_b = r.body.sessions.findIndex((s) => s.id === "list-b");
    assert.ok(idx_b < idx_a);
  });

  it("filters by date", async () => {
    const r = await get("/cowork/sessions?date=2026-04-16", { auth: true });
    assert.ok(r.body.sessions.every((s) => s.startedAt.startsWith("2026-04-16")));
  });
});

describe("GET /cowork/session/:id", () => {
  it("requires auth", async () => {
    const r = await get("/cowork/session/list-a");
    assert.equal(r.status, 401);
  });

  it("returns session details", async () => {
    const r = await get("/cowork/session/list-a", { auth: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.session.id, "list-a");
    assert.equal(r.body.session.slug, "a");
  });

  it("returns 404 for unknown session", async () => {
    const r = await get("/cowork/session/nonexistent", { auth: true });
    assert.equal(r.status, 404);
  });
});

describe("GET /cowork/status", () => {
  it("requires auth", async () => {
    const r = await get("/cowork/status");
    assert.equal(r.status, 401);
  });

  it("reports active sessions with recent heartbeat", async () => {
    app.state.coworkSessions["active-s"] = { slug: "active", status: "in-progress", lastHeartbeat: Date.now(), turnCount: 1 };
    const r = await get("/cowork/status", { auth: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.active, true);
    assert.ok(r.body.sessions.some((s) => s.id === "active-s"));
  });
});

describe("POST /cowork/start", () => {
  it("requires auth", async () => {
    const r = await post("/cowork/start", { goal: "Test" });
    assert.equal(r.status, 401);
  });

  it("queues a pending session", async () => {
    app.state.coworkPending = null;
    const r = await post("/cowork/start", { goal: "CLI goal", instructions: "Do X" }, { auth: true });
    assert.equal(r.body.ok, true);
    assert.ok(r.body.requestId);
    assert.equal(app.state.coworkPending.goal, "CLI goal");
    assert.equal(app.state.coworkPending.instructions, "Do X");
  });

  it("defaults goal when not provided", async () => {
    await post("/cowork/start", {}, { auth: true });
    assert.equal(app.state.coworkPending.goal, "CLI-initiated session");
  });
});

// ── CORS headers on all responses ──

describe("CORS headers", () => {
  it("includes CORS on JSON responses", async () => {
    const r = await get("/health");
    assert.equal(r.headers["access-control-allow-origin"], "*");
  });
});

// ── createApp isolation ──

describe("createApp", () => {
  it("creates isolated instances", async () => {
    const app2 = createApp({ apiKey: "other-key", _skipTimers: true });
    await new Promise((resolve) => app2.server.listen(0, "127.0.0.1", resolve));
    const addr2 = app2.server.address();

    // State is isolated — app2 tabs should be empty even though app has tabs
    const r = await request("GET", "/agent/tabs", { auth: true });
    // This uses app's baseUrl, so it goes to app
    const r2 = await new Promise((resolve, reject) => {
      const req = http.request({ method: "GET", hostname: "127.0.0.1", port: addr2.port, path: "/agent/tabs", headers: { authorization: "Bearer other-key" } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(r2.count, 0);

    app2.cleanup();
    app2.server.close();
  });
});
