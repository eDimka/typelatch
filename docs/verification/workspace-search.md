# Workspace search verification

Version 0.2.0 introduces `workspace_search` and `typelatch search`. The checks below verify the implementation and package installation. Existing version 0.1.1 recordings remain evidence for the earlier six tools.

## Recorded checks

| Check | Result |
| :--- | :--- |
| `npm ci --no-audit --no-fund` | Clean dependency installation passed on Node.js 22.23.1. |
| `npm run release:check` | 101 tests passed and one existing test was skipped. Clean packed installation passed CLI source search, MCP source and exact dependency search, missing index reporting, the seven tool listing, library retrieval, validation and its negative control. |
| `npm run benchmark:workspace` | All eight expected source files ranked first. Warm worker requests took 325 through 353 ms in this run. Unchanged warm requests rebuilt no files and preserved result content. |
| `npm run benchmark` | All 73 questions had a discovery hit. All expected symbols appeared for 70 questions, preserving the three documented limitations. The executable release gate passed. |
| `npm run prove:support` | All 24 scenarios across 12 package versions passed, with all 48 negative controls rejecting their intended failures. The refreshed summary and compressed raw evidence are retained. |

An earlier full test attempt exceeded an existing 5 second timeout in the unsaved overlay validation test. The final full release check passed without changing that test or its timeout.

The [workspace search report](../benchmarks/workspace-search.json) contains exact questions, expected locations, ranked results, coverage, timing, output sizes and raw output from the fixed `rg` reference. The corpus omits the evaluator and new search test fixture. These are authored repository regressions, not evidence of general agent success or superiority over an agent using file search.

## Behavior exercised

The 17 workspace search tests cover internal declarations, UTF16 positions, source, tests, docs, configuration and filename lookup; content changes with preserved size and timestamps; creation, deletion, renaming and changed Git ignores; root isolation; source symlink exclusion; exact nested and transitive package versions; alias identity and a scoped virtual store; linked local package source; missing indexes; invalid package metadata and artifact integrity; cross package ranking and exact symbol casing; oversized files; filesystem fallback; and worker deadlines and cancellation.

Source search caches excerpts locally and checks content on each request. CLI and MCP run it through a bounded worker process. Dependency search uses existing indexes and exact installed or npm locked identities. It does not install missing indexes or load project code. Workspace searches leave compiler resolution, type checking and tests as not run, and atomic snapshot stability and installed artifact equivalence as unknown.

## Remaining limits

Coverage is explicitly scoped and bounded. Generated directories, source symlinks, binaries and other documented exclusions are outside the search scope. Large files or chunk limits produce incomplete coverage. Results are a lexical shortlist; an empty result does not prove absence. Only npm lockfiles of version 2 or 3 supply uninstalled dependency identities, while other layouts can use readable installed manifests. Missing package indexes remain visible and do not silently fall back to another version. Workspace queries do not yet participate in library feedback or usage aggregates.
