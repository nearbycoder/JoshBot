# NoBo feature status

Reviewed October 22, 2026 against the implementation, automated tests, and production configuration. “Implemented” describes code availability; Slack permissions, subscriptions, credentials, and storage determine what is usable in a particular workspace.

## Where to find each feature

| Area | Entry point | Status and prerequisites |
| --- | --- | --- |
| Conversation | Mention `@NoBo`, DM, or reply in an existing thread | Implemented: thread context, streaming, acknowledgement reactions, native Agent sessions with legacy fallback. Needs Slack credentials/events and OpenCode access. |
| Models and vision | `/nobo-channel-model`; Home → More → Models | 28 active reviewed Go models, four wire protocols, channel overrides, image-aware routing, and fallback. Kimi K3 remains the text/image default. Gemini/Muse Contributor models require OpenCode training consent. |
| Web search and time | `@NoBo web-search …`; ordinary current-information/time requests | Exa search and exact current-time tools are implemented. Search needs `EXA_API_KEY`; scheduling uses saved timezones. |
| Personal memory/preferences | `@NoBo remember …`, `show my memory`; `/nobo-prefs` | Implemented: remember/forget/clear, timezone, verbosity, interests, reminder style. Persistence requires Redis. |
| Channel memory/listening | `/nobo-memory`, `/nobo-listen` | Implemented: shared memory, forget/clear, active listening with concurrency limits. Requires Redis and channel message subscriptions. |
| Thread workflows | `@NoBo summarize-thread`, `meeting-notes`, `thread-todos`, `follow-ups` | Implemented: summaries, notes, action-item extraction, ownership/due dates, tracked completion and reminders. Meeting notes use supplied transcript text/files; NoBo does not record huddles. |
| Attention triage | `@NoBo what needs my attention?` | Implemented using current-channel history plus stored user work; not a workspace-wide inbox scan. |
| Decisions | `/nobo-decisions`, `@NoBo decision add …`, natural “we decided …” | Implemented channel decision log with source context. Requires Redis. |
| Polls | `/nobo-polls`; `@NoBo poll …` | Implemented create/list/vote/results/close and optional decision logging. Requires Redis. Reaction votes require a recognized poll anchor; command voting is available for slash-created polls. |
| Issue drafts | `/nobo-issues`, `@NoBo issues …` | GitHub/Linear payload drafting is implemented. Actual creation needs configured repository/team and credentials, plus approval when offered through an agent card. Production currently has neither issue integration configured. |
| Reminders and recurring jobs | `/nobo-reminder`; Home → New reminder; ordinary scheduling requests | Implemented one-time, interval, daily/weekly, prompt jobs, cross-channel targets, list/edit/cancel, and creation deduplication. Requires Redis; generated tasks also need model/search access. |
| Conditional monitors | `@NoBo monitor …`, `@NoBo monitors`; Home → More → Monitors | Implemented channel-history, web-change and prompt checks with fingerprint suppression. Requires Redis; web/prompt checks need their respective integrations. |
| News and digests | `/nobo-news`, `/nobo-ai-news`, `/nobo-hacker-news`, `/nobo-channel-digest` | General/AI news uses model/search; Hacker News uses its public API. Recurring channel digests use Redis and model access. HN defaults to 09:00/14:00 America/Chicago in `#hacker-news`. |
| Documents/artifacts | Ask NoBo to save HTML/Markdown; `/nobo-artifacts`; Home → Recent documents | Implemented creation, raw/preview links, static PNG previews, edits, versions/diffs/rollback, owner-scoped management and cleanup. Files require durable storage across deployments. |
| Attachments | Attach images, text/code/CSV, PDF, DOCX, XLSX, VTT/SRT | Implemented bounded extraction, image routing and preview fallback. Requires `files:read`; image-bearing model runs currently disable tools. |
| History search | `/nobo-search`, `@NoBo semantic-search …` | Implemented lexical ranking over bounded recent channel history and owned artifacts. Embedding/vector search is not implemented. |
| Interactive cards | Buttons/overflow menus beneath generated replies | Implemented sources, catch-up sections, task progress, document controls, approvals, reminders, safe retries, follow-ups and thumbs-up/down feedback. Redis-backed controls expire after 24 hours. |
| App Home | Open NoBo → Home | Implemented reminders, recent documents, monitors, memories, channel/model/integration views, preferences and toolbox. Requires `app_home_opened` and Home enabled in Slack. |
| X media | `/nobo-x`, `/nobo-help x`, X upload modal | Implemented public-post images/video with optional short text summary. Requires `files:write`, channel access and FxEmbed/X availability. Summary failure does not prevent media upload. |
| Operations/access | `/nobo-status`, `/nobo-admin`, `/healthz` | Status, policy controls, audit entries, error tracking and signed ingress are implemented. Admin mutation commands require `NOBO_ADMIN_USER_IDS`, currently unset in production. `/healthz` is a liveness check; `/nobo-status` includes dependency checks. |

## The twenty private toolbox tools

Open **NoBo Home → Open toolbox**, or use `/nobo-help tools <tool> help`.

| Group | Tool IDs |
| --- | --- |
| Capture and reuse | `notes`, `bookmarks`, `checklists`, `prompts`, `snippets`, `glossary` |
| Personal tracking | `journal`, `habits`, `timelog`, `focus`, `goals`, `countdowns` |
| Team planning | `standups`, `retros`, `scorecards`, `agendas`, `releases`, `workload` |
| Utilities | `timezones`, `textkit` |

All twenty are implemented, scoped to workspace and user in Redis, and require no model calls. Their create/export/delete flows, duplicate protection, workspace isolation and concurrent writes passed a live Redis smoke check during this refresh; all synthetic records were removed. Tool-specific examples and limits are in [the toolbox guide](toolbox.md).

## Production configuration and remaining setup

- Slack bot credentials, OpenCode credentials, Exa, Redis and the public artifact base URL are configured. Kimi K3 remains selected for default text and vision.
- Production reports the required native Agent OAuth grants. However, its logs warn that **`agent_session_stopped` is not subscribed**. Add that bot event in the existing Slack app's Event Subscriptions and save; reinstall only if Slack requests it. Until then, the native Stop control cannot reliably reach NoBo. See [the Slack admin checklist](slack-bolt-migration.md).
- Keep **one replica**. Native run cancellation is process-local; cross-process cancellation and resuming model runs after deployment are not implemented.
- GitHub/Linear creation and admin controls remain optional and unconfigured. Draft generation and ordinary bot features remain available.
- Slack slash-command registration, private-channel membership, Agent view/client behavior, and every workspace-specific event cannot be proven by repository tests alone. Use the live acceptance checklist in the migration guide after Slack configuration changes.

## Refresh changes and verification

- Release checks passed on Node 24: all **449 tests**, including real Redis concurrency and lease tests, with zero skipped; typecheck; production build; and a full dependency audit.
- Updated direct dependencies to current stable releases, with Node 24 LTS and matching Node types. TypeScript 7, Flue 2.3, pi-ai 1.4, Redis client 6.3 and Chromium 153 are included. CI uses the current Node setup action and runs tests, typechecking, a production dependency audit, and the build.
- Removed the six initial dependency advisories. A scoped MCP client override selects the patched 2.3.1 line because Flue still pins 2.0.0. `npm audit` reports zero vulnerabilities after installation.
- Refreshed the model catalog and current protocol routes, preserved SDK pricing/context metadata, and retained the documented MiMo effort-parameter compatibility exception. Mocked transport tests verify route/auth headers, sessions, prompts, tools and image handling without calling providers.
- Fixed reminder/digest modal destination selection and policy checks. Fixed Recent documents to sort by modification time before limiting results.
- Replaced destructive scheduler claims with renewable Redis leases. Jobs remain discoverable after a worker exits; conditional completion lets cancellation and edits win. Reminder, monitor, digest and Hacker News delivery rechecks access after generation. Concurrent poll mutations and poll-linked decision creation are atomic, and human reaction votes can reach bot-authored anchors.
- Buffered scheduled digests use a direct Slack send, so rejected posts and rate limits retry the occurrence instead of advancing the schedule. Memory failures after successful delivery do not resend it.
- A read-only production scan found no stored reminders, monitors or digest subscriptions requiring recovery or migration.
- A real Chromium 153 render produced a PNG. The standalone server tests exercise Bolt/Flue startup and signed Slack URL verification with a local Slack API fixture.
- A small live Kimi K3 request through the updated Flue runtime returned successfully. No test messages were posted to Slack.

## Practical limits

- Artifact URLs are bearer links. Marking an artifact expired hides it from normal lists but does not revoke a link until cleanup deletes the file.
- Deterministic explicit skills use the documented mention/slash entry points. An ordinary DM/thread reply may be answered by the model instead.
- Poll reaction votes work only where the message timestamp is registered as the poll anchor; use `/nobo-polls vote …` otherwise.
- Native Slack Agent feedback events are not handled; NoBo's own response-card feedback is stored in Redis.
- Scheduler recovery is at-least-once: a crash after Slack accepts a post but before Redis records completion can still cause a duplicate. Leases do not retroactively recover records already stranded by an older deployment.
- The fixed-time Hacker News schedule prevents overlapping runs within one process; it does not recover runs missed while the service is offline.
- Free/preview models and account-specific access can change. LongCat 2.5 Preview Free is excluded because live discovery omits it and Models.dev marks it deprecated despite its continued presence in the Go docs.

Sources for the refresh: [OpenCode Go](https://opencode.ai/v2/docs/console/go/), [model metadata](https://github.com/anomalyco/models.dev/tree/dev/providers/opencode-go/models), [Node LTS releases](https://nodejs.org/en/about/previous-releases), [Redis client migration](https://github.com/redis/node-redis/blob/master/docs/v5-to-v6.md), and the [MCP client advisory](https://github.com/advisories/GHSA-6prh-2h8m-c8cw).
