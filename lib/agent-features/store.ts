import { resolveAgentBudgets } from "./budgets.js";
import { contextRead } from "./context/shared.js";
import { getRedisClient } from "../redis.js";
import type { AgentFeatureStore, AgentFeatureResourceBudgets } from "./types.js";

export interface AgentStateBackend {
  get(key: string): Promise<string | null>;
  compareSet(key: string, previous: string | null, next: string, ttlSeconds?: number): Promise<boolean>;
}

const CAS = `
local old=redis.call('GET',KEYS[1])
if ARGV[1]=='missing' then
  if old then return 0 end
elseif not old or old~=ARGV[2] then return 0 end
if tonumber(ARGV[4])>0 then
  redis.call('SET',KEYS[1],ARGV[3],'EX',ARGV[4])
else redis.call('SET',KEYS[1],ARGV[3]) end
return 1`;

export async function createAgentStateBackend(): Promise<AgentStateBackend | null> {
  const redis = await getRedisClient();
  if (!redis) return null;
  return {
    get: (key) => redis.get(key),
    compareSet: async (key, previous, next, ttlSeconds = 0) =>
      (await redis.eval(CAS, {
        keys: [key],
        arguments: [previous === null ? "missing" : "present", previous ?? "", next, String(ttlSeconds)],
      })) === 1,
  };
}

export function validateAgentIdentity<T extends { teamId?: string; userId?: string }>(owner: T): asserts owner is T & { teamId: string; userId: string } {
  if (!owner.teamId || !owner.userId || !/^[A-Z0-9]{2,32}$/.test(owner.teamId) || !/^[A-Z0-9]{2,32}$/.test(owner.userId)) {
    throw new Error("Personal agents need a signed Slack workspace and user context.");
  }
}

export function agentStorePrefix(owner: { teamId: string; userId: string }, featureId: string) {
  validateAgentIdentity(owner);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(featureId)) throw new Error("Invalid personal agent ID.");
  return `nobo:agents:v1:${owner.teamId}:${owner.userId}:${featureId}:`;
}

export function createAgentFeatureStore(
  backend: AgentStateBackend,
  owner: { teamId: string; userId: string },
  featureId: string,
  signal?: AbortSignal,
  limits?: Pick<AgentFeatureResourceBudgets, "storeReads" | "storeUpdates">,
): AgentFeatureStore {
  const prefix = agentStorePrefix(owner, featureId);
  const budgets = resolveAgentBudgets(limits);
  let reads = 0, updates = 0;
  const scopedKey = (key: string) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(key)) throw new Error("Invalid personal agent storage key.");
    return prefix + key;
  };
  const parse = <T>(raw: string): T => {
    if (Buffer.byteLength(raw) > 512_000) throw new Error("Personal agent data exceeds the storage limit.");
    return JSON.parse(raw) as T;
  };
  return {
    async read<T>(key: string) {
      signal?.throwIfAborted();
      if (++reads > budgets.storeReads) throw new Error(`This command reached its limit of ${budgets.storeReads} state reads.`);
      const raw = await contextRead(signal, () => backend.get(scopedKey(key)));
      signal?.throwIfAborted();
      return raw === null ? null : parse<T>(raw);
    },
    async update<T, R>(key: string, initial: T, transform: (current: T) => { value: T; result: R }): Promise<R> {
      signal?.throwIfAborted();
      if (++updates > budgets.storeUpdates) throw new Error(`This command reached its limit of ${budgets.storeUpdates} state updates.`);
      const fullKey = scopedKey(key);
      for (let attempt = 0; attempt < 32; attempt++) {
        signal?.throwIfAborted();
        const previous = await contextRead(signal, () => backend.get(fullKey));
        signal?.throwIfAborted();
        const current = parse<T>(previous ?? JSON.stringify(initial));
        const next = transform(current);
        if (!next || typeof next !== "object" || !("value" in next)) throw new Error("Invalid personal agent state update.");
        const encoded = JSON.stringify(next.value);
        if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 512_000) {
          throw new Error("Personal agent storage is full. Export or remove older entries first.");
        }
        signal?.throwIfAborted();
        if (encoded === previous || await contextRead(signal, () => backend.compareSet(fullKey, previous, encoded))) return next.result;
      }
      throw new Error("Your data changed repeatedly while saving. Please retry this command.");
    },
  };
}
