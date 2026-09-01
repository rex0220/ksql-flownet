import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "plugin/dist/", "plugin/zip/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "plugin/src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["tests/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        process: "readonly",
        Response: "readonly",
        setImmediate: "readonly",
      },
    },
  },
  {
    files: ["spikes/**/*.mjs"],
    languageOptions: {
      globals: {
        Blob: "readonly",
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        performance: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    // Consoleスクリプトも静的検査の対象に残し、実行環境固有のglobalだけを許可する。
    files: ["spikes/**/*.console.js"],
    languageOptions: {
      globals: {
        confirm: "readonly",
        console: "readonly",
        kintone: "readonly",
        location: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: {
      "no-console": "off",
    },
  },
);
