# Competitive evidence

Measured on 6 October 2026. Typelatch has verified improvements in storage, repeated search latency and exact API lookup. The evidence does not establish that it surpasses CodeGraph and Graphify in every aspect.

The competitors are [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph), executed as `@colbymchenry/codegraph@1.6.2`, and [Graphify](https://github.com/Graphify-Labs/graphify), executed as `graphifyy==0.9.77`. This excludes the unrelated local LibBrain project. [Research and pinned identities](research/competitive-baseline.md).

## Implemented improvements

| Change | Before | After | Recorded check |
| :--- | ---: | ---: | :--- |
| Workspace cache, fixed 57 file repository | 4,952,064 bytes | 1,228,800 bytes | 75.19 percent smaller; ordered retrieval parity |
| Workspace cache, generated 80 file corpus | 6,864,896 bytes | 1,441,792 bytes | 79.00 percent smaller; ordered retrieval parity |
| Ten pinned package indexes | 1,404,928 bytes | 1,236,992 bytes | 11.95 percent smaller; all API evidence preserved |
| Repeated search median, three MCP sessions | 326.27 ms | 19.64 ms | 93.98 percent lower; normalized complete responses match |
| Exact `Effect.retry` response | 20,599 bytes | 4,005 bytes | Requested API preserved; unrelated matches removed |
| Exact Kysely transaction builder response | 4,922 bytes | 2,946 bytes | Requested module preserved; second module excluded |

Workspace schema 6 removes duplicate text and paths from the database. It reconstructs excerpts from the same current file text used for freshness checks. Existing caches rebuild automatically. The one file, 74 byte fixture grows from 32,768 to 36,864 bytes because of fixed SQLite page overhead. This change does not save space for every possible corpus. [Storage proof](benchmarks/storage.json).

New package indexes use the trimmed representation. All 261 symbols, 512 relationships, exact symbol results and 73 ranked queries match the prior compact format. Raw implementation text and unused edge evidence are deliberately omitted; public API evidence remains. Existing formats remain readable. Rebuild an existing package with `typelatch add name@version` to obtain the smaller representation. [Package proof](benchmarks/package-storage.json).

Repeated search requests reuse a bounded worker while still reading and hashing current files. Cold median latency changed from 467.49 to 456.27 ms, so the large improvement applies to repeated requests. Workers retain runtime memory for up to 30 idle seconds; peak memory was not measured. Cancellation, process group cleanup, shared queue limits and output bounds remain covered. [Session proof](benchmarks/search-session.json).

Exact symbol lookup now preserves case and module identity. Missing or differently cased qualified names return `not-found`; bare names report ambiguity and omitted candidate counts. The two successful qualified examples reduce serialized MCP response bytes by 80.56 and 40.15 percent. Explicit ambiguity metadata makes the two bare name examples 1.08 and 4.51 percent larger. These are byte counts, not token savings. [Identity proof](benchmarks/usability.json).

Compact workspace previews are optional through `detail: "compact"` or CLI `--compact`. Full mode remains the default. Previews retain coverage and source positions, disclose omitted characters, and provide exact dependency inspection arguments. They trade source completeness for shorter responses.

## Comparison against competitors

The [small fixture report](benchmarks/competitive-final-small.json) and [repository report](benchmarks/competitive-final-repository.json) preserve each actual MCP request and response, identical input manifests, tool schemas, index inventories and negative controls. Both use Typelatch compact previews. The repository questions are known Typelatch regressions and favor familiarity with this repository. A mentioned expected path is a retrieval check, not proof that an agent can complete an edit.

All three tools found the expected paths for seven of seven small code questions. In the larger repository, the recorded counts were Typelatch eight of eight, CodeGraph seven of eight and Graphify six of eight. These counts do not support a general ranking. Configuration and documentation cases are recorded separately from code.

| Frozen corpus measurement | Typelatch compact | CodeGraph | Graphify |
| :--- | ---: | ---: | ---: |
| Small fixture index bytes | 45,056 | 225,658 | 23,590 |
| Small code questions, text bytes | 28,004 | 13,935 | 13,518 |
| Small code questions, MCP response bytes | 58,440 | 14,662 | 14,071 |
| Repository index bytes | 868,352 | 2,220,410 | 320,342 |
| Repository questions, text bytes | 56,659 | 119,361 | 92,581 |
| Repository questions, MCP response bytes | 117,905 | 125,637 | 94,202 |

Graphify has the smallest graph indexes in both comparisons. Typelatch has smaller indexes than CodeGraph in these runs. Index sizes cover different capabilities: Graphify ran with code extraction and clustering disabled, and its responses contained graph locations rather than source excerpts. Typelatch searches documentation and reconstructs source snippets. None of these is an equal utility storage score.

Typelatch still returns larger responses on the small fixture. On the repository questions its text output is smaller than both competitors, but duplicated structured content makes its serialized MCP responses larger than Graphify's. Different clients can consume these representations differently. The reports retain both measurements; actual model tokens and retained model context remain unmeasured.

The [installation report](benchmarks/install-space.json) measures a fresh production install and separates interpreters. CodeGraph bundles Node in its installation; Typelatch requires an existing Node, and Graphify requires Python. File totals exclude download caches, indexes and model weights. Allocated filesystem blocks do not establish physically reclaimable APFS space. There is no peak RAM superiority claim.

| Installed regular files | Tool and dependencies | Interpreter reported separately |
| :--- | ---: | :--- |
| Typelatch frozen candidate | 74,426,457 bytes | Existing Node executable: 112,928,848 bytes |
| CodeGraph | 294,335,553 bytes | Includes its 120,573,328 byte bundled Node |
| Graphify | 149,291,121 bytes | Python distribution: 52,883,657 bytes |

These interpreter totals have different boundaries and do not include every operating system dependency. They are not an equal capability provisioning score.

## Measured process memory

The [process memory study](research/process-space.md) adds 18 actual sessions with three rotated rounds per provider on two fixed corpora. Every query passed its expected source path control. Runtime identities, 2,688 sampled process tables, responses and cleanup were independently checked.

| Repository serving observation | Typelatch | CodeGraph | Graphify |
| :--- | ---: | ---: | ---: |
| Median sampled maximum tree RSS | 209.64 MiB | 327.80 MiB | 83.84 MiB |
| Median tree RSS at 31 to 32 idle seconds | 65.50 MiB | 327.80 MiB | 83.84 MiB |

Typelatch used less serving RSS than CodeGraph but retained more than Graphify until worker cleanup. Setup runs have a different ordering: Graphify's repository extraction used 12 observed processes and a larger RSS sum. Shared mappings can be counted repeatedly, and sampling can miss short spikes. These values are observed process RSS, not true peaks, unique physical memory, or a universal memory ranking. The host had uncontrolled background activity. [Raw report and protocol](benchmarks/process-space.json).

## Completed coding pilot

Three fresh agents each received the same two authored TypeScript bug tasks, their own identical repository copy, one assigned provider, a 16 action budget and at most three grader runs. The fixture and 14 assertions were frozen before discovery. Actions, MCP responses, edits and compiler output were recorded. [Pilot report](benchmarks/agent-pilot.json) and [integrity review](research/agent-pilot-review.md).

| Provider and configuration | Final assertions | Actions | Additional source reads | Test runs |
| :--- | ---: | ---: | ---: | ---: |
| Typelatch compact previews | 14 / 14 | 7 | 2 | 2 |
| CodeGraph primary explore tool | 14 / 14 | 5 | 0 | 2 |
| Graphify code graph query | 14 / 14 | 7 | 2 | 2 |

All three compiled and fixed both bugs. CodeGraph supplied enough source in its initial response for that agent to proceed without separate file reads. Typelatch compact mode and Graphify needed two reads. This is a measured convenience gap for this configuration, not proof that Typelatch's default full mode loses. All agents saw detailed failing assertion diagnostics before editing. One agent session per provider on two authored tasks cannot establish general coding superiority.

The initial tool logs did not contain model accounting. A later [metadata supplement](benchmarks/agent-pilot-accounting.json) recovered and reconciled the completed coding turns from local client records. All three recorded `gpt-6-astra` with `ultra` reasoning. The export contains allowlisted metadata and hashes, without reasoning text or internal prompts.

| Initial pilot agent | Input tokens | Cached input component | Output tokens | Total input and output |
| :--- | ---: | ---: | ---: | ---: |
| Typelatch compact | 382,355 | 367,488 | 2,038 | 384,393 |
| CodeGraph | 285,379 | 273,920 | 1,736 | 287,115 |
| Graphify | 365,597 | 352,768 | 2,081 | 367,678 |

Input totals count every model request, including repeated context; they are not unique prompt sizes. Cached tokens are part of input and must not be added again. Later reviewer turns and orchestration are excluded. Local records do not establish billing cost, a pinned server model snapshot, equal private prompts, or a general causal token advantage. [Accounting method and privacy checks](research/agent-accounting.md).

The reviewer who prepared the pilot report authored the CodeGraph candidate, so the review is not blind. A different reviewer inspected that implementation against the tasks and grader. The pilot captures an earlier product source snapshot; later lockfile work in the shared checkout is not validated by those agent outcomes. [Product review](research/product-review.md).

## Next acceptance gates

1. Compare default full mode and compact mode on new independently authored tasks. Freeze requirements, graders and budgets before running any provider. Require successful compiled changes before counting fewer actions or bytes as an improvement.
2. Reduce repeated response metadata while preserving coverage, identity, missing evidence and truncation. Measure complete sessions, including followup source reads and repairs. Keep a change only if independently reviewed successful outcomes or total session efficiency improve without a correctness regression.
3. Measure peak process memory, cold startup and incremental refresh at several repository sizes. Include installed runtimes separately. Require equivalent content and requested capabilities before claiming a space win.
4. Evaluate dependency version errors, large monorepos, graph navigation and impact analysis. Other languages, Graphify media extraction and the hosted Graphify service remain outside the executed comparison.

Until those gates pass, the defensible claim is narrower: Typelatch uses substantially less cache space than its previous version, repeats searches faster, and returns safer exact API identities. Every aspect superiority remains an open objective.

## Reproduce and inspect

```sh
npm ci
npm run release:check
npm run benchmark
npm run prove:support
npm run benchmark:workspace
npm run benchmark:storage
npm run benchmark:package-storage
npm run prove:usability
npm run prove:search-session
npm run showcase:agent
```

See [external provider setup](research/competitive-baseline.md#reproduction) before running `benchmark:competitive` and `benchmark:competitive:repository`. Each report contains exact versions, hashes and limitations. The scripts reconstruct previous Typelatch modules from Git commit `0053a7fbb1c8f8e7b3572145f2e64e18e8dc7125`. Benchmark raw archives remain under `artifacts/competitive`, with checksums in reports. The coding pilot needs fresh agent sessions; replaying its grader is not a new agent trial.

The [verification manifest](benchmarks/competitive-verification.json) binds release checks and evidence to their captured snapshot. Shared checkout edits during the work were preserved. The final comparator runs use a frozen candidate to avoid changing source or build files underneath a live server.

The initial Graphify setup automatically refreshed an existing Claude skill. Its main file was restored from the exact backup, and eight reference files were restored from the intact original distribution with hash checks. Possible prior custom reference edits remain unknown. Subsequent runs isolate the home directory and disable refresh. A local recovery audit records the incident and restoration.
