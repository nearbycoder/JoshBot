import assert from "node:assert/strict";
import test from "node:test";
import {
  __testing,
  formatOpenCodeGoRuntimeContext,
  formatOpenCodeGoModelName,
  getDefaultSlackTextModel,
  getDefaultSlackVisionModel,
  getSlackImageModel,
  getOpenCodeGoModelApi,
  getOpenCodeGoModelBaseUrl,
  listOpenCodeGoModelDefinitions,
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
    assert.equal(supportsOpenCodeGoImageInput("kimi-k3"), true);
    assert.equal(supportsOpenCodeGoImageInput("deepseek-v4-pro"), false);
    assert.equal(getSlackImageModel("kimi-k3"), "kimi-k3");
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
    requiresOpenCodeGoDataTrainingOptIn("opencode-go/GEMINI-4-ARGON-CONTRIBUTOR"),
    true
  );
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
  assert.match(context, /gemini-4-argon-contributor \[image, training opt-in\]/);
  assert.match(context, /deepseek-v4-pro/);
});

const newModels = [
  { id: "grok-4.7", name: "Grok 4.7", api: "openai-responses" },
  { id: "mimo-v2.6-flash", name: "MiMo-V2.6-Flash", api: "openai-completions" },
  { id: "mimo-v2.6-pro", name: "MiMo-V2.6-Pro", api: "openai-completions" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", api: "openai-completions" }
];

// Active documented Go models checked against live discovery and models.dev on
// 2026-10-22. The docs still advertise deprecated LongCat 2.5 Preview Free.
const currentModelsByApi = {
  "anthropic-messages": ["claude-haiku-5-5", "minimax-m3", "qwen3.7-plus", "qwen3.8-flash", "qwen3.8-max"],
  "google-generative-ai": ["gemini-4-argon-contributor"],
  "openai-completions": [
    "beam-free", "deepseek-v4-pro", "deepseek-v4.1-flash", "glm-5.2", "glm-5.3", "glm-5.3-flash",
    "hy3", "hy4-preview", "kimi-k2.7-code", "kimi-k3", "longcat-2.0", "mimo-v2.5", "mimo-v2.5-pro",
    "mimo-v2.6-flash", "mimo-v2.6-pro", "minimax-m3.1-flash-free", "step-5-preview"
  ],
  "openai-responses": ["gpt-5.6-luna", "gpt-6-luna", "grok-4.7", "muse-spark-1.2-contributor", "muse-spark-1.3-contributor"]
};

const retiredModels = [
  "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "glm-5.1", "grok-4.6", "kimi-k2.6",
  "longcat-2.5-preview-free", "minimax-m2.7", "qwen3.6-plus", "qwen3.7-max"
];

test("registers the active October catalog with each documented wire protocol", () => {
  assert.equal(listOpenCodeGoModelDefinitions().length, 28);
  for (const [api, ids] of Object.entries(currentModelsByApi)) {
    assert.deepEqual(
      listOpenCodeGoModelDefinitions().filter((model) => model.api === api).map(({ id }) => id).sort(),
      [...ids].sort()
    );
    for (const id of ids) assert.equal(normalizeOpenCodeGoSupportedModelId(`opencode-go/${id.toUpperCase()}`), id);
  }
});

test("uses protocol-specific inference routes without confusing them with discovery", () => {
  for (const [id, expected] of [
    ["gpt-6-luna", "https://opencode.ai/inference/go/openai/v1"],
    ["minimax-m3.1-flash-free", "https://opencode.ai/inference/go/openai/v1"],
    ["claude-haiku-5-5", "https://opencode.ai/inference/go/anthropic"],
    ["opencode-go/GEMINI-4-ARGON-CONTRIBUTOR", "https://opencode.ai/inference/go/google/v1beta"]
  ]) assert.equal(getOpenCodeGoModelBaseUrl(id!), expected);
  assert.equal(getOpenCodeGoModelBaseUrl("unknown-model"), null);
});

test("new vision models retain image routing and contributor consent", () => {
  for (const id of ["gpt-6-luna", "claude-haiku-5-5", "gemini-4-argon-contributor", "step-5-preview", "minimax-m3.1-flash-free"]) {
    assert.equal(supportsOpenCodeGoImageInput(id), true);
    assert.equal(getSlackImageModel(id), id);
    assert.equal(requiresOpenCodeGoDataTrainingOptIn(id), id === "gemini-4-argon-contributor");
  }
  assert.equal(supportsOpenCodeGoImageInput("beam-free"), false);
  assert.equal(supportsOpenCodeGoImageInput("deepseek-v4-pro"), false);
  assert.equal(requiresOpenCodeGoDataTrainingOptIn("beam-free"), false);
});

test("does not revive retired models from stale discovery or saved preferences", () => {
  for (const id of retiredModels) {
    assert.equal(normalizeOpenCodeGoSupportedModelId(id), null);
    assert.equal(getOpenCodeGoModelApi(id), null);
    assert.equal(getOpenCodeGoModelBaseUrl(id), null);
    assert.equal(supportsOpenCodeGoImageInput(id), false);
  }
  assert.deepEqual(__testing.normalizeModelList({ data: retiredModels.map((id) => ({ id })) }), []);
});

test("keeps Kimi defaults and safely handles retired configured models", (t) => {
  const originalText = process.env.OPENCODE_GO_MODEL;
  const originalVision = process.env.OPENCODE_GO_VISION_MODEL;
  t.after(() => {
    if (originalText === undefined) delete process.env.OPENCODE_GO_MODEL;
    else process.env.OPENCODE_GO_MODEL = originalText;
    if (originalVision === undefined) delete process.env.OPENCODE_GO_VISION_MODEL;
    else process.env.OPENCODE_GO_VISION_MODEL = originalVision;
  });
  process.env.OPENCODE_GO_MODEL = "glm-5.1";
  process.env.OPENCODE_GO_VISION_MODEL = "kimi-k2.6";
  assert.equal(getDefaultSlackTextModel(), "kimi-k3");
  assert.equal(getDefaultSlackVisionModel(), "kimi-k3");
  assert.equal(getSlackImageModel("beam-free"), "kimi-k3");
  process.env.OPENCODE_GO_MODEL = "opencode-go/gpt-6-luna";
  process.env.OPENCODE_GO_VISION_MODEL = "claude-haiku-5-5";
  assert.equal(getDefaultSlackTextModel(), "gpt-6-luna");
  assert.equal(getDefaultSlackVisionModel(), "claude-haiku-5-5");
});

test("fetches only vetted active models from the current discovery route and caches the result", async (t) => {
  __testing.clearModelCache();
  t.after(() => __testing.clearModelCache());
  const fetch = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(url, "https://opencode.ai/inference/go/v1/models");
    return Response.json({ data: [
      { id: "gpt-6-luna" }, { id: "gemini-4-argon-contributor" }, { id: "beam-free" },
      { id: "gpt-6-luna" }, { id: "longcat-2.5-preview-free" }, { id: "omen-alpha" }, null, { id: 42 }
    ] });
  });
  const expected = [
    { id: "gpt-6-luna", name: "GPT 6 Luna" },
    { id: "gemini-4-argon-contributor", name: "Gemini 4 Argon Contributor" },
    { id: "beam-free", name: "Beam Free" }
  ];
  assert.deepEqual(await listOpenCodeGoModels(), expected);
  assert.deepEqual(await listOpenCodeGoModels(), expected);
  assert.equal(fetch.mock.callCount(), 1);
});

test("failed discovery falls back to the active catalog without retired models", async (t) => {
  __testing.clearModelCache();
  t.after(() => __testing.clearModelCache());
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const fallback = await listOpenCodeGoModels();
  assert.deepEqual(fallback.map(({ id }) => id).sort(), Object.values(currentModelsByApi).flat().sort());
  for (const id of retiredModels) assert.equal(fallback.some((model) => model.id === id), false);
});

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
    "grok-4.7", "glm-5.3-flash", "gpt-5.6-luna", "qwen3.8-max", "qwen3.8-flash",
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
