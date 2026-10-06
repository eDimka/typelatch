# Security

## Trust boundary

Typelatch runs locally. Index creation contacts npm and verifies the downloaded registry artifact. Search uses local SQLite databases. The application does not upload query history.

Workspace resolution loads the installed TypeScript compiler. Validation can execute an explicitly supplied command with the current user’s permissions. Use those features only in projects whose compiler and commands you trust. Time and output limits bound work; they are not a security sandbox.

Local history can contain questions, symbol names, and feedback notes. Set `TYPELATCH_USAGE=off` to disable query and validation recording. Explicit feedback still updates an existing query when requested. Package indexes retain third party API material under its original license.

Workspace search stores source paths, excerpt positions and searchable source terms in `TYPELATCH_HOME/workspaces`, defaulting to `~/.typelatch/workspaces`. It reconstructs excerpts from the content read for each request; source terms in the cache still require the same protection as workspace data. Usage recording settings do not disable this search cache. Search reads workspace files and installed dependency manifests but does not execute project code or download missing indexes. Source symlinks and paths outside the requested root are excluded. Git ignore rules apply when Git file selection is available; filesystem fallback reports its narrower ignore support. Coverage and cache snapshots describe the observed inputs, not an atomic or runtime verified state.

A saved project scope limits source indexing and direct dependency discovery. Required lockfiles and package manifests can still be read for identity. Removing a project drops its source from that workspace cache on the next search; it does not erase shared package indexes or caches created for other requested roots. The selection controls indexing, not filesystem permissions or explicit context and validation requests.

## Report a vulnerability

Use the repository’s private vulnerability reporting form under Security. Include the affected version, a minimal reproducer, and the expected impact. Keep credentials and private source out of public issues.

The latest published version receives security fixes during MVP development. No response time guarantee is offered.
