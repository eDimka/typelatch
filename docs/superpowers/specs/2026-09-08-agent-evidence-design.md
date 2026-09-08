# Agent evidence experience design

## Goal

Make Typelatch useful to a reader configuring Codex or Claude Code, before asking them to read a benchmark methodology. Deliver a new README, npm first usage documentation, and a distinctive GitHub Pages site. Preserve the implementation.

## Direction

A precision latch holds source evidence in place. The palette is ink `#10100f`, ivory `#f2efe5`, orange `#ff5a1f`, graphite `#22221f`, and muted ivory `#aaa99f`. Archivo variable carries the large display and reading text. IBM Plex Mono identifies commands and evidence. Original generated industrial artwork supplies one sculptural focal point. A custom bracket mark and source path visualization make the metaphor specific to Typelatch.

The site is a continuous journey from a useful question to evidence, not a stack of feature cards. An expressive dark opening leads into an ivory task surface and an inspectable recorded workflow. Readers can move between API discovery and applying and checking the API. Setup is a concise workbench with Codex and Claude Code commands. Detailed methodology and limitations remain directly accessible through supporting links.

Rejected alternatives are a generic terminal hero with feature cards, which does not explain the task, and a research report as the homepage, which foregrounds limitations instead of usefulness. There are no numbered section labels, simulated live statuses, invented chat messages, performance claims, or hidden essential content.

## Authentic demonstration

Use the published `typelatch@0.1.1`, not checkout builds. Capture actual MCP calls through its published `typelatch-mcp` executable. Index `kysely@0.28.8` in an isolated local SQLite store and build a minimal SQLite batch import using Kysely and `better-sqlite3`. Show the original question, a real search refinement, exact declaration references, authored agent decisions, workspace context, and explicit validation. Keep retrieval, resolution, compilation, runtime assertions, and unknown artifact equivalence distinct. A negative control that omits the transaction must fail its rollback assertion.

The capture client is a scripted MCP client operated during this development session. It is not a recorded Codex or Claude Code conversation. The website is a static presentation of that recording, never a browser execution service. Preserve full captured payloads and document private path normalization. Record the unsuccessful separate declaration package indexing probe in supporting notes.

## Delivery boundaries

`site/` owns presentation and original assets. `scripts/site.mjs` builds the static artifact from templates and the recorded evidence into `_site/`. `examples/sqlite/` and `scripts/showcase.mjs` provide a repeatable fixture and capture. `docs/showcase/` owns provenance and complete payloads. README and usage documentation are separate reading experiences sharing those sources. A dedicated GitHub Pages workflow publishes the built static artifact. No application source modules change.

## Accessibility and verification

Essential content is visible without JavaScript. Native details controls expose full requests and responses. Interactive navigation uses buttons with state and keyboard support. Motion only explains the selected evidence path, lasts briefly, and is absent with reduced motion. No autoplay carousels, typing effects, or decorative continuous movement. Locally hosted fonts and optimized responsive artwork avoid third party runtime requests.

Run site contract tests, browser checks at mobile and desktop, keyboard and no JavaScript checks, reduced motion checks, broken local link and asset checks, automated accessibility checks, and independent visual and claim review. Run project release checks and preserve their concrete results. Commit only scoped deliverables. A configured workflow is not a claim that the public site has been deployed.
