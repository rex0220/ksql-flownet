# kSQL-FlowNet

English | [日本語](./README.ja.md)

kSQL-FlowNet is a Control Plane CLI that manages multiple
[kSQL-Flow](https://www.npmjs.com/package/@rex0220/ksql-flow) jobs as a network
(DAG). It handles network-definition validation, Run uniqueness per business
key, dependency-ordered serial execution, resume, network locks, state
persistence, and audit trails. Networks may declare branching and joining DAGs,
but nodes execute one at a time in a stable topological order.

Combined with the "Run status" board plugin and the operation-request app on
kintone, operators can trigger rerun, stop, release, and new-run (START)
requests from the UI.

- **Installation guide**: [docs/installation.md](./docs/installation.md)
  (kintone apps, tokens, plugin, server, cron — from zero to production)
- **Specification and operations docs**: [docs/README.md](./docs/README.md)
  (integrated specification, first-response one-pager, recovery runbook)
- **Creating the kintone apps**: [templates/README.md](./templates/README.md)
- **Board plugin**: [plugin/README.md](./plugin/README.md)

## Requirements

- kintone (uses API tokens, a plugin, related records, and app templates)
- An execution server with Node.js 22 or later. All traffic is outbound HTTPS
  from the server to kintone; kintone never connects to the server (no inbound
  port, static IP, or domain required)
- See [Specification §2 (environment)](./docs/specification.md) for details

## Installation

Once the package is published to npm:

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

`validate` checks the YAML schema, DAG rules, and referenced SQL files without
changing external state.

`poll-requests` is a one-shot poller for the kintone operation-request app. It
claims `REQUESTED` records and performs `RERUN`, `STOP`, `RELEASE`, or `START`;
start it periodically from a scheduler such as cron. Configure it through the
`KSQL_FLOWNET_REQUEST_*` entries in [`.env.example`](./.env.example) and an
absolute-path allowlist such as:

```yaml
networks:
  - network_id: monthly_jobs
    definition_path: C:/srv/my-ksql-jobs/networks/monthly.yaml
    app_start: false
```

`app_start` is fail-closed: omitting it is equivalent to `false`, and only an
explicit boolean `true` enables START requests (launching a new Run from the
app) for that network. This flag does not remove the network from run lookup
for `RERUN`, `STOP`, or `RELEASE`.

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
$env:KSQL_FLOW_BIN_ARGS = '["C:\\path\\to\\ksql-flow\\dist\\cli.js"]'
```

`KSQL_FLOW_BIN_ARGS` also accepts whitespace-separated arguments. When using
the standalone executable, point `KSQL_FLOW_BIN` at it and leave
`KSQL_FLOW_BIN_ARGS` unset.

## Real-device E2E

After configuring the real-device environment described in
[`tests/e2e/README.md`](./tests/e2e/README.md), run the scenarios serially from
PowerShell. They access the configured kintone and kSQL-Flow environment and
must not run in CI. Each scenario writes a sanitized result JSON under
`tests/e2e/results/` and cleans up its own scoped state.

## License

MIT. See [LICENSE](./LICENSE).
