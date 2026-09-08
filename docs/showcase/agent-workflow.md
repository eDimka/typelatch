# An agent fixes a partial contact import

The user task is simple: a failed contact import leaves rows behind. Find the implementation and make each batch succeed together or roll back together, while preserving parameter binding.

The agent starts with a question. It does not need the package name, function name or TypeScript config to make the first search. This walkthrough uses a deliberately broken copy of the SQLite example so that the before and after behavior can be checked with the same assertions.

## Give this to your agent

Install Typelatch 0.2.0 and connect its MCP server as described in [Usage](../USAGE.md). From a trusted source checkout, prepare an isolated exercise:

```sh
npm ci
npm run showcase:agent:prepare
```

The command prints an absolute workspace path and installs the fixture dependencies there. Open that directory in your agent. The repository's original example remains unchanged. Give the agent this prompt:

```text
Contact imports leave partial data after a duplicate name. Find the
implementation and fix whole batch rollback while preserving parameter
binding.

Use Typelatch's workspace_search with this workspace's absolute root
as your first discovery step. Do not assume the file or package name.
Inspect the returned sources and tests. Report missing search coverage.

Use workspace_context to resolve the dependency actually used here.
You may prepare its exact API index with typelatch add if it is missing.
Inspect the relevant API before editing.

I authorize npm test inside this isolated workspace before and after
the change. Use workspace_validate for those checks. Edit only batch.ts;
preserve all assertions. Do not run other application commands.

Report the changed code and the evidence for retrieval, compiler
resolution, compilation, tests and input stability separately. Keep
anything unknown or not run visible.
```

## What the tool calls look like

The [captured requests and result projections](agent-workflow.json) come from actual MCP calls over standard input and output. `$WORKSPACE` below represents the prepared absolute path. The explanations describe the intended agent decisions. The replay is a fixed, curated workflow authored by Codex, not a transcript of independent agent decisions or a coding benchmark.

| Step | Agent action | Evidence to inspect |
| :--- | :--- | :--- |
| Discover | Call `workspace_search` with the user question and workspace root. | Source and test candidates, plus missing dependency indexes. No compilation has run. |
| Inspect | Read the tests with normal file tools, then search for `importContacts`. | The rollback assertion and the implementation location. |
| Reproduce | Call `workspace_validate` with `testCommand: ["npm", "test"]`. | The broken implementation compiles but fails the rollback assertion. |
| Resolve | Call `workspace_context` for the import found in the source. | The installed compiler identifies `kysely@0.28.8`. |
| Discover an API | Prepare that exact index, then call `workspace_search` with `scope: "dependencies"` and `TransactionBuilder execute`. | A transaction callback candidate with its package, version and source location. |
| Inspect the API | Call `library_symbol` using the exact returned identity. | The `TransactionBuilder.execute` callback signature. |
| Edit | Use normal file editing to wrap the inserts in a transaction callback. | The actual before and after code. The assertions remain unchanged. |
| Resolve and validate | Refresh discovery, resolve the edited call and rerun the same validation. | Changed file detected, compiler resolution, passing compilation, both assertions passing and stable recorded inputs. |

The first request has no package or file argument:

```json
{
  "name": "workspace_search",
  "arguments": {
    "workspaceRoot": "$WORKSPACE",
    "question": "Contact imports leave partial data after a duplicate name. Find the implementation and fix whole batch rollback while preserving parameter binding.",
    "limit": 8
  }
}
```

After reading the tests, the agent narrows the search to the function they exercise:

```json
{
  "name": "workspace_search",
  "arguments": {
    "workspaceRoot": "$WORKSPACE",
    "question": "importContacts",
    "scope": "workspace",
    "limit": 5
  }
}
```

The compiler context comes from the discovered file:

```json
{
  "name": "workspace_context",
  "arguments": {
    "config": "$WORKSPACE/tsconfig.json",
    "file": "$WORKSPACE/batch.ts",
    "importSpecifier": "kysely",
    "symbol": "Kysely"
  }
}
```

The replay prepares the returned exact dependency identity with `typelatch add kysely@0.28.8`. This downloads an API index; it does not install or change the workspace dependency. The next workspace search supplies `scope: "dependencies"` and `question: "TransactionBuilder execute"`, still without a package argument. `library_symbol` then inspects the returned `kysely@0.28.8` symbol `esm/kysely.TransactionBuilder`.

The substantive edit is:

```diff
 export async function importContacts(db: Kysely<Tables>, contacts: Contact[]) {
-  for (const contact of contacts) {
-    await db.insertInto('contact').values(contact).execute()
-  }
+  await db.transaction().execute(async transaction => {
+    for (const contact of contacts) {
+      await transaction.insertInto('contact').values(contact).execute()
+    }
+  })
 }
```

The validation request is identical before and after the edit:

```json
{
  "name": "workspace_validate",
  "arguments": {
    "config": "$WORKSPACE/tsconfig.json",
    "workspaceRoot": "$WORKSPACE",
    "testCommand": ["npm", "test"],
    "timeoutMs": 60000,
    "record": false
  }
}
```

## What the agent can conclude

The before run compiles successfully and fails the rollback assertion. The after run compiles and passes both unchanged assertions: parameter binding and whole batch rollback. The recorded input stability check passes. The source search refresh detects the edit.

The agent can report those results for this fixture. Search coverage remains partial where other dependency indexes are missing. Installed artifact equivalence remains unknown. These results do not prove the behavior of arbitrary imports, deployments or database configurations.

## CLI agents use the same implementation

An agent with terminal access can use the CLI and parse JSON:

```sh
typelatch search "Contact imports leave partial data after a duplicate name" --json
typelatch search "importContacts" --scope workspace --json
typelatch workspace context.json
typelatch add kysely@0.28.8
typelatch search "TransactionBuilder execute" --scope dependencies --json
typelatch symbol kysely@0.28.8 esm/kysely.TransactionBuilder --json
typelatch validate validation.json
```

`context.json` and `validation.json` contain the corresponding `arguments` objects above, with real absolute paths. File inspection and editing use the agent's ordinary tools. Typelatch does not edit files. The capture includes an executed CLI search in addition to the MCP flow.

## Replay and inspect the evidence

```sh
npm run showcase:agent
```

This builds the checkout, creates a fresh isolated fixture, executes the curated sequence, and fails unless the baseline assertion fails for the expected reason and the corrected code passes. It saves the request and result projections to `docs/showcase/agent-workflow.json` and full normalized MCP envelopes, source edits and command output to `artifacts/agent-workflow.json.gz`. Per run working files remain under `artifacts/agent-workflow` for inspection. Private path prefixes are replaced in public evidence; IDs, hashes, timings and assertion output are retained.

To exercise a packed or published build instead of the source checkout:

```sh
TYPELATCH_PACKAGE=/absolute/path/typelatch-0.2.0.tgz npm run showcase:agent
TYPELATCH_PACKAGE=typelatch@0.2.0 npm run showcase:agent
```

The capture records which package was installed. The full archive is included with the [0.2.0 release assets](https://github.com/eDimka/typelatch/releases/tag/v0.2.0), with its SHA256 checksum in the compact recording and release checksums.
