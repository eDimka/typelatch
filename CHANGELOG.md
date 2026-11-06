# Changelog

## 0.4.0

Expanded JavaScript and TypeScript lockfile discovery, including Deno npm dependencies and legacy binary Bun lockfiles. Binary Bun decoding uses an installed Bun executable without installing dependencies or running lifecycle scripts.

Fixed npm 12 metadata and archive responses, npm v1 aliases, npm v4 registry entries, pnpm package names containing underscores, Yarn catalogs and current Bun text schemas. Exact package identities, local dependency exclusions and unsupported artifact diagnostics remain explicit.

Published paired Codex measurements and a GIF replay of actual actions with and without Typelatch. Across six sessions per condition, the recorded Typelatch 0.3.0 workflow used 10 grep shell calls versus 22 and passed 5 solutions versus 4. It used more tokens and time. Every run, the protocol and independent correctness checks are retained.

## 0.3.0

Added strict semantic release checks and GitHub Actions publication from annotated version tags. The workflow tests one preserved artifact, publishes with npm trusted publishing and provenance, creates an immutable GitHub release, and deploys the website after registry verification.

Added `typelatch setup` and `npm run setup:mcp` for interactive Codex and Claude Code registration. The npm workflow pins the running version and works without a global installation or repository clone.

Added exact dependency discovery from npm package lock and shrinkwrap, pnpm, Yarn Classic and modern Yarn, and Bun text lockfiles. `sync` supports ancestor lockfiles, aliases, mixed package managers, repeated `--project` selection, and `--workspaces`. `--dry-run --json` exposes the complete plan before downloads. Conflicting artifact integrity and unresolved identities stop preparation.

Fixed first use with real dependency sets. Package extraction now accepts one safe named archive root, including older DefinitelyTyped packages. Sync reports dependencies without TypeScript declarations as unsupported and continues supported packages, while keeping incomplete coverage visible and operational errors fatal.

Added saved monorepo subsets through `scope add`, `scope remove`, `scope set`, `scope list`, and `scope clear`. Source search and plain `sync` follow the selection. Later additions reuse unchanged source entries and exact package indexes. Coverage explicitly describes the selected subset.

This release also includes workspace search and the agent workflow introduced in the unreleased 0.2.0 source version.

Reduced workspace cache duplication and made the smaller package index format the default. Existing package indexes remain readable and workspace caches rebuild automatically. Exact library symbol lookup now preserves case and module identity, reports bare name ambiguity, and never substitutes an unrelated declaration for a missing qualified symbol.

Added source mode with bounded file contents and direct relative import candidates, exact multiword API lookup, callable export signatures, lazy parser loading, recoverable package caches and stricter cache identity checks. Workspace queries preserve source hashes, scope boundaries and explicit omission counts. Older workspace compilers retain their existing resolution and signatures; unavailable normalized headers are reported explicitly instead of throwing.

Added optional compact workspace search previews through MCP `detail: "compact"` and CLI `--compact`. Coverage, ranking, source positions and evidence checks remain available, with explicit excerpt omission counts and exact dependency inspection arguments.

Repeated workspace searches reuse a bounded worker process while still checking current file contents. The shared queue, output limits, cancellation and idle cleanup apply to search and compiler context.

Added reproducible storage measurements and a pinned CodeGraph and Graphify comparison. Recorded response sizes measure bytes, not model token savings or coding success.

Refreshed the landing page and npm README with a compact onboarding animation and inspectable agent evidence.

Updated the MCP SDK, minimatch, Zod, Vitest and affected transitive dependencies after the dependency audit. The November 6 lockfile audit found no remaining advisories; this is dependency inventory evidence, not a security assessment of every execution path.

Updated runnable examples to Kysely 0.28.19 and minimatch 11.0.5. All three active dependency trees pass the audit. Original recordings retain their exact identities and hash checked text snapshots independently of maintained examples. Historical retrieval inputs remain unchanged.

## 0.2.0

Source milestone. This version was not published to npm.

Added `workspace_search` and `typelatch search` for local source, internal declarations, tests, documentation, configuration and exact dependency indexes. Workspace caches refresh by content hash. Results preserve source locations, coverage gaps, retrieval limits, and separate compiler and execution evidence. Existing library tools remain available.

## 0.1.1

The product is named Typelatch. Install it from npm with `npm install --global typelatch`. The commands are `typelatch` and `typelatch-mcp`. Local data uses `~/.typelatch`, with `TYPELATCH_HOME` and `TYPELATCH_USAGE` for configuration.

The package discovery, workspace validation, and benchmark behavior is unchanged.

## 0.1.0

Initial public MVP.

Exact npm artifact indexing, local API retrieval, six MCP tools, live TypeScript workspace resolution, compiler and runtime evidence, and executable benchmark suites.
