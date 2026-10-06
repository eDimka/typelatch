# Agent coding pilot review

All three sessions passed the same 14 frozen tests. Each session fixed two authored defects, a TTL and LRU cache defect and a retry bounds defect. This is one session per provider, with three sessions in total. It supports a success tie on these requirements. It does not establish a general coding advantage, model token savings, or product leadership.

The [machine readable audit](../benchmarks/agent-pilot.json) contains source references, SHA256 hashes, individual action records, byte accounting, and explicit integrity states. Its source run is [2026-10-06T14-34-05.468Z](../../artifacts/competitive/agent-eval/2026-10-06T14-34-05.468Z/). The reviewer previously authored the CodeGraph candidate, so this review is not blind or independent of every candidate.

## Recorded outcome

| Provider | Query | List | Read | Edit | Test | Total actions | Baseline pass / fail | Final pass / fail |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | :--- | :--- |
| Typelatch | 1 | 0 | 2 | 2 | 2 | 7 | 4 / 10 | 14 / 0 |
| CodeGraph | 1 | 0 | 0 | 2 | 2 | 5 | 4 / 10 | 14 / 0 |
| Graphify | 1 | 0 | 2 | 2 | 2 | 7 | 4 / 10 | 14 / 0 |

Every provider remained within 16 actions and three controlled tests. The first controlled test reproduced ten failures before edits. The next controlled test passed. There were no failed controlled tests after editing and no repair cycles after a failed candidate. The server also ran its own initial baseline and final grade outside those budgets. TypeScript compilation passed for every baseline and final grade.

CodeGraph returned complete cache and retry source in its first query, which removed the need for separate read actions. Typelatch returned compact source excerpts and Graphify returned graph nodes and relationships. Their agents each read the two source files. These action counts describe the selected adapters and this fixture.

## Response accounting

| Provider | Query text bytes | Read text bytes | Raw MCP response JSON bytes | All action output JSON bytes | Reconstructed client output bytes |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Typelatch | 8,370 | 2,681 | 17,379 | 25,242 | 25,776 |
| CodeGraph | 4,472 | 0 | 4,698 | 18,187 | 18,594 |
| Graphify | 3,719 | 2,681 | 3,828 | 20,062 | 20,596 |

Text columns count UTF8 bytes. JSON columns count the compact serialization of the named response surface. Reconstructed client output includes its pretty printed result, budget fields, and final newline. The [client](../../scripts/agent-eval-client.mjs) does not forward MCP `structuredContent`; the raw MCP column includes it when present. These columns overlap and must not be added together.

All agents submitted 3,136 source bytes across two edit actions. The logs contain no model input, output, reasoning token, or cost records. They also omit assistant messages, scratch file operations, and the shell tool envelope. No byte count in this report is a token estimate or total conversation size. The Graphify `token_budget: 2000` request parameter is an adapter setting, not measured model usage.

## Source and log integrity

The audit replayed every recorded read and edit from the ten frozen fixture files. Each read matched the source at that point. Every edit targeted an existing `src/*.ts` file. Only `src/cache.ts` and `src/retry.ts` changed in each candidate. Every final fixture file matched the replay, and each final grade's stored before and after text matched the edit records. Extra files were confined to the expected Git or provider index directories.

Each query record matched the text in its raw MCP response. CodeGraph's line numbered source blocks reconstructed the frozen source exactly. The recorded action and test counters were contiguous, matched final counters, and stayed within the limits. Each raw log ends with exactly one successful final grade.

| Raw log | SHA256 |
| :--- | :--- |
| [Typelatch](../../artifacts/competitive/agent-eval/2026-10-06T14-34-05.468Z/typelatch.jsonl) | `5739a91dfd9eb212766863592ac94d065028c85388e381f6b925054fb0f751d4` |
| [CodeGraph](../../artifacts/competitive/agent-eval/2026-10-06T14-34-05.468Z/codegraph.jsonl) | `491974b4157822532e35ebe032dcb698bb12583bf743af9a6eab44494ed402a8` |
| [Graphify](../../artifacts/competitive/agent-eval/2026-10-06T14-34-05.468Z/graphify.jsonl) | `121dd53a5de2971b1fa1c7fe5dedcf2df78ec7126e27d002a4617f21a75235ee` |

The frozen manifest, corpus digest, freeze body digest, task prompt, grader script, grader tests, and task specification all matched their recorded hashes. The freeze timestamp precedes every logged provider query. The report also stores a hash for every exact JSONL record and the final source files. These are current consistency checks; the raw logs have no external signature or trusted timestamp anchor that proves their history.

The run captured 42 product source hashes and four harness hashes in [implementation.json](../../artifacts/competitive/agent-eval/2026-10-06T14-34-05.468Z/implementation.json). All four harness hashes matched at review. Current `src/cli.ts`, `src/mcp.ts`, `src/project.ts`, and `src/workspace/inventory.ts` differed from the captured product hashes. The pilot therefore applies to its captured run and cannot validate subsequent product edits.

The manifest does not bind the executed `dist/mcp.js`, Node binary, installed TypeScript compiler, dependency tree, or competitor executable contents. Hashing source alone does not prove which compiled artifact ran. The server's shared host filesystem was not an isolation sandbox. Controlled API logs cannot independently exclude unlogged file access or establish the complete model prompts and configuration.

## Candidate review beyond the frozen grader

No requirement defect was found. All candidates preserve exported interfaces and input validation. They remove expired entries before capacity eviction, move live reads and replacements to most recent position, and count only live entries. Retry checks the deadline before each operation, includes the initial call in the attempt limit, clips delay, rechecks after waiting, preserves arbitrary failure identity, and accepts success from an operation that began on time.

All three retry files are byte identical. Typelatch and CodeGraph cache files are byte identical. Graphify places the private expiry helper after the public methods. Source similarity does not by itself prove contamination or independence.

The frozen replacement test reads the updated key before checking the next eviction, which could conceal a failure to refresh recency during `set`. The supplemental review checked replacement recency without that intervening read. It also ran 36 seeded cache sequences with 3,600 actions per provider, arbitrary failure values, deadline exhaustion after several failures, sleep overshoot, early sleep completion, zero delay, and a past initial deadline. All six supplemental checks passed for each provider. The [supplemental script](../../artifacts/competitive/agent-eval/2026-10-06T14-34-05.468Z/audit/supplemental-checks.mjs) and [results](../../artifacts/competitive/agent-eval/2026-10-06T14-34-05.468Z/audit/supplemental-results.json) are retained separately. They are later review evidence and do not increase the original pilot score or action budget.

Cache cleanup scans all stored entries on `set` and `size`. No complexity bound was requested, so this is a performance limitation to measure separately rather than a task failure. The checks use supplied clocks and waits. Real timer scheduling, throwing sleep callbacks, and nonfinite custom clock values were not part of the asserted task contract. Finite checks do not establish exhaustive correctness.

## Evaluation limits

The same detailed requirements, fixture, allowed actions, and deterministic grader were available to all sessions. However, provider names were visible, query wording differed, and output settings differed. Typelatch used compact detail with eight results, CodeGraph used eight files with full source, and Graphify used code only extraction without clustering. There was no randomization or repeated trial.

All three agents received detailed diagnostics for the ten failing tests before editing. The test source remained hidden under the task rules, but the feedback exposed assertion names, expected values, and stack locations. This measures coding with interactive grader feedback, not performance against an untouched holdout.

The fixture names the target utilities, contains six small TypeScript source files, and has no third party runtime dependencies. It does not test package identity, external API discovery, compiler resolution across dependencies, large repository navigation, or integration changes. The untouched baseline establishes the defects but is not a coding agent without retrieval. Without that control, the pilot cannot isolate retrieval's contribution to success.

Full model prompts, model identifiers, reasoning settings, seeds, and token records are absent from the pilot logs. Equal model settings cannot be independently verified from these artifacts. Scheduling and setup conditions also prevent a defensible speed ranking. The three final successes are useful evidence that the selected adapters supported completion of these two fixes; they do not support comparative superiority.

## Reproduce this audit

The [audit builder](../../artifacts/competitive/agent-eval/2026-10-06T14-34-05.468Z/audit/build-report.mjs) validates the frozen inputs, replays actions, checks final sources, and regenerates the JSON report. It issues no provider calls and does not modify fixtures, candidate solutions, or product code.

```sh
node --experimental-strip-types artifacts/competitive/agent-eval/2026-10-06T14-34-05.468Z/audit/supplemental-checks.mjs
node artifacts/competitive/agent-eval/2026-10-06T14-34-05.468Z/audit/build-report.mjs
```
