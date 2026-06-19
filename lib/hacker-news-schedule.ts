import { Cron } from "croner";
import { createHackerNewsSlackDigest } from "./hacker-news.js";
import { requireEnv } from "./env.js";
import { postGeneratedSlackMessage, resolveSlackChannelIdByName } from "./slack.js";

const DEFAULT_HACKER_NEWS_CHANNEL_NAME = "hacker-news";
const DEFAULT_HACKER_NEWS_SCHEDULE_TIMES = ["09:00", "14:00"];
const HACKER_NEWS_SCHEDULE_TIMEZONE = "America/Chicago";

let hackerNewsScheduleStarted = false;
let resolvedChannelIdPromise: Promise<string | null> | null = null;

export function startHackerNewsSchedule() {
  if (hackerNewsScheduleStarted) {
    return;
  }

  hackerNewsScheduleStarted = true;

  if (isHackerNewsScheduleDisabled()) {
    return;
  }

  for (const time of getHackerNewsScheduleTimes()) {
    const cronExpression = timeToCronExpression(time);

    new Cron(
      cronExpression,
      {
        protect: true,
        timezone: HACKER_NEWS_SCHEDULE_TIMEZONE,
        catch: (error) => {
          console.error(`Scheduled Hacker News post failed: ${summarizeError(error)}`);
        }
      },
      async () => {
        await postScheduledHackerNewsDigest();
      }
    );
  }
}

async function postScheduledHackerNewsDigest() {
  const channel = await resolveHackerNewsChannelId();

  if (!channel) {
    console.warn(
      "Skipping scheduled Hacker News post because #hacker-news could not be resolved. Set NOBO_HACKER_NEWS_CHANNEL_ID or grant channels:read."
    );
    return;
  }

  await postGeneratedSlackMessage({
    channel,
    createReply: () =>
      createHackerNewsSlackDigest({
        focus: getHackerNewsScheduleFocus()
      })
  });
}

async function resolveHackerNewsChannelId() {
  const configuredChannelId = normalizeSlackChannelId(process.env.NOBO_HACKER_NEWS_CHANNEL_ID);

  if (configuredChannelId) {
    return configuredChannelId;
  }

  if (!resolvedChannelIdPromise) {
    resolvedChannelIdPromise = resolveSlackChannelIdByName({
      token: requireEnv("SLACK_BOT_TOKEN"),
      name: getHackerNewsChannelName()
    }).catch((error) => {
      resolvedChannelIdPromise = null;
      throw error;
    });
  }

  const resolvedChannelId = await resolvedChannelIdPromise;

  if (!resolvedChannelId) {
    resolvedChannelIdPromise = null;
  }

  return resolvedChannelId;
}

function isHackerNewsScheduleDisabled() {
  return /^(0|false|off|disabled)$/i.test(process.env.NOBO_HACKER_NEWS_SCHEDULE ?? "");
}

function getHackerNewsChannelName() {
  return (
    process.env.NOBO_HACKER_NEWS_CHANNEL_NAME?.trim().replace(/^#/, "") ||
    DEFAULT_HACKER_NEWS_CHANNEL_NAME
  );
}

function getHackerNewsScheduleFocus() {
  return process.env.NOBO_HACKER_NEWS_FOCUS?.trim() ?? "";
}

function getHackerNewsScheduleTimes() {
  const rawTimes = process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES;

  if (!rawTimes) {
    return DEFAULT_HACKER_NEWS_SCHEDULE_TIMES;
  }

  const times = rawTimes
    .split(",")
    .map((time) => time.trim())
    .filter(Boolean);

  return times.length > 0 ? times : DEFAULT_HACKER_NEWS_SCHEDULE_TIMES;
}

function timeToCronExpression(time: string) {
  const match = time.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);

  if (!match) {
    throw new Error(`Invalid Hacker News schedule time: ${time}. Use HH:mm, such as 09:00.`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  return `${minute} ${hour} * * *`;
}

function normalizeSlackChannelId(input: string | undefined) {
  if (!input) {
    return null;
  }

  const match = input.trim().match(/#?(C[A-Z0-9]+|G[A-Z0-9]+)/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

export const __testing = {
  getHackerNewsScheduleTimes,
  timeToCronExpression
};
