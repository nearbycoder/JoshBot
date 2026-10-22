# Personal agents

Use `/nobo-help agent` to see the catalog, or open **NoBo Home → More → Personal agents**. Each command uses `/nobo-help agent <name> <command>`, and `<name> help` explains its syntax.

All 20 features, private routes, storage limits, and source adapters are integrated on the development branch. Remaining fixes, independent review, and release validation are in progress; the expansion is **not deployed** and has not reached final acceptance. Follow [release status and research](../personal-agent-expansion.md). Replies are private. Saved data is separated by Slack workspace, user, and feature.

## Find a feature

| Name | What it does | First command after the name |
| --- | --- | --- |
| [morning-brief](morning-brief.md) | Prioritizes your available commitments and imported events for the day | `brief` |
| [weekly-review](weekly-review.md) | Summarizes recorded work and patterns, with saved reflections | `review` |
| [inbox](inbox.md) | Captures thoughts and previews suggested classifications for approval | `capture Review the launch draft` |
| [day-planner](day-planner.md) | Fits tasks around working hours, breaks, and imported calendar events | `add Review the draft \| 30 \| normal` |
| [meeting-prep](meeting-prep.md) | Builds meeting packets with source excerpts and suggested questions | `prepare Launch review \| purpose: Review readiness` |
| [reply-coach](reply-coach.md) | Drafts and revises replies using explicitly approved writing examples | `style show` |
| [relationships](relationships.md) | Tracks contact history, reconnect cadence, and personal promises | `add Maya \| 30 \| Met at the workshop` |
| [read-later](read-later.md) | Prioritizes pasted articles and produces excerpt-backed reading drafts | `list` |
| [research](research.md) | Saves cited research dossiers and compares refreshed evidence | `research What evidence supports this approach?` |
| [project-briefs](project-briefs.md) | Curates project context and selected owned source references | `create Launch \| Prepare the release` |
| [recall](recall.md) | Searches available personal context with lexical matching and provenance | `search launch` |
| [memory-review](memory-review.md) | Reviews facts, sources, expiry, conflicts, and explicit confirmations | `list` |
| [playbooks](playbooks.md) | Saves typed, versioned procedures that produce text drafts | `help` |
| [workflows](workflows.md) | Runs text-generation steps with saved checkpoints and manual continuation | `list` |
| [learning](learning.md) | Turns supplied material into source-backed cards and spaced review | `due` |
| [decision-coach](decision-coach.md) | Compares your options using explicit weights, evidence, and scores | `create Commute \| Compare convenience and reliability` |
| [handoffs](handoffs.md) | Saves task progress and next steps for a later session | `capture Launch review \| done: Read notes \| next: Check the draft` |
| [calendar](calendar.md) | Imports a confirmed ICS snapshot and checks its agenda and availability | `help` |
| [travel](travel.md) | Organizes itinerary entries, timezones, transfer checks, and packing | `trip Weekend visit \| America/Chicago \| 60` |
| [automation-audit](automation-audit.md) | Reviews permitted reminder, monitor, and digest metadata | `review` |

## Start with a small workflow

Capture an item with `/nobo-help agent inbox capture Review the launch draft`. Use the returned ID with `inbox triage <id>`, inspect the preview, then use its exact approval token with `inbox accept <id> <preview-id>`. Acceptance saves your private classification; follow the suggested next action yourself.

For planning, import a calendar snapshot using the [calendar example](calendar.md), review it, and confirm its preview token. Add a task with `day-planner add Review the draft | 30 | normal`, then use `day-planner plan YYYY-MM-DD`. The proposal reflects the imported snapshot and supplied tasks; it does not update an external calendar.

## Storage, sources, and generation

The shared runtime requires Redis for every non-help command, including stateless recall. Model-assisted commands use the existing configured model; research additionally uses the existing Exa integration. Help and deterministic operations do not require inference. Generated drafts and interpretations are labeled; validated citations or source quotations establish provenance, not model accuracy. Connected source coverage is described below.

Stateful features have bounded storage and documented removal or reset commands; recall retains no feature state. Limits measure serialized UTF-8 bytes, so large Unicode text can reach capacity before an item-count limit. Quota errors preserve saved work and explain how to free space. Request receipts store fingerprints and status, without caching private input or replies, to suppress duplicate Slack delivery.

Connected sources include your private toolbox records, confirmed calendar imports, and eligible approved memory cards. Reminders, monitors, digests, and follow-ups cover **your records in the channel where you run the command**. Saved artifacts and legacy personal memory are not connected; memory-review's legacy-import commands therefore return no candidates. Capture facts directly in memory-review instead. Missing references indicate absence from the current permitted snapshot, not proof that a record was deleted everywhere. See the [source-coverage reference](context.md) for bounds and date semantics.

Commands run on demand. This expansion does not create background schedules, connect external accounts, send outreach, book travel, or execute arbitrary code. Workflow continuation is explicit; calendar imports are snapshots; recall uses lexical matching. The individual guides describe the supported inputs and limits.
