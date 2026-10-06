# Adversarial review of the competitive proof

Reviewed on 6 October 2026. This review inspected the compact search and exact symbol changes authored by another team member, the workspace cache representation, the recorded comparisons, the evaluator and the fixture manifests. The reviewer also authored the initial comparison harness, so the harness audit is a second pass rather than an independent author review.

## Findings

### Source body metric overstates what is checked

The original `sourceBodyIncluded` field was true whenever a Typelatch result contained a nonempty snippet. In the repository comparison, all eight expected snippets were shortened, with 22 to 712 characters omitted by compact mode. For example, the `validateWorkspace` result omitted 338 characters. The metric therefore established that a source excerpt was provided, not that a function body was complete. CodeGraph's detection also checked formatting rather than comparing every source byte. The runner and saved reports now use `sourceExcerptIncluded` and `sourceExcerptsIncluded`. Location fields now use `sourceLocationProvided` and `sourceLocationsProvided`. Raw tool outputs were unchanged by this schema correction. This finding does not change the expected file hit counts.

### Text and protocol sizes can lead to opposite conclusions

In the recorded repository run, Typelatch returned 56,666 text bytes and Graphify returned 92,581. Their serialized MCP response sizes were 117,919 and 94,202 bytes respectively because Typelatch also includes structured content. The client may choose one representation, both, or another serialization. Neither value establishes actual model tokens or retained context. Report both values and leave token savings unmeasured.

### Session state prevents an independent query interpretation

Each provider receives one persistent MCP session. A query and its repeat follow all earlier query pairs. CodeGraph can omit source it returned earlier in that session. Thus a missing body in the current response is not necessarily missing evidence for the agent. The fields called first and repeat mean first and second call of that pair, not independent sessions. Only the first query of the run can be considered the first query after setup. Cold operating system caches and randomized repeated latency trials were not measured.

### Capability and corpus differences limit storage conclusions

All provider inputs had identical manifests, but their indexes intentionally represent different content. Typelatch searches docs and snippets. Graphify in this run builds a code graph without clustering or semantic document extraction. CodeGraph primarily indexes code structure. All files in each measured index directory, including caches and live SQLite journals, were counted. The resulting sizes are valid observations; they do not establish equal capability or universal storage superiority.

The larger corpus includes 45 files from Typelatch's known repository and eight existing repository regression questions. It is neither a blind benchmark nor an independent coding task. JSON library benchmark cases are present in the source corpus, but the workspace evaluator and its expected source paths are outside it. The tiny authored corpus also keeps its expectations outside the indexed directory. No discovery tool receives the expected path.

## Verified checks

The baseline, initial compact and initial repository reports each completed without tool error rows. An independent Python pass recomputed every recorded text content byte count from the raw responses. All three provider input manifest hashes matched the original fixture hash in every report. The unrelated query control returned explicit empty results for all three providers in both the initial compact and repository runs.

The following focused test command passed 27 tests across four files:

```sh
npx vitest run test/workspace-compact.test.ts test/symbol-identity.test.ts test/query-ranking.test.ts test/workspace-storage.test.ts
```

That command ran before the final schema 6 cache revision. The final release check must rerun the updated tests. Source inspection of schema 6 found consistent UTF16 offsets for slicing the same inventory text used to compute the content hash. Tests cover Unicode, CRLF, same length changes, stale term removal and migration from schema versions 4 and 5. Final runtime verification belongs to the recorded release run.

The retained search worker was subsequently reviewed and its 15 search and compiler session tests independently rerun successfully:

```sh
npx vitest run test/workspace-search-session.test.ts test/workspace-session.test.ts
```

The pool still shares the two active request and sixteen queued request limits across operation types. Reuse keys include the command, current directory and environment. Cancellation kills the child process group. Input and aggregate output limits remain enforced, and the idle timer and child streams do not keep a completed CLI alive. Repeated searches rebuild their file inventory and content hashes, rather than reusing a stale source snapshot. No confirmed worker correctness defect was found in this pass.

Exact symbol lookup uses a bound SQL value with binary case comparison. Qualified names do not fall back to another module or a differently cased symbol. Bare names expose ambiguity and the number of omitted candidates. Tests exercise these behaviors in baseline, compact and trimmed package storage. No additional confirmed product defect was found in the reviewed changes.

## Addressed setup defects

The first Graphify adapter used the wrong output path. That response was an adapter error, not a Graphify miss. The invalid run is excluded from published result counts. Later runs successfully use the graph at the path actually produced by extraction, and the runner classifies Graphify error text as errors even if its MCP `isError` field is false.

The initial classifier also called successful empty messages `ok` because they contained text. It now preserves an explicit `empty` state for all three providers. Stored report classifications were corrected from their raw responses; expected file hit counts were unchanged. Errors retain a null hit rather than becoming retrieval misses.

Graphify's automatic skill refresh changed an existing Claude skill during the first invocation. The main skill was restored from an exact backup. The intact original pipx distribution supplied the eight reference files, with every restored file checked against that source. Later children use isolated home and XDG paths as well as an explicit auto refresh opt out. The [setup recovery audit](competitive-setup-side-effects.json) records exact sources, hashes and the remaining uncertainty about any prior custom sidecar edits.

## Remaining proof gap

The retrieval comparisons reviewed here do not include matched agents completing code changes under fixed model, prompt, token, tool call and repair budgets. No shared generated implementation was compiled or asserted for these competitor rows. A separate coding pilot, if present, needs its own protocol and outcome review. No cross language, impact analysis, multimodal, monorepo or hosted service comparison was executed in these runs. These results support narrower claims about measured retrieval and storage, and identify follow up work. They do not support the claim that Typelatch surpasses both competitors in every aspect.

The final competitor reports were rerun from a frozen candidate after a source hash check detected concurrent edits during the first final attempt. Those interim reports were archived and excluded from the final claims. The [final integrity record](../benchmarks/competitive-final-integrity.json) confirms 54 small corpus rows and 48 repository rows, identical provider inputs, correct content and full response byte counts, no tool errors, all empty controls and unchanged candidate source and build hashes. The original baseline and initial compact reports remain available separately.
