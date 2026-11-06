# Monorepo competitor configurations

Reviewed 6 November 2026 against official documentation, registry metadata and release source. This is a configuration review, not a new performance result. The earlier small corpus measurements do not establish a large monorepo advantage. Native search, TypeScript language services and Serena are being qualified separately.

## Exact candidates

| Candidate | Current published identity | Source inspected |
| :--- | :--- | :--- |
| CodeGraph | `@colbymchenry/codegraph@1.6.2` | Registry `gitHead` `6560052a6f856855d3f71eee838fd66ccfa4285d` |
| Graphify | `graphifyy==0.9.103` | `16218bfc80d4ca2799734d045039f7ed1a5fa9fb`, current `v8` branch |
| ast-grep | `@ast-grep/cli@0.51.1` | Published package and official CLI documentation |

These identities came from the [CodeGraph npm registry](https://registry.npmjs.org/@colbymchenry%2Fcodegraph/latest), [Graphify PyPI registry](https://pypi.org/pypi/graphifyy/json) and [ast-grep npm registry](https://registry.npmjs.org/@ast-grep%2Fcli/latest). Registry labels can move. Preserve actual package archives, dependency locks and executable hashes at qualification. CodeGraph's current main commit differs from its published package metadata; a source commit does not establish reproducibility of a distributed binary. Graphify's obsolete `main` branch is not the current release.

## Use each tool's intended path

**CodeGraph:** build with `codegraph init <copy> --yes`, then use a persistent `codegraph serve --mcp` session from that copy. Its default model interface is the single `codegraph_explore` tool. Preserve source excerpts, relationship paths, impact information and session deduplication. The native CLI `codegraph explore <query> --path <copy>` uses the same handler, but a new CLI process per query cannot stand in for the persistent MCP session's reuse. `--max-files` is available; do not silently shrink it to handicap answers. These commands are source verified here and still require a runtime smoke check. [Release CLI](https://github.com/colbymchenry/codegraph/blob/6560052a6f856855d3f71eee838fd66ccfa4285d/src/bin/codegraph.ts), [release tool surface](https://github.com/colbymchenry/codegraph/blob/6560052a6f856855d3f71eee838fd66ccfa4285d/src/mcp/tools.ts).

Leave the default watcher and shared daemon enabled for repeated session and freshness trials. Measure index construction, first connection, warm reuse and observed refresh completion separately. The product documents a two second quiet window for file changes. An immediate stale response before that window is not evidence that automatic refresh is absent. Retain freshness warnings and unresolved graph boundaries. [Release README](https://github.com/colbymchenry/codegraph/blob/6560052a6f856855d3f71eee838fd66ccfa4285d/README.md), [MCP lifecycle](https://github.com/colbymchenry/codegraph/blob/6560052a6f856855d3f71eee838fd66ccfa4285d/src/mcp/index.ts).

**Graphify:** for the initial source code lane use an isolated Python 3.12 installation of `graphifyy[mcp,leiden,watch]==0.9.103`, `GRAPHIFY_BACKEND=none`, and `graphify extract <copy> --code-only`. Keep clustering enabled. The optional Leiden installation prevents the documented fallback to Louvain, which changes communities. Record the actual clustering implementation. A document semantics lane needs a separate configured model and full extraction costs; this source code lane cannot support claims about that capability. [Release dependency extras](https://github.com/Graphify-Labs/graphify/blob/16218bfc80d4ca2799734d045039f7ed1a5fa9fb/pyproject.toml), [release extraction and privacy instructions](https://github.com/Graphify-Labs/graphify/blob/16218bfc80d4ca2799734d045039f7ed1a5fa9fb/README.md).

Serve the absolute graph file with `graphify-mcp <copy>/graphify-out/graph.json`. Qualify `query_graph`, `get_node`, `get_neighbors` and `shortest_path`; use communities when the task calls for an architectural map. The server reloads a changed graph file. Source changes require `graphify watch <copy>` or explicit `graphify update <copy>`; graph reload alone is not source indexing. [MCP setup](https://docs.graphify.com/open-source/mcp-server), [MCP tools](https://docs.graphify.com/open-source/features/mcp-tools).

For precise headless questions, the CLI also supports `query --seed`, `explain`, `path` and reverse `affected` traversal. CLI query depth defaults to two, whereas MCP query depth defaults to three. Explicitly freeze both depth and output budget in a matched query comparison. Budget units are an estimate, not model tokens: release rendering uses roughly three characters per token, and complete edges or omission notices can exceed the requested budget. Measure actual bytes and client token usage. Ambiguous and absent names have distinct CLI exit states. [CLI reference](https://docs.graphify.com/open-source/configuration/cli), [release rendering](https://github.com/Graphify-Labs/graphify/blob/16218bfc80d4ca2799734d045039f7ed1a5fa9fb/graphify/serve.py).

**ast-grep:** qualify direct `ast-grep run` structural patterns and `ast-grep outline`, including compact imports, exports and member signatures. The outline command is explicitly experimental and constructs no index. It does not follow references or re-export chains. This makes it a useful low setup structural comparator and a candidate for a stronger native baseline. [Outline documentation](https://ast-grep.github.io/guide/outline-code).

Its documented limits include no type, scope, control flow or data flow analysis. Do not score a syntactic import match as proof of the installed package version or resolved declaration. Fix TypeScript versus TSX language selection, explicit paths, ignore rules and symlink handling before timing; preserve output ranges and unmatched cases. Avoid rewrite options in the retrieval trial. [Analysis limits](https://ast-grep.github.io/advanced/faq.html), [search options](https://ast-grep.github.io/reference/cli/run.html).

## Protect user configuration

Every install and first invocation must run with child process home, XDG, agent configuration and caches isolated inside the experiment directory. Do not replace shell session home variables. Use disposable source copies and explicit paths. Avoid global agent installers and hook installers; connect the MCP commands directly through the controlled client. Record the resulting experiment directory writes.

For CodeGraph set `CODEGRAPH_TELEMETRY=0`, `CODEGRAPH_NO_UPDATE_CHECK=1` and `CODEGRAPH_NO_INSTALL_REFRESH=1`. Installation and upgrades can change agent configuration and instruction files; none is necessary for direct MCP use. Do not disable watching or daemon reuse as a substitute for process lifecycle tracking. [Telemetry](https://github.com/colbymchenry/codegraph/blob/6560052a6f856855d3f71eee838fd66ccfa4285d/TELEMETRY.md), [update checks](https://github.com/colbymchenry/codegraph/blob/6560052a6f856855d3f71eee838fd66ccfa4285d/src/upgrade/update-check.ts), [installer refresh guard](https://github.com/colbymchenry/codegraph/blob/6560052a6f856855d3f71eee838fd66ccfa4285d/src/upgrade/index.ts).

Before any Graphify command set `GRAPHIFY_NO_AUTO_REFRESH=1` and `GRAPHIFY_QUERY_LOG_DISABLE=1`. Release startup can refresh installed agent skills. Release query logging is opt in, despite stale README wording describing default logging; the explicit disable guard takes precedence. `GRAPHIFY_BACKEND=none` prevents provider autodetection and labeling fallback in the source code lane. [Startup guard](https://github.com/Graphify-Labs/graphify/blob/16218bfc80d4ca2799734d045039f7ed1a5fa9fb/graphify/__main__.py), [logging guard](https://github.com/Graphify-Labs/graphify/blob/16218bfc80d4ca2799734d045039f7ed1a5fa9fb/graphify/querylog.py).

## What the comparison can establish

| Question lane | Suitable comparison | Evidence needed |
| :--- | :--- | :--- |
| Locate syntax or summarize local exports | Native search plus ast-grep, CodeGraph, Graphify, Typelatch | Correct file and range, useful body or contract, explicit omissions |
| Trace consumers, references and graph paths | Native compiler services, Serena, CodeGraph, Graphify, Typelatch where supported | Verified endpoints and edge meaning, aliases, duplicate names, missed branches |
| Resolve installed API identity | Compiler resolution and package identity tools | Exact selected artifact, version, declaration and owning configuration; source graph matches alone are insufficient |
| Natural language intent | Each tool's supported query interface | Necessary evidence retained at equal output budgets, absent fact controls, full follow-up cost |
| Freshness | Persistent sessions and supported updates | Correct edited and removed source after reported completion, refresh latency and rebuild cost |

The qualified corpus is pnpm `v10.32.1` at `eaae772717d3d36903960af125a2a2ff9d34fe09`; its source discovery trial precedes dependency installation and actual bug fixing. Freeze independently reviewed questions before scoring. Include cross-package consumers, re-exports, same-name ambiguity, absent facts and repeated sessions. Count source reads needed after graph answers. Retain every timeout, parse failure, incomplete index and invalid adapter attempt.

Read-only retrieval success is a screening gate. Any subsequent product claim needs completed coding tasks with independent checks, identical task prompts and full input plus output token accounting, including local models, indexing, refresh and retries. Report cold and warm totals separately. Fewer grep calls or smaller responses do not establish lower overall time or tokens. No current result supports a universal superiority claim.
