export type OpenCodeGoModel = {
  id: string;
  name: string;
};

export type OpenCodeGoApi =
  | "anthropic-messages"
  | "google-generative-ai"
  | "openai-completions"
  | "openai-responses";

export const OPENCODE_GO_PROVIDER = "opencode-go";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
export const DEFAULT_SLACK_TEXT_MODEL = "kimi-k3";
export const DEFAULT_SLACK_VISION_MODEL = "kimi-k3";
export const FALLBACK_SLACK_TEXT_MODEL = "kimi-k3";
export const FALLBACK_SLACK_VISION_MODEL = "kimi-k3";

const OPENCODE_GO_MODELS_URL = "https://opencode.ai/inference/go/v1/models";
const MODEL_CACHE_MS = 5 * 60 * 1000;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,74}$/;
// Verified 2026-11-20 against https://opencode.ai/inference/go/v1/models and
// @earendil-works/pi-ai@1.6.0 opencodeGoProvider().
// Discovery is filtered through this catalog so a new ID cannot inherit a guessed
// wire protocol or capabilities. Retired IDs are not silently mapped to successors.
const IMAGE_INPUT_MODEL_IDS = new Set([
  "kimi-k3.1-pro",
  "kimi-k3",
  "kimi-k2.7-code",
  "gemini-4-argon",
  "claude-haiku-5-5",
  "gpt-6-luna",
  "gpt-5.6-luna",
  "grok-4.7",
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
  "qwen4-max",
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-plus",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "minimax-m3",
  "minimax-m3.1-flash",
  "step-5-preview",
  "hy4",
  "hy4-flash-free",
  "longcat-2.5-free",
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor"
]);
const DATA_TRAINING_OPT_IN_MODEL_IDS = new Set([
  "iceman-contributor-free",
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor"
]);
const FEATURED_MODEL_IDS = new Set([
  "kimi-k3.1-pro",
  "gemini-4-argon",
  "claude-haiku-5-5",
  "gpt-6-luna",
  "deepseek-v4.1-flash",
  "glm-5.3",
  "glm-5.3-flash",
  "mimo-v2.6-flash",
  "qwen3.8-flash",
  "hy4-flash-free",
  "beam-free",
  "muse-spark-1.3-contributor"
]);

const MODEL_DEFINITIONS = new Map<
  string,
  { name: string; api: OpenCodeGoApi }
>([
  ["kimi-k3.1-pro", { name: "Kimi K3.1 Pro", api: "openai-completions" }],
  ["kimi-k3", { name: "Kimi K3", api: "openai-completions" }],
  ["gemini-4-argon", { name: "Gemini 4 Argon", api: "google-generative-ai" }],
  ["claude-haiku-5-5", { name: "Claude Haiku 5.5", api: "anthropic-messages" }],
  ["gpt-6-luna", { name: "GPT-6 Luna", api: "openai-responses" }],
  ["deepseek-v4.1-flash", { name: "DeepSeek V4.1 Flash", api: "openai-completions" }],
  ["glm-5.3", { name: "GLM-5.3", api: "openai-completions" }],
  ["glm-5.3-flash", { name: "GLM-5.3-Flash", api: "openai-completions" }],
  ["mimo-v2.6-flash", { name: "MiMo-V2.6-Flash", api: "openai-completions" }],
  ["qwen3.8-flash", { name: "Qwen3.8 Flash", api: "anthropic-messages" }],
  ["hy4-flash-free", { name: "Hy4 flash Free", api: "openai-completions" }],
  ["beam-free", { name: "Beam Free", api: "openai-completions" }],
  [
    "muse-spark-1.3-contributor",
    { name: "Muse Spark 1.3 Contributor", api: "openai-responses" }
  ],
  ["qwen4-max", { name: "Qwen4 Max", api: "anthropic-messages" }],
  ["deepseek-v4-pro", { name: "DeepSeek V4 Pro", api: "openai-completions" }],
  ["grok-4.7", { name: "Grok 4.7", api: "openai-responses" }],
  ["gpt-5.6-luna", { name: "GPT-5.6 Luna", api: "openai-responses" }],
  ["kimi-k2.7-code", { name: "Kimi K2.7 Code", api: "openai-completions" }],
  ["mimo-v2.6-pro", { name: "MiMo-V2.6-Pro", api: "openai-completions" }],
  ["minimax-m3", { name: "MiniMax-M3", api: "anthropic-messages" }],
  ["minimax-m3.1-flash", { name: "MiniMax M3.1 Flash", api: "openai-completions" }],
  ["qwen3.8-max", { name: "Qwen3.8 Max", api: "anthropic-messages" }],
  ["qwen3.7-plus", { name: "Qwen3.7 Plus", api: "anthropic-messages" }],
  ["step-5-preview", { name: "Step 5 Preview", api: "openai-completions" }],
  ["hy4", { name: "Hy4", api: "openai-completions" }],
  ["hy4-preview", { name: "Hy4 preview", api: "openai-completions" }],
  ["hy3", { name: "Hy3", api: "openai-completions" }],
  ["longcat-2.5-free", { name: "LongCat 2.5 Free", api: "openai-completions" }],
  ["longcat-2.0", { name: "LongCat-2.0", api: "openai-completions" }],
  [
    "iceman-contributor-free",
    { name: "Iceman Contributor Free", api: "openai-completions" }
  ],
  [
    "muse-spark-1.2-contributor",
    { name: "Muse Spark 1.2 Contributor", api: "openai-responses" }
  ]
]);

const FALLBACK_OPENCODE_GO_MODELS: OpenCodeGoModel[] = Array.from(
  MODEL_DEFINITIONS,
  ([id, { name }]) => ({ id, name })
);

let modelCache:
  | {
      expiresAt: number;
      models: OpenCodeGoModel[];
    }
  | null = null;

export async function listOpenCodeGoModels() {
  const now = Date.now();

  if (modelCache && modelCache.expiresAt > now) {
    return modelCache.models;
  }

  try {
    const models = normalizeModelList(await fetchOpenCodeGoModels());

    if (models.length > 0) {
      modelCache = {
        expiresAt: now + MODEL_CACHE_MS,
        models
      };
      return models;
    }
  } catch (error) {
    console.warn(`Unable to load OpenCode Go models: ${summarizeModelError(error)}`);
  }

  modelCache = {
    expiresAt: now + MODEL_CACHE_MS,
    models: FALLBACK_OPENCODE_GO_MODELS
  };
  return modelCache.models;
}

export function normalizeOpenCodeGoModelId(input: string | undefined | null) {
  const trimmed = input?.trim();

  if (!trimmed) {
    return null;
  }

  const withoutProvider = trimmed
    .replace(new RegExp(`^${OPENCODE_GO_PROVIDER}/`, "i"), "")
    .toLowerCase();

  return MODEL_ID_PATTERN.test(withoutProvider) ? withoutProvider : null;
}

export function normalizeOpenCodeGoSupportedModelId(input: string | undefined | null) {
  const modelId = normalizeOpenCodeGoModelId(input);
  return modelId && MODEL_DEFINITIONS.has(modelId) ? modelId : null;
}

export function getOpenCodeGoModelApi(modelId: string) {
  const normalized = normalizeOpenCodeGoSupportedModelId(modelId);
  return normalized ? MODEL_DEFINITIONS.get(normalized)?.api ?? null : null;
}

export function getOpenCodeGoModelBaseUrl(modelId: string) {
  switch (getOpenCodeGoModelApi(modelId)) {
    case "anthropic-messages":
      // The Anthropic SDK appends /v1/messages itself.
      return "https://opencode.ai/inference/go/anthropic";
    case "google-generative-ai":
      return "https://opencode.ai/inference/go/google/v1beta";
    case "openai-completions":
    case "openai-responses":
      return OPENCODE_GO_BASE_URL;
    default:
      return null;
  }
}

export function supportsOpenCodeGoImageInput(modelId: string | undefined | null) {
  const normalized = normalizeOpenCodeGoSupportedModelId(modelId);
  return normalized ? IMAGE_INPUT_MODEL_IDS.has(normalized) : false;
}

export function requiresOpenCodeGoDataTrainingOptIn(
  modelId: string | undefined | null
) {
  const normalized = normalizeOpenCodeGoSupportedModelId(modelId);
  return normalized ? DATA_TRAINING_OPT_IN_MODEL_IDS.has(normalized) : false;
}

export function isOpenCodeGoFeaturedModel(modelId: string | undefined | null) {
  const normalized = normalizeOpenCodeGoSupportedModelId(modelId);
  return normalized ? FEATURED_MODEL_IDS.has(normalized) : false;
}

export function listOpenCodeGoModelDefinitions() {
  return Array.from(MODEL_DEFINITIONS, ([id, definition]) => ({
    id,
    ...definition
  }));
}

export function getDefaultSlackTextModel() {
  return normalizeOpenCodeGoSupportedModelId(process.env.OPENCODE_GO_MODEL) ?? DEFAULT_SLACK_TEXT_MODEL;
}

export function getDefaultSlackVisionModel() {
  const configured = normalizeOpenCodeGoSupportedModelId(
    process.env.OPENCODE_GO_VISION_MODEL
  );

  return configured && supportsOpenCodeGoImageInput(configured)
    ? configured
    : DEFAULT_SLACK_VISION_MODEL;
}

export function getSlackImageModel(preferredModelId: string | undefined | null) {
  const preferred = normalizeOpenCodeGoSupportedModelId(preferredModelId);
  return preferred && supportsOpenCodeGoImageInput(preferred)
    ? preferred
    : getDefaultSlackVisionModel();
}

export function formatOpenCodeGoRuntimeContext(activeModelId: string) {
  const active = normalizeOpenCodeGoSupportedModelId(activeModelId) ?? activeModelId;
  const defaultText = getDefaultSlackTextModel();
  const imageFallback = getDefaultSlackVisionModel();
  const registeredModels = listOpenCodeGoModelDefinitions()
    .map(({ id }) => {
      const capabilities = [
        supportsOpenCodeGoImageInput(id) ? "image" : null,
        requiresOpenCodeGoDataTrainingOptIn(id) ? "training opt-in" : null
      ].filter(Boolean);

      return `${id}${capabilities.length > 0 ? ` [${capabilities.join(", ")}]` : ""}`;
    })
    .join(", ");

  return `Runtime model configuration (authoritative):
- Active model for this request: ${formatRuntimeModel(active)}
- Default text model: ${formatRuntimeModel(defaultText)}
- Image fallback model: ${formatRuntimeModel(imageFallback)}
- Registered OpenCode Go models ([image] means image input is enabled; [training opt-in] means the OpenCode workspace must explicitly allow model-training data use): ${registeredModels}
- When asked which model is configured or currently in use, answer from this runtime configuration rather than guessing.`;
}

export function formatOpenCodeGoModelName(modelId: string) {
  const normalized = normalizeOpenCodeGoModelId(modelId) ?? modelId;
  return MODEL_DEFINITIONS.get(normalized)?.name ?? titleizeModelId(normalized);
}

async function fetchOpenCodeGoModels() {
  const headers: Record<string, string> = {
    accept: "application/json"
  };

  if (process.env.OPENCODE_GO_API_KEY) {
    headers.authorization = `Bearer ${process.env.OPENCODE_GO_API_KEY}`;
  }

  const response = await fetch(OPENCODE_GO_MODELS_URL, {
    headers,
    signal: AbortSignal.timeout(2500)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return (await response.json()) as unknown;
}

function normalizeModelList(input: unknown) {
  const data = isRecord(input) && Array.isArray(input.data) ? input.data : [];
  const seen = new Set<string>();
  const models: OpenCodeGoModel[] = [];

  for (const item of data) {
    const id = normalizeOpenCodeGoSupportedModelId(
      isRecord(item) ? getString(item.id) : null
    );

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    models.push({
      id,
      name: formatOpenCodeGoModelName(id)
    });
  }

  return models;
}

function titleizeModelId(modelId: string) {
  return modelId
    .split(/[-_]+/)
    .map((part) => (part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

function formatRuntimeModel(modelId: string) {
  const api = getOpenCodeGoModelApi(modelId) ?? "unknown API";
  const imageSupport = supportsOpenCodeGoImageInput(modelId)
    ? "image input enabled"
    : "text input only";
  const dataPolicy = requiresOpenCodeGoDataTrainingOptIn(modelId)
    ? ", training data opt-in required"
    : "";

  return `\`${modelId}\` (${api}, ${imageSupport}${dataPolicy})`;
}

function getString(input: unknown) {
  return typeof input === "string" ? input : null;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function summarizeModelError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const __testing = {
  clearModelCache() {
    modelCache = null;
  },
  normalizeModelList
};
