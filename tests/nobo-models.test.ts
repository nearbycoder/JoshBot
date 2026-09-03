import assert from "node:assert/strict";
import test from "node:test";
import {
  __testing,
  formatOpenCodeGoRuntimeContext,
  formatOpenCodeGoModelName,
  getDefaultSlackVisionModel,
  getSlackImageModel,
  getOpenCodeGoModelApi,
  normalizeOpenCodeGoSupportedModelId,
  requiresOpenCodeGoDataTrainingOptIn,
  supportsOpenCodeGoImageInput
} from "../lib/nobo-models.js";

test("normalizes the current OpenCode Go catalog", () => {
  assert.equal(
    normalizeOpenCodeGoSupportedModelId("opencode-go/GLM-5.3-Flash"),
    "glm-5.3-flash"
  );
  assert.equal(normalizeOpenCodeGoSupportedModelId("qwen3.8-max"), "qwen3.8-max");
  assert.equal(normalizeOpenCodeGoSupportedModelId("gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(normalizeOpenCodeGoSupportedModelId("grok-4.5"), null);
});

test("maps OpenCode Go models to their documented APIs", () => {
  assert.equal(getOpenCodeGoModelApi("glm-5.3"), "openai-completions");
  assert.equal(getOpenCodeGoModelApi("qwen3.8-flash"), "anthropic-messages");
  assert.equal(getOpenCodeGoModelApi("gpt-5.6-luna"), "openai-responses");
  assert.equal(getOpenCodeGoModelApi("grok-4.5"), null);
});

test("filters model discovery to supported current models", () => {
  assert.deepEqual(
    __testing.normalizeModelList({
      data: [
        { id: "glm-5.3" },
        { id: "qwen3.8-max" },
        { id: "glm-5.3" },
        { id: "grok-4.5" },
        { id: "unknown-model" }
      ]
    }),
    [
      { id: "glm-5.3", name: "GLM-5.3" },
      { id: "qwen3.8-max", name: "Qwen3.8 Max" }
    ]
  );
  assert.equal(
    formatOpenCodeGoModelName("muse-spark-1.3-contributor"),
    "Muse Spark 1.3 Contributor"
  );
});

test("tracks image input capabilities and routing", () => {
  const originalVisionModel = process.env.OPENCODE_GO_VISION_MODEL;
  process.env.OPENCODE_GO_VISION_MODEL = "kimi-k2.7-code";

  try {
    assert.equal(supportsOpenCodeGoImageInput("kimi-k2.6"), true);
    assert.equal(supportsOpenCodeGoImageInput("deepseek-v4-pro"), false);
    assert.equal(getSlackImageModel("kimi-k2.6"), "kimi-k2.6");
    assert.equal(getSlackImageModel("deepseek-v4-pro"), "kimi-k2.7-code");
  } finally {
    if (originalVisionModel === undefined) {
      delete process.env.OPENCODE_GO_VISION_MODEL;
    } else {
      process.env.OPENCODE_GO_VISION_MODEL = originalVisionModel;
    }
  }
});

test("tracks models that require workspace data-training opt-in", () => {
  assert.equal(
    requiresOpenCodeGoDataTrainingOptIn("muse-spark-1.3-contributor"),
    true
  );
  assert.equal(
    requiresOpenCodeGoDataTrainingOptIn("muse-spark-1.2-contributor"),
    true
  );
  assert.equal(requiresOpenCodeGoDataTrainingOptIn("kimi-k3"), false);
});

test("rejects a text-only configured image fallback", () => {
  const originalVisionModel = process.env.OPENCODE_GO_VISION_MODEL;
  process.env.OPENCODE_GO_VISION_MODEL = "deepseek-v4-pro";

  try {
    assert.equal(getDefaultSlackVisionModel(), "kimi-k3");
  } finally {
    if (originalVisionModel === undefined) {
      delete process.env.OPENCODE_GO_VISION_MODEL;
    } else {
      process.env.OPENCODE_GO_VISION_MODEL = originalVisionModel;
    }
  }
});

test("formats authoritative runtime model context for NoBo", () => {
  const context = formatOpenCodeGoRuntimeContext("kimi-k2.7-code");

  assert.match(context, /Active model for this request: `kimi-k2\.7-code`/);
  assert.match(context, /Image fallback model: `kimi-k3`/);
  assert.match(context, /kimi-k2\.7-code \[image\]/);
  assert.match(context, /muse-spark-1\.3-contributor \[training opt-in\]/);
  assert.match(context, /deepseek-v4-pro/);
});
