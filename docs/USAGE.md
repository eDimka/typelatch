# Usage

## Library discovery

`add` downloads and indexes an npm artifact. An explicit version makes the request reproducible. When a version is omitted, `add` first checks the current project lockfile and otherwise resolves through npm. Search defaults to the newest installed index when no version is supplied.

```sh
typelatch add effect@3.22.1
typelatch query effect@3.22.1 "How do I retry an operation?" --json --limit 5
typelatch symbol effect@3.22.1 Effect.retry --json
typelatch sync effect zod
```

Responses include package identity, source locations, signatures, documentation, relationships, and retrieval signals. A retrieved API still needs workspace validation.

## Workspace context

Save a request as `context.json`. Use absolute paths for an agent launched outside your project.

```json
{
  "config": "/path/to/project/tsconfig.json",
  "file": "/path/to/project/src/main.ts",
  "importSpecifier": "effect",
  "symbol": "Effect.retry",
  "question": "How do I retry with exponential delay?",
  "expectedVersion": "3.22.1"
}
```

```sh
typelatch workspace context.json
```

Context returns definitions, types, dependency identity, and optional discovery results. `position` accepts a UTF16 offset starting at zero. `overlays` accepts unsaved `{ "file": "...", "text": "..." }` entries. Context resolution does not compile the project or run tests.

## Validation

Save a request as `validation.json`:

```json
{
  "config": "/path/to/project/tsconfig.json",
  "testCommand": ["npm", "test"],
  "timeoutMs": 30000,
  "record": true
}
```

```sh
typelatch validate validation.json
```

The command runs from the directory containing the config. Compilation must pass before tests execute. Omitting `testCommand` requests compilation only. Unsaved overlays can be checked but cannot receive runtime test evidence.

Validation records compiler inputs and, when execution is requested, the runtime file scope before and after the command. `runtimeInputs` extends that scope; `snapshotExclude` excludes known generated outputs. Excluded files, remote services, and environmental state are outside the evidence boundary. `workspaceRoot` bounds snapshot collection.

A command returning zero establishes only the assertions it actually ran. Results keep `pass`, `fail`, `unknown`, and `not-run` distinct. The CLI exits with status 2 when required checks fail and status 1 for command errors.

## MCP tools

| Tool | Purpose |
| :--- | :--- |
| `library_search` | Search an installed package index |
| `library_symbol` | Resolve an exact symbol in an index |
| `library_feedback` | Record an agent reported outcome |
| `library_stats` | Read local usage aggregates |
| `workspace_context` | Resolve APIs in the installed workspace |
| `workspace_validate` | Compile and optionally execute assertions |

Library search arguments:

```json
{
  "package": "effect",
  "version": "3.22.1",
  "question": "How do I retry with exponential delay?",
  "limit": 5
}
```

Workspace MCP tools accept the same request fields as the corresponding CLI commands. Feedback remains separate from tool executed evidence.

## Storage

`TYPELATCH_HOME` selects the data directory. `TYPELATCH_USAGE=off` disables query and validation recording. Query history can contain source related questions and feedback notes. Indexes contain package documentation and source locations. Remove the data directory to clear local data, then rebuild required indexes.
