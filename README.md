# NoBo

NoBo is a small TypeScript process that receives Slack Events API calls and replies in-thread.

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
   - `OPENCODE_GO_MODEL`: defaults to `glm-5.2`
   - `OPENCODE_GO_VISION_MODEL`: optional override for image-bearing messages; defaults to `kimi-k2.6`
   - `EXA_API_KEY`: enables Exa-backed web search for current or uncertain facts
   - `REDIS_URL`: optional Redis connection string for caching Slack thread state, shared channel memory, and channel decision logs
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
   - `SLACK_TEXT_ATTACHMENT_MAX_BYTES`: defaults to `262144`; max private Slack file download size for text/CSV-like extraction, capped at 2 MB
   - `SLACK_ATTACHMENT_TEXT_MAX_CHARS`: defaults to `6000`; max extracted attachment text sent into model context, capped at 20000
   - `ARTIFACT_BASE_URL`: public base URL used in Slack artifact links; defaults to `http://localhost:$PORT`
   - `ARTIFACT_DIR`: local directory for generated artifacts; defaults to `artifacts`
   - `ARTIFACT_TTL_DAYS`: optional default artifact expiration window; blank or `0` means no default expiration
   - `SCHEDULER_INTERVAL_MS`: defaults to `30000`; how often NoBo checks Redis for due reminders and crons
   - `CHANNEL_DIGEST_SCHEDULER_INTERVAL_MS`: optional override for channel digest subscription checks; falls back to `SCHEDULER_INTERVAL_MS`
   - `NOBO_HACKER_NEWS_CHANNEL_NAME`: defaults to `hacker-news`; channel name for the scheduled Hacker News digest
   - `NOBO_HACKER_NEWS_CHANNEL_ID`: optional Slack channel ID override for scheduled Hacker News posts
   - `NOBO_HACKER_NEWS_SCHEDULE_TIMES`: defaults to `09:00,14:00`; daily post times in America/Chicago
   - `NOBO_HACKER_NEWS_FOCUS`: optional search focus for scheduled Hacker News posts

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
- Slash Commands: create `/nobo-listen`, `/nobo-memory`, `/nobo-artifacts`, `/nobo-decisions`, `/nobo-help`, `/nobo-status`, `/nobo-news`, `/nobo-hacker-news`, `/nobo-ai-news`, `/nobo-channel-digest`, and `/nobo-dad-joke`, all with the Request URL `https://your-domain/api/slack/commands`
- Subscribe to bot events: `app_mention`
- Subscribe to bot events: `message.channels` so thread replies trigger follow-up responses
- Subscribe to bot events: `message.im` so direct messages to NoBo trigger responses
- Subscribe to bot events: `reaction_added` so reaction shortcuts can run
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
  - `files:read` so uploaded attachment metadata, previews, small text-like files, and image bytes can be passed into the model

If you only grant `app_mentions:read` and `chat:write`, the bot still works, but it falls back to the current mention text instead of reading thread history.

To allow users to type directly in NoBo's App DM, enable the Messages tab in Slack App Home and turn on "Allow users to send Slash commands and messages from the messages tab", then reinstall the app after adding `message.im` and `im:history`.

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

## Time awareness

NoBo injects the current UTC and America/Chicago time into every model call and exposes a `get_current_time` Flue tool for exact time questions. Relative schedule phrases like "in 5 minutes" and "next Monday" should be interpreted from America/Chicago unless the user specifies another timezone.

## Artifacts

NoBo can generate browser-previewable artifacts when a Slack user asks for a standalone HTML page or Markdown document. Generated files are written under `ARTIFACT_DIR` and served from:

- `GET /artifacts/:id/:filename` for the raw `.html` or `.md` file
- `GET /artifacts/:id/preview` for a rendered Markdown preview

Set `ARTIFACT_BASE_URL` to the same public HTTPS origin you use for Slack events, such as your ngrok URL in local development, so links posted in Slack are clickable by teammates.

Each new artifact also writes `.artifact.json` metadata with title, kind, size, creation time, and optional expiration. Expired artifacts are still served by URL until deleted; cleanup removes them.

Artifact management:

- `/nobo-artifacts list`
- `/nobo-artifacts list all`
- `/nobo-artifacts expired`
- `/nobo-artifacts delete abc12345`
- `/nobo-artifacts cleanup`
- `@NoBo artifacts [list|delete <id>|cleanup]`

## Thread context

NoBo does not send the entire Slack thread back to the model on every reply. It keeps the first message in the thread plus the most recent turns, controlled by `SLACK_CONTEXT_MESSAGES`. This keeps latency and token cost from growing linearly with long threads.

If `REDIS_URL` is set, NoBo also caches trimmed thread state in Redis, so normal follow-up replies can avoid fetching the full Slack thread again. On a cold cache or restart, it falls back to Slack and repopulates Redis.

If `REDIS_URL` is set, NoBo also appends every handled user turn and NoBo reply to one shared Redis key per Slack channel: `slack-channel-memory:<channelId>`. This shared channel memory also stores channel settings, and is injected into future replies and reply decisions so NoBo can adapt to that channel's context, norms, and recurring topics.

NoBo also uses Redis to lock each Slack message event before generating a reply. This prevents duplicate Slack deliveries or multiple running instances from replying to the same message more than once. Without Redis, a local in-memory lock still protects a single process.

Schedule creation also uses a per-message idempotency key, so repeated `createSchedule` tool calls from one Slack ask return the already-created schedule instead of creating duplicate jobs.

NoBo can also summarize recent channel history when asked with a channel mention, such as `@NoBo summarize #ai over the past week`. This uses Slack `conversations.history`, so the bot must be in the channel and have the matching Slack history scope.

## Scheduled Hacker News

NoBo posts top trending Hacker News stories to `#hacker-news` twice daily at 9:00 AM and 2:00 PM America/Chicago. This follows Flue's Node scheduling guidance by using Croner for the fixed app-owned schedule.

Set `NOBO_HACKER_NEWS_CHANNEL_ID` to the Slack channel ID when possible. Otherwise NoBo resolves `NOBO_HACKER_NEWS_CHANNEL_NAME` by name, which requires the Slack app to have `channels:read`.

## Channel digest subscriptions

NoBo can subscribe a channel to recurring daily or weekly digests. Subscriptions live in Redis and read recent channel history at delivery time, so the bot needs `REDIS_URL` plus the matching Slack history scope.

Supported examples:

- `/nobo-channel-digest daily 09:00`
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

`show my memory` returns a numbered list, and `forget ...` can remove by exact text, unique partial match, or number.

Saved memories are injected into future replies for that Slack user when relevant.

NoBo also keeps shared per-channel memory in Redis. This is channel-owned context, not user-owned memory, and is stored as one JSON value per channel for now.

Channel settings live in that same value. `/nobo-listen` toggles active listening for the current channel; `/nobo-listen on`, `/nobo-listen off`, and `/nobo-listen status` are also supported. When active listening is on, NoBo sees normal channel messages, records them into shared channel memory, and can choose to stay silent, reply in-thread, or reply inline. Shared channel memory appends and settings updates are atomic in Redis, and active-listening replies are capped by `NOBO_ACTIVE_LISTENING_MAX_CONCURRENT_REPLIES`.

Shared channel memory controls:

- `/nobo-memory`
- `/nobo-memory forget <number|text>`
- `/nobo-memory clear confirm`
- `@NoBo show channel memory`
- `@NoBo forget channel memory <number|text>`
- `@NoBo clear channel memory confirm`

`/nobo-memory` shows saved channel entries and active-listening status. Clearing channel memory preserves channel settings; use `/nobo-listen off` to disable active listening.

## Decision log

NoBo can persist a simple decision log per Slack channel in Redis at `slack-channel-decisions:<channelId>`. Each entry stores the decision text, created date, user, source message timestamp, thread timestamp, and Slack thread permalink when Slack returns one.

Supported commands:

- `/nobo-decisions add Use Redis for shared channel state`
- `/nobo-decisions list`
- `@NoBo decision add Use Redis for shared channel state`
- `@NoBo decisions`
- `@NoBo we decided to use Redis for shared channel state`

When active listening is on, NoBo also captures explicit `we decided ...` or `we agreed ...` channel messages that reach it.

## Reminders and crons

NoBo can persist user-owned reminders and recurring jobs in Redis. Each schedule is owned by the Slack user who created it and posts back into the channel/thread where it was created.

Supported examples:

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

Recurring daily and weekly schedules are interpreted in America/Chicago time. Reminder-style schedules post the saved reminder text. Prompt-style schedules, such as "post what is trending", run NoBo at delivery time so current-information tasks can use web search. The scheduler requires `REDIS_URL`; without Redis, schedule commands fall through to normal NoBo replies.

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

- `:summary:`, `:summarize:`, `:thread_summary:`, `:nobo_summary:`: summarize the thread
- `:memo:`, `:note:`, `:artifact:`, `:nobo_note:`, `:nobo_artifact:`: create a Markdown note artifact from the thread
- `:alarm_clock:`, `:reminder:`, `:remind:`, `:nobo_remind:`: create a next-day 9 AM America/Chicago reminder for the reacting user

Unknown reactions, non-message reactions, and bot reactions are ignored.

## Skills

NoBo supports explicit Slack skills triggered with `@NoBo <skill> ...`.

Current skills:

- `/nobo-help`
- `/nobo-status`
- `/nobo-listen [on|off|status]`
- `/nobo-memory [show|forget <number|text>|clear confirm]`
- `/nobo-artifacts [list|delete <id>|cleanup]`
- `/nobo-decisions [add <decision>|list]`
- `/nobo-news [focus]`
- `/nobo-hacker-news [focus]`
- `/nobo-ai-news [focus]`
- `/nobo-channel-digest daily|weekly ...`
- `/nobo-dad-joke`
- `@NoBo skills` or `@NoBo help`
- `@NoBo decision add <decision>` or `@NoBo decisions`
- `@NoBo summarize-thread [focus]`
- `@NoBo follow-ups`
- `@NoBo thread-todos`
- `@NoBo channel-digest daily 09:00 [focus]`
- `@NoBo web-search <query>`
- `@NoBo show channel memory`
- `@NoBo forget channel memory <number|text>`
- `@NoBo clear channel memory confirm`
- `@NoBo artifacts [list|delete <id>|cleanup]`

Memory commands also remain available:

- `@NoBo remember ...`
- `@NoBo show my memory`
- `@NoBo clear my memory`

## Attachments

NoBo passes Slack attachment metadata into the model. For image uploads it attempts to download the image and attach the bytes to the current user message. For small text-like uploads such as `.txt`, Markdown, JSON, logs, code, CSV, and TSV, it downloads the private Slack file and includes extracted text in context.

This requires the Slack app to have `files:read`.

Attachment limits:

- Images are capped at 5 MB.
- Text-like files are capped by `SLACK_TEXT_ATTACHMENT_MAX_BYTES` and `SLACK_ATTACHMENT_TEXT_MAX_CHARS`.
- PDFs, Word docs, and binary spreadsheets use Slack-provided preview text when available; otherwise NoBo includes metadata and notes the current extraction limit. CSV/TSV spreadsheet exports are extracted as text.

NoBo uses `OPENCODE_GO_VISION_MODEL` for image-bearing messages. If unset, it defaults to `kimi-k2.6`. If the configured vision model fails, NoBo retries the image request once with `kimi-k2.6` before falling back to text-only attachment context.

In direct testing here on May 21, 2026, `minimax-m2.7` behaved as if no image was attached, while `kimi-k2.6` successfully described the same image. If your normal text model is not vision-capable, keep it in `OPENCODE_GO_MODEL` and set `OPENCODE_GO_VISION_MODEL` to a model that actually handles image input.
