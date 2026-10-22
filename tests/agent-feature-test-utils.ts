import type {
  AgentFeatureContext,
  AgentFeatureStore,
} from "../lib/agent-features/types.js";

/** Isolated test store. JSON cloning matches persistent-store value semantics. */
export function createAgentTestStore(): AgentFeatureStore {
  const records = new Map<string, string>();
  return {
    async read<T>(key: string): Promise<T | null> {
      const raw = records.get(key);
      return raw === undefined ? null : JSON.parse(raw) as T;
    },
    async update<T, R>(key: string, initial: T, transform: (value: T) => { value: T; result: R }): Promise<R> {
      const raw = records.get(key);
      const current = JSON.parse(raw ?? JSON.stringify(initial)) as T;
      const next = transform(current);
      records.set(key, JSON.stringify(next.value));
      return next.result;
    },
  };
}

export function createAgentTestContext(
  overrides: Partial<AgentFeatureContext> = {},
): AgentFeatureContext {
  return {
    teamId: "TTEST",
    userId: "UTEST",
    now: new Date("2026-10-22T15:00:00Z"),
    timezone: "America/Chicago",
    store: createAgentTestStore(),
    services: {
      generate: async () => { throw new Error("Inject a fake generator in this test."); },
      search: async () => { throw new Error("Inject a fake search provider in this test."); },
      readContext: async () => [],
    },
    ...overrides,
  };
}
