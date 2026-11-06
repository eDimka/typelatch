# Package impact prototype

This experimental provider collects cross package evidence for named exports of one installed workspace package. It reuses Typelatch’s frozen workspace inventory and package selection, then follows explicit compiler import and export paths. It reports source quotations, exact package identities, conservative installed dependency chains, validation script entries and limits.

The supported source scope is configured package src directories. Aliases, named and star reexports, namespaces, type roles and different installed versions have independent synthetic controls. The binding program uses native module resolution options per source file. It does not perform a project build, infer arbitrary value propagation or prove dynamic runtime impact. Unavailable declarations, ambiguous configurations and unsupported loading remain explicit issues. Lookalike candidates use bounded name similarity and distinct compiler symbols; the list is not exhaustive.

The optional report writer creates one new JSON file in the workspace root and never overwrites an existing file. Its response contains a few sample facts and exact omission counts; the file retains every collected fact and issue. The artifact is evidence, not a task specific final answer. Every benchmark condition has the same file policy. Analysis sessions may create only their requested answer file and must transform that file to the required schema.

The prototype has no persistent index or warm session advantage. Provider initialization and each collection run are charged inside the model session. Source snapshots cover admitted inventory files; benchmark fixtures separately bind installed dependencies and toolchains before and after each session.

The first local probe is development qualification only. Actual Codex transport was qualified on independent scratch packages containing a unique source marker. No held out target, source or answer was used to implement or tune this provider. Performance claims require separate measured sessions and independent correctness review.
