const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  snapshotToMarkdown,
  buildDiscordPayload,
  buildLogEntry,
  pickMostRecentTab,
  pruneByAge,
  pushResult,
  pruneCommandQueues,
  appendLog,
  pruneBlobs,
  buildSessionSummary,
  shouldRouteToExtension,
} = require("../lib/core");

// ── snapshotToMarkdown ──

describe("snapshotToMarkdown", () => {
  it("generates header with slug", () => {
    const md = snapshotToMarkdown("abc", { slug: "my-session", turns: [] });
    assert.ok(md.startsWith("# Session: my-session\n"));
  });

  it("falls back to sessionId when no slug", () => {
    const md = snapshotToMarkdown("abc123", { turns: [] });
    assert.ok(md.includes("# Session: abc123"));
  });

  it("formats startedAt as ISO datetime", () => {
    const md = snapshotToMarkdown("x", { startedAt: "2026-04-14T10:30:00Z", turns: [] });
    assert.ok(md.includes("**Started**: 2026-04-14 10:30"));
  });

  it("shows 'unknown' when no startedAt", () => {
    const md = snapshotToMarkdown("x", { turns: [] });
    assert.ok(md.includes("**Started**: unknown"));
  });

  it("uses default goal when none provided", () => {
    const md = snapshotToMarkdown("x", { turns: [] });
    assert.ok(md.includes("**Goal**: Cowork session"));
  });

  it("includes custom goal", () => {
    const md = snapshotToMarkdown("x", { goal: "Fix auth bug", turns: [] });
    assert.ok(md.includes("**Goal**: Fix auth bug"));
  });

  it("includes model when present", () => {
    const md = snapshotToMarkdown("x", { model: "claude-3-opus", turns: [] });
    assert.ok(md.includes("**Model**: claude-3-opus"));
  });

  it("omits model line when not present", () => {
    const md = snapshotToMarkdown("x", { turns: [] });
    assert.ok(!md.includes("**Model**"));
  });

  it("renders user turns", () => {
    const md = snapshotToMarkdown("x", {
      turns: [{ role: "human", content: "Hello world" }],
    });
    assert.ok(md.includes("**User**: Hello world"));
  });

  it("renders assistant turns", () => {
    const md = snapshotToMarkdown("x", {
      turns: [{ role: "assistant", content: "Hi there" }],
    });
    assert.ok(md.includes("**Assistant**: Hi there"));
  });

  it("numbers turns sequentially", () => {
    const md = snapshotToMarkdown("x", {
      turns: [
        { role: "human", content: "a" },
        { role: "assistant", content: "b" },
        { role: "human", content: "c" },
      ],
    });
    assert.ok(md.includes("### Turn 1"));
    assert.ok(md.includes("### Turn 2"));
    assert.ok(md.includes("### Turn 3"));
  });

  it("shows --:-- for turns without timestamp", () => {
    const md = snapshotToMarkdown("x", {
      turns: [{ role: "human", content: "test" }],
    });
    assert.ok(md.includes("--:--"));
  });

  it("truncates content at 2000 chars", () => {
    const longContent = "x".repeat(2500);
    const md = snapshotToMarkdown("x", {
      turns: [{ role: "human", content: longContent }],
    });
    assert.ok(!md.includes("x".repeat(2500)));
    assert.ok(md.includes("x".repeat(2000)));
  });

  it("includes final summary for completed sessions", () => {
    const md = snapshotToMarkdown("x", {
      status: "completed",
      turns: [{ role: "human", content: "hi" }],
      reason: "user-closed",
    });
    assert.ok(md.includes("## Final Summary"));
    assert.ok(md.includes("Session completed with 1 turns"));
    assert.ok(md.includes("Reason: user-closed"));
  });

  it("includes final summary for interrupted sessions", () => {
    const md = snapshotToMarkdown("x", {
      status: "interrupted",
      turns: [],
      reason: "page-unload",
    });
    assert.ok(md.includes("Session interrupted"));
  });

  it("omits final summary for active sessions", () => {
    const md = snapshotToMarkdown("x", { status: "active", turns: [] });
    assert.ok(!md.includes("## Final Summary"));
  });

  it("uses default reason when none provided", () => {
    const md = snapshotToMarkdown("x", { status: "completed", turns: [] });
    assert.ok(md.includes("Reason: normal end"));
  });

  it("handles empty turns array", () => {
    const md = snapshotToMarkdown("x", { turns: [] });
    assert.ok(md.includes("## Turns"));
    assert.ok(!md.includes("### Turn"));
  });

  it("handles undefined turns", () => {
    const md = snapshotToMarkdown("x", {});
    assert.ok(md.includes("## Turns"));
  });
});

// ── buildDiscordPayload ──

describe("buildDiscordPayload", () => {
  it("sets username to Cowork Bridge", () => {
    const p = buildDiscordPayload({ turns: [] });
    assert.equal(p.username, "Cowork Bridge");
  });

  it("uses green color for completed status", () => {
    const p = buildDiscordPayload({ status: "completed", turns: [] });
    assert.equal(p.embeds[0].color, 3066993);
  });

  it("uses orange color for interrupted status", () => {
    const p = buildDiscordPayload({ status: "interrupted", turns: [] });
    assert.equal(p.embeds[0].color, 15105570);
  });

  it("uses blue color for other statuses", () => {
    const p = buildDiscordPayload({ status: "active", turns: [] });
    assert.equal(p.embeds[0].color, 3447003);
  });

  it("defaults to completed color when no status", () => {
    const p = buildDiscordPayload({ turns: [] });
    assert.equal(p.embeds[0].color, 3066993);
  });

  it("includes slug in title", () => {
    const p = buildDiscordPayload({ slug: "my-chat", turns: [] });
    assert.equal(p.embeds[0].title, "Cowork: my-chat");
  });

  it("falls back to session in title", () => {
    const p = buildDiscordPayload({ turns: [] });
    assert.equal(p.embeds[0].title, "Cowork: session");
  });

  it("includes turn count in description", () => {
    const p = buildDiscordPayload({ turns: [{ role: "human", content: "hi" }] });
    assert.ok(p.embeds[0].description.includes("**Turns:** 1"));
  });

  it("includes model in description when present", () => {
    const p = buildDiscordPayload({ model: "opus", turns: [] });
    assert.ok(p.embeds[0].description.includes("**Model:** opus"));
  });

  it("omits model line when not present", () => {
    const p = buildDiscordPayload({ turns: [] });
    assert.ok(!p.embeds[0].description.includes("**Model:**"));
  });

  it("includes reason when present", () => {
    const p = buildDiscordPayload({ reason: "timeout", turns: [] });
    assert.ok(p.embeds[0].description.includes("**Reason:** timeout"));
  });

  it("shows recent turns (last 3)", () => {
    const turns = [
      { role: "human", content: "first" },
      { role: "assistant", content: "second" },
      { role: "human", content: "third" },
      { role: "assistant", content: "fourth" },
    ];
    const p = buildDiscordPayload({ turns });
    // Should show last 3 turns (second, third, fourth)
    assert.ok(p.embeds[0].description.includes("**Claude**: second"));
    assert.ok(p.embeds[0].description.includes("**User**: third"));
    assert.ok(p.embeds[0].description.includes("**Claude**: fourth"));
    assert.ok(!p.embeds[0].description.includes("**User**: first"));
  });

  it("truncates long turn content at 200 chars with ellipsis", () => {
    const longContent = "a".repeat(300);
    const p = buildDiscordPayload({ turns: [{ role: "human", content: longContent }] });
    assert.ok(p.embeds[0].description.includes("a".repeat(200) + "..."));
  });

  it("replaces newlines in turn content", () => {
    const p = buildDiscordPayload({ turns: [{ role: "human", content: "line1\nline2" }] });
    assert.ok(p.embeds[0].description.includes("line1 line2"));
  });

  it("shows no turns captured message", () => {
    const p = buildDiscordPayload({ turns: [] });
    assert.ok(p.embeds[0].description.includes("(no turns captured)"));
  });

  it("includes footer text", () => {
    const p = buildDiscordPayload({ turns: [] });
    assert.equal(p.embeds[0].footer.text, "Cowork Bridge (auto-captured)");
  });

  it("truncates description at 3900 chars", () => {
    const longTurns = Array.from({ length: 100 }, (_, i) => ({
      role: "human",
      content: `Message number ${i} with ${"x".repeat(100)} padding`,
    }));
    const p = buildDiscordPayload({ turns: longTurns });
    assert.ok(p.embeds[0].description.length <= 3900);
  });
});

// ── buildLogEntry ──

describe("buildLogEntry", () => {
  it("formats entry with tabId prefix (truncated to 8 chars)", () => {
    const entry = buildLogEntry("abcdefghijklmnop", "hello world", 1713100000000);
    assert.ok(entry.includes("[abcdefgh]"));
    assert.ok(entry.includes("hello world"));
  });

  it("uses ? for null tabId", () => {
    const entry = buildLogEntry(null, "msg", 1713100000000);
    assert.ok(entry.includes("[?]"));
  });

  it("uses ? for undefined tabId", () => {
    const entry = buildLogEntry(undefined, "msg", 1713100000000);
    assert.ok(entry.includes("[?]"));
  });

  it("includes ISO timestamp", () => {
    const entry = buildLogEntry("tab1", "msg", 1713100000000);
    assert.ok(entry.match(/\[\d{4}-\d{2}-\d{2}T/));
  });

  it("handles short tabId", () => {
    const entry = buildLogEntry("ab", "msg", 1713100000000);
    assert.ok(entry.includes("[ab]"));
  });
});

// ── pickMostRecentTab ──

describe("pickMostRecentTab", () => {
  it("returns null for empty tabs", () => {
    assert.equal(pickMostRecentTab({}), null);
  });

  it("returns the only tab", () => {
    assert.equal(pickMostRecentTab({ tab1: { receivedAt: 100 } }), "tab1");
  });

  it("returns the tab with the highest receivedAt", () => {
    const tabs = {
      old: { receivedAt: 100 },
      newest: { receivedAt: 300 },
      mid: { receivedAt: 200 },
    };
    assert.equal(pickMostRecentTab(tabs), "newest");
  });

  it("handles tabs with no receivedAt (treats as 0)", () => {
    const tabs = {
      noTs: {},
      hasTs: { receivedAt: 1 },
    };
    assert.equal(pickMostRecentTab(tabs), "hasTs");
  });

  it("handles all tabs with same receivedAt", () => {
    const tabs = {
      a: { receivedAt: 100 },
      b: { receivedAt: 100 },
    };
    const result = pickMostRecentTab(tabs);
    assert.ok(result === "a" || result === "b");
  });
});

// ── pruneByAge ──

describe("pruneByAge", () => {
  it("removes entries older than TTL", () => {
    const map = {
      old: { receivedAt: 100 },
      new: { receivedAt: 900 },
    };
    const pruned = pruneByAge(map, 500, "receivedAt", 1000);
    assert.deepEqual(pruned, ["old"]);
    assert.ok(!map.old);
    assert.ok(map.new);
  });

  it("keeps entries within TTL", () => {
    const map = {
      recent: { receivedAt: 800 },
    };
    pruneByAge(map, 500, "receivedAt", 1000);
    assert.ok(map.recent);
  });

  it("handles empty map", () => {
    const pruned = pruneByAge({}, 500, "receivedAt", 1000);
    assert.deepEqual(pruned, []);
  });

  it("prunes entries with missing timestamp field (treated as 0)", () => {
    const map = { noTs: {} };
    const pruned = pruneByAge(map, 500, "receivedAt", 1000);
    assert.deepEqual(pruned, ["noTs"]);
  });

  it("prunes all entries when all are expired", () => {
    const map = {
      a: { ts: 1 },
      b: { ts: 2 },
      c: { ts: 3 },
    };
    const pruned = pruneByAge(map, 10, "ts", 100);
    assert.equal(pruned.length, 3);
    assert.equal(Object.keys(map).length, 0);
  });

  it("keeps all entries when none are expired", () => {
    const map = {
      a: { ts: 95 },
      b: { ts: 99 },
    };
    pruneByAge(map, 10, "ts", 100);
    assert.equal(Object.keys(map).length, 2);
  });
});

// ── pushResult ──

describe("pushResult", () => {
  it("adds result to array", () => {
    const results = [];
    pushResult({ id: "cmd-1", ok: true }, results, 10, {});
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "cmd-1");
  });

  it("sets timestamp on result", () => {
    const results = [];
    pushResult({ id: "cmd-1" }, results, 10, {});
    assert.ok(results[0].ts > 0);
  });

  it("enforces max size (circular buffer)", () => {
    const results = [];
    for (let i = 0; i < 5; i++) {
      pushResult({ id: `cmd-${i}` }, results, 3, {});
    }
    assert.equal(results.length, 3);
    assert.equal(results[0].id, "cmd-2");
    assert.equal(results[2].id, "cmd-4");
  });

  it("resolves matching waiter", () => {
    const results = [];
    let resolved = null;
    const waiters = {
      "cmd-5": {
        resolve: (r) => { resolved = r; },
        timer: setTimeout(() => {}, 60000),
      },
    };
    pushResult({ id: "cmd-5", ok: true }, results, 10, waiters);
    assert.ok(resolved);
    assert.equal(resolved.id, "cmd-5");
    assert.ok(!waiters["cmd-5"]);
  });

  it("ignores when no matching waiter", () => {
    const results = [];
    const waiters = {};
    pushResult({ id: "cmd-99" }, results, 10, waiters);
    assert.equal(results.length, 1);
  });

  it("clears waiter timer on resolve", () => {
    const results = [];
    const timer = setTimeout(() => {}, 60000);
    const waiters = {
      "cmd-7": {
        resolve: () => {},
        timer,
      },
    };
    pushResult({ id: "cmd-7" }, results, 10, waiters);
    // Waiter should be removed
    assert.ok(!waiters["cmd-7"]);
  });
});

// ── pruneCommandQueues ──

describe("pruneCommandQueues", () => {
  it("removes commands for dead tabs", () => {
    const commands = {
      "dead-tab": [{ id: "cmd-1" }, { id: "cmd-2" }],
      "live-tab": [{ id: "cmd-3" }],
    };
    const dropped = pruneCommandQueues(commands, ["live-tab"]);
    assert.equal(dropped["dead-tab"], 2);
    assert.ok(!commands["dead-tab"]);
    assert.ok(commands["live-tab"]);
  });

  it("preserves 'all' broadcast queue", () => {
    const commands = {
      all: [{ id: "cmd-1" }],
      "dead-tab": [{ id: "cmd-2" }],
    };
    pruneCommandQueues(commands, []);
    assert.ok(commands.all);
  });

  it("returns empty object when nothing to prune", () => {
    const commands = {
      tab1: [{ id: "cmd-1" }],
    };
    const dropped = pruneCommandQueues(commands, ["tab1"]);
    assert.deepEqual(dropped, {});
  });

  it("handles empty command queues", () => {
    const dropped = pruneCommandQueues({}, ["tab1"]);
    assert.deepEqual(dropped, {});
  });

  it("skips tabs with empty command arrays", () => {
    const commands = {
      "dead-tab": [],
    };
    const dropped = pruneCommandQueues(commands, []);
    assert.deepEqual(dropped, {});
  });
});

// ── appendLog ──

describe("appendLog", () => {
  it("adds entry to log", () => {
    const logs = [];
    appendLog(logs, "entry1", 10);
    assert.equal(logs.length, 1);
    assert.equal(logs[0], "entry1");
  });

  it("enforces max size", () => {
    const logs = [];
    for (let i = 0; i < 5; i++) appendLog(logs, `entry${i}`, 3);
    assert.equal(logs.length, 3);
    assert.equal(logs[0], "entry2");
  });

  it("handles max of 1", () => {
    const logs = [];
    appendLog(logs, "a", 1);
    appendLog(logs, "b", 1);
    assert.equal(logs.length, 1);
    assert.equal(logs[0], "b");
  });
});

// ── pruneBlobs ──

describe("pruneBlobs", () => {
  it("removes expired blobs", () => {
    const blobs = {
      old: { ts: 100, base64: "data" },
      fresh: { ts: 900, base64: "data" },
    };
    const pruned = pruneBlobs(blobs, 500, 1000);
    assert.deepEqual(pruned, ["old"]);
    assert.ok(!blobs.old);
    assert.ok(blobs.fresh);
  });

  it("handles empty blob store", () => {
    const pruned = pruneBlobs({}, 500, 1000);
    assert.deepEqual(pruned, []);
  });

  it("keeps all blobs when none expired", () => {
    const blobs = {
      a: { ts: 800 },
      b: { ts: 900 },
    };
    pruneBlobs(blobs, 500, 1000);
    assert.equal(Object.keys(blobs).length, 2);
  });
});

// ── buildSessionSummary ──

describe("buildSessionSummary", () => {
  it("returns empty array for empty sessions", () => {
    assert.deepEqual(buildSessionSummary({}, 10), []);
  });

  it("extracts summary fields", () => {
    const sessions = {
      s1: { slug: "chat", goal: "test", status: "completed", turnCount: 5, startedAt: "2026-04-14T10:00:00Z" },
    };
    const result = buildSessionSummary(sessions, 10);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "s1");
    assert.equal(result[0].slug, "chat");
    assert.equal(result[0].goal, "test");
    assert.equal(result[0].status, "completed");
    assert.equal(result[0].turnCount, 5);
  });

  it("sorts by startedAt descending", () => {
    const sessions = {
      old: { slug: "old", startedAt: "2026-04-13T10:00:00Z" },
      new: { slug: "new", startedAt: "2026-04-14T10:00:00Z" },
      mid: { slug: "mid", startedAt: "2026-04-13T18:00:00Z" },
    };
    const result = buildSessionSummary(sessions, 10);
    assert.equal(result[0].slug, "new");
    assert.equal(result[1].slug, "mid");
    assert.equal(result[2].slug, "old");
  });

  it("respects limit", () => {
    const sessions = {
      a: { startedAt: "2026-04-14T01:00:00Z" },
      b: { startedAt: "2026-04-14T02:00:00Z" },
      c: { startedAt: "2026-04-14T03:00:00Z" },
    };
    const result = buildSessionSummary(sessions, 2);
    assert.equal(result.length, 2);
  });

  it("defaults turnCount to 0 when missing", () => {
    const sessions = { s1: {} };
    const result = buildSessionSummary(sessions, 10);
    assert.equal(result[0].turnCount, 0);
  });

  it("handles sessions with no startedAt", () => {
    const sessions = {
      a: { startedAt: "2026-04-14T10:00:00Z" },
      b: {},
    };
    const result = buildSessionSummary(sessions, 10);
    assert.equal(result.length, 2);
    // Session with startedAt should sort first
    assert.equal(result[0].id, "a");
  });
});

// ── shouldRouteToExtension ──

describe("shouldRouteToExtension", () => {
  const NOW = 1000;
  const EXT_TTL = 30000;

  it("routes tab commands when extension is alive", () => {
    assert.ok(shouldRouteToExtension("openTab", NOW - 10000, EXT_TTL, NOW));
  });

  it("routes openTabBackground to extension", () => {
    assert.ok(shouldRouteToExtension("openTabBackground", NOW - 5000, EXT_TTL, NOW));
  });

  it("routes closeTab to extension", () => {
    assert.ok(shouldRouteToExtension("closeTab", NOW - 5000, EXT_TTL, NOW));
  });

  it("routes focusTab to extension", () => {
    assert.ok(shouldRouteToExtension("focusTab", NOW - 5000, EXT_TTL, NOW));
  });

  it("routes queryTabs to extension", () => {
    assert.ok(shouldRouteToExtension("queryTabs", NOW - 5000, EXT_TTL, NOW));
  });

  it("routes createTab to extension", () => {
    assert.ok(shouldRouteToExtension("createTab", NOW - 5000, EXT_TTL, NOW));
  });

  it("routes captureTab to extension", () => {
    assert.ok(shouldRouteToExtension("captureTab", NOW - 5000, EXT_TTL, NOW));
  });

  it("routes captureAdvanced to extension", () => {
    assert.ok(shouldRouteToExtension("captureAdvanced", NOW - 5000, EXT_TTL, NOW));
  });

  it("routes cdpType to extension", () => {
    assert.ok(shouldRouteToExtension("cdpType", NOW - 5000, EXT_TTL, NOW));
  });

  it("routes cdpClick to extension", () => {
    assert.ok(shouldRouteToExtension("cdpClick", NOW - 5000, EXT_TTL, NOW));
  });

  it("routes cdpEval to extension", () => {
    assert.ok(shouldRouteToExtension("cdpEval", NOW - 5000, EXT_TTL, NOW));
  });

  it("routes cdpKeys to extension", () => {
    assert.ok(shouldRouteToExtension("cdpKeys", NOW - 5000, EXT_TTL, NOW));
  });

  it("does not route CDP commands when extension is dead", () => {
    assert.ok(!shouldRouteToExtension("cdpType", NOW - 50000, EXT_TTL, NOW));
    assert.ok(!shouldRouteToExtension("cdpClick", NOW - 50000, EXT_TTL, NOW));
    assert.ok(!shouldRouteToExtension("cdpEval", NOW - 50000, EXT_TTL, NOW));
    assert.ok(!shouldRouteToExtension("cdpKeys", NOW - 50000, EXT_TTL, NOW));
  });

  it("does not route non-tab commands", () => {
    assert.ok(!shouldRouteToExtension("click", NOW - 5000, EXT_TTL, NOW));
  });

  it("does not route navigate", () => {
    assert.ok(!shouldRouteToExtension("navigate", NOW - 5000, EXT_TTL, NOW));
  });

  it("does not route when extension is dead", () => {
    assert.ok(!shouldRouteToExtension("openTab", NOW - 50000, EXT_TTL, NOW));
  });

  it("does not route non-tab command even when extension alive", () => {
    assert.ok(!shouldRouteToExtension("getPageState", NOW - 5000, EXT_TTL, NOW));
  });

  it("returns false for exactly-expired heartbeat", () => {
    // extLastHeartbeat is exactly EXT_TTL ago — not alive
    assert.ok(!shouldRouteToExtension("openTab", NOW - EXT_TTL, EXT_TTL, NOW));
  });
});
