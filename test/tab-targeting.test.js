// Tab-targeting safety for CDP/native extension commands.
//
// Regression suite for the silent wrong-tab hazard: a cdp-eval given an explicit
// target used to run against whatever tab happened to be focused, so a command
// aimed at one page could read another — including a logged-in account page the
// caller never named. Resolution must now fail CLOSED whenever a named target
// can't be resolved.

const test = require("node:test");
const assert = require("node:assert");

const { resolveTargetCore, originMismatch, originOf } = require("../extension/tab-target.js");

const TABS = [
  { id: 11, url: "https://maxmypoint.com/deals" },
  { id: 22, url: "https://myaccount.google.com/security" },
  { id: 33, url: "https://example.com/page" },
];
const ACTIVE = 22; // the focused tab is the credential page

test("resolves a named tab via the internal->chrome registry", () => {
  const reg = new Map([["1753000000000-ab12", 11]]);
  const out = resolveTargetCore({ tabId: "1753000000000-ab12" }, TABS, reg, ACTIVE);
  assert.strictEqual(out.tabId, 11);
  assert.strictEqual(out.resolvedBy, "registry");
  assert.strictEqual(out.targetUrl, "https://maxmypoint.com/deals");
});

test("unresolvable tab id does NOT fall back to the active tab", () => {
  const out = resolveTargetCore({ tabId: "1753000000000-ab12" }, TABS, new Map(), ACTIVE);
  assert.ok(out.error, "expected an error, not a silent fallback");
  assert.strictEqual(out.tabId, undefined);
  assert.strictEqual(out.resolvedBy, "unresolved");
  assert.match(out.error, /Refusing to fall back to the active tab/);
});

test("the exact reported bug: a tab id sent as a url substring is refused", () => {
  // Pre-fix, the CLI passed the tab id in `url`; it matched nothing and the
  // extension attached to the focused myaccount.google.com tab.
  const out = resolveTargetCore({ url: "1753000000000-ab12" }, TABS, new Map(), ACTIVE);
  assert.ok(out.error);
  assert.notStrictEqual(out.tabId, ACTIVE);
});

test("unmatched url substring does NOT fall back to the active tab", () => {
  const out = resolveTargetCore({ url: "nosuchsite.example" }, TABS, new Map(), ACTIVE);
  assert.ok(out.error);
  assert.strictEqual(out.tabId, undefined);
});

test("a stale registry entry pointing at a closed tab is refused", () => {
  const reg = new Map([["1753000000000-ab12", 99]]); // tab 99 no longer open
  const out = resolveTargetCore({ tabId: "1753000000000-ab12" }, TABS, reg, ACTIVE);
  assert.ok(out.error);
  assert.notStrictEqual(out.tabId, ACTIVE);
});

test("registry miss falls back to the relay-supplied url for the SAME tab", () => {
  // MV3 evicts the service worker and with it the in-memory registry; the relay
  // attaches the tab's recorded URL so the intended tab is still reachable.
  const out = resolveTargetCore(
    { tabId: "1753000000000-ab12", url: "https://maxmypoint.com/deals" },
    TABS, new Map(), ACTIVE
  );
  assert.strictEqual(out.tabId, 11);
  assert.strictEqual(out.resolvedBy, "url");
});

test("unknown chromeTabId is refused rather than redirected", () => {
  const out = resolveTargetCore({ chromeTabId: 404 }, TABS, new Map(), ACTIVE);
  assert.ok(out.error);
  assert.match(out.error, /not open/);
});

test("active tab is used only when no target is named at all", () => {
  const out = resolveTargetCore({}, TABS, new Map(), ACTIVE);
  assert.strictEqual(out.tabId, ACTIVE);
  assert.strictEqual(out.resolvedBy, "activeTab");
});

test("no named target and no active tab is an error, not a guess", () => {
  const out = resolveTargetCore({}, TABS, new Map(), undefined);
  assert.ok(out.error);
});

test("a tab that navigated cross-origin since resolution is refused", () => {
  // Relay tab ids live in sessionStorage, so they survive navigation: an id
  // captured on maxmypoint still resolves after that tab moved to Google.
  const reg = new Map([["1753000000000-ab12", 22]]);
  const out = resolveTargetCore(
    { tabId: "1753000000000-ab12", expectUrl: "https://maxmypoint.com/deals" },
    TABS, reg, ACTIVE
  );
  assert.ok(out.error);
  assert.match(out.error, /changed origin/);
  assert.strictEqual(out.expectedOrigin, "https://maxmypoint.com");
  assert.strictEqual(out.actualOrigin, "https://myaccount.google.com");
});

test("same-origin navigation within the target tab is allowed", () => {
  const reg = new Map([["1753000000000-ab12", 11]]);
  const out = resolveTargetCore(
    { tabId: "1753000000000-ab12", expectUrl: "https://maxmypoint.com/other" },
    TABS, reg, ACTIVE
  );
  assert.strictEqual(out.tabId, 11);
});

test("originMismatch ignores non-URL substrings (CLI url args)", () => {
  assert.strictEqual(originMismatch("facebook.com", "https://example.com/"), null);
  assert.strictEqual(originMismatch(null, "https://example.com/"), null);
  assert.strictEqual(originOf("not a url"), null);
});

test("every named-target failure keeps the caller off the credential tab", () => {
  const cases = [
    { tabId: "1753000000000-zz99" },
    { url: "1753000000000-zz99" },
    { chromeTabId: 404 },
    { tabId: "1753000000000-ab12", expectUrl: "https://maxmypoint.com/deals" },
  ];
  const reg = new Map([["1753000000000-ab12", 22]]);
  for (const cmd of cases) {
    const out = resolveTargetCore(cmd, TABS, reg, ACTIVE);
    assert.ok(out.error, `expected refusal for ${JSON.stringify(cmd)}`);
    assert.strictEqual(out.tabId, undefined, `leaked a tab for ${JSON.stringify(cmd)}`);
  }
});
