# Changelog

## 0.3.0

Added `typelatch setup` and `npm run setup:mcp` for interactive Codex and Claude Code registration. The npm workflow pins the running version and works without a global installation or repository clone.

Added exact dependency discovery from npm package lock and shrinkwrap, pnpm, Yarn Classic and modern Yarn, and Bun text lockfiles. `sync` supports ancestor lockfiles, aliases, mixed package managers, repeated `--project` selection, and `--workspaces`. `--dry-run --json` exposes the complete plan before downloads. Conflicting artifact integrity and unresolved identities stop preparation.

Added saved monorepo subsets through `scope add`, `scope remove`, `scope set`, `scope list`, and `scope clear`. Source search and plain `sync` follow the selection. Later additions reuse unchanged source entries and exact package indexes. Coverage explicitly describes the selected subset.

This release also includes workspace search and the agent workflow introduced in the unreleased 0.2.0 source version.

Reduced workspace cache duplication and made the smaller package index format the default. Existing package indexes remain readable and workspace caches rebuild automatically. Exact library symbol lookup now preserves case and module identity, reports bare name ambiguity, and never substitutes an unrelated declaration for a missing qualified symbol.

Added optional compact workspace search previews through MCP `detail: "compact"` and CLI `--compact`. Coverage, ranking, source positions and evidence checks remain available, with explicit excerpt omission counts and exact dependency inspection arguments.

Repeated workspace searches reuse a bounded worker process while still checking current file contents. The shared queue, output limits, cancellation and idle cleanup apply to search and compiler context.

Added reproducible storage measurements and a pinned CodeGraph and Graphify comparison. Recorded response sizes measure bytes, not model token savings or coding success.

Updated five transitive dependencies to compatible patched versions after the dependency audit. The recorded audit found no remaining advisories in this lockfile; this is dependency inventory evidence, not a security assessment of every execution path.

## 0.2.0

Source milestone. This version was not published to npm.

Added `workspace_search` and `typelatch search` for local source, internal declarations, tests, documentation, configuration and exact dependency indexes. Workspace caches refresh by content hash. Results preserve source locations, coverage gaps, retrieval limits, and separate compiler and execution evidence. Existing library tools remain available.

## 0.1.1

The product is named Typelatch. Install it from npm with `npm install --global typelatch`. The commands are `typelatch` and `typelatch-mcp`. Local data uses `~/.typelatch`, with `TYPELATCH_HOME` and `TYPELATCH_USAGE` for configuration.

The package discovery, workspace validation, and benchmark behavior is unchanged.

## 0.1.0

Initial public MVP.

Exact npm artifact indexing, local API retrieval, six MCP tools, live TypeScript workspace resolution, compiler and runtime evidence, and executable benchmark suites.
