# Paired agent tasks

These are authored repair exercises, not production incidents or unseen benchmark tasks. They were selected before the paired model runs. Both conditions receive identical starting source, task text, public checks, dependency versions and editable paths.

The SQLite task repeats the contact import bug shown in the public Typelatch demonstration. Its maintained fixture uses Kysely 0.28.19. The broken baseline removes the transaction around the batch. Its two public assertions preserve quoted names and reproduce partial writes. Eight separate evaluation assertions cover successful writes, duplicates inside and outside the batch, primary key failures, empty batches, immutable inputs and use after rollback.

The two Parcel Desk tasks reuse the existing authored maintenance fixture. It contains 57 production TypeScript source files totaling 62,512 bytes. One task repairs quote behavior across repeated calls, repeated product rows and region pricing. The other repairs runtime validation and normalization with the production Effect package. The production dependency is Effect 3.22.1; a separate experimental workspace retains Effect 4.0.0 rc.112 to preserve the exact version selection problem.

Each Parcel Desk workspace contains sixteen existing public regression tests and one task specific failing reproducer. The evaluator additionally checks the exported TypeScript contract and sixteen semantic assertions for that task. The unrelated task defects remain outside that task's grade, while the common public regressions must still pass.

## Evaluation boundary

`prepareTask` copies only the selected workspace fixture and public reproducer, then performs an ordinary locked installation. Every agent workspace owns its dependency files. The sibling `grader` directory, reference repairs and all evaluation assertions are excluded from agent workspaces.

After the agent exits, `gradeTask` copies candidate implementation source into a fresh evaluation directory. Tests, compiler options, package metadata and dependencies come from the trusted fixture, never from the candidate. The evaluator hashes protected files, including every installed dependency file and symlink target. Only the declared implementation paths may differ. Generated root `dist`, `.git` and `.typelatch` data are excluded from that inventory; generated output is never accepted as candidate source.

The evaluator's dependency link exists only inside its temporary evaluation directory after the agent session. The agent workspaces do not share mutable dependency links. Filesystem endpoint hashes do not establish the absence of all transient activity or external reads; the run harness is responsible for its access boundary and reporting that limitation.

The fixture tests demonstrate that every baseline fails its intended reproducer, each reference repair passes independent checks, and protected file changes invalidate an otherwise correct result. A baseline passes compilation before the model run. Both dependency trees passed `npm audit` with zero reported advisories on 6 November 2026.
