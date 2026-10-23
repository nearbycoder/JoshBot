# Pure helper optimization evidence, 2026-10-23

Two helper changes reduced work in a fixed offline comparison while preserving the checked outputs. This is a focused **shared-host diagnostic**, not an isolated-host benchmark, production release gate, deployment result, or cloud cost estimate. Every planned sample is retained in [bench-agent-helpers.results.json](../../scripts/bench-agent-helpers.results.json). No sample was discarded or rerun.

## Source and scope

The measured baseline was clean commit `a280238d7c1eba791c916a2592eedd0584694fdd`. The measured candidate was clean child commit `8532acaef2079887258f7dda246bee12222291b3`, containing:

- `31fbae4c73cab2eff801ac0f4d7439a2f2961f54`: span pagination in `lib/agent-features/feature-kit/command-and-display.ts`, with differential and CSV tests in `tests/agent-feature-kit.test.ts`.
- `8532acaef2079887258f7dda246bee12222291b3`: allocation-free escape counting in `lib/agent-features/budgets.ts`, with new `tests/agent-context-measurement.test.ts`.

Only the two helper source files differ between the 235-file application/build input manifests. The measurements are of those child commits, **not the subsequently integrated root or other agents' changes**. The evidence commit adds only this document and the new results file. Existing benchmark scripts, historical results and the performance guide are unchanged.

The source-manifest SHA-256 values are `8ee919f700dc994191599fe2d33cd8a2b2e760a5bad66e2b058b3b780d2dbc9c` before and `0429fd52af9f9cffe21e2f0fe88061e2eb4c341a0fe34f2d760db7c97e6e55b0` after. Individual file content hashes and Git blob IDs for the four owned files are persisted in the results. The two implementation-file SHA-256 pairs are:

- `command-and-display.ts`: `d7d9d9866c3abd9449e31ad037b2599b38132d3e5043399b7f11b6ae90bb0d2a` → `cdb7cd5e8be726b258b0c7dcb13a052fa5bdfe1d5eeb427da3166f11322328cc`.
- `budgets.ts`: `002840187cb16b6cafc022f097c0bf45f02ffe03e759a9701c61d0366f610226` → `4db7291e01a2ea96fc17305bcde57a57978adce15fd1d45ca0c3cbb7e4bb4379`.

Pagination retains the original token-count header reservation, full page objects and boundaries, callback sequence, plain/mrkdwn rendering, Unicode boundaries, atomic URLs/commands/identifiers, validation and error bounds. Context sizing retains native UTF-8 byte counting and all existing traversal, optional-value, error, node/depth and capacity behavior. Schema, quotas, admission, pending physical work, deadlines, yields, receipts, caches and reply caps were not changed. Broader stored-state serialization and CSV stamp changes were deferred.

## Fixed comparison and measurement boundaries

Exactly 24 fresh workers ran from **2026-10-23T07:41:00.701Z to 2026-10-23T07:41:09.974Z**: four workloads, three before/after pairs each. Pair order was before/after, after/before, before/after within each workload. There were no application warmup calls, retries, profiles or additional release series. Each worker used Node **24.22.1**, a **1 GiB** old-space ceiling and a **30-second** timeout. All completed successfully with no network attempts. Services were fake or forbidden; no live provider, search, Slack or production Redis calls occurred.

The Linux x64 host reported AMD RYZEN AI MAX+395. Per-sample UTC start/end, 1/5/15-minute load and free memory are retained. Load ranges during the window were **29.42–31.62 / 31.02–31.49 / 19.08–19.13**. Root deferred heavy tests, and the UX reviewer reported being idle; the context implementation owner might have run small tests. Other host activity was not controlled. These observations do not establish isolation.

There was one explicit `globalThis.gc()` after module import and fixture/oracle setup, before timing, identically for each worker. No manual GC ran inside timed work; natural GC and assertion work remain included. The pure helpers were transformed identically with Node's `stripTypeScriptTypes`. CSV used actual production Vite artifacts: the retained baseline build and a candidate build prepared before the measurement window. Build and worker-startup CPU are not part of the reported workload CPU.

CPU is process user+system time; wall time measures the outer workload call after setup. CSV also records the original harness's active request window. Its outer wall time includes the existing event-loop monitor's 20 ms setup and 20 ms teardown waits; active wall/CPU exclude those waits. No new waits were introduced. The original CSV monitor values are preserved, including the third pair's loop maximum **30.425 → 30.720 ms**; improvements are not claimed for every metric.

RSS is Linux whole-process **VmHWM** through measurement completion, including imports, fixture/oracle setup and GC. It is neither active-only memory nor retained heap or allocated bytes; no peak subtraction was performed. Escape-heavy fixture/oracle setup can establish the process peak before measurement, so lower allocation does not imply a lower reported peak.

## All three samples

Values below retain sample numbers **1 / 2 / 3** for each variant, before → after, without best-sample selection or averages. The results file also preserves actual execution order and full precision.

**Pagination, 40 calls alternating plain/mrkdwn:** each input has 25,085 UTF-16 units / 30,085 UTF-8 bytes, mixed prose and explicit atomic URL/identifier parts. Each worker returns 380 total pages. Joined bodies equal the input, every page is well-formed and at most 3,500 units, and both variants have the same first plain/mrkdwn page-object digest: `bd94e88acfa2246960474c590559dd7c2f6745ab2738e89c42f69ab1d4f0fec4`.

- Wall ms: **257.821 / 369.578 / 350.382 → 46.986 / 42.669 / 42.995**.
- CPU ms: **428.843 / 567.296 / 567.695 → 83.351 / 83.690 / 90.442**.
- Whole-process peak RSS MiB: **98.207 / 101.059 / 137.039 → 60.398 / 60.270 / 62.086**.

**Actual CSV lifecycle:** every worker completes 26/26 commands, 40×8 = 320 cells, ten duplicate groups and all 19 pages. Assertions cover canonical CRLF CSV, preview/apply/undo, exact restored cells, and concatenated show JSON equal to exported JSON before/after undo. Source is 663 bytes, saved state 8,893 bytes and export 8,917 bytes; backend counts stay 29 reads / 4 writes. This numeric-cell performance fixture is supplemented by the existing Unicode/quoted-CSV correctness tests.

- Outer wall ms: **289.583 / 256.124 / 229.644 → 137.093 / 132.623 / 130.704**.
- Outer workload CPU ms: **402.077 / 329.811 / 277.505 → 156.275 / 164.426 / 151.473**.
- Active request wall ms: **246.843 / 213.950 / 188.224 → 94.868 / 89.318 / 90.402**.
- Active request CPU ms: **399.524 / 322.044 / 275.252 → 154.204 / 147.417 / 149.334**.
- Whole-process peak RSS MiB: **105.781 / 96.953 / 102.863 → 66.324 / 67.820 / 66.262**.

**Ordinary context byte counting:** twelve calls over 600 source records, each exactly 980,671 JSON bytes, for 11,768,052 measured bytes per worker. Each result equals `Buffer.byteLength(JSON.stringify(items))`. This measures the helper, not full recall ranking or end-to-end request latency.

- Wall ms: **37.722 / 66.676 / 46.718 → 32.880 / 39.191 / 30.751**.
- CPU ms: **52.476 / 83.425 / 64.763 → 47.525 / 54.201 / 41.454**.
- Whole-process peak RSS MiB: **65.625 / 65.953 / 65.883 → 62.000 / 61.684 / 61.859**.

**Escape-heavy context stress:** twelve calls over 600 records, each exactly 10,516,691 JSON bytes, for 126,200,292 measured bytes per worker. Strings contain CJK, emoji, quotes, backslashes, controls, paired and lone surrogates, including nested metadata. The same native JSON byte oracle is checked for every call. This deliberately dense escape fixture must not be presented as a typical user workload.

- Wall ms: **1028.494 / 1184.901 / 1330.139 → 250.278 / 265.987 / 398.267**.
- CPU ms: **1043.090 / 1202.728 / 1325.996 → 275.404 / 294.366 / 365.491**.
- Whole-process peak RSS MiB: **81.488 / 81.387 / 81.629 → 81.426 / 81.316 / 81.551**. These peaks are essentially unchanged; no memory-peak saving is claimed for this case.

Earlier diagnostic heap profiles estimated 104.386 MiB under CSV pagination and 3,086.392 MiB under the escape-heavy string-sizing helper. Those estimates include collected objects and profiler overhead; they are cumulative allocation, not RSS. They motivated the changes but are **not** an after-change allocation comparison. No new allocation profile or allocation-saving percentage was measured.

## Portable correctness checks

With existing project dependencies and Node 24.22.1, these commands are portable from the checkout root:

```sh
node --max-old-space-size=1024 --import tsx --test --test-concurrency=1 tests/agent-feature-kit.test.ts tests/agent-data-cleanroom.test.ts
node --max-old-space-size=1024 --import tsx --test --test-concurrency=1 tests/agent-context-measurement.test.ts
node --max-old-space-size=1024 --import tsx --test --test-concurrency=1 tests/agent-performance.test.ts tests/agent-runtime.test.ts
npm run typecheck
git diff --check
```

The author ran equivalent commands on a temporary source copy using the existing read-only dependency directory and absolute tsx/tsc entrypoints: **31/31**, **4/4**, and **56/56** tests passed, with zero failures/skips/cancellations. Type checking and diff checking passed for this child checkout. This does not claim a typecheck result for the integrated root or other agents' changes.

The pagination test freezes the original a280238 algorithm and compares complete page objects, error name/message and callback sequence against 600 seeded mixed cases plus header-digit thresholds, maximum inputs, empty atomic parts, Unicode, entity expansion, automatic/explicit atomic spans and invalid inputs. The registered CSV test proves the 26-command/19-page lifecycle. Context tests cover all 65,536 UTF-16 code units in values and keys, 4,913 boundary triples, 600 seeded metadata cases, optional/array behavior, repeated references, unsupported values/cycles/getter errors, exact 16 MiB byte ceilings across seven character classes, and exact item/node/depth boundaries.

Independent integration review is parent-owned. The existing portable production Vite 30-sample gate is a separately coordinated follow-up; these measurements do not replace it.

## Retained local evidence and reproduction limits

The comparison driver is the historical local artifact `/tmp/joshbot-helper-optimization-20261023/compare.mjs`, SHA-256 **`42b2638b1f12b22ad42690be791ed555d420768e3b775dfa4fb0b95af7f87df5`**. It contains author-specific checkout and temporary paths and imports `/tmp/joshbot-release-5A6pQX/scripts/research-harness.mjs`, SHA-256 **`daf50c5e4b43fefc8a46cfc5f559e52c8def39b226ab08d30e5ca487011f4d74`**. That earlier temporary harness exposes the original `csvWorkload`; the repository benchmark script was not edited. The driver and harness are **not repository-portable reproduction tools** and might not exist on another machine.

Retained local files are `comparison-manifest.json`, `comparison-raw.jsonl`, `comparison-report.json`, individual worker JSON/log files and correctness logs under `/tmp/joshbot-helper-optimization-20261023/`. Baseline and candidate runtime builds are `/tmp/joshbot-release-5A6pQX` and `/tmp/joshbot-release-D4luFP`. These are historical local evidence references only, not repository prerequisites.

The repository results file copies every per-worker JSON object verbatim, retaining all 24 observations, exact outcomes, host/GC metadata, the workload plan, complete source manifests, generated helper hashes, driver/harness hashes and individual sample hashes. It is inspectable without those temporary paths. All 28 original research artifacts under `/tmp/joshbot-research-20261023/` remain untouched; the recovery analysis and integrity manifest remain under `/tmp/joshbot-profile-recovery-20261023/`. No benchmark or profile was run for this evidence-only persistence step.
