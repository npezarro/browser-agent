/**
 * Pure functions extracted from agent-server.js for testability.
 * No side effects, no I/O — all state is passed in.
 */

// ── Markdown Generation ──

function snapshotToMarkdown(sessionId, session) {
  const started = session.startedAt
    ? new Date(session.startedAt).toISOString().replace("T", " ").slice(0, 16)
    : "unknown";

  let md = `# Session: ${session.slug || sessionId}\n`;
  md += `- **Started**: ${started}\n`;
  md += `- **Goal**: ${session.goal || "Cowork session"}\n`;
  md += `- **Status**: ${session.status || "unknown"}\n`;
  if (session.model) md += `- **Model**: ${session.model}\n`;
  md += `- **Source**: cowork-bridge (auto-captured)\n\n`;

  md += `## Turns\n\n`;

  let turnNum = 0;
  for (const turn of session.turns || []) {
    turnNum++;
    const time = turn.ts
      ? new Date(turn.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
      : "--:--";

    md += `### Turn ${turnNum} — ${time}\n`;
    md += `**${turn.role === "human" ? "User" : "Assistant"}**: ${turn.content.slice(0, 2000)}\n\n`;
  }

  if (session.status === "completed" || session.status === "interrupted") {
    md += `## Final Summary\n`;
    md += `Session ${session.status} with ${(session.turns || []).length} turns. `;
    md += `Reason: ${session.reason || "normal end"}.\n`;
  }

  return md;
}

// ── Discord Embed Construction ──

function buildDiscordPayload(session) {
  const turnCount = session.turns?.length || 0;
  const status = session.status || "completed";
  const color = status === "completed" ? 3066993 : status === "interrupted" ? 15105570 : 3447003;
  const model = session.model || "";

  const recentTurns = (session.turns || []).slice(-3).map((t) => {
    const role = t.role === "human" ? "**User**" : "**Claude**";
    const text = t.content.slice(0, 200).replace(/\n/g, " ");
    return `${role}: ${text}${t.content.length > 200 ? "..." : ""}`;
  }).join("\n");

  const description = [
    `**Turns:** ${turnCount}`,
    model ? `**Model:** ${model}` : "",
    `**Status:** ${status}`,
    session.reason ? `**Reason:** ${session.reason}` : "",
    "",
    recentTurns || "(no turns captured)",
  ].filter(Boolean).join("\n").slice(0, 3900);

  return {
    username: "Cowork Bridge",
    embeds: [{
      title: `Cowork: ${session.slug || "session"}`,
      description,
      color,
      footer: { text: "Cowork Bridge (auto-captured)" },
    }],
  };
}

// ── Log Entry Formatting ──

function buildLogEntry(tabId, msg, ts) {
  return `[${new Date(ts || Date.now()).toISOString()}] [${(tabId || "?").substring(0, 8)}] ${msg}`;
}

// ── Tab Selection ──

function pickMostRecentTab(agentTabs) {
  const tabIds = Object.keys(agentTabs);
  if (tabIds.length === 0) return null;
  tabIds.sort((a, b) => (agentTabs[b].receivedAt || 0) - (agentTabs[a].receivedAt || 0));
  return tabIds[0];
}

// ── State Management (pure — operate on passed-in collections) ──

function pruneByAge(map, ttlMs, tsField, now) {
  now = now || Date.now();
  const pruned = [];
  for (const [id, entry] of Object.entries(map)) {
    if (now - (entry[tsField] || 0) > ttlMs) {
      delete map[id];
      pruned.push(id);
    }
  }
  return pruned;
}

function pushResult(result, agentResults, maxResults, resultWaiters) {
  result.ts = Date.now();
  agentResults.push(result);
  if (agentResults.length > maxResults) agentResults.shift();

  const waiter = resultWaiters[result.id];
  if (waiter) {
    clearTimeout(waiter.timer);
    delete resultWaiters[result.id];
    if (waiter.resolve) waiter.resolve(result);
  }
  return result;
}

function pruneCommandQueues(agentCommands, liveTabIds) {
  const live = new Set(liveTabIds);
  live.add("all");
  const dropped = {};
  for (const tabId of Object.keys(agentCommands)) {
    if (!live.has(tabId) && agentCommands[tabId]?.length > 0) {
      dropped[tabId] = agentCommands[tabId].length;
      delete agentCommands[tabId];
    }
  }
  return dropped;
}

// ── Circular Buffer (logs) ──

function appendLog(logs, entry, maxLogs) {
  logs.push(entry);
  if (logs.length > maxLogs) logs.shift();
}

// ── Blob Pruning ──

function pruneBlobs(uploadBlobs, blobTtl, now) {
  now = now || Date.now();
  const pruned = [];
  for (const [id, b] of Object.entries(uploadBlobs)) {
    if (now - b.ts > blobTtl) {
      delete uploadBlobs[id];
      pruned.push(id);
    }
  }
  return pruned;
}

// ── Session Summary Builder ──

function buildSessionSummary(coworkSessions, limit) {
  return Object.entries(coworkSessions)
    .map(([id, s]) => ({
      id,
      slug: s.slug,
      goal: s.goal,
      status: s.status,
      turnCount: s.turnCount || 0,
      startedAt: s.startedAt,
    }))
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
    .slice(0, limit || 10);
}

// ── Extension Routing Decision ──

function shouldRouteToExtension(action, extLastHeartbeat, extTtl, now) {
  now = now || Date.now();
  const EXT_TAB_ACTIONS = new Set(["openTab", "openTabBackground", "closeTab", "focusTab", "queryTabs", "createTab", "captureTab", "cdpType", "cdpClick", "cdpEval", "cdpKeys"]);
  const extAlive = now - extLastHeartbeat < extTtl;
  const isTabCmd = EXT_TAB_ACTIONS.has(action);
  return isTabCmd && extAlive;
}

module.exports = {
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
};
