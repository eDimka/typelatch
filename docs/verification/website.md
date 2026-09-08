# Website verification

Recorded on September 8, 2026 in the Typelatch checkout. This is delivery verification, not a coding benchmark or a claim of measured token savings.

See the [requirement acceptance map](requirements.md) for direct client and GitHub interface checks, concrete interaction improvements, and the public deployment constraint. [Client output](client-onboarding.json) preserves actual npm, Typelatch, Codex and Claude Code commands. [GitHub results](github-rendering.json) preserve renderer checks and the public URL response.

## Executed checks

| Check | Observed result |
| :--- | :--- |
| `npm run site:check` | All five static contract tests passed. They cover the README's direct npm link and exact question and requests, complete output, exact recording preservation, local and repository links, social image existence, refused incomplete recordings, changed fixture hashes, and static motion alternatives. |
| `node scripts/site-browsercheck.mjs` | Passed using Chromium 149.0.7827.55. Both evidence views and expanded disclosures fit at widths 320, 390, 768, 1024, and 1440 pixels. |
| Automated accessibility | No axe violations for the selected WCAG A and AA rules at 390 and 1440 pixels in either view. This is not a complete accessibility audit. |
| Interaction checks | Keyboard navigation, skip link, native disclosures, direct assertion links, clipboard success and denied access fallback passed. |
| Alternative presentation | Both workflows remained available without JavaScript and in print. Reduced motion disabled animation and smooth scrolling. |
| Resource and identity checks | Correct Typelatch identity, no page exceptions, no failed local requests, exact returned declaration, immediate npm command, and no corner brand icon. |
| Final `npm run release:check` | Passed with 84 tests passing and one skipped, followed by clean packed installation, CLI retrieval, bundled benchmark, six MCP tools, validation and negative control. |
| Scope | No changes to application source, existing tests, or the application dependency lockfile relative to the task baseline. |

The first coordinator release check timed out in the unchanged `passes a real runtime assertion and links evidence to a query` test at its default five second limit. The same test passed in isolation. A subsequent complete release check passed with no source, test, timeout, or dependency changes. The timeout remains recorded here rather than being omitted from the verification history. Its underlying environmental cause was not established.

A final request audit found that the README had no direct npm link and paraphrased the question without showing the actual search request. A new contract failed before those omissions were corrected, then passed against the frozen recording. The package installation check was repeated successfully. Copy describes less searching and fewer irrelevant tokens as the design goal, with no claim of measured savings.

## Independent review

An independent evidence reviewer reexecuted fixture compilation and both positive assertions, confirmed that the transaction omission control failed, checked fixture hashes, queried the preserved published MCP executable, and compared the local SQLite audit rows. Published package identity and registry integrity matched the recording. The reviewer also checked the new visible outcome summary and per assertion source and output against the frozen evidence.

That review found a missing social banner and a stale usage heading link. Both were fixed and covered by regression tests. Independent visual review found joined responsive text, undersized evidence code, and runtime outcomes hidden behind navigation. Literal whitespace, readable code, and direct links to always visible outcome summaries addressed those findings.

The independent visual reviewer signed off this iteration after inspecting both views at desktop and mobile sizes. The visual direction uses original product artwork, a plain wordmark, and a real question rather than decorative statistics. Source provenance is in [the asset notes](../../site/ASSETS.md). The [showcase notes](../showcase/README.md) distinguish authored interpretation from actual tool output and preserve unknown artifact equivalence.

## Reproduction and publication

See [website instructions](../WEBSITE.md) for the static build and isolated browser tooling. The browser suite writes fresh screenshots, complete axe results, and a report to the configured QA directory. Normal verification does not modify the committed banner or frozen recording.

The Pages workflow is configured to run static and browser checks before deployment. Local execution does not verify GitHub Actions or a public deployment. At completion of this work, no commit had been pushed and no public deployment was claimed. GitHub Pages must be enabled with GitHub Actions as its source before publishing.
