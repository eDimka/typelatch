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

A focused package impact prototype and a separate necessary cross package maintenance task are under investigation. No prototype performance or held out advantage is claimed here. Any qualifying category claim requires both cost savings and correctness against native tools and Serena on two distinct held out tasks with two repetitions. A broader comparative claim also requires a CodeGraph challenge.
