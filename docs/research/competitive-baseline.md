# Competitive baseline

Measured on 6 October 2026. This investigation compares Typelatch with the public [CodeGraph repository](https://github.com/colbymchenry/codegraph) named by the user and [Graphify](https://github.com/Graphify-Labs/graphify). The unrelated local LibBrain checkout is excluded.

## Identities

| Product | Executed artifact | Source used for research |
| :--- | :--- | :--- |
| Typelatch | Local version 0.2.0, source and build hashes in each report | This working tree |
| CodeGraph | `@colbymchenry/codegraph@1.6.2`, Darwin ARM64 npm distribution | Commit `6421644ef292d0e6decd968e249c18bd648a9078` |
| Graphify | `graphifyy==0.9.77` built from the checked out source, with its MCP extra | Commit `5c7b84792f453582676548185aaec3824d51dfe2` |

The CodeGraph source commit identifies the documentation inspected. It does not claim that the published binary was independently reproduced from that commit. The comparison records the installed npm lockfile and its integrity pins. Graphify records its installed dependency versions and direct source installation metadata.

## What the competitors actually provide

CodeGraph supplies a local graph, structural search, source excerpts, call relationships and impact information across many languages. Its default MCP surface lists one primary exploration tool, while an environment setting enables narrower tools. The server normally watches files, marks pending changes and catches up on connection. These are relevant usability features that Typelatch must assess, rather than assuming more tools are better. [CodeGraph tool definitions](https://github.com/colbymchenry/codegraph/blob/6421644ef292d0e6decd968e249c18bd648a9078/src/mcp/tools.ts), [CodeGraph MCP lifecycle](https://github.com/colbymchenry/codegraph/blob/6421644ef292d0e6decd968e249c18bd648a9078/src/mcp/index.ts).

CodeGraph's npm distribution includes its own Node runtime. Its source documentation describes a separate runtime, application files, production dependencies and native kernel. Comparing that whole installation against only a Typelatch database would be misleading. [Distribution design](https://github.com/colbymchenry/codegraph/blob/6421644ef292d0e6decd968e249c18bd648a9078/BUNDLING.md).

Graphify builds local graphs through AST extraction and can additionally process documents and media through semantic extraction. It has graph querying, node inspection, neighbors, shortest paths, communities and several export targets. Its local MCP query returns source locations and relationships. Our invocation uses code only extraction and skips clustering, so it does not evaluate Graphify's document, media or community features. [Extraction implementation](https://github.com/Graphify-Labs/graphify/blob/5c7b84792f453582676548185aaec3824d51dfe2/graphify/cli.py), [MCP implementation](https://github.com/Graphify-Labs/graphify/blob/5c7b84792f453582676548185aaec3824d51dfe2/graphify/serve.py).

Graphify's hosted MCP service is a separate product whose implementation is private. It requires account access and repository indexing. This local comparison makes no claims about that service. [Hosted MCP documentation](https://github.com/Graphify-Labs/graphify-mcp).

## Executed baseline

The [baseline report](../benchmarks/competitive-baseline.json) preserves actual setup commands, MCP tool schemas, input arguments, responses, timings and file inventories. Expectations were saved in [the case manifest](../../scripts/fixtures/competitive-cases.json) before running any provider. Each provider received an identical copy of [the fixture](../../scripts/fixtures/competitive). Only questions were sent to retrieval tools. Expected answers and evaluator code were not indexed.

| Observation across seven code questions | Typelatch before changes | CodeGraph | Graphify |
| :--- | ---: | ---: | ---: |
| Expected source paths mentioned | 7 / 7 | 7 / 7 | 7 / 7 |
| Text content bytes | 29,514 | 13,935 | 13,518 |
| Serialized MCP response bytes | 61,565 | 14,662 | 14,071 |
| Advertised tool schema bytes | 6,097 | 1,913 | 6,273 |
| Index directory logical bytes after first query | 57,344 | 225,658 | 23,592 |

These are observations, not equivalent utility scores. Graphify supplies graph nodes and edges with line locations but no source bodies in these responses. Typelatch and CodeGraph include code. CodeGraph responses may also mention useful files outside the source shown. A path mention alone is therefore a weak retrieval check. The current runner additionally records located source evidence, source body presence, breadth and a no match control. It keeps document and configuration cases separate.

The baseline reveals a real Typelatch weakness: repeated metadata and duplicated structured content make its small retrieval responses larger than both competitors. It also shows that Graphify's minimal graph is smaller than Typelatch's initial workspace database on this tiny corpus. No claim that Typelatch already surpasses both products follows from these results.

The first [compact response run](../benchmarks/competitive-compact.json) retained all seven expected code locations and reduced Typelatch text content to 28,011 bytes. That is a 5.1 percent reduction on these short snippets, still larger than both competing responses. All three providers returned an explicit empty response for the unrelated control query. CodeGraph omitted one source body from its current response after showing it earlier in the session, consistent with session deduplication. This must not be counted as an absent capability.

## Frozen candidate rerun

The [final small report](../benchmarks/competitive-final-small.json) and [final repository report](../benchmarks/competitive-final-repository.json) were executed from the frozen candidate at `/tmp/typelatch-competitive-candidate-20261006`. Its snapshot manifest SHA256 is `5e0e616708b524feacebae0751d9cf0519c631c76846519174a086c937c5c6ab`. The [independent integrity report](../benchmarks/competitive-final-integrity.json) verifies every candidate manifest file, executed source and build hash, identical provider fixture inputs, all byte counts and the expected path scoring. These results describe that candidate, not an assertion about a concurrently edited working tree.

| Frozen candidate observation | Typelatch | CodeGraph | Graphify |
| :--- | ---: | ---: | ---: |
| Small corpus expected code paths | 7 / 7 | 7 / 7 | 7 / 7 |
| Small corpus text bytes | 28,004 | 13,935 | 13,518 |
| Small corpus full response bytes | 58,440 | 14,662 | 14,071 |
| Small corpus index bytes | 45,056 | 225,658 | 23,590 |
| Repository expected code paths | 8 / 8 | 7 / 8 | 6 / 8 |
| Repository text bytes | 56,659 | 119,361 | 92,581 |
| Repository full response bytes | 117,905 | 125,637 | 94,202 |
| Repository index bytes | 868,352 | 2,220,410 | 320,342 |

The repository corpus contains 45 files from commit `0053a7fbb1c8f8e7b3572145f2e64e18e8dc7125` and eight previously authored Typelatch regression questions. Every corpus file was independently checked against that Git object. All three providers passed the unrelated empty result control on both corpora. Typelatch's index is smaller than CodeGraph's in both runs, and larger than Graphify's minimal graph. Typelatch's repository text response is smaller than both competitors, while its full protocol response remains larger than Graphify's. The small corpus still exposes substantial response overhead. None of these measurements establishes token savings or better completed agent work.

## Reproduction

Use isolated installations. Do not run either product's agent installation command for this benchmark.

```sh
git clone https://github.com/Graphify-Labs/graphify.git /tmp/typelatch-graphify-source
git -C /tmp/typelatch-graphify-source checkout 5c7b84792f453582676548185aaec3824d51dfe2
uv venv /tmp/typelatch-graphify-env --python 3.12
uv pip install --python /tmp/typelatch-graphify-env/bin/python '/tmp/typelatch-graphify-source[mcp]'
npm install --prefix /tmp/typelatch-codegraph-install --ignore-scripts --no-audit --no-fund @colbymchenry/codegraph@1.6.2
npm run build
CODEGRAPH_BIN=/tmp/typelatch-codegraph-install/node_modules/.bin/codegraph \
GRAPHIFY_PYTHON=/tmp/typelatch-graphify-env/bin/python \
node scripts/competitive-proof.mjs
```

The runner records resolved dependency versions. Rerunning the installation later can select newer Graphify dependencies, so compare the manifest before treating a replay as the same environment. Set `TYPELATCH_DETAIL=compact` to measure the compact search response separately after building a version that supports it.

For a different corpus, set `COMPETITIVE_FIXTURE` to its directory and `COMPETITIVE_CASES` to a JSON file containing a `cases` array with `id`, `question`, `expected` and `lane`. Expectations belong outside the indexed directory. The report records exact input manifests. The authored edit and delete sequence is skipped when the alternate corpus does not have the retry fixture.

The runner uses an isolated home and XDG directories for child processes. Telemetry and update checks are disabled for CodeGraph, and Graphify skill auto refresh and query logging are disabled. Graphify receives no model credentials. Skill auto refresh is unrelated to refreshing the graph. The freshness lane edits and removes one source file, records immediate results, then records explicit refresh commands and subsequent results. It does not award freshness wins from a race against a watcher's debounce interval.

## Proof still needed

| Dimension | Evidence required before a superiority claim |
| :--- | :--- |
| Storage | Same content and required capabilities, several corpus sizes, index files and journals, installation and runtime costs reported separately |
| Agent usability | Same model and task budget, complete successful edits, compilation and assertions, tool calls, repairs and retained context |
| Correctness | Exact source locations, ambiguity and missing result controls, changed and deleted sources, dependency version mismatches |
| Breadth | Languages, call graph navigation, impact analysis, docs, configs, monorepos and media evaluated only where supported |
| Reproducibility | Pinned provider artifacts, fixture hashes, all responses, execution logs, independent replay and explicit failure states |

Competitor published benchmarks use different workloads and cannot be transferred to Typelatch. CodeGraph documents both lower total tokens processed and larger retained context in its architecture answer experiments. Graphify publishes memory and code understanding evaluations. Neither proves the outcome of a shared Typelatch coding task. [CodeGraph retained context study](https://github.com/colbymchenry/codegraph/blob/6421644ef292d0e6decd968e249c18bd648a9078/docs/benchmarks/residual-context-occupancy.md), [Graphify benchmark methodology](https://github.com/Graphify-Labs/graphify/blob/5c7b84792f453582676548185aaec3824d51dfe2/BENCHMARKS.md).

## Setup incident

The first Graphify invocation automatically refreshed an existing Claude skill before the runner disabled that behavior. The original `SKILL.md` was restored from Graphify's exact backup and the version marker restored to the logged previous version, 0.8.44. The intact original pipx installation was then located and its main skill verified against the backup byte for byte. All eight reference files were restored from that original distribution, after preserving the replacement files. Their recovery sources and hashes are retained in [the setup audit](competitive-setup-side-effects.json). Possible prior custom edits to reference files remain unknown because their original bytes were not captured. Later calls use an isolated home as well as the opt out setting. The initial Graphify adapter run also pointed at an incorrect graph path; it is retained separately as `artifacts/competitive-invalid-adapter-run.json` and excluded from all baseline scores.
