# Typelatch

[![Typelatch. Find the API. Check it where the code runs.](https://raw.githubusercontent.com/eDimka/typelatch/main/site/assets/readme-banner.png)](https://edimka.github.io/typelatch/)

Local API evidence for TypeScript coding agents.

Give Codex or Claude Code the API from an exact npm version, then check the code against your installed compiler and explicit assertions. Typelatch searches a local SQLite knowledge store through six MCP tools. It also works from the terminal.

[See the walkthrough](https://edimka.github.io/typelatch/) · [Usage](docs/USAGE.md) · [Recorded evidence](docs/showcase/recording.json)

## Connect your agent

Requires Node.js 22.12 or newer and npm. The SQLite dependency uses a native binary. A platform without a suitable binary needs a working C++ build toolchain.

```sh
npm install --global typelatch@0.1.1
typelatch --help
typelatch add kysely@0.28.8
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

Start a new agent session in your TypeScript project. The agent can now search the prepared index. Indexing does not install Kysely into your project. [Usage](docs/USAGE.md) covers workspace setup, configuration files, and running without a global installation.

## A batch should succeed together or not at all

Suppose you are importing contacts into SQLite. A duplicate name halfway through the import must roll back the whole batch, not leave the first contacts saved.

The [SQLite fixture](examples/sqlite) uses Kysely with `better-sqlite3`. The recorded question asks for an atomic import that also stores a name containing a quote safely. The first search returned constraint and insertion APIs. A refined search for `TransactionBuilder execute` found the callback API. The next MCP request was:

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

## Six tools, one local server

| Tool | What it does |
| :--- | :--- |
| `library_search` | Search an installed package index by question and exact version |
| `library_symbol` | Look up an exact symbol and its relationships |
| `workspace_context` | Resolve imports, definitions, and types with the workspace compiler |
| `workspace_validate` | Compile the project, then optionally run an explicit assertion command |
| `library_feedback` | Record an agent reported outcome for a prior query |
| `library_stats` | Read local query, latency, context size, and outcome aggregates |

Retrieval is not compilation. Compilation is not execution. Context resolution does neither, and agent feedback stays separate from tool executed evidence. [Request examples and evidence states](docs/USAGE.md#read-the-evidence) explain what each result establishes.

## Keep the evidence close

An index records the package name, exact version, registry integrity, and source locations. Downloads verify registry integrity without running package lifecycle scripts. Once indexed, search works offline. In an npm project, `typelatch add kysely` uses the locked version when available. `typelatch sync` indexes direct locked dependencies.

Indexes and query history live in `~/.typelatch`. Set `TYPELATCH_HOME` to choose another directory or `TYPELATCH_USAGE=off` to disable query and validation recording. The application does not upload query history. Workspace validation loads the trusted project compiler and can run an explicitly supplied command with your permissions. [Security and local data](SECURITY.md).

The recorded development suites contain 73 discovery hits out of 73 questions, 70 strict retrieval passes, 24 workspace scenarios, and 48 negative controls. These are authored regression cases, not a measurement of general coding agent success. [Inspect the reports and methodology](docs/BENCHMARKS.md).

```sh
npm run benchmark
npm run prove:support
```

Run those commands from a source checkout. See [contributing](CONTRIBUTING.md) for source setup and [release checks](docs/RELEASE.md) for package verification.

Typelatch currently supports npm packages with TypeScript declarations or usable TypeScript sources, npm lockfiles, and local TypeScript projects. [Architecture](docs/ARCHITECTURE.md) describes the boundaries. Hosted indexes, other languages, and coordinated changes across repositories are outside this release.

[GitHub Pages](https://edimka.github.io/typelatch/) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
