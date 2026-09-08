# Usage

Start with a workspace question, inspect the relevant source or exact dependency APIs, then check their use in a local TypeScript project. The CLI and MCP server share the same implementation.

## Install and connect

Requires Node.js 22.12 or newer and npm. The SQLite dependency uses a native binary. If your platform has no suitable binary, installation requires a working C++ build toolchain.

```sh
npm install --global typelatch@0.2.0
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

Start a new client session after registration or upgrading. Version 0.2.0 exposes the [seven tools](#mcp-tool-reference) over standard input and output, including `workspace_search`. If the client cannot find `typelatch-mcp`, check the executable path in the environment that launches the client or configure its absolute path.

<details>
<summary>Use npm without a global installation</summary>

Prepare the same local index:

```sh
npx --yes --package=typelatch@0.2.0 typelatch add kysely@0.28.8
```

Register either client with npm as the launcher:

```sh
codex mcp add typelatch -- npx --yes --package=typelatch@0.2.0 typelatch-mcp
claude mcp add --transport stdio --scope user typelatch -- npx --yes --package=typelatch@0.2.0 typelatch-mcp
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

## Workspace search

Workspace search is included in version 0.2.0. Install or upgrade with `npm install --global typelatch@0.2.0`, then restart the MCP client so it discovers the new tool.

Use `workspace_search` when the relevant file or dependency is unknown:

```json
{
  "workspaceRoot": "/absolute/path/to/repo",
  "question": "Where do we validate incoming requests?",
  "limit": 8
}
```

The CLI uses the current directory by default:

```sh
typelatch search "Where do we validate incoming requests?" --json
typelatch search "retry failed requests" --root /absolute/path/to/repo --json
typelatch search "validateRequest" --scope workspace --file src/server.ts --json
typelatch search "retry with exponential delay" --scope dependencies --json
```

`scope` is `all` by default, or `workspace` or `dependencies`. `file` is an optional path within the root that favors nearby workspace results. It does not limit the search or establish compiler resolution. `limit` is 1 through 20 and defaults to 8. MCP accepts `timeoutMs`, defaulting to 60000. Cancellation fails the request rather than returning an apparently complete result.

Source search includes internal declarations, implementation text, tests, documentation, and configuration. TypeScript and JavaScript declarations receive symbol names and UTF16 positions when the bundled parser recognizes them. Other UTF8 text is searched as text. No project compiler or application code executes during search.

In Git workspaces, the inventory includes tracked and unignored files, including uncommitted edits. Generated and dependency directories, source symlinks, binary files, environment files, and common archive or media formats are excluded. Lockfiles supply dependency identities and are excluded from content retrieval. Outside Git, filesystem traversal remains available and reports that Git ignore rules were not applied. The response names the selection policy and samples exclusions. Linked source outside the root is outside the search scope.

Search discovers nested package manifests, TypeScript configs, installed dependencies and nested transitive installations. It uses each installed manifest's name and exact version, including aliases and multiple versions, rather than the newest global index. npm lockfiles of version 2 or 3 also provide exact candidates when packages are not installed. These results are labeled `identity: "lockfile"` and `installed: false`. A lockfile candidate is not proof of workspace resolution. Other lockfile formats are not parsed; available installed manifests can still supply identities. Unidentified declared dependencies are reported.

Search uses existing package indexes and does not download or build missing ones. Run `typelatch sync` in each relevant npm project to prepare direct locked dependencies. Missing entries in `coverage.dependencies` include exact `typelatch add name@version` commands, including for transitive packages. A JavaScript package without usable TypeScript declarations may still be unindexable. Do not substitute another version. Registry metadata and any available lockfile integrity must match; installed artifact equivalence remains unknown.

Each source hit includes an absolute `source`, `line`, `endLine`, compact `snippet`, owning `projectRoot`, and optional `symbol` and `position`. A dependency hit instead identifies its package, exact version, registry integrity, artifact relative source path, and known dependency roots. Inspect it with `library_symbol` using that identity. `coverage.configs` lists discovered configs; the agent must select one that owns the relevant file before using `workspace_context`.

The agent workflow is:

1. Search with a concrete question. Check `coverage` before interpreting the results.
2. Read relevant source locations. For dependency hits, inspect the exact returned symbol with `library_symbol`.
3. Use `workspace_context` to resolve an actual use in the appropriate project.
4. Make the change with normal file tools.
5. Use `workspace_validate` for the affected leaf projects and explicitly authorized assertion commands. Keep retrieval, resolution, compilation, and execution evidence separate.

Suggested agent instruction:

```text
Use workspace_search when the relevant file or package is unknown.
Supply the repository's absolute root and a focused question. Inspect
coverage gaps and returned source locations. Use library_symbol with
the returned package and exact version for dependency detail, and
workspace_context for compiler resolution of an actual workspace use.
After editing, use workspace_validate for the affected projects and
authorized assertions. Report missing evidence separately.
```

The result `status` is `ok` when candidates were found with complete declared inventory coverage, `empty` when no candidates were found with that coverage, and `partial` when inventories, indexes, or file indexing have gaps. `coverage.complete` refers to the declared inventory policy, not exhaustive retrieval, semantic understanding, or an atomic filesystem snapshot. The evidence checks explicitly leave resolution, compilation, and tests as `not-run`, and stability and installed artifact matching as `unknown`.

Retrieval is lexical and uses a shared content score across source and dependency candidates, with a bounded shortlist and overlap suppression. It does not use embeddings. Current limits are 20000 inventoried paths, 1 MB per file, 64 MiB of workspace text, 2000 dependency installations, 500 chunks per file, 400 workspace candidates, 20 candidates per dependency, and 20 returned hits. Coverage reports inventory and indexing limits. Retrieval limits remain explicit even when inventory coverage is complete. Dependency coverage details prioritize gaps and show up to 40 entries with omitted counts; large project and config inventories are also summarized. An empty shortlist never proves that a symbol or behavior is absent.

The SQLite cache lives under `~/.typelatch/workspaces`, or the selected `TYPELATCH_HOME`. It stores source excerpts. Every search reads file contents and checks hashes, so same size edits with preserved timestamps, additions, removals, and changed ignore rules refresh the index. Unchanged files reuse cached chunks. `TYPELATCH_USAGE=off` controls query history, not this cache. Workspace searches currently do not create `library_feedback` query IDs or contribute to `library_stats`.

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
| `workspace_search` | absolute `workspaceRoot`, `question`; optional `scope`, `file`, `limit` from 1 to 20, `timeoutMs` | Ranked local file and exact dependency candidates, cache refresh details, coverage and evidence limits |
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
