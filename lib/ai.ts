import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Exa } from "exa-js";
import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { z } from "zod";

const SYSTEM_PROMPT = `You are Joshbot, a concise and pragmatic assistant.

You are replying inside Slack.

Rules:
- Be direct and helpful.
- Prefer short paragraphs or short flat lists.
- When the user asks for code, provide code that can be pasted directly.
- Do not claim to have done actions in Slack unless the app actually did them.
- If context is missing, make the smallest reasonable assumption and say so briefly.
- Use web search when the request depends on recent, fast-changing, or hard-to-recall facts.
- When web search is used, ground the answer in the retrieved sources instead of guessing.`;

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
  const result = await generateText({
    model: getModel(),
    system: `${SYSTEM_PROMPT}

Extra Slack rules:
- Reply in plain text only.
- Keep formatting light.
- Aim for a response that fits naturally in a Slack thread.
- If the request is ambiguous, answer the likeliest interpretation instead of stalling.
- If you use web search, end with a short 'Sources:' list using the URLs you relied on.`,
    messages,
    tools: process.env.EXA_API_KEY ? { webSearch: createExaSearchTool() } : undefined,
    stopWhen: stepCountIs(5)
  });

  return result.text.trim();
}

function createExaSearchTool() {
  const apiKey = process.env.EXA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing required environment variable: EXA_API_KEY");
  }

  const exa = new Exa(apiKey);

  return tool({
    description:
      "Search the web with Exa for recent or hard-to-recall facts. Prefer type='auto'. Use livecrawl only when you need the freshest content.",
    inputSchema: z.object({
      query: z.string().min(1).describe("The web search query."),
      type: z
        .enum(["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"])
        .optional()
        .describe("Exa search type. Default to auto unless latency or depth is important."),
      includeDomains: z
        .array(z.string())
        .max(10)
        .optional()
        .describe("Optional domains to include, e.g. ['arxiv.org', 'github.com']."),
      excludeDomains: z
        .array(z.string())
        .max(10)
        .optional()
        .describe("Optional domains to exclude."),
      livecrawl: z
        .boolean()
        .optional()
        .describe("Set true only when you need the freshest page content.")
    }),
    execute: async ({ query, type, includeDomains, excludeDomains, livecrawl }) => {
      const response = await exa.search(query, {
        type: type ?? "auto",
        numResults: 5,
        includeDomains,
        excludeDomains,
        contents: {
          highlights: true,
          ...(livecrawl ? { maxAgeHours: 0 } : {})
        }
      });

      return {
        results: response.results.map((result) => ({
          title: result.title,
          url: result.url,
          publishedDate: result.publishedDate ?? null,
          author: result.author ?? null,
          highlights: (result.highlights ?? []).slice(0, 3)
        }))
      };
    }
  });
}
