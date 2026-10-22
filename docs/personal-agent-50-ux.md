# Personal agents: UX contract for the additional fifty

Design specification, 2026-10-22. Audited baseline: deployed PR #58, commit `7a30db374bf3df702af5e28413468a04dc571862`. This document proposes integration work; it does not certify that the new catalog, commands, or fifty agents exist. The companion [acceptance checklist](personal-agent-50-acceptance.md) defines release evidence. The parent owns implementation assignments, integration, and rollout.

The outcome is **70 personal agents: the existing 20 plus 50 distinct additions**. Existing toolbox/core Slack functionality, navigation, favorites, and shared runtime hardening do not count toward the fifty. The feature catalog assigns ten implementation batches of five. Each addition needs a useful deterministic workflow and a distinct user outcome, not just a new prompt label.

## Priority decisions

| Priority | Decision | Reason |
| --- | --- | --- |
| P0 | Preserve `/nobo-help agent <id> ...`, private replies, signed workspace/user ownership, and text-only services. | Familiar entrypoint; no new credentials, external mutations, or broad access. |
| P0 | Ship catalog groups, lexical search, and complete pagination with the fifty. | Seventy agents must be findable; this is required integration, not another feature. |
| P0 | Keep help/catalog metadata separate from implementation imports. | Browsing should not initialize all agents, source adapters, or providers. |
| P0 | Every saved workflow has a stable ID, inspect/reopen path, honest status, and exact next command. | An ephemeral reply can disappear; the saved result must remain accessible. |
| P0 | Preserve data on malformed state, stale generation, capacity errors, and unavailable sources. | A friendly-looking success must never mask data loss or incomplete evidence. |
| P0 | New feature budgets are explicit and lower-only; no background work. | CPU, memory, provider spend, and Redis traffic stay bounded. |
| P1 | Add lightweight private action/form controls where they remove repeated long input. | Native Block Kit is enough; commands remain the accessible fallback. |
| P2 | Defer favorites and recent-use personalization. | Groups, search, and copyable commands solve initial discovery without reads/writes on every Home open. |

## What the baseline actually does

The audit follows [feature status](feature-status.md), the [agent guide](agent-features/README.md), and these code paths:

- [`lib/slack-commands.ts`](../lib/slack-commands.ts): identifies the private agent route, starts its 120-second deadline before access-policy I/O, passes signed identity/channel/trigger, and returns `response_type: "ephemeral"`, `mrkdwn: false`, with no background task.
- [`src/slack-bolt.ts`](../src/slack-bolt.ts): acknowledges first, dispatches through the active run context, then responds. Only `in_channel` responses enter slash-command conversation memory. Its catch-all error currently says only to retry; the integrated error design below is proposed work.
- [`src/slack-home-actions.ts`](../src/slack-home-actions.ts) and [`lib/slack-home-view.ts`](../lib/slack-home-view.ts): Home → More → Personal agents opens a private help modal. It renders the entire flat catalog using `textBlocks`, which chunks at 2,900 characters and silently keeps only twelve blocks. Current chunking avoids oversized sections, but is not a paginated catalog.
- [`registry.ts`](../lib/agent-features/registry.ts) and [`index.ts`](../lib/agent-features/index.ts): the baseline eagerly imports twenty implementations; catalog/help bypass feature startup, but import cost is already paid. Non-help commands initialize Redis, preferences, and services.
- [`runtime.ts`](../lib/agent-features/runtime.ts) and [`store.ts`](../lib/agent-features/store.ts): command/reply guards are 48,000/28,000 JavaScript string units; state values have a 512,000-byte UTF-8 ceiling; CAS retries are bounded at 32. The runtime's generic reply truncation suggests `show` or `export` without knowing whether those verbs exist. Do not rely on that as a complete result view.
- Existing good patterns: inbox exact-preview acceptance and reserved review bytes; workflows saved checkpoints with token/revision guards; travel complete timeline pages; research saved evidence pages and source-change comparisons. Preserve those behaviors and their existing syntax.

Some baseline feature-level guides still say “not deployed,” despite PR #58's deployed status in the current brief and top-level status. The integration owner should reconcile release wording separately. Historical test totals are not acceptance evidence for new work.

## Slack constraints and practical rendering budgets

Slack requires slash acknowledgement within three seconds; custom slash commands do not run in message threads. Keep the channel/DM composer as the documented entrypoint and never suggest a bare “yes” in a thread as agent confirmation. [Slack slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands/)

Slack allows 50 blocks per message and 100 per Home/modal view. Section text is limited to 3,000 characters. These are ceilings, not useful page sizes. Use single-column content; avoid ASCII tables, multi-column fields, emoji-only status, and elaborate cards. [Block limits](https://docs.slack.dev/reference/block-kit/blocks/), [section limits](https://docs.slack.dev/reference/block-kit/blocks/section-block/)

Product budgets for new views:

- Normal reply/help/list page: at most **3,500 JavaScript string units**, after display escaping and including next commands. Prefer 400–1,200 for mutation acknowledgements. This is an application readability target, not a Slack platform maximum.
- Detail/source pages: aim for the same budget; split oversized records into lossless parts with exact continuation commands. Retain the shared 28,000-unit emergency guard. No new ordinary flow should reach it.
- Native sections: target at most 2,500 rendered units per section, always below 3,000. Catalog modal: at most **20 blocks**, ten compact rows, one filter area, one navigation area. Page controls do not grow with total catalog size.
- Keep identifiers, confirmation tokens, URLs, and next commands intact. Clip only labeled previews. Split Unicode without creating lone surrogates; preserve original stored text. Recheck lengths after escaping.

The current slash route uses `respond`/the signed response URL, not `chat.postEphemeral`. If another private adapter is introduced, honor its own byte contract: Slack's `chat.postEphemeral` guidance recommends messages no larger than 4,000 bytes. A 3,500-character CJK reply is not a 3,500-byte reply. Ephemeral delivery is session-bound and not durable; never use the message itself as the only copy of saved work. [Ephemeral message behavior](https://docs.slack.dev/reference/methods/chat.postEphemeral/)

Use one final response per invocation; do not send all result pages at once. Slack response URLs permit up to five responses within thirty minutes, not an indefinite stream. Each requested page is a fresh interaction. [Interaction response limits](https://docs.slack.dev/interactivity/handling-user-interaction/)

Opening a modal needs a fresh trigger within three seconds. Update the existing catalog modal for filters/pages rather than repeatedly pushing views: Slack's stack holds only three views. Use the supplied view `hash` to reject stale UI updates; a view hash does not replace a record revision or authorization check. [Modal lifecycle and race prevention](https://docs.slack.dev/surfaces/modals/)

## One thin catalog for all seventy

Agreed foundation contract, supplied by the performance agent and parent:

```ts
type AgentFeatureResourceBudgets = {
  generations?: number;
  searches?: number;
  contextReads?: number;
  storeReads?: number;
  storeUpdates?: number;
};
type AgentFeatureMetadata = {
  id: string;
  title: string;
  description: string;
  help: string;
  group?: string;
  keywords?: readonly string[];
  example?: string;
  resourceBudgets?: AgentFeatureResourceBudgets;
};
```

`AgentFeature` adds the unchanged `execute(command, context)`. Each new `<id>.metadata.ts` has only a type import and a default literal satisfying `AgentFeatureMetadata`; the implementation imports and spreads that metadata. The parent imports metadata into the registry and uses `lazyAgentFeature(metadata, () => import('./<id>.js'))`. `agentFeatures` remains `readonly AgentFeature[]`. No implementation import, source read, service initialization, timer, or stored private content belongs in metadata. Preserve the existing twenty help strings when extracting them.

The fields are optional for source compatibility, but every shipped catalog entry must have a group, a concrete example, and useful keywords. Recommended authoring limits: title 48 units, description 100, up to six keywords of 24, example 240. Use one canonical group label from the table; the short slug is a navigation alias mapped centrally. Keep optional `resourceBudgets` out of everyday user help; show understandable “Uses model”/“Uses web search” labels only for the relevant action.

| Navigation slug | Metadata `group` | Existing twenty assigned here |
| --- | --- | --- |
| `plan` | Plan & prioritize | morning-brief, day-planner, meeting-prep, calendar |
| `capture` | Capture & recall | inbox, read-later, project-briefs, recall, memory-review, handoffs |
| `write` | Write & communicate | reply-coach |
| `decide` | Decide & analyze | research, decision-coach |
| `learn` | Learn & improve | learning |
| `life` | Organize life | relationships, travel |
| `review` | Review & maintain | weekly-review, playbooks, workflows, automation-audit |

Assign each new agent one primary group; use keywords for overlap. These seven user-facing groups are independent of the ten engineering batches. Preserve feature IDs across reordering; no duplicate aliases pretending to be new agents.

### Proposed slash discovery

These navigation commands require parent integration; they are not current commands:

```text
/nobo-help agent
/nobo-help agent catalog page 2
/nobo-help agent catalog group plan
/nobo-help agent catalog group plan page 2
/nobo-help agent search meeting
/nobo-help agent search meeting page 2
/nobo-help agent meeting-prep help
```

The empty route shows a short private-use sentence, the seven group aliases, ten catalog rows, `1–10 of 70 · page 1/7`, and exact next-page/help/search commands. Reserve `catalog`, `search`, and `help` as navigation names; validate future IDs against those names. Keep existing `<id> help` routes working.

Rows show `id — one-line purpose`, not full syntax plus title plus repeated disclaimers. Sort by fixed group order and then ID. Search is bounded, deterministic, case-insensitive token matching over metadata ID/title/description/keywords; rank exact ID, ID/title matches, then other matches, with ID tie-breaks. No embeddings, model call, Redis query, or search-as-you-type backend. Trim/collapse spaces, accept up to 100 query units, and parse only a terminal `page <positive integer>` suffix. Print the query and page so navigation can preserve both. Invalid pages and no matches give a working reset/group command, never an empty success.

Ten rows is a maximum: the renderer may use fewer if the full reply budget requires it, while showing correct ranges/counts and continuation. Static metadata pages can use numeric pagination without creating snapshots. Retain a single canonical catalog definition for help, search, Home, and registration checks.

### Proposed Home catalog

Retain Home → More → Personal agents; a direct “Personal agents” button near “Open toolbox” is inexpensive optional polish. The catalog modal initially shows the same first ten rows, an All/seven-group selector, and Previous/Next controls. Add search as a plain input submitted explicitly, keeping the query in view state. A per-row “Help” action opens or updates a short private detail view with a real example and a Back control that preserves page/query/group.

A selected agent displays its canonical slash command for use in the channel/DM composer. It does **not** execute a command merely because the user browsed or selected it. Home lacks the signed channel context needed for legacy source access; do not reconstruct a channel from preferences, a guessed recent conversation, or a copied action value.

Slack static selects already support type-ahead and allow 100 options, but a seventy-item selector with no purpose/explanation is not the whole catalog. Use the eight-option group control plus ten visible rows. [Static select behavior](https://docs.slack.dev/reference/block-kit/block-elements/select-menu-element/)

Catalog view state contains only validated group/query/page/feature IDs, never source text, owner credentials, or writable authorization. Identity comes from the signed interaction. Unknown or stale action values return to the catalog. A closed/expired modal should end quietly; do not open a DM or post publicly as fallback. UI errors offer the existing slash help route.

Help/catalog rendering performs no feature-storage, preference, context, model, or search work. Existing ingress policy checks and the separate general Home dashboard's reads still occur; do not claim that the entire Slack request performs zero I/O. Do not add feature usage counts to Home or read seventy namespaces for badges.

Favorites may later store at most ten explicitly chosen IDs in a bounded workspace/user preference. They must be optional, removable, and absent from the default help path's storage dependency. No implicit recent-use tracker or global private cache is needed for this release.

## Help that gets someone to a result

New feature help fits one normal page and has this order: one-sentence outcome, first realistic command, what happens next, compact command syntax, source/privacy boundary, and capacity/cleanup note. Each documented example must run against the real parser with fake dependencies. Do not use an invented ID as if it already exists; subsequent examples explain that the returned ID replaces `<id>`.

For example, the existing inbox supports this small workflow:

```text
/nobo-help agent inbox capture Review Maya's launch draft before Friday
/nobo-help agent inbox triage next
```

The preview must print the complete command containing the actual item and preview IDs. Acceptance changes only the private classification. Avoid repeating the capture or asking the user to remember which preview “yes” refers to.

For the existing workflow agent:

```text
/nobo-help agent workflows create Launch note | Beta is ready; testing takes two days. | Extract facts and open questions | Draft a short update | Keep it under 80 words
```

Creation returns an ID; show complete `run <id>` and `inspect <id>` commands. After two checkpoints, show `resume <id>` with the same ID. A user should never re-paste the input just to continue. Existing `inspect`, `tasks`, `trip`, and other verbs remain valid; new agents should favor consistent `list`/`show` unless a more specific verb has clear value. Do not claim every existing agent already implements every standard verb.

If help needs more than one page, offer static topic/page help before runtime startup, with commands that actually exist. Never send someone to `export`, `edit`, or `cancel` unless that feature supports it. Pipe-delimited commands must document literal-pipe handling or rejection; don't silently split pasted content into extra fields.

## Predictable private records and progressive work

New saved-record agents use this grammar where applicable. Stateless agents explicitly say that no result was retained and omit lifecycle verbs they cannot implement.

| Action | Required result |
| --- | --- |
| `list [filter] [page <n>]` | Stable IDs, concise title/status, range/total, deterministic order, exact next page. Empty list gives a realistic creation command. |
| `show <id> [page <n>]` | Saved input/result, status, revision or snapshot time, provenance summary, next action. Full long fields have a lossless part view. |
| `create` / `capture` / `add` | Validate first; acknowledge only a confirmed save. Return ID and complete next command. Preserve input as saved once. |
| `edit <id> ...` | Update only explicit fields, show what changed, invalidate dependent previews/results when required. Review forms carry the base revision. |
| `preview` / `draft` / `analyze` | Label generated interpretation, show its source scope and saved/unsaved state. Never imply a suggestion was performed. |
| `confirm` / `accept` | Bind to the exact item and preview token/revision; reread current state and reject replaced/expired previews. Only local private state changes. |
| `delete <id> confirm` | Without confirmation, show the item and consequence. With it, remove only the named owned record. Never resurrect it from in-flight work. |
| `cancel <id>` / `pause <id>` | If supported, revoke the active attempt; preserve completed checkpoints. Distinguish terminal cancellation from resumable pause. |

An explicit CLI `delete <id> confirm` expresses intent to delete the current item. A confirmation based on an earlier screen additionally binds that screen's record revision; a literal `confirm` alone is not a stale-screen guard. Bulk reset needs a separate explicit scope/count/token and must not be the only normal quota recovery path. Do not build bulk deletion solely for consistency.

Use one status line and one main next action. Example copy patterns, with real IDs filled at runtime:

```text
Saved privately: <id> · Ready
Next: /nobo-help agent <agent> analyze <id>

Draft saved: <id> · Needs review · revision 3
Based on 4 supplied notes, captured Oct 22, 2026, 10:00 America/Chicago.
Next: /nobo-help agent <agent> show <id>

Paused: <id> · 2 of 3 steps saved
Next: /nobo-help agent workflows resume <id>
```

For long form workflows, native optional controls can carry item IDs/preview tokens and prefill current values. Reauthorize and reread on every action, validate view state as untrusted input, and keep the same runtime/admission/deadline/receipt protections as slash invocation. Do not add a persistent per-user “current item” implicit session: two Slack windows must not accidentally edit each other's selected record. Concrete copied commands are the minimum complete progressive workflow; forms are additive.

### Complete pagination

Separate discovery pages, saved-record lists, and complete record/evidence parts. Ten list rows and five long-detail rows are useful defaults; byte/text fit controls the final size. Include filter, range, count, ordering, and exact next command. Always provide a reopen-by-ID path independent of page order.

Use a stable ordering with ID tie-breaks. Saved comparisons and evidence pages carry their revision/snapshot; if it changed between page requests, state that and require a restart or serve a retained immutable revision. Do not label a current list as a frozen snapshot. For simple lists, recompute counts, show “current list,” and explicitly handle an out-of-range page after deletions. Navigation cannot mutate domain records, regenerate, search the web, or silently discard sources to fit a page.

Test the final item at maximum capacity, including after filtering. A “show/export for more” hint is insufficient if the specific item cannot actually be retrieved. If a stateless result cannot fit completely, offer a deterministic detail command against its declared source snapshot or reject it before expensive work and ask for a narrower request; do not manufacture a saved ID.

## Empty, unavailable, stale, and busy states

| State | Private reply and next action |
| --- | --- |
| Empty, read succeeded | “No saved items yet.” Include one real create example. Zero data is not a failure. |
| Query has no matches | State query/scope, then show catalog/list reset or a broader search example. |
| Bad input | Name the invalid field and allowed form; one corrected example. Preserve valid form fields when a form exists. No provider call. |
| Missing/foreign item | “Item not found in your private records.” Give this agent's list command; don't reveal another owner's existence. |
| Redis unavailable | State that saved work could not be loaded/saved and provide static help/retry. Do not pretend there is no data. |
| Source failed or exceeded bound | Name the source category; say it was not read completely. Keep the prior snapshot. Do not produce a complete-looking plan/inventory. |
| Model/search unavailable | Keep original input and last good output. Say which optional operation failed and give its explicit retry/show command. No automatic retries. |
| Stale edit/result | “This item changed while the draft was running. The stale result was discarded.” Give exact show/retry; don't overwrite newer work. |
| Quota reached | Give item count and saved/reserved bytes where available, identify the rejected change, and give a working list/delete command. Never auto-evict. |
| Duplicate receipt | Request was already received; point to an actual list/show/status verb. Do not call it completed merely because a receipt exists. |
| Admission busy | “Your agent request was not started. Try again after current work finishes.” No receipt, queued work, or retry timer. Scope the wording to user/global saturation when known. |
| Timeout/cancel | State only confirmed checkpoints, then offer inspect/retry if supported. If a save was already dispatched, say its outcome could not be confirmed and ask to inspect before repeating. |
| Corrupt/unsupported state | Say saved data could not be read safely. Preserve it, leave help available, and identify a documented recovery route; never silently reset. |

Privacy does not mean inputs never leave the app: model-assisted operations send explicit supplied material to the configured text model; web research sends its query to the configured search service. Explain that at the relevant action/help, not in a repeated catalog wall of caveats. Do not claim these agents send messages, book events, schedule jobs, or change external accounts.

## Source, provenance, and date contract

Use the actual [owned-source contract](agent-features/context.md) and [`AgentContextItem`](../lib/agent-features/types.ts). Available sources are five toolbox kinds (notes, goals, habits, journal, bookmarks), confirmed calendar imports, eligible approved memory cards, and eligible caller-owned legacy records in the signed current channel. Other toolbox tools, arbitrary sibling agents, artifacts, legacy personal memory, channel history, and general Slack search are not connected through `readContext`.

Every new feature declares exact kinds. Prefer one selected-kind read per operation; no source traversal from help/list/show. Missing sources, empty sources, unreadable sources, and truncated excerpts have different meanings:

- Read failures stop operations that claim complete inventory/availability. The adapter has no partial-completeness envelope; do not catch a failure and replace it with `[]`.
- A selected subset is labeled “based on N of M available items” where M is known. Evidence excerpts are not the entire underlying document. Respect `textTruncated`/`titleTruncated` and feature scan bounds.
- Stable source IDs and permitted URLs accompany claims. Pasted material uses a clearly labeled local input/reference ID. Invented source IDs, citations, publication dates, or nonexistent source links are rejected.
- Show separate **captured/read time**, **source update time**, and **publication/event time** when relevant. Missing metadata stays unknown. A generated summary is interpretation, even when its citations validate.
- “No longer in this permitted snapshot” is not “deleted everywhere,” “disproven,” or “completed.” Source authorization can change between invocations; reread scope before refresh.

For features detecting changed evidence, fingerprint a canonical bounded representation of stable source ID, kind, relevant content, source dates/status/metadata, and meaningful URL. Sort object keys/set-like fields where appropriate. Do not include read time, enumeration order, or display-only formatting. Reordering identical evidence must not signal change; a changed due date, completion status, excerpt, URL, or citation binding must. Include a fingerprint/schema version, and disclose excerpt-only coverage when adapters clip content. Never claim to detect changes in the unavailable tail of a source. A fingerprint is not an authorization capability.

If confirming a preview promises to use current source values, reread the same declared kinds in that confirmation invocation and compare its source fingerprint as well as the local record revision. Changed evidence needs a new preview. A historical draft may retain its captured evidence without rereading, but must identify that snapshot. Multiple source reads are not one cross-source transaction; describe capture time/scope rather than promising a globally atomic live view.

Use the runtime's one `now` and caller IANA timezone. Keep `YYYY-MM-DD` labels as civil dates; don't convert a goal deadline into a timezone-shifting midnight instant. Normalize actual timestamp offsets and reject invalid dates. Calendar all-day intervals retain original civil dates and exclusive ends; equal-start/end timed events are nonblocking instants. DST gaps/overlaps need explicit handling, never server-local guessing. A source `updatedAt` is not proof of completion, successful automation delivery, or current truth. Display the timezone beside schedules/availability so the user can act correctly.

## Runtime, storage, and cost contract

The performance foundation preserves maximum per-invocation budgets of **8 generations, 6 searches, 8 context reads, 64 logical store reads, and 32 logical store updates**. Metadata can only lower them with nonnegative integers. Internal CAS retries are a separate 32-attempt bound. Integration must not interpret omitted or malformed values as unlimited.

For the new fifty, default to zero searches, zero or one explicitly invoked generation, and at most one selected-kind context read. Set unused services to zero. Declare realistic logical store budgets covering the longest supported command, including validation and saved checkpoint transitions. A deterministic feature might declare `{ generations: 0, searches: 0, contextReads: 0, storeReads: 2, storeUpdates: 1 }`; this is an example to verify against its actual flow, not a universal template. List/show must remain deterministic even in a feature that has an optional generated draft.

The integrated performance foundation (`df89fdc`) admits work before expensive startup and request receipt creation, with defaults of **three active invocations process-wide and two per workspace/user**. This supersedes the earlier eight-global design proposal. The performance agent's full benchmark report is forthcoming; these defaults are not a throughput or production cost-savings claim. Busy responses do not spend provider calls. No unbounded queue, retry storm, automatic generation on Home open, or per-feature background poller. Keep one replica under the current process-local cancellation contract.

Maintain the original 120-second ingress deadline through policy, startup, source reads, generation, and storage; don't restart it at each phase. Cancellation stops waiting promptly and forbids subsequent feature work/writes after the signal is observed. It cannot roll back a Redis CAS already sent, prove a provider stopped charging, or retract a response already delivered. Active generation must compare current record revision/attempt token before saving. Delete/edit/cancel winning first prevents stale output from recreating or overwriting that record. Treat ambiguous saves as inspect-before-retry, not a guaranteed rollback.

Measure serialized JSON with `Buffer.byteLength(..., 'utf8')`, not character counts or record counts alone. New features should choose a small explicit quota suited to the workflow, always below the 512,000-byte hard ceiling; 480,000 is an upper operating ceiling used by existing modules, not a recommended default allocation for seventy agents. Bound all record/history counts and key counts. Reserve room at admission for later outputs, revisions, previews, status, and cancellation. Account for JSON escaping and Unicode, not just three bytes per visible character. Keep near-quota data inspectable and deletable; don't require another generated result before freeing space.

Reuse source references and bounded evidence excerpts instead of copying an entire context snapshot into every checkpoint. No global private-content cache, persistent provider-response cache, new service, new secret, heavier UI framework, or new scheduler is required. Detailed budgets and meaningful tests belong in each feature's four owned files: implementation, thin metadata, tests, and user guide. Shared registry/Home/runtime work stays with assigned integration owners.
