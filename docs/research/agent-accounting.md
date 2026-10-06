# Agent trial accounting and integrity

The next trial can record actual per response model usage without publishing reasoning, private instructions or conversation text. The local Codex records for the original three pilot agents already contain that metadata. The [supplement](../benchmarks/agent-pilot-accounting.json) recovers their initial coding turns and reconciles every unique response against the recorded cumulative turn totals. It does not revise the original pilot outcome or repair its missing executed build identity.

## Recovered pilot metadata

All three coding turns record model `gpt-6-astra`, reasoning effort `ultra`, provider `openai` and client version `0.160.0`. Their dispatches used `fork_turns: none`, with no explicit model or reasoning override. Later review turns are excluded by exact turn identifiers and terminal task events.

| Provider | Model responses | Input tokens | Cached input component | Output tokens | Reasoning output component | Total tokens |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| Typelatch | 9 | 382355 | 367488 | 2038 | 222 | 384393 |
| CodeGraph | 7 | 285379 | 273920 | 1736 | 218 | 287115 |
| Graphify | 9 | 365597 | 352768 | 2081 | 258 | 367678 |

These are recorded model request totals for one coding turn per provider. Input totals include repeated context across requests and the cached input component. Cached input must not be added to input tokens. Reasoning output is a component of output, so it must not be added to output or total tokens. Output accounting includes more than the text visible to a reader. [Official token accounting guidance](https://developers.openai.com/api/docs/guides/token-counting).

The earlier pilot showed CodeGraph using five controlled actions while the other adapters used seven. Its lower observed token total is consistent with fewer model requests in that trial. This is one observation with different queries, outputs and cache histories. It does not isolate a causal retrieval advantage or establish a general saving. Monetary cost, billing reconciliation, server model snapshot, seed and complete prompt equality remain unknown.

## Safe extraction

[The extractor](../../scripts/agent-trial-accounting.mjs) requires an explicit rollout path, expected root thread identifier and expected canonical agent name. It checks the recorded parent and agent before selecting a turn. `initial` means the first started turn; an exact turn identifier selects another turn. An incomplete turn is rejected rather than presented as a completed sample.

```sh
node scripts/agent-trial-accounting.mjs \
  --rollout /absolute/path/to/the/selected/rollout.jsonl \
  --root-thread ROOT_THREAD_ID \
  --agent /root/assigned_agent \
  --turn initial \
  --output /absolute/path/to/accounting.json

node --test scripts/agent-trial-accounting.test.mjs
```

The export contains only allowlisted model and client metadata, numeric usage, response identifier hashes, tool event hashes, record positions, timestamps and source digests. It exports no reasoning content, message bodies, tool arguments, tool outputs or private instructions. The source rollout stays in its original private location. The document name in the export is a basename rather than its private absolute path.

The usage source is `token_usage_record`. A response identifier is counted once. Conflicting duplicate usage is rejected. Every recorded turn total is checked against the sum so far. Missing numeric fields remain null. Repeated `token_count` UI events are counted for the audit and otherwise ignored; summing their cumulative values would inflate usage. `thread_token_usage` is not used because a thread can later perform review or other work.

The source digest covers the current file. The segment digest covers the exact byte range from the selected start through completion, so later appended turns do not change the selected segment identity. This is a local consistency record, not an external signature or a trusted timestamp. Tool event hashes are evidence of recorded events and do not establish filesystem isolation.

Eight executable checks cover privacy sentinels, cumulative event exclusion, duplicate response handling, missing fields, wrong parent and agent identity, incomplete turns, explicit later turn selection, and inconsistent cumulative totals. All passed when this recommendation was prepared. The script has also reconciled the three real initial pilot turns.

## Required trial manifest

A new manifest should bind the following before any agent retrieves evidence. Check the same executable and dependency manifests after the last agent finishes. Reject changed inputs or explicitly classify the sample as invalid.

| Surface | Required evidence | Acceptance check |
| :--- | :--- | :--- |
| Tasks and corpus | Exact task text, requirements, initial file contents, path and byte manifests, frozen grader source and hashes | Baseline fails the intended requirements; expected fixes pass before the fixture is sealed |
| Product build | Exact executed `dist` files, package metadata and lockfile, archived source used to build them, build command and exit code | MCP command resolves inside the frozen candidate and every executable file still matches after the trial |
| Node and native dependencies | Real Node executable path and digest, runtime version and architecture, installed dependency files including native SQLite addon, symlink targets | Resolve and hash executable targets; record any external runtime dependency outside the archive as an explicit boundary |
| CodeGraph | Installed npm version, archive integrity where available, actual launcher and bundled runtime bytes, full installed dependency manifest | Launch the recorded installation; do not infer executable contents from a Git commit or version string |
| Graphify | Actual Python executable and base interpreter, Graphify distribution and installed dependency manifests, extraction flags | Record Python runtime and package contents; distinguish code from generated bytecode and index output |
| Grading | Actual compiler executable and installed compiler files, test runner and grader bytes, exact command and environment allowlist | Compiler and grader come from frozen paths; neither follows a mutable shared checkout |
| Assignment | Provider, task, repetition, order, complete public task and wrapper text, allowed tools, budgets, feedback policy | Freeze assignment before execution and tie its hash to the dispatch and resulting agent identifier |
| Model settings | Observed model identifier, reasoning setting, client version, explicit overrides, selected turn | Report absent or inconsistent values as unknown; compare observed settings rather than inheritance intent |
| Tool traffic | Exact requests, outputs, errors, elapsed times, sequence numbers, before and after edit hashes | Verify budgets and replay reads and edits from the frozen corpus to reproduce the final candidate |
| Final outcome | Final source manifest, compiler result, hidden grader result, terminal state, accounting export | Complete success needs terminal evidence and final grading; failures, interruptions and timeouts stay distinct |

Hashing only a top level executable is insufficient when it dynamically imports modules. Hash the installed tree used by that executable and resolve symlinks. Shared libraries and operating system dependencies can remain outside the copied tree, but their boundary must be stated. A lockfile records the intended installation; it does not prove the installed files. `npm ls` or a Python package list supplies useful identities, but file manifests establish contents.

Use a copied runtime with immutable product and compiler paths. A shared `dist/mcp.js` can change during a run even if the source was hashed at the beginning. A manifest should also record whether the candidate still matches its source build. Persistent servers and child workers must use the same frozen tree. Record the sanitized environment actually passed to providers without collecting inherited credentials or unrelated user settings.

## Feedback and isolation

The [first server](../../scripts/agent-eval-server.mjs) recorded source files and four harness files, then launched the current shared `dist/mcp.js`. Its grader resolved TypeScript from the shared checkout. It did not bind compiled output, runtime binaries or installed dependencies. Those omissions cannot be repaired retroactively by hashing today's files.

The original `test` action ran the supposedly hidden grader and returned its complete stdout and stderr. Agents saw assertion names, expected values and stack locations before editing. This is a valid interactive feedback experiment but does not measure an untouched holdout. The next protocol should provide public development checks with normal diagnostics and run the hidden grader only after the agent finishes. Hidden grader results should be retained in evaluator artifacts and withheld during the coding turn. Keep public test calls and evaluator final grading separately counted.

A prompt asking an agent to use only the client is not an operating system sandbox. The previous server and agents shared the host filesystem. Controlled API logs alone cannot exclude other reads. If the next run uses the same environment, say that restriction is procedural and audit the recorded tool events. Strong isolation requires an environment that cannot read evaluator files or other candidates and cannot contact unauthorized endpoints. Do not label that property verified until an actual isolation test fails the forbidden read.

A fair usability trial also needs a coding control without provider retrieval, repeated trials, order balancing and tasks not used to tune the implementation. Freeze the comparison metrics and feedback rules first. Distinguish complete task success, repair attempts, model requests, controlled actions, tokens, provider time and total turn duration. A speed ranking requires controlled scheduling and repeated measurements. A token count cannot stand in for task correctness.

## Implementation guidance for the next run

1. Prepare independent fixtures and freeze the requirements, public checks and sealed final grader before retrieval. Record the negative baseline and known correct solutions as evaluator evidence.
2. Archive the candidate, provider installations, compiler, harness and public prompt wrappers. Make commands resolve into those archives. Record content manifests before startup and compare them after shutdown.
3. Register each exact public prompt and assignment before dispatch. Use a fresh agent for each sample and record its resulting canonical path. Keep model settings inherited unless the user explicitly authorizes an override; verify what the resulting turn actually recorded.
4. Log the controlled protocol with a monotonic sequence, original request, original response, timestamp, elapsed time and resulting source hashes. Validate it against the frozen corpus and final files. Keep transport controls private.
5. Wait for a terminal agent event, perform the sealed grade, then extract the specific completed turn with this script. Preserve missing usage and interrupted samples rather than replacing them with estimates or silently retrying them.
6. Publish aggregate results only after independent replay and review. Keep the original task scores separate from later supplemental checks. Retain explicit unknown values for prompt completeness, billing and operating system isolation when those properties were not observed.

A separate future CLI runner can use `codex exec --json`, whose documented event stream includes usage on `turn.completed`. The stream can also contain reasoning items, so an allowlist filter is still necessary before making an artifact public. This recommendation inspected the documented interface but did not launch another model session or verify this alternative runner locally. [Official noninteractive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
