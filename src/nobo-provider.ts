import { registerProvider } from "@flue/runtime";

const OPENCODE_GO_PROVIDER = "opencode-go";
const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

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
