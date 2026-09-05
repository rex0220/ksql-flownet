import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const pluginDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(pluginDirectory, "..");
const pluginOutputDirectory = resolve(pluginDirectory, "dist");
const testOutputDirectory = resolve(repositoryDirectory, "dist", "plugin");
const activityOutput = resolve(pluginOutputDirectory, "activity.js");
const metafileOutput = resolve(pluginOutputDirectory, "activity-meta.json");
const desktopOutput = resolve(pluginOutputDirectory, "desktop.js");
const desktopMetafileOutput = resolve(
  pluginOutputDirectory,
  "desktop-meta.json",
);
const configOutput = resolve(pluginOutputDirectory, "config.js");

const workspaceResolver = {
  name: "workspace-resolver",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^\.{1,2}\// }, async (args) => {
      let path = resolve(args.resolveDir, args.path);
      if (extname(path) === ".js") {
        const typeScriptPath = `${path.slice(0, -3)}.ts`;
        try {
          await access(typeScriptPath);
          path = typeScriptPath;
        } catch {
          // Keep the JavaScript path so onLoad reports the original missing file.
        }
      }
      return { path, namespace: "workspace-file" };
    });
    buildContext.onLoad(
      { filter: /.*/, namespace: "workspace-file" },
      async (args) => ({
        contents: await readFile(args.path, "utf8"),
        loader: extname(args.path) === ".ts" ? "ts" : "js",
        resolveDir: dirname(args.path),
      }),
    );
  },
};

// manifest.json の version を bundle へ埋め込む(起動ログで配布版を識別するため。
// 2026-09-05 実機フィードバック: ハードコードの "v2" が manifest と食い違っていた)
const manifest = JSON.parse(
  await readFile(resolve(pluginDirectory, "manifest.json"), "utf8"),
);
const pluginVersionDefine = {
  __PLUGIN_VERSION__: JSON.stringify(String(manifest.version)),
};

async function buildWorkspaceEntry(entry, options) {
  return build({
    ...options,
    define: { ...(options.define ?? {}), ...pluginVersionDefine },
    stdin: {
      contents: await readFile(entry, "utf8"),
      loader: "ts",
      resolveDir: dirname(entry),
      sourcefile: entry,
    },
    plugins: [workspaceResolver],
    tsconfigRaw: {},
  });
}

await mkdir(pluginOutputDirectory, { recursive: true });
await mkdir(testOutputDirectory, { recursive: true });
await mkdir(resolve(pluginDirectory, "zip"), { recursive: true });

const activityBuild = await buildWorkspaceEntry(
  resolve(pluginDirectory, "src", "activity-entry.ts"),
  {
    outfile: activityOutput,
    bundle: true,
    format: "iife",
    globalName: "KsqlFlownetActivity",
    platform: "browser",
    target: "es2022",
    treeShaking: true,
    legalComments: "none",
    metafile: true,
  },
);

const desktopBuild = await buildWorkspaceEntry(
  resolve(pluginDirectory, "src", "desktop.ts"),
  {
    outfile: desktopOutput,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    treeShaking: true,
    legalComments: "none",
    sourcemap: false,
    metafile: true,
  },
);

await buildWorkspaceEntry(resolve(pluginDirectory, "src", "config.ts"), {
  outfile: configOutput,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  treeShaking: true,
  legalComments: "none",
  sourcemap: false,
});

const metafileText = `${JSON.stringify(activityBuild.metafile, null, 2)}\n`;
const desktopMetafileText = `${JSON.stringify(desktopBuild.metafile, null, 2)}\n`;
await writeFile(metafileOutput, metafileText, "utf8");
await writeFile(desktopMetafileOutput, desktopMetafileText, "utf8");

const forbidden = [
  ["node:", /node:/u],
  ["node:crypto", /node:crypto/u],
  ["require(", /require\s*\(/u],
  ["process.", /process\s*\./u],
];
async function inspectBrowserBundle(label, output, metadata) {
  const bundleText = await readFile(output, "utf8");
  for (const [tokenLabel, pattern] of forbidden) {
    if (pattern.test(bundleText) || pattern.test(metadata)) {
      throw new Error(
        `browser-incompatible token found in ${label} bundle: ${tokenLabel}`,
      );
    }
  }
}

await inspectBrowserBundle("activity", activityOutput, metafileText);
await inspectBrowserBundle("desktop", desktopOutput, desktopMetafileText);

const desktopText = await readFile(desktopOutput, "utf8");
for (const [label, pattern] of [
  ["cursor endpoint", /\/k\/v1\/records\/cursor\.json/u],
  ["bulk endpoint", /\/k\/v1\/bulkRequest\.json/u],
  ["DELETE method", /["']DELETE["']/u],
]) {
  if (pattern.test(desktopText)) {
    throw new Error(`forbidden runtime API found in desktop bundle: ${label}`);
  }
}
// P2-16 §6: 唯一許される PUT は cancel_requested 専用の固定 builder 1 箇所だけ。
// リテラル "PUT" の出現をちょうど 1 回に固定し、汎用 update 経路の混入を検出する。
const putLiterals = desktopText.match(/["']PUT["']/gu) ?? [];
if (putLiterals.length !== 1) {
  throw new Error(
    `desktop bundle must contain exactly one PUT literal (cancel_requested only), found ${putLiterals.length}`,
  );
}

const allowedDesktopEndpoints = new Set([
  "/k/v1/app/form/fields.json",
  "/k/v1/records.json",
  "/k/v1/record.json",
]);
const discoveredDesktopEndpoints = [
  ...desktopText.matchAll(/\/k\/v1\/[A-Za-z/]+\.json/gu),
].map((match) => match[0]);
for (const endpoint of discoveredDesktopEndpoints) {
  if (!allowedDesktopEndpoints.has(endpoint)) {
    throw new Error(
      `endpoint outside runtime allowlist found in desktop bundle: ${endpoint}`,
    );
  }
}

await Promise.all([
  buildWorkspaceEntry(resolve(pluginDirectory, "src", "activity-input.ts"), {
    outfile: resolve(testOutputDirectory, "activity-input.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    legalComments: "none",
  }),
  buildWorkspaceEntry(resolve(pluginDirectory, "src", "kintone-reader.ts"), {
    outfile: resolve(testOutputDirectory, "kintone-reader.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    legalComments: "none",
  }),
  ...[
    "board-action",
    "board-controller",
    "config",
    "desktop",
    "detail-controller",
    "error-summary",
    "render",
    "related-app-detection",
    "request-dialog",
    "request-client",
    "start-request",
    "start-request-dialog",
    "terminal-run-loader",
  ].map((name) =>
    buildWorkspaceEntry(resolve(pluginDirectory, "src", `${name}.ts`), {
      outfile: resolve(testOutputDirectory, `${name}.js`),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      legalComments: "none",
    }),
  ),
]);
