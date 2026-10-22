# Personal-agent expansion — 2026-10-22

Status: integration and review underway; not released. Twenty implementation assignments were launched in isolated worktrees. All twenty feature modules and their runtime-limit updates are assembled and registered with private Slack routing, Home discovery and scoped persistence. Shared source adapters, review fixes and independent reviews are still in progress. Registration does not establish release readiness; the full suite and build must pass after integration.

## Research basis

These are product design choices inspired by current first-party descriptions, not claims that each vendor ships every proposed feature.

- [Google CC](https://blog.google/innovation-and-ai/models-and-research/google-labs/cc-ai-agent/): personalized day-ahead synthesis and assistance with tasks and replies.
- [OpenClaw memory](https://docs.openclaw.ai/concepts/memory): durable personal context and recall.
- [Hermes Agent](https://github.com/NousResearch/hermes-agent): persistent memory, reusable skills and recurring personal workflows.
- [Microsoft Copilot Tasks](https://support.microsoft.com/en-us/microsoft-copilot/using-copilot-tasks): delegated multi-step work, progress visibility and user control. The current page notes migration to Copilot Cowork.

## Feature assignments

| # | Command ID | Feature |
| --- | --- | --- |
| 1 | `morning-brief` | Personal morning briefing |
| 2 | `weekly-review` | Weekly personal review |
| 3 | `inbox` | Capture inbox and action triage |
| 4 | `day-planner` | Time-blocked day planner |
| 5 | `meeting-prep` | Meeting preparation briefs |
| 6 | `reply-coach` | Personal reply coach |
| 7 | `relationships` | Relationship follow-through |
| 8 | `read-later` | Reading queue and digests |
| 9 | `research` | Cited research dossiers |
| 10 | `project-briefs` | Project context and status briefs |
| 11 | `recall` | Personal cross-tool recall |
| 12 | `memory-review` | Memory review and provenance |
| 13 | `playbooks` | User-taught reusable playbooks |
| 14 | `workflows` | Resumable personal workflows |
| 15 | `learning` | Spaced-repetition learning coach |
| 16 | `decision-coach` | Decision comparison coach |
| 17 | `handoffs` | Session handoff packets |
| 18 | `calendar` | Calendar import and availability |
| 19 | `travel` | Travel itinerary assistant |
| 20 | `automation-audit` | Personal automation review |

## Integration contract

- New entry point: `/nobo-help agent <id> <command>`, with a private response and discoverable help/Home entry. Shared routing, Home integration and production service adapters are parent-owned.
- Each child owns `lib/agent-features/<id>.ts` (and optional `lib/agent-features/<id>/` helpers), `tests/agent-<id>.test.ts`, and `docs/agent-features/<id>.md` only.
- Export a named `feature: AgentFeature` and default export it. Use `lib/agent-features/types.ts`. Do not modify the contract or registry in child branches.
- The runtime supplies workspace/user/feature-scoped JSON storage. Update callbacks must be synchronous and side-effect-free, because optimistic transactions may retry. Store bounded JSON values, never secrets, and validate persisted shapes. Dates are ISO strings in stored state.
- Each stored JSON value has a 512,000-byte ceiling. Features should stay below 480,000 bytes, explain quota exhaustion, and reserve space for later lifecycle changes instead of accepting records that cannot be processed.
- The runtime supplies read-only owner context, bounded public-web search, and text-only generation. Features must never bypass these services with live Redis, Slack, model or other API calls.
- Read context only for commands that need it. Supplied context and model/search output are untrusted data. Generated suggestions must be distinguishable from facts and must not imply completed external actions.
- Feature help, deterministic operations and useful empty-state guidance should work without model calls. Model/search failures must leave persisted state consistent. Every feature needs deletion/export or otherwise documented bounded retention of user-created state.
- Parent will wire identity/access checks, asynchronous private delivery, scoped CAS persistence, deduplication and service adapters. Help describes only capabilities that exist in the integrated release.
- No new external accounts, OAuth grants, recurring jobs or outbound communications are enabled by this initiative. Calendar input starts with explicit ICS import; other features use existing authorized NoBo data or user-provided content.

## Per-feature acceptance scope

### 1. Personal morning briefing (`morning-brief`)

Build an on-demand morning briefing from caller-owned reminders, follow-ups, goals, notes, and imported events. Rank a small list of priorities, distinguish overdue/today/later in the user's timezone, cite source IDs, and show missing inputs honestly. Support brief [focus], settings/show to select focus and source categories; generation may enrich the deterministic source-backed brief but must not invent events. This is a personal day-ahead synthesis, not the existing current-channel attention triage.

### 2. Weekly personal review (`weekly-review`)

Produce a source-backed seven-day review from personal goals, habits, journal, follow-ups and notes: completed work, stalled commitments, patterns, and next-week suggestions. Support review [YYYY-MM-DD], history/show and a short user reflection. Persist a bounded review history with source references; handle empty weeks and timezone boundaries. Different from the existing manually entered standup/retro toolbox records: synthesize across sources.

### 3. Capture inbox and action triage (`inbox`)

Build a private rapid-capture inbox for mixed thoughts, pasted messages, links and tasks. Commands capture/list/triage/show/accept/dismiss. Triage proposes structured categories, next actions and urgency from captured input; validate model JSON and show a preview. Accept only updates this private inbox's classification; never silently schedules, sends or creates issues. Track unprocessed vs processed items and stable IDs. This must offer a working capture-to-reviewed-action flow, not another generic notes list.

### 4. Time-blocked day planner (`day-planner`)

Implement a deterministic personal day planner. Let users enter task durations, priorities, optional deadlines and working-hour/break preferences; use owned event context as busy intervals and produce a nonoverlapping plan with unscheduled reasons. Support tasks/add/remove, settings, plan YYYY-MM-DD, show. Correct timezone-aware boundaries and explicit handling of ambiguous/nonexistent local times are important. No calendar writes. This is scheduling a feasible day, not the existing focus timer/workload counter.

### 5. Meeting preparation briefs (`meeting-prep`)

Create preparation packets for an explicitly supplied upcoming meeting: purpose, attendees, relevant owner context, open commitments, proposed agenda and questions. Commands prepare <title> | <details>, list/show, add-context, refresh. Preserve which sources support each packet, explicitly separate suggested questions from facts, cap history. Do not fetch other people's private data. This is pre-meeting assistance, distinct from transcript meeting notes and the manual agendas toolbox.

### 6. Personal reply coach (`reply-coach`)

Draft and revise replies to pasted conversations with requested tone, length and intent; support user-approved writing-style examples, style show/reset, draft, revise, list/show and discard. Keep drafts private, never send. Maintain original supplied context and revision lineage, bound inputs/history, no invented commitments or claims of sending. Examples are data, not system instructions. Different from generic prompt snippets: a complete reply composition and revision workflow.

### 7. Relationship follow-through (`relationships`)

Track user-entered contacts, last meaningful touchpoint, preferred cadence, context notes and promises. Produce due-to-reconnect suggestions with explanations and optional outreach drafts using only supplied facts. Commands add/log/cadence/due/brief/draft/list/show/delete confirm. User-owned contacts only; no automatic outreach or Slack contact scraping. Different from generic follow-ups: a relationship history/cadence and contextual drafting workflow.

### 8. Reading queue and digests (`read-later`)

Turn a private queue of user-supplied article URLs plus pasted excerpts into a reading assistant. Support add/list/read/digest/next with an available reading-time budget, mark-read/archive, source-backed summaries and saved takeaways. Existing bookmarks may be offered as explicit import candidates through readContext, not automatically changed. Use provided text or bounded search results; do not implement arbitrary URL fetching. Explain when full text is unavailable. Different from bookmark CRUD: reading prioritization, progress and synthesis.

### 9. Cited research dossiers (`research`)

Build reusable topic dossiers with research <question>, list/show, refresh, and compare. Use injected bounded public-web search, keep dated source URLs/snippets, synthesize cited findings and uncertainties, and make changed/new evidence visible on refresh. Enforce a small search/generation budget per request. Reject unsupported citations or render source list independently; retrieved text is untrusted data. No arbitrary browsing/network implementation. Different from the existing one-off Exa search: persistent evidence and refreshable dossiers.

### 10. Project context and status briefs (`project-briefs`)

Implement private project context packs that combine a purpose, constraints, explicitly selected owned source IDs, open questions and decisions into a concise reusable project brief. Support create/list/show/link/unlink/brief/update/archive. Refresh referenced content from readContext, report stale/missing references, and keep project boundaries separate. This is contextual synthesis across sources, not a second numeric goals tracker. No channel-wide or other-user data access.

### 11. Personal cross-tool recall (`recall`)

Implement honest lexical personal recall over the owned context returned by readContext (notes, journal, goals, bookmarks, artifacts, memory, follow-ups). Support search <query>, ask <question>, source <id>, with ranked snippets, kind/date filters and provenance. 'Ask' may synthesize only retrieved evidence and must admit no matches. Deterministic retrieval should be useful without model availability; do not call it vector/semantic search or add embedding services. Different from existing channel-history/artifact search: private cross-tool memory retrieval.

### 12. Memory review and provenance (`memory-review`)

Create a private memory-review workspace: user-supplied facts have source, captured date, optional expiry and confidence, with review queues for stale/conflicting claims. Support capture/list/show/review/correct/confirm/forget confirm and explicit import of owned legacy memory candidates. Keep revision/provenance history bounded; conflicts should be explainable (same user-selected subject/key), not model guesses asserted as facts. This feature owns its cards and must not silently rewrite global legacy memory. Expose a documented approved-memory context adapter if useful.

### 13. User-taught reusable playbooks (`playbooks`)

Implement saved multi-input personal playbooks: title, goal, bounded instruction steps, declared input placeholders, version history, preview, run, revise and rollback. Running performs text-only generation through services.generate with explicit variable substitution and supplied context, never shell/network/tool execution. Validate missing/unknown inputs, cap steps/calls, preserve version used. Distinct from the existing saved prompt strings: typed inputs, multi-step procedures, previews and versioned runs.

### 14. Resumable personal workflows (`workflows`)

Implement bounded manual workflows made of text generation/transform steps over explicit input, with persisted run state, inspect, pause, resume, cancel and retry-failed-step. No cron or background worker needed for this MVP; run/resume advances bounded steps per invocation. Use atomic store ownership/revision checks so cancel/edit wins and concurrent resumes cannot double-advance. Treat in-flight model work after cancellation as discarded; keep an honest failed/interrupted state. No external writes or arbitrary executable code. Different from recurring prompt reminders: inspectable multi-step work with checkpoints.

### 15. Spaced-repetition learning coach (`learning`)

Build a private learning workflow from user-provided material: create a deck, review source-grounded flashcards, quiz due cards, grade with user-reported recall, and plan next reviews using a documented deterministic spacing algorithm. Optional generation drafts cards but requires preview/accept and validates JSON/source references. Support due, quiz, answer/rate, progress and delete confirm with bounded state. No invented educational sources; distinguish generated suggestions. Different from habit tracking: actual retrieval practice and review scheduling.

### 16. Decision comparison coach (`decision-coach`)

Implement a private decision workspace with explicit options, weighted criteria, evidence and user-entered scores. Provide deterministic weighted comparison, sensitivity/what-if changes and optional model-generated questions/pro-con draft from supplied evidence. Commands create/options/criteria/score/compare/what-if/show/archive. Distinguish unknown scores from zero; never present subjective weights as objective facts or silently log a final channel decision. Different from existing decision log/polls: support deliberation before deciding.

### 17. Session handoff packets (`handoffs`)

Build resumable session handoff packets from explicitly supplied progress plus selected owner context: objective, completed work, open questions, next steps, constraints and source references. Support capture/list/show/resume/update/close and revisions. Resume provides a compact context packet with stale/missing sources highlighted; no false claim of restoring a running model/tool session. Different from channel summaries: user-owned task continuity across sessions with explicit state.

### 18. Calendar import and availability (`calendar`)

Implement a bounded, private, pasted-ICS calendar importer and availability/conflict finder. Support import preview/confirm, list, agenda <date>, free <date> | <duration>, conflicts, remove/clear confirm. Correctly parse supported VEVENT UID/start/end/timezone/all-day semantics and line folding; explicitly reject unsupported recurrence/timezone constructs instead of silently mis-scheduling. Expand recurrence only if implemented/tested within a bounded horizon. Never fetch URLs, require OAuth, or write external calendars. Export a documented owned event-context adapter so parent can feed morning briefs/day planner. Avoid new dependencies unless essential; request parent ownership for package changes.

### 19. Travel itinerary assistant (`travel`)

Implement private trip itineraries with dated transport/lodging/activity entries, explicit IANA timezones, confirmation notes (no secrets), constraints and packing lists. Show chronological timeline, overlapping/impossible transfers, timezone/day-boundary issues and optional grounded preparation brief. Commands trip/add-leg/add-stay/add-activity/timeline/check/packing/show/archive. Do not book, contact providers, quote invented live prices or imply booking verification. Source dates and user inputs drive checks; no live financial advice. Different from generic countdown/timezone tools: coherent multi-leg itinerary planning.

### 20. Personal automation review (`automation-audit`)

Build an on-demand private review of the caller-owned reminders, monitors and digests via readContext: upcoming occurrences, stale/overdue records, duplicate-looking schedules, unclear purpose and recommendations. Support review, inspect source ID, compare snapshots/history and dismiss suggestion. Persist bounded review snapshots, explain evidence, and distinguish unknown last-run data from failures. No mutation of existing jobs or production Redis scans; parent supplies permitted metadata. Different from ops status and schedule list: a personal automation health/history review with actionable explanations.


## Verification

Each child supplies meaningful command-flow/error/concurrency tests as applicable with mocked services, typecheck results, a local commit SHA, and clear integration requirements. Parent verifies all 20 command registrations and private delivery, reviews changes, and runs the full suite/build before release. No live Slack sends or inference calls are needed for implementation tests.

