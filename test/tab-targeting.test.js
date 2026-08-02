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
  // CHANGED in ext 2.11.0, deliberately. This previously asserted against
  // ACTIVE (tab 22), which is the myaccount.google.com fixture from the
  // original wrong-tab incident. The origin hard-deny now REFUSES that tab,
  // and the refusal is the whole point: the active-tab default is the one path
  // with no caller intent behind it, so it is exactly where an unnoticed
  // credential-page read would happen. The sensitive case is asserted in
  // "an unnamed command still cannot land on a sensitive active tab"; this
  // test keeps covering the fallback itself, against a benign active tab.
  const out = resolveTargetCore({}, TABS, new Map(), 33);
  assert.strictEqual(out.tabId, 33);
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

// --- Remote extension reload routing ---

const { shouldRouteToExtension } = require("../lib/core.js");

test("reloadExtension routes to the extension when it is alive", () => {
  const now = Date.now();
  assert.strictEqual(shouldRouteToExtension("reloadExtension", now, 60000, now), true);
});

test("reloadExtension does not route when the extension is dead", () => {
  const now = Date.now();
  assert.strictEqual(shouldRouteToExtension("reloadExtension", now - 120000, 60000, now), false);
});

// ---------------------------------------------------------------------------
// Origin containment (ext 2.11.0)
//
// Fail-closed resolution stops a STALE target from landing somewhere unnamed.
// These cover the other half: a CORRECTLY resolved target that the caller
// should still not be allowed to act on. That matters for unattended jobs,
// where a wrong-origin read has nobody watching it.
// ---------------------------------------------------------------------------

const {
  isSensitiveOrigin, allowlistViolation,
} = require("../extension/tab-target.js");

test("isSensitiveOrigin matches the host and its subdomains", () => {
  assert.equal(isSensitiveOrigin("https://myaccount.google.com/security"), true);
  assert.equal(isSensitiveOrigin("https://www.chase.com/"), true);
  assert.equal(isSensitiveOrigin("https://global.americanexpress.com/x"), true);
});

test("isSensitiveOrigin does NOT match a lookalike suffix", () => {
  // The check must be host-or-dot-suffix, never a bare substring, or
  // "notchase.com" / "chase.com.evil.tld" would read as sensitive (or worse,
  // an attacker-chosen host would read as safe under a naive includes()).
  assert.equal(isSensitiveOrigin("https://notchase.com/"), false);
  assert.equal(isSensitiveOrigin("https://chase.com.evil.tld/"), false);
  assert.equal(isSensitiveOrigin("https://hyatt.com/"), false);
});

test("a sensitive origin is refused even when named by chromeTabId", () => {
  // The strongest possible targeting signal must NOT be an override. The
  // 2026-07-30 incident read a myaccount.google.com tab; naming it explicitly
  // should still be refused.
  const out = resolveTargetCore({ chromeTabId: 22 }, TABS, new Map(), ACTIVE);
  assert.ok(out.error, "expected refusal");
  assert.equal(out.sensitive, true);
  assert.equal(out.tabId, undefined);
});

test("unsafeAllowSensitive is the documented escape hatch", () => {
  // Real skills (OAuth relinks, token refreshes) legitimately drive these
  // origins. The opt-in must work, and it is logged relay-side.
  const out = resolveTargetCore(
    { chromeTabId: 22, unsafeAllowSensitive: true }, TABS, new Map(), ACTIVE
  );
  assert.equal(out.tabId, 22);
  assert.equal(out.resolvedBy, "chromeTabId");
});

test("allowOrigins refuses a tab outside the list", () => {
  const out = resolveTargetCore(
    { chromeTabId: 33, allowOrigins: ["https://www.hyatt.com"] }, TABS, new Map(), ACTIVE
  );
  assert.ok(out.error);
  assert.equal(out.deniedOrigin, "https://example.com");
});

test("allowOrigins permits a tab inside the list", () => {
  const tabs = [{ id: 44, url: "https://www.hyatt.com/shop/rooms/x" }];
  const out = resolveTargetCore(
    { chromeTabId: 44, allowOrigins: ["https://www.hyatt.com"] }, tabs, new Map(), 44
  );
  assert.equal(out.tabId, 44);
});

test("hard-deny OUTRANKS allowOrigins", () => {
  // A job must not be able to allowlist its way onto a credential page.
  const out = resolveTargetCore(
    { chromeTabId: 22, allowOrigins: ["https://myaccount.google.com"] },
    TABS, new Map(), ACTIVE
  );
  assert.ok(out.error);
  assert.equal(out.sensitive, true);
});

test("NO allowOrigins behaves exactly as before (no regression)", () => {
  // The containment must be opt-in for existing consumers, or every current
  // skill breaks on upgrade.
  const out = resolveTargetCore({ chromeTabId: 33 }, TABS, new Map(), ACTIVE);
  assert.equal(out.tabId, 33);
  assert.equal(out.resolvedBy, "chromeTabId");
  assert.equal(out.error, undefined);
});

test("allowlistViolation is a no-op when the list is absent or empty", () => {
  assert.equal(allowlistViolation(undefined, "https://anything.com/"), null);
  assert.equal(allowlistViolation([], "https://anything.com/"), null);
});

test("an unnamed command still cannot land on a sensitive active tab", () => {
  // The active-tab default is the one path with no caller intent behind it, so
  // it is exactly where an unnoticed credential-page read would happen.
  const out = resolveTargetCore({}, TABS, new Map(), ACTIVE);
  assert.ok(out.error);
  assert.equal(out.sensitive, true);
});
