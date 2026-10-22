# Spaced-repetition learning coach

`learning` turns your pasted material into private, source-grounded flashcards. Try to recall an answer, compare it with the source excerpt, then report how well you remembered it. The coach calculates the next review time deterministically. It does not automatically judge correctness or send reminders.

The module is implemented; parent integration must register it at `/nobo-help agent learning <command>` before these commands are available in Slack. All responses must be private.

## First learning session

Create a deck with a source label and the material itself:

```text
/nobo-help agent learning create Networking | My class notes | DNS translates domain names to IP addresses. A resolver asks a name server for a record.
```

The reply supplies a stable deck ID and source ID. Copy the full deck ID into subsequent commands; `<deck-id>`, `<draft-id>` and `<quiz-id>` below are placeholders for returned IDs.

Add a question and an **exact excerpt** as its answer:

```text
/nobo-help agent learning card <deck-id> | What does DNS do? | DNS translates domain names to IP addresses.
/nobo-help agent learning cards <deck-id>
/nobo-help agent learning due <deck-id>
/nobo-help agent learning quiz <deck-id>
```

`cards` displays the answers for source review; `due` and an unrevealed `quiz` display questions only. The quiz supplies an attempt ID. Recall the answer before revealing it:

```text
/nobo-help agent learning answer <quiz-id> | It maps domain names to IP addresses.
/nobo-help agent learning rate <quiz-id> good
/nobo-help agent learning progress <deck-id>
```

If you cannot recall anything, use `reveal <quiz-id>`, then `rate <quiz-id> again`. `answer` records only your temporary recall text and reveals the saved excerpt; it does not compare answers using a model. A completed rating clears that temporary recall text. Use `quiz` again to continue with another due card.

## Commands

All commands below follow `/nobo-help agent learning`.

| Command | Behavior |
| --- | --- |
| `help` | Syntax, example and spacing rule; works without storage or a model. |
| `create <title> \| <source label> \| <material>` | Save one immutable source and an empty deck. |
| `list` | Deck IDs, accepted-card counts, due counts, draft indicators and UTF-8 storage usage including reserved review space. |
| `show <deck-id>` | Source ID, original material, date and deck status. Long escaped displays may be shortened with an explicit notice. |
| `card <deck-id> \| <question> \| <answer excerpt>` | Add a manual card, due immediately. Its answer must occur verbatim in the deck's source. |
| `cards <deck-id> [page]` | Review three accepted cards per page, with answers, provenance and due times. |
| `draft <deck-id>` | Request up to three generated suggestions and show the complete preview. This is the only command that calls a model. |
| `preview <deck-id>` | Redisplay the pending draft without another model call. |
| `accept <deck-id> <draft-id>` | Add exactly that pending draft's cards to the quiz pool, due now. |
| `discard <deck-id> <draft-id>` | Remove that pending draft. Accepted cards stay intact. |
| `due [deck-id]` | Count due cards and show up to ten questions, or the earliest next review. Omit the deck ID to include every deck. |
| `quiz [deck-id]` | Start the earliest due card or resume the existing attempt. Equal due times sort by card ID. |
| `answer <quiz-id> \| <your recall>` | Save temporary recall and reveal the source answer. |
| `reveal <quiz-id>` | Reveal without entering recall. |
| `rate <quiz-id> again\|hard\|good\|easy` | Record your self-rating after reveal and schedule the next review. Choose one rating word. |
| `progress [deck-id]` | New/practiced/due counts, total reviews, again ratings, pending suggestions, and the next five scheduled reviews. |
| `delete <deck-id> confirm` | Remove the entire deck, source, accepted cards, pending draft, and any active quiz for that deck. Without `confirm`, no deletion occurs. |

There is one active attempt across all decks. Resume it with `quiz` without a deck ID, then reveal and rate it before switching decks. Repeating `quiz` preserves its attempt ID and revealed state. A stale answer or rating cannot affect another attempt; a repeated rating cannot advance an interval twice.

Pipes delimit the first two fields in `create` and `card`. Their final field can contain additional pipes and newlines. `answer` splits at its first pipe. Titles, labels, questions and recalled/source text have surrounding whitespace trimmed. IDs are full UUIDs, not titles or short prefixes.

## Deterministic review spacing

This is a simple application-defined interval ladder, not an implementation of SM-2 or FSRS and not a claim of optimal retention. Each accepted card starts with `intervalDays = 0`, zero reviews, and a due time equal to creation or draft acceptance time. For a self-rating made at time `t`, let `d` be the card's previous interval:

| Rating | When to choose it | New interval and due time |
| --- | --- | --- |
| `again` | You did not recall the answer. | Reset `intervalDays` to 0; due at `t + 10 minutes`. Add one again count. |
| `hard` | You recalled it with substantial difficulty. | `min(365, max(1, ceil(d × 1.2)))` days after `t`. |
| `good` | You recalled it correctly with normal effort. | 1 day if `d = 0`; otherwise `min(365, d × 2)` days after `t`. |
| `easy` | You recalled it easily. | 4 days if `d = 0`; otherwise `min(365, d × 3)` days after `t`. |

Days mean **elapsed periods of 24 hours**, including across daylight-saving transitions. An overdue review starts its new interval at the actual rating time. A card is due when `dueAt <= context.now`; due timestamps are stored as UTC ISO strings and displayed in the supplied IANA timezone. No server-local date conversion is used. For example, a one-day review made October 31, 2026 at 10:00 CDT becomes due November 1 at 09:00 CST in America/Chicago.

Progress reports completed reviews and self-reported difficulty, not mastery or objective accuracy. No background job, notification, calendar entry or external action is created.

## Optional generated cards

```text
/nobo-help agent learning draft <deck-id>
/nobo-help agent learning preview <deck-id>
/nobo-help agent learning accept <deck-id> <draft-id>
```

The generator receives only the deck's source and existing questions. The complete source is retained; the list of existing questions is shortened if necessary to keep the JSON input at or below the runtime's 80,000-character limit. Duplicate validation still checks every saved card. Each request makes at most one text-only generation call. Output must be strict JSON with one to three cards (or fewer when close to capacity):

```json
{
  "cards": [
    {
      "question": "What does a resolver do?",
      "answer": "A resolver asks a name server for a record.",
      "sourceId": "the exact UUID from the supplied source"
    }
  ]
}
```

Unknown fields, malformed JSON, unsupported source IDs, non-excerpt answers, oversized fields and duplicate cards reject the whole response. Generated card IDs are assigned locally. Markdown code fences are not accepted as JSON.

Preview always labels cards as generated suggestions. Accepted suggestions retain that label. Check that the question is actually answered by the excerpt: exact-quote validation checks provenance, not educational quality or truth. The source is user supplied and not independently verified. Text inside the source or generated result is data; nothing executes its instructions. Slack mention/link markup is escaped in replies.

Drafts never become quiz cards until explicit acceptance. Provider failures preserve existing state. If a deck is changed, rated or deleted during generation, the stale result is discarded. Concurrent operations on other decks remain intact. There is only one pending batch per deck; accept or discard it before generating another. If a manual card duplicates a pending suggestion or fills the deck, acceptance refuses rather than partially importing the batch.

## Bounds and retention

- At most 6 decks, 40 accepted cards per deck, 3 pending suggestions per deck and one active quiz.
- The entire serialized state must stay **below 480,000 UTF-8 bytes**, including space reserved for future reviews. Every mutation measures `Buffer.byteLength(JSON.stringify(state), "utf8")` and a conservative size envelope for later lifecycle changes. This is below the runtime's 512,000-byte per-value cap. Unicode and JSON escaping can consume several bytes per character, so the byte quota may be reached before the deck/card-count limits.
- The size envelope reserves fully expanded dates and counters for every accepted card, conversion of all pending suggestions into accepted cards, and a maximum-sized active recall answer (including worst-case JSON escaping). New content cannot use that reserve. An admitted deck can still be quizzed, answered and rated, and admitted drafts can still be accepted without exceeding the byte limit. The existing 40-card-per-deck and duplicate checks still apply to acceptance.
- `list` shows saved bytes and total allocated bytes including the reserve. An addition that would exceed the quota fails atomically with explicit deletion/discard guidance. Use `delete <deck-id> confirm` to free a deck's space, or `discard <deck-id> <draft-id>` to remove pending suggestions. Smaller source and answer excerpts consume less space. Existing records are never automatically evicted to make room.
- Titles and source labels: 100 characters each. Source material: 10,000 characters. Questions: 300; answers: 800; temporary recall: 2,000.
- A command is limited to 12,000 characters; model output to 8,000. Replies are escaped and capped below 28,000 characters. Three-card pages and generated previews fit completely within that bound, even with escaped text.
- Each invocation makes at most one generation call and zero searches, within the runtime's limits of eight generation calls and six searches. The parent runtime owns the 120-second deadline, prompt cancellation and guards against late writes. Aborted drafts do not save generated cards; no background work continues a learning workflow.
- Source text is immutable. To change source material or replace incorrect cards, create a replacement deck and delete the old deck. Individual card editing/deletion and deck imports/exports are not implemented.
- Data stays until explicit deck deletion; there is no automatic expiry. Source and accepted-card content are bounded, and review history uses aggregate counters instead of a growing event log. Each card allows up to 1,000,000 recorded reviews, after which it must be recreated. Temporary recall disappears on rating or deck deletion.
- Sources are pasted text only: no URL fetching, invented citations, attachment processing, public-web search, owned-context reads, automatic grading or live inference tests.
- Invalid persisted structures or source/session references produce a repair message and are never silently reset. A storage error reports an unconfirmed operation; inspect `list` or `quiz` before retrying. Parent request deduplication is still required for repeated create/card requests after delivery failures.

## Parent integration requirements

1. Import named `feature` or the default export from `lib/agent-features/learning.ts`; register exact ID `learning` through the parent registry/router and help/Home discovery. No shared files are changed by this feature.
2. Route `/nobo-help agent learning <command>` to `feature.execute(command, context)` and deliver only to the caller privately. Keep identity/access checks, request deduplication and asynchronous delivery in the runtime.
3. Use the parent runtime's workspace/user/feature-scoped `AgentFeatureStore` persistence. The sole internal key is `learning:v1`. `update` must atomically apply pure synchronous transforms and may retry them; callback exceptions must not commit a partial value. Initial state is `{version: 1, decks: [], session: null}`. Reads return JSON data, and stored deck/session/card references are validated on every access. Feature writes enforce the stricter lifecycle-aware quota below 480,000 UTF-8 bytes; no changes to the runtime's 512,000-byte limit or shared contract are needed.
4. Supply a valid `now` and saved IANA `timezone`. Invalid time/timezone inputs fail without mutations. The module does not read preferences, channels, Redis or system-local dates itself.
5. Supply `services.generate` for optional `draft` only. It must remain text-only, without tools. All other commands work if generation is unavailable. `search` and `readContext` are unused. Keep the runtime's 120-second deadline, abortable service waiting and signal-guarded storage writes in place; the feature does not create its own timer or bypass these guards. No external credentials or package changes are needed.
6. No recurring scheduler integration is required. Due checks and practice are explicitly invoked; parent should not advertise notification delivery.

## Verification

Run in the feature worktree with Node 24:

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-learning.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```

Tests use the shared isolated JSON store and fake generation only. They cover the complete manual and generated flows, exact-source validation, timezones/DST, interval growth/reset/cap, confirmation, limits, corrupted data, failed providers, stale generation, concurrent attempts/ratings, and pure retry behavior. Quota tests fill state with multibyte Unicode, reject over-budget additions without changes, accept saved drafts, expand review counters and record a maximally JSON-escaped recall answer while every stored value remains below 480,000 bytes. Tests also check complete source preservation within the generation-input cap and cancellation without saved drafts. No Slack, production storage or inference API is called.
