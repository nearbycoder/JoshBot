# Feedback builder

Implemented and registered; [release/deployment status is tracked in PR #59](https://github.com/nearbycoder/JoshBot/pull/59). See the [grouped guide index](README.md#find-a-feature) and [implementation/evidence record](../personal-agent-50-release.md).

Prepare a private observation/impact/request draft without turning an inferred motive into a recorded observation. Explicit interpretations stay separately labeled, including in optional assistance. Observations are user supplied and unverified.

Start: `/nobo-help agent feedback-builder create Review handoff | Monday planning meeting`. Use the returned `ID`. Commands follow `/nobo-help agent feedback-builder`:

- `behavior ID | OBSERVATION`, `impact ID | PERSONAL-IMPACT`, `request ID | SPECIFIC-CHANGE`, `positive ID | POSITIVE-EXAMPLE` save the core fields.
- `inference ID | INTERPRETATION` adds an explicitly unverified interpretation. `reclassify ID confirm` moves current behavior text intact into an interpretation and clears behavior; it does not guess or upgrade an interpretation to an observation.
- `interpretation ID edit INFERENCE | TEXT` replaces that text; `interpretation ID remove INFERENCE confirm` removes it.
- `edit ID | title/situation/behavior/impact/request/positive | TEXT` replaces a field; `clear ID FIELD confirm` removes it.
- `check ID [page [rev REV]]` lists missing core fields and quoted lexical matches. `draft ID [page [rev REV]]` renders the deterministic template, separate interpretations and check results.
- `polish ID` requests one unsaved finite composition. Every title, situation, behavior, impact, request, positive example and interpretation retains exact text, including dates, names and attributions. Evidence and interpretations keep fixed separate labels. The optional framing is “For discussion:” or “Please consider this feedback.”; no generated evidence, motives or commitments are accepted.
- `list [page]`, `show ID [page [rev REV]]`, `export ID`, `delete ID confirm` retrieve/remove complete saved records. Delete without confirmation displays the exact confirmation command.

The transparent, case-insensitive lexical rules flag absolute words `always`, `never`, `everyone`, `nobody`, `nothing`; possible interpretation/motive phrases `lazy`, `careless`, `deliberately`, `on purpose`, `don't care`/`don’t care`, `doesn't care`/`doesn’t care`, `trying to`; and vague request phrases `be better`, `do better`, `improve`, `communicate better`, `be professional`, `be proactive`, `try harder`. Matches quote the exact entered case/text. These are heuristics, not proof of intent, personality, truth or observability. No match is not verification. Missing behavior specifically calls for an observable example.

The pipe grammar decodes `\|` and `\\`, rejects other/trailing escapes and extra delimiters, and trims delimiter-adjacent whitespace. Accepted interior text is preserved. Mentions/URLs remain plaintext. Nothing sends, assigns work or asserts another person's agreement.

Schema version 1 permits 12 cases, 20 interpretations per case, 160 UTF-8 title bytes and 1000 bytes per other text field. New content fits 32768 bytes; full feature state 49152; each export including envelope 24576. Admission explicitly projects every maximum revision; no persisted draft/report payload grows later. New optional text must pass content admission. No hidden histories, eviction, auto-expiry or background work. Complete valid legacy state is still readable/deletable above byte limits.

Normal pages fit 3500 JavaScript units, with atomic IDs and full fields. Show exposes all metadata and original fields; export is exact JSON and the explicit response-size exception. List uses insertion order/ten roots; current revision labels require restarting pagination after edits.

Catalog budgets generations/searches/contextReads/storeReads/storeUpdates: 1/0/0/8/4. Deterministic reads use one read; mutations bind intent with one read before one update; polish uses one model call, at most two state reads, zero writes. Input <=16000 UTF-8 bytes, instructions <=4000, raw output <=4000 units, each suggestion <=1000 bytes, complete visible reply <=3500 units. Invalid/oversized output is rejected with a deterministic draft command, with no repair call or generated pagination. No provider-token ceiling is expressed by the service interface.

Every loaded state is schema checked; CAS transforms enforce quotas and use IDs/time allocated beforehand. Revision/signal rereads discard optional results after edits/deletion. Bad input, malformed state and optional failures preserve saved bytes. Runtime owner isolation, receipts and original deadline apply; cancellation cannot undo an already dispatched CAS.

`tests/agent-feedback-builder.test.ts` verifies exact catalog workflow and original observation/motive strings, lexical matches, all editing/removal, final interpretation retrieval, Unicode quota recovery, optional output validation and stale work. Tests use the real runtime/scoped store with fake/throwing services. Parent owns registration, independent review and deployment; no production result is claimed.

Every mutation binds the intended record snapshot before CAS retries. A same-record change rejects the older command with an inspect/retry message, including status, evidence, attempts and confirmed deletion. Unrelated-record conflicts retry safely; a deleted target is never recreated.

Every saved-record and derived-report continuation includes `PAGE rev REV`. Copy the whole emitted command: REV combines the record revision with a content stamp, including at the revision ceiling. A mismatch rejects before rendering and gives a fresh page-1 command. Existing first-page commands and manually entered page numbers still render the current record; root lists are recomputed. No unsaved model output uses pagination.

Optional polish is constrained composition, with no free prose rewriting. The provider returns every known source exactly once, with exact full quotes and text equal to those quotes. The renderer copies saved bytes under fixed role labels and in fixed source order; provider ordering cannot reclassify evidence, relax a constraint or move an attribution. All supplied sections are mandatory in the composition. Unknown or duplicate source/framing IDs, omitted sections, added keys, changed quotes/text, appended factual claims and unsupported structures reject the entire result. The only presentation choices are compact/spaced layout and zero or one allowlisted nonfactual framing phrase. Entered claims remain user supplied and unverified; exact preservation is not truth verification.

The smallest complete composition is checked before generation; if required exact text cannot fit the 3500-unit reply or 4000-unit raw-output representation, the command refuses with a deterministic-page/edit-input action and makes no call. Accepted results remain unsaved, manual-review text. Full output is rechecked after generation; it fits completely or rejects, never truncates, silently drops content or paginates inaccessible model output. There is one explicit optional call and no repair call. Post-generation validation is not an upstream billing cap: the service interface still exposes no provider token ceiling. A final revision/content-stamp check discards stale output even after removals at the revision ceiling.
