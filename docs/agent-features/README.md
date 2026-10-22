# Personal agents

Use `/nobo-help agent` to see the catalog, or open **NoBo Home → More → Personal agents**. Each command uses `/nobo-help agent <name> <command>`, and `<name> help` explains its syntax.

All **70 features are implemented and registered**. The original 20 first shipped in [PR #58](https://github.com/nearbycoder/JoshBot/pull/58); its independently reviewed **1,093-test, zero-skip** release is [historical evidence](../personal-agent-expansion.md). The 50 additions belong to [PR #59](https://github.com/nearbycoder/JoshBot/pull/59), the source for release/deployment status. See the [current implementation/evidence record](../personal-agent-50-release.md) for scoped approvals and checks. Replies are private; saved data is separated by Slack workspace, user, and feature.

## Find a feature

The seven groups below match the registered metadata. Start with `/nobo-help agent catalog group plan`, `/nobo-help agent catalog page 2`, or `/nobo-help agent search meeting`. Catalog pages show at most ten agents; Home supports group filters, search, paging, Help and Back to results. Browsing never executes an agent or reads channel/source context. See [discovery syntax and privacy](catalog.md).

Each example below follows `/nobo-help agent <name>`; copy the name plus example into your Slack composer. Full IDs returned by commands replace placeholders. Open the linked guide or `<name> help` for the complete grammar. The cleanroom guide includes its multiline CSV example.

### Plan & prioritize (`plan`; 10)

| Name | Outcome | First command or example after the name |
| --- | --- | --- |
| [calendar](calendar.md) | Privately preview pasted ICS, inspect your agenda, and find free time or conflicts in imported events. | `free 2026-10-23 \| 45m` |
| [capacity-forecast](capacity-forecast.md) | Compare multiweek effort ranges with explicit capacity and see best- and worst-case overload. | `create November delivery \| 2026-11-02 \| 2` |
| [context-batch](context-batch.md) | Bundle small actions by shared setup and available tools to reduce switching. | `create Admin hour \| 60` |
| [day-planner](day-planner.md) | Build a private, timezone-aware day plan around owned events, task priorities, deadlines, and breaks. | `add Draft proposal \| 60 \| high` |
| [deadline-backplan](deadline-backplan.md) | Work backward from a finish date through prerequisites, working days, and explicit buffers. | `create Conference proposal \| 2026-12-04 \| mon,tue,wed,thu,fri` |
| [goal-alignment](goal-alignment.md) | See where planned effort contributes to your selected goals and where work has no stated purpose. | `create November effort` |
| [meeting-prep](meeting-prep.md) | Prepare a private, source-backed packet for a supplied upcoming meeting, with owner context, commitments, agenda suggestions and questions. | `prepare Atlas launch \| purpose: Agree the launch date; attendees: Ana, Dev; Resolve rollout risks.` |
| [morning-brief](morning-brief.md) | Rank personal commitments and imported events into a cited, timezone-aware day-ahead brief. | `brief launch preparation` |
| [scope-slicer](scope-slicer.md) | Fit a coherent minimum deliverable inside an effort budget and expose what must be deferred. | `create Guide v1 \| 180` |
| [task-breakdown](task-breakdown.md) | Turn a vague outcome into small, testable steps and a clear starting action. | `create Publish a short guide \| Readers can install the app \| 30` |

### Capture & recall (`capture`; 12)

| Name | Outcome | First command or example after the name |
| --- | --- | --- |
| [change-digest](change-digest.md) | Compare two pasted versions and distinguish wording edits from changed facts that need review. | `create Launch note \| before \| Launch on October 30 with 10 users.` |
| [concept-links](concept-links.md) | Connect ideas with typed relationships and follow a short, explainable path between them. | `create Reliable systems` |
| [handoffs](handoffs.md) | Carry explicit progress and selected personal context into a new session, with revisions and source freshness checks. | `capture Ship onboarding fix \| done: Reproduced login loop \| next: Review cookie handling` |
| [inbox](inbox.md) | Privately capture thoughts, messages, links, and tasks; review proposed next actions before classifying them. | `capture Review Maya’s launch draft before Friday` |
| [memory-review](memory-review.md) | Review sourced personal claims, expiry, conflicting keys, and explicit memory approval. | `capture me \| work-city \| I work in Chicago \| My update today` |
| [project-briefs](project-briefs.md) | Private, reusable project context packs with explicitly linked owned sources, freshness checks and optional cited synthesis. | `create Website launch \| Ship the accessible customer portal` |
| [question-triage](question-triage.md) | Identify which unanswered questions block a decision and define what evidence would settle them. | `create Choose workshop format` |
| [read-later](read-later.md) | Prioritize private reading by available time, track progress, and save excerpt-backed summaries, digests, and takeaways. | `add https://example.org/attention \| Attention and reading \| 8 \| Silence notifications before reading.` |
| [reading-path](reading-path.md) | Order a small reading collection by prerequisite concepts and available reading time. | `create Learn queue basics` |
| [recall](recall.md) | Find and quote your own context across personal tools with lexical ranking, filters and source provenance. | `search Atlas rollout --kind note` |
| [source-compare](source-compare.md) | Compare supplied accounts point by point and keep agreement, disagreement, and missing coverage separate. | `create Two onboarding studies` |
| [timeline-builder](timeline-builder.md) | Arrange dated observations into a chronology while preserving uncertain dates and conflicting accounts. | `create Launch history` |

### Write & communicate (`write`; 9)

| Name | Outcome | First command or example after the name |
| --- | --- | --- |
| [audience-brief](audience-brief.md) | Adapt one set of facts into concise updates for different readers without losing required details. | `create Pilot update` |
| [boundary-script](boundary-script.md) | Draft a clear decline or renegotiation from your limits and an explicit alternative. | `create Extra report this week \| Existing delivery already fills the week` |
| [claim-check](claim-check.md) | Map factual claims in a draft to supplied evidence and expose unsupported or mismatched claims. | `create Pilot announcement \| Ten users completed onboarding in two minutes.` |
| [delegation-brief](delegation-brief.md) | Prepare a bounded request with decision rights, checkpoints, and an observable definition of done. | `create Review onboarding \| Reviewer \| Find the three largest sources of confusion` |
| [difficult-conversation](difficult-conversation.md) | Rehearse a challenging conversation with your goal, boundaries, likely objections, and chosen responses. | `create Discuss shifting the deadline \| Agree on a feasible scope` |
| [document-critic](document-critic.md) | Check a draft against an explicit purpose, audience, structure, and review rubric. | `create Setup guide \| New users \| Help a new user install the app` |
| [feedback-builder](feedback-builder.md) | Build actionable feedback by separating observed behavior, impact, and a specific request. | `create Review handoff \| Monday planning meeting` |
| [redaction-desk](redaction-desk.md) | Preview and apply reversible redactions to a pasted text before you copy it elsewhere. | `create Shareable note \| Contact Maya at maya@example.com about the launch.` |
| [reply-coach](reply-coach.md) | Compose and revise private, context-grounded reply suggestions using explicitly approved writing examples. | `draft warm \| short \| Decline the Friday invite \| Alex: Can you join us Friday?` |

### Decide & analyze (`decide`; 8)

| Name | Outcome | First command or example after the name |
| --- | --- | --- |
| [argument-map](argument-map.md) | Make a position’s reasons, objections, rebuttals, and evidence gaps visible. | `create Use a shorter onboarding form` |
| [assumption-tests](assumption-tests.md) | Turn an uncertain belief into a falsifiable, bounded test with a predeclared result rule. | `create Shorter form increases responses \| response count \| at-least \| 5 \| 1 \| 60` |
| [blocker-lab](blocker-lab.md) | Separate a blocker’s observations from guesses and choose a small diagnostic next step. | `open Draft keeps slipping \| Need a repeatable explanation` |
| [decision-coach](decision-coach.md) | Private deliberation with explicit evidence, subjective weighted ratings and temporary what-if comparisons. | `create Commute choice \| Compare reliability and convenience` |
| [decision-journal](decision-journal.md) | Record a decision’s expectations before the result, then review what actually happened. | `record Use a short signup form \| Reduce friction \| 2026-11-20` |
| [number-audit](number-audit.md) | Check stated totals, percentage changes, and weighted averages against explicit numeric inputs. | `create Launch metrics` |
| [premortem](premortem.md) | Find plausible failure modes before starting and pair them with triggers and mitigations. | `create Launch workshop \| Attendees complete the exercise` |
| [research](research.md) | Save cited public-web research, refresh evidence and compare dated dossiers privately. | `research What are the tradeoffs of sodium-ion batteries for home storage?` |

### Learn & improve (`learn`; 12)

| Name | Outcome | First command or example after the name |
| --- | --- | --- |
| [achievement-portfolio](achievement-portfolio.md) | Turn concrete work into evidence-backed accomplishment stories for reviews or applications. | `create Simplified onboarding \| New users struggled with setup` |
| [curriculum](curriculum.md) | Build a prerequisite-aware study plan with bounded session capacity and evidence of readiness. | `create Learn SQL joins \| 3 \| 25` |
| [estimate-calibration](estimate-calibration.md) | Compare effort estimates with actuals and calculate a transparent adjustment from similar completed work. | `estimate Draft article \| writing \| 60` |
| [feedback-themes](feedback-themes.md) | Group received feedback by exact evidence and turn repeated themes into a concrete response experiment. | `create Quarterly feedback` |
| [habit-experiments](habit-experiments.md) | Test a smaller version, cue, or environment change against an explicit habit baseline. | `create Reading cue \| Put the book beside the kettle` |
| [interview-practice](interview-practice.md) | Practice a timed answer with a role-specific rubric and inspect the evidence you actually supplied. | `create Backend interview \| 120 \| 130` |
| [learning](learning.md) | Create source-grounded flashcards from your material, practice recall privately, and schedule reviews from your own ratings. | `create Networking \| My class notes \| DNS translates domain names to IP addresses.` |
| [learning-transfer](learning-transfer.md) | Turn a lesson into a real-world application, define evidence of use, and reflect on the result. | `create Use smaller PRs \| Workshop notes \| Keep each change focused on one purpose` |
| [mistake-patterns](mistake-patterns.md) | Group repeated errors by your labels and track whether a prevention rule actually helped. | `record 2026-10-22 \| Review \| Missed an edge case \| testing` |
| [practice-lab](practice-lab.md) | Run a self-scored practice attempt against a rubric and choose what to improve next. | `create Explain a technical tradeoff in two minutes` |
| [skill-matrix](skill-matrix.md) | Compare self-assessed skills with a target role and keep demonstrated evidence distinct from confidence. | `create Backend role` |
| [teach-back](teach-back.md) | Explain supplied material in your own words, then compare your explanation with an explicit concept rubric. | `create Explain cache invalidation \| Cached data must be refreshed when the source changes.` |

### Organize life (`life`; 7)

| Name | Outcome | First command or example after the name |
| --- | --- | --- |
| [errand-batch](errand-batch.md) | Find feasible errand groups from your available window, supplied opening hours, and travel estimates. | `create Saturday errands \| 2026-10-24 \| 09:00 \| 120 \| home` |
| [home-maintenance](home-maintenance.md) | Track service intervals and meter-based upkeep from your own manuals and service records. | `add Air filter \| Appliance manual \| 90 \| none` |
| [pantry-plan](pantry-plan.md) | Scale a saved recipe, subtract compatible pantry quantities, and produce an honest shopping gap list. | `create Pasta \| 2` |
| [purchase-compare](purchase-compare.md) | Compare entered offers by usable quantity, delivered cost, and transparent ownership assumptions. | `create Filter packs \| USD \| filter \| 12` |
| [relationships](relationships.md) | Remember meaningful touchpoints, reconnect on your preferred cadence, keep promises, and prepare private outreach drafts. | `add Maya Chen \| 30 \| Met at the neighborhood garden` |
| [renewal-radar](renewal-radar.md) | See notice deadlines and normalized costs for manually entered subscriptions and memberships. | `add Design membership \| 2026-12-01 \| 14 \| 120.00 \| USD \| year \| 1` |
| [travel](travel.md) | Private multi-leg itineraries, timezone and transfer checks, constraints, and packing preparation. | `trip Japan visit \| America/Chicago \| 90 \| Carry-on only` |

### Review & maintain (`review`; 12)

| Name | Outcome | First command or example after the name |
| --- | --- | --- |
| [automation-audit](automation-audit.md) | Privately review automation timing, purpose, duplicate candidates and changes over time, with source evidence. | `review` |
| [change-impact](change-impact.md) | Trace which documents, routines, or commitments need review when one assumption or dependency changes. | `create Launch dependencies` |
| [checklist-lint](checklist-lint.md) | Inspect a procedure for vague steps, missing verification, and unsafe ordering before anyone runs it. | `create Publish a guide \| Applies to the public documentation site` |
| [data-cleanroom](data-cleanroom.md) | Validate a small pasted table and preview explicit cleaning operations before exporting it. | `help` |
| [energy-patterns](energy-patterns.md) | Find useful patterns in your own energy check-ins without treating mood or missing days as energy measurements. | `checkin 2026-10-22 \| morning \| 4 \| writing \| Felt alert` |
| [interruption-audit](interruption-audit.md) | Log disruptions briefly and see which triggers cost the most recovery time. | `log 2026-10-22 \| chat \| Writing guide \| 3 \| 8 \| estimated` |
| [meeting-load](meeting-load.md) | Measure calendar fragmentation, back-to-back pressure, and protected-time breaches in a confirmed snapshot. | `create Workweek review \| 2026-10-26 \| 2026-10-30` |
| [playbooks](playbooks.md) | Teach typed, multi-step text procedures; preview, run, revise and restore versions privately. | `create {"title":"Launch brief","goal":"Explain {{topic}}","inputs":{"topic":"text"},"steps":["Extract facts about {{topic}}."]}` |
| [process-friction](process-friction.md) | Separate active work, waiting, and handoffs in a routine and test a cheaper process on paper. | `create Monthly report \| 4` |
| [shutdown-review](shutdown-review.md) | Close the day by explicitly resolving loose ends and leaving a first step for tomorrow. | `start 2026-10-22` |
| [weekly-review](weekly-review.md) | Synthesize seven local calendar days of personal goals, habits, journal, follow-ups and notes, with source references and a private reflection. | `review` |
| [workflows](workflows.md) | Private text workflows with inspectable checkpoints, manual resume, cancellation and failed-step retry. | `create Launch update \| Beta is ready; testing takes two days. \| Extract facts and open questions \| Draft a short update` |

## Start with a small workflow

Capture an item with `/nobo-help agent inbox capture Review the launch draft`. Use the returned ID with `inbox triage <id>`, inspect the preview, then use its exact approval token with `inbox accept <id> <preview-id>`. Acceptance saves your private classification; follow the suggested next action yourself.

For planning, import a calendar snapshot using the [calendar example](calendar.md), review it, and confirm its preview token. Add a task with `day-planner add Review the draft | 30 | normal`, then use `day-planner plan YYYY-MM-DD`. The proposal reflects the imported snapshot and supplied tasks; it does not update an external calendar.

## Storage, sources, and generation

The shared runtime requires Redis for every non-help command, including stateless recall. Model-assisted commands use the existing configured model; research additionally uses the existing Exa integration. The 50 additions comprise 34 deterministic features, 16 with explicit optional one-call assistance, and six owned-context consumers; all 50 declare zero searches. Help and deterministic operations do not require inference. No new services or credentials are needed. Generated drafts and interpretations are labeled; validated citations or source quotations establish provenance, not model accuracy. Connected source coverage is described below.

Stateful features have bounded storage and documented removal or reset commands; recall retains no feature state. Limits measure serialized UTF-8 bytes, so large Unicode text can reach capacity before an item-count limit. Quota errors preserve saved work and explain how to free space. Request receipts store fingerprints and status, without caching private input or replies, to suppress duplicate Slack delivery.

Connected sources include your private toolbox records, confirmed calendar imports, and eligible approved memory cards. Reminders, monitors, digests, and follow-ups cover **your records in the channel where you run the command**. Saved artifacts and legacy personal memory are not connected; memory-review's legacy-import commands therefore return no candidates. Capture facts directly in memory-review instead. Missing references indicate absence from the current permitted snapshot, not proof that a record was deleted everywhere. See the [source-coverage reference](context.md) for bounds and date semantics.

Commands run on demand. The additions create no background tasks or schedules, connect no external accounts, send no outreach, book no travel, and execute no arbitrary code. Workflow continuation is explicit; calendar imports are snapshots; recall uses lexical matching. The individual guides describe the supported inputs and limits.

For shared admission, deadline, source-completeness and quota boundaries, see the [implementation record](../personal-agent-50-release.md#shared-boundaries). Each guide retains its exact domain commands, byte/count limits and lifecycle rules.
