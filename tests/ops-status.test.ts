import assert from "node:assert/strict";
import test from "node:test";
import { formatNoboOpsStatus } from "../lib/ops-status.js";
import { summarizeOpsError } from "../lib/ops-errors.js";

test("formats ops status without exposing secrets", async () => {
  const originalEnv = snapshotEnv([
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "SLACK_BOT_USER_ID",
    "OPENCODE_GO_API_KEY",
    "OPENCODE_GO_MODEL",
    "OPENCODE_GO_VISION_MODEL",
    "EXA_API_KEY"
  ]);

  process.env.SLACK_BOT_TOKEN = "xoxb-secret-token";
  process.env.SLACK_SIGNING_SECRET = "signing-secret";
  process.env.SLACK_BOT_USER_ID = "U123";
  process.env.OPENCODE_GO_API_KEY = "opencode-secret-key";
  process.env.OPENCODE_GO_MODEL = "deepseek-v4-pro";
  process.env.OPENCODE_GO_VISION_MODEL = "kimi-k2.7-code";
  process.env.EXA_API_KEY = "exa-secret-key";

  try {
    const text = await formatNoboOpsStatus({
      checkRedis: async () => ({
        configured: true,
        state: "ok",
        detail: "PING ok",
        latencyMs: 3
      }),
      getScheduler: () => ({
        started: true,
        running: false,
        intervalMs: 30000,
        redisConfigured: true
      }),
      getMonitors: () => ({
        started: true,
        running: false,
        intervalMs: 30000,
        redisConfigured: true
      }),
      getHackerNewsScheduler: () => ({
        started: true,
        disabled: false,
        times: ["09:00", "14:00"],
        channelIdConfigured: false,
        channelName: "hacker-news"
      }),
      getRecentErrors: () => [
        {
          at: "2026-06-25T12:00:00.000Z",
          source: "test",
          message: "boom"
        }
      ]
    });

    assert.match(text, /Redis: ok \(PING ok, 3ms\)/);
    assert.match(text, /Scheduler: started, idle/);
    assert.match(text, /Monitors: started, idle/);
    assert.match(text, /Slack config: token present, signing secret present, bot user present/);
    assert.match(text, /Model\/search: API key present, default model `deepseek-v4-pro`, image fallback `kimi-k2.7-code`, web search enabled/);
    assert.match(text, /test: boom/);
    assert.doesNotMatch(text, /xoxb-secret-token|signing-secret|opencode-secret-key|exa-secret-key/);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("ops error summaries mask sensitive env values", () => {
  const originalEnv = snapshotEnv(["REDIS_URL"]);
  process.env.REDIS_URL = "redis://user:redis-secret@example.com:6379";

  try {
    const summary = summarizeOpsError(new Error(`Failed ${process.env.REDIS_URL}`));
    assert.doesNotMatch(summary, /redis-secret/);
    assert.match(summary, /\[hidden\]/);
  } finally {
    restoreEnv(originalEnv);
  }
});

function snapshotEnv(names: string[]) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>) {
  for (const [name, value] of snapshot) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
