# kSQL-FlowNet

`kSQL-FlowNet` is the Control Plane CLI for kSQL-Flow job networks.

## Requirements

- Node.js 22 or later (an LTS release)
- npm

## Development

```sh
npm install
npm run build
npm run format:check
npm run lint
npm run typecheck
npm test
```

The unit tests use the built-in `node:test` runner to keep the bootstrap dependency set small.

## CLI

```sh
ksql-flownet --help
ksql-flownet --version
```

The `validate` and `plan` commands belong to FN-02. They are listed for discoverability but fail explicitly until FN-02 is implemented.
