# Process memory comparison

Typelatch used less sampled serving RSS than CodeGraph on both measured corpora, but more than Graphify while its search worker was retained. After 31 seconds of inactivity, Typelatch had released that worker and used less sampled RSS than either comparator. This is a measured lifecycle tradeoff, not an overall memory superiority claim.

The run completed on 6 October 2026 with three rotated rounds for each provider and corpus. All 18 queries returned the expected source path. No query errors, sampling errors, absent serving roots or residual observed processes occurred. A separate readback verified every RSS sum, response hash, aggregate and rotation.

Evidence: [public JSON report](../benchmarks/process-space.json), [compressed samples and complete responses](../../artifacts/competitive/process-space/2026-10-06T15-00-27.459Z/samples-and-responses.json.gz), [integrity readback](../../artifacts/competitive/process-space/2026-10-06T15-00-27.459Z/integrity.json), and [exact executed runner](../../artifacts/competitive/process-space/2026-10-06T15-00-27.459Z/executed-runner.mjs).

## Serving observations

Values are MiB. Baseline and idle columns are the median of each round's median. The sampled maximum column is the median of the three observed serving maxima. A fresh server handles one query against an already prepared index in each round.

| Corpus | Provider | Baseline | Sampled maximum | Retained idle | Idle at 31 to 32 seconds |
| :--- | :--- | ---: | ---: | ---: | ---: |
| Small | Typelatch | 74.52 | 209.58 | 209.58 | 65.34 |
| Small | CodeGraph | 231.72 | 319.75 | 319.44 | 319.75 |
| Small | Graphify | 81.78 | 81.86 | 81.86 | 81.86 |
| Repository | Typelatch | 74.91 | 209.64 | 209.64 | 65.50 |
| Repository | CodeGraph | 232.41 | 327.80 | 327.52 | 327.80 |
| Repository | Graphify | 83.14 | 83.84 | 83.84 | 83.84 |

Typelatch had two observed processes throughout the retained idle window and one throughout the late idle window in all six sessions. The root MCP process remained alive. Its lower late reading therefore reflects worker retirement, not server failure. The retained idle window begins 250 ms after the query returns and ends at two seconds.

The three serving maxima ranged from 208.88 to 209.98 MiB for Typelatch, 319.02 to 319.78 MiB for CodeGraph, and 81.67 to 81.98 MiB for Graphify on the small corpus. On the repository corpus, the ranges were 209.64 to 209.69, 326.91 to 328.17, and 83.83 to 84.23 MiB respectively. These ranges describe these runs; they are not confidence intervals.

## Setup observations

Index preparation uses a separate process tree before the measured server starts. These are medians of three observed setup maxima in MiB. Setup commands and their full output remain in the capture.

| Corpus | Typelatch | CodeGraph | Graphify |
| :--- | ---: | ---: | ---: |
| Small | 258.53 | 434.78 | 48.64 |
| Repository | 284.25 | 446.69 | 560.72 |

Graphify used 12 observed processes at the repository extraction maximum. Adding RSS across these processes can count shared mappings repeatedly. Its higher summed setup value does not establish that it consumed more unique physical memory. Graphify also reported that one repository code file yielded no modeled symbols. That warning is preserved and does not prevent the expected query target from being found.

## Scope and protocol

The small fixture contains nine files and 2,301 bytes. Its query is `calculateInvoiceTotal`, with `src/billing.ts` as the access control. The repository fixture contains 45 files and 260,480 bytes from Typelatch commit `0053a7fbb1c8f8e7b3572145f2e64e18e8dc7125`. Its query is `validateWorkspace`, with `src/workspace/validate.ts` as the access control. The repository paths are `src`, `README.md`, `docs/USAGE.md` and `docs/ARCHITECTURE.md`. These small authored corpora do not establish large repository behavior.

The executed Typelatch candidate is frozen and uses `detail: "compact"`. Its build, source, actual dependency files and Node executable are hashed. The candidate's original dependencies resolve through a shared checkout symlink, so the runner first copies them into a private runtime and hashes that resolved copy. This pins what ran without assuming that the candidate lockfile alone identifies every installed byte. Later main checkout changes are outside this result.

Comparators are `@colbymchenry/codegraph@1.6.2` and Graphify `0.9.77`. The report pins their installed file manifests, the CodeGraph launcher and bundled Node executable, and Graphify's Python executable and distribution. All installation and runtime manifests were unchanged after the run. Isolated home, configuration and cache directories prevent setup from discovering the user's agent configuration. Update checks, telemetry, Graphify query logging and skill auto refresh are disabled.

For each corpus, round one runs Typelatch, CodeGraph and Graphify. Round two runs CodeGraph, Graphify and Typelatch. Round three runs Graphify, Typelatch and CodeGraph. Only one measured provider session runs at a time. Each session includes startup and MCP tool discovery, one second of baseline sampling, one query, early idle sampling and sampling through 32 seconds after the query returns. A fresh workspace copy and separately prepared index are used for every session.

The sampler reads `ps` RSS in KiB and converts it to bytes. It starts from the transport PID, includes the npm launcher where present, recursively follows descendants, and retains already observed descendants after reparenting. The benchmark controller, sampler and unrelated processes are excluded. There are 2,521 serving samples and 167 setup samples in the capture.

Sampling schedules the next observation after 25 ms during startup, setup and the query window, and after 200 ms while idle. Running `ps` and host scheduling add time. Every raw sample records its timestamp and duration; the report records the largest actual gap per session. The query window also includes samples immediately before the request and after its response. Its maximum must not be interpreted as an allocation peak captured strictly inside the call.

## What remains unproven

RSS sums are not unique physical memory, proportional set size or reclaimable memory. They may count shared pages more than once and exclude compressed or nonresident pages. Sampled maxima can miss short lived processes and allocation spikes. A descendant that detaches before any observation can be missed. No daemon mode was requested.

The operating system cache was not purged. The host was not dedicated, and other desktop applications or short validation commands could run. Free memory and load observations are recorded at each session boundary. These factors can affect residency and timing. No speed claim follows from this memory run.

The returned context is not equivalent across providers. Graphify uses local code extraction without clustering or model calls and returns graph context, while Typelatch returns source previews and CodeGraph returns a different code packet. Matching the expected source path confirms usable retrieval access for this measurement, not equal source completeness or coding quality. No model token, completed coding task or broader language claim follows from these results.

Installation disk use, index disk use, initial indexing memory, active serving memory and idle memory remain separate dimensions. See the existing [installation report](../benchmarks/install-space.json) and [competitive comparison](../COMPETITIVE.md) for the other measurements.

## Next falsifiable improvement

The frozen search worker eagerly loads TypeScript through both the search index and lockfile modules, even when an existing workspace index is unchanged. The lockfile module also eagerly imports the YAML and Yarn parsers. Loading each parser only when its input format or a changed source file requires it is a concrete optimization candidate. It must preserve exact identities, current content hashing, rebuild behavior, cancellation and result parity before being adopted.

That change could lower memory for existing indexes. It does not by itself prove that Typelatch can beat Graphify during active serving, and it cannot remove the parser cost when rebuilding TypeScript declarations. Changing the idle timeout would also change repeated query latency; the next run must report that tradeoff rather than selecting a favorable idle window.

## Reproduce

Use the isolated pinned comparator installations described in [the baseline research](competitive-baseline.md). Prepare the repository fixture with the existing repository comparison runner first. The memory runner verifies each repository fixture file against its recorded Git object and captures the complete manifest.

```sh
TYPELATCH_CANDIDATE=/absolute/path/to/built/candidate \
CODEGRAPH_BIN=/absolute/path/to/codegraph-install/node_modules/.bin/codegraph \
GRAPHIFY_PYTHON=/absolute/path/to/graphify-environment/bin/python \
node scripts/benchmark-process-space.mjs
```

The runner does not build or change product source. It creates isolated temporary runtime and workspace copies, writes the public report to `docs/benchmarks/process-space.json`, and retains full evidence under `artifacts/competitive/process-space`. `PROCESS_SPACE_REPORT` selects a different report path. A `--smoke` invocation runs a shorter incomplete capture and cannot set `complete` to true.
