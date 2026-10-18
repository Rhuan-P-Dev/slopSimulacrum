import js from "@eslint/js";
import unusedImports from "eslint-plugin-unused-imports";

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
        // testes (vitest)
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
    // The browser client. Deliberately linted with the same unused-code rules
    // as the server; `no-console` stays off here because Logger-free diagnostics
    // in the browser console are how this client reports UI failures today.
    files: ["public/**/*.js"],
    languageOptions: { globals: BROWSER_GLOBALS },
    rules: { "no-console": "off" },
  },
  {
    ignores: ["node_modules/", "coverage/", "data/", "wiki/", "plans/", "docs/"],
  },
];
