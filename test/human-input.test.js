const { test } = require("node:test");
const assert = require("node:assert");

const {
  makeRng, keyDescriptor, needsShift, keystrokeDelays,
  pointInRect, mousePath, moveDelays, clickTiming, idlePointer, SHIFT,
} = require("../extension/human-input.js");

// ── keyDescriptor: the correctness half of this module ──
//
// The previous inline implementation was `code: \`Key${char.toUpperCase()}\``
// and `windowsVirtualKeyCode: char.charCodeAt(0)` for EVERY character, so a
// page reading event.code saw "Key1"/"Key "/"Key." and event.keyCode saw 97 for
// a lowercase "a". These assert the values a real US keyboard reports.

test("keyDescriptor: lowercase letter reports the UPPERCASE virtual key", () => {
  const d = keyDescriptor("a");
  assert.strictEqual(d.key, "a");
  assert.strictEqual(d.code, "KeyA");
  assert.strictEqual(d.windowsVirtualKeyCode, 65, "was 97 (raw charCode) before");
  assert.strictEqual(d.modifiers, 0);
});

test("keyDescriptor: uppercase letter is shift + the same physical key", () => {
  const d = keyDescriptor("A");
  assert.strictEqual(d.key, "A");
  assert.strictEqual(d.code, "KeyA");
  assert.strictEqual(d.windowsVirtualKeyCode, 65);
  assert.strictEqual(d.modifiers, SHIFT, "shift was never set before");
});

test("keyDescriptor: digits are DigitN, not KeyN", () => {
  const d = keyDescriptor("1");
  assert.strictEqual(d.code, "Digit1", 'previously emitted "Key1", not a real DOM code');
  assert.strictEqual(d.windowsVirtualKeyCode, 49);
  assert.strictEqual(d.modifiers, 0);
});

test("keyDescriptor: space is Space", () => {
  const d = keyDescriptor(" ");
  assert.strictEqual(d.code, "Space", 'previously emitted "Key "');
  assert.strictEqual(d.windowsVirtualKeyCode, 32);
});

test("keyDescriptor: punctuation maps to its physical key", () => {
  assert.deepStrictEqual(
    keyDescriptor("."),
    { key: ".", code: "Period", windowsVirtualKeyCode: 190, modifiers: 0 },
  );
  assert.deepStrictEqual(
    keyDescriptor("/"),
    { key: "/", code: "Slash", windowsVirtualKeyCode: 191, modifiers: 0 },
  );
  assert.deepStrictEqual(
    keyDescriptor("-"),
    { key: "-", code: "Minus", windowsVirtualKeyCode: 189, modifiers: 0 },
  );
});

test("keyDescriptor: shifted punctuation reports the UNSHIFTED key plus shift", () => {
  // "@" is shift+2, so the physical key is Digit2 and the virtual key is 50.
  const at = keyDescriptor("@");
  assert.strictEqual(at.key, "@");
  assert.strictEqual(at.code, "Digit2");
  assert.strictEqual(at.windowsVirtualKeyCode, 50);
  assert.strictEqual(at.modifiers, SHIFT);

  const colon = keyDescriptor(":");
  assert.strictEqual(colon.code, "Semicolon");
  assert.strictEqual(colon.windowsVirtualKeyCode, 186);
  assert.strictEqual(colon.modifiers, SHIFT);
});

test("keyDescriptor: an email address round-trips to real codes", () => {
  const codes = [..."a@b.co"].map((c) => keyDescriptor(c).code);
  assert.deepStrictEqual(codes, ["KeyA", "Digit2", "KeyB", "Period", "KeyC", "KeyO"]);
});

test("keyDescriptor: characters with no US physical key return null", () => {
  // Caller emits the char event with the text and skips keyDown/keyUp rather
  // than inventing a code no keyboard has.
  assert.strictEqual(keyDescriptor("é"), null);
  assert.strictEqual(keyDescriptor("漢"), null);
  assert.strictEqual(keyDescriptor("🙂"[0]), null);
});

test("needsShift agrees with the descriptor", () => {
  assert.ok(needsShift("A"));
  assert.ok(needsShift("!"));
  assert.ok(!needsShift("a"));
  assert.ok(!needsShift("1"));
  assert.ok(!needsShift("é"), "unknown chars must not throw");
});

// ── keystroke timing ──

test("keystrokeDelays: one delay per character, all above the motor floor", () => {
  const text = "hello world, this is typed.";
  const delays = keystrokeDelays(text, { rng: makeRng(7) });
  assert.strictEqual(delays.length, text.length);
  assert.ok(delays.every((d) => d >= 26 && d <= 900), "delays out of range");
});

test("keystrokeDelays: is not a metronome (the entire point)", () => {
  const delays = keystrokeDelays("aaaaaaaaaaaaaaaaaaaa", { rng: makeRng(3) });
  const unique = new Set(delays);
  assert.ok(unique.size > 10, `expected a spread, got ${unique.size} distinct values`);
  const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
  const sd = Math.sqrt(delays.reduce((a, b) => a + (b - mean) ** 2, 0) / delays.length);
  assert.ok(sd > 10, `expected real variance, sd=${sd.toFixed(1)}`);
});

test("keystrokeDelays: same seed reproduces exactly", () => {
  const a = keystrokeDelays("replay me", { rng: makeRng(42) });
  const b = keystrokeDelays("replay me", { rng: makeRng(42) });
  assert.deepStrictEqual(a, b);
  const c = keystrokeDelays("replay me", { rng: makeRng(43) });
  assert.notDeepStrictEqual(a, c);
});

test("keystrokeDelays: long text is scaled to stay inside the relay timeout", () => {
  // 400 chars at the 105ms default would be ~42s and would blow the relay's
  // 30s command timeout. The mean scales down instead of the call failing.
  const text = "x".repeat(400);
  const total = keystrokeDelays(text, { rng: makeRng(9), budgetMs: 18000 })
    .reduce((a, b) => a + b, 0);
  assert.ok(total < 30000, `total ${total}ms must stay under the 30s timeout`);
});

// ── mouse geometry ──

test("pointInRect: always integral and strictly inside the box", () => {
  const rng = makeRng(11);
  const rect = { x: 100, y: 200, width: 80, height: 24 };
  for (let i = 0; i < 500; i++) {
    const p = pointInRect(rect, rng);
    assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y), "CDP accepts floats; a mouse never emits them");
    assert.ok(p.x >= rect.x && p.x <= rect.x + rect.width, `x ${p.x} outside`);
    assert.ok(p.y >= rect.y && p.y <= rect.y + rect.height, `y ${p.y} outside`);
  }
});

test("pointInRect: scatters instead of always hitting the centroid", () => {
  const rng = makeRng(5);
  const rect = { x: 0, y: 0, width: 200, height: 60 };
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = pointInRect(rect, rng);
    seen.add(`${p.x},${p.y}`);
  }
  assert.ok(seen.size > 100, `expected scatter, got ${seen.size} distinct points`);
  assert.ok(!seen.has("100,30") || seen.size > 100, "must not be pinned to the centre");
});

test("mousePath: ends exactly on the target and every point is integral", () => {
  const rng = makeRng(13);
  for (const to of [{ x: 40, y: 40 }, { x: 900, y: 620 }, { x: 5, y: 700 }]) {
    const pts = mousePath({ x: 300, y: 300 }, to, rng);
    const last = pts[pts.length - 1];
    assert.deepStrictEqual(last, { x: to.x, y: to.y }, "press must land on the aimed point");
    assert.ok(pts.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y)));
    assert.ok(pts.length >= 5, `expected an approach path, got ${pts.length} points`);
  }
});

test("mousePath: waypoint count stays small enough to survive the relay timeout", () => {
  // Each waypoint is a chrome.debugger round trip costing ~1s against this
  // relay. A 26-point path pushed a single click past the 30s command timeout
  // and left the debugger attached until the 55s safety timer. Cap is 14 plus
  // at most 2 appended correction points.
  const rng = makeRng(23);
  for (const to of [{ x: 60, y: 20 }, { x: 1600, y: 1200 }, { x: 4000, y: 3000 }]) {
    const pts = mousePath({ x: 0, y: 0 }, to, rng);
    assert.ok(pts.length <= 16, `${pts.length} waypoints is too many for the transport`);
  }
});

test("mousePath: bows off the straight line", () => {
  // A perfectly straight interpolation is the loudest mouse signal there is.
  const pts = mousePath({ x: 0, y: 0 }, { x: 600, y: 0 }, makeRng(17));
  const maxDeviation = Math.max(...pts.map((p) => Math.abs(p.y)));
  assert.ok(maxDeviation > 3, `path was effectively straight (max dy=${maxDeviation})`);
});

test("mousePath: degenerate move returns a single point", () => {
  const pts = mousePath({ x: 50, y: 50 }, { x: 50, y: 50 }, makeRng(1));
  assert.deepStrictEqual(pts, [{ x: 50, y: 50 }]);
});

test("mousePath: long throws can overshoot and correct back", () => {
  // Fitts' law: a long ballistic movement lands past the target and corrects.
  let sawOvershoot = false;
  for (let seed = 0; seed < 40 && !sawOvershoot; seed++) {
    const to = { x: 800, y: 0 };
    const pts = mousePath({ x: 0, y: 0 }, to, makeRng(seed), { overshootChance: 1 });
    sawOvershoot = pts.some((p) => p.x > to.x);
    assert.deepStrictEqual(pts[pts.length - 1], to, "still has to finish on target");
  }
  assert.ok(sawOvershoot, "expected at least one overshoot sample");
});

test("mousePath: same seed reproduces exactly", () => {
  const a = mousePath({ x: 10, y: 10 }, { x: 400, y: 300 }, makeRng(99));
  const b = mousePath({ x: 10, y: 10 }, { x: 400, y: 300 }, makeRng(99));
  assert.deepStrictEqual(a, b);
});

test("moveDelays: one per waypoint, bounded, and decelerating overall", () => {
  const rng = makeRng(21);
  const d = moveDelays(20, rng);
  assert.strictEqual(d.length, 20);
  assert.ok(d.every((x) => x >= 3 && x <= 40));
  const head = d.slice(0, 5).reduce((a, b) => a + b, 0);
  const tail = d.slice(-5).reduce((a, b) => a + b, 0);
  assert.ok(tail > head, `tail ${tail} should exceed head ${head} (corrective phase is slower)`);
});

test("clickTiming: press and release are never simultaneous", () => {
  const rng = makeRng(31);
  for (let i = 0; i < 200; i++) {
    const t = clickTiming(rng);
    assert.ok(t.holdMs >= 32, `hold ${t.holdMs}ms is physically impossible`);
    assert.ok(t.holdMs <= 190 && t.settleMs >= 25 && t.settleMs <= 220);
  }
});

test("idlePointer: lands inside the viewport, never at the origin", () => {
  const rng = makeRng(41);
  for (let i = 0; i < 100; i++) {
    const p = idlePointer({ width: 1280, height: 800 }, rng);
    assert.ok(p.x > 0 && p.x < 1280 && p.y > 0 && p.y < 800);
  }
});
