import { config as loadEnv } from "dotenv";
import { Hono } from "hono";
import { handleArtifactFetchRequest } from "../lib/artifacts.js";
import {
  createConditionalMonitorCheck,
  createScheduledSlackMessage,
  createWeeklyAiNewsSlackDigest,
  createWeeklyNewsSlackDigest
} from "../lib/ai.js";
import { startChannelDigestSubscriptionRunner } from "../lib/channel-digests.js";
import { createHackerNewsSlackDigest } from "../lib/hacker-news.js";
import { requireEnv } from "../lib/env.js";
import { startHackerNewsSchedule } from "../lib/hacker-news-schedule.js";
import { recordOpsError } from "../lib/ops-errors.js";
import { readLimitedRequestBody, RequestBodyTooLargeError } from "../lib/request-body.js";
import {
  handleSlackInteractionRequest,
  handleSlackSlashCommandPayload,
  parseSlackInteractionPayload,
  parseSlackSlashCommandPayload,
  type SlackSlashCommandPayload,
  type SlackSlashCommandTask
} from "../lib/slack-commands.js";
import { handleSlackEventCallbackPayload, parseSlackPayload } from "../lib/slack-events.js";
import { openSlackModal, postGeneratedSlackMessage, postSlackMessage, verifySlackRequest } from "../lib/slack.js";
import { appendChannelMemory, type ChannelMemoryEntry } from "../lib/memory.js";
import { startMonitorRunner } from "../lib/monitors.js";
import { getPreferredNewsFocus, getUserPreferences } from "../lib/preferences.js";
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
  const rawBody = await readSlackRequestBody(c.req.raw);
  if (rawBody instanceof Response) {
    return rawBody;
  }

  if (!verifySlackRequest(rawBody, c.req.raw.headers)) {
    return c.text("Invalid Slack signature", 401);
  }

  const payload = parseSlackPayload(rawBody);

  if (payload.type === "url_verification") {
    return c.text(payload.challenge);
  }

  if (!c.req.header("x-slack-retry-num")) {
    void handleSlackEventCallbackPayload(payload).catch((error) => {
      recordOpsError("slack event", error);
      console.error(`Slack event handling failed: ${summarizeError(error)}`);
    });
  }

  return c.json({ ok: true });
});

app.post("/api/slack/commands", async (c) => {
  const rawBody = await readSlackRequestBody(c.req.raw);
  if (rawBody instanceof Response) {
    return rawBody;
  }

  if (!verifySlackRequest(rawBody, c.req.raw.headers)) {
    return c.text("Invalid Slack signature", 401);
  }

  try {
    const payload = parseSlackSlashCommandPayload(rawBody);
    const result = await handleSlackSlashCommandPayload(payload);

    if (result.modal) {
      await openSlackModal({
        token: requireEnv("SLACK_BOT_TOKEN"),
        triggerId: result.modal.triggerId,
        view: result.modal.view
      });
    }

    if (result.task) {
      void runSlackSlashCommandTask(result.task, formatSlackSlashCommandMemory(payload)).catch((error) => {
        recordOpsError("slack slash command task", error);
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

app.post("/api/slack/interactions", async (c) => {
  const rawBody = await readSlackRequestBody(c.req.raw);
  if (rawBody instanceof Response) {
    return rawBody;
  }

  if (!verifySlackRequest(rawBody, c.req.raw.headers)) {
    return c.text("Invalid Slack signature", 401);
  }

  try {
    const payload = parseSlackInteractionPayload(rawBody);
    const result = await handleSlackInteractionRequest(payload);

    if (result.modal) {
      await openSlackModal({
        token: requireEnv("SLACK_BOT_TOKEN"),
        triggerId: result.modal.triggerId,
        view: result.modal.view
      });
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
startMonitorRunner({
  postSlackMessage,
  runMonitorCheck: createConditionalMonitorCheck
});
startChannelDigestSubscriptionRunner({
  postGeneratedSlackMessage
});
startHackerNewsSchedule();

async function runSlackSlashCommandTask(task: SlackSlashCommandTask, commandText: string) {
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

async function readSlackRequestBody(request: Request) {
  try {
    return await readLimitedRequestBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return new Response("Slack request body is too large.", {
        status: 413,
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      });
    }

    throw error;
  }
}

export default app;
