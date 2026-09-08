# Contributing

Start with an issue that describes the observed behavior or desired result. Keep changes focused on one behavior. Include a reproducer for a defect and a failing test before changing behavior.

```sh
npm ci
npm run verify
npm run release:check
```

Read [architecture](docs/ARCHITECTURE.md) before changing module boundaries. Read [benchmarks](docs/BENCHMARKS.md) before changing retrieval, storage, or evidence handling. Run the relevant executable benchmark after such changes and retain its raw results.

Use direct names and small functions. Comment only when the reason or constraint is not evident from the code. Keep public prose concise, with ordinary sentences and no dash punctuation. Code syntax, command flags, identifiers, links, and Mermaid arrows retain their required spelling.

A contribution is ready when the behavior is tested, documentation matches the result, and the release checks pass. Describe the concrete change and the checks you ran. Keep source locations and evidence states intact.
