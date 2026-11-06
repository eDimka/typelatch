# Real pnpm API migration fixture

This is a narrow, explicit dependency upgrade in the full pnpm v10.32.1 TypeScript corpus at `eaae772717d3d36903960af125a2a2ff9d34fe09`. It reproduces one real consumer change from [pnpm PR 10930](https://github.com/pnpm/pnpm/pull/10930), commit `3a5bfaa94fdf28db21cae8d6a86bd8d76ab70a84`, whose parent is `56b065dd47e71c79aa748c81d76369deef95a529`.

Only `@pnpm/config` receives the exact `can-write-to-dir@2.0.0` dependency. The lockfile adds the five exact package and snapshot entries from the upstream lockfile, preserving every unrelated importer and existing entry. The installed package has a renamed synchronous API. The reference applies the exact upstream import and call substitutions to the older, otherwise unchanged consumer. The untouched old dependency state is not presented as broken.

Preparation retains the complete corpus and its installed dependency closure. It uses a frozen pnpm install with lifecycle scripts disabled, an isolated store, the original metadata hook, and `cleanupUnusedCatalogs=false` so the original workspace configuration remains unchanged. The only prerequisite builds are the two already qualified maintenance fixture packages. A supplied native test command calls the real global executable directory validator through pinned `tsx@4.23.13`. This is subsystem validation, not a full pnpm CLI build or test claim.

Qualification attempt 004 is eligible. The baseline fails 1 of 3 public checks and 6 of 11 private checks. The upstream reference passes all 3 public and 11 private checks. An incorrect asynchronous replacement passes the public checks but fails 2 private checks. PATH membership, missing PATH, optional write checks, missing directories, read only directories, spaces and symlinks are covered. No coding agent has seen the private checks or reference.

All earlier preparation failures remain in separate directories:

* Attempt 001 detected unrelated peer context changes from ordinary dependency resolution.
* Attempt 002 detected the original catalog cleanup policy modifying workspace configuration.
* Attempt 003 passed installation guards but exposed a grader fixture error: the macOS `/var` alias was supplied instead of the canonical real path for a symlink PATH case. The original engine and results are retained. Attempt 004 supplies the canonical real path without changing product source or expected behavior.

The eligible baseline tree SHA256 is `ee4ac20446106435d226405e542fc416e56a75076a77009593d4f0573db64f15`. The qualification record includes exact dependency integrity, source hashes, reference mapping, native commands, results and harness hashes. The separately retained link audit found no external targets among 5,234 symlinks. Four preexisting dangling fixture links remain within the corpus.

The selected task replaces the date-fns task in the primary agent study before any coding model run. It addresses the requested large monorepo and installed API use case. Date-fns remains a separate qualified external replication. This choice does not establish any Typelatch advantage; every arm must solve the same repair under the frozen protocol.
