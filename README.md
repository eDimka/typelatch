# Typelatch

[![Typelatch. The right API. Not a wall of docs.](https://raw.githubusercontent.com/eDimka/typelatch/main/site/assets/readme-banner.png)](https://edimka.github.io/typelatch/)

**Search your workspace and its dependencies. Give Codex and Claude Code relevant source and API context, then verify changes with your TypeScript project.**

Start with a question, without choosing a package or file first. Typelatch searches local source, internal functions, tests, docs, configuration, and available indexes for exact dependency versions. It returns a focused shortlist with source locations and visible coverage gaps. Use the workspace compiler and explicit assertions to check the changes that follow. Search runs locally through MCP or the terminal. Actual token use and time saved depend on the task and client; we do not claim measured agent savings.

[npm package](https://www.npmjs.com/package/typelatch) · [See the walkthrough](https://edimka.github.io/typelatch/) · [Usage](docs/USAGE.md) · [Recorded evidence](docs/showcase/recording.json)

## Connect your agent

Requires Node.js 22.12 or newer and npm. The SQLite dependency uses a native binary. A platform without a suitable binary needs a working C++ build toolchain.

```sh
npx typelatch@0.3.0 setup
```

Choose Codex or Claude Code and confirm. Setup registers the exact package version through npm, with no global installation or repository clone. Start a new client session in your TypeScript project and ask: "Use workspace_search to explain how this project is organized."

Version 0.3.0 adds interactive MCP setup, lockfile discovery across package managers, and saved project scopes for monorepos. [Release notes](CHANGELOG.md#030).

<details>
<summary>Source checkout or manual registration</summary>

For development, the source setup also offers the current checkout and an installed executable:

```sh
npm run setup:mcp
```

The checkout option installs missing dependencies and builds the current source. To install globally and register manually:

```sh
npm install --global typelatch@0.3.0
```

**Codex**

```sh
codex mcp add typelatch -- typelatch-mcp
```

**Claude Code**

```sh
claude mcp add --transport stdio --scope user typelatch -- typelatch-mcp
```

</details>

Workspace source is indexed on the first search and refreshed from file contents on later searches. To prepare direct dependency indexes, run `npx typelatch@0.3.0 sync` inside a project with a supported lockfile. Search reports missing indexes and exact preparation commands; it does not download packages automatically. [Usage](docs/USAGE.md) covers workspace setup and configuration files.

For a large monorepo, save the subset you work on with `typelatch scope add apps/web packages/ui`. Source search and plain `sync` then use those projects. Run `scope add services/api` later to expand the selection, `scope remove apps/web` to narrow it, or `scope list` to inspect it. The [saved scope workflow](docs/USAGE.md#keep-a-monorepo-subset) explains cache reuse and overrides.

## Search the whole workspace

When you do not know which file or package contains the answer, start with `workspace_search`:

```json
{
  "workspaceRoot": "/absolute/path/to/your/repo",
  "question": "Where do we validate incoming requests?",
  "limit": 8
}
```

It searches source, internal declarations, tests, docs, configuration, and available indexes for exact installed or locked dependencies. No package name or TypeScript config is required. Source results include file locations and, for recognized declarations, symbol positions. The local workspace index refreshes from file contents on every search.

```sh
typelatch search "Where do we validate incoming requests?" --json
```

Read the returned coverage: missing dependency indexes, exclusions, errors, and limits stay visible. Search does not download packages, resolve symbols with the project compiler, or run tests. [Workspace search and agent workflow](docs/USAGE.md#workspace-search) explains preparation and followup inspection.

The agent workflow is **search, inspect, resolve, edit, validate**. Use `library_symbol` for an exact dependency hit, `workspace_context` for compiler resolution in a real file, and `workspace_validate` for compilation and authorized assertions.

Eight authored repository questions returned the expected source file first in the [workspace discovery regression](docs/benchmarks/workspace-search.json). That is a regression result on known questions, not a measurement of general agent success. [Verification details](docs/verification/workspace-search.md).

The [CodeGraph and Graphify comparison](docs/COMPETITIVE.md) records measured storage improvements, actual MCP responses, a completed coding pilot and remaining gaps. It does not claim superiority in every aspect.

## Watch the agent workflow

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

## Seven tools, one local server

| Tool | What it does |
| :--- | :--- |
| `workspace_search` | Discover relevant workspace files and exact dependency APIs without choosing a package first |
| `library_search` | Search an installed package index by question and exact version |
| `library_symbol` | Look up an exact symbol and its relationships |
| `workspace_context` | Resolve imports, definitions, and types with the workspace compiler |
| `workspace_validate` | Compile the project, then optionally run an explicit assertion command |
| `library_feedback` | Record an agent reported outcome for a prior query |
| `library_stats` | Read local query, latency, context size, and outcome aggregates |

Retrieval is not compilation. Compilation is not execution. Context resolution does neither, and agent feedback stays separate from tool executed evidence. [Request examples and evidence states](docs/USAGE.md#read-the-evidence) explain what each result establishes.

## Keep the evidence close

An index records the package name, exact version, registry integrity, and source locations. Downloads verify registry integrity without running package lifecycle scripts. Once indexed, search works offline. In a project with a supported lockfile, `typelatch add kysely` uses the locked version when available. `typelatch sync` indexes direct locked dependencies. Use `--workspaces` for declared workspace packages or repeat `--project path` to choose projects. Preview the selection with `--dry-run --json`.

Indexes and query history live in `~/.typelatch`. Set `TYPELATCH_HOME` to choose another directory or `TYPELATCH_USAGE=off` to disable query and validation recording. The application does not upload query history. Workspace validation loads the trusted project compiler and can run an explicitly supplied command with your permissions. [Security and local data](SECURITY.md).

The recorded development suites exercise retrieval, workspace scenarios, and negative controls. These are authored regression cases, not a measurement of general coding agent success. [Inspect the reports and methodology](docs/BENCHMARKS.md).

```sh
npm run benchmark
npm run benchmark:workspace
npm run prove:support
```

Run those commands from a source checkout. See [contributing](CONTRIBUTING.md) for source setup and [release checks](docs/RELEASE.md) for package verification.

Typelatch currently supports npm packages with TypeScript declarations or usable TypeScript sources, npm, pnpm, Yarn and Bun text lockfiles, and local TypeScript projects. [Architecture](docs/ARCHITECTURE.md) describes the boundaries. Hosted indexes, other languages, and coordinated changes across repositories are outside this release.

[GitHub Pages](https://edimka.github.io/typelatch/) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
