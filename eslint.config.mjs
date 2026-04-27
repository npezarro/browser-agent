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
