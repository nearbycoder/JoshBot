# Workflow optimization release verification, 2026-10-23

The integrated optimization passed the existing offline production-Vite release gate. This is a local shared-host verification, not a deployment result or a cloud-cost estimate.

Changes include conversational catalog matching, actionable first-step guidance, canonical recall recovery commands, span pagination, nonallocating context escape counting, and bounded optional Redis batch reads. All 70 IDs and canonical metadata/resource budgets remain unchanged. See [helper measurements](helper-optimization-evidence.md) and [batch contract and measurements](backend-batch-reads.md) for the separate before/after diagnostics and their tradeoffs.

## Exact gate and retained history

Run `f57bbfb7-42f8-4f3c-ac75-858a5406d58f` used source HEAD `ce3b0e74ad65be081993efdc52d131fa6631fd4b`, source manifest SHA-256 `17f11452f4163b5114284d7b523b272684422d154bc646faea3756c7203abc1d`, Node 24.22.1, and the unchanged `scripts/bench-agent-release.mjs` (SHA-256 `737ac81b52cc4b2c1a314170068b366bb82ffae926aca0d582403280e7083066`). The command was `node --max-old-space-size=1024 scripts/bench-agent-release.mjs --final --check`. The source-status entry reports only the results file being appended by the harness.

The planned three fresh samples of ten workloads completed from 2026-10-23T07:55:37.385Z through 2026-10-23T07:55:58.270Z. There was one series, no timing reruns, warmups, profile run, threshold change, or sample removal. All 117 prior history events remain structurally identical; all 30 new samples and build/parity/preflight/gate/cleanup events are retained in [the raw history](../../scripts/bench-agent-release.results.json). No app test workers or task-owned Redis servers were active during this series; other host activity was uncontrolled. Each sample retains host load and memory observations.

The existing gate passed: runtime peak RSS ≤256 MiB; deterministic mixed p95 ≤50 ms; recall p95 ≤250 ms; event-loop maximum ≤150 ms in the gate's established runtime/active-request windows. Setup/import and full-server windows remain separately reported. No forbidden network attempts occurred. The 70-registration/50-addition parity check passed.

Values below are sample 1 / 2 / 3. CPU is whole-worker user+system time including setup/import; RSS is Linux whole-process VmHWM, without subtraction. Loop values use the established active request window for context/policy/CSV, the complete runtime window for runtime, and the ungated whole-server window for server. These different windows must not be interchanged.

| Workload | Loop max ms | Whole-process peak MiB | Whole-worker CPU ms |
| --- | --- | --- | --- |
| runtime | 78.053 / 116.261 / 102.433 | 190.140 / 144.650 / 190.030 | 1036.640 / 988.480 / 1086.100 |
| adapter-six | 41.779 / 48.234 / 45.351 | 144.965 / 143.203 / 134.352 | 394.214 / 402.398 / 405.096 |
| meeting-prep | 50.561 / 51.249 / 46.236 | 123.867 / 124.082 / 122.957 | 325.697 / 316.846 / 372.722 |
| morning-brief | 85.524 / 63.603 / 76.022 | 123.535 / 123.250 / 124.285 | 367.627 / 332.839 / 341.817 |
| weekly-review | 54.657 / 63.078 / 67.240 | 140.891 / 139.156 / 139.340 | 345.973 / 343.138 / 389.915 |
| capacity | 30.720 / 30.261 / 23.151 | 127.711 / 127.562 / 127.820 | 351.604 / 352.912 / 319.385 |
| policy | 12.730 / 14.467 / 13.165 | 280.211 / 279.875 / 281.168 | 1002.507 / 931.413 / 1038.348 |
| csv | 29.835 / 24.887 / 27.722 | 68.035 / 67.477 / 68.902 | 172.698 / 133.284 / 166.294 |
| server | 882.377 / 875.037 / 843.055 | 310.730 / 319.195 / 310.148 | 1369.231 / 1338.455 / 1340.034 |

Runtime mixed deterministic p95 was 30.670 / 28.871 / 31.913 ms; recall p95 was 47.246 / 41.925 / 51.641 ms. Every burst kept 96 offered / 9 accepted / 87 explicit busy responses, at most three physical context calls. Every mixed workload completed all 60 requests: 45 deterministic and 15 recall. Admission rejection is not throughput improvement.

All source-count and byte oracles passed, including six-group 1,500 records / 23,575,616 bytes; meeting/morning 600 records / 29,339,745 bytes; weekly 600 / 21,945,013 bytes; over-total 540 / 39,574,473 bytes visibly rejected with the prior snapshot intact. CSV retained all 26 commands, 19 pages, and exact restored/exported cells. Policy work settled fully and retained permits for pending physical work.

The release harness's source fixtures use a serial fake backend. It verifies integrated behavior and responsiveness; it does not measure the default Redis Lua path or WAN RTT. Actual default-backend comparisons are retained separately in the batch guide, including slower zero-added-latency consumers, increased Redis server work, missing per-worker UTC/load, and variable process CPU/RSS. Full-server setup/import and policy import RSS are not covered by the dedicated-feature 256 MiB limit. No blanket CPU, memory, production latency, or cloud-billing savings are established.

## Correctness and independent review

Before this gate, the integrated root passed 1,868 repository tests with zero failures/skips, including isolated Redis 7.2.10 and scheduler fixtures. The final test-only batch additions subsequently passed all 73 affected context/performance tests. Full repository typecheck, production Vite build, whitespace checks, and production dependency audit passed; the audit reported zero vulnerabilities. CI remains required before merge.

Independent review approved each scope without P1/P2/P3 findings: workflow UX (99 tests plus parser/cold checks), pure helpers (125 tests plus 868 independent pagination comparisons), and batching (127 focused tests plus nine independent probes, including 100 real-Redis error-order comparisons). Counts overlap and are not summed. Reviews excluded the final timed series; the parent validated its unchanged gate and retained event history.

Cancellation, original deadlines, pending physical-work retention, tenant provenance, revocation/freshness, complete retrieval, logical quotas, byte bounds, and explicit completion remain enforced. Publication and deployment are separate subsequent steps; this document records verification only.
