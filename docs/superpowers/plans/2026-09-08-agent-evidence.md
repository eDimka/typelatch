# Agent evidence experience implementation plan

> **For agentic workers:** Use the independent assignments and verification gates below. Changes share this checkout and must remain scoped.

**Goal:** Ship an agent focused README and static GitHub Pages experience grounded in a real published package SQLite workflow.

**Architecture:** Capture authentic tool evidence separately from presentation. Generate the website's recorded excerpts at build time from the complete capture and fixture source. Enhance static HTML with small local scripts, never simulated execution.

**Tech Stack:** HTML, CSS, browser JavaScript, Node.js built in test runner, existing MCP SDK, locally hosted Archivo and IBM Plex Mono.

**Spec:** `docs/superpowers/specs/2026-09-08-agent-evidence-design.md`

## Global constraints

* Preserve `src/` and exact package identities.
* Use `typelatch@0.1.1` published on npm for showcase execution.
* Keep retrieval, resolution, compilation, execution, and unknown evidence distinct.
* No numbered section decoration, fake live execution, or benchmark claims without the recorded scope.
* No JavaScript required for essential content. Respect reduced motion.

## Recorded workflow

Owner: evidence worker. Files: `examples/sqlite/`, `scripts/showcase.mjs`, `docs/showcase/`.

* [x] Install published package into an isolated scratch directory and record registry metadata and CLI help.
* [x] Pin Kysely 0.28.8 and better-sqlite3 13.0.3 in a minimal SQLite fixture.
* [x] Test quoted names and rollback on UNIQUE failure. Demonstrate failure without the transaction before recording the corrected fixture.
* [x] Capture actual MCP requests and responses, source references, SQLite store audit, positive validation and negative control.
* [x] Document capture client, environment, normalization and reproduction. Preserve full payloads.

## Static website

Owner: coordinator. Files: `site/`, `scripts/site.mjs`, `scripts/site.test.mjs`, `.github/workflows/pages.yml`, package script entries.

* [x] Add Node contract tests asserting a complete static build with no unresolved placeholders, local evidence links, npm onboarding, accessible controls, and no private absolute paths. Run `node --test scripts/site.test.mjs` and observe the missing build fail.
* [x] Build static output under `_site/` with evidence snippets derived directly from `docs/showcase/recording.json` and actual fixture source. Escape all captured text inserted into HTML.
* [x] Use a plain wordmark, optimize original generated artwork into desktop and mobile WebP, retain font licenses, and create the README banner.
* [x] Implement hero, real task prompt, inspectable retrieval and execution views, and client setup. Native details retain full requests and responses. No essential JavaScript rendering.
* [x] Add purposeful button triggered evidence tracing with immediate reduced motion and static equivalents. Add copy controls with honest failure fallback.
* [x] Configure publication of only `_site/` through a dedicated Pages workflow after static and browser checks pass. Document setup and preview commands. Public deployment is a separate operation.
* [x] Run static tests and inspect browser renders at 1440, 768, 390 and 320 pixels. Verify keyboard, no JavaScript, reduced motion, copy failure, local links, and automated accessibility.

## README and usage

Owner: content designer. Files: `README.md`, `docs/USAGE.md`.

* [x] Lead with npm installation and Codex and Claude Code configuration, not source builds.
* [x] Show a concise real question, request, returned API, agent choice and execution result from the recording.
* [x] Keep detailed CLI fields, all six MCP tools, explicit command authorization, and evidence states in usage.
* [x] Link source, complete recording, repeatable fixture, Pages, npm, methodology and trust boundaries.

## Independent verification and completion

* [x] A reviewer who did not build the site checks visual composition, mobile layout and accessible interactions.
* [x] A separate reviewer compares all claims and snippets with raw evidence and source. Reexecute the fixture and check the published package onboarding.
* [x] Resolve concrete findings, then run `npm run release:check` and `npm run site:check`.
* [x] Check package contents and confirm application source remains unchanged.
* [x] Commit only scoped artifacts. Report deployment status honestly and provide the preview path.
