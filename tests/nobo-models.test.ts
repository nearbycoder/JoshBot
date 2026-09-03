import assert from "node:assert/strict";
import test from "node:test";
import {
  __testing,
  formatOpenCodeGoModelName,
  getOpenCodeGoModelApi,
  normalizeOpenCodeGoSupportedModelId
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
