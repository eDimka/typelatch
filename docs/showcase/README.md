# Recorded SQLite run

[recording.json](recording.json) preserves an actual npm installation and MCP run. The client is `typelatch-showcase@1.0.0`, implemented with the MCP SDK `Client` over stdio. Jcode authored the question, implementation and rationale. This is not a transcript from Claude Desktop or Codex, and no agent conversation or performance improvement is simulated.

## Question

How can I import a batch of contacts into SQLite atomically, roll back every new row if a UNIQUE name constraint fails, and safely store a name containing a quote?

The first search returned `ControlledTransaction`, insertion and constraint APIs. A refinement to `TransactionBuilder execute` found the callback API. Exact symbol lookup returned `esm/kysely.TransactionBuilder` at `dist/esm/kysely.d.ts:623`. The recording retains both searches, including the first result set rather than replacing it with the better query.

The solution uses `db.transaction().execute(...)` and `transaction.insertInto('contact').values(contact).execute()`. It lets errors escape the callback. See [the implementation](../../examples/sqlite/batch.ts) and [assertions](../../examples/sqlite/batch.test.ts).

## Package identities

| Role | Exact package |
| :--- | :--- |
| Published CLI and MCP server | `typelatch@0.1.1` |
| Indexed API declarations and query builder | `kysely@0.28.8` |
| SQLite runtime | `better-sqlite3@13.0.3` |
| Separate runtime declarations in the workspace | `@types/better-sqlite3@9.6.0` |
| Workspace compiler | `typescript@6.0.3` |

Kysely bundles its declarations. The separate `@types` package is not indexed successfully and is not represented as the Kysely API artifact. The fixture lockfile retains exact package integrities. The recording also retains the published Typelatch install lock, registry metadata, environment versions and fixture SHA256 hashes.

## Reproduce

Requires Node.js 22.12 or newer, npm, registry access and a working native SQLite dependency. A C++ build toolchain may be needed when no prebuilt native binary is available. The recorded environment was macOS arm64 with Node.js 22.23.1. Consult `provenance.environment` for the actual capture details.

From the repository root:

```sh
npm ci
export JCODE_SCRATCH_DIR="${JCODE_SCRATCH_DIR:-$HOME/.cache/typelatch-showcase}"
node scripts/showcase.mjs
```

The script creates a fresh directory under `JCODE_SCRATCH_DIR`, installs **published `typelatch@0.1.1` from npm**, copies the pinned fixture and runs `npm ci` there. It uses the repository SDK dependency only for the MCP client, never the repository `dist` as the server. It sets an isolated `TYPELATCH_HOME`, indexes Kysely, starts the published MCP executable and runs the supplied commands. It does not alter a global installation or the default Typelatch data directory.

By default this writes `docs/showcase/recording.json`. To keep the checked in recording, give an alternate destination:

```sh
node scripts/showcase.mjs "$JCODE_SCRATCH_DIR/recording.json"
```

Scratch files remain for inspection. Downloads and native install scripts execute through npm. Workspace validation executes explicitly supplied commands with your permissions, not in a security sandbox. Only run this fixture after reviewing it.

To run the SQLite fixture directly:

```sh
npm ci --prefix examples/sqlite
npm run check --prefix examples/sqlite
npm test --prefix examples/sqlite
npm run test:negative --prefix examples/sqlite
```

The last command is deliberately expected to exit with status 1. The ordinary `npm test` script selects only the positive tests. No persistent application database is created. Each test uses an independent in memory SQLite database.

## Observed evidence

| Recording entry | Recorded result |
| :--- | :--- |
| `list-tools` | Six MCP tools listed |
| `initial-search`, `refined-search` | Real local library retrieval, with exact source references |
| `transaction-symbol`, `kysely-symbol` | Exact symbol requests and complete returned results |
| `workspace-context` | Import resolution and version match `pass`, artifact match `unknown` |
| `validate-positive` | Compilation `pass`, execution `pass`, input stability `pass` |
| `validate-negative` | Compilation `pass`, execution `fail`, input stability `pass` |
| `validate-invalid-types` | Invalid overlay diagnostic TS2322, compilation `fail`, execution `not-run` |

The two positive tests prove a valid batch commits, a quoted name and a SQL looking name round trip as data, and a UNIQUE violation rolls back an earlier insert from the same batch. The binding assertion inspects the compiled SQL placeholders and separate parameters. The negative control omits the transaction and fails because the earlier row remains committed. The invalid type control uses an unsaved overlay. Its returned explanation states that tests cannot validate unsaved overlays, so this control must not be described as saved runtime execution.

`storeAudit` opens `$TYPELATCH_HOME/brains/kysely/0.28.8/brain.db` read only using a separate SQLite client. Its schema, 1,500 symbol rows, 6,040 relationship rows, metadata and exact returned symbol location demonstrate a real local SQLite index. This audit is not an MCP tool, and the MCP interface does not offer arbitrary SQL execution. The indexed API store and the fixture's SQLite database serve different purposes.

## Recording format and limits

`commands` contains command arguments, working directories, full stdout, stderr and exit statuses. `mcp` contains stable entry IDs, exact requests and full SDK responses. `sourceExcerpts` contains separately labeled reads of the installed Kysely declaration file, including transaction documentation and the callback signature. `authored` contains Jcode's question and rationale, not captured tool output. `assertions` summarizes the capture harness gates and does not replace raw evidence.

Only private absolute path prefixes are normalized. Tokens are documented in `provenance.pathTokens`: `$WORKSPACE`, `$TYPELATCH_HOME`, `$PUBLISHED_INSTALL`, `$RUN_ROOT`, `$SCRATCH`, `$REPOSITORY`, `$NODE` and `$USER_HOME`. They are explanatory placeholders, not portable executable paths. IDs, hashes, durations, source lines, failures and unknown states remain as returned. Captures are not expected to be byte identical because timestamps, UUIDs, durations, snapshots and environment hashes vary.

The provisional declaration package request `@types/better-sqlite3@9.6.13` returned npm E404. The available exact version `9.6.0` then failed Typelatch indexing with `Unsafe package archive path: better-sqlite3/`. Both attempts are preserved under `commands` as capture notes. No archive workaround, production patch or source build was used to hide that limit.

This is one authored development example, not an unseen task benchmark. Retrieval did not independently invent the solution. Artifact equivalence remains unknown in workspace context. Passing tests establish only the supplied assertions and the recorded input scope, not general SQL safety, concurrency behavior, filesystem durability or performance gains.
