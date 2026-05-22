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
   - `EXA_API_KEY`: enables Exa-backed web search for current or uncertain facts
   - `REDIS_URL`: optional Redis connection string for caching Slack thread state
   - `REDIS_TTL_SECONDS`: defaults to `604800` (7 days)
   - `MEMORY_MAX_ITEMS`: defaults to `20`; cap for saved per-user memory items
   - `SLACK_BOT_TOKEN`: Bot User OAuth Token from your Slack app
   - `SLACK_SIGNING_SECRET`: Signing secret from the Slack app settings
   - `SLACK_BOT_USER_ID`: the bot user ID, used to strip mentions and classify assistant replies in thread history
   - `SLACK_CONTEXT_MESSAGES`: defaults to `12`; keeps the thread root plus only the most recent turns when building model context

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
- OAuth scopes:
  - `app_mentions:read`
  - `chat:write`
  - `channels:history` for thread context in public channels
  - `files:read` so uploaded attachment metadata and previews can be passed into the model

If you only grant `app_mentions:read` and `chat:write`, the bot still works, but it falls back to the current mention text instead of reading thread history.

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

## Files to edit first

- `lib/ai.ts`: assistant prompt and OpenCode Go model selection
- `lib/slack.ts`: Slack history loading, text cleanup, and reply posting
- `server.ts`: HTTP routing and Slack event handling

## Web search

If `EXA_API_KEY` is set, Joshbot can call Exa web search during response generation for current or hard-to-recall questions. The integration uses Exa's canonical JavaScript SDK and `/search` with `contents.highlights: true` for token-efficient excerpts. It defaults to `type: "auto"` and only forces livecrawl when the model explicitly asks for fresh content.

## Thread context

Joshbot does not send the entire Slack thread back to the model on every reply. It keeps the first message in the thread plus the most recent turns, controlled by `SLACK_CONTEXT_MESSAGES`. This keeps latency and token cost from growing linearly with long threads.

If `REDIS_URL` is set, Joshbot also caches trimmed thread state in Redis, so normal follow-up replies can avoid fetching the full Slack thread again. On a cold cache or restart, it falls back to Slack and repopulates Redis.

## Memory

Joshbot can persist simple per-user memory in Redis across threads. Supported commands:

- `remember ...`
- `forget ...`
- `show my memory`
- `clear my memory`

Saved memories are injected into future replies for that Slack user when relevant.
