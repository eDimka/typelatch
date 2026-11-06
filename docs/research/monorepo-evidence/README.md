# Monorepo retrieval research evidence

This bundle records development diagnostics from 6 November 2026. It does not establish a coding speed or token advantage for Typelatch. The separate availability study completed all 16 coding sessions correctly with zero MCP calls, so it did not exercise any connected retrieval provider. Its public run export is maintained separately by the study coordinator.

## Corrected tool screen

The corpus is pnpm v10.32.1, commit `eaae772717d3d36903960af125a2a2ff9d34fe09`: 198 workspace packages, 39 families, 649 TypeScript files under source directories, and 503 TypeScript configurations. Only the selected dependency closures were installed. The actual project compiler was TypeScript 5.5.4. This is an older pinned corpus, not current pnpm main.

Round 1 used 12 fixed questions and 35 semantic facts. Each probe allowed eight retrieval actions, 64 KiB cumulative returned text and 60 seconds. Common native reads, compiler resolution and manifest inspection were permitted and charged. Every fact citation identifies the original capture hash and JSON pointer. These are collector results, not autonomous coding results or general provider rankings.

| Condition | Raw supported facts | Budget qualified facts | Complete qualified probes |
| :--- | ---: | ---: | ---: |
| Native search and reads | 29/35 | 29/35 | 10/12 |
| Direct TypeScript service | 31/35 | 31/35 | 11/12 |
| Typelatch candidate | 33/35 | 29/35 | 9/12 |
| Serena | 31/35 | 31/35 | 11/12 |
| CodeGraph | 24/35 | 24/35 | 8/12 |
| Graphify | 27/35 | 27/35 | 9/12 |

Typelatch returned the complete discovery implementation, but its import and freshness answers exceeded the byte allowance. Its older dependency export query returned null without complete negative evidence. The native collector missed part of discovery and the concurrency cap; the TypeScript collector missed discovery. Those are specific collector choices, not proof that either underlying tool cannot retrieve the source. Many config and dependency facts came from shared native helpers. The ledgers distinguish those facts from provider output.

Serena was selected as the connected coding control from the completed competitor screen. Direct TypeScript tied its supported fact count. CodeGraph and Graphify were not compared in the subsequent coding trial. CodeGraph clipping and fixed declaration windows explain several misses; this screen does not justify a claim of universal inferiority.

The earlier screen003 is ineligible for comparative performance. Parent Git ignore rules hid Typelatch source, a TypeScript whole file response exceeded the budget, and competitor refresh readiness failed. Its failure receipt, diagnostic ledger and cited core captures remain under `screen003`. No metrics are substituted into screen004.

## Packet and local model experiments

The first 8 KiB packet found the correct module but omitted the needed implementation lines: zero of four public discovery facts. A separate generic projection that includes a complete small module or enclosing declaration returned all four facts in 7,895 structured response bytes. This was the same public development question after inspection, not an unseen task or a measured model token saving. Both versions and their receipts are retained. The packet is experimental source only, separate from the published package interface.

Local ranking used two authored candidate pools, six positive labels and five absent fact controls, with two repetitions and top two selection. MLX Qwen3 Reranker 0.6B 4 bit found all six positive labels in both repetitions, with MRR 0.833. Ollama qwen3:1.7b found four, with MRR 0.583. Input order found four, with MRR 0.500. Neither model recognized any of the five absent facts. MLX had no calibrated abstention threshold; Ollama was permitted an empty selection but chose candidates. All five candidates already fit the larger packet budget, so reordering alone cannot add missing semantics. Inputs were explicitly truncated, and labels refer to complete candidate text.

Measured process time was 9.818 and 8.242 seconds for MLX, and 16.261 and 15.775 seconds for Ollama across eleven cases each. The receipts retain local input and output tokens, loading and residency. These are additional local costs, not cloud token savings. No coding outcome was tested in this ranking screen.

## What can be verified here

Run from a checkout containing this bundle:

```sh
node docs/research/monorepo-evidence/verify.mjs
```

The verifier requires only Node built ins. It checks every export hash, expands the compressed tool captures, checks all screen004 citation quotations at their exact JSON pointers, recalculates fact totals, and recalculates ranking hit rates. It does not independently prove manual semantic labels. The ledger keeps supported, absent, unknown and contradicted states distinct.

`manifest.json` records original and exported hashes. Absolute checkout, home and temporary root prefixes are replaced by declared placeholders. Recorded semantic content, timing and counts are retained. Ranking exports omit raw generated selection text and retain selected IDs and measured fields. No coding model reasoning or assistant messages are included. Sources, grader checks, dependency locks and copyright notices are included. Original qualification README files describe their historical state before coding sessions; that prose is preserved as a receipt.

## What requires a new run

This is not a portable image of the observed machine. Full installed dependency trees, Python environment, OS libraries, model weights, caches and complete per file fixture inventories are not bundled. Compact inventory receipts are not a way to reconstruct omitted files. Runtime manifests identify the observed boundaries, including explicit Python cache exclusions in the historical supplemental manifest; they do not hash every operating system dependency. The exact 194,704 byte Typelatch candidate archive is included. Its archive hash is authoritative; its sourceCommit field identifies the checkout base and is not a guarantee that rebuilding that commit reproduces the archive.

For a new run, use a fresh checkout and restore the supplemental `source/` overlay at its original repository relative paths. Install the root lock with Node 22.23.1, and the pinned pnpm tool lock. Fetch pnpm commit `eaae772717d3d36903960af125a2a2ff9d34fe09` into `artifacts/research/large-monorepo/pnpm-source`; copy it to `pnpm-installed` preserving symlink text. The supplied `qualify-corpus.mjs`, `prepare-dependencies.mjs 002 --allow-committed-metadata-hook` and `qualify-installed.mjs` reproduce the staged checks. The committed metadata hook is required by the frozen lock; lifecycle scripts remain disabled.

Then run maintenance `qualify.mjs --prepare` with a fresh `truth-private/maintenance-research/qualification-002` output. Restore the included upstream lock to `truth-private/api-migration-research/upstream-lock.yaml` before API qualification. Run API `qualify.mjs --prepare` with a fresh `qualification-004` output. The API script deliberately depends on the qualified maintenance baseline path. Both must reproduce a failing baseline, passing reference and failing incorrect control before a new model study. Baseline public checks have three cases each; independent graders have fifteen and eleven cases. Earlier ineligible qualification attempts are retained here. These source commands were exercised on the recorded host, not verified as a one command installation on another machine.

New absolute paths, native packages or tool versions can change tree hashes. Freeze a new spec and protocol rather than editing or pretending to resume the recorded study. Use the tracked agent trial and provider adapters with newly qualified runtime paths. A new served model response, prompt cache, operating system cache and elapsed time cannot be reproduced byte for byte. No immutable served model snapshot or sampling seed is available. Two adapted public repairs in one repository, with two repetitions per condition, support only that bounded experiment. They may also occur in model training data. Date fns remains outside this bundle as a separate reserved replication.

## Sources and licenses

The pinned corpus and copied source excerpts retain the [pnpm MIT notice](licenses/pnpm-LICENSE). Task provenance is in the [maintenance qualification](qualification/maintenance-README.md) and [API qualification](qualification/api-migration-README.md). The [exact upstream API lock receipt](locks/api-upstream-lock-provenance.json) identifies its source commit and SHA256. Serena 2.1.0 is pinned to `5e4f5cd173c7ff3eed37ee3f1de6c266b937c5dc`; its source and lock metadata retain [GPL and MIT notices](licenses/serena/LICENSE). The Typelatch archive and authored harness retain the [project MIT notice](licenses/typelatch-LICENSE). Other dependency code and model weights are fetched separately under their own licenses and are not redistributed here.
