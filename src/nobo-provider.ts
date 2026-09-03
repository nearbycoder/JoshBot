import { setProvider } from "@flue/runtime";
import { envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_PROVIDER,
  listOpenCodeGoModelDefinitions,
  type OpenCodeGoApi
} from "../lib/nobo-models.js";

const ANTHROPIC_BASE_URL = OPENCODE_GO_BASE_URL.replace(/\/v1$/, "");
const VISION_MODELS = new Set([
  "deepseek-v4-flash-vision-exp",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k3",
  "minimax-m3",
  "mimo-v2.5",
  "qwen3.6-plus",
  "qwen3.7-plus"
]);

export function registerNoboProvider() {
  const builtInProvider = opencodeGoProvider();
  const builtInModels = new Map(
    builtInProvider.getModels().map((model) => [model.id, model])
  );
  const models = listOpenCodeGoModelDefinitions().map(({ id, name, api }) =>
    createOpenCodeGoModel({ id, name, api }, builtInModels.get(id))
  );

  setProvider({
    ...builtInProvider,
    auth: {
      apiKey: envApiKeyAuth("OpenCode Go API key", [
        "OPENCODE_GO_API_KEY",
        "OPENCODE_API_KEY"
      ])
    },
    getModels: () => models
  });
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
      ...definition,
      baseUrl
    };
  }

  return {
    ...definition,
    provider: OPENCODE_GO_PROVIDER,
    baseUrl,
    reasoning: true,
    input: VISION_MODELS.has(definition.id) ? ["text", "image"] : ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262_144,
    maxTokens: 65_536
  };
}
