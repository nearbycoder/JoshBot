import { AgentContextCapacityError, AGENT_CONTEXT_LIMITS, measureAgentContext, resolveAgentBudgets } from "./budgets.js";
import { AGENT_BUSY_MESSAGE, agentInvocationSignal, withAgentAdmission } from "./admission.js";
import { contextRead } from "./context/shared.js";
import { createHash } from "node:crypto";
import { AgentStateCorruptionError, createAgentFeatureStore, createAgentStateBackend, validateAgentIdentity, type AgentStateBackend } from "./store.js";
import type { AgentFeature, AgentFeatureServices, AgentFeatureStore } from "./types.js";

export type AgentFeatureOwner = { teamId?: string; userId?: string; channelId?: string; requestId?: string };
export type AgentRuntimeOptions = {
  backend?: AgentStateBackend;
  services: AgentFeatureServices;
  timezone: string;
  now?: Date;
  signal?: AbortSignal;
};

const abortable = <T>(work: () => Promise<T>, signal: AbortSignal) => contextRead(signal, work);

/** Private slash-command execution; this layer never posts Slack messages. */
export async function runAgentFeature(
  feature: AgentFeature,
  command: string,
  owner: AgentFeatureOwner,
  options: AgentRuntimeOptions,
): Promise<string> {
  validateAgentIdentity(owner);
  if (command.length > 48_000) return "This command is too long. Use at most 48,000 characters.";
  if (!command.trim() || command.trim().toLowerCase() === "help") return feature.help;
  const budgets = resolveAgentBudgets(feature.resourceBudgets);
  return withAgentAdmission(owner, async () => {
    // The caller supplies the original policy/startup deadline; never renew it.
    const signal = agentInvocationSignal(options.signal);
    signal.throwIfAborted();
    const backend = options.backend ?? await abortable(createAgentStateBackend, signal);
    signal.throwIfAborted();
    if (!backend) return "Personal agents need the existing Redis connection. Please try again when it is available.";
    // Keep the first diagnosis only for this invocation. Feature catch/fallback paths
    // cannot turn it into an empty result, retry loop, or subsequent service/write.
    let stateFailure: AgentStateCorruptionError | undefined;
    const checkState = () => { signal.throwIfAborted(); if (stateFailure) throw stateFailure; };
    const scopedStore = createAgentFeatureStore({
      async get(key) {
        checkState();
        const value = await backend.get(key);
        checkState();
        return value;
      },
      compareSet(key, previous, next, ttl) { checkState(); return backend.compareSet(key, previous, next, ttl); },
    }, owner, feature.id, signal, budgets);
    const stateOperation = async <T>(work: () => Promise<T>): Promise<T> => {
      checkState();
      try { return await work(); }
      catch (error) {
        if (error instanceof AgentStateCorruptionError) stateFailure ??= error;
        throw error;
      }
    };
    const store: AgentFeatureStore = {
      read: key => stateOperation(() => scopedStore.read(key)),
      update: (key, initial, transform) => stateOperation(() => scopedStore.update(key, initial, transform)),
    };

    // Retain only a request fingerprint/status, never private reply content. A crash
    // after a write must not cause Slack redelivery to execute that write again.
    let requestKey: string | undefined;
    let running: string | undefined;
    if (owner.requestId) {
      const fingerprint = createHash("sha256").update(owner.requestId).digest("hex");
      requestKey = `nobo:agent-requests:v1:${owner.teamId}:${owner.userId}:${feature.id}:${fingerprint}`;
      running = JSON.stringify({ state: "started", commandHash: createHash("sha256").update(command).digest("hex") });
      const received = await abortable(() => backend.compareSet(requestKey!, null, running!, 86_400), signal);
      signal.throwIfAborted();
      if (!received) {
        return "This request was already received. Use this agent's list, show, or status command to check its result.";
      }
    }

    let generations = 0;
    let searches = 0;
    let contextReads = 0;
    let contextBytes = 0;
    let pendingContext = false;
    const services: AgentFeatureServices = {
      generate: async (input) => {
        checkState();
        if (++generations > budgets.generations) throw new Error(`This command reached its limit of ${budgets.generations === 8 ? "eight" : budgets.generations} generation steps.`);
        if (input.instructions.length > 24_000 || input.input.length > 80_000) throw new Error("Too much source material for one generation step.");
        const output = await abortable(() => options.services.generate(input), signal);
        signal.throwIfAborted();
        if (!output.trim() || output.length > 28_000) throw new Error("The model returned an empty or oversized result. Try a smaller request.");
        return output;
      },
      search: async (query, limit = 5) => {
        checkState();
        if (++searches > budgets.searches) throw new Error(`This command reached its limit of ${budgets.searches === 6 ? "six" : budgets.searches} web searches.`);
        if (!query.trim() || query.length > 2_000) throw new Error("Search queries must contain 1–2,000 characters.");
        const count = Number.isFinite(limit) ? Math.max(1, Math.min(8, Math.floor(limit))) : 5;
        const results = await abortable(() => options.services.search(query, count), signal);
        signal.throwIfAborted();
        return results.slice(0, count).filter((result) => {
          try { const url = new URL(result.url); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; }
          catch { return false; }
        }).map((result) => ({ ...result, title: result.title.slice(0, 300), text: result.text.slice(0, 8_000) }));
      },
      readContext: async (kinds) => {
        checkState();
        if (pendingContext) throw new Error("Read personal context sequentially; another source read is still running.");
        if (++contextReads > budgets.contextReads) throw new Error(`This command reached its limit of ${budgets.contextReads} context reads.`);
        pendingContext = true;
        {
          const items = await abortable(() => Promise.resolve().then(() => options.services.readContext(kinds)).finally(() => { pendingContext = false; }), signal);
          signal.throwIfAborted();
          contextBytes += measureAgentContext(items);
          if (contextBytes > AGENT_CONTEXT_LIMITS.invocationBytes) throw new AgentContextCapacityError("This command reached its total context byte budget (32 MiB). Request fewer source kinds, then retry; no sources were truncated.");
          return items;
        }
      },
    };
    try {
      const result = await abortable(() => feature.execute(command.trim(), {
        ...owner,
        teamId: owner.teamId,
        userId: owner.userId,
        now: options.now ?? new Date(),
        timezone: options.timezone,
        signal,
        store,
        services,
      }), signal);
      signal.throwIfAborted();
      if (stateFailure) return stateFailure.message;
      if (typeof result !== "string" || !result.trim()) throw new Error("The personal agent did not return a result.");
      if (result.length > 28_000) return result.slice(0, 27_850) + "\n\nOutput shortened. Use show or export for a specific item.";
      return result;
    } catch (error) {
      signal.throwIfAborted();
      // Return a private, actionable reply: outer Slack handlers hide thrown errors.
      if (stateFailure) return stateFailure.message;
      throw error;
    } finally {
      if (requestKey && running) {
        // Failure to finalize is not a reason to repeat feature mutations. The
        // original 'started' receipt still suppresses duplicate delivery.
        if (!signal.aborted) await abortable(() => backend.compareSet(requestKey!, running!, JSON.stringify({ state: "finished" }), 86_400), signal).catch(() => {});
      }
    }
  }, () => AGENT_BUSY_MESSAGE);
}
