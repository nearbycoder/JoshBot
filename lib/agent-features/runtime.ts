import { createHash } from "node:crypto";
import { createAgentFeatureStore, createAgentStateBackend, validateAgentIdentity, type AgentStateBackend } from "./store.js";
import type { AgentFeature, AgentFeatureServices } from "./types.js";

export type AgentFeatureOwner = { teamId?: string; userId?: string; channelId?: string; requestId?: string };
export type AgentRuntimeOptions = {
  backend?: AgentStateBackend;
  services: AgentFeatureServices;
  timezone: string;
  now?: Date;
  signal?: AbortSignal;
};

/** Stop waiting promptly; consume late rejections and keep signal-based write guards. */
function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

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
  const timeout = AbortSignal.timeout(120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  const backend = options.backend ?? await abortable(createAgentStateBackend, signal);
  signal.throwIfAborted();
  if (!backend) return "Personal agents need the existing Redis connection. Please try again when it is available.";
  const store = createAgentFeatureStore(backend, owner, feature.id, signal);

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
  const services: AgentFeatureServices = {
    generate: async (input) => {
      signal.throwIfAborted();
      if (++generations > 8) throw new Error("This command reached its limit of eight generation steps.");
      if (input.instructions.length > 24_000 || input.input.length > 80_000) throw new Error("Too much source material for one generation step.");
      const output = await abortable(() => options.services.generate(input), signal);
      signal.throwIfAborted();
      if (!output.trim() || output.length > 28_000) throw new Error("The model returned an empty or oversized result. Try a smaller request.");
      return output;
    },
    search: async (query, limit = 5) => {
      signal.throwIfAborted();
      if (++searches > 6) throw new Error("This command reached its limit of six web searches.");
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
      signal.throwIfAborted();
      const items = await abortable(() => options.services.readContext(kinds), signal);
      signal.throwIfAborted();
      return items;
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
    if (typeof result !== "string" || !result.trim()) throw new Error("The personal agent did not return a result.");
    if (result.length > 28_000) return result.slice(0, 27_850) + "\n\nOutput shortened. Use show or export for a specific item.";
    return result;
  } finally {
    if (requestKey && running) {
      // Failure to finalize is not a reason to repeat feature mutations. The
      // original 'started' receipt still suppresses duplicate delivery.
      if (!signal.aborted) await abortable(() => backend.compareSet(requestKey!, running!, JSON.stringify({ state: "finished" }), 86_400), signal).catch(() => {});
    }
  }
}
