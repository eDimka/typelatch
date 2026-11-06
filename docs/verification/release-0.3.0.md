# Typelatch 0.3.0 release candidate verification

This report records the candidate checked on 6 November 2026. It starts from the merged GitHub main commit `cc041fa` and includes the latest production source and regression tests from the development checkout. Version 0.2.0 remains an unpublished source milestone. This report records local verification; publication and hosted CI results must be verified separately.

## Included behavior

* Exact version MCP setup for Codex and Claude Code.
* npm, pnpm, Yarn and Bun text lockfile discovery, mixed package ownership and saved monorepo scopes.
* Compact discovery and bounded source context, with source hashes, import candidates and explicit omissions.
* Installed API evidence using the project compiler, callable signatures, normalized declaration headers and cursor coverage counts.
* Exact compound API lookup, corrected callable headers, package cache identity checks and explicit recovery commands.
* Lazy command and parser loading, reusable workers, smaller workspace caches and cleanup on database failures.
* Updated README, usage guide and website walkthroughs tied to recorded evidence.

Two onboarding failures were reproduced before correction. Archives with a named top directory, including DefinitelyTyped packages, now normalize one safe root into `package`. Mixed roots, traversal, links and extraction limits remain guarded. Sync now reports packages without TypeScript evidence as `unsupported` and continues preparing supported dependencies. Its JSON result separates successful execution from complete preparation. Download, integrity and other operational failures remain errors.

A separate compatibility regression was reproduced with the official TypeScript 4.7.4 compiler. Older compilers retain installed API type and signature resolution. Normalized headers return an explicit unsupported reason when the compiler lacks the required modifier and factory APIs. Two deterministic regression cases also cover missing modifier APIs and incompatible older factory arguments. This does not introduce a new minimum compiler version for workspace resolution.

## Completed local checks

The local environment was Node.js 22.23.1 on macOS arm64. Static checking passed. The final source test run passed 514 tests across 40 files; one optional test requiring a prebuilt real corpus was skipped. The executable retrieval benchmark was run separately.

* A clean root `npm ci` completed. The [root dependency audit](dependency-audit-2026-11-06.json) reports zero advisories, including development dependencies.
* All 19 release policy, workflow isolation and website publication policy tests passed.
* Packed installation checks passed after the onboarding and compiler compatibility fixes. They exercised CLI and MCP, all seven tools, source and compact discovery, setup registration through both stub clients, monorepo sync, saved scopes, compiler validation and a failing type control. They also checked the MCP package version. The reviewed npm payload contains 132 files and excludes tests, site assets, research artifacts, caches and credentials.
* A fresh full sync of the SQLite example completed successfully. It prepared both declared `@types` packages, Kysely and TypeScript. The native `better-sqlite3` package was explicitly unsupported because it carries no TypeScript source or declarations, so preparation remained `complete: false`.
* The [retrieval regression](../benchmarks/retrieval.json) returned an expected symbol for 73 of 73 authored questions and all expected symbols for 70. The three documented strict exceptions remain visible.
* The [workspace regression](../benchmarks/workspace-search.json) passed all eight authored questions. Expected file ranks, in report order, were `1, 1, 1, 1, 2, 1, 1, 4`. This is not an all first result claim.
* The [support suite](../benchmarks/support.json) passed 24 scenarios across 12 package versions, including the required negative controls.
* The [curated agent replay](../showcase/agent-workflow.json) passed. The baseline compiled but failed its rollback assertion; the edited fixture passed compilation, unchanged assertions and input stability. Search refreshed one file. Artifact equivalence remains unknown.
* An [actual Codex session](../showcase/codex-session.md) used four successful MCP calls, one implementation edit and one shell diff command. Source discovery preceded the failing assertion and exact installed API inspection. Both unchanged assertions passed after the edit and in a separate harness run. No recorded shell command contained `rg` or `grep`. The authored exercise, explicit tool preference and prepared dependency indexes are disclosed; no comparative saving is measured.

The historical support fixture deliberately retains its pinned minimatch 10.2.6 corpus. Its separate dependency tree reports two advisories, in minimatch and brace expansion. Those fixtures are not shipped in the npm package. The zero advisory result above applies to the root package and lockfile, not every historical example dependency tree.

Historical competitive reports retain their original measurements. They do not establish current superiority over other tools, model token savings or general coding success. The original published `recording.json` capture remains unchanged. The new agent capture is separate evidence. The refreshed site was inspected locally at desktop and mobile sizes, including step controls, clipboard feedback and overflow. Its hosted browser and accessibility suite must also pass on the release commit.

## Publication status

At this verification checkpoint, npm still serves 0.1.1 and the 0.3.0 tag has not been released. Owner authentication and trusted publishing configuration are being completed. Local artifacts must not be published directly.

The annotated tag workflow must build one preserved artifact, pass the Linux and macOS verification matrix, publish through npm trusted publishing, verify the fresh registry installation and integrity, publish the immutable GitHub release, and deploy the website for the verified stable version. Successful local tests do not establish any of those publication outcomes.
