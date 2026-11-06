# Fixture preparation correction

Earlier cross package protocols described Node directory copies as APFS clones. That physical copying claim was unverified. In the installed Node22.23.1 source, the directory fast path does not receive the requested cloning mode. A filtered path using that mode returns ENOSYS on this host. The [recorded mechanism audit](copy-mechanism-audit.json) retains the evidence. Source hashes, modes, literal symlink targets and independent writes were checked separately and remain valid.

The first confirmation attempt also retained upstream Git metadata. Creating a new baseline commit on the already committed tree failed before any provider or model session. Its [reproducer](git-failure-reproducer.json) and [original failed preparation](../confirmation-001/preparation-failure.json) remain recorded.

The new helper calls macOS clonefile for each admitted regular file and symlink, requires success without a copy fallback, checks independent file identity and preserves modes and link text. It excludes upstream Git directories. Both [clean fixtures](clean-fixtures.json) match the original admitted source and dependency hashes. Separate [qualification copies](canonical-qualification.json) each produce one independent commit with exactly 700 tracked source files. The helper and exact Python executable are bound into the new study.

Copying is common fixture preparation, reported separately from charged provider and agent time. This correction does not change recorded model tokens, session durations or correctness results. It does not establish a performance advantage. The candidate, task facts, prompts, graders and comparison rules remain unchanged.
