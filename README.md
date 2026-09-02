# kSQL-FlowNet

kSQL-FlowNet is the Control Plane CLI for defining and validating kSQL-Flow job
networks. Phase 1 accepts DAGs such as branches and joins, but executes every
eligible node sequentially in a stable topological order.

## Installation

Node.js 22 or later is required.

After the package is published to npm:

```sh
npm install --global @rex0220/ksql-flownet
```

## Development

```sh
npm install
npm run build
npm run format:check
npm run lint
npm run typecheck
npm test
```

## CLI usage

```sh
ksql-flownet --help
ksql-flownet --version
ksql-flownet validate path/to/network.yaml
ksql-flownet poll-requests --check
```

`validate` checks the YAML schema, Phase 1 DAG rules, and referenced SQL files
without changing external state.

`poll-requests` is a one-shot poller for the kintone operation-request app. It
claims `REQUESTED` records and performs `RERUN`, `STOP`, or `RELEASE`; a
scheduler such as cron starts it periodically. Configure it through the five
`KSQL_FLOWNET_REQUEST_*` entries in [`.env.example`](./.env.example) and an
absolute-path allowlist such as:

```yaml
networks:
  - network_id: monthly_jobs
    definition_path: C:/srv/my-ksql-jobs/networks/monthly.yaml
    app_start: false
```

`app_start` is fail-closed: omitting it is equivalent to `false`, and only an
explicit boolean `true` enables START requests for that network. This flag does
not remove the network from run lookup for `RERUN`, `STOP`, or `RELEASE`.

Before enabling a production schedule, run `poll-requests --check`. This is a
read-only preflight: it validates every allowlisted network definition and its
`network_id`, then confirms GET access to the request app. It does not claim or
update requests and does not start `status`, `run-network`, or `cancel-run`
children. A nonzero exit must block schedule activation.

Each network node must also satisfy
`KSQL_FLOWNET_PROFILE + ":" + nodes[].job_id` <= 64 UTF-16 code units. This is
the measured kSQL-Flow job-lock-key limit. The current `validate` command does
not detect an overrun; execution fails later with `VALIDATION_ERROR`.

To run `run-network` against a source build of kSQL-Flow on Windows, set the
executable and its leading CLI-script argument separately. Use the JSON array
form when an argument contains spaces:

```powershell
$env:KSQL_FLOW_BIN = 'node.exe'
$env:KSQL_FLOW_BIN_ARGS = '["C:\\Users\\rex02\\Projects\\ksql-flow\\dist\\cli.js"]'
```

`KSQL_FLOW_BIN_ARGS` also accepts whitespace-separated arguments. After the
standalone executable is rebuilt, `KSQL_FLOW_BIN` can point to the executable
and `KSQL_FLOW_BIN_ARGS` can be unset.

## M7 acceptance-gap E2E

After configuring the real-device environment described in
[`tests/e2e/README.md`](./tests/e2e/README.md), run the M7 scenarios serially
from PowerShell. These commands access the configured kintone and kSQL-Flow
environment and must not be run as part of CI.

```powershell
node tests\e2e\m7-01-acceptance-gaps.mjs
node tests\e2e\m7-02-kintone-drain.mjs
node tests\e2e\m7-03-control-plane-api-calls.mjs
node tests\e2e\m7-04-windows-sigbreak.mjs
```

Each scenario writes a sanitized result JSON under `tests/e2e/results/` and
cleans its M7-scoped state. The SIGBREAK scenario is Windows-only.

## License

MIT. See [LICENSE](./LICENSE).
