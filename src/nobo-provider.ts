import { setProvider } from "@flue/runtime";
import { envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_PROVIDER,
  listOpenCodeGoModelDefinitions,
  supportsOpenCodeGoImageInput,
  type OpenCodeGoApi
} from "../lib/nobo-models.js";

const ANTHROPIC_BASE_URL = OPENCODE_GO_BASE_URL.replace(/\/v1$/, "");

// The installed pi catalog predates these models. Keep wire compatibility explicit
// until the upstream definitions include them. Sources: OpenCode Go and models.dev,
// checked 2026-09-22. Costs are baseline estimates, not peak/long-context billing.
const MODEL_METADATA: Record<string, Partial<Model<OpenCodeGoApi>>> = {
  "grok-4.7": {
    contextWindow: 500_000,
    maxTokens: 500_000,
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    thinkingLevelMap: {
      minimal: "low", low: "low", medium: "medium",
      high: "high", xhigh: "xhigh", max: "xhigh"
    }
  },
  "mimo-v2.6-flash": {
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true
    }
  },
  "mimo-v2.6-pro": {
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true
    }
  },
  "deepseek-v4.1-flash": {
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek"
    },
    thinkingLevelMap: {
      minimal: "low", low: "low", medium: "high",
      high: "high", xhigh: "max", max: "max"
    }
  }
};

export function registerNoboProvider() {
  setProvider(createNoboProvider());
}

export function createNoboProvider() {
  const builtInProvider = opencodeGoProvider();
  const builtInModels = new Map(
    builtInProvider.getModels().map((model) => [model.id, model])
  );
  const models = listOpenCodeGoModelDefinitions().map(({ id, name, api }) =>
    createOpenCodeGoModel({ id, name, api }, builtInModels.get(id))
  );

  return {
    ...builtInProvider,
    auth: {
      apiKey: envApiKeyAuth("OpenCode Go API key", [
        "OPENCODE_GO_API_KEY",
        "OPENCODE_API_KEY"
      ])
    },
    getModels: () => models
  };
}

export function getNoboModelSpecifier(modelId: string) {
  return `${OPENCODE_GO_PROVIDER}/${modelId}`;
}

function createOpenCodeGoModel(
  definition: { id: string; name: string; api: OpenCodeGoApi },
  builtIn: Model<OpenCodeGoApi> | undefined
): Model<OpenCodeGoApi> {
  const baseUrl =
    definition.api === "anthropic-messages" ? ANTHROPIC_BASE_URL : OPENCODE_GO_BASE_URL;

  if (builtIn) {
    return {
      ...builtIn,
      ...MODEL_METADATA[definition.id],
      ...definition,
      baseUrl,
      input: supportsOpenCodeGoImageInput(definition.id)
        ? ["text", "image"]
        : ["text"]
    };
  }

  return {
    ...definition,
    provider: OPENCODE_GO_PROVIDER,
    baseUrl,
    reasoning: true,
    input: supportsOpenCodeGoImageInput(definition.id) ? ["text", "image"] : ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262_144,
    maxTokens: 65_536,
    ...MODEL_METADATA[definition.id]
  };
}
