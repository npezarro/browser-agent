// ==UserScript==
// @name         Browser Agent (Generic)
// @namespace    https://pezant.ca
// @version      1.2.0
// @description  Generic remote browser agent. Polls server for commands, executes them, reports results. Works on all pages.
// @author       npezarro
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_info
// @grant        GM_notification
// @connect      pezant.ca
// @run-at       document-idle
// @updateURL    https://pezant.ca/browser-agent.user.js
// @downloadURL  https://pezant.ca/browser-agent.user.js
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = GM_info.script.version;
  const API = "https://pezant.ca/api/browser-agent/agent";
  const POLL_MS = 3000;
  // Use sessionStorage for per-tab ID (survives SPA navigation, unique per tab)
  const stored = sessionStorage.getItem("_browserAgentTabId");
  const tabId = stored || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (!stored) sessionStorage.setItem("_browserAgentTabId", tabId);

  // ── Console log capture ──
  const consoleLogs = [];
  const MAX_CONSOLE = 100;
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  function captureConsole(level, args) {
    const msg = args.map((a) => typeof a === "object" ? JSON.stringify(a).substring(0, 300) : String(a)).join(" ");
    consoleLogs.push({ level, msg, ts: Date.now() });
    if (consoleLogs.length > MAX_CONSOLE) consoleLogs.shift();
  }

  console.log = function (...args) { origLog.apply(console, args); captureConsole("log", args); };
  console.warn = function (...args) { origWarn.apply(console, args); captureConsole("warn", args); };
  console.error = function (...args) { origError.apply(console, args); captureConsole("error", args); };

  // Capture unhandled errors
  window.addEventListener("error", (e) => {
    consoleLogs.push({ level: "error", msg: `${e.message} at ${e.filename}:${e.lineno}`, ts: Date.now() });
    if (consoleLogs.length > MAX_CONSOLE) consoleLogs.shift();
  });

  // ── Logging ──

  function log(msg) {
    origLog(`[BrowserAgent] ${msg}`);
    post("/log", { tabId, msg, ts: Date.now() });
  }

  function post(path, data) {
    GM_xmlhttpRequest({
      method: "POST",
      url: API + path,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(data),
    });
  }

  // ── Page introspection ──

  function getPageState() {
    const buttons = [];
    const seen = new Set();
    for (const el of document.querySelectorAll("button, a[class*='button'], a[class*='btn'], a[role='button'], [role='button'], input[type='submit'], input[type='button']")) {
      const text = (el.innerText || el.value || "").trim().replace(/\s+/g, " ");
      if (!text || text.length > 100 || seen.has(text)) continue;
      seen.add(text);
      buttons.push({
        text,
        tag: el.tagName,
        disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
        visible: el.offsetParent !== null,
        classes: (el.className?.toString() || "").substring(0, 120),
        href: el.href || null,
        id: el.id || null,
      });
      if (buttons.length >= 50) break;
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
      tabId, url: window.location.href, title: document.title,
      version: VERSION, ts: Date.now(),
      buttons, inputs, dialogs, errors,
      bodyText: (document.body?.innerText || "").substring(0, 3000),
      scrollY: window.scrollY,
      docHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      readyState: document.readyState,
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
          result = { logs: consoleLogs.slice(-(cmd.count || 50)) };
          break;

        case "getBodyText":
          result = { text: (document.body?.innerText || "").substring(0, cmd.maxLen || 5000) };
          break;

        case "getHtml":
          const htmlEl = cmd.selector ? document.querySelector(cmd.selector) : document.body;
          result = { html: (htmlEl?.innerHTML || "").substring(0, cmd.maxLen || 10000) };
          break;

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
            el = document.querySelector(cmd.selector);
          } else if (cmd.text) {
            const scope = cmd.scope || "button, a, input[type='submit'], input[type='button'], [role='button']";
            const lc = cmd.text.toLowerCase();
            for (const candidate of document.querySelectorAll(scope)) {
              const t = (candidate.innerText || candidate.value || "").trim().toLowerCase();
              if (cmd.exact ? t === lc : t.includes(lc)) {
                if (!cmd.excludeText || !cmd.excludeText.some((ex) => t.includes(ex.toLowerCase()))) {
                  el = candidate;
                  break;
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
          window.location.href = cmd.url;
          result = { navigating: true };
          break;

        case "openTab":
          window.open(cmd.url, "_blank");
          result = { opened: true, url: cmd.url };
          break;

        case "back":
          window.history.back();
          result = { navigating: true };
          break;

        case "reload":
          window.location.reload();
          result = { reloading: true };
          break;

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
          const fn = new Function("document", "window", cmd.code);
          const evalResult = await fn(document, window);
          if (typeof evalResult === "undefined") {
            result = { value: "undefined" };
          } else if (typeof evalResult === "object") {
            result = { value: JSON.stringify(evalResult).substring(0, cmd.maxLen || 5000) };
          } else {
            result = { value: String(evalResult).substring(0, cmd.maxLen || 5000) };
          }
          break;
        }

        case "setInput": {
          const inputEl = document.querySelector(cmd.selector);
          if (inputEl) {
            // Focus first for React-style apps
            inputEl.focus();
            // Use native setter to bypass React's synthetic events
            const nativeSet = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, "value"
            )?.set || Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype, "value"
            )?.set;
            if (nativeSet) nativeSet.call(inputEl, cmd.value);
            else inputEl.value = cmd.value;
            inputEl.dispatchEvent(new Event("input", { bubbles: true }));
            inputEl.dispatchEvent(new Event("change", { bubbles: true }));
            result = { set: true };
          } else {
            result = { set: false, error: "Input not found" };
          }
          break;
        }

        case "type": {
          // Simulate real keystrokes for apps that listen to keydown/keypress/keyup
          const typeEl = cmd.selector ? document.querySelector(cmd.selector) : document.activeElement;
          if (typeEl) {
            typeEl.focus();
            for (const char of cmd.text) {
              typeEl.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
              typeEl.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));
              // Update value
              const nSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
              if (nSet) nSet.call(typeEl, typeEl.value + char);
              else typeEl.value += char;
              typeEl.dispatchEvent(new Event("input", { bubbles: true }));
              typeEl.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
              if (cmd.delay) await new Promise((r) => setTimeout(r, cmd.delay));
            }
            typeEl.dispatchEvent(new Event("change", { bubbles: true }));
            result = { typed: true, length: cmd.text.length };
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

        case "screenshot": {
          // Capture visible viewport as data URL via html2canvas-lite approach
          // Falls back to just returning page dimensions and visible text
          result = {
            url: window.location.href,
            title: document.title,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            scrollY: window.scrollY,
            bodyText: (document.body?.innerText || "").substring(0, cmd.maxLen || 3000),
          };
          break;
        }

        case "getNetworkErrors": {
          // Return captured console errors (network errors show up in console)
          result = { errors: consoleLogs.filter((l) => l.level === "error").slice(-20) };
          break;
        }

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
          // Batch fill multiple fields: { fields: { "#name": "John", "#email": "j@x.com" } }
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

        case "gmSet":
          GM_setValue(cmd.key, cmd.value);
          result = { set: true };
          break;

        case "gmGet":
          result = { value: GM_getValue(cmd.key) };
          break;

        case "gmDelete":
          GM_deleteValue(cmd.key);
          result = { deleted: true };
          break;

        case "notify":
          GM_notification({ title: cmd.title || "Browser Agent", text: cmd.text, timeout: cmd.timeout || 5000 });
          result = { sent: true };
          break;

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

  function poll() {
    if (polling) return;
    polling = true;

    GM_xmlhttpRequest({
      method: "GET",
      url: `${API}/commands?tabId=${tabId}&url=${encodeURIComponent(window.location.href)}`,
      headers: { "Content-Type": "application/json" },
      onload: async (resp) => {
        polling = false;
        if (resp.status !== 200) return;
        try {
          const data = JSON.parse(resp.responseText);
          if (!data.commands || data.commands.length === 0) return;

          for (const cmd of data.commands) {
            log(`Exec: ${cmd.action}${cmd.selector ? ` ${cmd.selector}` : ""}${cmd.text ? ` "${cmd.text}"` : ""}`);
            const result = await execCommand(cmd);
            post("/result", { tabId, ...result });

            if (data.commands.length > 1) {
              await new Promise((r) => setTimeout(r, 300));
            }
          }
        } catch (err) {
          origError("[BrowserAgent] Poll error:", err);
        }
      },
      onerror: () => { polling = false; },
      ontimeout: () => { polling = false; },
    });
  }

  // ── Init ──

  log(`v${VERSION} loaded on ${window.location.hostname}`);
  post("/heartbeat", getPageState());

  // Watch for SPA navigation
  let lastUrl = window.location.href;
  setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      log(`Navigate: ${lastUrl.substring(0, 120)}`);
      post("/heartbeat", getPageState());
    }
  }, 2000);

  setInterval(poll, POLL_MS);
  setTimeout(poll, 800);
})();
