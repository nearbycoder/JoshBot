# Upload X media directly to Slack

Run in the destination channel:

```text
/nobo-x
```

This opens a native Slack modal with a link field, destination channel, and **Upload media** button. Invalid links are flagged inline. Upload progress and the result stay in the private modal; closing it after submission does not cancel the upload. If you close it early, check the channel for the files before retrying.

Or include the link to skip the form:

```text
/nobo-x https://x.com/user/status/123456789
```

NoBo uploads the actual attached images and MP4 videos as native Slack files, in media order. When the post has text, a short **Post summary (AI)** accompanies the files in the same message. No source link, full-tweet card, thumbnail preview, or link-unfurl message is posted. GIF-style X videos are uploaded as playable MP4s. Progress, completion, and errors are visible only to the requester. A `/photo/2` or `/video/1` link still uploads the whole post's attachments.

Summaries use the channel’s selected text model (or NoBo’s default) and existing data-policy fallback. Only the post’s own text is summarized—not quoted posts, linked pages, image contents, or video transcripts. No Slack history or personal memory is sent for this task, and tools are disabled. Link-only/empty posts stay media-only. If generation fails, takes over 20 seconds, or returns an empty/oversized result, NoBo uploads the media without a summary. Summaries are limited to 600 characters and rendered as plain text so they cannot trigger Slack mentions.

You can also use the existing command `/nobo-help x <link>` without registering another slash command, or `/nobo-help x` to open the same form. The file-upload permission below is still required. The modal uses NoBo’s existing Interactivity endpoint and requires no additional Slack scopes or admin changes.

## Slack admin setup

Open [Your Apps](https://api.slack.com/apps), select the existing **NoBo** app, and preserve its other configuration:

1. **OAuth & Permissions → Bot Token Scopes:** add `files:write` if missing, then **Reinstall to Workspace** to grant it. This is separate from the existing `files:read` scope. If Slack changes the bot token, update `SLACK_BOT_TOKEN` in Railway; never paste it into a channel.
2. **Slash Commands → Create New Command:**
   - Command: `/nobo-x`
   - Request URL: `https://joshbot-production.up.railway.app/api/slack/commands`
   - Short description: `Upload an X post’s images or video to this channel`
   - Usage hint: `<X post link>`
   - Save; reinstall again if Slack requests it. No new event subscriptions or interactivity settings are needed.
3. Invite NoBo into each destination channel, including private channels.

After deployment, test with a public image post and a short public video post you have permission to share. Expect real Slack files, no X post card, and a private completion message. The bot cannot override workspace file-sharing restrictions. Slack controls video processing/playback and storage retention.

## Limits and dependencies

- Public X/Twitter status URLs only, including mobile, `i/status`, and `i/web/status` links. Shortened links, profiles, and search pages are rejected.
- Up to 4 attachments, 50 MiB per file and 100 MiB total. Oversized or invalid downloads fail before any Slack upload. Files are held in bounded memory, not persisted to NoBo's artifact storage.
- One transfer at a time per server process; additional requests receive a private busy message. Keep the existing one-replica deployment. Work does not resume across deployments/restarts.
- Lookup uses the public [FxEmbed API v2](https://docs.fxembed.com/api/introduction/); downloads come only from X's image/video CDNs. No X API key, cookies, account connection, or new hosted infrastructure is needed. Summaries use NoBo’s existing OpenCode configuration; media upload still works if it is unavailable. This **does depend on an external public service**: FxEmbed receives the public post ID and server IP, never Slack tokens or conversation content. The configured model provider receives up to 12,000 characters of public post text for summarization. Service outages, rate limits, and X changes can make posts unavailable.
- Private, deleted, restricted, and unavailable posts are not bypassed. External players, live streams, and media nested in quoted posts are not downloaded; provide the original media post's URL.
- Only share content you have permission to redistribute. Copies are visible to members of the destination Slack channel.
- An uncertain Slack upload is not automatically retried: check the channel before retrying to avoid duplicate attachments.

Implementation follows Slack's current [file upload flow](https://docs.slack.dev/messaging/working-with-files/) through `filesUploadV2`, not the retired `files.upload` endpoint.
