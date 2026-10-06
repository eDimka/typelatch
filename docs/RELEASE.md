# Release checks

A release requires a clean dependency installation, static checks, project tests, a build, and installation of the packed artifact in a temporary project.

```sh
npm ci
npm run release:check
npm run benchmark
npm run prove:support
npm run showcase:agent
npm pack
```

The package check exercises CLI help, package download and integrity verification, retrieval, workspace search through both the CLI and MCP, bundled benchmark data outside the checkout, all seven registered MCP tools, successful validation, and rejection of invalid TypeScript before test execution.

Monorepo checks exercise mixed lockfile ownership and saved project selection through the installed CLI. An MCP session verifies that adding and removing selected projects refreshes source coverage and reuses unchanged entries.

It also runs `typelatch setup` through npm with a fresh cache and no source checkout, using stub Codex and Claude Code clients. It checks that registration pins the package version and does not store the temporary package path. After publishing, verify `npx typelatch@latest setup --help` from a clean directory. The website publication gate checks direct npx commands as well as npm installation and launcher pins against the registry.

Review package contents for private paths, credentials, generated caches, and unrelated research. Keep version metadata consistent. Commit the source, wait for CI, tag the verified commit, and attach the package and SHA256 checksum to the GitHub release.

Publish the same verified tarball to npm, then install that exact registry version in a temporary project and check the CLI and MCP server. Confirm that the registry integrity matches the published tarball. Keep npm credentials outside the repository.

After building and packing, set `TYPELATCH_PACKAGE` to the absolute tarball path when running `node scripts/packagecheck.mjs`. The check requires byte equality with a fresh pack of the checked source, then installs and exercises that artifact. After publication, set `TYPELATCH_PACKAGE=typelatch@<exact-version>` to exercise a fresh registry installation through the same CLI and MCP checks.

The supported runtime begins at Node.js 22.12. CI exercises Linux and macOS on Node.js 22 and 24. Platform support is limited to successful CI runs. Windows is not claimed in this MVP.
