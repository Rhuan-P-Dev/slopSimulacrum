import js from "@eslint/js";
import unusedImports from "eslint-plugin-unused-imports";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        // Node.js
        process: "readonly",
        require: "readonly",
        module: "readonly",
        __dirname: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        queueMicrotask: "readonly",
        structuredClone: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        AbortController: "readonly",
        // testes (vitest)
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        vi: "readonly",
        beforeAll: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        afterAll: "readonly",
      },
    },
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      // unused imports: removed automatically via `npm run lint:fix`
      "unused-imports/no-unused-imports": "error",
      "no-unused-vars": [
        "error",
        {
          vars: "all",
          args: "after-used",
          // catch (err) not using err is not an error (common best-effort pattern)
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
    ignores: ["node_modules/", "coverage/", "public/", "data/", "wiki/", "plans/", "docs/"],
  },
];
