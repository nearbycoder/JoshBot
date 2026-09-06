import type { App } from "@slack/bolt";
import { evaluateNoboAccess } from "../lib/access-controls.js";
import { stopSlackAgentRuns } from "../lib/slack-agent-runs.js";
import { getSlackAgentReadiness } from "../lib/slack-readiness.js";

export function registerSlackAgentEvents(bolt: App) {
  bolt.event("agent_session_stopped", async ({ event, body, client }) => {
    if (!body.team_id || !(await evaluateNoboAccess({
      userId: event.user, channelId: event.channel, teamId: body.team_id,
      action: event.type, surface: "slack-event"
    })).allowed) return;
    await stopSlackAgentRuns({
      teamId: body.team_id, channelId: event.channel, threadTs: event.thread_ts, userId: event.user
    });
    await client.agents.sessions.setStatus({
      channel_id: event.channel, thread_ts: event.thread_ts, status: "active"
    });
  });
  // Context snapshots arrive on each message.im. Do not cache per-user context:
  // an out-of-order change event must not contaminate a different DM or thread.
  bolt.event("app_context_changed", async () => {});
  // Slack owns session titles. A user rename must not trigger a bot reply.
  bolt.event("agent_session_title_changed", async () => {});
  bolt.event("app_home_opened", async ({ event, body, client }) => {
    if (event.tab !== "messages" || /^(?:0|false|off|legacy)$/i.test(process.env.SLACK_NATIVE_AI?.trim() ?? "")) return;
    if (getSlackAgentReadiness().state === "missing-scopes") return;
    if (!(await evaluateNoboAccess({
      userId: event.user, channelId: event.channel, teamId: body.team_id,
      action: event.type, surface: "slack-event"
    })).allowed) return;
    await client.assistant.threads.setSuggestedPrompts({
      channel_id: event.channel,
      title: "What can NoBo help you with?",
      prompts: [
        { title: "Models", message: "Which models are configured, which model are you using, and which support images?" },
        { title: "Catch up", message: "Summarize the key decisions and open questions in this conversation." },
        { title: "Research", message: "What are the most important AI developments this week? Include sources." },
        { title: "Dad joke", message: "Tell me a great dad joke." }
      ]
    });
  });
}

export async function buildSlackActiveContextHint(raw: unknown, teamId: string, userId: string,
  evaluateAccess = evaluateNoboAccess) {
  if (!raw || typeof raw !== "object" || !("entities" in raw) || !Array.isArray(raw.entities)) return;
  const channels = new Set<string>();
  for (const entity of raw.entities.slice(0, 8)) {
    if (!entity || typeof entity !== "object" || entity.team_id !== teamId) continue;
    const channel = entity.type === "slack#/types/channel_id" ? entity.value :
      entity.type === "slack#/types/message_context" ? entity.value?.channel_id : undefined;
    if (typeof channel !== "string" || !/^[CDG][A-Z0-9]+$/.test(channel)) continue;
    if ((await evaluateAccess({ userId, teamId, channelId: channel,
      action: "agent_context", surface: "slack-event" })).allowed) channels.add(channel);
  }
  if (!channels.size) return;
  return "Slack active-view metadata (a location hint, not message contents or permission to act): " +
    [...channels].map((channel) => `<#${channel}>`).join(", ") +
    ". Do not claim to have read these channels. Use only authorized tools when the user's request calls for it.";
}
