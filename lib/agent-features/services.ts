import type { evaluateNoboAccess } from "../access-controls.js";
import { getRedisClient } from "../redis.js";
import type { AgentContextAdapters, AgentContextRequest } from "./context.js";
import { contextRead } from "./context/shared.js";
import { AgentContextCapacityError } from "./budgets.js";
import type { AgentStateBackend } from "./store.js";
import type { AgentFeatureServices } from "./types.js";

type IndexRedis = { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> };
const BOUNDED_OWNER_INDEX = `
if redis.call('SCARD',KEYS[1]) > tonumber(ARGV[1]) then return false end
return redis.call('SMEMBERS',KEYS[1])`;

/** Atomic cardinality guard: no global scan or unbounded SMEMBERS response. */
export function createProductionContextAdapters(dependencies: {
  redis?: () => Promise<IndexRedis | null>;
  evaluateAccess?: typeof evaluateNoboAccess;
} = {}): AgentContextAdapters {
  return {
    async readOwnerIndex(key, limit, signal) {
      if (!/^(follow-ups|schedules|monitors|channel-digests):user:[A-Z0-9]{2,32}$/.test(key) ||
          !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid personal owner-index request.");
      const redis = await contextRead(signal, dependencies.redis ?? getRedisClient);
      if (!redis) throw new Error("Personal automation context requires the existing Redis connection.");
      const ids = await contextRead(signal, () => redis.eval(BOUNDED_OWNER_INDEX, { keys: [key], arguments: [String(limit)] }));
      if (!Array.isArray(ids)) throw new AgentContextCapacityError(`Personal owner index exceeds the complete-read limit (${limit}).`);
      return ids;
    },
    async authorizeChannel(owner, signal) {
      const access = await contextRead(signal, async () => (dependencies.evaluateAccess ?? (await import("../access-controls.js")).evaluateNoboAccess)({
        ...owner, action: "personal_agent_context", surface: "slack-command",
      }));
      if (!access.allowed) throw new Error("Access to personal context in this channel is denied.");
    },
  };
}

export function createAgentFeatureServices(
  backend: AgentStateBackend,
  owner: { teamId: string; userId: string; channelId?: string },
  signal: AbortSignal,
  request: Omit<AgentContextRequest, "signal">,
  adapters: AgentContextAdapters = createProductionContextAdapters(),
): AgentFeatureServices {
  return {
    generate: async ({ instructions, input }) => {
      const { createPersonalAgentText } = await contextRead(signal, () => import("../ai.js"));
      return contextRead(signal, () => createPersonalAgentText({ ...owner, instructions, input, signal }));
    },
    search: async (query, limit = 5) => {
      signal.throwIfAborted();
      if (!process.env.EXA_API_KEY) throw new Error("Web search requires the configured Exa integration.");
      const { Exa } = await contextRead(signal, () => import("exa-js"));
      const exa = new Exa(process.env.EXA_API_KEY);
      const count = Number.isFinite(limit) ? Math.max(1, Math.min(8, Math.floor(limit))) : 5;
      const response = await contextRead(signal, () => exa.search(query, { type: "auto", numResults: count, contents: { highlights: true } }, { signal }));
      signal.throwIfAborted();
      return response.results.slice(0, count).map((result) => ({
        title: result.title ?? result.url, url: result.url,
        text: (result.highlights ?? []).join("\n"), publishedAt: result.publishedDate,
      }));
    },
    readContext: async (kinds) => {
      const { readAgentOwnedContext } = await contextRead(signal, () => import("./context.js"));
      return contextRead(signal, () => readAgentOwnedContext(backend, owner, { ...request, signal }, adapters, kinds));
    },
  };
}
