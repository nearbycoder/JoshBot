import assert from "node:assert/strict";
import test from "node:test";
import {
  __testing,
  formatOpenCodeGoRuntimeContext,
  formatOpenCodeGoModelName,
  getDefaultSlackVisionModel,
  getSlackImageModel,
  getOpenCodeGoModelApi,
  listOpenCodeGoModels,
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
  assert.match(context, /muse-spark-1\.3-contributor \[image, training opt-in\]/);
  assert.match(context, /deepseek-v4-pro/);
});

const newModels = [
  { id: "grok-4.7", name: "Grok 4.7", api: "openai-responses" },
  { id: "mimo-v2.6-flash", name: "MiMo-V2.6-Flash", api: "openai-completions" },
  { id: "mimo-v2.6-pro", name: "MiMo-V2.6-Pro", api: "openai-completions" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", api: "openai-completions" }
];

test("registers the September models with image input and documented endpoints", () => {
  for (const { id, name, api } of newModels) {
    assert.equal(normalizeOpenCodeGoSupportedModelId(`opencode-go/${id.toUpperCase()}`), id);
    assert.equal(formatOpenCodeGoModelName(id), name);
    assert.equal(getOpenCodeGoModelApi(id), api);
    assert.equal(supportsOpenCodeGoImageInput(id), true);
    assert.equal(getSlackImageModel(id), id);
    assert.equal(requiresOpenCodeGoDataTrainingOptIn(id), false);
    assert.ok(formatOpenCodeGoRuntimeContext(id).includes(`${id} [image]`));
  }
});

test("refreshes existing image capabilities without bypassing Muse consent", () => {
  for (const id of [
    "grok-4.6", "glm-5.3-flash", "gpt-5.6-luna", "qwen3.8-max", "qwen3.8-flash",
    "muse-spark-1.3-contributor", "muse-spark-1.2-contributor"
  ]) {
    assert.equal(getSlackImageModel(id), id);
    assert.equal(requiresOpenCodeGoDataTrainingOptIn(id), id.startsWith("muse-"));
  }
});

test("new models appear in live discovery and offline fallback without enabling unknown models", async (t) => {
  __testing.clearModelCache();
  t.after(() => __testing.clearModelCache());
  t.mock.method(globalThis, "fetch", async () => Response.json({
    data: [...newModels, { id: "omen-alpha" }, { id: "unknown-model" }, newModels[0]]
  }));
  assert.deepEqual(await listOpenCodeGoModels(), newModels.map(({ id, name }) => ({ id, name })));

  __testing.clearModelCache();
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const fallback = await listOpenCodeGoModels();
  for (const { id, name } of newModels) {
    assert.deepEqual(fallback.find((model) => model.id === id), { id, name });
  }
  assert.equal(fallback.some(({ id }) => id === "omen-alpha"), false);
});
