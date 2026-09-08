# Project guide

Typelatch provides local package API discovery and TypeScript workspace evidence through a CLI and MCP server.

## Working rules

Keep changes scoped to the requested behavior. Add a failing reproducer before a behavior fix, then run the relevant tests and release checks. Preserve explicit evidence states and exact package identity. Use direct names and brief comments that explain necessary constraints. Write public prose without dash punctuation; retain required code and command syntax. Keep public claims grounded in recorded project evidence.

## Routing

| When working on | Read |
| :--- | :--- |
| Installation or commands | README.md and docs/USAGE.md |
| Module boundaries or workspace workers | docs/ARCHITECTURE.md |
| Retrieval, storage, or benchmark cases | docs/BENCHMARKS.md |
| Validation or local execution | SECURITY.md and src/workspace/schema.ts |
| Packaging or publication | docs/RELEASE.md |
| Contributions or verification | CONTRIBUTING.md |
