import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type ModelMessage } from "ai";

const SYSTEM_PROMPT = `You are Joshbot, a concise and pragmatic assistant.

You are replying inside Slack.

Rules:
- Be direct and helpful.
- Prefer short paragraphs or short flat lists.
- When the user asks for code, provide code that can be pasted directly.
- Do not claim to have done actions in Slack unless the app actually did them.
- If context is missing, make the smallest reasonable assumption and say so briefly.`;

function getModel() {
  const apiKey = process.env.OPENCODE_GO_API_KEY;

  if (!apiKey) {
    throw new Error("Missing required environment variable: OPENCODE_GO_API_KEY");
  }

  const provider = createOpenAICompatible({
    name: "opencode-go",
    apiKey,
    baseURL: "https://opencode.ai/zen/go/v1"
  });

  return provider(process.env.OPENCODE_GO_MODEL ?? "kimi-k2.6");
}

export async function createSlackReply(messages: ModelMessage[]) {
  const { text } = await generateText({
    model: getModel(),
    system: `${SYSTEM_PROMPT}

Extra Slack rules:
- Reply in plain text only.
- Keep formatting light.
- Aim for a response that fits naturally in a Slack thread.
- If the request is ambiguous, answer the likeliest interpretation instead of stalling.`,
    messages
  });

  return text.trim();
}
