import { agentStorePrefix, createAgentFeatureStore, type AgentStateBackend } from "../../lib/agent-features/store.js";
import { runAgentFeature, type AgentFeatureOwner } from "../../lib/agent-features/runtime.js";
import type { AgentFeature, AgentFeatureServices } from "../../lib/agent-features/types.js";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Hooks may pause I/O or inject contention; comparison itself always stays exact. */
export function createMemoryAgentBackend(options: {
  clock?: () => number;
  beforeGet?: (key: string) => void | Promise<void>;
  beforeCompareSet?: (key: string, previous: string | null, next: string) => void | Promise<void>;
} = {}) {
  const data = new Map<string, string>(), expiresAt = new Map<string, number>();
  const calls = { gets: 0, compareSets: 0, writes: 0, conflicts: 0 };
  const current = (key: string) => {
    if ((expiresAt.get(key) ?? Infinity) <= (options.clock?.() ?? 0)) { data.delete(key); expiresAt.delete(key); }
    return data.get(key) ?? null;
  };
  const backend: AgentStateBackend = {
    async get(key) { calls.gets++; await options.beforeGet?.(key); return current(key); },
    async compareSet(key, previous, next, ttlSeconds = 0) {
      calls.compareSets++;
      await options.beforeCompareSet?.(key, previous, next);
      if (current(key) !== previous) { calls.conflicts++; return false; }
      data.set(key, next); calls.writes++;
      if (ttlSeconds > 0) expiresAt.set(key, (options.clock?.() ?? 0) + ttlSeconds * 1_000);
      else expiresAt.delete(key);
      return true;
    },
  };
  return { ...backend, data, expiresAt, calls };
}

type Owner = { teamId: string; userId: string; channelId?: string; requestId?: string };
export type FeatureFixtureOptions = {
  owner?: Owner;
  now?: Date | (() => Date);
  timezone?: string;
  services?: Partial<AgentFeatureServices>;
  backend?: ReturnType<typeof createMemoryAgentBackend>;
};

/** No live services, fallback aliases, or substitute store implementation. */
export function createAgentFeatureFixture(feature: AgentFeature, options: FeatureFixtureOptions = {}) {
  const owner = options.owner ?? { teamId: "TFIXTURE", userId: "UFIXTURE", channelId: "CFIXTURE" };
  const now = () => new Date(typeof options.now === "function" ? options.now().getTime() : (options.now ?? new Date("2026-10-22T15:00:00Z")).getTime());
  const backend = options.backend ?? createMemoryAgentBackend({ clock: () => now().getTime() });
  const calls = { generate: 0, search: 0, readContext: 0 };
  const services: AgentFeatureServices = {
    async generate(input) { calls.generate++; if (!options.services?.generate) throw new Error("Unexpected generate call in fixture."); return options.services.generate(input); },
    async search(query, limit) { calls.search++; if (!options.services?.search) throw new Error("Unexpected search call in fixture."); return options.services.search(query, limit); },
    async readContext(kinds) { calls.readContext++; if (!options.services?.readContext) throw new Error("Unexpected readContext call in fixture."); return options.services.readContext(kinds); },
  };
  const store = (scope: Owner = owner) => createAgentFeatureStore(backend, scope, feature.id);
  const run = (command: string, invocation: { owner?: AgentFeatureOwner; requestId?: string; signal?: AbortSignal } = {}) => runAgentFeature(
    feature, command, { ...owner, ...invocation.owner, ...(invocation.requestId === undefined ? {} : { requestId: invocation.requestId }) },
    { backend, services, now: now(), timezone: options.timezone ?? "America/Chicago", signal: invocation.signal },
  );
  return { backend, owner, calls, services, store, run,
    /** Seed corrupt raw JSON only for preservation tests; normal setup uses store().update. */
    key: (key: string, scope: Owner = owner) => agentStorePrefix(scope, feature.id) + key,
  };
}
