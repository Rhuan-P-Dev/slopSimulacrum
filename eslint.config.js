import js from "@eslint/js";
import unusedImports from "eslint-plugin-unused-imports";
import crRules from "./tools/eslint-rules.js";

// Browser globals the client sources reference. Kept explicit and enumerated:
// when `no-undef` reports a real browser global, add it here. Never turn
// `no-undef` off for public/ - that would silence the one check that catches a
// typo'd identifier in code nobody can type-check.
const BROWSER_GLOBALS = {};
for (const name of [
  "window", "document", "localStorage", "sessionStorage", "navigator",
  "fetch", "Request", "Response", "Headers", "AbortController", "FormData",
  "Blob", "URL", "URLSearchParams", "structuredClone", "performance",
  "requestAnimationFrame", "getComputedStyle", "CustomEvent", "Event",
  "HTMLElement", "prompt", "io", "socket",
]) {
  BROWSER_GLOBALS[name] = "readonly";
}

// Data seam (CR B-3): the only files that may import `fs`. Keep in sync with
// the fs imports in src/utils/DataLoader.js and the PNG reader. The same list
// is the default of the cr/no-direct-file-read rule (tools/eslint-rules.js).
const DATA_SEAM_FS_FILES = [
  "src/utils/DataLoader.js",
  "src/utils/PngCharaReader.js",
  "src/controllers/logic/CardSpawnLogic.js",
];

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        // Node.js
        process: "readonly", require: "readonly", module: "readonly",
        global: "readonly", __dirname: "readonly", console: "readonly",
        Buffer: "readonly",
        URL: "readonly", URLSearchParams: "readonly", setTimeout: "readonly",
        clearTimeout: "readonly", setInterval: "readonly",
        clearInterval: "readonly", setImmediate: "readonly",
        queueMicrotask: "readonly", structuredClone: "readonly",
        crypto: "readonly", fetch: "readonly", Request: "readonly",
        Response: "readonly", Headers: "readonly", AbortController: "readonly",
        // vitest
        describe: "readonly", it: "readonly", expect: "readonly",
        vi: "readonly", beforeAll: "readonly", beforeEach: "readonly",
        afterEach: "readonly", afterAll: "readonly",
      },
    },
    plugins: { "unused-imports": unusedImports },
    rules: {
      "unused-imports/no-unused-imports": "error",
      "no-unused-vars": [
        "error",
        {
          vars: "all",
          args: "after-used",
          caughtErrors: "none",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "no-undef": "error",
    },
  },
  {
    // Browser client. Linted with the same unused-code rules as the server;
    // `no-console` stays off here because Logger-free diagnostics in the
    // browser console are how this client reports UI failures today.
    files: ["public/**/*.js"],
    languageOptions: { globals: BROWSER_GLOBALS },
    rules: { "no-console": "off" },
  },
  {
    // CR rules (CODE_RULES.md). Scope: server code + shared modules.
    // The fixtures in src/lint-fixtures/ are deliberate counter-examples: they
    // stay lintable so test/lint-rules.test.js can prove each rule still fires,
    // while the gate lint (npm run lint) excludes them with --ignore-pattern.
    plugins: { cr: crRules },
    files: ["src/**/*.js", "shared/**/*.js"],
    rules: {
      "cr/fetch-requires-signal": "error",
      "cr/no-direct-file-read": ["error", { allowedFiles: DATA_SEAM_FS_FILES }],
      "cr/no-accented-text": "error",
      "no-console": "error",
    },
  },
  {
    // Logger exemption: it IS the logging utility (CR OBS-1).
    files: ["src/utils/Logger.js"],
    rules: { "no-console": "off" },
  },
  {
    // RangeResolver: client-side pure geometry; its console.warn keeps the
    // module independent of the server Logger (CR OBS-1).
    files: ["shared/RangeResolver.js"],
    rules: { "no-console": "off" },
  },
  {
    ignores: [
      "node_modules/",
      "coverage/",
      "data/",
      "wiki/",
      "plans/",
      "docs/",
    ],
  },
];
