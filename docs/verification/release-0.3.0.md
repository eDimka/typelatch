# Typelatch 0.3.0 release candidate

Prepared on 6 October 2026 from the completed MCP setup, lockfile, saved scope, and search improvements. The isolated release checkout starts at GitHub commit `8447871` and preserves its website publication gate. Version 0.2.0 was a source milestone and was not published to npm.

## Included behavior

* Interactive MCP setup for Codex and Claude Code, with the exact npm version as the launcher target.
* npm, pnpm, Yarn, and Bun text lockfile discovery, ancestor ownership, mixed package managers, aliases, workspace selection, and a dry run plan.
* Saved monorepo subsets that apply to source search and direct dependency sync, with incremental additions and removals.
* Smaller indexes, reusable search workers, compact previews, and exact symbol identity.
* Updated README, usage guide, changelog, and website onboarding.

The active comparison chat's source context feature, lazy parser experiment, and second agent trial were excluded. Their original files remain in the shared development checkout. The published comparison documents retain their original frozen measurements. Fresh release reruns are retained with local release artifacts.

## Local verification

* Clean `npm ci`, with zero advisories in the root dependency audit.
* Static checks and 250 passing tests across 26 test files. One optional test requiring a prebuilt real corpus was skipped; the executable retrieval benchmark passed separately.
* Installed package checks cover CLI and MCP, all seven tools, both setup registrations through stub clients, mixed lockfile monorepo sync, and saved scope changes in a live MCP session.
* The package check verifies that the MCP handshake matches package metadata.
* Retrieval regression gate: 73 discovery hits from 73 questions and 70 strict matches, with the three documented exceptions retained.
* Workspace discovery regression: eight expected first results from eight authored questions.
* Support suite: all 24 tasks across 12 package versions, with negative controls.
* Agent walkthrough: the failing fixture was repaired, compilation and assertions passed, the assertions stayed unchanged, and the index refreshed. Artifact equivalence remains unknown.
* Storage, package storage, exact symbol usability, and repeated search session reruns passed their assertions.
* Website static tests and seven publication gate tests passed. The gate now recognizes direct npx commands.
* Chromium workflows and automated accessibility checks passed at 320, 390, 768, 1024, and 1440 pixels. Mobile hero and setup screenshots were visually reviewed.
* Eight accounting extractor tests passed. The separate coding grader requires a prepared candidate and was not used as a release test.

## Publication

npm and public website publication are pending. The saved npm credentials returned HTTP 401. The new website cannot deploy until its advertised exact version is available from npm. Local checks do not establish remote CI, registry publication, or a public deployment.
