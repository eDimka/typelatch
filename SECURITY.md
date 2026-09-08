# Security

## Trust boundary

Typelatch runs locally. Index creation contacts npm and verifies the downloaded registry artifact. Search uses local SQLite databases. The application does not upload query history.

Workspace resolution loads the installed TypeScript compiler. Validation can execute an explicitly supplied command with the current user’s permissions. Use those features only in projects whose compiler and commands you trust. Time and output limits bound work; they are not a security sandbox.

Local history can contain questions, symbol names, and feedback notes. Set `TYPELATCH_USAGE=off` to disable query and validation recording. Explicit feedback still updates an existing query when requested. Package indexes retain third party API material under its original license.

## Report a vulnerability

Use the repository’s private vulnerability reporting form under Security. Include the affected version, a minimal reproducer, and the expected impact. Keep credentials and private source out of public issues.

Version 0.1 receives security fixes during MVP development. No response time guarantee is offered.
