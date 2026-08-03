// Human-plausible input kinematics for CDP-driven mouse and keyboard events.
//
// Lives in its own file so the same code runs in the MV3 service worker (loaded
// via importScripts from background.js) and under `node --test`, which cannot
// require background.js because that file calls chrome.* at load time.
//
// WHY THIS EXISTS, AND WHY IT IS NOT FINGERPRINT SPOOFING.
//
// The hardware under this agent is already real: a real Chrome on a real
// Windows GPU, a real display, a real residential IP, a real logged-in profile.
// Every PASSIVE fingerprint surface (WebGL vendor/renderer, canvas and audio
// hashes, screen metrics, hardwareConcurrency, deviceMemory, font list) is
// therefore genuine and needs no simulation. Patching any of it would only
// manufacture the internal INCONSISTENCY that bot-mitigation actually scores;
// a spoofed GPU string on a machine whose canvas hash still says otherwise is
// far louder than the truth. See `fingerprint-audit` in browser-cli.sh, which
// exists to prove those surfaces are coherent rather than to alter them.
//
// What was genuinely synthetic was the INPUT. Before this module:
//   - every click teleported to the exact sub-pixel centroid of the element's
//     bounding box with a single mouseMoved, no approach path, no dwell before
//     press, and zero hold between press and release;
//   - every keystroke fired on a metronomic 30ms interval, and carried a
//     malformed `event.code`: `Key${char.toUpperCase()}` yields "Key1" for a
//     digit, "Key " for a space and "Key." for a period, none of which are real
//     DOM code values, plus `windowsVirtualKeyCode` was the raw charCode, so
//     lowercase letters reported 97..122 where a real keyboard reports 65..90.
//
// The second of those is a plain correctness bug independent of any detection
// concern: a page reading `event.code` or `event.keyCode` (keyboard shortcut
// handlers, code-entry inputs, games) got values no keyboard emits. This module
// fixes the descriptors and gives the timing and trajectory the distribution a
// hand actually produces.

// ── Deterministic RNG ──
// Seeded rather than Math.random so tests assert on real sequences instead of
// mocking globals, and so a misbehaving interaction can be replayed exactly by
// pinning the seed (browser-cli --seed).
function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Box-Muller normal sample. */
function gauss(rng, mean, sd) {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── Keyboard descriptors ──

// CDP Input.dispatchKeyEvent modifier bitmask.
const ALT = 1, CTRL = 2, META = 4, SHIFT = 8;

// Characters produced by holding Shift, mapped to the key actually pressed.
const SHIFTED = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7",
  "*": "8", "(": "9", ")": "0", _: "-", "+": "=", "{": "[", "}": "]",
  "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
};

// Unshifted punctuation on a US layout: char -> [DOM code, Windows virtual key].
const PUNCT = {
  "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221], "\\": ["Backslash", 220], ";": ["Semicolon", 186],
  "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190],
  "/": ["Slash", 191], "`": ["Backquote", 192],
};

/**
 * The DOM/CDP key descriptor a real US-layout keyboard emits for `char`.
 *
 * Returns { key, code, windowsVirtualKeyCode, modifiers }. `key` is always the
 * character produced (so "A" for shift+a), `code` is the physical key, and the
 * virtual key code is the UNSHIFTED key's code, which is what Windows reports
 * and what `event.keyCode` exposes.
 *
 * Unknown characters (accented, CJK, emoji) get a null descriptor: there is no
 * honest US-layout physical key for them, so the caller should emit the `char`
 * event carrying the text and skip the keyDown/keyUp pair rather than invent a
 * `code` that no keyboard has.
 */
function keyDescriptor(char) {
  let base = char;
  let modifiers = 0;

  if (SHIFTED[char]) {
    base = SHIFTED[char];
    modifiers = SHIFT;
  } else if (char >= "A" && char <= "Z") {
    base = char.toLowerCase();
    modifiers = SHIFT;
  }

  if (base === " ") {
    return { key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers };
  }
  if (base >= "a" && base <= "z") {
    const upper = base.toUpperCase();
    return { key: char, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers };
  }
  if (base >= "0" && base <= "9") {
    return { key: char, code: `Digit${base}`, windowsVirtualKeyCode: base.charCodeAt(0), modifiers };
  }
  if (PUNCT[base]) {
    return { key: char, code: PUNCT[base][0], windowsVirtualKeyCode: PUNCT[base][1], modifiers };
  }
  return null;
}

function needsShift(char) {
  const d = keyDescriptor(char);
  return !!d && (d.modifiers & SHIFT) !== 0;
}

/**
 * Per-character inter-keystroke delays, in ms, for `text`.
 *
 * Modelled lognormal rather than Gaussian because real keystroke intervals are
 * right-skewed: a hard floor near the motor limit and a long tail of pauses. A
 * symmetric distribution is itself a signature, and a constant one (the old
 * fixed 30ms) is the loudest signature available.
 *
 * opts: { rng, meanMs, budgetMs }
 * `budgetMs` caps the total so a long string cannot silently blow the relay's
 * 30s command timeout; the mean is scaled down instead of the call failing.
 */
function keystrokeDelays(text, opts) {
  const o = opts || {};
  const rng = o.rng || makeRng(1);
  const budget = o.budgetMs || 18000;
  let mean = o.meanMs || 105;
  if (text.length > 0) mean = Math.min(mean, Math.max(26, budget / text.length));

  const delays = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : "";
    let d = Math.exp(gauss(rng, Math.log(mean), 0.34));

    if (prev === " ") d *= 1.18;              // starting a new word costs a beat
    if (/[.,!?;:]/.test(prev)) d *= 1.5;      // clause boundaries cost more
    if (ch === prev) d *= 0.82;               // repeated key is a fast rebound
    if (needsShift(ch) && !needsShift(prev)) d *= 1.22; // reaching for shift
    if (rng() < 0.035) d += 180 + rng() * 420;          // occasional hesitation

    delays.push(Math.round(clamp(d, 26, 900)));
  }
  return delays;
}

// ── Mouse kinematics ──

/**
 * An integral point inside `rect`, biased to the centre but scattered.
 *
 * Two reasons this is not the centroid. A real cursor lands anywhere in a
 * target, and CDP will happily dispatch fractional coordinates like x=317.5,
 * which no physical mouse ever produces: the OS delivers integer device pixels.
 * The triangular (rng+rng-1) term concentrates near the middle without ever
 * being exactly it.
 */
function pointInRect(rect, rng) {
  const fx = 0.5 + (rng() + rng() - 1) * 0.22;
  const fy = 0.5 + (rng() + rng() - 1) * 0.22;
  return {
    x: Math.round(rect.x + rect.width * clamp(fx, 0.12, 0.88)),
    y: Math.round(rect.y + rect.height * clamp(fy, 0.12, 0.88)),
  };
}

function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * Integral waypoints from `from` to `to`. The last point is always exactly
 * `to`, so a caller can press without a separate settle move.
 *
 * A straight line between two points is the single loudest mouse signal there
 * is: human arm movement bows off-axis and, on longer throws, overshoots the
 * target and corrects back (Fitts' law ballistic phase plus a corrective one).
 * Control points are pushed along the perpendicular to produce the bow; the
 * overshoot is appended for long throws only, where it actually occurs.
 */
function mousePath(from, to, rng, opts) {
  const o = opts || {};
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [{ x: Math.round(to.x), y: Math.round(to.y) }];

  const steps = Math.round(clamp(dist / 34, 6, 26));
  const nx = -dy / dist, ny = dx / dist;
  const bow = dist * (0.06 + rng() * 0.12) * (rng() < 0.5 ? -1 : 1);
  const c1 = { x: from.x + dx * 0.3 + nx * bow, y: from.y + dy * 0.3 + ny * bow };
  const c2 = { x: from.x + dx * 0.7 + nx * bow * 0.6, y: from.y + dy * 0.7 + ny * bow * 0.6 };

  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = easeInOutQuad(i / steps);
    const p = cubicBezier(from, c1, c2, to, t);
    // Sub-pixel jitter on the approach, but never on the final sample: the
    // press has to land on the point we actually aimed at.
    const last = i === steps;
    pts.push({
      x: Math.round(last ? to.x : p.x + (rng() - 0.5) * 1.6),
      y: Math.round(last ? to.y : p.y + (rng() - 0.5) * 1.6),
    });
  }

  if (dist > 220 && rng() < (o.overshootChance != null ? o.overshootChance : 0.6)) {
    const over = 3 + rng() * 9;
    const ux = dx / dist, uy = dy / dist;
    pts[pts.length - 1] = { x: Math.round(to.x + ux * over), y: Math.round(to.y + uy * over) };
    pts.push({ x: Math.round(to.x + ux * over * 0.35), y: Math.round(to.y + uy * over * 0.35) });
    pts.push({ x: Math.round(to.x), y: Math.round(to.y) });
  }

  return pts;
}

/**
 * Per-waypoint delays for a path of `n` points. Deceleration into the target:
 * the tail of a real approach is closer together in space and further apart in
 * time, which is the corrective phase.
 */
function moveDelays(n, rng) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = n === 1 ? 1 : i / (n - 1);
    out.push(Math.round(clamp(gauss(rng, 7 + p * 9, 3), 3, 40)));
  }
  return out;
}

/**
 * settleMs: hover dwell after arriving, before the button goes down.
 * holdMs:   press to release. Previously zero (the two events were awaited back
 *           to back), which is physically impossible.
 */
function clickTiming(rng) {
  return {
    settleMs: Math.round(clamp(gauss(rng, 78, 30), 25, 220)),
    holdMs: Math.round(clamp(gauss(rng, 68, 22), 32, 190)),
  };
}

/**
 * A plausible resting position for a cursor whose real location we do not know
 * (first interaction with a tab). Anywhere but 0,0 and not the target, so the
 * first click still has a real approach path.
 */
function idlePointer(viewport, rng) {
  const w = (viewport && viewport.width) || 1280;
  const h = (viewport && viewport.height) || 800;
  return {
    x: Math.round(w * (0.25 + rng() * 0.5)),
    y: Math.round(h * (0.3 + rng() * 0.5)),
  };
}

// Node (`node --test`) only; in the service worker `module` is undefined and the
// declarations above are already globals reachable from background.js.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    makeRng, gauss, clamp,
    keyDescriptor, needsShift, keystrokeDelays,
    pointInRect, mousePath, moveDelays, clickTiming, idlePointer,
    easeInOutQuad, cubicBezier,
    SHIFT, CTRL, ALT, META,
  };
}
