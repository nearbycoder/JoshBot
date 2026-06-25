import { getHackerNewsScheduleStatus } from "./hacker-news-schedule.js";
import { getRecentOpsErrors, summarizeOpsError, type OpsErrorRecord } from "./ops-errors.js";
import { getRedisClient } from "./redis.js";
import { getScheduleRunnerStatus } from "./schedules.js";

const DEFAULT_TEXT_MODEL = "glm-5.2";
const DEFAULT_VISION_MODEL = "kimi-k2.6";
const DEFAULT_REDIS_TIMEOUT_MS = 1000;

export type RedisOpsStatus = {
  configured: boolean;
  state: "ok" | "missing" | "error";
  detail: string;
  latencyMs?: number;
};

export type OpsStatus = {
  generatedAt: string;
  redis: RedisOpsStatus;
  scheduler: ReturnType<typeof getScheduleRunnerStatus>;
  hackerNewsSchedule: ReturnType<typeof getHackerNewsScheduleStatus>;
  slack: {
    botToken: boolean;
    signingSecret: boolean;
    botUserId: boolean;
  };
  modelSearch: {
    apiKey: boolean;
    textModel: string;
    visionModel: string;
    searchEnabled: boolean;
  };
  recentErrors: OpsErrorRecord[];
};

type CollectOpsStatusOptions = {
  redisTimeoutMs?: number;
  checkRedis?: () => Promise<RedisOpsStatus>;
  getScheduler?: () => OpsStatus["scheduler"];
  getHackerNewsScheduler?: () => OpsStatus["hackerNewsSchedule"];
  getRecentErrors?: () => OpsErrorRecord[];
};

export async function collectOpsStatus(options: CollectOpsStatusOptions = {}): Promise<OpsStatus> {
  return {
    generatedAt: new Date().toISOString(),
    redis: await (options.checkRedis ?? (() => checkRedisHealth(options.redisTimeoutMs)))(),
    scheduler: (options.getScheduler ?? getScheduleRunnerStatus)(),
    hackerNewsSchedule: (options.getHackerNewsScheduler ?? getHackerNewsScheduleStatus)(),
    slack: {
      botToken: hasEnv("SLACK_BOT_TOKEN"),
      signingSecret: hasEnv("SLACK_SIGNING_SECRET"),
      botUserId: hasEnv("SLACK_BOT_USER_ID")
    },
    modelSearch: {
      apiKey: hasEnv("OPENCODE_GO_API_KEY"),
      textModel: process.env.OPENCODE_GO_MODEL?.trim() || DEFAULT_TEXT_MODEL,
      visionModel: process.env.OPENCODE_GO_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL,
      searchEnabled: hasEnv("EXA_API_KEY")
    },
    recentErrors: (options.getRecentErrors ?? (() => getRecentOpsErrors(5)))()
  };
}

export async function formatNoboOpsStatus(options: CollectOpsStatusOptions = {}) {
  return formatOpsStatus(await collectOpsStatus(options));
}

export function formatOpsStatus(status: OpsStatus) {
  const lines = [
    "*NoBo status*",
    `Generated: ${status.generatedAt}`,
    `Redis: ${formatRedisStatus(status.redis)}`,
    `Scheduler: ${status.scheduler.started ? "started" : "not started"}, ${
      status.scheduler.running ? "running" : "idle"
    }, interval ${status.scheduler.intervalMs}ms, Redis ${status.scheduler.redisConfigured ? "configured" : "missing"}`,
    `Hacker News schedule: ${formatHackerNewsScheduleStatus(status.hackerNewsSchedule)}`,
    `Slack config: token ${present(status.slack.botToken)}, signing secret ${present(
      status.slack.signingSecret
    )}, bot user ${present(status.slack.botUserId)}`,
    `Model/search: API key ${present(status.modelSearch.apiKey)}, text model \`${status.modelSearch.textModel}\`, vision model \`${status.modelSearch.visionModel}\`, web search ${
      status.modelSearch.searchEnabled ? "enabled" : "disabled"
    }`,
    "*Recent errors*",
    ...formatRecentErrors(status.recentErrors)
  ];

  return lines.join("\n");
}

async function checkRedisHealth(timeoutMs = DEFAULT_REDIS_TIMEOUT_MS): Promise<RedisOpsStatus> {
  if (!process.env.REDIS_URL) {
    return {
      configured: false,
      state: "missing",
      detail: "REDIS_URL not set"
    };
  }

  const startedAt = Date.now();

  try {
    const redis = await withTimeout(getRedisClient(), timeoutMs, "Redis connection timed out");

    if (!redis) {
      return {
        configured: false,
        state: "missing",
        detail: "REDIS_URL not set"
      };
    }

    await withTimeout(redis.ping(), timeoutMs, "Redis ping timed out");

    return {
      configured: true,
      state: "ok",
      detail: "PING ok",
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      configured: true,
      state: "error",
      detail: summarizeOpsError(error),
      latencyMs: Date.now() - startedAt
    };
  }
}

function formatRedisStatus(status: RedisOpsStatus) {
  if (status.state === "missing") {
    return `missing (${status.detail})`;
  }

  const latency = status.latencyMs === undefined ? "" : `, ${status.latencyMs}ms`;
  return `${status.state} (${status.detail}${latency})`;
}

function formatHackerNewsScheduleStatus(status: OpsStatus["hackerNewsSchedule"]) {
  if (status.disabled) {
    return "disabled";
  }

  const state = status.started ? "started" : "not started";
  const target = status.channelIdConfigured ? "channel ID configured" : `channel #${status.channelName}`;
  return `${state}, ${status.times.join(", ")}, ${target}`;
}

function formatRecentErrors(errors: OpsErrorRecord[]) {
  if (errors.length === 0) {
    return ["none recorded"];
  }

  return errors.map((error) => `- ${error.at} ${error.source}: ${error.message}`);
}

function present(value: boolean) {
  return value ? "present" : "missing";
}

function hasEnv(name: string) {
  return Boolean(process.env[name]?.trim());
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs).unref();
    })
  ]);
}
