import { createConditionalMonitorCheck, createScheduledSlackMessage, createWeeklyAiNewsSlackDigest, createWeeklyNewsSlackDigest } from "../lib/ai.js";
import { startChannelDigestSubscriptionRunner } from "../lib/channel-digests.js";
import { createHackerNewsSlackDigest } from "../lib/hacker-news.js";
import { startHackerNewsSchedule } from "../lib/hacker-news-schedule.js";
import type { SlackSlashCommandPayload, SlackSlashCommandTask } from "../lib/slack-commands.js";
import { postGeneratedSlackMessage, postSlackMessage } from "../lib/slack.js";
import { appendChannelMemory, type ChannelMemoryEntry } from "../lib/memory.js";
import { startMonitorRunner } from "../lib/monitors.js";
import { getPreferredNewsFocus, getUserPreferences } from "../lib/preferences.js";
import { startScheduleRunner } from "../lib/schedules.js";

export function startBackgroundRunners() {
  startScheduleRunner({ postSlackMessage, runScheduledTask: createScheduledSlackMessage });
  startMonitorRunner({ postSlackMessage, runMonitorCheck: createConditionalMonitorCheck });
  startChannelDigestSubscriptionRunner({ postGeneratedSlackMessage });
  startHackerNewsSchedule();
}

export async function runSlackSlashCommandTask(task: SlackSlashCommandTask, commandText: string) {
  const preferences = await getUserPreferences(task.userId);
  const focus = task.focus || getPreferredNewsFocus(preferences);

  await recordAppChannelMemory(task.channelId, {
    role: "user",
    content: commandText,
    userId: task.userId
  });

  switch (task.type) {
    case "ai-news":
      await postGeneratedSlackMessage({
        channel: task.channelId,
        createReply: (onTextDelta) =>
          createWeeklyAiNewsSlackDigest({
            focus,
            currentUserId: task.userId,
            channelId: task.channelId,
            onTextDelta
          })
      });
      return;
    case "news":
      await postGeneratedSlackMessage({
        channel: task.channelId,
        createReply: (onTextDelta) =>
          createWeeklyNewsSlackDigest({
            focus,
            currentUserId: task.userId,
            channelId: task.channelId,
            onTextDelta
          })
      });
      return;
    case "hacker-news":
      await postGeneratedSlackMessage({
        channel: task.channelId,
        createReply: () =>
          createHackerNewsSlackDigest({
            focus
          })
      });
      return;
  }
}

export async function recordSlackSlashCommandExchange(
  payload: SlackSlashCommandPayload,
  assistantText: string
) {
  if (!payload.channel_id) {
    return;
  }

  await recordAppChannelMemory(payload.channel_id, {
    role: "user",
    content: formatSlackSlashCommandMemory(payload),
    userId: payload.user_id
  });
  await recordAppChannelMemory(payload.channel_id, {
    role: "assistant",
    content: assistantText
  });
}

async function recordAppChannelMemory(channel: string, entry: ChannelMemoryEntry) {
  try {
    await appendChannelMemory(channel, entry);
  } catch (error) {
    console.warn(`Unable to append app Slack channel memory: ${summarizeError(error)}`);
  }
}

export function formatSlackSlashCommandMemory(payload: SlackSlashCommandPayload) {
  const text = payload.text.trim();
  return text ? `${payload.command} ${text}` : payload.command;
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}
