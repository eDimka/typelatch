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

* [ ] Install published package into an isolated scratch directory and record registry metadata and CLI help.
* [ ] Pin Kysely 0.28.8 and better-sqlite3 13.0.3 in a minimal SQLite fixture.
* [ ] Test quoted names and rollback on UNIQUE failure. Demonstrate failure without the transaction before recording the corrected fixture.
* [ ] Capture actual MCP requests and responses, source references, SQLite store audit, positive validation and negative control.
* [ ] Document capture client, environment, normalization and reproduction. Preserve full payloads.

## Static website

Owner: coordinator. Files: `site/`, `scripts/site.mjs`, `scripts/site.test.mjs`, `.github/workflows/pages.yml`, package script entries.

* [ ] Add Node contract tests asserting a complete static build with no unresolved placeholders, local evidence links, npm onboarding, accessible controls, and no private absolute paths. Run `node --test scripts/site.test.mjs` and observe the missing build fail.
* [ ] Build static output under `_site/` with evidence snippets derived directly from `docs/showcase/recording.json` and actual fixture source. Escape all captured text inserted into HTML.
* [ ] Build the original latch mark, optimize generated artwork into desktop and mobile WebP, retain font licenses, and create the README banner.
* [ ] Implement hero, real task prompt, inspectable retrieval and execution views, and client setup. Native details retain full requests and responses. No essential JavaScript rendering.
* [ ] Add purposeful button triggered evidence tracing with immediate reduced motion and static equivalents. Add copy controls with honest failure fallback.
* [ ] Publish only `_site/` through a dedicated Pages workflow after the site checks pass. Document setup and preview commands.
* [ ] Run static tests and inspect browser renders at 1440, 768, 390 and 320 pixels. Verify keyboard, no JavaScript, reduced motion, copy failure, local links, and automated accessibility.

## README and usage

Owner: content designer. Files: `README.md`, `docs/USAGE.md`.

* [ ] Lead with npm installation and Codex and Claude Code configuration, not source builds.
* [ ] Show a concise real question, request, returned API, agent choice and execution result from the recording.
* [ ] Keep detailed CLI fields, all six MCP tools, explicit command authorization, and evidence states in usage.
* [ ] Link source, complete recording, repeatable fixture, Pages, npm, methodology and trust boundaries.

## Independent verification and completion

* [ ] A reviewer who did not build the site checks visual composition, mobile layout and accessible interactions.
* [ ] A separate reviewer compares all claims and snippets with raw evidence and source. Reexecute the fixture and check the published package onboarding.
* [ ] Resolve concrete findings, then run `npm run release:check` and `npm run site:check`.
* [ ] Check package contents and confirm application source remains unchanged.
* [ ] Commit only scoped artifacts. Report deployment status honestly and provide the preview path.
