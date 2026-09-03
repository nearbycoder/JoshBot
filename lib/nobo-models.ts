export type OpenCodeGoModel = {
  id: string;
  name: string;
};

export type OpenCodeGoApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses";

export const OPENCODE_GO_PROVIDER = "opencode-go";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const DEFAULT_SLACK_TEXT_MODEL = "kimi-k3";
export const DEFAULT_SLACK_VISION_MODEL = "kimi-k3";
export const FALLBACK_SLACK_VISION_MODEL = "kimi-k3";

const OPENCODE_GO_MODELS_URL = `${OPENCODE_GO_BASE_URL}/models`;
const MODEL_CACHE_MS = 5 * 60 * 1000;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,74}$/;

const MODEL_DEFINITIONS = new Map<
  string,
  { name: string; api: OpenCodeGoApi }
>([
  ["grok-4.6", { name: "Grok 4.6", api: "openai-responses" }],
  ["glm-5.3-flash", { name: "GLM-5.3-Flash", api: "openai-completions" }],
  ["glm-5.3", { name: "GLM-5.3", api: "openai-completions" }],
  ["glm-5.2", { name: "GLM-5.2", api: "openai-completions" }],
  ["glm-5.1", { name: "GLM-5.1", api: "openai-completions" }],
  ["gpt-5.6-luna", { name: "GPT 5.6 Luna", api: "openai-responses" }],
  ["kimi-k3", { name: "Kimi K3", api: "openai-completions" }],
  ["kimi-k2.7-code", { name: "Kimi K2.7 Code", api: "openai-completions" }],
  ["kimi-k2.6", { name: "Kimi K2.6", api: "openai-completions" }],
  ["longcat-2.0", { name: "LongCat-2.0", api: "openai-completions" }],
  ["mimo-v2.5", { name: "MiMo-V2.5", api: "openai-completions" }],
  ["mimo-v2.5-pro", { name: "MiMo-V2.5-Pro", api: "openai-completions" }],
  ["minimax-m3", { name: "MiniMax M3", api: "anthropic-messages" }],
  ["minimax-m2.7", { name: "MiniMax M2.7", api: "anthropic-messages" }],
  [
    "muse-spark-1.3-contributor",
    { name: "Muse Spark 1.3 Contributor", api: "openai-responses" }
  ],
  [
    "muse-spark-1.2-contributor",
    { name: "Muse Spark 1.2 Contributor", api: "openai-responses" }
  ],
  ["qwen3.8-max", { name: "Qwen3.8 Max", api: "anthropic-messages" }],
  ["qwen3.8-flash", { name: "Qwen3.8 Flash", api: "anthropic-messages" }],
  ["qwen3.7-max", { name: "Qwen3.7 Max", api: "anthropic-messages" }],
  ["qwen3.7-plus", { name: "Qwen3.7 Plus", api: "anthropic-messages" }],
  ["qwen3.6-plus", { name: "Qwen3.6 Plus", api: "anthropic-messages" }],
  ["deepseek-v4-pro", { name: "DeepSeek V4 Pro", api: "openai-completions" }],
  ["deepseek-v4-flash", { name: "DeepSeek V4 Flash", api: "openai-completions" }],
  [
    "deepseek-v4-flash-vision-exp",
    { name: "DeepSeek V4 Flash Vision Exp", api: "openai-completions" }
  ],
  ["hy4-preview", { name: "Hy4 preview", api: "openai-completions" }],
  ["hy3", { name: "Hy3", api: "openai-completions" }]
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
  return normalizeOpenCodeGoSupportedModelId(process.env.OPENCODE_GO_VISION_MODEL) ?? DEFAULT_SLACK_VISION_MODEL;
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
