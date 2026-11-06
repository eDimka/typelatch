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

Archive extraction accepts one safe top directory, including the named root used by older DefinitelyTyped artifacts, and normalizes it into `package`. Mixed roots, traversal, links and extraction limit violations are rejected. Sync reports packages without TypeScript evidence as unsupported and continues supported packages; operational and identity failures still stop execution.

Package identity is the name, exact version, and registry integrity. An index is reusable across projects. The registry hash establishes the downloaded artifact identity; workspace artifact equivalence remains a separate question.

Managed queries check package and version metadata against the selected cache identity and require nonblank stored integrity on the readonly database handle before returning rows. Validation failures close that handle and name the exact rebuild command. SQLite and schema errors retain their existing states. The internal `brainFile` override remains available for explicit fixture and benchmark inputs; it is not a public MCP selector. This guard checks the stored label and does not rehash an archive or installed package.

New package builds use the trimmed format. It retains signatures, documentation, source locations, symbol identities and relationship endpoints while omitting raw implementation text and unused edge evidence. Existing baseline and compact indexes remain readable. Rebuild an existing package with `typelatch add name@version` to use the smaller format.

Signature extraction preserves declared callable headers for direct arrow and function expressions, using syntax printing to keep literal types and defaults intact while eliding the outer implementation. Function declarations with bodies retain only their headers. It does not infer return types or follow factory calls, aliases or assertions to guess callability. Rebuilt metadata identifies generator `typelatch-indexer/0.2.2`; this changes evidence text without changing the database schema or rewriting existing indexes.

Compound library questions recognize at least two distinct complete ASCII dotted names and query up to 64 exact identities using bound values and binary comparison. Returned exact matches keep first mention order. Remaining slots use the existing lexical ranking without duplicating those rows. Per name metadata distinguish returned, missing and result limit omissions; additional recognized names have a separate truncation count. Recognition excludes paths, URLs, filenames and prose abbreviations, and does not infer aliases. Single name discovery and strict symbol lookup keep their existing behavior. This changes query projection without rebuilding package indexes.

## Workspace evidence

`workspace/search.ts` is the entry point for discovery without a known file or package. `workspace/inventory.ts` gathers Git selected workspace text, project manifests, configs, and exact installed or locked dependency identities. `lockfiles.ts` selects and parses supported npm, pnpm, Yarn, Bun and Deno formats for both project commands and workspace inventory. `project.ts` resolves lock ownership for both sync and search. `sync.ts` expands the selected projects and prepares a complete plan before downloads. The plan records exact identities, project and lockfile provenance, cache status, skips and errors. Lock candidates remain distinct from installed identities. `workspace/search-index.ts` updates a separate SQLite text index by content hash and extracts local declaration positions with the bundled TypeScript parser. It does not load the project compiler. Package indexes retain their existing artifact identity and format.

`project-manifest.ts` combines package declarations with Deno JSON or JSONC npm imports. Declared Deno workspace members inherit root imports, and member imports override those aliases. Unsupported resolution settings remain visible issues, and Deno import aliases require a selected `deno.lock` rather than being treated as installation paths.

`scope.ts` persists an explicit project selection in `.typelatch/scope.json`. Plain sync and every search inventory reload the nearest configuration. Source inventory intersects the selection with the requested root before Git enumeration or filesystem traversal. Scoped dependency discovery resolves only selected projects' direct declarations, including hoisted installations and shared locks. Ancestor metadata and Yarn Classic member manifests used for local identity never opt more source into the index. An empty selection remains empty; invalid selections fail. The existing cache transaction removes excluded files and reuses unchanged selected files. Global package indexes are retained when the selection contracts.

Workspace and dependency candidates receive a shared lexical score based on content, rather than comparing the existing package rank numbers. Results expose bounded retrieval, inventory gaps, exact locations, and separate evidence states. CLI and MCP discovery run in a separate `search-worker.ts` process through the existing bounded worker queue, so synchronous indexing cannot block the server from enforcing cancellation and deadlines. The existing workspace context and validation paths remain responsible for compiler and execution evidence. Workspace cache transactions keep index refresh and candidate selection together; the filesystem reads themselves are not an atomic snapshot.

Workspace cache schema 6 stores excerpt offsets and lengths and refers to file paths by numeric identity. A contentless FTS index holds search postings without storing excerpt text. Search reconstructs excerpts from the same content inventory whose hashes were checked for that request, including unchanged files. Older caches rebuild from current file contents and reclaim obsolete pages. File content hashes, ranking weights, candidate limits and source locations retain their existing meaning.

New empty caches use 1024 byte pages when the inventory contains at most 32 searchable files and 64 KiB of UTF8 text. Larger new caches use the SQLite default. Existing caches retain their page size through growth or contraction. This reduces initial small cache overhead without changing FTS detail or retrieval. It adds no recurring VACUUM operation. A formerly small cache can cost more space after substantial growth; the recorded experiment quantifies that tradeoff.

`workspace/source-context.ts` projects optional source context from that same inventory. It deduplicates selected files, finds direct literal relative imports in source syntax and includes only unambiguous candidates already inside the selected inventory. It performs no file reads or compiler resolution. Source text and file counts have fixed bounds, with hashes, line ranges and omissions exposed to callers. Full and compact search behavior remain unchanged.

```mermaid
flowchart LR
    Request[Workspace request] --> Worker[Bounded compiler worker]
    Worker --> Context[Definitions and types]
    Context --> Validate[Compiler check]
    Validate --> Tests[Explicit test command]
    Tests --> Record[Result and input snapshots]
```

`workspace/context.ts` resolves the installed project and joins optional package discovery. `workspace/persistent.ts` reuses compiler processes while checking file and configuration identity. `workspace/runtime.ts` bounds requests. `workspace/validate.ts` combines compiler results, explicit command execution, and input snapshots.

Known `importSpecifier` and `symbol` requests without `question` or `position` use the existing compiler route and report `installed-api`. This route requires the installed package and project compiler but creates no package index. Callable signatures use the value type for merged value and interface declarations while the legacy type field retains its declared type. Compiler formatting remains separate from declared syntax.

`workspace/api-evidence.ts` projects bounded evidence for the explicitly selected API. It prints normalized declaration headers using the installed compiler, elides bodies and container members, and hashes the actual compiler source text, including overlays. Intersecting syntax diagnostics and unsupported declaration forms produce visible unsupported states. Character counts expose truncation of type, documentation, signatures, headers and compiler JSDoc tags. Discovery and navigation candidates retain their lighter projection. The worker byte limit, validation checks and installed artifact equivalence remain separate boundaries; this projection adds no cache or snapshot guarantee.

Workspace search also reuses a worker within a session. It inventories and hashes current files on every request; only process and parser startup are reused. Search and context share a pool with at most two workers and sixteen queued requests. Cancellation and deadlines terminate the process group, output remains bounded, and idle workers retire after thirty seconds. Parsers load only when the selected format or changed content requires them. Once loaded, the parser runtime remains in memory during that idle interval. Standalone CLI requests can exit without waiting for it.

`workspace/command.ts` enforces time and output limits. `workspace/snapshot.ts` records the scoped input identity. Cancellation and missing results stay visible. A retrieved symbol, a resolved symbol, a successful compile, and passing assertions each carry their own evidence.

## Interfaces

`cli.ts` handles local commands. `mcp.ts` exposes seven tools over standard input and output. `workspace/schema.ts` validates workspace requests. `usage.ts` stores optional local library query history and feedback. Workspace discovery caches source excerpts separately and does not emit library feedback IDs. Tool executed validation records remain separate from agent reported outcomes.

CLI dispatch loads command modules only after checking required arguments. Help and saved scope do not load a compiler or package database. Existing package queries load the database reader without the TypeScript indexer. Synchronization loads the indexer only for a target that needs a build. Deferred imports and asynchronous commands remain inside their existing error boundaries.

## Boundaries

The installed compiler and explicit test commands are trusted local code. Snapshots describe the recorded files and configuration. They do not certify remote systems or excluded inputs. Each leaf project can be validated; references inform resolution. This release does not implement an LSP transport or a remote service.
