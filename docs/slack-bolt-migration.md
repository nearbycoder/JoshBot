# Bolt migration: deployment and Slack admin checklist

## Merge and deploy

Merge the stacked PRs in order: **[#22](https://github.com/nearbycoder/JoshBot/pull/22) → [#23](https://github.com/nearbycoder/JoshBot/pull/23) → [#24](https://github.com/nearbycoder/JoshBot/pull/24)**. Each later PR is based on the previous branch. After merging a predecessor, verify/retarget the next PR's base to `main`. If squash-merging, GitHub may show predecessor commits in the next diff until the stack is rebased. Do not deploy a child branch independently of its ancestors.

Railway still uses `npm run build` and `npm start`, listening on `PORT`. No domain, signing secret or command endpoint needs to change. Keep **one replica**: the in-flight model cancellation registry is process-local. Redis still owns existing memory, event locks and scheduled jobs; Flue's per-run execution database is process-lifetime SQLite, as configured by the standalone runtime.

Code review/tests do not install the new Slack permissions or prove the native UI works in your workspace. Complete the following steps after the full stack is deployed.

## Slack app settings

Open the existing **NoBo** app at [Your Apps](https://api.slack.com/apps). Preserve its app ID, bot, signing secret, existing commands, shortcuts and scopes.

1. **Agents**: enable the Agent messaging experience (`agent_view`), add an agent overview, and save. If the app currently uses `assistant_view`, use Slack's migration/update button; the nested description changes from `assistant_description` to `agent_description`. This change is **irreversible** and users must hard-refresh Slack afterward. Some AI features require a paid workspace plan. See [Slack's migration guide](https://docs.slack.dev/ai/migrating-to-agent-messaging/) and [Agent setup](https://docs.slack.dev/ai/developing-agents/).
2. **App Home**: keep Home and Messages enabled and allow users to send messages. NoBo publishes its existing Home dashboard and sets four suggested prompts when the Messages tab opens.
3. **OAuth & Permissions → Bot Token Scopes**: ensure **`assistant:write`** is added by the Agents setting and **`chat:write`** remains granted. Preserve `commands`, `app_mentions:read`, `im:history`, `channels:history`, `reactions:read`, `reactions:write`, `files:read`, and any existing private-channel/read scopes your installation uses. No extra workspace-wide search scopes or app-level tokens are required for this migration. The complete existing feature scope list remains in the README.
4. **Event Subscriptions**: keep the verified Request URL **`https://YOUR-RAILWAY-DOMAIN/api/slack/events`**. Add these bot events:

   | Event | Purpose |
   | --- | --- |
   | `agent_session_stopped` | Shows Slack's native Stop button and delivers cancellation |
   | `app_context_changed` | Includes the user's active-view context on DM messages |
   | `agent_session_title_changed` | Accepts title-change notifications without overwriting user titles |

   Retain `app_home_opened`, `message.im`, `app_mention`, `message.channels`, `reaction_added`, and any existing `message.groups` subscriptions used for private-channel replies. This implementation no longer needs the legacy `assistant_thread_started` or `assistant_thread_context_changed` events.
5. **Interactivity & Shortcuts**: leave enabled at **`https://YOUR-RAILWAY-DOMAIN/api/slack/interactions`**. Keep existing shortcut callback IDs. Feedback buttons are not added in this pass.
6. **Slash Commands**: keep every existing command and its Request URL **`https://YOUR-RAILWAY-DOMAIN/api/slack/commands`**. No commands need recreating.
7. **OAuth & Permissions → Reinstall to Workspace**: approve the updated scopes (ask a workspace owner if approval is required). Saving scope names alone does not update an already-installed bot token. If Slack issues a different `xoxb-` token, update Railway's **`SLACK_BOT_TOKEN`**. Leave `SLACK_SIGNING_SECRET` unchanged unless you intentionally rotated it.
8. Restart/redeploy Railway with **`SLACK_NATIVE_AI=auto`** (the default). Hard-refresh Slack, then reopen NoBo. Check `/nobo-status`: expect **`scopes-present`**, not `missing-scopes`. This checks actual granted scopes, but cannot attest to your workspace plan or event subscriptions.

No Socket Mode setup, `connections:write` app token, new Slack app, or new Railway service is needed.

## Live acceptance checks

- Open Home: existing dashboard works. Open Messages: Models, Catch up, Research and Dad joke prompts appear.
- Click Dad joke: receive a threaded reply with native Working indicator, then an active session.
- Ask for current AI news: tool cards appear as real tools start/finish, followed by the streamed answer. Cards deliberately omit tool arguments, output and model reasoning.
- Start a longer research reply and click **Stop** as its initiating user. The session leaves Working, generation stops, and no fallback answer/error overwrites the stopped stream. Already-completed external tool actions cannot be undone; an in-flight external request may finish despite cancellation.
- Rename a session: NoBo does not replace the user's title.
- Open NoBo beside a channel and ask which channel you are viewing: same-workspace, policy-allowed location hints can be used. NoBo does not automatically fetch channel history; a current-view hint is not authorization to read or act there.
- Test `/nobo-status`, model selection, a preference modal, a reminder shortcut, a reaction shortcut and a normal channel mention.
- Select an image-capable model and send an image; then select a text-only model and repeat. Existing selected-model/image-fallback routing remains in place.
- Test Muse separately. The pending policy/invalid-parameter fallback fix is included in #22, but switching Slack frameworks does not grant OpenCode's data-training consent or guarantee provider availability.

Automated tests exercise signed Bolt requests, acknowledgements, modals, scoped cancellation, progress, context filtering, permission diagnostics, and a real standalone Bolt/Flue boot using a local fake Slack API. They do not post to Slack or spend model tokens.

## Rollback and limits

Set `SLACK_NATIVE_AI=off` and restart to force legacy reply rendering while keeping Bolt. Slack's `agent_view` migration itself cannot be undone. Model execution still uses Flue; this is a Slack transport/UI migration, not a model-runtime rewrite. Workspace search/MCP, feedback collection, distributed cancellation and resume-across-deploy are not implemented by this stack.

Stop events are checked against NoBo's user/channel/workspace access policy, then stop all NoBo runs in that exact workspace/channel/thread, matching Slack's session semantics (including reaction-triggered work). A process restart loses the in-flight registry; a subsequent Stop still clears the Slack session status, but no work is resumed across the restart. Do not scale beyond one replica without implementing cross-process cancellation. Slack owns pin/archive/title UI; NoBo does not duplicate those controls.

References: [Agent sessions and Stop](https://docs.slack.dev/ai/agent-sessions/), [active-view context](https://docs.slack.dev/ai/agent-context-management/), [Bolt HTTP configuration](https://docs.slack.dev/tools/bolt-js/reference/).
