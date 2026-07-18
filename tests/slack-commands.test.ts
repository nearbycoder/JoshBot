import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createArtifact, listArtifacts } from "../lib/artifacts.js";
import {
  handleSlackInteractionRequest,
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
  assert.match(response.text, /`\/nobo-search <query>`/);
  assert.match(response.text, /`\/nobo-admin`/);
  assert.match(response.text, /`\/nobo-listen \[on\|off\|status\]`/);
  assert.match(response.text, /`\/nobo-prefs \[setting\]`/);
  assert.match(response.text, /`\/nobo-memory \[show\|forget <number\|text>\|clear confirm\]`/);
  assert.match(response.text, /`\/nobo-artifacts \[list\|update <id> <content>\|versions <id>\|diff <id>\|rollback <id>\|delete <id>\|cleanup\]`/);
  assert.match(response.text, /`\/nobo-decisions \[add <decision>\|list\]`/);
  assert.match(response.text, /`\/nobo-issues \[github\|linear\|both\] \[create\] <follow-up bullets>`/);
  assert.match(response.text, /`\/nobo-polls \[create\|list\|vote\|results\|close\]`/);
  assert.match(response.text, /`\/nobo-news \[focus\]`/);
  assert.match(response.text, /`\/nobo-hacker-news \[focus\]`/);
  assert.match(response.text, /`\/nobo-ai-news \[focus\]`/);
  assert.match(response.text, /`\/nobo-channel-digest daily\|weekly/);
  assert.match(response.text, /`\/nobo-channel-model`/);
  assert.match(response.text, /`\/nobo-dad-joke`/);
  assert.match(response.text, /@NoBo follow-ups/);
  assert.match(response.text, /@NoBo issues/);
  assert.match(response.text, /@NoBo web-search/);
});

test("blocks slash commands when access controls deny them", async () => {
  const result = await handleSlackSlashCommandPayload(
    {
      command: "/nobo-dad-joke",
      text: "",
      user_id: "U123",
      channel_id: "C123"
    },
    {
      evaluateAccess: async () => ({
        allowed: false,
        reason: "Channel `C123` is denied."
      })
    }
  );

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /access denied/i);
  assert.match(result.response.text, /C123/);
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

test("does not gate /nobo-status behind access controls", async () => {
  const result = await handleSlackSlashCommandPayload(
    {
      command: "/nobo-status",
      text: "",
      user_id: "U123",
      channel_id: "C123"
    },
    {
      formatOpsStatus: async () => "*NoBo status*\nRedis: ok",
      evaluateAccess: async () => {
        throw new Error("status should not check access controls");
      }
    }
  );

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /Redis: ok/);
});

test("lets bootstrap admins list controls even when channel would be denied", async () => {
  const originalAdminUsers = process.env.NOBO_ADMIN_USER_IDS;
  const originalRedisUrl = process.env.REDIS_URL;
  process.env.NOBO_ADMIN_USER_IDS = "UADMIN";
  delete process.env.REDIS_URL;

  try {
    const result = await handleSlackSlashCommandPayload(
      {
        command: "/nobo-admin",
        text: "list",
        user_id: "UADMIN",
        channel_id: "C123"
      },
      {
        evaluateAccess: async () => ({
          allowed: false,
          reason: "Channel `C123` is denied."
        })
      }
    );

    assert.equal(result.response.response_type, "ephemeral");
    assert.match(result.response.text, /NoBo admin controls/);
    assert.match(result.response.text, /UADMIN/);
  } finally {
    restoreEnv("NOBO_ADMIN_USER_IDS", originalAdminUsers);
    restoreEnv("REDIS_URL", originalRedisUrl);
  }
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

test("opens preferences modal for /nobo-prefs with a trigger", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-prefs",
    text: "",
    user_id: "U123",
    channel_id: "C123",
    trigger_id: "trigger-123"
  });

  assert.equal(result.modal?.triggerId, "trigger-123");
  assert.match(JSON.stringify(result.modal?.view), /nobo_prefs_modal/);
  assert.match(JSON.stringify(result.modal?.view), /prefs_timezone_input/);
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

test("handles preferences modal submissions with existing Redis errors", async () => {
  const result = await handleSlackInteractionPayload(createViewSubmission("nobo_prefs_modal", {
    prefs_timezone: {
      prefs_timezone_input: { value: "America/New_York" }
    },
    prefs_verbosity: {
      prefs_verbosity_select: { selected_option: { value: "concise" } }
    },
    prefs_news: {
      prefs_news_input: { value: "ai, security" }
    },
    prefs_reminder_style: {
      prefs_reminder_style_select: { selected_option: { value: "gentle" } }
    }
  }));

  assert.equal("response_action" in result ? result.response_action : undefined, "update");
  assert.match(JSON.stringify(result), /Redis is not configured/);
});

test("lists artifacts for /nobo-artifacts", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "markdown",
      title: "Plan",
      content: "hello",
      ownerUserId: "U123"
    });
    const result = await handleSlackSlashCommandPayload({
      command: "/nobo-artifacts",
      text: "list",
      user_id: "U123"
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
      content: "<!doctype html><title>Temp</title>",
      ownerUserId: "U123"
    });
    const result = await handleSlackSlashCommandPayload({
      command: "/nobo-artifacts",
      text: `delete ${artifact.id.slice(0, 8)}`,
      user_id: "U123"
    });

    assert.equal(result.response.response_type, "ephemeral");
    assert.match(result.response.text, /Deleted artifact/);

    const listResult = await handleSlackSlashCommandPayload({
      command: "/nobo-artifacts",
      text: "list all",
      user_id: "U123"
    });

    assert.match(listResult.response.text, /No artifacts found/);
  });
});

test("does not let other users delete artifacts for /nobo-artifacts", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "markdown",
      title: "Private plan",
      content: "hello",
      ownerUserId: "U123"
    });
    const result = await handleSlackSlashCommandPayload({
      command: "/nobo-artifacts",
      text: `delete ${artifact.id.slice(0, 8)}`,
      user_id: "U999"
    });

    assert.equal(result.response.response_type, "ephemeral");
    assert.match(result.response.text, /one of your artifacts/);
    assert.equal((await listArtifacts({ includeExpired: true })).length, 1);
  });
});

test("handles artifact modal submissions with artifact command behavior", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "markdown",
      title: "Plan",
      content: "hello",
      ownerUserId: "U123"
    });
    const result = await handleSlackInteractionPayload(createViewSubmission("nobo_artifact_modal", {
      artifact_action: {
        artifact_action_select: { selected_option: { value: "list" } }
      },
      artifact_id: {
        artifact_id_input: { value: "" }
      },
      artifact_content: {
        artifact_content_input: { value: "" }
      }
    }));

    assert.match(JSON.stringify(result), new RegExp(artifact.id.slice(0, 8)));
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

test("returns help for /nobo-issues without pasted follow-ups", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-issues",
    text: "github"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /NoBo issues/);
  assert.match(result.response.text, /pasted text/);
});

test("drafts issues for /nobo-issues pasted follow-ups", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-issues",
    text: "github - Fix onboarding bug"
  });

  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /NoBo issue drafts/);
  assert.match(result.response.text, /GitHub draft/);
  assert.match(result.response.text, /Fix onboarding bug/);
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

test("reports Redis requirement for /nobo-polls create without Redis", async () => {
  const originalRedisUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;

  try {
    const result = await handleSlackSlashCommandPayload({
      command: "/nobo-polls",
      text: "create Ship Friday? | Yes | No",
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

test("opens channel digest modal for empty slash command with a trigger", async () => {
  const result = await handleSlackSlashCommandPayload({
    command: "/nobo-channel-digest",
    text: "",
    channel_id: "C123",
    user_id: "U123",
    trigger_id: "trigger-123"
  });

  assert.equal(result.modal?.triggerId, "trigger-123");
  assert.match(JSON.stringify(result.modal?.view), /nobo_digest_modal/);
  assert.match(JSON.stringify(result.modal?.view), /digest_frequency_select/);
});

test("handles channel digest modal submissions with existing Redis errors", async () => {
  const result = await handleSlackInteractionPayload(createViewSubmission("nobo_digest_modal", {
    digest_frequency: {
      digest_frequency_select: { selected_option: { value: "daily" } }
    },
    digest_weekday: {
      digest_weekday_select: { selected_option: { value: "monday" } }
    },
    digest_time: {
      digest_time_input: { value: "09:00" }
    },
    digest_focus: {
      digest_focus_input: { value: "launch blockers" }
    }
  }));

  assert.match(JSON.stringify(result), /Channel digest subscriptions require REDIS_URL/);
});

test("opens reminder modal from a Slack shortcut", async () => {
  const result = await handleSlackInteractionRequest({
    type: "shortcut",
    callback_id: "nobo_reminder",
    trigger_id: "trigger-123",
    user: { id: "U123" },
    channel: { id: "C123" }
  });

  assert.equal(result.modal?.triggerId, "trigger-123");
  assert.match(JSON.stringify(result.modal?.view), /nobo_reminder_modal/);
  assert.deepEqual(result.response, {});
});

test("blocks denied Slack shortcut interactions", async () => {
  const result = await handleSlackInteractionRequest(
    {
      type: "shortcut",
      callback_id: "nobo_reminder",
      trigger_id: "trigger-123",
      user: { id: "U999" },
      channel: { id: "C123" }
    },
    {
      evaluateAccess: async (subject) => ({
        allowed: false,
        reason: `User ${subject.userId} denied.`
      })
    }
  );

  assert.equal(result.modal, undefined);
  const response = asSlashResponse(result.response);
  assert.equal(response.response_type, "ephemeral");
  assert.match(response.text, /NoBo access denied/);
  assert.match(response.text, /U999/);
});

test("handles reminder modal submissions with existing Redis errors", async () => {
  const result = await handleSlackInteractionPayload(createViewSubmission("nobo_reminder_modal", {
    reminder_task: {
      reminder_task_input: { value: "check logs" }
    },
    reminder_kind: {
      reminder_kind_select: { selected_option: { value: "once" } }
    },
    reminder_amount: {
      reminder_amount_input: { value: "10" }
    },
    reminder_unit: {
      reminder_unit_select: { selected_option: { value: "minutes" } }
    },
    reminder_weekday: {
      reminder_weekday_select: { selected_option: { value: "monday" } }
    },
    reminder_time: {
      reminder_time_input: { value: "09:00" }
    },
    reminder_mode: {
      reminder_mode_select: { selected_option: { value: "reminder" } }
    }
  }));

  assert.match(JSON.stringify(result), /Scheduling requires REDIS_URL/);
});

test("blocks denied Slack modal submissions using modal metadata", async () => {
  const result = await handleSlackInteractionPayload(
    createViewSubmission("nobo_artifact_modal", {
      artifact_action: {
        artifact_action_select: { selected_option: { value: "list" } }
      }
    }),
    {
      evaluateAccess: async (subject) => ({
        allowed: false,
        reason: `Channel ${subject.channelId} denied.`
      })
    }
  );

  assert.equal("response_action" in result ? result.response_action : undefined, "update");
  assert.match(JSON.stringify(result), /NoBo access denied/);
  assert.match(JSON.stringify(result), /C123/);
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
    assert.match(result.response.text, /Current: `kimi-k3`/);
    assert.ok(result.response.blocks);
    assert.match(JSON.stringify(result.response.blocks), /static_select/);
    assert.match(JSON.stringify(result.response.blocks), /nobo_channel_model_select/);
    assert.match(JSON.stringify(result.response.blocks), /deepseek-v4-pro/);
    assert.doesNotMatch(JSON.stringify(result.response.blocks), /qwen3\.7-max/);
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

  const response = asSlashResponse(result);
  assert.equal(response.response_type, "ephemeral");
  assert.match(response.text, /Redis is not configured/);
});

test("channel model interaction replaces selector with updated current model", async () => {
  await withMockOpenCodeModels(async () => {
    const result = await handleSlackInteractionPayload(
      {
        type: "block_actions",
        channel: { id: "C123" },
        actions: [
          {
            action_id: "nobo_channel_model_select",
            selected_option: { value: "deepseek-v4-pro" }
          }
        ]
      },
      {
        setChannelModelPreference: async () => ({
          ok: true as const,
          preferences: { modelId: "deepseek-v4-pro" }
        })
      }
    );

    const response = asSlashResponse(result);
    assert.equal(response.replace_original, true);
    assert.match(response.text, /deepseek-v4-pro/);
    assert.match(JSON.stringify(response.blocks), /Current text model: `deepseek-v4-pro`/);
    assert.match(JSON.stringify(response.blocks), /"initial_option"/);
    assert.match(JSON.stringify(response.blocks), /"value":"deepseek-v4-pro"/);
  });
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

function createViewSubmission(
  callbackId: string,
  values: Record<string, Record<string, Record<string, unknown>>>
) {
  return {
    type: "view_submission",
    user: { id: "U123" },
    channel: { id: "C123" },
    view: {
      id: "V123",
      callback_id: callbackId,
      private_metadata: JSON.stringify({
        userId: "U123",
        channelId: "C123"
      }),
      state: {
        values
      }
    }
  };
}

function asSlashResponse(result: Awaited<ReturnType<typeof handleSlackInteractionPayload>>) {
  assert.ok("response_type" in result);
  return result;
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
          { id: "deepseek-v4-pro", object: "model" },
          { id: "qwen3.7-max", object: "model" }
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
