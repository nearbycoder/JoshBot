# NoBo

NoBo is a small TypeScript process that receives Slack Events API calls and replies in-thread.

## Features

- Slack assistant surfaces: `@NoBo` mentions, thread replies, DMs, slash commands, Block Kit modals, reaction shortcuts, active channel listening, and Slack App Home.
- Thread-aware replies: reads Slack thread history, trims long threads, caches thread state, and decides whether normal thread replies need NoBo.
- Streaming Slack UX: acknowledgement reaction, animated listening message, and progressive same-message block updates.
- Web and time tools: Exa search, exact current-time tool, UTC plus user-timezone context, and timezone-aware relative scheduling.
- User memory and preferences: per-user memories, timezone, verbosity, news interests, and reminder style in Redis.
- Channel memory and settings: shared channel memory, active-listening state, and per-channel model overrides in Redis.
- Active listening: records channel messages and can stay silent, reply in-thread, or reply inline, with concurrency limits.
- Scheduling: one-time reminders, interval crons, daily/weekly jobs, prompt-style scheduled tasks, cross-channel posting, idempotency, listing, cancellation, and updates.
- Follow-ups: extracts thread action items, tracks open items, lists thread or user follow-ups, marks items done, and schedules due reminders.
- Issue drafts: converts thread follow-ups into GitHub/Linear issue payloads, with optional create mode when API config is present.
- Smart notification triage: `@NoBo what needs my attention?` ranks recent mentions, questions, follow-ups, decisions, and schedules.
- Decisions: channel decision log via slash commands, mentions, and natural `we decided ...` / `we agreed ...` messages.
- Artifacts: standalone HTML/Markdown generation, preview/raw URLs, metadata, expiration, version history, diffs, rollback, list/update/delete/cleanup.
- Semantic search: user-facing search over recent Slack channel history and owned artifacts, currently using a lexical scorer behind the semantic search interface.
- Polls: lightweight channel/thread polls with command or reaction votes, result summaries, closing, and optional decision logging.
- Digests and news: weekly general news, weekly AI news, on-demand Hacker News, scheduled Hacker News, and recurring channel digests.
- Attachments: Slack file metadata, image bytes for vision models, small text/code/CSV contents, and bounded text extraction for PDF, DOCX, and XLSX uploads with Slack preview fallback.
- App Home dashboard: reminders/crons, memories, active-listening channels, model status, artifacts, preferences, and shortcuts.
- Utility commands: `/nobo-help`, `/nobo-status`, and `/nobo-dad-joke`.
- Ops and safety: Slack signature verification, retry suppression, duplicate event locks, admin allow/deny controls, audit log, Redis status, async error recording, `/healthz`, and CI checks.

## Stack

- Flue Node.js target and generated HTTP server
- TypeScript
- `@flue/runtime` agent harness
- OpenCode Go registered as a Flue OpenAI-compatible provider
- Exa Search API via `exa-js`
- Redis thread-state cache and shared channel memory
- Slack Events API, with both the legacy `/api/slack/events` route and Flue's `/channels/slack/events` channel route
- Slack response streaming via an immediate listening message and progressive same-message block updates

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create env vars:

   ```bash
   cp .env.example .env
   ```

   The process also accepts `.env.local`. If both exist, `.env.local` wins.

3. Fill in:

   - `PORT`: defaults to `3000`
   - `OPENCODE_GO_API_KEY`: your OpenCode Go API key
   - `OPENCODE_GO_MODEL`: default text model, defaults to `glm-5.2`
   - `OPENCODE_GO_VISION_MODEL`: optional override for image-bearing messages; defaults to `kimi-k2.6`
   - `EXA_API_KEY`: enables Exa-backed web search for current or uncertain facts
   - `REDIS_URL`: optional Redis connection string for caching Slack thread state, shared channel memory, channel polls, channel decision logs, admin access updates, and audit entries
   - `REDIS_TTL_SECONDS`: defaults to `604800` (7 days)
   - `SLACK_EVENT_LOCK_TTL_SECONDS`: defaults to `600`; prevents duplicate Slack event processing across retries or concurrent instances
   - `SCHEDULE_CREATE_IDEMPOTENCY_TTL_SECONDS`: defaults to `600`; prevents duplicate schedule creation from one Slack ask
   - `MEMORY_MAX_ITEMS`: defaults to `20`; cap for saved per-user memory items
   - `SLACK_BOT_TOKEN`: Bot User OAuth Token from your Slack app
   - `SLACK_SIGNING_SECRET`: Signing secret from the Slack app settings
   - `SLACK_BOT_USER_ID`: the bot user ID, used to strip mentions and classify assistant replies in thread history
   - `SLACK_ACK_REACTION`: defaults to `eyes`; emoji reaction NoBo adds to targeted messages, or `off` to disable
   - `SLACK_CONTEXT_MESSAGES`: defaults to `12`; keeps the thread root plus only the most recent turns when building model context
   - `SLACK_LISTENING_MESSAGE`: defaults to `Thinking...`; used as the base text for the animated placeholder before model text starts streaming back
   - `SLACK_LISTENING_ANIMATION_INTERVAL_MS`: defaults to `1000`; controls the placeholder dot animation cadence
   - `SLACK_STREAM_BUFFER_SIZE`: defaults to `128`; controls how many new characters accumulate before updating a streamed Slack reply
   - `SLACK_STREAM_UPDATE_INTERVAL_MS`: defaults to `750`; maximum update cadence for streamed Slack reply updates
   - `NOBO_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES`: defaults to `3`; caps simultaneous active-listening replies per channel in this process
   - `SLACK_TEXT_ATTACHMENT_MAX_BYTES`: defaults to `262144`; max private Slack file download size for text/CSV/PDF/DOCX/XLSX extraction, capped at 2 MB
   - `NOBO_ADMIN_USER_IDS`: comma-separated Slack user IDs allowed to run `/nobo-admin`
   - `NOBO_ALLOWED_CHANNEL_IDS` / `NOBO_DENIED_CHANNEL_IDS`: comma-separated bootstrap Slack channel allow/deny IDs
   - `NOBO_ALLOWED_USER_IDS` / `NOBO_DENIED_USER_IDS`: comma-separated bootstrap Slack user allow/deny IDs
   - `SLACK_ATTACHMENT_TEXT_MAX_CHARS`: defaults to `6000`; max extracted attachment text sent into model context, capped at 20000
   - `ARTIFACT_BASE_URL`: public base URL used in Slack artifact links; defaults to `http://localhost:$PORT`
   - `ARTIFACT_DIR`: local directory for generated artifacts; defaults to `artifacts`
   - `ARTIFACT_TTL_DAYS`: optional default artifact expiration window; blank or `0` means no default expiration
   - `ARTIFACT_MAX_VERSIONS`: retained prior artifact versions per artifact; defaults to `10`, `0` disables history
   - `NOBO_SEMANTIC_SEARCH_PROVIDER`: semantic search backend, currently `lexical`; future embedding/vector DB swaps should implement `SemanticSearchProvider`
   - `NOBO_SEMANTIC_SEARCH_HISTORY_DAYS`: defaults to `14`; recent Slack history window searched by `/nobo-search`
   - `NOBO_SEMANTIC_SEARCH_HISTORY_LIMIT`: defaults to `200`; max channel messages fetched per search
   - `NOBO_SEMANTIC_SEARCH_ARTIFACT_LIMIT`: defaults to `200`; max owned artifacts loaded per search
   - `NOBO_SEMANTIC_SEARCH_RESULTS`: defaults to `5`; max formatted search results
   - `SCHEDULER_INTERVAL_MS`: defaults to `30000`; how often NoBo checks Redis for due reminders and crons
   - `CHANNEL_DIGEST_SCHEDULER_INTERVAL_MS`: optional override for channel digest subscription checks; falls back to `SCHEDULER_INTERVAL_MS`
   - `NOBO_HACKER_NEWS_CHANNEL_NAME`: defaults to `hacker-news`; channel name for the scheduled Hacker News digest
   - `NOBO_HACKER_NEWS_CHANNEL_ID`: optional Slack channel ID override for scheduled Hacker News posts
   - `NOBO_HACKER_NEWS_SCHEDULE_TIMES`: defaults to `09:00,14:00`; daily post times in America/Chicago
   - `NOBO_HACKER_NEWS_FOCUS`: optional search focus for scheduled Hacker News posts
   - `NOBO_GITHUB_TOKEN` or `GITHUB_TOKEN`: optional token for issue creation
   - `NOBO_GITHUB_REPOSITORY` or `GITHUB_REPOSITORY`: optional `owner/repo` target for GitHub issues
   - `NOBO_GITHUB_LABELS` or `NOBO_ISSUE_LABELS`: optional comma-separated GitHub labels
   - `NOBO_LINEAR_API_KEY` or `LINEAR_API_KEY`: optional Linear API key for issue creation
   - `NOBO_LINEAR_TEAM_ID` or `LINEAR_TEAM_ID`: optional Linear team ID for issue creation
   - `NOBO_LINEAR_LABEL_IDS` or `LINEAR_LABEL_IDS`: optional comma-separated Linear label IDs

4. Start the process:

   ```bash
   npm run dev
   ```

   Flue dev serves on `http://localhost:3583` by default. Set `PORT=3000` if you want the previous local port.

5. Confirm the process is up:

   - `GET http://localhost:3583/healthz`
   - `POST http://localhost:3583/api/slack/events`
   - `POST http://localhost:3583/api/slack/commands`
   - `POST http://localhost:3583/channels/slack/events`

## Slack app configuration

Create a Slack app and configure:

- Event Subscriptions: enable and set the Request URL to `https://your-domain/api/slack/events`
  - Flue's channel route is also available at `https://your-domain/channels/slack/events` if you want to move the Slack app to the framework-owned channel URL.
- Slash Commands: create `/nobo-listen`, `/nobo-prefs`, `/nobo-memory`, `/nobo-artifacts`, `/nobo-decisions`, `/nobo-decision`, `/nobo-issues`, `/nobo-search`, `/nobo-polls`, `/nobo-poll`, `/nobo-admin`, `/nobo-help`, `/nobo-status`, `/nobo-news`, `/nobo-hacker-news`, `/nobo-ai-news`, `/nobo-channel-digest`, `/nobo-reminder`, `/nobo-channel-model`, and `/nobo-dad-joke`, all with the Request URL `https://your-domain/api/slack/commands`
- Interactivity & Shortcuts: enable Interactivity with the Request URL `https://your-domain/api/slack/interactions`
- Shortcuts: optional global/message shortcuts can use callback IDs `nobo_reminder`, `nobo_prefs`, `nobo_channel_digest`, and `nobo_artifacts`
- Subscribe to bot events: `app_mention`
- Subscribe to bot events: `message.channels` so thread replies trigger follow-up responses
- Subscribe to bot events: `message.im` so direct messages to NoBo trigger responses
- Subscribe to bot events: `reaction_added` so reaction shortcuts can run
- Subscribe to bot events: `app_home_opened` so NoBo can publish the App Home dashboard
- OAuth scopes:
  - `commands`
  - `app_mentions:read`
  - `chat:write`
  - `channels:read` if scheduled Hacker News posts should resolve `#hacker-news` by name instead of `NOBO_HACKER_NEWS_CHANNEL_ID`
  - `reactions:read` so Slack sends `reaction_added` shortcut events
  - `reactions:write` so NoBo can react to messages it is handling
  - `im:history` for direct messages
  - `channels:history` for thread context in public channels
  - `groups:history` if NoBo should summarize private channels it has joined
  - `files:read` so uploaded attachment metadata, PDF/DOCX/XLSX/text contents, previews, and image bytes can be passed into the model

Semantic search over channel history uses `conversations.history`, so public channels need `channels:history`; private channels need `groups:history`. Artifact results are scoped to the Slack user who ran the command.

If you only grant `app_mentions:read` and `chat:write`, the bot still works, but it falls back to the current mention text instead of reading thread history.

To allow users to type directly in NoBo's App DM, enable the Messages tab in Slack App Home and turn on "Allow users to send Slash commands and messages from the messages tab", then reinstall the app after adding `message.im` and `im:history`.

Enable the Slack App Home surface if you want NoBo to show a dashboard with reminders, saved memory, active-listening channel status, and recent artifacts.

## App Home

NoBo publishes a Slack App Home dashboard on `app_home_opened`. It includes:

- Upcoming reminders and crons for the current user
- Saved personal memories
- Active-listening channel status and shared-memory counts
- Channel model overrides
- Recent generated artifacts
- Current user preferences
- Quick command examples for threads, channel settings, digests, and preferences

For local development, expose the app with a tunnel:

```bash
ngrok http 3583
```

Then paste the public HTTPS URL into Slack Event Subscriptions.

## Running in production

Build and run:

```bash
npm run build
npm start
```

## Ops status

Use `/nobo-status` in Slack for a private health snapshot covering Redis, the reminder scheduler, scheduled Hacker News, Slack config presence, model/search config, and recent recorded async errors. It reports only presence and non-secret config such as model names; tokens, signing secrets, API keys, and Redis URLs are never printed.

## Admin controls

Set `NOBO_ADMIN_USER_IDS` with one or more Slack user IDs before using `/nobo-admin`. Bootstrap env allow/deny lists apply at startup, and Redis-backed `/nobo-admin` changes layer on top when `REDIS_URL` is configured.

Commands:

- `/nobo-admin list`
- `/nobo-admin allow channel C123`
- `/nobo-admin deny channel C123`
- `/nobo-admin allow user U123`
- `/nobo-admin deny user U123`
- `/nobo-admin remove allow channel C123`
- `/nobo-admin audit 20`

Deny rules win over allow rules. If a user or channel allowlist is non-empty, matching Slack events, interactions, and slash commands must be on that allowlist. `/nobo-status`, `/nobo-admin`, `/healthz`, and Slack URL verification remain available so operators can inspect and repair access. Audit entries store sanitized actor/action/target metadata only; secrets and raw command text are not logged.

## CI and deployments

GitHub Actions runs `npm test` and `npm run build` on pull requests and pushes to `main`.

For Railway GitHub autodeploys, enable `Wait for CI` on the NoBo service deploy trigger so Railway waits for the GitHub Actions check to pass before deploying `main`.

## Files to edit first

- `src/app.ts`: Flue/Hono app entrypoint, health routes, legacy Slack route, and scheduler startup
- `src/agents/nobo.ts`: Flue agent definition and internal route guard
- `lib/nobo-prompt.ts`: assistant prompt
- `lib/flue-tools.ts`: Flue tool definitions for web search, artifacts, schedules, time, and Slack history
- `lib/ai.ts`: internal Flue agent prompt bridge and OpenCode Go model selection
- `lib/skills.ts`: Slack skill registry and command handlers
- `lib/slack.ts`: Slack history loading, text cleanup, and reply posting

## Web search

If `EXA_API_KEY` is set, NoBo can call Exa web search during Flue agent runs for current or hard-to-recall questions. The integration uses Exa's canonical JavaScript SDK and `/search` with `contents.highlights: true` for token-efficient excerpts. It defaults to `type: "auto"` and only forces livecrawl when the model explicitly asks for fresh content.

## News digests

NoBo can post channel-visible digests on demand:

- `/nobo-news [focus]`: this week's broad news; uses saved news interests when no focus is supplied
- `/nobo-ai-news [focus]`: this week's AI news
- `/nobo-hacker-news [focus]`: top trending Hacker News stories, optionally filtered by title/URL focus

The general and AI news digests use web search. Hacker News uses the official Firebase API.

## Time awareness

NoBo injects the current UTC time and the current user's saved timezone into every model call, falling back to America/Chicago. It also exposes a `get_current_time` Flue tool for exact time questions. Relative schedule phrases like "in 5 minutes" and "next Monday" use the user's saved timezone unless the user specifies another timezone.

## Artifacts

NoBo can generate browser-previewable artifacts when a Slack user asks for a standalone HTML page or Markdown document. Generated files are written under `ARTIFACT_DIR` and served from:

- `GET /artifacts/:id/:filename` for the raw `.html` or `.md` file
- `GET /artifacts/:id/preview` for a rendered Markdown preview

Set `ARTIFACT_BASE_URL` to the same public HTTPS origin you use for Slack events, such as your ngrok URL in local development, so links posted in Slack are clickable by teammates.

Each new artifact also writes `.artifact.json` metadata with title, kind, size, creation time, and optional expiration. Expired artifacts are still served by URL until deleted; cleanup removes them.

Updating an artifact snapshots the prior live file under `.versions` before writing the replacement. Rollback restores a retained version in place, so preview/raw URL behavior stays the same as normal artifact updates. History is owner-scoped and capped by `ARTIFACT_MAX_VERSIONS`.

Artifact management:

- `/nobo-artifacts list`
- `/nobo-artifacts list all`
- `/nobo-artifacts expired`
- `/nobo-artifacts update abc12345 <content>`
- `/nobo-artifacts versions abc12345`
- `/nobo-artifacts diff abc12345 [v1]`
- `/nobo-artifacts rollback abc12345 [v1]`
- `/nobo-artifacts delete abc12345`
- `/nobo-artifacts cleanup`
- `/nobo-artifacts modal`
- `@NoBo artifacts [list|update <id> <content>|versions <id>|diff <id>|rollback <id>|delete <id>|cleanup]`

## Issue Drafts

NoBo can turn Slack thread follow-ups into GitHub or Linear issue payloads:

- `@NoBo issues`: draft GitHub and Linear issues from current thread follow-ups
- `@NoBo issues github`: draft only GitHub issue payloads
- `@NoBo issues linear create`: create Linear issues when `NOBO_LINEAR_API_KEY` and `NOBO_LINEAR_TEAM_ID` are set
- `/nobo-issues github - Fix onboarding bug`: draft from pasted text
- `/nobo-issues both create - Ship launch checklist; Update rollout docs`: create when provider config exists, otherwise return actionable drafts and missing env vars

The default is draft-only. Create mode validates provider config first and returns Slack-readable payloads instead of failing when tokens, repository, or team IDs are absent.

## Semantic search

NoBo can search recent Slack channel history plus artifacts owned by the requesting Slack user:

- `/nobo-search database migration`
- `@NoBo semantic-search database migration`

The current backend is `LexicalSemanticSearchProvider`, exposed through the `SemanticSearchProvider` interface. It uses BM25-style lexical ranking so the feature works without embeddings or a vector DB. To swap in embeddings later, add a provider that implements that interface and route `NOBO_SEMANTIC_SEARCH_PROVIDER` to it.

## Polls

NoBo can run lightweight polls scoped to a Slack channel or thread. Polls live in Redis under `slack-channel-polls:<channelId>`.

Supported examples:

- `/nobo-polls create Ship Friday? | Yes | No`
- `/nobo-polls vote abc12345 1`
- `/nobo-polls results abc12345`
- `/nobo-polls close abc12345 decision`
- `@NoBo poll create Ship Friday? | Yes | No`
- `@NoBo poll vote 1`

Votes can be changed by voting again. In threads, users can also react to the poll thread/root message with option emoji such as `:one:`, `:two:`, `:three:`, or `:regional_indicator_a:`, `:regional_indicator_b:`, `:regional_indicator_c:`. Closing with `decision` records the current winner, tie, or no-consensus outcome in the channel decision log.

## Thread context

NoBo does not send the entire Slack thread back to the model on every reply. It keeps the first message in the thread plus the most recent turns, controlled by `SLACK_CONTEXT_MESSAGES`. This keeps latency and token cost from growing linearly with long threads.

If `REDIS_URL` is set, NoBo also caches trimmed thread state in Redis, so normal follow-up replies can avoid fetching the full Slack thread again. On a cold cache or restart, it falls back to Slack and repopulates Redis.

If `REDIS_URL` is set, NoBo also appends every handled user turn and NoBo reply to one shared Redis key per Slack channel: `slack-channel-memory:<channelId>`. This shared channel memory also stores channel settings, and is injected into future replies and reply decisions so NoBo can adapt to that channel's context, norms, and recurring topics.

NoBo also uses Redis to lock each Slack message event before generating a reply. This prevents duplicate Slack deliveries or multiple running instances from replying to the same message more than once. Without Redis, a local in-memory lock still protects a single process.

Schedule creation also uses a per-message idempotency key, so repeated `createSchedule` tool calls from one Slack ask return the already-created schedule instead of creating duplicate jobs.

NoBo can also summarize recent channel history when asked with a channel mention, such as `@NoBo summarize #ai over the past week`. This uses Slack `conversations.history`, so the bot must be in the channel and have the matching Slack history scope.

Use `@NoBo what needs my attention?` for deterministic triage of recent thread/channel context. NoBo scans local thread context, channel memory, Slack history when available, open follow-ups, channel decisions, and upcoming schedules, then returns a short prioritized list.

## Scheduled Hacker News

NoBo posts top trending Hacker News stories to `#hacker-news` twice daily at 9:00 AM and 2:00 PM America/Chicago. This follows Flue's Node scheduling guidance by using Croner for the fixed app-owned schedule.

Set `NOBO_HACKER_NEWS_CHANNEL_ID` to the Slack channel ID when possible. Otherwise NoBo resolves `NOBO_HACKER_NEWS_CHANNEL_NAME` by name, which requires the Slack app to have `channels:read`.

## Channel digest subscriptions

NoBo can subscribe a channel to recurring daily or weekly digests. Subscriptions live in Redis and read recent channel history at delivery time, so the bot needs `REDIS_URL` plus the matching Slack history scope.

Supported examples:

- `/nobo-channel-digest daily 09:00`
- `/nobo-channel-digest`
- `/nobo-channel-digest daily 09:00 launch blockers`
- `/nobo-channel-digest weekly monday 09:00 customer feedback`
- `/nobo-channel-digest list`
- `/nobo-channel-digest cancel abc12345`
- `@NoBo channel-digest daily 09:00 release risk`

Times are interpreted in America/Chicago. Daily digests read the last day; weekly digests read the last 7 days. Optional focus text steers the digest without changing which channel messages are read.

## Memory

NoBo can persist simple per-user memory in Redis across threads. Supported commands:

- `remember ...`
- `forget ...`
- `show my memory`
- `clear my memory`
- `what do you remember about me?`
- `forget everything`

`show my memory` returns a numbered list, and `forget ...` can remove by exact text, unique partial match, or number.

Saved memories are injected into future replies for that Slack user when relevant.

## Preferences

NoBo can persist per-user preferences in Redis:

- Timezone
- Verbosity: `concise`, `normal`, or `detailed`
- News interests
- Reminder style: `direct`, `gentle`, or `detailed`

Supported commands:

- `/nobo-prefs`
- `/nobo-prefs timezone America/New_York`
- `/nobo-prefs verbosity concise`
- `/nobo-prefs news ai, startups, security`
- `/nobo-prefs news add robotics`
- `/nobo-prefs news remove security`
- `/nobo-prefs reminder-style gentle`
- `/nobo-prefs clear`
- `@NoBo prefs ...`

Preferences are injected into model prompts. Timezone is used for current-time context and daily/weekly schedules. News interests focus broad news digests. Reminder style changes delivered reminder wording.

NoBo also persists per-channel preferences in Redis at `slack-preferences:channel:<channelId>`.

- `/nobo-channel-model`: choose this channel's text model with a Slack Block Kit selector
- `/nobo-channel-model status`
- `/nobo-channel-model <model-id>`
- `/nobo-channel-model reset`

The selector loads OpenCode Go models from `https://opencode.ai/zen/go/v1/models` and falls back to the built-in model list if discovery fails. Channel model choices only affect text requests; image-bearing messages continue using `OPENCODE_GO_VISION_MODEL`.

NoBo also keeps shared per-channel memory in Redis. This is channel-owned context, not user-owned memory, and is stored as one JSON value per channel for now.

Channel settings live in that same value. `/nobo-listen` toggles active listening for the current channel; `/nobo-listen on`, `/nobo-listen off`, and `/nobo-listen status` are also supported. When active listening is on, NoBo sees normal channel messages, records them into shared channel memory, and can choose to stay silent, reply in-thread, or reply inline. Shared channel memory appends and settings updates are atomic in Redis, and active-listening replies are capped by `NOBO_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES`.

Shared channel memory controls:

- `/nobo-memory`
- `/nobo-memory forget <number|text>`
- `/nobo-memory clear confirm`
- `@NoBo show channel memory`
- `@NoBo what do you remember about this channel?`
- `@NoBo forget channel memory <number|text>`
- `@NoBo clear channel memory confirm`

`/nobo-memory` shows saved channel entries and active-listening status. Clearing channel memory preserves channel settings; use `/nobo-listen off` to disable active listening.

## Decision log

NoBo can persist a simple decision log per Slack channel in Redis at `slack-channel-decisions:<channelId>`. Each entry stores the decision text, created date, user, source message timestamp, thread timestamp, and Slack thread permalink when Slack returns one.

Supported commands:

- `/nobo-decisions add Use Redis for shared channel state`
- `/nobo-decisions list`
- `/nobo-decision add Use Redis for shared channel state`
- `@NoBo decision add Use Redis for shared channel state`
- `@NoBo decisions`
- `@NoBo we decided to use Redis for shared channel state`
- `@NoBo we agreed to use Redis for shared channel state`

When active listening is on, NoBo also captures explicit `we decided ...` or `we agreed ...` channel messages that reach it.

## Reminders and crons

NoBo can persist user-owned reminders and recurring jobs in Redis. Each schedule is owned by the Slack user who created it and posts back into the channel/thread where it was created.

Supported examples:

- `/nobo-reminder`
- `@NoBo remind me about the deploy in 10 minutes`
- `@NoBo remind me in #josh to check the logs in 5 minutes`
- `@NoBo post in #ai in 5 minutes what is currently trending on Hacker News`
- `@NoBo in 2 hours remind me to check the logs`
- `@NoBo every 30 minutes do check the queue`
- `@NoBo every monday at 6pm CST do send the weekly metrics`
- `@NoBo every day at 9am CT remind me to triage alerts`
- `@NoBo list my reminders`
- `@NoBo cancel reminder abc12345`
- `@NoBo update schedule abc12345 to every weekday at 9am remind me to triage alerts`

Recurring daily and weekly schedules are interpreted in the user's saved timezone, falling back to America/Chicago. Reminder-style schedules post with the user's reminder style. Prompt-style schedules, such as "post what is trending", run NoBo at delivery time so current-information tasks can use web search. The scheduler requires `REDIS_URL`; without Redis, schedule commands fall through to normal NoBo replies.

## Conditional monitors

NoBo can persist user-owned conditional monitors in Redis. Monitors run on a recurring cadence and post only when the condition matches. They suppress repeated alerts for the same fingerprint.

Supported examples:

- `@NoBo monitor every 10 minutes alert if "deploy failed" appears`
- `@NoBo monitor web every 30 minutes alert if "OpenAI pricing" changes`
- `@NoBo monitor prompt every 5 minutes alert if "status.example.com" fails`
- `@NoBo monitors`
- `@NoBo cancel monitor abc12345`

`appears` defaults to recent Slack channel history. `changes` defaults to web search. `fails` defaults to a current prompt check that can use available tools. The monitor runner requires `REDIS_URL`; without Redis, monitor commands fall through to normal NoBo replies.

## Follow-ups

NoBo can extract and track action items from the current Slack thread. It stores follow-ups in Redis, keeps owner/date metadata when the thread makes them clear, and creates one-time reminder schedules for future due dates.

Supported examples:

- `@NoBo follow-ups`
- `@NoBo follow-ups list`
- `@NoBo follow-ups mine`
- `@NoBo follow-ups done abc12345`

Reminder delivery uses the same Redis scheduler as reminders and crons. If an item has a clear Slack owner, the reminder is owned by and mentions that user; otherwise it falls back to the user who ran the tracker.

## Reaction shortcuts

NoBo handles a small allowlist of `reaction_added` shortcuts on Slack messages. Add the reaction to the root message of a thread for best results.

- `:summary:`, `:summarize:`, `:summarise:`, `:thread_summary:`, `:thread-summary:`, `:nobo_summary:`, `:nobo-summary:`: summarize the thread
- `:memo:`, `:note:`, `:artifact:`, `:nobo_note:`, `:nobo_artifact:`, `:page_facing_up:`, `:spiral_note_pad:`: create a Markdown note artifact from the thread
- `:alarm_clock:`, `:reminder:`, `:remind:`, `:nobo_remind:`, `:nobo_reminder:`: create a next-day 9 AM America/Chicago reminder for the reacting user

Unknown reactions, non-message reactions, and bot reactions are ignored.

## Skills

NoBo supports explicit Slack skills triggered with `@NoBo <skill> ...`.

Current skills:

- `/nobo-help`
- `/nobo-status`
- `/nobo-search <query>`
- `/nobo-listen [on|off|status]`
- `/nobo-prefs [setting]`
- `/nobo-memory [show|forget <number|text>|clear confirm]`
- `/nobo-artifacts [list|update <id> <content>|versions <id>|diff <id>|rollback <id>|delete <id>|cleanup]`
- `/nobo-decisions [add <decision>|list]` or `/nobo-decision ...`
- `/nobo-news [focus]`
- `/nobo-hacker-news [focus]`
- `/nobo-ai-news [focus]`
- `/nobo-channel-digest daily|weekly ...`
- `/nobo-reminder`
- `/nobo-channel-model`
- `/nobo-dad-joke`
- `@NoBo skills` or `@NoBo help`
- `@NoBo decision add <decision>` or `@NoBo decisions`
- `@NoBo summarize-thread [focus]` or `@NoBo summary [focus]`
- `@NoBo meeting-notes [artifact]`, `meeting notes`, or `notes`: turn a Slack huddle transcript, transcript upload, or thread text into notes with summary, decisions, action items, and blockers
- `@NoBo follow-ups`, `@NoBo follow-ups list`, `@NoBo follow-ups mine`, `@NoBo follow-ups done <id>`
- `@NoBo thread-todos`, `@NoBo todos`, or `@NoBo action-items`
- `@NoBo channel-digest daily 09:00 [focus]` or `@NoBo digest daily 09:00 [focus]`
- `@NoBo semantic-search <query>`, `history-search <query>`, or `search-history <query>`
- `@NoBo monitor every 10 minutes alert if <thing> appears|changes|fails` or `@NoBo monitors`
- `@NoBo web-search <query>` or `@NoBo search <query>`
- `@NoBo show channel memory`
- `@NoBo forget channel memory <number|text>`
- `@NoBo clear channel memory confirm`
- `@NoBo artifacts [list|update <id> <content>|versions <id>|diff <id>|rollback <id>|delete <id>|cleanup]`
- `@NoBo list-artifacts`, `delete-artifact`, `update-artifact`, `edit-artifact`, `cleanup-artifacts`, or `prune-artifacts`
- `@NoBo prefs ...`, `preferences ...`, or `settings ...`

Memory commands also remain available:

- `@NoBo remember ...`
- `@NoBo forget ...`
- `@NoBo show my memory`
- `@NoBo clear my memory`

## Attachments

NoBo passes Slack attachment metadata into the model. For image uploads it attempts to download the image and attach the bytes to the current user message. For small text-like uploads such as `.txt`, Markdown, JSON, logs, code, CSV, TSV, VTT, and SRT, it downloads the private Slack file and includes extracted text in context.

For meeting notes, use `@NoBo meeting-notes` in a thread with transcript-like text or an attached transcript. Add `artifact`, `markdown`, `doc`, `save`, or `export` to have NoBo create a Markdown artifact and link it back. Slack huddle/transcript metadata is included when Slack provides it; otherwise NoBo uses the uploaded text/Markdown transcript and surrounding thread.

This requires the Slack app to have `files:read`.

Attachment limits:

- Images are capped at 5 MB.
- Text-like files are capped by `SLACK_TEXT_ATTACHMENT_MAX_BYTES` and `SLACK_ATTACHMENT_TEXT_MAX_CHARS`.
- PDFs, Word docs, and binary spreadsheets use Slack-provided preview text when available; otherwise NoBo includes metadata and notes the current extraction limit. CSV/TSV spreadsheet exports and VTT/SRT transcripts are extracted as text.

NoBo uses `OPENCODE_GO_VISION_MODEL` for image-bearing messages. If unset, it defaults to `kimi-k2.6`. If the configured vision model fails, NoBo retries the image request once with `kimi-k2.6` before falling back to text-only attachment context.

In direct testing here on May 21, 2026, `minimax-m2.7` behaved as if no image was attached, while `kimi-k2.6` successfully described the same image. If your normal text model is not vision-capable, keep it in `OPENCODE_GO_MODEL` and set `OPENCODE_GO_VISION_MODEL` to a model that actually handles image input.
