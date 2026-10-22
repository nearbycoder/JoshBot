# Goal alignment

Locally implemented; unregistered; not deployed. Integration, independent review, CI and release remain parent-owned.

Create `November effort`, discover all owned goal IDs with `goals`, and explicitly select a source. Add `Write onboarding guide | 120`, link 75% with your reason, and `review` reports **90 aligned minutes and 30 unallocated minutes**. Shares sum to at most 100% per activity; unknown effort is not spread evenly. Local goal labels are a separate explicit alternative, with no claimed source identity. Activities and links remain user planning assumptions, never evidence of goal completion or causal impact.

`goals` enumerates every available goal within the actual adapter's 100-item bound. Its detail route exposes each complete adapter source without selecting it. Both discovery and source-detail continuations bind board revision/content and a fingerprint of the complete source set. Every source operation calls `readContext(['goal'])` exactly once and never queries another namespace directly. Each source is validated separately so the full 100-source discovery is not limited by the selected-snapshot byte cap. Selection retains the exact source ID, title/text, update instant, civil deadline, source status, target/current/unit/history/provenance/coverage and fingerprint, with capture time and owning workspace/user. Unknown coverage remains unknown; adapter truncation flags are disclosed, never silently erased. The selection cap is ten goals and 8000 UTF-8 bytes of source `text` combined; other retained fields also count toward serialized state/export budgets.

`refresh` rechecks the current complete permitted snapshot once. Unchanged evidence is labeled unchanged; changed evidence keeps its saved historical content until explicit `replace ... | confirm`; absent or revoked sources become absent/unverified without deleting history or allocations. Reappearance is checked again by fingerprint. Source failures are caught before any board save is dispatched, with explicit incomplete goal-read guidance, the 100-goal source limit, verified toolbox export/delete commands and a local-label alternative. Typed capacity errors add a fixed capacity diagnosis; arbitrary exception text is never echoed. Cancellation retains its original signal reason. Source failure preserves prior state; it is never treated as an empty snapshot. `show`/`review` explicitly use historical saved context. Numeric status `done` may mean the adapter observed current >= target; it supplies neither a dated completion event nor proof of completion/impact. Denominators and progress history are semantically validated even during stored reads/deletes.

Admission projects every selected source's longest refresh verification/fingerprint/checked-time fields plus root revision growth. Fresh replacements and link reasons remain content admission; review requires no extra saved text. Full field and child editing/removal is supported, with destructive selection removal also removing its local shares. No source is mutated. All source-await saves bind the original full board content and check it inside every CAS retry. Integration tests use actual toolbox goal commands, `createAgentFeatureServices`, `createProductionContextAdapters`, real feature runtime/scoped store and a fake backend; no legacy artifacts, unscoped memory or live service is involved.

## Complete command grammar

```text
Goal alignment — See where planned effort contributes to your selected goals and where work has no stated purpose.
Start: /nobo-help agent goal-alignment create November effort
Then: goals BOARD [PAGE [rev TOKEN source FINGERPRINT]]; select BOARD | EXACT_SOURCE_ID; activity BOARD add LABEL | MINUTES; link BOARD ACTIVITY | GOAL_ID | PERCENT | REASON; review BOARD [PAGE [rev TOKEN]].
source BOARD SOURCE_ID [PAGE [rev TOKEN source FINGERPRINT]] retrieves full adapter source. Each source operation reads only goal context once, max 100 items. No silent selection/truncation. Selected sources: 10, summed source text <=8000 UTF-8 bytes.
Incomplete source read preserves history and dispatches no board save. Source limit: 100 goals. Check /nobo-help tools goals list; use /nobo-help tools goals export ID then /nobo-help tools goals delete ID confirm to reduce owned goals, and retry. Use the toolbox ID without toolbox:goals:. Or use local BOARD | LABEL; saved show/review/export stay available.
refresh BOARD checks current sources, preserving historical snapshots and labeling changed/absent. replace BOARD | SOURCE_ID | confirm explicitly replaces one with fresh evidence. Show/review are historical, with no refresh.
local BOARD | LABEL; local-edit BOARD LOCAL_ID | LABEL; goal-remove BOARD GOAL_ID confirm (also removes its board shares, never source data).
Edit: edit BOARD | title | VALUE; clear BOARD title confirm.
activity BOARD edit ACTIVITY | label OR minutes | VALUE; activity BOARD clear ACTIVITY label confirm; activity BOARD remove ACTIVITY confirm. Required minutes are removed with activity.
link again edits share/reason; unlink BOARD ACTIVITY GOAL_ID confirm. Shares 1–100%, summed <=100%; minutes 0–1000000. No equal allocation inferred. Limits: labels 160 bytes, reasons 320 bytes.
Numeric progress/status is not proof of completion or causal impact; source deadlines stay civil dates. Owned context is read-only. No model/search or hidden cross-feature reads.
Use returned full IDs. Pipes separate fields; escape literal pipes as \| and backslashes as \\. Private, on demand; no search or external actions.
Manage: list [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID confirm. Detail continuations are revision/content-bound.
Capacity: 10 boards; 10 selected goals and 30 activities each. New content 32768 UTF-8 bytes; hard cap 49152; complete export 24576. Bytes may fill first. Explicit removal only.
```

## Storage and safety

Version 1 state is scoped by workspace, user and feature. Each accepted root and all children are fully retrievable with `show` continuations; concatenating page bodies reconstructs the exact JSON. `export` is one complete JSON envelope. Lists explicitly recompute. Every saved/derived continuation binds numeric revision and SHA-256 of content. Plain slash replies retain literal mentions and URLs without activation.

All updates capture the intended record content before the retryable CAS transform. Unrelated record edits can retry; same-record changes or deletion reject. Confirmed removals must strictly reduce serialized bytes, remain available at the root revision ceiling, and change the content stamp without reusing a write clock. At that ceiling ordinary/lifecycle writes refuse with export and whole-record deletion guidance. Malformed state is preserved. Schema-valid over-quota legacy state can be incrementally removed. Backend/provider diagnostics remain private; ambiguous dispatched saves require inspection before retry. No silent eviction, hidden history, background jobs or service caches.

New content admission checks a feature-specific worst-case lifecycle projection against both the full-state and per-export caps. Optional long additions still count as content. Limits are serialized UTF-8, including JSON escaping. No model output-token/billing ceiling is claimed. Tests use Node 24, the real runtime/scoped store, injected memory backend and fake/throwing services; they establish no production quality or performance claims.

Persisted generated IDs require the exact role prefix and a full lowercase UUID: `board-UUID`, `local-UUID`, `activity-UUID`. Unknown prefixes, wrong roles, malformed lengths and non-string IDs make the whole stored state unreadable; reads and mutations preserve its exact bytes, with no relabeling or repair. External `toolbox:goals:SOURCE_ID` selections and allocations retain the owned toolbox adapter’s separate source-ID contract.
