import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunError } from "@flue/runtime";
import { __testing } from "../lib/ai.js";

test("current time uses requested timezone", () => {
  const currentTime = __testing.formatCurrentTime("America/Chicago");

  assert.equal(currentTime.timeZone, "America/Chicago");
  assert.match(currentTime.iso, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(currentTime.local, /Central|GMT-5|GMT-6|CDT|CST/);
  assert.match(currentTime.utc, /UTC|Coordinated Universal Time|GMT/);
});

test("current time falls back to America/Chicago for invalid timezone", () => {
  const currentTime = __testing.formatCurrentTime("Nope/Nowhere");

  assert.equal(currentTime.timeZone, "America/Chicago");
});

test("current time prompt names relative date phrases", () => {
  const prompt = __testing.formatCurrentTimePrompt();

  assert.match(prompt, /Current time:/);
  assert.match(prompt, /America\/Chicago/);
  assert.match(prompt, /in 5 minutes/);
  assert.match(prompt, /over the past week/);
});

test("current time prompt can use user timezone", () => {
  const prompt = __testing.formatCurrentTimePrompt("America/New_York");

  assert.match(prompt, /America\/New_York/);
  assert.doesNotMatch(prompt, /Timezone: America\/Chicago/);
});

test("Slack markdown normalization converts Markdown links and bold", () => {
  const normalized = __testing.normalizeSlackMrkdwn(
    "See [OpenAI](https://openai.com) and **bold** text"
  );

  assert.equal(normalized, "See <https://openai.com|OpenAI> and *bold* text");
});

test("channel memory prompt is shared channel context", () => {
  const prompt = __testing.formatChannelMemoryPrompt(
    [
      {
        role: "user",
        userId: "U123",
        content: "Prefers short release updates",
        ts: "1000.000",
        threadTs: "999.000"
      },
      {
        role: "assistant",
        content: "Use concise checklists in this channel"
      }
    ],
    "C123"
  );

  assert.match(prompt, /Shared channel memory for Slack channel C123/);
  assert.match(prompt, /Slack user U123: Prefers short release updates/);
  assert.match(prompt, /NoBo: Use concise checklists in this channel/);
  assert.match(prompt, /belongs to the channel, not a single user/);
  assert.match(prompt, /how NoBo should react here/);
});

test("image-bearing Slack messages default to Kimi vision model", () => {
  const originalTextModel = process.env.OPENCODE_GO_MODEL;
  const originalVisionModel = process.env.OPENCODE_GO_VISION_MODEL;
  delete process.env.OPENCODE_GO_MODEL;
  delete process.env.OPENCODE_GO_VISION_MODEL;

  try {
    assert.equal(
      __testing.selectSlackModel([
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", image: Buffer.from("image"), mediaType: "image/jpeg" }
          ]
        }
      ]),
      "kimi-k3"
    );
  } finally {
    if (originalTextModel === undefined) {
      delete process.env.OPENCODE_GO_MODEL;
    } else {
      process.env.OPENCODE_GO_MODEL = originalTextModel;
    }
    if (originalVisionModel === undefined) {
      delete process.env.OPENCODE_GO_VISION_MODEL;
    } else {
      process.env.OPENCODE_GO_VISION_MODEL = originalVisionModel;
    }
  }
});

test("image-bearing Slack messages respect configured vision model", () => {
  const originalTextModel = process.env.OPENCODE_GO_MODEL;
  const originalVisionModel = process.env.OPENCODE_GO_VISION_MODEL;
  process.env.OPENCODE_GO_MODEL = "deepseek-v4-pro";
  process.env.OPENCODE_GO_VISION_MODEL = "kimi-k2.7-code";

  try {
    assert.equal(
      __testing.selectSlackModel([
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", image: Buffer.from("image"), mediaType: "image/jpeg" }
          ]
        }
      ]),
      "kimi-k2.7-code"
    );
  } finally {
    if (originalTextModel === undefined) {
      delete process.env.OPENCODE_GO_MODEL;
    } else {
      process.env.OPENCODE_GO_MODEL = originalTextModel;
    }
    if (originalVisionModel === undefined) {
      delete process.env.OPENCODE_GO_VISION_MODEL;
    } else {
      process.env.OPENCODE_GO_VISION_MODEL = originalVisionModel;
    }
  }
});

test("text-only channel model falls back to the configured image model", () => {
  const originalVisionModel = process.env.OPENCODE_GO_VISION_MODEL;
  delete process.env.OPENCODE_GO_VISION_MODEL;

  try {
    assert.equal(
      __testing.selectSlackModel(
        [
          {
            role: "user",
            content: "Use the channel model"
          }
        ],
        "deepseek-v4-pro"
      ),
      "deepseek-v4-pro"
    );

    assert.equal(
      __testing.selectSlackModel(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image", image: Buffer.from("image"), mediaType: "image/jpeg" }
            ]
          }
        ],
        "deepseek-v4-pro"
      ),
      "kimi-k3"
    );
  } finally {
    if (originalVisionModel === undefined) {
      delete process.env.OPENCODE_GO_VISION_MODEL;
    } else {
      process.env.OPENCODE_GO_VISION_MODEL = originalVisionModel;
    }
  }
});

test("image-capable channel model handles image messages itself", () => {
  const originalVisionModel = process.env.OPENCODE_GO_VISION_MODEL;
  process.env.OPENCODE_GO_VISION_MODEL = "kimi-k3";

  try {
    assert.equal(
      __testing.selectSlackModel(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image", image: Buffer.from("image"), mediaType: "image/jpeg" }
            ]
          }
        ],
        "kimi-k2.7-code"
      ),
      "kimi-k2.7-code"
    );
  } finally {
    if (originalVisionModel === undefined) {
      delete process.env.OPENCODE_GO_VISION_MODEL;
    } else {
      process.env.OPENCODE_GO_VISION_MODEL = originalVisionModel;
    }
  }
});

test("image-capable default model handles image messages itself", () => {
  const originalTextModel = process.env.OPENCODE_GO_MODEL;
  const originalVisionModel = process.env.OPENCODE_GO_VISION_MODEL;
  process.env.OPENCODE_GO_MODEL = "kimi-k2.6";
  process.env.OPENCODE_GO_VISION_MODEL = "kimi-k3";

  try {
    assert.equal(
      __testing.selectSlackModel([
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", image: Buffer.from("image"), mediaType: "image/jpeg" }
          ]
        }
      ]),
      "kimi-k2.6"
    );
  } finally {
    if (originalTextModel === undefined) {
      delete process.env.OPENCODE_GO_MODEL;
    } else {
      process.env.OPENCODE_GO_MODEL = originalTextModel;
    }
    if (originalVisionModel === undefined) {
      delete process.env.OPENCODE_GO_VISION_MODEL;
    } else {
      process.env.OPENCODE_GO_VISION_MODEL = originalVisionModel;
    }
  }
});

test("data-policy failures fall back to Kimi without changing normal text failures", () => {
  const policyError = new AgentRunError({
    outcome: "failed",
    submissionId: "sub_test",
    cause: {
      type: "operation_failed",
      meta: {
        reason:
          'OpenAI API error (403): {"type":"DataPolicyError","message":"This model requires explicit opt in"}'
      }
    }
  });

  assert.deepEqual(
    __testing.selectSlackModelFailureFallback(
      policyError,
      "muse-spark-1.3-contributor",
      false
    ),
    { modelId: "kimi-k3", reason: "data-policy" }
  );
  assert.equal(
    __testing.selectSlackModelFailureFallback(
      new Error("Temporary provider error"),
      "muse-spark-1.3-contributor",
      false
    ),
    null
  );
  assert.equal(
    __testing.selectSlackModelFailureFallback(policyError, "kimi-k3", false),
    null
  );
});

test("shared agent execution applies data-policy fallback to every Flue model call", async () => {
  const calls: Array<{
    modelId: string;
    toolMode: string;
    streams: boolean;
    prompt: string;
  }> = [];
  const policyError = new AgentRunError({
    outcome: "failed",
    submissionId: "sub_policy",
    cause: {
      type: "operation_failed",
      meta: {
        reason:
          'OpenAI API error (403): {"type":"DataPolicyError","message":"This model requires explicit opt in"}'
      }
    }
  });
  const result = await __testing.runNoboAgentPromptWithFallback(
    {
      prompt: "Classify this Slack thread.",
      modelId: "muse-spark-1.3-contributor",
      toolMode: "none",
      onTextDelta: () => {}
    },
    async (options) => {
      calls.push({
        modelId: options.modelId,
        toolMode: options.toolMode,
        streams: Boolean(options.onTextDelta),
        prompt: options.prompt
      });

      if (calls.length === 1) {
        throw policyError;
      }

      return "RESPOND";
    }
  );

  assert.equal(result, "RESPOND");
  assert.deepEqual(
    calls.map(({ modelId, toolMode, streams }) => ({ modelId, toolMode, streams })),
    [
      {
        modelId: "muse-spark-1.3-contributor",
        toolMode: "none",
        streams: true
      },
      { modelId: "kimi-k3", toolMode: "none", streams: false }
    ]
  );
});

test("tool-enabled policy fallback recovers from OpenCode invalid parameters", async () => {
  const calls: Array<{
    modelId: string;
    toolMode: string;
    streams: boolean;
    prompt: string;
  }> = [];
  const policyError = new AgentRunError({
    outcome: "failed",
    submissionId: "sub_policy",
    cause: {
      type: "operation_failed",
      meta: {
        reason:
          'OpenAI API error (403): {"type":"DataPolicyError","message":"This model requires explicit opt in"}'
      }
    }
  });
  const invalidRequestError = new AgentRunError({
    outcome: "failed",
    submissionId: "sub_invalid",
    cause: {
      type: "operation_failed",
      meta: {
        reason:
          '400: {"type":"server_error","message":"Upstream request failed: Invalid request parameters. Please check your input and try again."}'
      }
    }
  });
  const result = await __testing.runNoboAgentPromptWithFallback(
    {
      prompt: "Use a tool if needed.",
      modelId: "muse-spark-1.3-contributor",
      toolMode: "slack",
      onTextDelta: () => {}
    },
    async (options) => {
      calls.push({
        modelId: options.modelId,
        toolMode: options.toolMode,
        streams: Boolean(options.onTextDelta),
        prompt: options.prompt
      });

      if (calls.length === 1) {
        throw policyError;
      }

      if (calls.length === 2) {
        throw invalidRequestError;
      }

      return "Safe fallback response";
    }
  );

  assert.equal(result, "Safe fallback response");
  assert.deepEqual(
    calls.map(({ modelId, toolMode, streams }) => ({ modelId, toolMode, streams })),
    [
      {
        modelId: "muse-spark-1.3-contributor",
        toolMode: "slack",
        streams: true
      },
      { modelId: "kimi-k3", toolMode: "slack", streams: false },
      { modelId: "kimi-k3", toolMode: "none", streams: false }
    ]
  );
  assert.match(calls[2]?.prompt ?? "", /tools are temporarily unavailable/);
});

test("channel text model accepts current non-chat OpenCode models", () => {
  const originalTextModel = process.env.OPENCODE_GO_MODEL;
  delete process.env.OPENCODE_GO_MODEL;

  try {
    assert.equal(
      __testing.selectSlackModel(
        [
          {
            role: "user",
            content: "Use the channel model"
          }
        ],
        "qwen3.7-max"
      ),
      "qwen3.7-max"
    );

    assert.equal(
      __testing.selectSlackModel(
        [
          {
            role: "user",
            content: "Ignore a retired model"
          }
        ],
        "qwen3.5-plus"
      ),
      "kimi-k3"
    );
  } finally {
    if (originalTextModel === undefined) {
      delete process.env.OPENCODE_GO_MODEL;
    } else {
      process.env.OPENCODE_GO_MODEL = originalTextModel;
    }
  }
});
