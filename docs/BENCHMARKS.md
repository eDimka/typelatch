# Benchmarks

## Method

The retrieval suite contains 73 authored questions across ten pinned npm packages. Each case preserves its expected API symbols. The strict case score passes when every expected symbol appears in the first five results. Recall measures the fraction of expected symbols returned. Mean reciprocal rank averages reciprocal positions across all expected symbols, including zero for missing symbols. A separate discovery hit records whether at least one expected symbol appeared.

The workspace suite exercises API discovery, live definitions, compilation, and runtime assertions. Each package also includes controls for an incorrect version, a missing API, invalid types, and a failing assertion.

```sh
npm run benchmark
npm run prove:support
```

The first command builds fresh package indexes and writes [retrieval evidence](https://github.com/eDimka/typelatch/blob/main/docs/benchmarks/retrieval.json). The second installs pinned fixtures, validates the workspace scenarios, and writes a [support summary](https://github.com/eDimka/typelatch/blob/main/docs/benchmarks/support.json). The retrieval command requires a discovery hit for every question and permits only the three recorded missing symbol exceptions in `src/benchmark/limitations.json`. The workspace command requires every scenario and negative control. Both return a failure status when a required gate fails.

Full workspace requests and results are preserved in `artifacts/support.json.gz` and attached to the GitHub release. The summary records the archive SHA256 checksum.

## Evidence boundary

### Workspace discovery

```sh
npm run benchmark:workspace
```

The [workspace search report](benchmarks/workspace-search.json) records eight fixed questions against a copy of this repository's source, existing tests, README, usage and architecture docs. The evaluator and new workspace search test fixture are omitted to avoid indexing the expected answers. The gate requires the expected source file in the first eight results for every question and identical cold and warm result content. It also checks that an unchanged warm query rebuilds no files.

Requests use the same bounded worker wrapper as the CLI and MCP. `firstQueryMs` and `warmQueryMs` include worker startup; `firstSearchMs` and `warmSearchMs` measure work inside that worker. Only the first request builds the complete cache. Subsequent requests reuse it.

For context, the report retains the raw output, byte size and timing of a fixed `rg` query using the question words as OR alternatives. That is a lexical reference with different output semantics, not an agent comparison or a claim of better correctness, lower token usage, or faster execution. The questions are authored repository regressions, not unseen tasks. The separate workspace search tests exercise freshness, removal, ignores, nested dependency versions, missing indexes, invalid artifact metadata, cancellation and incomplete coverage.

These cases were authored during development and are known to the implementation. They measure regression behavior on this corpus. They do not measure general coding success or unseen task performance. Latency depends on the recorded machine and cache state.

The manifest in `src/benchmark/corpus.json` records the original package selection and exact integrity pins. It is a fixed corpus, not a live popularity ranking. Expected alternatives remain visible in `src/benchmark/cases`. Controls must fail for their intended reason. Missing evidence never counts as a successful case.

## Release results

The initial retrieval run found an expected API for 73 of 73 questions. It returned every expected symbol for 70 of 73 questions. The strict floors are 10 of 12 for minimatch, 11 of 12 for chalk, and all cases for each remaining package.

Two minimatch cases return one module variant of the expected function and miss the other variant in the first five results. One chalk case returns the constructor and misses the expected options type. These limitations remain in the raw evidence. The gate binds each exception to its package, version, exact question, expected symbols, and allowed missing symbols. Every other case requires full coverage, and every question requires a discovery hit. A new failure cannot be offset by an improvement elsewhere.

The CLI `typelatch benchmark` reports strict coverage and exits with status 2 when any strict case fails. `npm run benchmark` runs the documented release regression gate and retains the same strict scores in its report.

The report timestamps and raw case results are the source of truth. The workspace suite passed all 24 scenarios across 12 package versions, including Effect 3.22.1 and 4.0.0 rc.112. All 48 negative controls rejected their intended invalid input or failing assertion.
