# Joshbot

Joshbot is a small TypeScript process that receives Slack Events API calls and replies in-thread.

## Stack

- Node.js HTTP server
- TypeScript
- Vercel AI SDK 6
- OpenCode Go via the AI SDK OpenAI-compatible provider
- Exa Search API via `exa-js`
- Redis thread-state cache
- Slack Events API

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
   - `OPENCODE_GO_MODEL`: defaults to `kimi-k2.6`
   - `OPENCODE_GO_VISION_MODEL`: optional override for image-bearing messages; defaults to `kimi-k2.6`
   - `EXA_API_KEY`: enables Exa-backed web search for current or uncertain facts
   - `REDIS_URL`: optional Redis connection string for caching Slack thread state
   - `REDIS_TTL_SECONDS`: defaults to `604800` (7 days)
   - `SLACK_EVENT_LOCK_TTL_SECONDS`: defaults to `600`; prevents duplicate Slack event processing across retries or concurrent instances
   - `SCHEDULE_CREATE_IDEMPOTENCY_TTL_SECONDS`: defaults to `600`; prevents duplicate schedule creation from one Slack ask
   - `MEMORY_MAX_ITEMS`: defaults to `20`; cap for saved per-user memory items
   - `SLACK_BOT_TOKEN`: Bot User OAuth Token from your Slack app
   - `SLACK_SIGNING_SECRET`: Signing secret from the Slack app settings
   - `SLACK_BOT_USER_ID`: the bot user ID, used to strip mentions and classify assistant replies in thread history
   - `SLACK_CONTEXT_MESSAGES`: defaults to `12`; keeps the thread root plus only the most recent turns when building model context
   - `ARTIFACT_BASE_URL`: public base URL used in Slack artifact links; defaults to `http://localhost:$PORT`
   - `ARTIFACT_DIR`: local directory for generated artifacts; defaults to `artifacts`
   - `SCHEDULER_INTERVAL_MS`: defaults to `30000`; how often Joshbot checks Redis for due reminders and crons

4. Start the process:

   ```bash
   npm run dev
   ```

5. Confirm the process is up:

   - `GET http://localhost:3000/healthz`
   - `POST http://localhost:3000/api/slack/events`

## Slack app configuration

Create a Slack app and configure:

- Event Subscriptions: enable and set the Request URL to `https://your-domain/api/slack/events`
- Subscribe to bot events: `app_mention`
- Subscribe to bot events: `message.channels` so thread replies trigger follow-up responses
- Subscribe to bot events: `message.im` so direct messages to Joshbot trigger responses
- OAuth scopes:
  - `app_mentions:read`
  - `chat:write`
  - `im:history` for direct messages
  - `channels:history` for thread context in public channels
  - `groups:history` if Joshbot should summarize private channels it has joined
  - `files:read` so uploaded attachment metadata and previews can be passed into the model

If you only grant `app_mentions:read` and `chat:write`, the bot still works, but it falls back to the current mention text instead of reading thread history.

To allow users to type directly in Joshbot's App DM, enable the Messages tab in Slack App Home and turn on "Allow users to send Slash commands and messages from the messages tab", then reinstall the app after adding `message.im` and `im:history`.

For local development, expose the app with a tunnel:

```bash
ngrok http 3000
```

Then paste the public HTTPS URL into Slack Event Subscriptions.

## Running in production

Build and run:

```bash
npm run build
npm start
```

## CI and deployments

GitHub Actions runs `npm test` and `npm run build` on pull requests and pushes to `main`.

For Railway GitHub autodeploys, enable `Wait for CI` on the `joshbot` service deploy trigger so Railway waits for the GitHub Actions check to pass before deploying `main`.

## Files to edit first

- `lib/ai.ts`: assistant prompt and OpenCode Go model selection
- `lib/skills.ts`: Slack skill registry and command handlers
- `lib/slack.ts`: Slack history loading, text cleanup, and reply posting
- `server.ts`: HTTP routing and Slack event handling

## Web search

If `EXA_API_KEY` is set, Joshbot can call Exa web search during response generation for current or hard-to-recall questions. The integration uses Exa's canonical JavaScript SDK and `/search` with `contents.highlights: true` for token-efficient excerpts. It defaults to `type: "auto"` and only forces livecrawl when the model explicitly asks for fresh content.

## Time awareness

Joshbot injects the current UTC and America/Chicago time into every model call and exposes a `getCurrentTime` tool for exact time questions. Relative schedule phrases like "in 5 minutes" and "next Monday" should be interpreted from America/Chicago unless the user specifies another timezone.

## Artifacts

Joshbot can generate browser-previewable artifacts when a Slack user asks for a standalone HTML page or Markdown document. Generated files are written under `ARTIFACT_DIR` and served from:

- `GET /artifacts/:id/:filename` for the raw `.html` or `.md` file
- `GET /artifacts/:id/preview` for a rendered Markdown preview

Set `ARTIFACT_BASE_URL` to the same public HTTPS origin you use for Slack events, such as your ngrok URL in local development, so links posted in Slack are clickable by teammates.

## Thread context

Joshbot does not send the entire Slack thread back to the model on every reply. It keeps the first message in the thread plus the most recent turns, controlled by `SLACK_CONTEXT_MESSAGES`. This keeps latency and token cost from growing linearly with long threads.

If `REDIS_URL` is set, Joshbot also caches trimmed thread state in Redis, so normal follow-up replies can avoid fetching the full Slack thread again. On a cold cache or restart, it falls back to Slack and repopulates Redis.

Joshbot also uses Redis to lock each Slack message event before generating a reply. This prevents duplicate Slack deliveries or multiple running instances from replying to the same message more than once. Without Redis, a local in-memory lock still protects a single process.

Schedule creation also uses a per-message idempotency key, so repeated `createSchedule` tool calls from one Slack ask return the already-created schedule instead of creating duplicate jobs.

Joshbot can also summarize recent channel history when asked with a channel mention, such as `@JoshBot summarize #ai over the past week`. This uses Slack `conversations.history`, so the bot must be in the channel and have the matching Slack history scope.

## Memory

Joshbot can persist simple per-user memory in Redis across threads. Supported commands:

- `remember ...`
- `forget ...`
- `show my memory`
- `clear my memory`

`show my memory` returns a numbered list, and `forget ...` can remove by exact text, unique partial match, or number.

Saved memories are injected into future replies for that Slack user when relevant.

## Reminders and crons

Joshbot can persist user-owned reminders and recurring jobs in Redis. Each schedule is owned by the Slack user who created it and posts back into the channel/thread where it was created.

Supported examples:

- `@JoshBot remind me about the deploy in 10 minutes`
- `@JoshBot remind me in #josh to check the logs in 5 minutes`
- `@JoshBot post in #ai in 5 minutes what is currently trending on Hacker News`
- `@JoshBot in 2 hours remind me to check the logs`
- `@JoshBot every 30 minutes do check the queue`
- `@JoshBot every monday at 6pm CST do send the weekly metrics`
- `@JoshBot every day at 9am CT remind me to triage alerts`
- `@JoshBot list my reminders`
- `@JoshBot cancel reminder abc12345`
- `@JoshBot update schedule abc12345 to every weekday at 9am remind me to triage alerts`

Recurring daily and weekly schedules are interpreted in America/Chicago time. Reminder-style schedules post the saved reminder text. Prompt-style schedules, such as "post what is trending", run Joshbot at delivery time so current-information tasks can use web search. The scheduler requires `REDIS_URL`; without Redis, schedule commands fall through to normal Joshbot replies.

## Skills

Joshbot supports explicit Slack skills triggered with `@JoshBot <skill> ...`.

Current skills:

- `@JoshBot skills` or `@JoshBot help`
- `@JoshBot summarize-thread [focus]`
- `@JoshBot thread-todos`
- `@JoshBot web-search <query>`

Memory commands also remain available:

- `@JoshBot remember ...`
- `@JoshBot show my memory`
- `@JoshBot clear my memory`

## Attachments

Joshbot passes Slack attachment metadata into the model, and for image uploads it will also attempt to download the image and attach the bytes to the current user message.

This requires the Slack app to have `files:read`.

Joshbot uses `OPENCODE_GO_VISION_MODEL` for image-bearing messages. If unset, it defaults to `kimi-k2.6`.

In direct testing here on May 21, 2026, `minimax-m2.7` behaved as if no image was attached, while `kimi-k2.6` successfully described the same image. If your normal text model is not vision-capable, keep it in `OPENCODE_GO_MODEL` and set `OPENCODE_GO_VISION_MODEL` to a model that actually handles image input.
