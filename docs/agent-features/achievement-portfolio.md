# Achievement portfolio

Locally implemented; unregistered; not deployed. Integration, independent review, CI and release remain parent-owned.

The catalog example saves the onboarding challenge. Add the personal guide-writing action, measured result `12 | requests per month | 20`, the support-summary excerpt and Maya's review contribution. `story` reports **20 → 12 requests per month**, a decrease of **8** and **40% using denominator 20**. These are labeled user measurements. The report does not infer that the action caused the result. Personal action and team attribution occupy separate exact sections; `bullets` gives a concise variant and `story` retains complete evidence.

Every field can be changed or explicitly cleared; evidence excerpts can be edited or removed individually. Numeric spellings, units and baseline are preserved; arithmetic uses bounded fixed-point integers and discloses percentage rounding. Missing result/evidence/attribution remain visible. URLs are inert text.

`polish ID | review` or `polish ID | resume` uses one optional call solely to choose one of three finite section orders. It must return every existing evidence ID exactly once. The renderer owns all wording that states facts, metrics, personal/team attribution, privacy and evidence, so malicious extra prose cannot contradict protected facts. No free-form generated wording is displayed. All allowed layouts are considered for minimum complete raw/reply preflight; a draft that cannot fit 3500 units is refused before the call. Input is at most 16000 UTF-8 bytes, instructions 4000 bytes, accepted raw output 4000 units. The current content stamp is reread after generation; edits/deletion/cancellation discard the unsaved result. Provider failure preserves deterministic story/bullets.

There is no stored mandatory assessment or preview lifecycle for this feature: stories and polish remain unsaved. The lifecycle projection reserves maximum root revision digits for each accepted achievement; optional entered text is content admission, never a reserve bypass.

## Complete command grammar

```text
Achievement portfolio — Turn concrete work into evidence-backed accomplishment stories for reviews or applications.
Start: /nobo-help agent achievement-portfolio create Simplified onboarding | New users struggled with setup
Then: action ID | PERSONAL_ACTION; result ID | RESULT | VALUE | UNIT | BASELINE (leave baseline blank if unknown); evidence ID | LABEL | EXCERPT; collaborators ID | TEAM_CONTRIBUTION; privacy ID | NOTE.
story ID [PAGE [rev TOKEN]]; bullets ID [PAGE [rev TOKEN]].
Edit any entered field: edit ID | FIELD | VALUE; clear ID FIELD confirm. Fields: title, challenge, action, result, collaborators, privacy, metric.value, metric.unit, metric.baseline.
evidence-edit ID EVIDENCE | LABEL | EXCERPT; evidence-remove ID EVIDENCE confirm.
Optional: polish ID | review OR polish ID | resume. One unsaved structural rewrite; finite model-selected ordering, renderer-owned exact facts, all evidence IDs required. Long complete drafts are refused before generation. No free-form generated claims.
Limits: title/labels/unit 160 UTF-8 bytes; other text 1000 bytes; excerpts 500 string units/2000 bytes; plain decimals up to 12 integer/6 fractional digits. Unknown metric fields remain unknown. No context reads.
Use returned full IDs. Pipes separate fields; escape literal pipes as \| and backslashes as \\. Private, on demand; no search or external actions.
Manage: list [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID confirm. Detail continuations are revision/content-bound.
Capacity: 20 achievements; 8 evidence excerpts of 500 characters each. New content 32768 UTF-8 bytes; hard cap 49152; complete export 24576. Bytes may fill first. Explicit removal only.
```

## Storage and safety

Version 1 state is scoped by workspace, user and feature. Each accepted root and all children are fully retrievable with `show` continuations; concatenating page bodies reconstructs the exact JSON. `export` is one complete JSON envelope. Lists explicitly recompute. Every saved/derived continuation binds numeric revision and SHA-256 of content. Plain slash replies retain literal mentions and URLs without activation.

All updates capture the intended record content before the retryable CAS transform. Unrelated record edits can retry; same-record changes or deletion reject. Confirmed removals must strictly reduce serialized bytes, remain available at the root revision ceiling, and change the content stamp without reusing a write clock. At that ceiling ordinary/lifecycle writes refuse with export and whole-record deletion guidance. Malformed state is preserved. Schema-valid over-quota legacy state can be incrementally removed. Backend/provider diagnostics remain private; ambiguous dispatched saves require inspection before retry. No silent eviction, hidden history, background jobs or service caches.

New content admission checks a feature-specific worst-case lifecycle projection against both the full-state and per-export caps. Optional long additions still count as content. Limits are serialized UTF-8, including JSON escaping. No model output-token/billing ceiling is claimed. Tests use Node 24, the real runtime/scoped store, injected memory backend and fake/throwing services; they establish no production quality or performance claims.
