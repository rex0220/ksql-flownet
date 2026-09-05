import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import {
  CSV1_NODE,
  cleanupTargetRows,
  createLegacyCli,
  csvPath,
  csvRows,
  prepareCsv1Case,
  runCsv1,
  runFixture,
  writeCsv,
} from "./csv1-support.mjs";
import { loadRunGraph, runFlowNetNetwork } from "./support.mjs";
import {
  assertPersistenceUnchanged,
  persistenceSnapshot,
} from "./p2-11-support.mjs";

function assertPreExecutionFailure(graph, code) {
  assert.equal(graph.run.status, "FAILED");
  const attempt = graph.attempts.at(-1);
  assert.equal(attempt?.status, "FAILED");
  assert.equal(attempt?.resultCode, code);
  // 共有decoderは空DATETIMEを空文字で返す(kintone保存表現)。未起動=空/nullの両表現を許容
  assert.ok(
    !attempt?.executionStartedAt,
    "execution_started_atは未設定であること",
  );
  assert.ok(
    !attempt?.runnerExecutionStartedAt,
    "runner_execution_started_atは未設定であること",
  );
}

await runCsv1(
  import.meta.url,
  "csv1-03-rejections",
  async ({ settings, scope }) => {
    const cases = [];
    try {
      for (const label of ["missing", "link", "legacy"])
        cases.push(
          await prepareCsv1Case(settings, `${scope}_${label}`, {
            encoding: "UTF8",
          }),
        );
    } catch (error) {
      await Promise.allSettled(cases.map((testCase) => testCase.dispose()));
      throw error;
    }
    const [missingCase, linkCase, legacyCase] = cases;
    const rows = csvRows(scope, 2);
    let outside = null;
    try {
      const missingKey = `${scope}_missing`;
      const missing = await runFixture(
        settings,
        missingCase.fixture,
        missingKey,
        missingCase.ioRoot,
      );
      assert.equal(missing.exitCode, 1);
      const missingGraph = await loadRunGraph(settings, missingKey);
      assertPreExecutionFailure(missingGraph, "INPUT_FILE_MISSING");

      const linkKey = `${scope}_symlink`;
      outside = await mkdtemp(join(settings.ioBase, `${scope}_outside_`));
      const outsidePath = csvPath(outside, linkKey, settings.profile);
      await writeCsv(outsidePath, rows);
      const link = join(linkCase.ioRoot, "in", "csv1");
      let symlinkCase;
      try {
        await mkdir(join(linkCase.ioRoot, "in"), { recursive: true });
        await symlink(
          join(outside, "in", "csv1"),
          link,
          process.platform === "win32" ? "junction" : "dir",
        );
        const rejected = await runFixture(
          settings,
          linkCase.fixture,
          linkKey,
          linkCase.ioRoot,
        );
        assert.equal(rejected.exitCode, 1);
        const graph = await loadRunGraph(settings, linkKey);
        assertPreExecutionFailure(graph, "INPUT_PATH_REJECTED");
        symlinkCase = { supported: true, graph };
      } catch (error) {
        if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
        symlinkCase = {
          supported: false,
          reason: `link creation unavailable (${error.code})`,
          unitReference:
            "tests/unit/io-path.test.mjs: symlinkまたはjunctionを含む入力pathを拒否する",
        };
      }

      const beforeLegacy = await persistenceSnapshot(settings);
      const legacyCli = await createLegacyCli(legacyCase.fixture.directory);
      const legacyKey = `${scope}_legacy`;
      const legacy = await runFlowNetNetwork(
        {
          ...settings,
          configPath: legacyCase.fixture.configPath,
          ksqlFlowBin: process.execPath,
          ksqlFlowBinArgs: [legacyCli],
        },
        legacyCase.fixture.networkPath,
        legacyKey,
        { environment: { KSQL_FLOWNET_IO_DIR: legacyCase.ioRoot } },
      );
      assert.equal(legacy.exitCode, 1);
      assert.match(
        `${legacy.stdout}\n${legacy.stderr}`,
        /CAPABILITY_FEATURE_MISSING|importCsv/u,
      );
      await assertPersistenceUnchanged(settings, beforeLegacy);

      return {
        missing: missingGraph,
        symlinkOutsideRoot: symlinkCase,
        lexicalOutsideRoot:
          "Network schema rejects absolute/traversal patterns; tests/unit/io-path.test.mjs covers direct resolver root-outside inputs.",
        legacyCapability: {
          exitCode: legacy.exitCode,
          stateUnchanged: true,
          rejectedBeforeNetworkLock: true,
        },
        nodeIds: {
          missing: missingCase.fixture.nodeId(CSV1_NODE),
          link: linkCase.fixture.nodeId(CSV1_NODE),
          legacy: legacyCase.fixture.nodeId(CSV1_NODE),
        },
      };
    } finally {
      await Promise.all([
        cleanupTargetRows(
          settings,
          rows.map(({ key }) => key),
        ),
        ...cases.map((testCase) => testCase.dispose()),
        ...(outside ? [rm(outside, { recursive: true, force: true })] : []),
      ]);
    }
  },
);
