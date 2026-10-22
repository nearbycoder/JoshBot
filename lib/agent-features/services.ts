import { Exa } from "exa-js";
import { createPersonalAgentText } from "../ai.js";
import { readAgentToolboxContext } from "./context.js";
import type { AgentStateBackend } from "./store.js";
import type { AgentFeatureServices } from "./types.js";

export function createAgentFeatureServices(
  backend: AgentStateBackend,
  owner: { teamId: string; userId: string; channelId?: string },
  signal: AbortSignal,
): AgentFeatureServices {
  return {
    generate: ({ instructions, input }) => createPersonalAgentText({ ...owner, instructions, input, signal }),
    search: async (query, limit = 5) => {
      signal.throwIfAborted();
      if (!process.env.EXA_API_KEY) throw new Error("Web search requires the configured Exa integration.");
      const exa = new Exa(process.env.EXA_API_KEY);
      const response = await exa.search(query, { type: "auto", numResults: limit, contents: { highlights: true } });
      signal.throwIfAborted();
      return response.results.map((result) => ({
        title: result.title ?? result.url, url: result.url,
        text: (result.highlights ?? []).join("\n"), publishedAt: result.publishedDate,
      }));
    },
    readContext: (kinds) => readAgentToolboxContext(backend, owner, kinds),
  };
}
