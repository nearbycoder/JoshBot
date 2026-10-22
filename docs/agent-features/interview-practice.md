# Interview practice

Locally implemented; unregistered; not deployed. Integration, independent review, CI and release remain parent-owned.

Create `Backend interview | 120 | 130`, add the behavioral tradeoff question and save your text response. Annotating `action` requires an exact substring of that specific attempt. `review` uses whitespace-delimited words × 60 / configured words-per-minute, labels duration approximate, compares the target, and lists missing STAR annotations. No missing result is hallucinated from a sentence about measurement. Ambiguous repeated spans require explicit UTF-16 coordinates, which must preserve Unicode character boundaries.

`revise` creates a distinct second attempt with empty annotations and self-ratings. Editing an existing answer explicitly clears dependent annotations and ratings. Each attempt keeps the original question text/type snapshot; editing the question affects future attempts without reinterpreting prior answers. Removing a question removes its attempts; individual attempts, annotations and ratings also have confirmed removal. Cleared timing settings remain unknown. Self-ratings are private 0–4 judgments, never official scores.

The lifecycle projection reserves every STAR section's maximal serialized span coordinates and all self-ratings for every saved attempt, plus maximum revision digits. Text/question additions remain new content. `coach` is a single optional unsaved call, constrained to a verified exact answer quote, matching question/attempt IDs, one finite critique category and one finite follow-up question. Renderer-owned prompts contain no employer identity or invented achievement. Complete minimum reply/raw preflight considers every allowed category/section and the shortest valid Unicode quote. Input/instructions/raw are capped at 16000 UTF-8 bytes/4000 bytes/4000 string units. Postvalidation checks all fields and the full reply; post-await content comparison discards stale output. Provider output cannot create stored content or increase budgets.

## Complete command grammar

```text
Interview practice — Practice a timed answer with a role-specific rubric and inspect the evidence you actually supplied.
Start: /nobo-help agent interview-practice create Backend interview | 120 | 130
Then: question SESSION add TEXT | TYPE; answer SESSION QUESTION | ANSWER; annotate SESSION ATTEMPT | SECTION | EXACT_SPAN; review SESSION ATTEMPT [PAGE [rev TOKEN]]; revise SESSION ATTEMPT | NEW_ANSWER (distinct attempt).
TYPE: behavioral, technical, situational, general. SECTION: situation, task, action, result.
Edit: edit SESSION | FIELD | VALUE; clear SESSION FIELD confirm. Fields: title, answerSeconds, wordsPerMinute.
question SESSION edit QUESTION | TEXT | TYPE; question SESSION remove QUESTION confirm.
attempt-edit SESSION ATTEMPT | TEXT (clears annotations/ratings); attempt-remove SESSION ATTEMPT confirm.
annotate-span SESSION ATTEMPT | SECTION | START | END (UTF-16, end exclusive; exact Unicode boundaries); annotation-remove SESSION ATTEMPT SECTION confirm.
rate SESSION ATTEMPT | clarity OR relevance OR evidence | LEVEL_0_TO_4; rating-remove SESSION ATTEMPT FIELD confirm.
Optional: coach SESSION ATTEMPT; one unsaved exact-quote-linked finite critique/follow-up. No employer facts or invented achievements. No context reads.
Limits: role 160 bytes; question 1000 bytes; answer 2000 units/8000 bytes; target 15–600 seconds; 40–300 words/minute. Existing attempts retain original question snapshots. Timing is approximate; missing STAR depends only on your annotations.
Use returned full IDs. Pipes separate fields; escape literal pipes as \| and backslashes as \\. Private, on demand; no search or external actions.
Manage: list [PAGE]; show ID [PAGE [rev TOKEN]]; export ID; delete ID confirm. Detail continuations are revision/content-bound.
Capacity: 10 sessions; 8 questions and 2 attempts/question; 2000 characters/attempt. New content 32768 UTF-8 bytes; hard cap 49152; complete export 24576. Bytes may fill first. Explicit removal only.
```

## Storage and safety

Version 1 state is scoped by workspace, user and feature. Each accepted root and all children are fully retrievable with `show` continuations; concatenating page bodies reconstructs the exact JSON. `export` is one complete JSON envelope. Lists explicitly recompute. Every saved/derived continuation binds numeric revision and SHA-256 of content. Plain slash replies retain literal mentions and URLs without activation.

All updates capture the intended record content before the retryable CAS transform. Unrelated record edits can retry; same-record changes or deletion reject. Confirmed removals must strictly reduce serialized bytes, remain available at the root revision ceiling, and change the content stamp without reusing a write clock. At that ceiling ordinary/lifecycle writes refuse with export and whole-record deletion guidance. Malformed state is preserved. Schema-valid over-quota legacy state can be incrementally removed. Backend/provider diagnostics remain private; ambiguous dispatched saves require inspection before retry. No silent eviction, hidden history, background jobs or service caches.

New content admission checks a feature-specific worst-case lifecycle projection against both the full-state and per-export caps. Optional long additions still count as content. Limits are serialized UTF-8, including JSON escaping. No model output-token/billing ceiling is claimed. Tests use Node 24, the real runtime/scoped store, injected memory backend and fake/throwing services; they establish no production quality or performance claims.
