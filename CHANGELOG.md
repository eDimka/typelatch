# Changelog

## 0.2.0

Added `workspace_search` and `typelatch search` for local source, internal declarations, tests, documentation, configuration and exact dependency indexes. Workspace caches refresh by content hash. Results preserve source locations, coverage gaps, retrieval limits, and separate compiler and execution evidence. Existing library tools remain available.

## 0.1.1

The product is named Typelatch. Install it from npm with `npm install --global typelatch`. The commands are `typelatch` and `typelatch-mcp`. Local data uses `~/.typelatch`, with `TYPELATCH_HOME` and `TYPELATCH_USAGE` for configuration.

The package discovery, workspace validation, and benchmark behavior is unchanged.

## 0.1.0

Initial public MVP.

Exact npm artifact indexing, local API retrieval, six MCP tools, live TypeScript workspace resolution, compiler and runtime evidence, and executable benchmark suites.
