import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createArtifact } from "../lib/artifacts.js";
import {
  handleSlackInteractionPayload,
  handleSlackSlashCommandPayload,
  parseSlackInteractionPayload,
  parseSlackSlashCommandPayload
} from "../lib/slack-commands.js";
import { __testing as modelTesting } from "../lib/nobo-models.js";

test("parses Slack slash command payloads", () => {
  const payload = parseSlackSlashCommandPayload(
    "command=%2Fnobo-help&text=help&user_id=U123&channel_id=C123&team_id=T123"
  );

  assert.equal(payload.command, "/nobo-help");
  assert.equal(payload.text, "help");
  assert.equal(payload.user_id, "U123");
  assert.equal(payload.channel_id, "C123");
  assert.equal(payload.team_id, "T123");
});

test("returns ephemeral help for /nobo-help", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-help",
    text: ""
  });

  const { response } = result;
  assert.equal(response.response_type, "ephemeral");
  assert.equal(response.mrkdwn, true);
  assert.match(response.text, /`\/nobo-help`/);
  assert.match(response.text, /`\/nobo-status`/);
  assert.match(response.text, /`\/nobo-listen \[on\|off\|status\]`/);
  assert.match(response.text, /`\/nobo-prefs \[setting\]`/);
  assert.match(response.text, /`\/nobo-memory \[show\|forget <number\|text>\|clear confirm\]`/);
  assert.match(response.text, /`\/nobo-artifacts \[list\|delete <id>\|cleanup\]`/);
  assert.match(response.text, /`\/nobo-decisions \[add <decision>\|list\]`/);
  assert.match(response.text, /`\/nobo-news \[focus\]`/);
  assert.match(response.text, /`\/nobo-hacker-news \[focus\]`/);
  assert.match(response.text, /`\/nobo-ai-news \[focus\]`/);
  assert.match(response.text, /`\/nobo-channel-digest daily\|weekly/);
  assert.match(response.text, /`\/nobo-channel-model`/);
  assert.match(response.text, /`\/nobo-dad-joke`/);
  assert.match(response.text, /@NoBo follow-ups/);
  assert.match(response.text, /@NoBo web-search/);
});

test("returns ephemeral ops status for /nobo-status", async () => {
  const result = await handleSlackSlashCommandPayload(
    {
      command: "/nobo-status",
      text: ""
    },
    {
      formatOpsStatus: async () => "*NoBo status*\nRedis: ok"
    }
  );

  assert.equal(result.response.response_type, "ephemeral");
  assert.equal(result.response.mrkdwn, true);
  assert.match(result.response.text, /NoBo status/);
  assert.match(result.response.text, /Redis: ok/);
  assert.equal(result.task, undefined);
});

test("returns personal preferences for /nobo-prefs", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-prefs",
    text: "",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /Your NoBo preferences/);
  assert.match(result.response.text, /Timezone: `America\/Chicago`/);
});

test("reports Redis requirement for /nobo-prefs update without Redis", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-prefs",
    text: "timezone America/New_York",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /Redis is not configured/);
});

test("lists artifacts for /nobo-artifacts", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "markdown",
      title: "Plan",
      content: "hello"
    });
    const result = await handleSlackSlashCommandPayload({
      command: "/nobo-artifacts",
      text: "list"
    });

    assert.equal(result.response.response_type, "ephemeral");
    assert.match(result.response.text, /\*Artifacts\*/);
    assert.match(result.response.text, new RegExp(artifact.id.slice(0, 8)));
    assert.match(result.response.text, /preview/);
  });
});

test("deletes artifacts for /nobo-artifacts", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "html",
      title: "Temporary page",
      content: "<!doctype html><title>Temp</title>"
    });
    const result = await handleSlackSlashCommandPayload({
      command: "/nobo-artifacts",
      text: `delete ${artifact.id.slice(0, 8)}`
    });

    assert.equal(result.response.response_type, "ephemeral");
    assert.match(result.response.text, /Deleted artifact/);

    const listResult = await handleSlackSlashCommandPayload({
      command: "/nobo-artifacts",
      text: "list all"
    });

    assert.match(listResult.response.text, /No artifacts found/);
  });
});

test("points unknown /nobo-help slash command text at help", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-help",
    text: "dance"
  });

  const { response } = result;
  assert.equal(response.response_type, "ephemeral");
  assert.match(response.text, /don't recognize/);
  assert.match(response.text, /`\/nobo-help`/);
});

test("returns channel memory status for /nobo-memory", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-memory",
    text: "",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.equal(result.response.text, "Shared channel memory is empty. Active listening: off.");
});

test("requires confirmation for /nobo-memory clear", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-memory",
    text: "clear",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /clear confirm/);
});

test("returns active listening status for /nobo-listen status", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-listen",
    text: "status",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /Active listening is off/);
});

test("reports Redis requirement for /nobo-listen toggle without Redis", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-listen",
    text: "",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /Redis is not configured/);
});

test("returns decision log help for /nobo-decisions help", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-decisions",
    text: "help",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /NoBo decision log/);
  assert.match(result.response.text, /`\/nobo-decisions add <decision>`/);
});

test("reports Redis requirement for /nobo-decisions list without Redis", async () => {
  const originalRedisUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;

  try {
    const result = await handleSlackSlashCommandPayload({
      command: "/nobo-decisions",
      text: "list",
      channel_id: "C123",
      user_id: "U123"
    });

    assert.equal(result.response.response_type, "ephemeral");
    assert.match(result.response.text, /Redis is not configured/);
  } finally {
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  }
});

test("reports Redis requirement for /nobo-decisions add without Redis", async () => {
  const originalRedisUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;

  try {
    const result = await handleSlackSlashCommandPayload({
      command: "/nobo-decisions",
      text: "add Use Redis for the decision log",
      channel_id: "C123",
      user_id: "U123"
    });

    assert.equal(result.response.response_type, "ephemeral");
    assert.match(result.response.text, /Redis is not configured/);
  } finally {
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  }
});

test("starts an async AI news task for /nobo-ai-news", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-ai-news",
    text: "open source models",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /Pulling this week's AI news/);
  assert.deepEqual(result.task, {
    type: "ai-news",
    channelId: "C123",
    userId: "U123",
    focus: "open source models"
  });
});

test("returns usage help for /nobo-ai-news help", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-ai-news",
    text: "help",
    channel_id: "C123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /`\/nobo-ai-news`/);
  assert.equal(result.task, undefined);
});

test("starts an async news task for /nobo-news", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-news",
    text: "markets",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /Pulling this week's news/);
  assert.deepEqual(result.task, {
    type: "news",
    channelId: "C123",
    userId: "U123",
    focus: "markets"
  });
});

test("returns usage help for /nobo-news help", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-news",
    text: "help",
    channel_id: "C123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /`\/nobo-news`/);
  assert.equal(result.task, undefined);
});

test("starts an async Hacker News task for /nobo-hacker-news", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-hacker-news",
    text: "rust",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /Pulling top trending Hacker News stories matching "rust"/);
  assert.deepEqual(result.task, {
    type: "hacker-news",
    channelId: "C123",
    userId: "U123",
    focus: "rust"
  });
});

test("returns usage help for /nobo-hacker-news help", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-hacker-news",
    text: "help",
    channel_id: "C123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /`\/nobo-hacker-news`/);
  assert.equal(result.task, undefined);
});

test("returns an in-channel dad joke for /nobo-dad-joke", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-dad-joke",
    text: "",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "in_channel");
  assert.equal(result.response.mrkdwn, true);
  assert.match(result.response.text, /^\*Dad joke:\* .+/);
  assert.equal(result.task, undefined);
});

test("returns usage help for /nobo-channel-digest help", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-channel-digest",
    text: "help",
    channel_id: "C123",
    user_id: "U123"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /`\/nobo-channel-digest daily 09:00 \[focus\]`/);
  assert.match(result.response.text, /`\/nobo-channel-digest cancel <id>`/);
});

test("reports Redis requirement for /nobo-channel-digest subscription without Redis", async () => {
  const originalRedisUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;

  try {
    const result = await handleSlackSlashCommandPayload({
      command: "/nobo-channel-digest",
      text: "daily 09:00 launch blockers",
      channel_id: "C123",
      user_id: "U123"
    });

    assert.equal(result.response.response_type, "ephemeral");
    assert.match(result.response.text, /Channel digest subscriptions require REDIS_URL/);
  } finally {
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  }
});

test("returns Block Kit selector for /nobo-channel-model", async () => {
  await withMockOpenCodeModels(async () => {
    const result = await handleSlackSlashCommandPayload({
      command: "/nobo-channel-model",
      text: "",
      channel_id: "C123",
      user_id: "U123"
    });

    assert.equal(result.response.response_type, "ephemeral");
    assert.match(result.response.text, /Current: `glm-5.2`/);
    assert.ok(result.response.blocks);
    assert.match(JSON.stringify(result.response.blocks), /static_select/);
    assert.match(JSON.stringify(result.response.blocks), /nobo_channel_model_select/);
    assert.match(JSON.stringify(result.response.blocks), /deepseek-v4-pro/);
  });
});

test("parses Slack interaction payloads", () => {
  const payload = parseSlackInteractionPayload(
    `payload=${encodeURIComponent(JSON.stringify({
      type: "block_actions",
      channel: { id: "C123" },
      actions: [
        {
          action_id: "nobo_channel_model_select",
          selected_option: { value: "glm-5.1" }
        }
      ]
    }))}`
  );

  assert.equal(payload.type, "block_actions");
  assert.equal(payload.channel?.id, "C123");
  assert.equal(payload.actions?.[0]?.selected_option?.value, "glm-5.1");
});

test("reports Redis requirement when channel model interaction saves without Redis", async () => {
  const result = await handleSlackInteractionPayload({
    type: "block_actions",
    channel: { id: "C123" },
    actions: [
      {
        action_id: "nobo_channel_model_select",
        selected_option: { value: "glm-5.1" }
      }
    ]
  });

  assert.equal(result.response_type, "ephemeral");
  assert.match(result.text, /Redis is not configured/);
});

async function withTempArtifactDir(run: () => Promise<void>) {
  const previousDir = process.env.ARTIFACT_DIR;
  const previousBaseUrl = process.env.ARTIFACT_BASE_URL;
  const previousTtlDays = process.env.ARTIFACT_TTL_DAYS;
  const artifactDir = await mkdtemp(path.join(tmpdir(), "nobo-slack-artifacts-"));

  process.env.ARTIFACT_DIR = artifactDir;
  process.env.ARTIFACT_BASE_URL = "https://nobo.test";
  delete process.env.ARTIFACT_TTL_DAYS;

  try {
    await run();
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    restoreEnv("ARTIFACT_DIR", previousDir);
    restoreEnv("ARTIFACT_BASE_URL", previousBaseUrl);
    restoreEnv("ARTIFACT_TTL_DAYS", previousTtlDays);
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

async function withMockOpenCodeModels(run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  modelTesting.clearModelCache();

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        object: "list",
        data: [
          { id: "glm-5.2", object: "model" },
          { id: "deepseek-v4-pro", object: "model" }
        ]
      }),
      {
        headers: {
          "content-type": "application/json"
        }
      }
    );

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    modelTesting.clearModelCache();
  }
}
