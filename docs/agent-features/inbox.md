# Capture inbox and action triage

Feature ID: `inbox`. Implementation is ready for parent integration; the commands below require registration in the private agent router.

Use the inbox for a thought, pasted message, task, link, or a mixture of these. A capture starts **unprocessed**. Triage proposes a category, a short summary, up to three concrete next actions, and urgency with reasoning. The proposal stays a preview until you explicitly accept it. Acceptance marks the item **processed / accepted** and saves its private classification. Dismissal marks it **processed / dismissed** without approving the proposal.

Acceptance does not complete a task, schedule a reminder, send a message, or create an issue. Suggested next actions remain yours to carry out. No external actions run from inbox commands.

## Commands

Prefix every command with `/nobo-help agent inbox`.

- `help`: command syntax, example, and retention limits; works without storage or a model.
- `capture <text>`: capture up to 4,000 characters, including multiple lines, pasted messages, links, and tasks. Returns a stable `inb_…` ID and a triage command. One invocation creates one capture; mixed text is summarized together rather than split into separate records.
- `list [unprocessed|processed|all] [page]`: show ten items per page, newest first. Default is `list unprocessed 1`. Counts distinguish unprocessed and processed items; previews are visibly marked. `processed` includes accepted and dismissed captures.
- `triage <item-id>`: generate or replace a preview for an unprocessed item. A successful preview has a stable `tri_…` ID. An existing preview is kept if generation fails or returns invalid data.
- `triage next`: prepare the oldest unprocessed capture that has no preview. Stops once every unprocessed capture already has a preview; it does not automatically approve anything or repeatedly replace pending previews.
- `show <item-id>`: show the original text and its pending preview, reviewed classification, or dismissal. Dates are displayed in the supplied user timezone.
- `accept <item-id> <preview-id>`: accept exactly the preview you reviewed. Copy the complete command printed by `triage` or `show`. An old preview ID cannot approve a replacement proposal.
- `dismiss <item-id>`: process an unprocessed capture without accepting any classification. Its original text remains available through `show` and `list processed`.
- `delete <item-id> confirm`: permanently remove the capture and its saved preview or classification. Works for any status and frees a storage slot. Without the literal `confirm`, no deletion occurs.

Use full item and preview IDs. Bare numeric IDs and shortened prefixes are not accepted. Already processed items cannot be triaged or reclassified; capture revised input as a new item, or delete the old capture when it is no longer needed.

## Example: capture to reviewed action

```text
/nobo-help agent inbox capture Sam asked for feedback on the draft by Friday. Also: a reusable launch checklist could help. https://example.com/draft
/nobo-help agent inbox list
/nobo-help agent inbox triage next
```

Triage might propose `mixed`, normal urgency because the calendar date is unclear, and next actions to read the draft and outline the checklist. These are generated suggestions, not verified facts. Review the complete source text and reasoning with `show`.

For example, if the returned IDs are `inb_f4ceae40-b9a1-4bce-85ba-90362759de35` and `tri_d75ac349-29aa-4f98-9c27-7ad3ad5b5630`, the review flow is:

```text
/nobo-help agent inbox show inb_f4ceae40-b9a1-4bce-85ba-90362759de35
/nobo-help agent inbox accept inb_f4ceae40-b9a1-4bce-85ba-90362759de35 tri_d75ac349-29aa-4f98-9c27-7ad3ad5b5630
/nobo-help agent inbox list processed
```

Substitute the IDs from your own responses. To discard a capture during review, use `dismiss <item-id>`. To free its storage slot afterward, use `delete <item-id> confirm`.

## Limits and failure behavior

- Maximum 100 retained captures, including accepted and dismissed ones. Records remain until explicitly deleted; there is no automatic expiry or silent eviction. A full inbox rejects further captures with deletion guidance. There is no bulk export command; `show` returns the original capture and classification for copying.
- Categories: `task`, `message`, `idea`, `reference`, `mixed`. Urgency: `high`, `normal`, `low`. Reference material can have no proposed next actions. Urgency is a suggestion and never creates a deadline.
- Only `triage` uses the model, with one text-only generation call per request. All other commands are deterministic. Triage uses only the selected capture, its capture time, the supplied current time, and timezone. It does not read other personal context, fetch URLs, search the web, or access Slack history.
- Captured text and model responses are untrusted data. They are never executed. Slack mention/link entities are escaped when displayed. Model output must be a bare JSON object with exactly the documented fields; Markdown fences, unknown fields, unsupported enum values, oversized responses, control characters, and invalid action arrays are rejected. Summary, urgency reason, and each action are limited to 240 characters; at most three actions are accepted.
- Model failure, invalid output, or cancellation leaves the existing capture and preview unchanged. A changed or deleted item causes in-flight generation to be discarded. If two triages start from the same revision, the first valid save wins and the other result is discarded. A concurrent acceptance or dismissal cannot be overwritten by a generation result.
- Malformed or unsupported persisted state is reported without resetting or overwriting it. Storage failures are reported without exposing backend details. If a write cannot be confirmed, check `list` or `show` before retrying; request deduplication belongs to the runtime.
- Relative dates remain source text. Displayed dates use the supplied timezone; an invalid runtime clock or timezone causes a helpful error instead of a server-local fallback. No background processing, model tools, external account changes, or outbound communications are implemented.

## Exact parent integration requirements

1. Import the named `feature` (or default export) from `lib/agent-features/inbox.ts` and register it once under ID `inbox`, using the existing `AgentFeature` contract. Add it to private agent help/Home discovery. Route `/nobo-help agent inbox <command>` to `feature.execute(command, context)` and preserve multiline command text.
2. Enforce caller identity/access checks and private delivery in the shared router. Return feature strings as private responses, with asynchronous acknowledgement/delivery for triage when needed. Feature output is bounded for a roughly 28,000-character Slack reply budget; the worst-case escape expansion is covered by a test.
3. Supply `context.store` already scoped by workspace, user, and feature. The only relative store key is `state`; its JSON shape is version 1 with at most 100 items. Each item has a stable ID, immutable captured text, ISO timestamps, a revision UUID, a status, and either a pending preview or an accepted classification. Implement atomic CAS semantics for `store.update`; transforms are pure, synchronous, retryable, and preserve other items. Generate IDs and timestamps outside transforms. Do not share this namespace with other features.
4. Supply `context.now`, a valid `context.timezone`, and optional `context.signal`. Supply `services.generate({ instructions, input })` as the existing text-only, tool-free service. Maintain the instructions/input boundary. No search, read-context adapter, new dependency, global Redis key, or other production API is required.
5. Apply the shared request deduplication policy before execution. This module does not consume `requestId`; separate capture invocations create separate stable records, even when their text matches. Handle corrupted-state inspection and any future migrations centrally without silently deleting user data.

No shared contract changes are requested. Routing, registry, access policy, persistence adapters, and private delivery remain parent-owned.

## Targeted verification

```sh
PATH=/tmp/joshbot-node24/bin:$PATH node --import tsx --test tests/agent-inbox.test.ts
PATH=/tmp/joshbot-node24/bin:$PATH npm run typecheck
git diff --check
```

Tests use the shared JSON-cloning store fixture and fake generation only. They cover the complete review flow, provider/schema failures, stable preview approval, concurrent capture/triage/review/delete, retryable pure transforms, retention/pagination, corrupt persisted data, timezone boundaries, cancellation, and escaped reply size. No live inference or production access is needed.
