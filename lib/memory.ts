import { getRedisClient } from "./redis.js";

const DEFAULT_MEMORY_MAX_ITEMS = 20;

export async function getUserMemories(userId: string) {
  const redis = await getRedisClient();

  if (!redis) {
    return [];
  }

  const payload = await redis.get(getMemoryKey(userId));

  if (!payload) {
    return [];
  }

  const parsed = JSON.parse(payload) as { memories?: string[] };

  if (!Array.isArray(parsed.memories)) {
    return [];
  }

  return parsed.memories.filter((memory): memory is string => typeof memory === "string");
}

export async function addUserMemory(userId: string, memory: string) {
  const redis = await getRedisClient();

  if (!redis) {
    return {
      ok: false as const,
      reason: "Redis is not configured."
    };
  }

  const nextMemory = memory.trim();

  if (!nextMemory) {
    return {
      ok: false as const,
      reason: "Memory cannot be empty."
    };
  }

  const memories = await getUserMemories(userId);
  const exists = memories.some((entry) => normalize(entry) === normalize(nextMemory));

  if (exists) {
    return {
      ok: true as const,
      status: "exists" as const,
      memories
    };
  }

  const trimmed = [...memories, nextMemory].slice(-getMemoryMaxItems());
  await saveUserMemories(userId, trimmed);

  return {
    ok: true as const,
    status: "added" as const,
    memories: trimmed
  };
}

export async function removeUserMemory(userId: string, memory: string) {
  const redis = await getRedisClient();

  if (!redis) {
    return {
      ok: false as const,
      reason: "Redis is not configured."
    };
  }

  const memories = await getUserMemories(userId);
  const filtered = memories.filter((entry) => normalize(entry) !== normalize(memory));

  if (filtered.length === memories.length) {
    return {
      ok: true as const,
      status: "missing" as const,
      memories
    };
  }

  await saveUserMemories(userId, filtered);

  return {
    ok: true as const,
    status: "removed" as const,
    memories: filtered
  };
}

export async function clearUserMemories(userId: string) {
  const redis = await getRedisClient();

  if (!redis) {
    return {
      ok: false as const,
      reason: "Redis is not configured."
    };
  }

  await redis.del(getMemoryKey(userId));

  return {
    ok: true as const
  };
}

async function saveUserMemories(userId: string, memories: string[]) {
  const redis = await getRedisClient();

  if (!redis) {
    return;
  }

  await redis.set(getMemoryKey(userId), JSON.stringify({ memories }));
}

function getMemoryKey(userId: string) {
  return `slack-memory:user:${userId}`;
}

function getMemoryMaxItems() {
  const rawValue = process.env.MEMORY_MAX_ITEMS;
  const parsedValue = Number(rawValue);

  if (!rawValue || !Number.isInteger(parsedValue) || parsedValue < 1) {
    return DEFAULT_MEMORY_MAX_ITEMS;
  }

  return parsedValue;
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}
