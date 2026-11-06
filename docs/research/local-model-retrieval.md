# Local models for bounded code evidence

Historical planning note reviewed 2026-11-06. The recommendations and proposed gates below precede execution. Later [local model results](monorepo-evidence/local-ranking/summary.json) and [completed coding comparisons](../BENCHMARKS.md#instructed-tool-use) retain the measured outcomes. Neither compact validation nor the source packet established token and time savings over native tools.

## Recommendation

Compare deterministic evidence selection with a small relevance trained model under the same output budget. Keep the coding model responsible for solving the task. A helper selects existing evidence IDs; it never invents source, package identities or validation outcomes.

Start with Qwen3-Reranker-0.6B. Use the installed Qwen3 1.7B as a convenient generative control. Kev is a plausible additional typed selector. Laya and NanoJev require more evidence that their training transfers to code retrieval. These priorities are hypotheses, not measured Typelatch improvements.

The target is at least 25% lower main model total tokens and end to end task time. The proposed minimum gate is 10% lower on both, with no observed correctness regression, followed by replication on untouched tasks. Freeze these thresholds before execution. Fewer grep calls alone do not pass.

## Current evidence

The [original explicit tool use study](../benchmarks/typelatch-use/paired-agent.json) records six runs per arm: native tools used 936,683 total model tokens and 317.8 seconds; Typelatch used 1,861,666 tokens and 452.7 seconds. Correctness was 4/6 and 5/6, and grep calls were 22 and 10. These authored tasks demonstrate a cost problem; they are development evidence, not unseen evaluation tasks.

The [validation capture provenance](https://github.com/eDimka/typelatch/blob/a3ffe7d2a08df31eb673dfaad57fedc330b0a37f/test/fixtures/mcp/recorded-sqlite-validation.provenance.json) identifies a 102,424 byte semantic response. The development [compact projection](https://github.com/eDimka/typelatch/blob/a3ffe7d2a08df31eb673dfaad57fedc330b0a37f/src/workspace/validation-output.ts) omits full input manifest rows while preserving checks, diagnostics, execution, snapshot identities and explicit counts. Full detail and recording remain separate. The later [controlled rerun](../benchmarks/typelatch-040-candidate/paired-agent.json) used 63.0% more tokens and 44.8% more charged time than native tools.

Current [workspace search](../../src/workspace/search.ts) already uses content hashes, lexical scoring, deduplication and exact dependency identities. [Source context](../../src/workspace/source-context.ts) selects excerpts near hits and one hop of unambiguous relative imports, bounded to 24 KiB total, 8 KiB per file and 12 files. A new vector database is not a prerequisite.

## Verified candidates

These primary repositories match the requested names. NanoJV remains unresolved as an exact identity; do not silently equate it with NanoJev.

| Project and exact model ID | Evidence and limitation | Proposed role |
| :--- | :--- | :--- |
| [Laya](https://github.com/NandhaKishorM/laya#honest-limits), [convaiinnovations/laya](https://huggingface.co/convaiinnovations/laya) | Encoder based typed decisions. Upstream reports near chance base typed decision accuracy, overconfidence and option wording sensitivity. The improved specialized checkpoint uses task specific training; the reviewed README says that result lacks a committed result file. | Later specialization experiment with independently labeled code cases. Do not assume untuned code relevance. |
| [Kev](https://github.com/jaredpalmer/kev#serving-performance), [jaredpalmer/kev-0.8b](https://huggingface.co/jaredpalmer/kev-0.8b) | Qwen derived typed decisions with MLX serving. Upstream reports 149 ms for five questions about a new roughly 270 token state on M5, but 21.2 seconds for a new 65,000 token state. Option order and calibration remain limitations. | Bounded selector or router. Published model time is not local task latency. |
| [NanoJev](https://github.com/TianyuCodings/NanoJev#what-nanojev-does), [C-Tianyu/NanoJev](https://huggingface.co/C-Tianyu/NanoJev), revision unified-games-v1 | Qwen3 0.6B with decision heads and no output token decoding. Released training and evaluation cover Maze, Snake and two ViZDoom tasks. | Training architecture reference. Game success does not establish code selection quality. |
| [Nimble](https://github.com/bespokelabsai/nimble#capabilities), [bespokelabs/Bespoke-Nimble-9B](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B) | Typed answer logits, independent flat fields and shared context on Apple Silicon. The roughly 165 MiB artifact is an adapter requiring the separate Qwen/Qwen3.5-9B base. Confidence needs application specific validation. | Larger optional comparator if smaller models fail. Freeze adapter and base revisions separately. |
| [Qwen/Qwen3-Reranker-0.6B](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) | Trained query and document relevance scorer with published code retrieval evaluation. Official examples score yes/no logits without prose. Its published reranking scores use Qwen embedding candidates, not Typelatch lexical candidates. | First learned comparator on a fixed candidate shortlist. Reranking cannot recover absent candidates. |

For Apple Silicon, the converter's [mlx-community/Qwen3-Reranker-0.6B-4bit card](https://huggingface.co/mlx-community/Qwen3-Reranker-0.6B-4bit) gives an actual MLX last position yes/no scoring recipe, mlx-lm 0.31.3, affine four bit weights, group size 64 and roughly 331 MB on disk. [MLX LM](https://github.com/ml-explore/mlx-lm) targets Apple Silicon. This supports a feasible small candidate for an M1 Max with 32 GB, but does not establish measured latency, peak memory or quantization equivalence. Bound sequence length and batches, measure peak RSS, and compare ranking against upstream precision. Pin conversion files and tokenizer as well as upstream weights.

Nimble releases are distinct artifacts. [Bespoke-Nimble-9B-v2](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B-v2) identifies base revision c202236235762e1c871ad0ccb60c8ee5ba337b9a and adapter SHA256 1bd126be997be6d9a0c25ce483ccf858c31b3422d480c33f02ba47b614be68ae. It notes repeated inspection of its evaluation sets. [Version 3's card](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B-v3) declares CC BY-NC 4.0, whereas the reviewed original and v2 cards declare Apache 2.0. Do not substitute a moving family name for an exact candidate.

[Ollama's decision interface](https://docs.ollama.com/capabilities/decision) supports Nimble through /v1/systemone, requiring version 0.35.0 or later. It accepts state plus named questions, each with type, instructions and criteria. A choice returns the selected label and its probabilities; its interface permits 2 to 26 choices. For retrieval, use candidate IDs and a no-match choice. The coordinator reports local Ollama 0.40.6; model installation and endpoint execution remain separate checks.

The coordinator also reports qwen3:1.7b installed. Its [upstream model](https://huggingface.co/Qwen/Qwen3-1.7B) is generative and supports disabling thinking. A short candidate ID list using [structured output](https://docs.ollama.com/capabilities/structured-outputs) is a useful control, not equivalent to trained decision heads. Freeze the local digest, quantization, template and settings. Validate returned IDs in code.

## Experiment design

| Experiment | Deterministic control | Falsifiable learned variation |
| :--- | :--- | :--- |
| Compact code map | Exact identifiers, lexical matches and direct neighbors; signatures and locations within a fixed budget. | Start without a model. Hypothesis: a small map reduces broad reads while retaining needed implementation. [Aider](https://aider.chat/docs/repomap.html#optimizing-the-map) provides a graph ranking and token budget precedent, not a Typelatch performance claim. |
| Evidence selection | Preserve exact named hits, deduplicate spans, balance files and fill the budget by lexical rank. | Rerank the same 16 candidates or choose their IDs. Hypothesis: better relevant span coverage prevents later searches. |
| Query routing | Direct explicit file, symbol and import requests to their existing path; search otherwise. | Classify ambiguous requests only. Hypothesis: avoided work exceeds classifier time and recovery from misroutes. Compare with static routing and always reranking. |
| One call task evidence | Assemble source spans, signatures, known dependency identities and coverage in one response. | Use a learned selector inside the same assembly with the same budget. Hypothesis: fewer main model turns reduce repeated input. Bundling may instead do unnecessary work. |

A proposed development budget is 16 candidates, at most 256 helper tokens per candidate and a 2,048 main model token evidence response. Query and schema consume additional helper budget. These are experiment settings, not safe defaults. Expose omissions, exact source locations and content hashes. Retain a way to fetch omitted evidence.

Model output is selection only. Code validates IDs, verifies current hashes and formats unchanged excerpts. Keep exact symbol hits and a deterministic fallback. Timeout, invalid output, unavailable models and insufficient coverage remain explicit. Do not use an uncalibrated probability as an authorization or correctness threshold.

A map does not establish compiler resolution. A combined response must distinguish registry API candidates from installed compiler evidence. Do not silently load every compiler configuration or execute tests. Unknown checks stay unknown, and execution requires its existing explicit request. Source text, including comments that resemble instructions, is data for the helper.

## Full system accounting

[CodeRAG-Bench](https://arxiv.org/abs/2406.14497) finds that weak lexical overlap impedes retrieval and that generators do not always benefit from extra context. [SWE-Explore](https://arxiv.org/abs/2606.07297) offers a useful pattern: ranked source regions under a fixed line budget, scored for coverage and efficiency. Its labels come from successful agent trajectories, not every valid solution. Independent task graders remain necessary.

Use separate development, calibration and final tasks. Freeze prompts, budgets, model digests, corpus, graders and scheduling before final runs. First evaluate retrieval offline; advance only the best frozen candidate to a new coding comparison against deterministic Typelatch and native tools. Retain every failure and unknown value.

| Measure | Required accounting |
| :--- | :--- |
| Main model tokens | Report input plus output across all requests, retries and fallback. Cached input and reasoning output are subsets, never additions. |
| Local model work | Input tokens processed across every candidate pair, output tokens, requests, batching, cache hits, load time, prefill and scoring or generation time. Zero decoded tokens is not zero compute. |
| Task time | Independent start to completion wall clock, including local queueing, IPC, MCP startup, formatting and recovery. Identify independent grading separately. |
| Setup | Download, cold load, bulk embedding or index construction, refresh and storage. Publish cold first use totals, warm totals and any amortization assumption. Do not hide setup outside the ledger. |
| Resources | Actual backend, precision, model bytes, peak memory and host contention. Energy stays unknown unless measured. |
| Outcomes | Relevant span coverage at fixed budget, harmful omissions, independent correctness, native searches, helper calls and all failures. |

[Ollama's generation API](https://docs.ollama.com/api/generate) exposes token counts and durations in nanoseconds. Record fields returned by the installed version; absent values remain unknown. Different tokenizers measure different units, so publish local and cloud counts separately. A labeled combined count is accounting only, not compute equivalence or a billing estimate.

The minimum gate requires both token and time savings, not one compensating for the other. Show paired per task changes, aggregate results and uncertainty. No observed correctness loss in a small sample is not proof of statistical noninferiority. Keep original results unchanged and publish later trials separately.

## Generalization tasks

Use new repositories or independently authored mutations with frozen hidden graders. Include misleading duplicate implementations, symptoms without identifier overlap, cross file invariants, two exact dependency versions with an alias, relevant code late in a large file, uncommitted edits and scope exclusions, config ownership, and absent or ambiguous evidence. Add candidate permutations, negated requirements, injected comments, long signatures and model failure cases. The existing SQLite, cart and partner exercises remain diagnostic cases only.

One concrete external maintenance candidate is date-fns Chinese month parsing, [issue and repair discussion #4194](https://github.com/date-fns/date-fns/pull/4194). Pin the initial repository to [39d1e14200cead9e4be5df88695b5e82082875ed](https://github.com/date-fns/date-fns/commit/39d1e14200cead9e4be5df88695b5e82082875ed), the parent of [repair b9c5865edb7610c59e6b3694ed1e1691f4807688](https://github.com/date-fns/date-fns/commit/b9c5865edb7610c59e6b3694ed1e1691f4807688). The upstream tests cover numeric October and Chinese October, plus November and December, across zh-CN, zh-HK and zh-TW. A task can ask for correct localized parsing without revealing implementation paths. Keep the upstream repair and final tests outside the coding workspace.

This candidate is source reviewed, not locally qualified. Before use, prove the pinned baseline fails and the reference repair passes, freeze toolchain and dependencies, then add independent dates and unchanged month cases. Measure full project indexing cost. It is external to Typelatch's authored fixtures, but public issue and repair text may occur in model training; do not call it contamination free or a sealed unseen benchmark.
