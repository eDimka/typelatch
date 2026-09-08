# Architecture

Typelatch has two paths: package discovery and workspace evidence. The CLI and MCP server call the same core functions.

## Package discovery

```mermaid
flowchart LR
    Registry[npm artifact] --> Integrity[Verify integrity]
    Integrity --> Parse[Read TypeScript APIs]
    Parse --> SQLite[SQLite index]
    SQLite --> Search[Symbol and text search]
```

`npm.ts` resolves and downloads one artifact. `archive.ts` bounds extraction. `indexer.ts` reads exports, declarations, documentation, examples, and relationships. `database.ts` stores the result atomically. `query.ts` combines exact lookup, text search, status signals, and relationships.

Package identity is the name, exact version, and registry integrity. An index is reusable across projects. The registry hash establishes the downloaded artifact identity; workspace artifact equivalence remains a separate question.

## Workspace evidence

`workspace/search.ts` is the entry point for discovery without a known file or package. `workspace/inventory.ts` gathers Git selected workspace text, project manifests, configs, and exact installed or npm locked dependency identities. `workspace/search-index.ts` updates a separate SQLite text index by content hash and extracts local declaration positions with the bundled TypeScript parser. It does not load the project compiler. Package indexes retain their existing artifact identity and format.

Workspace and dependency candidates receive a shared lexical score based on content, rather than comparing the existing package rank numbers. Results expose bounded retrieval, inventory gaps, exact locations, and separate evidence states. CLI and MCP discovery run in a separate `search-worker.ts` process through the existing bounded worker queue, so synchronous indexing cannot block the server from enforcing cancellation and deadlines. The existing workspace context and validation paths remain responsible for compiler and execution evidence. Workspace cache transactions keep index refresh and candidate selection together; the filesystem reads themselves are not an atomic snapshot.

```mermaid
flowchart LR
    Request[Workspace request] --> Worker[Bounded compiler worker]
    Worker --> Context[Definitions and types]
    Context --> Validate[Compiler check]
    Validate --> Tests[Explicit test command]
    Tests --> Record[Result and input snapshots]
```

`workspace/context.ts` resolves the installed project and joins optional package discovery. `workspace/persistent.ts` reuses compiler processes while checking file and configuration identity. `workspace/runtime.ts` bounds requests. `workspace/validate.ts` combines compiler results, explicit command execution, and input snapshots.

`workspace/command.ts` enforces time and output limits. `workspace/snapshot.ts` records the scoped input identity. Cancellation and missing results stay visible. A retrieved symbol, a resolved symbol, a successful compile, and passing assertions each carry their own evidence.

## Interfaces

`cli.ts` handles local commands. `mcp.ts` exposes seven tools over standard input and output. `workspace/schema.ts` validates workspace requests. `usage.ts` stores optional local library query history and feedback. Workspace discovery caches source excerpts separately and does not emit library feedback IDs. Tool executed validation records remain separate from agent reported outcomes.

## Boundaries

The installed compiler and explicit test commands are trusted local code. Snapshots describe the recorded files and configuration. They do not certify remote systems or excluded inputs. Each leaf project can be validated; references inform resolution. This release does not implement an LSP transport or a remote service.
