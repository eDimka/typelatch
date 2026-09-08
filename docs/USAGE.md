# Usage

Typelatch has two paths: read APIs from an exact package index, then check their use in a local TypeScript workspace. The CLI and MCP server share the same implementation.

## Install and connect

Requires Node.js 22.12 or newer and npm. The SQLite dependency uses a native binary. If your platform has no suitable binary, installation requires a working C++ build toolchain.

```sh
npm install --global typelatch@0.1.1
typelatch --help
typelatch add kysely@0.28.8
```

`add` downloads an npm artifact, verifies its registry integrity, and indexes its TypeScript APIs without running package lifecycle scripts. It does not add a dependency to your workspace. Search uses that local index after preparation, including when offline.

**Codex**

```sh
codex mcp add typelatch -- typelatch-mcp
```

The corresponding entry in `~/.codex/config.toml` is:

```toml
[mcp_servers.typelatch]
command = "typelatch-mcp"
```

**Claude Code**

```sh
claude mcp add --transport stdio --scope user typelatch -- typelatch-mcp
```

For a client that accepts an MCP JSON configuration:

```json
{
  "mcpServers": {
    "typelatch": {
      "command": "typelatch-mcp"
    }
  }
}
```

Start a new client session after registration. The server exposes the [six tools](#mcp-tool-reference) over standard input and output. If the client cannot find `typelatch-mcp`, check the executable path in the environment that launches the client or configure its absolute path.

<details>
<summary>Use npm without a global installation</summary>

Prepare the same local index:

```sh
npx --yes --package=typelatch@0.1.1 typelatch add kysely@0.28.8
```

Register either client with npm as the launcher:

```sh
codex mcp add typelatch -- npx --yes --package=typelatch@0.1.1 typelatch-mcp
claude mcp add --transport stdio --scope user typelatch -- npx --yes --package=typelatch@0.1.1 typelatch-mcp
```

The package name is `typelatch`. Its server executable is `typelatch-mcp`. Do not use `npx typelatch-mcp`, which asks npm for a different package. The npm launcher may need network access before it can start the server. Use the same `TYPELATCH_HOME` for index preparation and the server if you override the default.

</details>

## Try the SQLite task

The [SQLite fixture](../examples/sqlite) imports a batch of contacts through Kysely and `better-sqlite3`. A duplicate name must reject the batch and leave no partial inserts. It uses an in memory database, not your application's data or Typelatch's index.

From a trusted source checkout, install the fixture's pinned dependencies and prepare its API index:

```sh
npm ci --prefix examples/sqlite
typelatch add kysely@0.28.8
```

Open Codex or Claude Code at the repository root with Typelatch connected. This prompt gives the agent a concrete question and a narrow execution authorization:

```text
In examples/sqlite, use Typelatch to answer this question:
How can I import a batch of contacts into SQLite atomically, roll back
every new row if a UNIQUE name constraint fails, and safely store a
name containing a quote?

Search the local kysely@0.28.8 index with library_search. If the first
results do not explain the callback transaction, refine the question
to "TransactionBuilder execute". Inspect the returned transaction API
with library_symbol. Cite the exact
package version, symbol, and source location. Read batch.ts and
batch.test.ts. Explain whether importContacts meets the requirement.
If a change is needed, edit only examples/sqlite/batch.ts and preserve
the assertions.

Use workspace_context with absolute config and file paths to resolve
the API in this fixture. Then use workspace_validate with the absolute
path to examples/sqlite/tsconfig.json and exactly this testCommand:
["npm", "test"]

I authorize that assertion command only inside examples/sqlite.
You may inspect fixture files, but do not run other test or application
commands, install packages, or access external databases.
Report retrieval, resolution, compilation, and assertion execution
separately. Keep unknown and not-run evidence visible.
```

The fixture already contains an implementation, so this prompt reviews and validates it rather than claiming to be an unseen coding benchmark. The [recording](showcase/recording.json) preserves actual MCP requests and results from an SDK client talking to published `typelatch@0.1.1` over stdio. The question and implementation were authored by Jcode. It is not a recording of Codex or Claude Code. [Capture provenance and reproduction](showcase/README.md) describe the run.

A client can use its normal file tools for edits. Typelatch does not edit source files.

## Library discovery

An explicit version makes an index request reproducible. Without one, `add` first checks the current npm lockfile and otherwise resolves through npm. Search without a version uses the newest installed index, not necessarily the workspace version.

```sh
typelatch add kysely@0.28.8
typelatch query kysely@0.28.8 "TransactionBuilder execute" --json --limit 5
typelatch sync
```

`sync` indexes direct locked dependencies. Supply package names to restrict it, for example `typelatch sync kysely`. Packages need TypeScript declarations or usable TypeScript sources. Indexing a JavaScript package does not automatically fetch its separate `@types` package.

The equivalent `library_search` request is:

```json
{
  "package": "kysely",
  "version": "0.28.8",
  "question": "TransactionBuilder execute",
  "limit": 5
}
```

This is the refined search from the recording. The initial question about atomic imports returned related constraint and insertion APIs, so the capture retains both searches rather than presenting the refined result as the first attempt.

For this result, the exact `library_symbol` request is:

```json
{
  "package": "kysely",
  "version": "0.28.8",
  "symbol": "esm/kysely.TransactionBuilder"
}
```

The CLI equivalent is:

```sh
typelatch symbol kysely@0.28.8 esm/kysely.TransactionBuilder --json
```

For other packages, use the exact returned `symbol` with the same `package` and `version`. Responses retain package identity, source locations, signatures, documentation, relationships, and retrieval signals. Finding a candidate does not establish that it resolves or compiles in your project.

## Workspace context

Save this request as `context.json`, replacing the paths with your absolute fixture paths:

```json
{
  "config": "/path/to/typelatch/examples/sqlite/tsconfig.json",
  "file": "/path/to/typelatch/examples/sqlite/batch.ts",
  "importSpecifier": "kysely",
  "symbol": "Kysely",
  "expectedVersion": "0.28.8"
}
```

Pass those fields to `workspace_context`, or use the CLI:

```sh
typelatch workspace context.json
```

Context uses the project's installed TypeScript language service. It returns definitions, types, and resolved dependency identity. Add `question` to request optional discovery from the matching local index. It does not compile the project or run tests.

`position` is a UTF16 offset starting at zero. Use it to inspect an actual expression in the file. `overlays` accepts unsaved `{ "file": "...", "text": "..." }` entries. Absolute paths avoid ambiguity when a client starts outside the project.

`expectedVersion` checks the package containing the resolved declaration. When declarations come from a separate `@types` package, that identity can differ from the runtime package. A matching version is not proof that installed files equal the registry artifact.

## Validation

Save this request as `validation.json`, replacing the config path:

```json
{
  "config": "/path/to/typelatch/examples/sqlite/tsconfig.json",
  "workspaceRoot": "/path/to/typelatch/examples/sqlite",
  "testCommand": ["npm", "test"],
  "timeoutMs": 60000,
  "record": true
}
```

Pass those fields to `workspace_validate`, or use the CLI:

```sh
typelatch validate validation.json
```

The assertion command runs from the directory containing the config. Use a leaf `tsconfig.json` and an explicitly authorized argument array, not a shell command string. Compilation must pass before the command runs. The project compiler and test command are trusted local code with your permissions. Time and output limits are not a sandbox.

Add `queryId` from a prior search to associate validation with that query. Omitting `testCommand` requests compilation only. Unsaved overlays can be checked but cannot receive runtime test evidence. Save the actual code before requesting execution.

### Read the evidence

| Result | What it establishes |
| :--- | :--- |
| Retrieved API | A candidate was found in the indexed package |
| Resolved API | The installed compiler found a workspace declaration |
| `checks.typechecked` | The compiler's result for the recorded project inputs |
| `checks.tested` | The result of the explicitly supplied assertion command |
| `checks.stable` | Whether the recorded input scope stayed unchanged across validation |

Results keep `pass`, `fail`, `unknown`, and `not-run` distinct. A command returning zero establishes only the assertions it actually ran. `artifactMatch` remains `unknown` when installed contents have not been compared with the registry artifact.

Validation's overall `success` is true only when compilation, assertion execution, and input stability all pass. A compilation only request can therefore have `checks.typechecked.status` equal to `pass`, `checks.tested.status` equal to `not-run`, and `success` equal to `false`. Read the individual checks rather than interpreting that as a compiler failure. The CLI uses status 2 when required checks fail and status 1 for command errors.

Validation records compiler inputs and, when execution is requested, the runtime file scope before and after the command. `runtimeInputs` extends that scope. `snapshotExclude` excludes known generated outputs. `workspaceRoot` bounds snapshot collection. Excluded files, remote services, and environmental state are outside the recorded evidence boundary.

## MCP tool reference

| Tool | Request | Result |
| :--- | :--- | :--- |
| `library_search` | `package`, `question`; optional `version`, `limit` from 1 to 20 | Search results from an installed index |
| `library_symbol` | `package`, `symbol`; optional `version` | Exact symbol lookup and relationships |
| `workspace_context` | `config`, `file`; optional `importSpecifier`, `symbol`, `position`, `question`, `expectedVersion`, `overlays`, `limit`, `timeoutMs` | Workspace definitions, types, identity, and optional discovery |
| `workspace_validate` | `config`; optional `testCommand`, `queryId`, `record`, `overlays`, `timeoutMs`, `runtimeInputs`, `snapshotExclude`, `workspaceRoot` | Compiler, execution, and input stability evidence |
| `library_feedback` | `queryId` UUID; optional `accepted`, `compilePassed`, `testsPassed`, `notes` up to 1000 characters | Agent reported outcome stored against a prior query |
| `library_stats` | `{}` | Local query, latency, hit rate, context size, and outcome aggregates |

Workspace tools accept the same fields as the corresponding CLI request files. Feedback is an agent report, not a compiler or test run. It remains separate from tool executed validation records. Index preparation uses the CLI. There is no MCP install tool or arbitrary SQL query tool.

## Local data and source setup

Indexes and query history live in `~/.typelatch`. `TYPELATCH_HOME` selects another directory. `TYPELATCH_USAGE=off` disables query and validation recording. Explicit feedback can still update an existing query when requested. Query history can contain source related questions and feedback notes. The application does not upload that history. [Security](../SECURITY.md) describes the trust boundary.

To build and verify Typelatch itself:

```sh
git clone https://github.com/eDimka/typelatch.git
cd typelatch
npm ci
npm run release:check
npm link
```

[Contributing](../CONTRIBUTING.md) · [Architecture](ARCHITECTURE.md) · [Benchmark evidence](BENCHMARKS.md) · [Release checks](RELEASE.md)
