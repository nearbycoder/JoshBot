export type OpenCodeGoModel = {
  id: string;
  name: string;
};

export const OPENCODE_GO_PROVIDER = "opencode-go";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const DEFAULT_SLACK_TEXT_MODEL = "kimi-k3";
export const DEFAULT_SLACK_VISION_MODEL = "kimi-k2.6";
export const FALLBACK_SLACK_VISION_MODEL = "kimi-k2.6";

const OPENCODE_GO_MODELS_URL = `${OPENCODE_GO_BASE_URL}/models`;
const MODEL_CACHE_MS = 5 * 60 * 1000;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,74}$/;
const OPENAI_COMPAT_UNSUPPORTED_MODEL_IDS = new Set(["qwen3.7-max"]);

const MODEL_LABELS = new Map([
  ["minimax-m3", "MiniMax M3"],
  ["minimax-m2.7", "MiniMax M2.7"],
  ["minimax-m2.5", "MiniMax M2.5"],
  ["kimi-k3", "Kimi K3"],
  ["kimi-k2.7-code", "Kimi K2.7 Code"],
  ["kimi-k2.6", "Kimi K2.6"],
  ["kimi-k2.5", "Kimi K2.5"],
  ["glm-5.2", "GLM-5.2"],
  ["glm-5.1", "GLM-5.1"],
  ["glm-5", "GLM-5"],
  ["deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["qwen3.7-max", "Qwen3.7 Max"],
  ["qwen3.7-plus", "Qwen3.7 Plus"],
  ["qwen3.6-plus", "Qwen3.6 Plus"],
  ["qwen3.5-plus", "Qwen3.5 Plus"],
  ["mimo-v2-pro", "MiMo V2 Pro"],
  ["mimo-v2-omni", "MiMo V2 Omni"],
  ["mimo-v2.5-pro", "MiMo V2.5 Pro"],
  ["mimo-v2.5", "MiMo V2.5"],
  ["hy3-preview", "HY3 Preview"],
  ["grok-4.5", "Grok 4.5"]
]);

const FALLBACK_OPENCODE_GO_MODELS: OpenCodeGoModel[] = Array.from(MODEL_LABELS)
  .filter(([id]) => isOpenCodeGoOaCompatibleModelId(id))
  .map(([id, name]) => ({ id, name }));

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

export function normalizeOpenCodeGoOaCompatibleModelId(input: string | undefined | null) {
  const modelId = normalizeOpenCodeGoModelId(input);
  return modelId && isOpenCodeGoOaCompatibleModelId(modelId) ? modelId : null;
}

export function isOpenCodeGoOaCompatibleModelId(modelId: string) {
  return !OPENAI_COMPAT_UNSUPPORTED_MODEL_IDS.has(modelId);
}

export function getDefaultSlackTextModel() {
  return normalizeOpenCodeGoOaCompatibleModelId(process.env.OPENCODE_GO_MODEL) ?? DEFAULT_SLACK_TEXT_MODEL;
}

export function getDefaultSlackVisionModel() {
  return normalizeOpenCodeGoOaCompatibleModelId(process.env.OPENCODE_GO_VISION_MODEL) ?? DEFAULT_SLACK_VISION_MODEL;
}

export function formatOpenCodeGoModelName(modelId: string) {
  const normalized = normalizeOpenCodeGoModelId(modelId) ?? modelId;
  return MODEL_LABELS.get(normalized) ?? titleizeModelId(normalized);
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
    const id = normalizeOpenCodeGoOaCompatibleModelId(
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
