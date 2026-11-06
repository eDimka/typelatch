# Codex fixes a partial contact import

This is an actual Codex CLI session captured on 6 November 2026. The agent received an authored broken exercise and a prompt to use Typelatch. It chose the requests and implementation edit. The [public record](codex-session.json) contains its completed tool actions, before and after source, fixture hashes, dependency preparation and independent test output.

The retained session used `kysely@0.28.8` before the runnable example was updated to `kysely@0.28.19`. Its original evidence and animation remain unchanged. The current example and future captures use the maintained dependency version.

The website and GIF are visual summaries of this session. Setup is shown as instructions. Playback timing and typing are edited for readability.

## What happened

The task was to stop a failed contact import from leaving partial data, while preserving parameter binding. The prompt supplied no implementation filename, package name or solution. It explicitly requested Typelatch source discovery, exact API inspection, and validation before and after editing.

| Action | Recorded evidence |
| :--- | :--- |
| `workspace_search` | Question: `contact import duplicate name batch rollback transaction`. Source mode returned the complete implementation, test file and package configuration. |
| `workspace_validate` | Compilation passed. Parameter binding passed. The existing whole batch rollback assertion failed. |
| `workspace_context` | The project compiler resolved `Kysely.prototype.transaction` from `kysely@0.28.8`. Version match passed. The response included its callable signature and documentation describing callback rollback. |
| Normal file edit | Codex changed the insert loop to use a transaction callback. |
| `workspace_validate` | Compilation, both unchanged assertions and recorded input stability passed. |
| Shell command | `git diff -- batch.ts`. |

The exact compiler signature returned for the selected method was:

```ts
(): TransactionBuilder<any>
```

The substantive agent edit was:

```ts
await db.transaction().execute(async trx => {
  for (const contact of contacts) {
    await trx.insertInto('contact').values(contact).execute()
  }
})
```

All four MCP calls completed successfully. The only recorded shell command was the diff inspection. No recorded shell command string contained `rg` or `grep`. Preparation and the harness's independent test runs are separate from those agent counts. This is one prompted session, without a comparative baseline or a measured token saving.

## What was checked

The capture independently ran the original tests before dispatch and confirmed the expected rollback failure. It then required a successful source search, exact API evidence, a failing MCP baseline before the edit, and successful MCP validation after the edit. Validation snapshots bind the checks to the recorded before and after source hashes.

Only `batch.ts` differs between the fixture manifests. Tests, package files and compiler configuration remain unchanged. A separate final `npm test` run passed both assertions. The recorded Typelatch build stayed unchanged during capture, with its full file manifest and hash retained in the record.

The session used Codex CLI 0.166.0, Node.js 22.23.1 and the Typelatch 0.3.0 development build. It was not a registry installation. Dependency indexes were prepared before the agent started. Preparation reported `better-sqlite3` as unsupported because it contains no usable TypeScript source or declarations, while its separate types package was indexed.

Coverage remains explicit: the first search reported three missing dependency indexes. Installed artifact equivalence remained unknown. The selected method's normalized declaration header was unsupported; its compiler signature, declaration location and documentation were still returned. Passing this fixture does not establish behavior in other projects.

## Run a fresh session

With an authenticated Codex CLI and the source checkout:

```sh
npm ci
npm run build
node scripts/capture-demo.mjs
```

This creates an isolated broken copy of the SQLite fixture, installs its pinned dependencies, prepares API indexes, and launches a new Codex session. It writes `docs/showcase/codex-session.json` only after the evidence checks pass. A fresh run uses the current fixture lockfile and can choose different queries, tools or code. The current harness derives the expected dependency identity from the installed package and lockfile. It has evolved since this retained capture; the historical harness hash still identifies the code used for that original run.

The [capture harness](../../scripts/capture-demo.mjs) saves genuine prelaunch metadata and raw events under ignored `artifacts/demo` directories. Public export excludes private model analysis and native session identifiers, and normalizes personal paths. The [evidence checks](../../scripts/demo-evidence.test.mjs) cover denied tools, missing APIs, wrong validation commands, source identity, ordering, changed configuration and added files.

This retained session is a successful demonstration after setup and recorder corrections, not a success rate study. The fixture inventory excludes dependency files, Git internals and Typelatch caches. Endpoint hashes and completed action records do not prove absence of every transient or external operation. Exact served model identity and full process lifecycle are not established by the export.

To try the task in your own client, use the [isolated exercise and prompt](agent-workflow.md#give-this-to-your-agent). That page also retains a separate curated MCP replay. The [original package recording](README.md) remains a historical SDK capture of published Typelatch 0.1.1.
