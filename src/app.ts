import { config as loadEnv } from "dotenv";
import { Hono } from "hono";
import { handleArtifactFetchRequest } from "../lib/artifacts.js";
import {
  createScheduledSlackMessage,
  createWeeklyAiNewsSlackDigest,
  createWeeklyNewsSlackDigest
} from "../lib/ai.js";
import { createHackerNewsSlackDigest } from "../lib/hacker-news.js";
import { startHackerNewsSchedule } from "../lib/hacker-news-schedule.js";
import {
  handleSlackSlashCommandPayload,
  parseSlackSlashCommandPayload,
  type SlackSlashCommandPayload,
  type SlackSlashCommandTask
} from "../lib/slack-commands.js";
import { handleSlackEventCallbackPayload, parseSlackPayload } from "../lib/slack-events.js";
import { postGeneratedSlackMessage, postSlackMessage, verifySlackRequest } from "../lib/slack.js";
import { appendChannelMemory, type ChannelMemoryEntry } from "../lib/memory.js";
import { startScheduleRunner } from "../lib/schedules.js";
import { flueApp } from "./internal-flue.js";
import { registerNoboProvider } from "./nobo-provider.js";

loadEnv({ path: ".env.local" });
loadEnv();
registerNoboProvider();

const app = new Hono();

app.get("/", (c) =>
  c.json({
    ok: true,
    service: "nobo",
    status: "running"
  })
);

app.get("/healthz", (c) =>
  c.json({
    ok: true,
    service: "nobo",
    status: "running"
  })
);

app.all("/artifacts/*", async (c) => {
  const response = await handleArtifactFetchRequest(c.req.raw);
  return response ?? c.notFound();
});

app.post("/api/slack/events", async (c) => {
  const rawBody = await c.req.text();

  if (!verifySlackRequest(rawBody, c.req.raw.headers)) {
    return c.text("Invalid Slack signature", 401);
  }

  const payload = parseSlackPayload(rawBody);

  if (payload.type === "url_verification") {
    return c.text(payload.challenge);
  }

  if (!c.req.header("x-slack-retry-num")) {
    void handleSlackEventCallbackPayload(payload).catch((error) => {
      console.error(`Slack event handling failed: ${summarizeError(error)}`);
    });
  }

  return c.json({ ok: true });
});

app.post("/api/slack/commands", async (c) => {
  const rawBody = await c.req.text();

  if (!verifySlackRequest(rawBody, c.req.raw.headers)) {
    return c.text("Invalid Slack signature", 401);
  }

  try {
    const payload = parseSlackSlashCommandPayload(rawBody);
    const result = await handleSlackSlashCommandPayload(payload);

    if (result.task) {
      void runSlackSlashCommandTask(result.task, formatSlackSlashCommandMemory(payload)).catch((error) => {
        console.error(`Slack slash command task failed: ${summarizeError(error)}`);
      });
    } else if (payload.channel_id && result.response.response_type === "in_channel") {
      void recordSlackSlashCommandExchange(payload, result.response.text);
    }

    return c.json(result.response);
  } catch (error) {
    return c.text(summarizeError(error), 400);
  }
});

app.route("/", flueApp);

startScheduleRunner({
  postSlackMessage,
  runScheduledTask: createScheduledSlackMessage
});
startHackerNewsSchedule();

async function runSlackSlashCommandTask(task: SlackSlashCommandTask, commandText: string) {
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
            focus: task.focus,
            currentUserId: task.userId,
            onTextDelta
          })
      });
      return;
    case "news":
      await postGeneratedSlackMessage({
        channel: task.channelId,
        createReply: (onTextDelta) =>
          createWeeklyNewsSlackDigest({
            focus: task.focus,
            currentUserId: task.userId,
            onTextDelta
          })
      });
      return;
    case "hacker-news":
      await postGeneratedSlackMessage({
        channel: task.channelId,
        createReply: () =>
          createHackerNewsSlackDigest({
            focus: task.focus
          })
      });
      return;
  }
}

async function recordSlackSlashCommandExchange(
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

function formatSlackSlashCommandMemory(payload: SlackSlashCommandPayload) {
  const text = payload.text.trim();
  return text ? `${payload.command} ${text}` : payload.command;
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

export default app;
