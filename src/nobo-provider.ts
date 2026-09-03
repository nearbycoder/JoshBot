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
    maxTokens: 65_536
  };
}
