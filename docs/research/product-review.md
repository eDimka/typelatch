# Product correctness review

Reviewed on 6 October 2026 against the working tree based on `0053a7fbb1c8f8e7b3572145f2e64e18e8dc7125`. This reviewer did not author the product changes. No additional confirmed correctness defect was found in the inspected changes. This is a scoped source review, not a release approval or proof of absence of defects.

## Inspected scope

The review covered the changed functions in `src/workspace/persistent.ts`, `runtime.ts`, `search-worker.ts`, `search-index.ts`, `search.ts`, `schema.ts`, and `src/query.ts`, `types.ts`, `indexer.ts`, `mcp.ts`, and `cli.ts`. Supporting reads included the inventory, package database and path handling, and `scripts/packagecheck.mjs`.

The standards and intended behavior came from `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/BENCHMARKS.md`, the interface descriptions, and the new tests. No separate issue specification was supplied.

The inspected tests were `workspace-search-session`, `workspace-compact`, `workspace-storage`, `symbol-identity`, and `indexer-default`, with selected existing workspace and query assertions for context. The reviewer checked the source changes with `git diff --check`; it passed. The release suite was running separately, so this review did not duplicate its execution or claim its result.

## Correctness and evidence boundaries

1. The shared admission counter still limits active worker requests and queued requests. Search now uses the existing persistent protocol, with distinct input limits and error labels. Environment and working directory participate in the reuse key. Cancellation, deadline expiry and excess output terminate the retained process group. Idle workers are unreferenced and retired. Tests exercise actual process reuse, queued cancellation, child termination, output bounds, recovery and CLI exit.
2. Cache refresh and candidate selection stay in one SQLite transaction. The content hash still includes the parser version. Stored offsets and lengths use the same UTF16 indexing as reconstruction from the current inventory text. Unchanged files remain present in that inventory. Updates and deletions remove search rows before their content identities can be reused. Tests cover migration from schemas 4 and 5, Unicode, CRLF, restored timestamps, stale terms and reused IDs.
3. The new cache omits raw excerpts but retains searchable terms, paths and declaration metadata. `SECURITY.md` accurately treats that material as workspace data and states that usage recording settings do not disable the search cache. This review did not establish secure erasure of deleted terms, atomic filesystem snapshots, or protection from another local process modifying cache files.
4. Compact mode preserves result order, exact dependency identity, source locations, coverage and evidence checks. It bounds previews by Unicode code point and reports omitted characters. Dependency inspection arguments carry the exact returned package version and symbol. Shortened previews retain the original excerpt locations and do not establish complete function bodies.
5. Exact symbol lookup binds the requested value and uses binary case comparison. Qualified identities do not fall back to same named declarations in another module. Bare names expose ambiguity and omitted counts before the result limit. The tests cover all three package formats. The new default package format already has matching query paths and retains the identity and relationship fields used by these interfaces.

## Limits and concurrent work

No broader network, installation or cross platform behavior was tested in this review. The new CLI preview tests use built output, so their results depend on the build performed by the release suite. The lifecycle tests cover the shared queue but do not exhaust every sequence of successful mixed context, search and check requests. The package default test uses a small fixture; larger format equivalence belongs to the separate regression evidence.

`scripts/setup-mcp.sh`, `test/lockfiles.test.ts`, `src/lockfiles.ts`, and `test/setup-mcp.test.ts` were untracked during review. Git history did not establish their provenance. The coordinating agent identified them, related project and inventory edits, and added parser dependencies as concurrent external work after the product candidate freeze. They were left untouched and are excluded from this correctness conclusion. The changed working tree therefore must not be described as a single frozen release candidate without another validation pass.

## Independent CodeGraph pilot inspection

After the controlled pilot ended, the reviewer separately read the CodeGraph candidate in `artifacts/competitive/agent-eval/2026-10-06T14-34-05.468Z/codegraph/repo`, its frozen task text and the 14 grader cases. This source inspection found that cache expiration, live size, replacement and LRU order satisfy the task. Retry starts attempts at one, checks the deadline before starting, skips waiting after the final failure, clips waits, checks again afterward, and preserves the latest failure value, including falsy values. Successful operations that start before the deadline remain accepted.

No hard coded fixture behavior or additional defect was found. The reviewer did not modify that candidate or rerun the grader while another reviewer was replaying it. The grader covers the listed requirements but is a finite authored suite, not a general proof or a comparative superiority result.
