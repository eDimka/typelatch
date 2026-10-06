# Typelatch

[![Typelatch. The right API. Not a wall of docs.](https://raw.githubusercontent.com/eDimka/typelatch/main/site/assets/readme-banner.png)](https://edimka.github.io/typelatch/)

**Find exact dependency APIs. Give Codex and Claude Code relevant API context, then verify changes with your TypeScript project.**

Typelatch searches local indexes for exact dependency versions and returns focused API context with source locations. Use the workspace compiler and explicit assertions to check the changes that follow. Search runs locally through MCP or the terminal. Actual token use and time saved depend on the task and client; we do not claim measured agent savings.

The published npm release is **0.1.1**, with six MCP tools for package discovery, workspace context, and validation. Workspace discovery through `workspace_search` and `typelatch search` is part of **unreleased 0.2.0** source development. To try those features, use the [source setup](docs/USAGE.md#local-data-and-source-setup).

[npm package](https://www.npmjs.com/package/typelatch) · [See the walkthrough](https://edimka.github.io/typelatch/) · [Usage](docs/USAGE.md) · [Recorded evidence](docs/showcase/recording.json)

## Connect your agent

Requires Node.js 22.12 or newer and npm. The SQLite dependency uses a native binary. A platform without a suitable binary needs a working C++ build toolchain.

```sh
npm install --global typelatch@0.1.1
typelatch --help
```

Choose your client:

**Codex**

```sh
codex mcp add typelatch -- typelatch-mcp
```

**Claude Code**

```sh
claude mcp add --transport stdio --scope user typelatch -- typelatch-mcp
```

Start a new agent session in your TypeScript project, or restart it after registration. To prepare direct dependency indexes, run `typelatch sync` inside an npm project with a lockfile, then use `library_search` with a package and exact version. [Usage](docs/USAGE.md) covers workspace setup, configuration files, and running without a global installation.

## Search the whole workspace

**Unreleased 0.2.0 feature.** The examples in this section require the [source setup](docs/USAGE.md#local-data-and-source-setup). Published 0.1.1 does not include `workspace_search` or the `typelatch search` command.

When you do not know which file or package contains the answer, start with `workspace_search`:

```json
{
  "workspaceRoot": "/absolute/path/to/your/repo",
  "question": "Where do we validate incoming requests?",
  "limit": 8
}
```

It searches source, internal declarations, tests, docs, configuration, and available indexes for exact installed or npm locked dependencies. No package name or TypeScript config is required. Source results include file locations and, for recognized declarations, symbol positions. The local workspace index refreshes from file contents on every search.

```sh
typelatch search "Where do we validate incoming requests?" --json
```

Read the returned coverage: missing dependency indexes, exclusions, errors, and limits stay visible. Search does not download packages, resolve symbols with the project compiler, or run tests. [Workspace search and agent workflow](docs/USAGE.md#workspace-search) explains preparation and followup inspection.

The agent workflow is **search, inspect, resolve, edit, validate**. Use `library_symbol` for an exact dependency hit, `workspace_context` for compiler resolution in a real file, and `workspace_validate` for compilation and authorized assertions.

Eight authored repository questions returned the expected source file first in the [workspace discovery regression](docs/benchmarks/workspace-search.json). That is a regression result on known questions, not a measurement of general agent success. [Verification details](docs/verification/workspace-search.md).

## Watch the agent workflow

This walkthrough uses unreleased 0.2.0 workspace discovery. Complete the [source setup](docs/USAGE.md#local-data-and-source-setup) before running it.

**The task:** contact imports leave partial data after a duplicate name. Find the implementation and make the whole batch roll back while preserving parameter binding.

The [agent walkthrough](docs/showcase/agent-workflow.md) includes a prompt you can give Codex or Claude Code, an isolated exercise, exact MCP requests, the source edit, and captured assertion output. It starts with `workspace_search`, without a package or file argument.

| Agent action | What the recorded replay establishes |
| :--- | :--- |
| Search the workspace and inspect the tests | Locate `importContacts` and the rollback assertion. Missing indexes stay visible. |
| Validate before editing | Compilation passes, but the rollback assertion fails. |
| Resolve the import and inspect the dependency API | The workspace uses `kysely@0.28.8`; inspect its returned transaction callback symbol. |
| Edit with normal file tools | Put all parameterized inserts inside the transaction callback. |
| Refresh, resolve and validate again | Discovery sees the edit. Compilation, both unchanged assertions and recorded input stability pass. |

From a source checkout, prepare a broken exercise for your own agent or replay the captured workflow:

```sh
npm run showcase:agent:prepare
npm run showcase:agent
```

The replay executes real MCP calls and a CLI search against an isolated SQLite fixture. Its decision sequence is curated, not a recording of independent agent decisions or a claim about general coding success. [Requests and results](docs/showcase/agent-workflow.json) · [Prompt, edit and reproduction](docs/showcase/agent-workflow.md).

## A batch should succeed together or not at all

The actual question in the recorded run:

> How can I import a batch of contacts into SQLite atomically, roll back every new row if a UNIQUE name constraint fails, and safely store a name containing a quote?

The [SQLite fixture](examples/sqlite) uses Kysely with `better-sqlite3`. The first search returned transaction, insertion, and constraint APIs. Jcode narrowed the question to the callback API with this actual MCP request against Typelatch's local SQLite index:

```json
{
  "name": "library_search",
  "arguments": {
    "package": "kysely",
    "version": "0.28.8",
    "question": "TransactionBuilder execute",
    "limit": 5
  }
}
```

The results included `esm/kysely.TransactionBuilder`. The next request inspected that exact symbol:

```json
{
  "name": "library_symbol",
  "arguments": {
    "package": "kysely",
    "version": "0.28.8",
    "symbol": "esm/kysely.TransactionBuilder"
  }
}
```

The returned class begins at `dist/esm/kysely.d.ts:623`. Its signature includes:

```ts
execute<T>(callback: (trx: Transaction<DB>) => Promise<T>): Promise<T>;
```

The [implementation](examples/sqlite/batch.ts) lets an insert error escape the callback so the batch rolls back. `workspace_context` resolved `kysely@0.28.8`. `workspace_validate` recorded compilation, assertions, and input stability as `pass`. Selected fields from its recorded `execution` result:

```json
{
  "command": ["npm", "test"],
  "exitCode": 0,
  "status": "pass"
}
```

Two passing tests check parameter binding and whole batch rollback. A separate control without the transaction compiled but failed the rollback assertion. That difference is the point: finding an API and compiling its use do not establish database behavior.

These excerpts come from a [real stdio MCP recording](docs/showcase/recording.json), captured with the published `typelatch@0.1.1` package and an SDK client. The question and implementation were authored by Jcode. This is not a Codex or Claude Code session transcript. [Inspect the capture and reproduce it](docs/showcase/README.md).

Typelatch's own SQLite store has a different job: it holds indexed package APIs. `library_search` queries that local store. The recording also includes a separate read only audit of `brains/kysely/0.28.8/brain.db` inside its data directory. That audit is not an MCP tool. There is no MCP tool for arbitrary SQL queries.

For terminal discovery:

```sh
typelatch query kysely@0.28.8 "TransactionBuilder execute" --json --limit 5
```

[Try the same task in your agent](docs/USAGE.md#try-the-sqlite-task), with an explicit assertion command and a report that keeps retrieval, resolution, compilation, and execution separate.

## Six published tools, one local server

Published `typelatch@0.1.1` provides these six tools:

| Tool | What it does |
| :--- | :--- |
| `library_search` | Search an installed package index by question and exact version |
| `library_symbol` | Look up an exact symbol and its relationships |
| `workspace_context` | Resolve imports, definitions, and types with the workspace compiler |
| `workspace_validate` | Compile the project, then optionally run an explicit assertion command |
| `library_feedback` | Record an agent reported outcome for a prior query |
| `library_stats` | Read local query, latency, context size, and outcome aggregates |

Unreleased 0.2.0 source development adds a seventh tool, `workspace_search`, to discover relevant workspace files and exact dependency APIs without choosing a package first. It requires the [source setup](docs/USAGE.md#local-data-and-source-setup).

Retrieval is not compilation. Compilation is not execution. Context resolution does neither, and agent feedback stays separate from tool executed evidence. [Request examples and evidence states](docs/USAGE.md#read-the-evidence) explain what each result establishes.

## Keep the evidence close

An index records the package name, exact version, registry integrity, and source locations. Downloads verify registry integrity without running package lifecycle scripts. Once indexed, search works offline. In an npm project, `typelatch add kysely` uses the locked version when available. `typelatch sync` indexes direct locked dependencies.

Indexes and query history live in `~/.typelatch`. Set `TYPELATCH_HOME` to choose another directory or `TYPELATCH_USAGE=off` to disable query and validation recording. The application does not upload query history. Workspace validation loads the trusted project compiler and can run an explicitly supplied command with your permissions. [Security and local data](SECURITY.md).

The recorded development suites exercise retrieval, workspace scenarios, and negative controls. These are authored regression cases, not a measurement of general coding agent success. [Inspect the reports and methodology](docs/BENCHMARKS.md).

```sh
npm run benchmark
npm run benchmark:workspace
npm run prove:support
```

Run those commands from a source checkout. See [contributing](CONTRIBUTING.md) for source setup and [release checks](docs/RELEASE.md) for package verification.

Typelatch currently supports npm packages with TypeScript declarations or usable TypeScript sources, npm lockfiles, and local TypeScript projects. [Architecture](docs/ARCHITECTURE.md) describes the boundaries. Hosted indexes, other languages, and coordinated changes across repositories are outside this release.

[GitHub Pages](https://edimka.github.io/typelatch/) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
