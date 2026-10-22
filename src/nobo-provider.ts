import { setProvider } from "@flue/runtime";
import { envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import {
  getOpenCodeGoModelBaseUrl,
  OPENCODE_GO_PROVIDER,
  listOpenCodeGoModelDefinitions,
  supportsOpenCodeGoImageInput,
  type OpenCodeGoApi
} from "../lib/nobo-models.js";

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
  const baseUrl = getOpenCodeGoModelBaseUrl(definition.id);
  if (!builtIn || !baseUrl) {
    throw new Error(`OpenCode Go model ${definition.id} is missing SDK metadata`);
  }

  // Keep upstream context limits, prices, pricing tiers, and wire compatibility.
  // The local catalog controls availability, display names, and verified image support.
  return {
    ...builtIn,
    ...definition,
    baseUrl,
    // MiMo supports reasoning but exposes no effort control. Preserve the other
    // SDK compatibility fields while omitting an unsupported wire parameter.
    ...(["mimo-v2.6-flash", "mimo-v2.6-pro"].includes(definition.id) ? {
      compat: { ...builtIn.compat, supportsReasoningEffort: false }
    } : {}),
    input: supportsOpenCodeGoImageInput(definition.id) ? ["text", "image"] : ["text"]
  };
}
