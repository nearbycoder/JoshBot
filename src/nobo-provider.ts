import { registerProvider } from "@flue/runtime";
import { OPENCODE_GO_BASE_URL, OPENCODE_GO_PROVIDER } from "../lib/nobo-models.js";

export function registerNoboProvider() {
  registerProvider(OPENCODE_GO_PROVIDER, {
    api: "openai-completions",
    baseUrl: OPENCODE_GO_BASE_URL,
    ...(process.env.OPENCODE_GO_API_KEY ? { apiKey: process.env.OPENCODE_GO_API_KEY } : {})
  });
}

export function getNoboModelSpecifier(modelId: string) {
  return `${OPENCODE_GO_PROVIDER}/${modelId}`;
}
