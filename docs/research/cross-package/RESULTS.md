# Cross package development results

Stock Typelatch did not meet the savings gate. Across the two tasks, it used 31 percent more total tokens and 22 percent more charged time than native tools. These six sessions are development evidence with one repetition, not a general ranking or a reason to archive the project.

| Task | Condition | Total tokens | Charged seconds | Grep calls | Correctness evidence |
| :--- | :--- | ---: | ---: | ---: | :--- |
| Five package migration | Native | 277,662 | 62.94 | 6 | Passed native build and all runtime checks |
| Five package migration | Typelatch | 354,627 | 87.05 | 4 | Passed native build and all runtime checks |
| Five package migration | Serena | 265,241 | 69.99 | 4 | Passed native build and all runtime checks |
| Cross package impact | Native | 334,723 | 123.91 | 4 | Audit found an incorrect script citation |
| Cross package impact | Typelatch | 447,178 | 140.31 | 6 | Audit found no substantive error in reviewed facts and evidence |
| Cross package impact | Serena | 434,994 | 147.23 | 5 | Audit found an incorrect script citation |

The migration changes six production source modules in five pnpm packages. It preserves package discovery, metadata matching, executable discovery, patch contents and published archive behavior after moving from fast-glob to tinyglobby. The dependency upgrade is already installed in every arm; dependency resolution and installation are not part of the measured edit. Independent qualification rejects an import-only migration and a repair that leaves a package unfinished. Generated reference outputs were removed from the initial fixture before freezing, with their exact bytes retained separately.

The impact task proposes a stricter parser contract. It requires 14 direct source facts across ten production consumer packages, 37 conservative dependent packages, source quotations, exact identities and 29 existing validation targets. It distinguishes configured symbol users from package reachability. It is a proposed change, not an upstream bug reproduction.

The initial impact grader was wrong about the location of a package test script. It selected directories.test rather than scripts.test. It also rejected truthful additional exclusions and exact version-qualified dependency chains. Original machine grades remain unchanged in the records. A separate [correctness audit](development-001/results/correctness-audit.md) records the errors, source hashes and evidence checks. Do not use the original impact pass/fail ordering as a correctness ranking. This correction does not change token or time measurements or create a savings claim.

Both native TypeScript and Serena separately recovered the complete runtime consumer set after project activation. All conditions could use native compiler, language service, package tools and source reads. Every provider was used for a relevant first investigation; later choices were free. Independent workflow review passed all six sessions. The full impact reports were assembled using additional native analysis after provider retrieval.

Charged time includes provider preparation and agent wall time, including startup, indexing, failed calls, fallback and native validation. Common fixture preparation, independent grading and teardown are separate. Total tokens include cached input once and output once; this is not a billing estimate. Each arm received fresh provider state and identical source bytes. OS caches may have been warm. Sessions requested gpt-6.1-sol with medium reasoning through Codex CLI 0.166.0; no immutable served model snapshot is available.

The [protocol](development-001/protocol.json) and [freeze record](development-001/freeze.json) were published before model sessions in commit 6704d4a. The [export manifest](development-001/results/manifest.json) binds all completed action records, exact returned tool outputs, requested report artifacts, independent grades and audits. It excludes model reasoning and assistant message bodies. All attempts remain retained. No earlier study was replaced or pooled into these results.

## Focused impact prototype

A fresh development comparison used the corrected grader and a focused compiler evidence prototype. All three reports passed independent correctness and workflow review. The prototype used 21 percent fewer tokens and 35 percent less charged time than native tools, and 27 percent fewer tokens and 40 percent less time than Serena. This is one development case with one repetition. It is a lead for confirmation, not an established category advantage. The prototype is not the published npm package.

| Condition | Total tokens | Charged seconds | Grep calls | Correctness | Workflow review |
| :--- | ---: | ---: | ---: | :--- | :--- |
| Native | 510,021 | 153.23 | 5 | Passed | Passed |
| Impact prototype | 400,446 | 99.26 | 4 | Passed | Passed |
| Serena | 549,572 | 166.37 | 5 | Passed | Passed |

The prototype collected the same 14 direct facts, 37 conservative dependents and 29 validation targets. Its source scope is configured package src directories and explicit compiler import and export paths. It does not prove arbitrary value propagation or dynamic runtime impact. The model still made eight shell calls and assembled the answer manually. A failed oversized request remains included in its costs. See the [frozen protocol](impact-002/protocol.json), [recorded results](impact-002/results/report.json), [correctness audit](impact-002/results/correctness-audit.md) and [export manifest](impact-002/results/manifest.json).

## Dedicated report writer

A separate experiment required the same evidence engine to write a file and return a compact summary. All three answers and workflows passed review. The writer reduced total tokens by 22 percent against native, but charged time improved by only 0.55 percent. It fails the joint savings gate. Against Serena the reductions were 25 percent in tokens and 22 percent in time. These results remain separate from the earlier prototype trial.

| Condition | Total tokens | Charged seconds | Grep calls | Correctness | Workflow review |
| :--- | ---: | ---: | ---: | :--- | :--- |
| Native | 413,466 | 105.83 | 4 | Passed | Passed |
| Report writer prototype | 322,097 | 105.25 | 4 | Passed | Passed |
| Serena | 431,031 | 134.38 | 4 | Passed | Passed |

The writer made 12 shell calls. It printed almost the entire saved report, including 815 issues, then rebuilt dependency chains, checked source ownership and regenerated validation citations. The bounded tool response did not eliminate verification or answer assembly. Exact token and time contributions of individual steps are unavailable. See the [protocol](impact-003/protocol.json), [results](impact-003/results/report.json), [correctness audit](impact-003/results/correctness-audit.md) and [manifest](impact-003/results/manifest.json).

The earlier interface is [fixed for confirmation](confirmation-candidate.json). Its implementation, description and settings cannot be tuned using the two previously hidden tasks. This selection is a development decision; the variation between native runs is another reason confirmation is required.

## Cross package maintenance

A catalog consistency repair requires behavior changes in three pnpm packages and a shared interface change. All three submitted repairs passed the separate 23 check grader, including the upstream regression. However, each final public check failed because the agent environment could not open the local test registry. These attempts do not establish a complete workflow cost comparison. Their measurements remain available without a savings claim.

| Condition | Total tokens | Charged seconds | Grep calls | Independent repair checks | Final public check | Workflow review |
| :--- | ---: | ---: | ---: | :--- | :--- | :--- |
| Native | 186,472 | 76.90 | 3 | 23 of 23 | Registry unavailable | Passed policy review |
| Typelatch | 314,544 | 124.43 | 3 | 23 of 23 | Registry unavailable | Failed external temporary file policy |
| Serena | 622,715 | 129.83 | 6 | 23 of 23 | Registry unavailable | Investigation started before baseline completion |

The [validation audit](maintenance-001/results/native-validation-audit.md), [recorded results](maintenance-001/results/report.json) and [export manifest](maintenance-001/results/manifest.json) retain this failure and all costs. A fresh setup must pass the baseline and repaired public commands in the actual agent environment before another measured batch. The original attempts remain unchanged.

## Maintenance rerun

The revised public runner was first qualified inside the actual agent environment on both the broken and repaired fixture. It changes only public validation setup. The independent grader retains all 23 checks, including the upstream registry regression. Every measured repair passed all nine public cases and all 23 independent checks.

| Condition | Total tokens | Charged seconds | Grep calls | Independent repair checks | Final public check | Workflow review |
| :--- | ---: | ---: | ---: | :--- | :--- | :--- |
| Native | 216,199 | 78.88 | 5 | 23 of 23 | 9 of 9 | Passed |
| Typelatch | 285,160 | 112.78 | 3 | 23 of 23 | 9 of 9 | Investigation started before baseline completion |
| Serena | 226,626 | 72.65 | 3 | 23 of 23 | 9 of 9 | Passed |

Typelatch started its first source search before the baseline command completed. That violates the frozen workflow rule and prevents qualification. It also made an optional workspace validation call that timed out after 30 seconds, after its native command had already passed. All costs are retained. The repair is correct; this run does not establish a compliant workflow advantage. See the [protocol](maintenance-002/protocol.json), [results](maintenance-002/results/report.json), [correctness audit](maintenance-002/results/correctness-audit.md) and [manifest](maintenance-002/results/manifest.json).

Any qualifying category claim requires both cost savings and correctness against native tools and Serena on two distinct held out tasks with two repetitions. A broader comparative claim also requires a CodeGraph challenge.
