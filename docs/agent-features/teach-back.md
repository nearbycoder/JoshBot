# Teach-back review

Implemented locally; **not yet registered or deployed**. Parent owns lazy registration, independent review and release.

Start `/nobo-help agent teach-back create Explain cache invalidation | Cached data must be refreshed when the source changes.` With the returned SESSION ID, use the same prefix:

```text
concept SESSION add Freshness | source,changes | Cached data must be refreshed when the source changes.
explain SESSION | A cache is a saved copy that needs updating.
review SESSION
self-rate SESSION CONCEPT | partial | Need to explain how changes are detected
```

The concept command returns a full CONCEPT ID. Its quoted span must exist verbatim; the first occurrence binds zero-based JavaScript offsets. Review shows required-term substring coverage, missing terms, original excerpts and explicit clear/partial/missing self-ratings. Synonyms can produce lexical gaps. Neither matching words nor user self-ratings prove comprehension. Missing concepts keep their evidence.

## Correct and retrieve

After `/nobo-help agent teach-back`:

```text
edit SESSION title|source|explanation | TEXT
source SESSION | SOURCE
clear SESSION title|source|explanation confirm
concept SESSION edit CONCEPT | LABEL | TERM[,TERM...] | EXACT-SOURCE-SPAN
concept SESSION clear CONCEPT label|requiredTerms|sourceSpan confirm
concept SESSION remove CONCEPT confirm
self-rate SESSION CONCEPT | clear|partial|missing | NOTE
self-rate SESSION CONCEPT clear confirm
coach SESSION
help
list [N]
show SESSION [page N] [rev R]
review SESSION [page N] [rev R]
export SESSION
delete SESSION [confirm]
```

Self-rate replaces the rating/note. Source, explanation and rubric edits increment the content revision, marking earlier ratings stale. Source changes also stale all concept bindings until explicitly rebound by concept edit. Old excerpts remain available and labeled stale. `clear source` removes the source field; erase retained concept copies using `clear ... sourceSpan` or concept removal. Each field has a replacement/clear path; whole session deletion removes all owned data.

Every mutation, rating and deletion captures the intended session revision and checks it inside every CAS retry. An unrelated session can change without blocking the retry. Detail/review continuations carry the revision; restart when changed. IDs are stable UUIDs, never prefixes. Show exposes all fields; export is an exact compact JSON envelope. Slash output is plain text; literal pipes use `\|` and backslashes `\\`.

## Optional assistance

`coach SESSION` explicitly sends the current supplied source, explanation and current concept rubric to the configured text model once. It returns one **unsaved model opinion** and at most three probing questions. The strict JSON response requires actual concept IDs and each cited concept's entire exact quote. Unknown references, changed quotes, empty notes, unsupported fields, refusals, malformed JSON, excess questions and oversized complete results are rejected without retry/repair or save. It never assigns grades or modifies self-ratings/cards.

Input is at most 16,000 UTF-8 bytes; static instructions are below 4,000. Accepted raw output is at most 4,000 JS units and the entire rendered response must fit 3,500. No clipping or regeneration continuation. These post-generation checks do not impose upstream token/spend caps; the shared provider foundation owns that. Provider failure leaves deterministic review available. Editing/deleting during generation discards its stale result; runtime cancellation propagates and makes no later writes. No generation result is persisted.

## Capacity and schema

Version 1 strict state, 8 sessions and 12 concepts/session. Source: 6,000 JS units/18,000 UTF-8 bytes; explanation: 3,000/9,000. Title/label: 120 bytes; up to eight unique required terms of 40 bytes each; exact span: 600 units/1,800 bytes; rating note: 160 bytes. Whole command input is at most 16,000 bytes. Limits reject, never clip.

65,536 serialized state bytes; 49,152 content admission; 24,576 complete export envelope. Each content admission projects the maximum Unicode explanation, maximum escaped note and rating for every accepted concept, retained source evidence and safe-integer revision growth. Future concept additions are new content and reserve their own rating. Bytes may bind before counts/field maxima. List/save shows actual and projected use; export then delete to recover space. No TTL, eviction, history snapshots, workers or context/search calls. Generation budget 1, searches/context 0, logical state reads 8/updates 4; normal deterministic operations read once and update at most once, coach adds one reread.

Full schema, offsets, source bindings, references and revisions validate before deletion or mutation. Corrupt/unknown state is preserved for maintainer repair. Parent integrated shared-state fix `6725cde` after this checkout's baseline; no local store workaround is included.

Node 24.22.1: ten real-runtime/store fake-backed tests cover lexical honesty, exact spans, all edits/removals, stale assessment and unrelated CAS retries, optional references/quotes/count/oversize/refusal, late edit/delete/abort, worst-case Unicode lifecycle saturation, full pages/export, exact boundaries, strict persisted enum types and tenant/corruption isolation. Run `node --import tsx --test --test-concurrency=1 tests/agent-teach-back.test.ts`. Fake checks do not certify live Slack delivery, upstream billing or production performance.

Domain validation and quota failures return private actionable help text. Unknown backend errors expose no raw exception details and direct inspection before retry. Runtime cancellation still propagates.

Explicit removals remain available when only the root revision reaches its valid ceiling (9,007,199,254,740,991); that revision stays at the ceiling. Creation of children, edits and new lifecycle reports at that ceiling are refused. Every intended mutation is also bound to the complete record's content stamp, including every CAS retry. Unrelated records may change and retry safely. No stored fields, schema versions or budgets were added.

Copy the complete emitted continuation: `rev R` now carries `NUMBER:CONTENT_HASH`. A continuation requires the content hash even when a removal leaves the numeric revision unchanged. Start again with `show ID` if an old numeric-only continuation is rejected. Page 1 without a token remains available. Complete pages and exports retain their existing limits.

Pending optional generation compares the full record content before returning. A same-revision erasure discards the draft and cannot repeat removed evidence or save a late result.

The separate source/content assessment versions also have the finite safe-integer limit (9,007,199,254,740,991). This astronomical boundary is intentional: an operation needing a new semantic version is refused with a finite-history explanation before any save, even if it is a selective removal. Existing data is valid and unchanged; it does not need repair or retry. Versions are never reused and historical associations are never rewritten or erased to make the operation fit. Use `export ID` for the complete record, then `delete ID confirm` only if you intend to erase that entire root and its owned history. A new separate record can be created from data you explicitly re-enter. Unrelated roots remain intact. This is distinct from root-revision saturation: the supported removals still work at the root ceiling when the needed semantic versions have capacity.
