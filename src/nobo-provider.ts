import { registerProvider } from "@flue/runtime";
import {
  getOpenCodeGoModelApi,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_PROVIDER,
  type OpenCodeGoApi
} from "../lib/nobo-models.js";

const OPENCODE_GO_PROVIDER_BY_API: Record<OpenCodeGoApi, string> = {
  "anthropic-messages": `${OPENCODE_GO_PROVIDER}-anthropic`,
  "openai-completions": OPENCODE_GO_PROVIDER,
  "openai-responses": `${OPENCODE_GO_PROVIDER}-responses`
};

export function registerNoboProvider() {
  for (const [api, providerId] of Object.entries(OPENCODE_GO_PROVIDER_BY_API) as [
    OpenCodeGoApi,
    string
  ][]) {
    registerProvider(providerId, {
      api,
      baseUrl: OPENCODE_GO_BASE_URL,
      ...(process.env.OPENCODE_GO_API_KEY
        ? { apiKey: process.env.OPENCODE_GO_API_KEY }
        : {})
    });
  }
}

export function getNoboModelSpecifier(modelId: string) {
  const api = getOpenCodeGoModelApi(modelId) ?? "openai-completions";
  return `${OPENCODE_GO_PROVIDER_BY_API[api]}/${modelId}`;
}
