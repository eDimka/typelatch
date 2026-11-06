# Benchmarks

## Large monorepo availability

Two real, localized repairs in the pinned pnpm repository, with 198 workspace packages. Each condition ran both tasks twice. All 16 solutions passed independent checks, and every session made zero MCP calls. Neither candidate met the frozen savings gate. Differences in these runs do not demonstrate a benefit from retrieval.

| Four sessions per condition | Total tokens | Charged time | Grep shell calls | MCP calls | Correct |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Native tools | 361,174 | 106.7 s | 10 | 0 | 4/4 |
| Serena 2.1.0 available | 378,639 | 103.3 s | 11 | 0 | 4/4 |
| Typelatch 0.4.0 candidate available | 407,578 | 100.2 s | 12 | 0 | 4/4 |
| Compact source experiment available | 393,729 | 104.3 s | 12 | 0 | 4/4 |

Tokens include cached input and output once. Charged time includes provider setup and the complete agent session. Shared fixture copying and independent grading remain separate. The gate requires at least 20% aggregate and median paired savings in both metrics against native tools and Serena, improvement in each repeat, and preserved correctness. Each task needs one implementation file, and the failing checks provide useful debugging clues. This is not a scaling study.

[All runs](benchmarks/monorepo-agent-study/report.json) · [Frozen protocol](benchmarks/monorepo-agent-study/protocol.json) · [Independent review](benchmarks/monorepo-agent-study/independent-review.json) · [Retained launch failures](benchmarks/monorepo-agent-study/infrastructure-attempt-001/report.json) · [Reproduction and six tool comparisons](research/monorepo-evidence/README.md)

## Paired agent comparison

[Results](https://edimka.github.io/typelatch/#benchmark) · [Current candidate evidence](benchmarks/typelatch-040-candidate/paired-agent.json) · [Candidate protocol](benchmarks/typelatch-040-candidate/paired-agent-protocol.json) · [Original 0.3.0 evidence](benchmarks/typelatch-use/paired-agent.json)

The latest recorded candidate uses compact MCP validation responses. It did not meet the performance gate: total model tokens increased 63.0%, and agent time plus index preparation increased 44.8%. Correctness was five of six sessions with Typelatch and four of six without it. This is the packed `typelatch@0.4.0` checkout candidate identified by the report's archive digest, not evidence about an npm release.

| Latest candidate totals | Without Typelatch | With Typelatch |
| :--- | ---: | ---: |
| Grep shell calls | 22 | 13 |
| Input plus output tokens | 954,947 | 1,556,137 |
| Agent time | 320.0 s | 430.9 s |
| Index preparation | 0.0 s | 32.4 s |
| Agent time plus indexing | 320.0 s | 463.3 s |
| Correct solutions | 4 / 6 | 5 / 6 |

The frozen gate required at least 10% improvement in both total tokens and charged time, in aggregate and median paired reductions, improvement in both repeats, and no correctness decline overall or per task. All twelve sessions remain included. Common fixture preparation, final independent grading and installation of the shared benchmark runtime are outside this gate and remain separately disclosed. Candidate results and the original 0.3.0 study are not pooled.

Three authored TypeScript tasks, two repetitions per condition, twelve fresh Codex sessions. Tasks cover SQLite rollback, cart preview correctness, and an Effect manifest validator. The latter two share a 57 source file project.

Both studies use Codex CLI 0.166.0, requested model `gpt-6.1-sol`, medium reasoning, identical task and workflow prompts within each pair, starting source, dependencies, native tools and permissions. The shared prompt requires source discovery, installed API inspection and tests before and after editing. It directs the agent to Typelatch when available and native equivalents otherwise. The original study provides published `typelatch@0.3.0` MCP tools; the current study uses the captured 0.4.0 candidate. Runs are sequential, with condition order reversed for the second repetition. All attempts remain in the results. Only workspace paths in two generated native build files are normalized when comparing initial inventories; original hashes are retained.

| Metric | Definition |
| :--- | :--- |
| Grep calls | Completed shell call groups invoking `rg`, `grep`, `egrep` or `fgrep`. Compound calls count once. Content search and file listing are separate. |
| Tokens | Terminal CLI input plus output. Cached input and reasoning output are included subsets, never added twice. Missing usage stays unknown. |
| Agent time | Process launch to exit, including MCP startup and tool execution. |
| Preparation | Fixture installation and baseline checks, plus separate Typelatch dependency indexing. Excluded from agent time. Source search starts with an empty cache. |
| Correctness | Independent compilation, public tests, held out assertions, API contracts and protected file checks after the agent exits. |

All shell and MCP calls are reported. Search counts do not cover searches hidden in scripts, aliases or other tools. Token accounting follows the [CLI JSON events](https://learn.chatgpt.com/docs/non-interactive-mode), not a billing estimate. Provider caching remains enabled. The model alias is pinned; a provider snapshot and sampling seed are unavailable.

Each broken fixture must compile and fail its intended regression; reference fixes must pass. Grading copies the final implementation into a fresh directory with trusted tests, configuration and dependencies. It ignores the agent's generated build output. File integrity checks include installed dependencies and reject changes outside existing implementation files. Public evidence includes commands, final source changes, test results and hashes; model reasoning and authentication data are excluded.

A separate [automatic choice study](benchmarks/paired-agent.json) retained twelve runs with neutral tool instructions. None of its six sessions with Typelatch enabled called MCP. Its results remain separate from the explicit tool use comparison.

### Reproduce

Use an authenticated Codex CLI and the recorded lockfiles. Use npm 10.9.8 for the captured Typelatch 0.3.0 runtime; npm 12 response compatibility starts in Typelatch 0.4.0. Install `typelatch@0.3.0` in `artifacts/paired-agent/runtime`. Run `node --test scripts/paired-agent*.test.mjs`. For a new study, run `node scripts/paired-agent-use.mjs --freeze --output-directory artifacts/paired-agent/new-study`, then the same command with `--run` instead of `--freeze`. The runner refuses to overwrite existing evidence. Fixtures and independent assertions are in `scripts/fixtures/paired-agent`.

The candidate capture uses `scripts/paired-agent-candidate.mjs`, the archive identity and frozen inputs in its protocol. Rebuilding a different checkout with the same version number does not reproduce that artifact. The candidate runner retains every preparation and launch attempt and refuses replacement runs. Its first SQLite pair was selected for the action replay before scoring, regardless of outcome.

These are known development exercises, not unseen production tasks. Two repetitions do not add task diversity. Machine load, network latency, provider caching and sampling affect measurements. Starting from an empty machine also incurs the separately reported preparation costs. Results describe this sample and do not establish a general performance guarantee.

## Method

The retrieval suite contains 73 authored questions across ten pinned npm packages. Each case preserves its expected API symbols. The strict case score passes when every expected symbol appears in the first five results. Recall measures the fraction of expected symbols returned. Mean reciprocal rank averages reciprocal positions across all expected symbols, including zero for missing symbols. A separate discovery hit records whether at least one expected symbol appeared.

The workspace suite exercises API discovery, live definitions, compilation, and runtime assertions. Each package also includes controls for an incorrect version, a missing API, invalid types, and a failing assertion.

```sh
npm run benchmark
npm run prove:support
```

The first command builds fresh package indexes and writes [retrieval evidence](https://github.com/eDimka/typelatch/blob/main/docs/benchmarks/retrieval.json). The second installs pinned fixtures, validates the workspace scenarios, and writes a [support summary](https://github.com/eDimka/typelatch/blob/main/docs/benchmarks/support.json). The retrieval command requires a discovery hit for every question and permits only the three recorded missing symbol exceptions in `src/benchmark/limitations.json`. The workspace command requires every scenario and negative control. Both return a failure status when a required gate fails.

Full workspace requests and results are preserved in `artifacts/support.json.gz` and uploaded in the CI workflow's `benchmark-evidence` artifact. The summary records the archive SHA256 checksum.

## Evidence boundary

### Workspace discovery

```sh
npm run benchmark:workspace
```

The [workspace search report](benchmarks/workspace-search.json) records eight fixed questions against a copy of this repository's source, existing tests, README, usage and architecture docs. The evaluator and new workspace search test fixture are omitted to avoid indexing the expected answers. The gate requires the expected source file in the first eight results for every question and identical cold and warm result content. It also checks that an unchanged warm query rebuilds no files.

Requests use the same bounded worker wrapper as the CLI and MCP. `firstQueryMs` and `warmQueryMs` include the complete request lifecycle; `firstSearchMs` and `warmSearchMs` measure work inside the worker. The first request starts a worker and builds the complete cache. Subsequent requests reuse the worker and cache while checking current content hashes.

For context, the report retains the raw output, byte size and timing of a fixed `rg` query using the question words as OR alternatives. That is a lexical reference with different output semantics, not an agent comparison or a claim of better correctness, lower token usage, or faster execution. The questions are authored repository regressions, not unseen tasks. The separate workspace search tests exercise freshness, removal, ignores, nested dependency versions, missing indexes, invalid artifact metadata, cancellation and incomplete coverage.

These cases were authored during development and are known to the implementation. They measure regression behavior on this corpus. They do not measure general coding success or unseen task performance. Latency depends on the recorded machine and cache state.

The manifest in `src/benchmark/corpus.json` records the original package selection and exact integrity pins. It is a fixed corpus, not a live popularity ranking. Expected alternatives remain visible in `src/benchmark/cases`. Controls must fail for their intended reason. Missing evidence never counts as a successful case.

The executable support fixtures use maintained dependency pins. Their minimatch version is 11.0.5, with its exact registry integrity enforced separately from the historical 10.2.6 retrieval input. Updating a runnable fixture does not relabel earlier retrieval results or change their expected symbols.

## Competitive evidence

The [competitive scorecard](COMPETITIVE.md) compares the pinned public CodeGraph and Graphify products, records the improvements to Typelatch, and lists dimensions where it still loses or lacks evidence. It includes actual MCP captures and a bounded coding pilot. Retrieval hits, index bytes and response bytes remain separate from successful code changes and actual model tokens.

```sh
npm run benchmark:storage
npm run benchmark:package-storage
npm run prove:usability
npm run prove:search-session
```

These commands reconstruct the previous Typelatch baseline where needed, execute the candidate, and preserve response evidence. The storage and worker proofs use commit `0053a7fbb1c8f8e7b3572145f2e64e18e8dc7125`. See the [competitor setup](research/competitive-baseline.md#reproduction) for the external artifacts and isolation settings.

## Release results

The initial retrieval run found an expected API for 73 of 73 questions. It returned every expected symbol for 70 of 73 questions. The strict floors are 10 of 12 for minimatch, 11 of 12 for chalk, and all cases for each remaining package.

Two minimatch cases return one module variant of the expected function and miss the other variant in the first five results. One chalk case returns the constructor and misses the expected options type. These limitations remain in the raw evidence. The gate binds each exception to its package, version, exact question, expected symbols, and allowed missing symbols. Every other case requires full coverage, and every question requires a discovery hit. A new failure cannot be offset by an improvement elsewhere.

The CLI `typelatch benchmark` reports strict coverage and exits with status 2 when any strict case fails. `npm run benchmark` runs the documented release regression gate and retains the same strict scores in its report.

The report timestamps and raw case results are the source of truth. The workspace suite passed all 24 scenarios across 12 package versions, including Effect 3.22.1 and 4.0.0 rc.112. All 48 negative controls rejected their intended invalid input or failing assertion.
