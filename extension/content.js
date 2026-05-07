// Browser Agent Content Script (v2.0.0)
// Replaces the Tampermonkey userscript with a native extension content script.
// Polls relay server for commands, executes against the DOM, reports results.

"use strict";

const VERSION = "2.0.0";
const API_BASE = "https://pezant.ca/api/browser-agent";
const API = API_BASE + "/agent";
const POLL_MS = 3000;
const USER_IDLE_MS = 5000;

// ── User activity detection — pause polling during active browser use ──

let lastUserActivity = 0;
let activityThrottled = false;

function onUserActivity() {
  if (activityThrottled) return;
  lastUserActivity = Date.now();
  activityThrottled = true;
  setTimeout(() => { activityThrottled = false; }, 500);
}

for (const evt of ["mousemove", "mousedown", "keydown", "scroll", "wheel", "touchstart"]) {
  window.addEventListener(evt, onUserActivity, { passive: true, capture: true });
}

function isUserActive() {
  if (document.hidden) return false;
  return document.hasFocus() && (Date.now() - lastUserActivity) < USER_IDLE_MS;
}

// ── Per-tab ID via sessionStorage (survives SPA navigation, unique per tab) ──

const stored = sessionStorage.getItem("_browserAgentTabId");
const tabId = stored || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
if (!stored) sessionStorage.setItem("_browserAgentTabId", tabId);

// ── Console log capture (circular buffer) ──

const MAX_CONSOLE = 100;
const consoleLogs = new Array(MAX_CONSOLE);
let consoleHead = 0;
let consoleCount = 0;
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function captureConsole(level, args) {
  const msg = args.map((a) => typeof a === "object" ? JSON.stringify(a).substring(0, 300) : String(a)).join(" ");
  consoleLogs[consoleHead] = { level, msg, ts: Date.now() };
  consoleHead = (consoleHead + 1) % MAX_CONSOLE;
  if (consoleCount < MAX_CONSOLE) consoleCount++;
}

function getConsoleLogs(count) {
  count = Math.min(count || 50, consoleCount);
  const result = [];
  let idx = (consoleHead - count + MAX_CONSOLE) % MAX_CONSOLE;
  for (let i = 0; i < count; i++) {
    result.push(consoleLogs[idx]);
    idx = (idx + 1) % MAX_CONSOLE;
  }
  return result;
}

console.log = function (...args) { origLog.apply(console, args); captureConsole("log", args); };
console.warn = function (...args) { origWarn.apply(console, args); captureConsole("warn", args); };
console.error = function (...args) { origError.apply(console, args); captureConsole("error", args); };

window.addEventListener("error", (e) => {
  captureConsole("error", [`${e.message} at ${e.filename}:${e.lineno}`]);
});

// ── Network helpers ──

function log(msg) {
  origLog(`[BrowserAgent] ${msg}`);
  post("/log", { tabId, msg, ts: Date.now() });
}

function post(path, data) {
  fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }).catch(() => {});
}

// keepalive variant for pre-unload posts (navigate, back, reload, closeTab)
function postKeepAlive(path, data) {
  fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    keepalive: true,
  }).catch(() => {});
}

// ── Page introspection ──

function getPageStateLite() {
  return {
    tabId, url: window.location.href, title: document.title,
    version: VERSION, ts: Date.now(),
    scrollY: window.scrollY,
    docHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    readyState: document.readyState,
  };
}

function getPageState() {
  const buttons = [];
  const textCount = {};
  for (const el of document.querySelectorAll("button, a[class*='button'], a[class*='btn'], a[role='button'], [role='button'], input[type='submit'], input[type='button']")) {
    const text = (el.innerText || el.value || "").trim().replace(/\s+/g, " ");
    if (!text || text.length > 100) continue;
    textCount[text] = (textCount[text] || 0) + 1;
    buttons.push({
      text,
      nth: textCount[text],
      tag: el.tagName,
      disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
      visible: el.offsetParent !== null,
      classes: (el.className?.toString() || "").substring(0, 120),
      href: el.href || null,
      id: el.id || null,
    });
    if (buttons.length >= 80) break;
  }

  const inputs = [];
  for (const el of document.querySelectorAll("input:not([type='hidden']), select, textarea")) {
    inputs.push({
      tag: el.tagName, type: el.type || "", name: el.name || "",
      value: el.type === "password" ? "***" : (el.value || "").substring(0, 120),
      id: el.id || "", placeholder: el.placeholder || "",
      label: el.labels?.[0]?.innerText?.trim().substring(0, 80) || "",
    });
    if (inputs.length >= 30) break;
  }

  const dialogs = [];
  for (const el of document.querySelectorAll("[role='dialog'], [role='alertdialog'], dialog, [class*='modal']:not([class*='modal-'])")) {
    if (el.offsetParent === null && !el.open) continue;
    dialogs.push({ text: el.innerText?.trim().substring(0, 500).replace(/\s+/g, " ") });
    if (dialogs.length >= 5) break;
  }

  const errors = [];
  for (const el of document.querySelectorAll("[class*='error'], [role='alert'], [class*='warning'], [class*='Error']")) {
    const t = el.innerText?.trim().substring(0, 300);
    if (t && t.length > 3) errors.push(t);
    if (errors.length >= 10) break;
  }

  return {
    ...getPageStateLite(),
    buttons, inputs, dialogs, errors,
    bodyText: (document.body?.innerText || "").substring(0, 3000),
  };
}

// ── Command executor ──

async function execCommand(cmd) {
  const { action, id } = cmd;
  try {
    let result;

    switch (action) {
      case "getState":
        result = getPageState();
        break;

      case "getConsoleLog":
        result = { logs: getConsoleLogs(cmd.count || 50) };
        break;

      case "getBodyText":
        result = { text: (document.body?.innerText || "").substring(0, cmd.maxLen || 5000) };
        break;

      case "getHtml": {
        const htmlEl = cmd.selector ? document.querySelector(cmd.selector) : document.body;
        result = { html: (htmlEl?.innerHTML || "").substring(0, cmd.maxLen || 10000) };
        break;
      }

      case "querySelector": {
        const el = document.querySelector(cmd.selector);
        result = el ? {
          found: true, tag: el.tagName, text: el.innerText?.trim().substring(0, 300),
          classes: el.className?.toString().substring(0, 120),
          href: el.href || null, value: el.value || null,
          id: el.id || null, visible: el.offsetParent !== null,
        } : { found: false };
        break;
      }

      case "querySelectorAll": {
        const els = document.querySelectorAll(cmd.selector);
        result = { count: els.length, elements: [] };
        for (const el of [...els].slice(0, cmd.limit || 30)) {
          result.elements.push({
            tag: el.tagName,
            text: el.innerText?.trim().substring(0, 150),
            classes: (el.className?.toString() || "").substring(0, 80),
            href: el.href || null, id: el.id || null,
            visible: el.offsetParent !== null,
          });
        }
        break;
      }

      case "click": {
        let el;
        if (cmd.selector) {
          if (cmd.nth && cmd.nth > 1) {
            const all = document.querySelectorAll(cmd.selector);
            el = all[cmd.nth - 1] || null;
          } else {
            el = document.querySelector(cmd.selector);
          }
        } else if (cmd.text) {
          const scope = cmd.scope || "button, a, input[type='submit'], input[type='button'], [role='button']";
          const lc = cmd.text.toLowerCase();
          let matchNum = 0;
          const targetNth = cmd.nth || 1;
          for (const candidate of document.querySelectorAll(scope)) {
            const t = (candidate.innerText || candidate.value || "").trim().toLowerCase();
            if (cmd.exact ? t === lc : t.includes(lc)) {
              if (!cmd.excludeText || !cmd.excludeText.some((ex) => t.includes(ex.toLowerCase()))) {
                matchNum++;
                if (matchNum === targetNth) {
                  el = candidate;
                  break;
                }
              }
            }
          }
        }
        if (el) {
          el.scrollIntoView({ block: "center" });
          el.click();
          result = { clicked: true, text: (el.innerText || el.value || "").trim().substring(0, 80) };
        } else {
          result = { clicked: false, error: "Element not found" };
        }
        break;
      }

      case "navigate":
        postKeepAlive("/result", { tabId, id, ok: true, result: { navigating: true, url: cmd.url } });
        await new Promise((r) => setTimeout(r, 200));
        window.location.href = cmd.url;
        return null;

      case "openTab":
      case "openTabBackground":
        window.open(cmd.url, "_blank");
        result = { opened: true, url: cmd.url, background: false };
        break;

      case "closeTab":
        postKeepAlive("/result", { tabId, id, ok: true, result: { closing: true, url: window.location.href } });
        await new Promise((r) => setTimeout(r, 200));
        window.close();
        return null;

      case "back":
        postKeepAlive("/result", { tabId, id, ok: true, result: { navigating: true, direction: "back" } });
        await new Promise((r) => setTimeout(r, 200));
        window.history.back();
        return null;

      case "reload":
        postKeepAlive("/result", { tabId, id, ok: true, result: { reloading: true } });
        await new Promise((r) => setTimeout(r, 200));
        window.location.reload();
        return null;

      case "wait":
        await new Promise((r) => setTimeout(r, cmd.ms || 1000));
        result = { waited: cmd.ms || 1000 };
        break;

      case "waitForSelector": {
        const timeout = cmd.timeout || 10000;
        const start = Date.now();
        let found = null;
        while (Date.now() - start < timeout) {
          found = document.querySelector(cmd.selector);
          if (found) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        result = found
          ? { found: true, text: found.innerText?.trim().substring(0, 200), elapsed: Date.now() - start }
          : { found: false, elapsed: Date.now() - start };
        break;
      }

      case "waitForText": {
        const timeout2 = cmd.timeout || 10000;
        const start2 = Date.now();
        const searchText = cmd.text.toLowerCase();
        let textFound = false;
        while (Date.now() - start2 < timeout2) {
          if ((document.body?.innerText || "").toLowerCase().includes(searchText)) {
            textFound = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        result = { found: textFound, elapsed: Date.now() - start2 };
        break;
      }

      case "read": {
        const readEl = document.querySelector(cmd.selector);
        result = readEl ? {
          found: true, text: readEl.innerText?.trim().substring(0, cmd.maxLen || 1000),
          value: readEl.value || null,
        } : { found: false };
        break;
      }

      case "readAttr": {
        const attrEl = document.querySelector(cmd.selector);
        result = attrEl ? {
          found: true, value: attrEl.getAttribute(cmd.attr),
        } : { found: false };
        break;
      }

      case "eval": {
        try {
          const fn = new Function("document", "window", cmd.code);
          const evalResult = await fn(document, window);
          if (typeof evalResult === "undefined") {
            result = { value: "undefined" };
          } else if (typeof evalResult === "object") {
            result = { value: JSON.stringify(evalResult).substring(0, cmd.maxLen || 5000) };
          } else {
            result = { value: String(evalResult).substring(0, cmd.maxLen || 5000) };
          }
        } catch (evalErr) {
          if (evalErr instanceof EvalError || evalErr.message?.includes("Content Security Policy")) {
            // CSP blocks eval in content script — fall back to CDP via background
            log("eval blocked by CSP, falling back to CDP");
            const cdpResult = await new Promise((resolve) => {
              chrome.runtime.sendMessage(
                { type: "ba-eval-fallback", code: cmd.code, maxLen: cmd.maxLen },
                (resp) => resolve(resp || { error: "No response from background" })
              );
            });
            if (cdpResult.error) {
              result = { value: null, error: cdpResult.error, fallback: "cdp" };
            } else {
              const v = cdpResult.value;
              if (typeof v === "undefined" || v === undefined) {
                result = { value: "undefined", fallback: "cdp" };
              } else if (typeof v === "object") {
                result = { value: JSON.stringify(v).substring(0, cmd.maxLen || 5000), fallback: "cdp" };
              } else {
                result = { value: String(v).substring(0, cmd.maxLen || 5000), fallback: "cdp" };
              }
            }
          } else {
            throw evalErr;
          }
        }
        break;
      }

      case "setInput": {
        const inputEl = document.querySelector(cmd.selector);
        if (inputEl) {
          inputEl.focus();
          const tracker = inputEl._valueTracker;
          if (tracker) tracker.setValue("");
          const proto = inputEl.tagName === "TEXTAREA"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const nativeSet = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (nativeSet) nativeSet.call(inputEl, cmd.value);
          else inputEl.value = cmd.value;
          inputEl.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: cmd.value, bubbles: true, cancelable: true }));
          inputEl.dispatchEvent(new Event("change", { bubbles: true }));
          result = { set: true };
        } else {
          result = { set: false, error: "Input not found" };
        }
        break;
      }

      case "type": {
        const typeEl = cmd.selector ? document.querySelector(cmd.selector) : document.activeElement;
        if (typeEl) {
          typeEl.focus();
          if (typeEl.value && !cmd.append) {
            typeEl.select?.();
            document.execCommand("delete", false);
          }
          const execOk = document.execCommand("insertText", false, cmd.text);
          if (!execOk) {
            for (const char of cmd.text) {
              const vt = typeEl._valueTracker;
              if (vt) vt.setValue(typeEl.value);
              typeEl.dispatchEvent(new KeyboardEvent("keydown", { key: char, code: `Key${char.toUpperCase()}`, bubbles: true }));
              const typeProto = typeEl.tagName === "TEXTAREA"
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
              const nSet = Object.getOwnPropertyDescriptor(typeProto, "value")?.set;
              if (nSet) nSet.call(typeEl, typeEl.value + char);
              else typeEl.value += char;
              typeEl.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: char, bubbles: true, cancelable: true }));
              typeEl.dispatchEvent(new KeyboardEvent("keyup", { key: char, code: `Key${char.toUpperCase()}`, bubbles: true }));
              if (cmd.delay) await new Promise((r) => setTimeout(r, cmd.delay));
            }
          }
          typeEl.dispatchEvent(new Event("change", { bubbles: true }));
          result = { typed: true, length: cmd.text.length, method: execOk ? "execCommand" : "synthetic" };
        } else {
          result = { typed: false, error: "Element not found" };
        }
        break;
      }

      case "scroll":
        if (cmd.selector) {
          const scrollEl = document.querySelector(cmd.selector);
          if (scrollEl) scrollEl.scrollIntoView({ behavior: "smooth", block: cmd.block || "center" });
        } else {
          window.scrollBy(0, cmd.y || 500);
        }
        result = { scrolled: true, scrollY: window.scrollY };
        break;

      case "screenshot":
        result = {
          url: window.location.href,
          title: document.title,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          scrollY: window.scrollY,
          bodyText: (document.body?.innerText || "").substring(0, cmd.maxLen || 3000),
        };
        break;

      case "getNetworkErrors":
        result = { errors: getConsoleLogs(consoleCount).filter((l) => l.level === "error").slice(-20) };
        break;

      case "assertText": {
        const bodyText = (document.body?.innerText || "").toLowerCase();
        const searchFor = cmd.text.toLowerCase();
        const found = bodyText.includes(searchFor);
        result = { pass: cmd.negate ? !found : found, text: cmd.text, negate: !!cmd.negate };
        break;
      }

      case "assertSelector": {
        const el = document.querySelector(cmd.selector);
        const exists = !!el;
        result = { pass: cmd.negate ? !exists : exists, selector: cmd.selector, negate: !!cmd.negate };
        break;
      }

      case "fillForm": {
        const results = {};
        for (const [sel, val] of Object.entries(cmd.fields || {})) {
          const field = document.querySelector(sel);
          if (field) {
            field.focus();
            const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            if (ns) ns.call(field, val); else field.value = val;
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.dispatchEvent(new Event("change", { bubbles: true }));
            results[sel] = "set";
          } else {
            results[sel] = "not found";
          }
        }
        result = { fields: results };
        break;
      }

      case "selectOption": {
        const selectEl = document.querySelector(cmd.selector);
        if (selectEl && selectEl.tagName === "SELECT") {
          selectEl.value = cmd.value;
          selectEl.dispatchEvent(new Event("change", { bubbles: true }));
          result = { selected: true, value: selectEl.value };
        } else {
          result = { selected: false, error: selectEl ? "Not a select element" : "Element not found" };
        }
        break;
      }

      case "uploadFile": {
        const resp = await fetch(`${API}/blob/${cmd.blobId}`);
        if (resp.status !== 200) throw new Error(`Blob fetch failed: ${resp.status}`);
        const blobData = await resp.json();
        if (!blobData.ok) throw new Error("Blob not found or expired");

        const binaryStr = atob(blobData.base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const file = new File([bytes], blobData.filename, { type: blobData.mimetype });

        const targetEl = document.querySelector(cmd.selector);
        if (!targetEl) throw new Error(`Upload target not found: ${cmd.selector}`);

        if (cmd.dragDrop) {
          const dt = new DataTransfer();
          dt.items.add(file);
          const dropEvent = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
          targetEl.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
          targetEl.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
          targetEl.dispatchEvent(dropEvent);
          result = { uploaded: true, mode: "dragDrop", filename: blobData.filename, size: bytes.length };
        } else {
          const dt = new DataTransfer();
          dt.items.add(file);
          targetEl.files = dt.files;
          targetEl.dispatchEvent(new Event("change", { bubbles: true }));
          targetEl.dispatchEvent(new Event("input", { bubbles: true }));
          result = { uploaded: true, mode: "fileInput", filename: blobData.filename, size: bytes.length };
        }
        break;
      }

      case "gmSet":
        await chrome.storage.local.set({ [`ba_${cmd.key}`]: cmd.value });
        result = { set: true };
        break;

      case "gmGet": {
        const store = await chrome.storage.local.get(`ba_${cmd.key}`);
        result = { value: store[`ba_${cmd.key}`] };
        break;
      }

      case "gmDelete":
        await chrome.storage.local.remove(`ba_${cmd.key}`);
        result = { deleted: true };
        break;

      case "notify":
        try {
          await chrome.runtime.sendMessage({ type: "ba-notify", title: cmd.title, text: cmd.text, timeout: cmd.timeout });
          result = { sent: true };
        } catch {
          result = { sent: false, error: "Background not available" };
        }
        break;

      case "clickAny": {
        const searchScope = cmd.scope || "*";
        const searchText = cmd.text.toLowerCase();
        const targetNth = cmd.nth || 1;

        const exactMatches = [];
        const startsWithMatches = [];

        for (const candidate of document.querySelectorAll(searchScope)) {
          if (candidate.offsetParent === null && !candidate.closest("[role='listbox'], [role='menu'], [role='dialog']")) continue;
          const t = (candidate.innerText || candidate.textContent || "").trim().toLowerCase();
          if (t.length > 200) continue;
          if (cmd.excludeText && cmd.excludeText.some((ex) => t.includes(ex.toLowerCase()))) continue;

          if (t === searchText) {
            exactMatches.push(candidate);
          } else if (!cmd.exact && t.startsWith(searchText + "\n")) {
            startsWithMatches.push(candidate);
          }
        }

        const allMatches = [...exactMatches, ...startsWithMatches];
        let clickTarget = null;
        if (targetNth <= allMatches.length) {
          clickTarget = allMatches[targetNth - 1];
        }

        if (clickTarget) {
          clickTarget.scrollIntoView({ block: "center" });
          clickTarget.click();
          result = { clicked: true, text: (clickTarget.innerText || "").trim().substring(0, 80), tag: clickTarget.tagName };
        } else {
          result = { clicked: false, error: `No element with text "${cmd.text}" found` };
        }
        break;
      }

      case "waitForRender": {
        const minLen = cmd.minLength || 50;
        const timeout = cmd.timeout || 15000;
        const start = Date.now();
        let bodyLen = 0;
        while (Date.now() - start < timeout) {
          bodyLen = (document.body?.innerText || "").length;
          if (bodyLen >= minLen) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        result = { rendered: bodyLen >= minLen, bodyLength: bodyLen, elapsed: Date.now() - start };
        break;
      }

      case "ping":
        result = { pong: true, url: window.location.href, version: VERSION, tabId };
        break;

      default:
        result = { error: `Unknown action: ${action}` };
    }

    return { id, ok: true, result };
  } catch (err) {
    return { id, ok: false, error: err.message, stack: err.stack?.substring(0, 300) };
  }
}

// ── Poll loop ──

let polling = false;

async function poll() {
  if (polling) return;
  polling = true;

  try {
    const resp = await fetch(`${API}/commands?tabId=${tabId}&url=${encodeURIComponent(window.location.href)}`);
    if (resp.status !== 200) return;
    const data = await resp.json();
    if (!data.commands || data.commands.length === 0) return;

    for (const cmd of data.commands) {
      if (isUserActive()) {
        log(`Deferring: ${cmd.action} (user active)`);
        await new Promise((resolve) => {
          const check = () => isUserActive() ? setTimeout(check, 1000) : resolve();
          check();
        });
      }

      await new Promise((resolve) => {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(resolve, { timeout: 2000 });
        } else {
          setTimeout(resolve, 50);
        }
      });

      log(`Exec: ${cmd.action}${cmd.selector ? ` ${cmd.selector}` : ""}${cmd.text ? ` "${cmd.text}"` : ""}`);
      const cmdTimeout = cmd.timeout || 60000;
      let result;
      let timer;
      try {
        result = await Promise.race([
          execCommand(cmd),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Command execution timeout")), cmdTimeout);
          }),
        ]);
      } catch (err) {
        result = { id: cmd.id, ok: false, error: err.message };
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (result) post("/result", { tabId, ...result });

      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (err) {
    origError("[BrowserAgent] Poll error:", err);
  } finally {
    polling = false;
  }
}

// ── Init ──

log(`v${VERSION} loaded on ${window.location.hostname}`);
post("/heartbeat", getPageStateLite());

let lastUrl = window.location.href;
function tick() {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    log(`Navigate: ${lastUrl.substring(0, 120)}`);
    post("/heartbeat", getPageStateLite());
  }

  if (isUserActive()) {
    setTimeout(tick, 2000);
    return;
  }

  poll();
  setTimeout(tick, POLL_MS);
}

setTimeout(tick, 800);
