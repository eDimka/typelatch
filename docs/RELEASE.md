# Release checks

A release requires a clean dependency installation, static checks, project tests, a build, and installation of the packed artifact in a temporary project.

```sh
npm ci
npm run release:check
npm run benchmark
npm run prove:support
npm pack
```

The package check exercises CLI help, package download and integrity verification, retrieval, bundled benchmark data outside the checkout, all six registered MCP tools, successful validation, and rejection of invalid TypeScript before test execution.

Review package contents for private paths, credentials, generated caches, and unrelated research. Keep version metadata consistent. Commit the source, wait for CI, tag the verified commit, and attach the package and SHA256 checksum to the GitHub release.

The supported runtime begins at Node.js 22.12. CI exercises Linux and macOS on Node.js 22 and 24. Platform support is limited to successful CI runs. Windows is not claimed in this MVP.
