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

async function buildWorkspaceEntry(entry, options) {
  return build({
    ...options,
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

const metafileText = `${JSON.stringify(activityBuild.metafile, null, 2)}\n`;
await writeFile(metafileOutput, metafileText, "utf8");

const forbidden = [
  ["node:", /node:/u],
  ["node:crypto", /node:crypto/u],
  ["require(", /require\s*\(/u],
  ["process.", /process\s*\./u],
];
const bundleText = await readFile(activityOutput, "utf8");
for (const [label, pattern] of forbidden) {
  if (pattern.test(bundleText) || pattern.test(metafileText)) {
    throw new Error(
      `browser-incompatible token found in activity bundle: ${label}`,
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
]);
