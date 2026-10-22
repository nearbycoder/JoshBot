# Feedback theme review

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

Create `Quarterly feedback`, enter Peer A's dated review-meeting quote, add the manual Decision clarity theme and assign the quote. Retain the migration-note counterexample alongside it, then choose the response experiment about putting tradeoffs before the recommendation. `themes` shows complete quotation coverage, counterevidence and the current response experiment without performing it.

Frequency reports distinguish retained entries, distinct exact quote texts, duplicates of the entire supplied speaker/date/context/text tuple, separately entered evidence tuples, and distinct supplied speaker labels. Identical wording never inflates distinct-text frequency. A separately entered excerpt is not verified independent evidence, two labels are not verified people, and repetition is not consensus. No identity resolution, personality inference or sentiment-based diagnosis occurs. Quote edits unassign the changed evidence for manual reassessment; theme deletion unassigns retained quotes and explicitly removes its counterexamples/experiment. Every field/child has an edit or confirmed whole-child removal path.

Admission projects full worst-case JSON-escaped 320-byte experiments for every theme and assignment IDs for every quote. Counterexamples are optional new content. `suggest-themes` uses one optional unsaved call returning only arrays of existing quote IDs and explicit unassigned coverage. Every quote must appear exactly once; no labels, invented quotes or extra prose are accepted. All allowed grouping counts, including zero groups/all-unassigned, are considered in minimum complete reply/raw preflight. Real replies are postvalidated against 3500 units; raw output 4000 units, input 16000 UTF-8 bytes and instructions 4000 bytes. Source text and meaningful local state are content-stamped after the await; edits, deletion and cancellation discard suggestions. Manual assignments remain the only way to save interpretations.

## Complete command grammar

```text
Feedback theme review — Group received feedback by exact evidence and turn repeated themes into a concrete response experiment.
Start: /nobo-help agent feedback-themes create Quarterly feedback
Then: quote REVIEW add SPEAKER | YYYY-MM-DD | CONTEXT | EXACT_QUOTE; theme REVIEW add LABEL; assign REVIEW QUOTE | THEME; counterexample REVIEW THEME | TEXT; experiment REVIEW THEME | RESPONSE; themes REVIEW [PAGE [rev TOKEN]].
Edit: edit REVIEW | title | VALUE; clear REVIEW title confirm.
quote REVIEW edit QUOTE | SPEAKER | DATE | CONTEXT | TEXT (becomes unassigned); quote REVIEW remove QUOTE confirm.
theme REVIEW edit THEME | LABEL; theme REVIEW remove THEME confirm (unassigns retained quotes; removes owned counterexamples/experiment).
unassign REVIEW QUOTE confirm; counterexample-edit REVIEW THEME COUNTEREXAMPLE | TEXT; counterexample-remove REVIEW THEME COUNTEREXAMPLE confirm.
experiment REVIEW THEME | NEW_RESPONSE replaces it; experiment-remove REVIEW THEME confirm.
Optional: suggest-themes REVIEW, one unsaved grouping of existing quote IDs, all IDs unique/accounted for. Create themes and assign manually. No generated labels, quotes or personality findings. No context reads.
Limits: title/speaker/theme 160 bytes, context 500, quote/counterexample 1000, response experiment 320. Exact duplicate evidence, repeated wording and separately entered excerpts are distinguished; source labels are not verified people. All dates are civil labels.
Use returned full IDs. Pipes separate fields; escape literal pipes as \| and backslashes as \\. Private, on demand; no search or external actions.
Manage: list [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID confirm. Detail continuations are revision/content-bound.
Capacity: 12 reviews; 30 feedback excerpts, 10 themes and 3 counterexamples/theme. New content 32768 UTF-8 bytes; hard cap 49152; complete export 24576. Bytes may fill first. Explicit removal only.
```

## Storage and safety

Version 1 state is scoped by workspace, user and feature. Each accepted root and all children are fully retrievable with `show` continuations; concatenating page bodies reconstructs the exact JSON. `export` is one complete JSON envelope. Lists explicitly recompute. Every saved/derived continuation binds numeric revision and SHA-256 of content. Plain slash replies retain literal mentions and URLs without activation.

All updates capture the intended record content before the retryable CAS transform. Unrelated record edits can retry; same-record changes or deletion reject. Confirmed removals must strictly reduce serialized bytes, remain available at the root revision ceiling, and change the content stamp without reusing a write clock. At that ceiling ordinary/lifecycle writes refuse with export and whole-record deletion guidance. Malformed state is preserved. Schema-valid over-quota legacy state can be incrementally removed. Backend/provider diagnostics remain private; ambiguous dispatched saves require inspection before retry. No silent eviction, hidden history, background jobs or service caches.

New content admission checks a feature-specific worst-case lifecycle projection against both the full-state and per-export caps. Optional long additions still count as content. Limits are serialized UTF-8, including JSON escaping. No model output-token/billing ceiling is claimed. Tests use Node 24, the real runtime/scoped store, injected memory backend and fake/throwing services; they establish no production quality or performance claims.

Persisted generated IDs require the exact role prefix and a full lowercase UUID: `feedback-UUID`, `theme-UUID`, `counter-UUID`, `quote-UUID`. Unknown prefixes, wrong roles, malformed lengths and non-string IDs make the whole stored state unreadable; reads and mutations preserve its exact bytes, with no relabeling or repair.
