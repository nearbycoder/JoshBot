# Personal reply coach

`reply-coach` composes private reply suggestions from a conversation you paste. You choose the tone, length, and intent, inspect the suggestion, and revise it without losing the original conversation or earlier versions. It never sends a message or changes another account.

This module is ready for parent integration. The intended entry point is `/nobo-help agent reply-coach <command>`; the parent must register it before these Slack commands are available. All results must be delivered privately.

## A complete workflow

Optionally approve a sample of **your own writing** for reuse as a style example:

```text
/nobo-help agent reply-coach style approve Thanks for thinking of me! I appreciate the invite, but I can't make it this time.
/nobo-help agent reply-coach style show
```

Approval is explicit: examples are not collected from Slack history, personal notes, or earlier drafts. Examples supply cadence, vocabulary, and formality, not facts or instructions. Drafting also works without examples.

Paste a conversation and state the outcome you want:

```text
/nobo-help agent reply-coach draft warm | short | Decline the Friday invite without promising another date | Alex: Can you join dinner on Friday? Me: Let me check.
```

The result includes a stable `d-<UUID>` ID, a suggested reply, the selected settings, and a reminder that nothing was sent. Use the **full returned ID** in the following commands, replacing `<draft-id>`:

```text
/nobo-help agent reply-coach revise <draft-id> | direct | - | - | Remove the apology and keep it friendly.
/nobo-help agent reply-coach show <draft-id>
/nobo-help agent reply-coach show <draft-id> 1
/nobo-help agent reply-coach list
```

`-` in a revision retains the previous tone, length, or intent. You can change all three:

```text
/nobo-help agent reply-coach revise <draft-id> | professional | medium | Decline Friday and ask what next month's options are | Ask a question without committing to a date.
```

`show` displays the selected version, the original supplied conversation, its style example IDs, and the complete revision lineage. The optional version number lets you copy an earlier reply. Revisions always extend the current version; there is no rollback or branching command.

Review the text and any listed commitments, then manually copy the reply wherever you want to use it. Clean up when finished:

```text
/nobo-help agent reply-coach discard <draft-id>
/nobo-help agent reply-coach style reset
```

`discard` deletes that draft's conversation and **all** its versions. `style reset` deletes all saved examples. Reset does not rewrite old replies or erase their historical style IDs; discard those drafts to remove their text too. There is no automatic expiry.

## Command reference

- `help`: syntax, available tones, and a realistic example; no model required.
- `style approve <example>`: explicitly approve a writing sample. Identical samples are deduplicated. To replace a set, use `style reset`, then approve the desired samples.
- `style show`: view approved samples and their approval times.
- `style reset`: delete all approved samples, including invalidating generations that were using the prior style set.
- `draft <tone> | <length> | <intent> | <conversation>`: create a new draft with one generation request.
- `revise <draft-id> | <tone or -> | <length or -> | <intent or -> | <instructions>`: generate one new version, retaining the original conversation and all prior versions.
- `list`: list draft IDs and their latest version/settings/intent, actual UTF-8 storage usage, and bytes reserved for remaining versions.
- `show <draft-id> [version]`: inspect the latest or a specific saved version, including the original context and lineage.
- `discard <draft-id>`: delete the draft, supplied context, and complete revision history.

Commands, tones, and lengths are lowercase. Tones are `warm`, `professional`, `direct`, `empathetic`, and `casual`. Lengths cap the generated reply at `short` = 600, `medium` = 1,400, and `long` = 2,400 characters; they are upper limits, not exact targets.

Only the leading `|` separators are syntax. The final pasted conversation or revision-instructions field may contain pipes and newlines. Other fields cannot contain pipes. Outer whitespace is trimmed; the retained conversation is otherwise unchanged. Revising does not replace the conversation; start a new draft for a different conversation.

## Retention, grounding, and failure behavior

- At most **12 drafts**, **8 versions per draft** (including the initial version), and **5 approved style examples** are stored. Limits reject additional work; they never silently evict history. Use `show` to copy any version you want to keep before discarding it.
- The whole saved JSON value must remain **below 480,000 UTF-8 bytes**, leaving headroom beneath the runtime's 512,000-byte ceiling. The feature measures `Buffer.byteLength(JSON.stringify(state), "utf8")`; character counts alone are not storage measurements. Unicode and JSON escapes can occupy more bytes than their source string length suggests.
- Each complete version (settings, intent, revision instructions, reply, commitment quotes, and metadata) is limited to **16,000 serialized UTF-8 bytes**. A larger generated version is rejected without changing history; request a shorter reply and use briefer intent/instructions before retrying.
- Admission reserves **16,001 bytes for every remaining version** of each accepted draft (one byte accounts for the JSON array comma), **64 bytes of metadata headroom**, and any remaining growth of the initial style token. New drafts and style examples cannot spend these reservations. Consequently, the byte quota can stop new drafts before the count limit; a set of short, un-revised drafts normally reaches that point at four. Reserving all remaining versions lets accepted drafts continue through version eight, provided each version respects its individual limit. Unused reservation space is released as revisions are saved.
- `list` shows actual and reserved byte usage. A quota error tells you to copy needed versions using `show`, then **`discard <draft-id>`** to release its context, history, and remaining reservation, or **`style reset`** to delete examples. Cleanup checks actual storage size rather than requiring fresh revision reservations, so older over-reserved state can still be reduced. Byte checks run again inside the atomic save to prevent concurrent commands from spending the same space.
- Conversations are limited to **8,000 characters**, intents to **600**, revision instructions to **1,000**, style examples to **1,200**, and the entire command to **12,000**. Limits use JavaScript string length (UTF-16 code units). Blank fields and control characters other than tabs/newlines are rejected.
- Only the pasted conversation, approved examples, current reply, and bounded prior caller instructions go to the injected text generator. There are no searches, context imports, attachment fetches, model tool calls, or outbound sends.
- Generation instructions forbid unsupported facts, promises, deadlines, and claims that the application has sent or changed anything. A participant's request in the pasted conversation does not authorize a commitment. The caller must authorize a promise in their intent or revision instructions.
- The generator must declare commitments using exact reply excerpts and exact authorization quotes from caller instructions. The module checks those substrings and shows the declarations for review. These lexical checks do **not** prove semantic support or catch promises the model fails to declare. Suggestions remain unverified: check facts, commitments, and wording before manually copying them.
- Model output is parsed as bounded JSON data, never executed. Malformed output, unsupported declared commitments, excessive response lengths, and provider failures leave existing drafts and examples untouched. There is no automatic retry or fallback that fabricates a reply.
- A command uses at most **one generation call and zero searches**, below the runtime's budgets of eight generations and six bounded searches. The runtime enforces the **120-second deadline**, stops waiting promptly on cancellation, and guards late writes. Serialized model input is checked against its 80,000-character ceiling; very large escaped source/history data requires shorter inputs or removal of examples. The feature does not silently truncate the original conversation or bypass the runtime's limits.
- A draft or style change during generation prevents stale output from being saved. Deleting a draft wins over an in-flight revision. Concurrent revisions of one draft cannot overwrite one another. Unrelated draft changes are merged using atomic updates. If capacity fills during generation, the extra result is rejected.
- Timestamps are stored as ISO UTC strings and displayed in the runtime-supplied timezone. An invalid clock or timezone produces an actionable error instead of falling back to the server's timezone.
- Invalid persisted state is rejected without automatic repair or data loss. Storage errors advise checking `list`/`show` before retrying. A response lost after a successful persistence operation can require runtime request deduplication; this feature does not deduplicate transport deliveries.

## Exact parent integration requirements

1. Import the named or default `feature` from `lib/agent-features/reply-coach.ts` and register ID **`reply-coach`**. Route the command suffix to `feature.execute(command, context)` and expose `feature.help` in help/Home discovery.
2. Inject `AgentFeatureContext` with authorized workspace/user identity, `now`, the user's configured IANA `timezone`, optional cancellation signal, and the implemented **atomic, workspace/user/feature-scoped** store. This module owns one key, **`state`**, with schema version **1**, and applies a stricter storage budget than the runtime's 512,000-byte limit. Reservations are derived from existing records, with no schema or shared-store change. Do not expose this state through channel-wide context. Transform callbacks may retry and must not commit if they throw.
3. Provide `services.generate` as the existing text-only adapter. Each `draft`/`revise` uses at most one call; deterministic commands use none. Keep its `instructions` separate from the JSON `input`. The expected response is raw JSON with exactly `reply` and `commitments` (no Markdown fences):

   ```json
   {"reply":"Thanks for asking. Friday won't work for me.","commitments":[]}
   ```

   Each commitment, if present, has exactly `text` (an exact reply substring, up to 400 characters) and `authorization` (an exact caller-intent or revision-instruction substring, up to 600). At most five are accepted. Raw generated JSON is limited to 12,000 characters. No structured-output SDK change is required.
4. Acknowledge long-running generation through the parent's usual async path and deliver **all** results privately. Render returned text as literal text with mention/link expansion disabled; pasted conversations and generated replies are untrusted text. Do not create a send button or automatically publish/copy suggestions elsewhere. Returned output fits under 28,000 characters even at the documented field limits.
5. Use the implemented shared authorization, cancellation/deadline guards, and delivery deduplication. The feature also checks cancellation before generation and after it returns. No new service interfaces, dependencies, package changes, shared runtime/store changes, recurring jobs, context adapter, or production configuration are required by this feature.

## Verification

Tests use `tests/agent-feature-test-utils.ts` and fake generation only:

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-reply-coach.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```

The suite covers the complete composition flow, style approval/reset, original-context preservation, revision lineage, malformed input/output/state, commitment quote validation, provider failure, deletion and edit races, style reset races, capacity, pure retryable transforms, timezone display, scoped isolation, response-size bounds, Unicode/JSON-escape byte accounting, concurrent quota admission, and completing all reserved revisions near the storage budget. No live model, Slack, Redis, or other production API is used.
