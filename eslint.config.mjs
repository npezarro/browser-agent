import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,

  // Server-side Node.js files (CJS)
  {
    files: ["agent-server.js", "lib/**/*.js", "ecosystem.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },

  // Tampermonkey userscript (browser + GM_ APIs)
  {
    files: ["browser-agent.user.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        GM_xmlhttpRequest: "readonly",
        GM_getValue: "readonly",
        GM_setValue: "readonly",
        GM_deleteValue: "readonly",
        GM_listValues: "readonly",
        GM_info: "readonly",
        GM_notification: "readonly",
        unsafeWindow: "readonly",
      },
    },
  },

  // Chrome extension files (browser + chrome APIs)
  {
    files: ["extension/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        chrome: "readonly",
      },
    },
  },

  // The service worker runs in MV3 worker scope and pulls tab-target.js in via
  // importScripts, so those declarations land on its global scope.
  {
    files: ["extension/background.js"],
    languageOptions: {
      globals: {
        importScripts: "readonly",
        resolveTargetCore: "readonly",
        originMismatch: "readonly",
        // Also from tab-target.js via importScripts (origin containment, 2.11.0).
        isSensitiveOrigin: "readonly",
        allowlistViolation: "readonly",
        originOf: "readonly",
        // From human-input.js via importScripts (humanized input, 2.12.0).
        makeRng: "readonly",
        keyDescriptor: "readonly",
        keystrokeDelays: "readonly",
        pointInRect: "readonly",
        mousePath: "readonly",
        moveDelays: "readonly",
        clickTiming: "readonly",
        idlePointer: "readonly",
      },
    },
  },

  // tab-target.js and human-input.js are dual-target: importScripts'd by the
  // service worker and require'd by `node --test`, so they guard a CJS export.
  {
    files: ["extension/tab-target.js", "extension/human-input.js"],
    languageOptions: {
      globals: { module: "readonly" },
    },
  },

  // Test files
  {
    files: ["test/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },

  // Shared rules
  {
    rules: {
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },

  // Ignore generated/data files
  {
    ignores: ["node_modules/"],
  },
];
