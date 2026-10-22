# Fifty additional personal agents: implementation plan

Design date: **2026-10-22**. Baseline: deployed PR #58, commit `7a30db374bf3df702af5e28413468a04dc571862`. This document and [the catalog](personal-agent-50-catalog.json) are a **proposed implementation contract**, not a claim that these features are implemented, tested in Slack, or deployed. The parent owns integration, release decisions, and production verification.

The catalog contains **exactly 50 new user-facing features**, organized into ten implementation batches of five and seven navigation groups. Each record includes a distinct outcome, existing-neighbor comparison, complete command flow, acceptance cases, state/algorithm brief, resource limits, dependencies, and four exact owned paths. Its `workflow` and `acceptanceCriteria` fields are the feature-specific acceptance specification; **PA50-v1** below supplies common requirements. Examples use `/nobo-help agent <id>`. Replace uppercase placeholders with full IDs returned by earlier commands. Future-dated observations in examples are recorded when they happen, or exercised under a fixed test clock; they are not fabricated present-day history.

There are **34 entirely deterministic features**, **16 with explicit optional one-call model assistance**, and **six context consumers**. Every feature has a useful workflow with generation unavailable. All 50 have **zero search calls**, require no new credentials/packages/services, and create no schedules or background polling. Catalog/help/search/Home improvements are required navigation work and are **not counted among the 50**.

## Research and product direction

These are primary public sources read on **2026-10-22**, not independent proof of product efficacy. Publication dates are distinguished from access dates. Product announcements indicate available interaction patterns; vendor research is evidence about its own population and methodology. The proposed features and their usefulness to JoshBot are **design inferences**, not claims that the cited companies validated this particular feature list. Catalog `researchRefs` refer to these themes, not to external runtime integrations.

- **R1 — Attention and coordination cost.** Microsoft’s [Breaking down the infinite workday](https://www.microsoft.com/en-us/worklab/work-trend-index/breaking-down-infinite-workday), published **2025-06-17**, describes fragmented work and eroding workday boundaries. Its telemetry ends February 15, 2025 and excludes education/EU tenants; it is not JoshBot usage evidence. Design inference: prioritize interruption accounting, realistic capacity, context batching, meeting fragmentation, and explicit daily closure instead of more notifications.
- **R2 — Move from capture to actionable structure.** Todoist’s [2026 changelog](https://www.todoist.com/help/todoist/product-updates/2026-changelog-HD3jJAtLd), entry dated **2026-01-22** (page last updated **2026-10-12**), announces Ramble across platforms. Its [Todoist Assist documentation](https://www.todoist.com/help/todoist/todoist-and-ai/introduction-to-todoist-assist-KgPP22q5O), publication date not stated, describes actionable task rewriting and decomposition. Design inference: JoshBot already has capture/triage, so add bounded decomposition and explicit reading prerequisites rather than another inbox or voice/transcription integration.
- **R3 — Reusable, discoverable, reviewable assistance.** Notion’s [agent skills release](https://www.notion.com/releases/2026-09-15), published **2026-09-15**, describes a shared skills library. [Suggest edits](https://www.notion.com/releases/2026-08-28), published **2026-08-28**, emphasizes reviewing proposed changes. [Model controls](https://www.notion.com/releases/2026-09-09), published **2026-09-09**, addresses model selection and predictable cost. Design inference: provide lightweight navigation, explicit transformation previews, stable evidence references, and small optional assistance budgets. JoshBot’s existing playbooks/workflows already cover reusable procedures; do not rebuild them or imitate autonomous connected actions.
- **R4 — Work design matters beyond individual generation speed.** Atlassian’s [State of Teams 2026](https://www.atlassian.com/blog/state-of-teams-2026), published **2026-04-27**, studies coordination and fragmentation; its disclosed survey was conducted in January–February 2026. Design inference: add delegation boundaries, assumption tests, outcome reviews, change-impact paths, and process-wait accounting. These are private preparation tools, not claims of shared team state or measured enterprise savings.
- **R5 — Learning grounded in supplied material.** Google’s [Six ways to use NotebookLM to master any subject](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-student-features/), published **2025-09-08**, describes source-linked study interactions, explanations, and learning guidance. Its [mobile flashcards/quizzes announcement](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-app-quizzes-flashcards/), published **2025-11-06**, also makes source selection explicit. Design inference: retain exact supplied evidence and extend JoshBot’s existing spaced cards into teach-back, practice, prerequisite study, and real-world application; do not add duplicate flashcards.

The balanced direction is work execution, communication, reasoning, learning, and a smaller practical life-administration group. Most value comes from domain structure and transparent computation. AI is reserved for optional wording or interpretation where users can review the result. External calendars, email, maps, billing accounts, recordings, employer databases, and general document stores are **future optional integrations only**, absent from working functionality here.

## Audited baseline and duplication decisions

Read [feature status](feature-status.md), [the agent guide](agent-features/README.md), [source coverage](agent-features/context.md), [the toolbox guide](toolbox.md), relevant individual agent guides, and implementation contracts in `lib/agent-features/{types,registry,index,runtime,store,services,context}.ts`. Additional checks included `lib/ai.ts`, calendar/day-planner time helpers, learning state/schema, and the shared test fixture. The per-feature documentation still contains historical “not deployed” language; the top-level baseline and parent instruction identify PR #58 as deployed. This research does not modify that release documentation or claim a fresh live verification.

The existing **20 agents** are: `morning-brief`, `weekly-review`, `inbox`, `day-planner`, `meeting-prep`, `reply-coach`, `relationships`, `read-later`, `research`, `project-briefs`, `recall`, `memory-review`, `playbooks`, `workflows`, `learning`, `decision-coach`, `handoffs`, `calendar`, `travel`, `automation-audit`.

The existing **20 toolbox tools** are: `notes`, `bookmarks`, `checklists`, `prompts`, `snippets`, `glossary`, `journal`, `habits`, `timelog`, `focus`, `goals`, `countdowns`, `standups`, `retros`, `scorecards`, `agendas`, `releases`, `workload`, `timezones`, `textkit`. Core conversation, thread summaries/action extraction, polls, channel decisions, issue drafts, reminders, monitors, news/digests, attachments, artifact versions/diffs, lexical history search, preferences and Slack controls also remain baseline capabilities.

Every catalog record names its closest existing neighbors and the domain behavior that makes it additional. The closest new-feature pairs also have explicit boundaries:

- `task-breakdown` defines small actions and completion tests; `deadline-backplan` performs a dated prerequisite backward pass; `scope-slicer` computes mandatory prerequisite closure under a budget. They must retain those distinct algorithms.
- `capacity-forecast` exposes low/high multiweek overload; `context-batch` amortizes shared setup; `errand-batch` checks opening/service/travel windows. Neither context batching nor errands becomes another day planner.
- `assumption-tests` locks a numeric test criterion before observation; `habit-experiments` compares actual habit-date windows with explicit opportunity counts; `learning-transfer` records an application and reflection. They must not share a generic “experiment CRUD” implementation as their entire behavior.
- `document-critic` audits purpose/structure/rubric; `claim-check` maps draft spans to supplied evidence; `source-compare` aligns multiple source accounts; `argument-map` traverses support/objection relations. None is a generic summary, research/search alias, or verification guarantee.
- `teach-back` reviews an explanation against source concepts; `practice-lab` compares attempts on a stable rubric; `interview-practice` adds interview question types, exact STAR annotations, and speaking-time estimates. A generic prompt differing only in title does not satisfy these briefs.
- `feedback-builder` prepares feedback to give; `feedback-themes` examines received excerpts, source repetition and counterexamples; `difficult-conversation` supports explicit objection/response rehearsal. None is merely a reply-coach style preset.
- `checklist-lint` checks procedure quality and ordering and has **no completion tracker**; `process-friction` measures active/wait/handoff costs; `change-impact` computes downstream review paths. These do not recreate checklists, releases or scheduled automation audit.
- `meeting-load` measures interval fragmentation rather than availability alone; `shutdown-review` requires dispositions for loose ends rather than another morning/weekly summary or handoff packet.
- Life features must preserve their actual arithmetic: notice periods/cost normalization, date-or-meter servicing, recipe/unit subtraction, opening-hour feasibility, and cost-per-usable-unit. Generic lists with different labels are insufficient.

No feature count is awarded for navigation, aliases, extra commands, helper modules, metadata, documentation, or testing.

## Ten implementation assignments

Assignments are disjoint. Each slug `S` owns exactly `lib/agent-features/S.ts`, `lib/agent-features/S.metadata.ts`, `tests/agent-S.test.ts`, and `docs/agent-features/S.md`; the catalog expands every path explicitly. Each batch therefore owns **20 files**. No feature batch owns registry, runtime, context adapters, Home, shared tests/helpers, another feature, or these research deliverables. The parent integrates registration and documentation indexes.

| Batch | Exact five feature IDs | Primary domain work |
| --- | --- | --- |
| 01 Work planning | `task-breakdown`, `deadline-backplan`, `capacity-forecast`, `context-batch`, `scope-slicer` | Effort sizing, backward dates, capacity scenarios, setup costs, scope closure |
| 02 Execution quality | `blocker-lab`, `premortem`, `assumption-tests`, `decision-journal`, `estimate-calibration` | Evidence/guess separation, risk triggers, predeclared tests, outcome comparison, estimation errors |
| 03 Communication | `delegation-brief`, `boundary-script`, `feedback-builder`, `audience-brief`, `difficult-conversation` | Decision rights, explicit limits, observations, fact coverage, rehearsal |
| 04 Writing and evidence | `document-critic`, `claim-check`, `argument-map`, `redaction-desk`, `change-digest` | Anchored criticism, claim coverage, arguments, reviewed masking, classified diffs |
| 05 Learning | `teach-back`, `practice-lab`, `curriculum`, `mistake-patterns`, `learning-transfer` | Explanation review, attempts, prerequisite learning, recurrence, application |
| 06 Knowledge structure | `timeline-builder`, `concept-links`, `question-triage`, `source-compare`, `reading-path` | Temporal evidence, typed connections, blocking questions, source matrices, reading dependencies |
| 07 Daily rhythm | `meeting-load`, `interruption-audit`, `energy-patterns`, `habit-experiments`, `shutdown-review` | Calendar fragmentation, recovery cost, explicit energy, habit trials, closure |
| 08 Life administration | `renewal-radar`, `home-maintenance`, `pantry-plan`, `errand-batch`, `purchase-compare` | Notice windows, upkeep thresholds, inventory arithmetic, feasible errands, entered offer costs |
| 09 Professional growth | `achievement-portfolio`, `skill-matrix`, `interview-practice`, `goal-alignment`, `feedback-themes` | Attributed impact, evidence gaps, interview practice, effort contribution, received feedback |
| 10 Data and process checks | `data-cleanroom`, `number-audit`, `checklist-lint`, `process-friction`, `change-impact` | Table quality, arithmetic reconciliation, procedure audit, wait cost, downstream impacts |

All batches can start from the same foundation; **no batch depends on another new feature’s implementation or private records**. The parent can launch early batches from the catalog commit while the shared toolkit settles. Consume the toolkit’s actual API sketch; do not invent exports or broaden ownership to implement missing helpers. Start each batch with its simplest deterministic workflow, then implement its graph/parser/interval cases and optional generation. Parent-controlled cherry-picking and integration serialize shared changes.

## Fixed runtime and metadata contract

The parent has committed the compatible types as `88178fc` (source `e329ab9`). Feature execution stays `execute(command, context)`. `services.generate`, `services.search`, `services.readContext`, and scoped store methods remain unchanged. Each implementation imports and spreads its metadata; metadata has a **type-only** import and a default literal satisfying `AgentFeatureMetadata`:

```ts
// lib/agent-features/<id>.metadata.ts
import type { AgentFeatureMetadata } from "./types.js";
export default {
  id, title, description, help, group, keywords, example,
  resourceBudgets: {
    generations: 0, searches: 0, contextReads: 0,
    storeReads: 8, storeUpdates: 4,
  },
} satisfies AgentFeatureMetadata;
```

The shorthand above documents fields; actual metadata must contain literal values, not unresolved variables. The catalog provides starting copy for `help`; expand it to precise implemented syntax, including editing, deletion and optional commands. Keep metadata independent of execution modules, Redis, provider clients and source initialization. The parent registry imports metadata and calls `lazyAgentFeature(metadata, () => import('./<id>.js'))`. `agentFeatures` remains `readonly AgentFeature[]`. Do not eagerly import all 70 implementations to render navigation.

`resourceBudgets` keys are exactly `generations`, `searches`, `contextReads`, `storeReads`, `storeUpdates`; values are integers at least zero and can only lower defaults **8/6/8/64/32**. Internal CAS attempts (up to 32) are distinct from logical `storeUpdates`. New features use **0 or 1 generation**, **0 searches**, **0 or 1 context read**, **8 logical store reads**, and **4 logical store updates per invocation**, not per workflow. A multi-step workflow runs as separate explicit invocations. Features should normally use one read and one update; the envelope permits revision checks and reviewed preview acceptance without retries through the model.

Parent coordination now specifies admission of **3 global / 2 per workspace-user** expensive invocations with immediate busy responses before expensive work/receipt creation. This supersedes the earlier provisional 8-global proposal. Admission and provider initialization are the performance foundation’s responsibility; this design makes no fresh performance measurement or production concurrency claim.

## Honest source composition

The existing `readContext(kinds)` contract can read only approved kinds. It has **no query, ID selector, pagination, byte limit, or date-window parameter**. Features select/clip after the bounded adapter returns. An empty source response differs from a failed source. Missing references mean absent from the current permitted snapshot, not proven deleted everywhere.

| New consumer | Explicit kinds | Adapter maximum items | Selected/retained projection |
| --- | --- | ---: | --- |
| `concept-links` | `note`, `memory` | 200 | 10 selected excerpts, 12,000 text bytes |
| `reading-path` | `bookmark` | 100 | 10 selected metadata snapshots, 10,000 text bytes |
| `meeting-load` | `event` | 100 | All intervals; compact IDs/times and 8,000 label/text bytes |
| `energy-patterns` | `journal` | 100 | 10 selected excerpts, 8,000 text bytes |
| `habit-experiments` | `habit` | 100 | One selected habit, 2,000 text bytes plus validated day metadata |
| `goal-alignment` | `goal` | 100 | 10 selected snapshots, 8,000 text bytes |

These projection limits do **not** cap upstream adapter allocation. A toolbox namespace permits a 2,000,000-byte read and feature-backed calendar/memory namespaces retain the existing 512,000-byte ceiling. Request only the stated kinds, perform one read, validate before processing, and avoid additional source copies. This expansion deliberately uses no legacy reminder/monitor/digest/follow-up reads, whose signed-current-channel owner indexes have separate complete-read costs and provenance restrictions.

Private states of inbox, handoffs, project briefs, relationships, workflows, learning and the new features are not generally exposed through context. Neither are toolbox timelog, focus, checklists, standups, agendas, scores or glossary. Artifacts and legacy personal memory are unconnected. Never read another feature’s Redis namespace directly or claim an import from these sources. A typed URL is an inert label; do not fetch it. Optional imported note/goal/habit/journal/bookmark content is explicitly selected and read-only. Calendar reports use confirmed ICS snapshots, not live calendar completeness. Habit UTC date labels and date-only goals remain literal labels; journal mood is never an inferred energy score.

## Shared toolkit and resource approach

The parent assigned a separate toolkit owner these exact paths: `lib/agent-features/feature-kit/command-and-display.ts`, `bounded-state.ts`, `evidence.ts`, `civil-time.ts`, plus `tests/agent-feature-kit.test.ts`, `tests/helpers/agent-feature-fixture.ts`, and `docs/agent-features/feature-kit.md`. The catalog’s helper labels refer to these responsibilities, **not invented exported APIs**:

1. **command-and-display:** bounded field parsing including `\|`/`\\`, stable full-ID resolution, Slack escaping, ordered pages, section/continuation output, and complete bounded export.
2. **bounded-state:** serialized UTF-8 quota/reservation calculation, version/revision guards and pure immutable transforms. Admission must leave enough capacity to finish accepted records; it must not turn a constant margin into an unsupported guarantee.
3. **evidence:** exact source/span validation, bounded selected-source projections, stable fingerprints, and revision-bound preview validation. Evidence existence does not prove factual truth.
4. **civil-time:** strict civil dates, offset instants, IANA/DST validation, interval clipping and working-day traversal. Reuse correct existing calendar/planner time behavior; avoid another timezone implementation in every feature.

Keep business algorithms in their assigned modules. Do not build a generic arbitrary-workflow engine, add an ORM, store a global private cache, start workers, create embeddings, or run a model in a loop. Graphs are capped at 40 nodes/80 edges, except explicitly smaller feature limits; traversals are visited-set/topological operations. Table parsing is capped at 40 rows/8 columns; diffs at 120 lines/side. Greedy planners disclose that they are not global optimizers. Numeric utilities accept typed operations, not executable expressions.

Per-feature state is **49,152 bytes**, or **65,536 bytes** for seven text-heavy features. Total theoretical new state across all 50 at their full ceilings is **2,572,288 bytes per workspace-user** (about 2.45 MiB), excluding Redis/key overhead, request receipts and existing features. This is a sum of feature caps, **not an enforced account-wide quota or a measured RSS figure**. Count limits and byte limits both apply; nothing is preallocated. Full occupancy across many users still needs the parent’s capacity review.

Each record, including export envelope, must fit **24,576 serialized UTF-8 bytes**. New content is admitted below the feature cap minus 16,384 bytes, and must also reserve its validated worst-case mandatory lifecycle footprint. The fixed margin alone does not prove that all pending statuses/evidence/previews fit. Status completion, reviewed apply/undo and deletion must remain possible at capacity; optional large new notes can be rejected. No silent eviction, TTL retention policy, indefinite revision history or background cleanup is introduced.

Optional model commands use at most 16,000 input UTF-8 bytes, 4,000 instruction bytes and 4,000 accepted output characters, one call with no automatic retry. Most outputs are unsaved suggestions; users explicitly add chosen material. Model-assisted features retain deterministic templates, computations or evidence views. **The current `generate` API has no per-call output-token parameter:** post-generation character validation is not a hard upstream token/spend cap. Any provider token ceiling belongs in the parent’s foundation. Do not claim zero provider cost for optional assistance or invent current token prices.

## PA50-v1: common acceptance profile

A feature is complete only when its catalog workflow and domain cases work, not merely when a module is registered.

- **Discoverability:** exactly one stable group from the seven agreed names, useful lexical keywords, a realistic first command, and accurate static help. Catalog/search/Home show **10 entries per page**, never a 70-item dump. Exact-ID lookup reaches the feature even if a query has no keyword match. Help/search/Home must not initialize feature implementations, sources, Redis or models; signed Slack policy behavior remains owned by ingress. Empty query results give a concrete recovery command. Navigation is parent/UX-owned.
- **Workflow:** implement every command shown in the record, optional commands if promised, and domain edit/remove operations for accepted input. Every mutation returns stable IDs and the next useful command. Deterministic reports expose assumptions, reasons, unknowns and omitted-by-display counts. Missing inputs get exact corrective syntax. Future integrations cannot appear as working buttons or success messages.
- **Privacy and boundaries:** all results remain private; user/workspace/feature isolation is inherited and preserved. No Slack sends, assignments, reminders, bookings, payments, code execution, extra source adapters or arbitrary network calls. Escape Slack mention/link delimiters in untrusted output. Labels for owners/recipients are plain labels.
- **Retrieval and lifecycle:** `list [page]` uses stable pages of ten; `show <id> [page]` exposes every retained field through bounded pages; `export <id>` returns complete JSON within its admission-tested ceiling. Auxiliary settings/rules have discoverable IDs or belong to an exported root. Source originals, revisions, pending previews and undo data cannot become inaccessible hidden retention. Normal replies target 3,500 characters; full export is an explicit bounded exception. `delete <id> confirm` deletes only the owned root and its children, not referenced source data.
- **Validation and concurrency:** reject malformed/unsupported stored state without silently resetting it. Check quotas inside pure synchronous atomic transforms; generate IDs/time outside retryable transforms. Revisions invalidate stale graph/diff/span/preview results. Replayed reviewed tokens cannot double-apply. Use the inherited abort signal and ensure cancelled/late provider results cannot write. Full shared identity/deduplication/admission/CAS tests belong in the foundation, with feature-specific stale/limit cases where relevant.
- **Evidence and time:** validate every ID and exact quoted span before accepting a model/reference result. Preserve evidence labels and uncertainty. Distinguish empty/unknown/unavailable; do not infer deletion, completion, causation, external verification or agreement. Keep date-only values distinct from instants. Real dates, leap days, DST gaps/folds and source-specific date labels use shared helpers and focused integration fixtures.
- **Model independence:** run the complete deterministic flow with `generate` and `search` stubs that throw if called. Optional generation runs only on its documented explicit command; provider failure leaves saved work intact and offers the deterministic route. Structured output rejects unknown references/invalid spans/oversize data; no automatic repair generation. Validate source revision after the one awaited call.
- **Quality evidence:** feature tests cover distinct math/graph/parser/evidence behavior, the complete happy path, a meaningful refusal case, updates/deletion and full retrieval. Reuse centralized parsing/quota/date/escape fixtures instead of 50 copies of expensive invariant suites. Unit tests use local memory and fake services; they prove no live provider quality or Slack deployment. Parent runs integrated registration/catalog tests, typecheck, build and repository release checks.

## Research-deliverable verification and handoff

A Node **24** validation script parsed the final JSON and checked: 50 records and unique slug IDs; no overlap with the existing agent registry; ten batches of five; seven groups; 200 unique/nonexistent recommended owned file paths; complete route prefixes; at least five workflow steps and three domain acceptance criteria per record; metadata help under 3,500 characters; integer resource budgets at or below defaults; model/context declarations consistent with budgets; and storage/export cap consistency. `git diff --check` is the documentation whitespace check. A final pass also checks toolbox-ID collisions, referenced research IDs, ownership-template expansion, and the catalogue’s distinct feature counts.

This research task made no feature implementation changes, live inference calls, Slack messages, production data writes, Railway metric queries, dependency installation, push, PR, deployment, or subagent delegation. Read-only public web research and local repository inspection were used. The parent owns implementation launches and the eventual push/deploy request. Design/test evidence here is about the **catalog**, not the behavior of unimplemented features.
