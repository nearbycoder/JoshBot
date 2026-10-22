# Skill evidence matrix

Locally implemented; unregistered; not deployed. Integration, independent review, CI and release remain parent-owned.

`create Backend role` returns a matrix ID. Add `Database design | 3 | Can explain schema and migration tradeoffs`, self-rate it 2, and attach the dated migration example. `gaps` reports the known gap **3 − 2 = 1**, separately labels an unrated skill unknown, and calls an unsupported rating unsubstantiated. The order is descending known gap, then unknowns, with stable skill-ID ties. This is personal development planning, never candidate ranking.

Every skill stores five visible rubric definitions. The target command supplies one custom definition; edit all other definitions explicitly with `rubric`. Clearing any definition prevents new ratings until it is restored. Skill name/target, rubric and evidence edits invalidate the old rating/reflection by clearing them; there are no semantic version counters or hidden assessment histories to reuse. Dated examples remain exactly supplied. Civil-date age is shown as age, including an explicit future-date label, not as skill decay. Current reflection is bounded and replaceable.

The lifecycle projection reserves a full worst-case JSON-escaped 320-byte reflection, one self-rating and maximum revision digits for every admitted skill, across every matrix. Both ratings and reflections can be entered at saturated admitted content. No generation, search or context calls occur.

## Complete command grammar

```text
Skill evidence matrix — Compare self-assessed skills with a target role and keep demonstrated evidence distinct from confidence.
Start: /nobo-help agent skill-matrix create Backend role
Then: skill MATRIX add NAME | TARGET_0_TO_4 | TARGET_DEFINITION; self-rate MATRIX SKILL | LEVEL; evidence MATRIX SKILL | YYYY-MM-DD | EXAMPLE; gaps MATRIX [PAGE [rev TOKEN]]; review MATRIX SKILL | REFLECTION.
Edit: edit MATRIX | title | VALUE; clear MATRIX title confirm.
skill MATRIX edit SKILL | FIELD | VALUE (name or target); skill MATRIX clear SKILL name confirm; skill MATRIX remove SKILL confirm.
rubric MATRIX SKILL | LEVEL_0_TO_4 | DEFINITION; rubric-remove MATRIX SKILL LEVEL confirm.
assessment-remove MATRIX SKILL FIELD confirm (self or reflection).
evidence-edit MATRIX SKILL EVIDENCE | YYYY-MM-DD | EXAMPLE; evidence-remove MATRIX SKILL EVIDENCE confirm.
Each skill starts with explicit five-level definitions; custom target definition replaces that level. Skill/rubric/evidence edits clear dependent self-rating/reflection; no retained assessment history. Required target is removed with its skill.
Limits: title/name 160 bytes, each rubric/reflection 320 bytes, example 1000 bytes. Review overwrites the current reflection. No model or context reads.
Use returned full IDs. Pipes separate fields; escape literal pipes as \| and backslashes as \\. Private, on demand; no search or external actions.
Manage: list [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID confirm. Detail continuations are revision/content-bound.
Capacity: 10 matrices; 24 skills and 3 evidence records per skill. New content 32768 UTF-8 bytes; hard cap 49152; complete export 24576. Bytes may fill first. Explicit removal only.
```

## Storage and safety

Version 1 state is scoped by workspace, user and feature. Each accepted root and all children are fully retrievable with `show` continuations; concatenating page bodies reconstructs the exact JSON. `export` is one complete JSON envelope. Lists explicitly recompute. Every saved/derived continuation binds numeric revision and SHA-256 of content. Plain slash replies retain literal mentions and URLs without activation.

All updates capture the intended record content before the retryable CAS transform. Unrelated record edits can retry; same-record changes or deletion reject. Confirmed removals must strictly reduce serialized bytes, remain available at the root revision ceiling, and change the content stamp without reusing a write clock. At that ceiling ordinary/lifecycle writes refuse with export and whole-record deletion guidance. Malformed state is preserved. Schema-valid over-quota legacy state can be incrementally removed. Backend/provider diagnostics remain private; ambiguous dispatched saves require inspection before retry. No silent eviction, hidden history, background jobs or service caches.

New content admission checks a feature-specific worst-case lifecycle projection against both the full-state and per-export caps. Optional long additions still count as content. Limits are serialized UTF-8, including JSON escaping. No model output-token/billing ceiling is claimed. Tests use Node 24, the real runtime/scoped store, injected memory backend and fake/throwing services; they establish no production quality or performance claims.
