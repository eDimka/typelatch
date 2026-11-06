# Large TypeScript monorepo evaluation

Reviewed 6 November 2026. This plan tests whether Typelatch has a useful advantage on a real monorepo before spending more on coding trials. It does not claim an advantage from fewer searches, smaller tool responses or successful setup.

The earlier comparisons used a 45 file repository corpus or small authored coding tasks. Their recorded limitations remain in [Competitive evidence](../COMPETITIVE.md). They cannot answer the large monorepo question.

## Corpus and exact boundary

Use [pnpm v10.32.1](https://github.com/pnpm/pnpm/releases/tag/v10.32.1), commit `eaae772717d3d36903960af125a2a2ff9d34fe09`. This is an older stable TypeScript snapshot, deliberately separate from the newer Rust CLI transition. It is not described as current pnpm. Its [workspace configuration](https://github.com/pnpm/pnpm/blob/eaae772717d3d36903960af125a2a2ff9d34fe09/pnpm-workspace.yaml) contains catalogs and real npm aliases; its [shared compiler configuration](https://github.com/pnpm/pnpm/blob/eaae772717d3d36903960af125a2a2ff9d34fe09/__utils__/tsconfig/tsconfig.json) enables composite projects. Existing leaf configurations declare project references.

The downloaded source was verified against the exact commit. The source qualification records 198 workspace packages across 39 groups, 2,946 tracked files, 1,101 TypeScript files, 649 TypeScript files under source directories, 102 JavaScript files and 503 TypeScript configurations. Of those configurations, 282 contain project references. All ten catalog aliases have actual workspace consumers. These are measured counts in `artifacts/research/large-monorepo/corpus-qualification.json`, with a complete inventory alongside it.

The committed lockfile contains 168 package names with multiple locked versions. Grouping only by declared import name hides one useful distinction: production code imports `safe-execa@0.1.2` through the `execa` alias and `safe-execa@0.1.4` under its own name. Installed resolution with repository TypeScript 5.5.4 confirms the separate versions and the newer version's additional named type export. Different version numbers alone are not a behavior difference. The independent version review also records a real direct versus transitive cache constructor difference, without pretending both are direct workspace imports.

Dependencies were prepared in a separate full source copy with pnpm 10.32.0, the repository's package manager pin, and the original frozen lockfile. The selected leaf dependency closures and root toolchain cover 147 of 199 workspace projects. No lifecycle, build or test scripts ran. The initial attempt disabling the pnpmfile hook failed its committed checksum and is retained. The successful attempt enabled only the original reviewed metadata hook, which filters Linux optional reflink binaries. Store and configuration locations were isolated, and global virtual store use was disabled. Every committed source file stayed byte identical. Installation is preparation, not a timed provider result.

## Strong controls

| Control | Configuration and purpose |
| :--- | :--- |
| Targeted native search | Expert reviewed fixed string searches, file globs, owning project manifests and bounded source reads. Permit a single batched shell command. Avoid a broad dump of the whole repository. Record the installed ripgrep version and executable hash before timing. |
| Native TypeScript | The actual repository TypeScript 5.5.4 server, with configured projects and batched definition, hover, reference and update requests. The language service is designed for incremental, on demand queries; do not restart it for every warm request. |
| Serena | Version 2.1.0, commit `5e4f5cd173c7ff3eed37ee3f1de6c266b937c5dc`. Qualify both its supported tool and batching REPL interfaces on a scratch project, then freeze the correct configuration before corpus responses. |
| CodeGraph | npm 1.6.2, release commit `6560052a6f856855d3f71eee838fd66ccfa4285d`. Preserve its primary exploration tool, live source, call and impact support, watcher and daemon behavior. |
| Graphify | PyPI 0.9.103, release commit `16218bfc80d4ca2799734d045039f7ed1a5fa9fb`. Include local code graph queries, paths, affected relationships and supported refresh. Keep useful clustering enabled. Do not extend conclusions to its hosted service or model driven document extraction. |

Official latest release pages confirmed [Serena 2.1.0](https://github.com/oraios/serena/releases/tag/v2.1.0), [CodeGraph 1.6.2](https://github.com/colbymchenry/codegraph/releases/tag/v1.6.2) and [Graphify 0.9.103](https://github.com/Graphify-Labs/graphify/releases/tag/v0.9.103). Current npm and PyPI metadata, including distribution integrity, is retained in `current-tool-metadata.json`. Runtime dependency trees and binaries must also be frozen before a scored comparison; a release tag alone does not identify installed bytes.

Serena's [pinned configuration documentation](https://github.com/oraios/serena/blob/v2.1.0/docs/02-usage/050_configuration.md) supports a single REPL interface that can batch operations. It also describes the TypeScript project graph requirements for cross package references. The [TypeScript project reference documentation](https://www.typescriptlang.org/docs/handbook/project-references.html) explains why declarations or source redirects must be available. Missing builds must be exposed and repaired consistently before scoring reference completeness, rather than treated as a competitor failure. See the [language service design](https://github.com/microsoft/TypeScript/wiki/Using-the-Language-Service-API) and [ripgrep guide](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md) for the native controls. Provider installation and configuration details belong in [the competitor note](monorepo-competitor-configurations.md).

## Frozen read only funnel

The twelve public probes are in `artifacts/research/large-monorepo/probes-public.json`. Its SHA256 is `299a395497c825251b7017b5af4fe3b2fc578b3695a73919e10fb08b6187280b`. It was frozen before provider responses. Expected facts, complete set oracles and the mutation recipe remain outside provider corpora in `truth-private`. A private signature transcription correction and a clarification of the advancement gate were recorded before responses; the original and amended hashes are retained. No public question changed.

The probes cover semantic source discovery, source versus test compiler ownership, exact aliased installed APIs, a real transitive API difference, bounded scope, complete direct imports, declared dependency impact, an out of scope control, an absent symbol, an ambiguous symbol and one live source mutation. Grading requires the requested facts and current evidence. Mentioning the expected path alone never passes. Providers need not use Typelatch field names.

All providers receive the same question and legitimate file or project context. Native reads and fallback are available to every provider and count toward its total. Each probe allows eight retrieval actions, 64 KiB of cumulative returned text and 60 seconds. A batched native command is one call but all internal work and output remain counted. An unsupported capability is reported separately from an incorrect claim; unknown is never success.

Use identical full corpus copies with prepared dependencies. Preserve relative pnpm symlink text and verify that links resolve within each copy. Keep homes, indexes and caches outside the corpus. Rotate provider order over three sequential rounds. Separate cold process and empty index setup, first query, repeated queries in the same session and persistent cache reuse. Cold here does not mean the operating system file cache was flushed.

The freshness probe first records unchanged answers, then the coordinator changes one existing constant. Every provider gets a common 500 ms grace and may use its documented readiness or explicit refresh procedure. Charge all elapsed time from the completed source write to a usable current answer, including grace and refresh. Preserve immediate stale or pending output as well as the final response. Restore the exact original bytes after the provider exits. Do not create an advantage by racing a competitor's watcher debounce.

## Advancement and stopping

First reject false installed identities, unsupported type availability claims, out of scope successes and stale data represented as current. Require complete facts for the relevant capability. A source path, shorter output or fewer calls is insufficient.

Equivalent complete evidence with fewer required discovery and assembly steps, or lower bytes or charged time, may advance to a small actual agent check. Apply this opportunity equally to higher level competitors. A handwritten native script can make compiler lookup cheap while leaving the coding agent to discover and assemble that script. Backend time or byte dominance alone therefore cannot establish lack of agent value or justify final archival. Preserve every failed attempt and do not replace losing probes after seeing results. False identity, scope and freshness claims still block advancement until corrected.

A surviving workflow must then solve genuine maintenance tasks in the same monorepo, against the strongest qualified alternative, with identical native tests and independent final grading. Freeze those prompts and reference repairs separately. Measure all cloud input and output tokens, including cached input once, and all indexing, local model load, inference, refresh, native fallback and agent time. Smaller JSON is not a model token result. The earlier no-tool diagnostic did not show substantial initial catalog token overhead, so that explanation is not assumed.

The later decision gate must require material savings in both whole-task tokens and charged time without correctness loss, with all runs retained. Its numerical threshold and task schedule must be fixed before model sessions. The qualified date-fns repair remains a separate external replication, not a substitute for proving a monorepo maintenance workflow. One repository or one repair cannot justify universal superiority.
