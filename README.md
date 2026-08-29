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
```

`validate` checks the YAML schema, Phase 1 DAG rules, and referenced SQL files
without changing external state. `plan` is reserved for FN-03 and currently
fails explicitly as not implemented.

## License

MIT. See [LICENSE](./LICENSE).
