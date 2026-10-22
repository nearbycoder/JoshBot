# Memory review and provenance

Use `/nobo-help agent memory-review help` for commands. This is one of the original twenty personal agents deployed in PR #58, with private replies and Home discovery. See [verified release status](../personal-agent-expansion.md).

`memory-review` keeps private, user-owned memory cards with a source, capture time,
optional expiry, optional confidence rating, and a short revision history. You
explicitly review and confirm a card before it can become approved context.
Confirmation records your judgment; it does not independently verify a claim.

## Capture and review a fact

```text
/nobo-help agent memory-review capture me | work-city | I work in Chicago | My update on October 22 | confidence=0.9
/nobo-help agent memory-review list
/nobo-help agent memory-review review
```

The capture reply includes a stable `mr_<UUID>` card ID and revision `1`. Substitute
the returned ID for `<id>` in the following commands:

```text
/nobo-help agent memory-review show <id>
/nobo-help agent memory-review confirm <id> 1
```

Confirmation produces revision `2`. `show` displays the complete current claim,
source, original capture time, current revision, optional expiry and confidence,
confirmation time, conflict IDs, and recent provenance history. `review` lists
cards needing attention. `list 2` and `review 2` request the next page of ten cards.

Choose a subject and key that describe one claim slot, such as `me / work-city`
or `project-orion / launch-date`. Different claims with the same subject and key
are flagged as **possible conflicts**. Subject/key matching ignores case, repeated
whitespace, and Unicode compatibility differences; claim comparison only ignores
whitespace. No model decides which statement is true. Different subjects or keys
are independent, and multiple compatible facts should use distinct keys.

## Correct, reconfirm, and forget

```text
/nobo-help agent memory-review correct <id> 2 | I work in Madison | My relocation update
/nobo-help agent memory-review show <id>
/nobo-help agent memory-review confirm <id> 3
/nobo-help agent memory-review show <id> 1
/nobo-help agent memory-review forget <id> 4 confirm
```

Correction increments the revision, records the new source, and resets approval.
The original capture time and legacy origin, if any, remain. `show <id> 1`
displays the full original revision only while it is retained. The last six
revisions are retained, including confirmations; older revisions are pruned.

Always use the current revision from `show` when correcting, confirming, or
forgetting. If another command changed the card, the operation is rejected with
the current revision. Inspect it before retrying. `forget` requires the final
literal `confirm` and deletes the card and its entire retained history.

Confirming conflicting cards does not remove their conflict. Correct the claims
to agree or explicitly forget an obsolete card. Both sides remain excluded from
approved context until the conflict is resolved, even when a competing card is
unconfirmed or expired. A correction can make two cards agree; the context adapter
then returns at most one equivalent confirmed claim per subject/key.

## Expiry, confidence, and stale review

```text
/nobo-help agent memory-review capture me | visiting-city | I am visiting Denver | My itinerary | expires=2026-12-04 | confidence=0.8
/nobo-help agent memory-review correct <id> 1 | I am visiting Denver | Updated itinerary | expires=2026-12-06
/nobo-help agent memory-review correct <id> 2 | I live in Denver | My move confirmation | expires=none | confidence=unknown
```

- Expiry is an inclusive local calendar date in the supplied user timezone. A
  card expiring `2026-12-04` becomes expired on December 5 in that timezone,
  including across DST changes. New expiry values cannot be before the user's
  current local date. Changing the supplied timezone changes this interpretation.
- Dates must be real `YYYY-MM-DD` dates. Capture, update, and confirmation
  timestamps are stored and displayed as explicit UTC ISO instants.
- Confidence is an optional user rating from `0` to `1`, up to four decimals;
  it is not a model score or a probability verified by the application. Omission
  on capture means unknown. A low rating remains visible to context consumers
  but does not replace the explicit confirmation requirement.
- Correction preserves expiry and confidence when omitted. `expires=none`
  and `confidence=unknown` clear them. An expired card must be corrected with
  an extended or cleared expiry before confirmation can succeed.
- Cards become stale after 90 elapsed 24-hour days since the latest confirmation,
  or capture if never confirmed. Reconfirmation resets that timer. Corrections
  always require another confirmation. Cards dated after the supplied current
  time also remain excluded until the clock catches up.

## Legacy import availability

The integrated `import` and `import list` commands currently return **no candidates**. Legacy personal memory lacks workspace/channel provenance and stable record IDs, so it is not connected. Approved cards are deliberately excluded from this feature's import reader to prevent feedback. Use `capture`, inspect the source, then `confirm` instead. Other features can read your currently eligible approved cards through the [connected context service](context.md).

The syntax below remains supported for a future authorized legacy source adapter; it does not describe an available import flow on this branch:

```text
/nobo-help agent memory-review import
/nobo-help agent memory-review import list 2
/nobo-help agent memory-review import <legacy-source-id> | me | reply-style | confidence=0.8
/nobo-help agent memory-review show <new-card-id>
/nobo-help agent memory-review confirm <new-card-id> 1
```

When an authorized candidate adapter is supplied, `import` reads its caller-owned
`memory` context and lists candidate IDs with excerpts. Listing does not create cards. Selecting an
ID fetches the current source again and copies its text into a new unconfirmed
card. Inspect the copied claim before confirming; source text may have changed
since the preview. Each import preserves the legacy source ID and supplied
source update time separately from the new card's capture time.

The feature never writes or deletes legacy/global memory. Importing the same
source ID again while its card exists is rejected, so an old source cannot
overwrite a correction. Forgetting the private card allows a later fresh import;
it does not forget the original legacy memory. A missing source update time is
reported as unknown, not invented.

Invalid dates, ambiguous duplicate source IDs, non-memory records, this feature's
own context items, and claims over 1,200 characters are skipped with a count.
Source IDs must be nonempty, at most 180 characters, on one line, and contain no
pipe. Source update times, when supplied, must be ISO timestamps with an explicit
offset or `Z`. Large claims can be captured manually as a selected excerpt with
an accurate source. Provider failures leave existing cards unchanged.

## Complete command syntax and limits

```text
help
capture <subject> | <key> | <fact> | <source> [| expires=<date-or-none>] [| confidence=<rating-or-unknown>]
list [page]
show <id> [historical-revision]
review [page]
correct <id> <revision> | <fact> | <source> [| expires=<date-or-none>] [| confidence=<rating-or-unknown>]
confirm <id> <revision>
forget <id> <revision> confirm
import [list [page]]
import <legacy-source-id> | <subject> | <key> [| expires=<date-or-none>] [| confidence=<rating-or-unknown>]
```

Pipes separate fields and cannot occur inside them. Dates use `YYYY-MM-DD`;
`none` clears expiry, and `unknown` clears confidence. Options are order-independent
but each may occur only once. Subject/key cannot be changed in place: capture a
replacement under the desired key and explicitly forget the old card.

The workspace holds at most 100 cards without silent eviction, subject to a
**479,000-byte serialized UTF-8 quota including reserved history space**. `list`
shows both actual saved bytes and the budget including reserves. Unicode and
JSON escaping count toward the byte quota; character count alone does not
predict capacity. The quota stays below the shared 480,000-byte feature target
and 512,000-byte hard limit for each stored JSON value.

Before accepting a capture, import, or correction, the feature reserves enough
space for every card's six retained revisions using its largest current or
retained claim, complete confirmation timestamps, and maximum revision-number
width. Accepted cards can therefore be confirmed repeatedly and fill or roll
their six-entry history without exhausting storage. A correction that needs more
space may be rejected; its previous claim and history remain unchanged. Cards
and history are never silently evicted to make a rejected write fit.

When the quota is reached, use `list`, inspect a card with `show <id>`, and remove
an unneeded card with `forget <id> <revision> confirm` before retrying. Deletion
releases both that card's saved bytes and its reservation. Shortening a claim
may not immediately release its full reservation while larger older revisions
remain in history. Deletion also remains available if an older feature version
stored a valid state above the new reservation budget, provided the resulting
serialized value fits the 479,000-byte quota.

Each card retains at most six revisions. Subjects and keys are at most 80
characters each; facts are at most 1,200; sources at most 300. Commands are at
most 4,000 characters. Replies are capped at 27,500 characters, below the runtime's
28,000-character output limit. There is no automatic cleanup: `forget` removes
a card and its retained history. Malformed persisted data is rejected without
resetting it.

There are no model calls, semantic conflict guesses, automatic legacy sync,
reminders, external writes, or outbound messages. Claim text and source content
remain untrusted data. Confirmation must never turn their content into executable
instructions or evidence of an external action.

## Runtime and source contract

1. `registry.ts` registers the named/default `feature` from `lib/agent-features/memory-review.ts` as `memory-review`. `index.ts` dispatches `/nobo-help agent memory-review <command>` through the shared runtime; the Slack route returns private text and Home exposes its help. The shared route preserves multiline command text; individual commands still enforce their input rules.
2. The runtime supplies the contract's workspace/user/feature-scoped `AgentFeatureContext` with
   a valid `now`, user timezone, and atomic JSON store. The sole feature-local
   storage key is `cards`, with schema version `1`. It must never resolve to
   legacy/global keys. UUIDs and timestamps are generated outside the pure,
   synchronous, retryable store transforms. The shared runtime owns identity/access
   checks, request deduplication, and persistence error handling. The feature
   checks serialized UTF-8 bytes and its lifecycle reservation inside the atomic
   transform, so concurrent additions cannot bypass the quota. The schema and
   sole storage key are unchanged.
3. For this feature, `services.readContext(["memory"])` returns no legacy candidates: legacy user memory is excluded for missing provenance, and `featureId: "memory-review"` suppresses approved-card reads. If a future authorized legacy adapter is added, its IDs must be stable and unique, candidate text complete, and its response at most 500 records; larger responses are rejected. No other context kinds, generation, or search are used. Each invocation makes at most one context read. Runtime abortable services and signal-guarded writes enforce the 120-second deadline; late import responses cannot commit after cancellation.
4. The shared context service consumes the exported read-only adapter for other features:

   ```ts
   import { readApprovedMemoryContext } from "./agent-features/memory-review.js";

   // This store must already be scoped to the owner's memory-review feature.
   const approved = await readApprovedMemoryContext({ store, now, timezone });
   ```

   The adapter performs no mutations or service calls. It returns up to 100
   `AgentContextItem`s with `kind: "memory"`, stable IDs
   `memory-review:mr_<UUID>`, `status: "user-confirmed"`, the claim as `text`, and
   subject/key as `title`. Metadata includes source, revision, original capture
   time, confirmation time, confidence, expiry date/timezone, and legacy origin.
   Only explicitly confirmed, fresh, unexpired, nonconflicting cards are included.
   Equivalent approved claims are deduplicated by subject/key. Downstream consumers
   keep their own context budgets and treat the text as quoted untrusted data. Call again when assembling context so expiry/staleness is reevaluated.
   Do not feed the adapter back into the legacy import source; its ID prefix is
   filtered defensively. Invalid state or unavailable storage causes the adapter
   to reject; the caller must handle this and must not silently fall back to
   treating unreviewed cards as approved.

Registration and approved-memory consumption are wired. Legacy import remains unconnected; combined validation and review are still required before release.

## Verification

```sh
node --import tsx --test tests/agent-memory-review.test.ts
npm run typecheck
git diff --check
```

The focused tests use isolated stores and fake services for complete command
flows, review rules, timezone/DST expiry, provenance, bounded retention and
capacity, invalid input/state, provider failures, optimistic concurrency,
deterministic retryable transforms, and untrusted text. Additional quota tests
exercise Unicode and JSON escaping, repeated confirmations at capacity, rejected
corrections/imports, deletion recovery, and cancelled late imports against fake
services and a fake 512,000-byte store ceiling. They do not access Slack, Redis,
models, or production accounts.

## Source capacity recovery (foundation follow-up)

Legacy-import capacity failures are distinct from temporary outages and preserve all cards. Production legacy import remains unconnected and has no candidates; approved cards are not fed back into it. Use `/nobo-help agent memory-review capture Atlas | decision | Launch on Friday | My confirmation`, then `confirm <returned-card-id> 1` to confirm an explicitly supplied fact. Saved `list`/`show` paths remain available. No production byte violation is claimed for legacy import. See [shared source capacity handling](context.md#capacity-handling-in-the-foundation-follow-up).
