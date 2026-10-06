# Relay runtime

Small TypeScript utilities used by a service adapter. Local caching avoids duplicate reads and retry handles temporary upstream failures. Clocks and waiting functions can be supplied by the caller for deterministic execution.

The adapter is in `src/service.ts`. The utilities have no runtime dependencies. Node.js can execute their erasable TypeScript with `--experimental-strip-types`.
