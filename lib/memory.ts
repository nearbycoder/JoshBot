import { getRedisClient } from "./redis.js";

const DEFAULT_MEMORY_MAX_ITEMS = 20;

export type ChannelMemorySettings = {
  activeListening: boolean;
};

export type ChannelMemoryEntry = {
  role: "user" | "assistant";
  content: string;
  ts?: string;
  threadTs?: string;
  userId?: string;
};

type ChannelMemoryState = {
  memories: ChannelMemoryEntry[];
  settings: ChannelMemorySettings;
};

const DEFAULT_CHANNEL_MEMORY_SETTINGS: ChannelMemorySettings = {
  activeListening: false
};

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
  const match = findMemoryMatch(memories, memory);

  if (match.status === "ambiguous") {
    return {
      ok: true as const,
      status: "ambiguous" as const,
      memories,
      matches: match.matches
    };
  }

  if (match.status === "missing") {
    return {
      ok: true as const,
      status: "missing" as const,
      memories
    };
  }

  const filtered = memories.filter((_entry, index) => index !== match.index);

  await saveUserMemories(userId, filtered);

  return {
    ok: true as const,
    status: "removed" as const,
    memories: filtered,
    removed: match.memory
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

export async function getChannelMemories(channelId: string) {
  const state = await getChannelMemoryState(channelId);
  return state.memories;
}

export async function getChannelMemorySettings(channelId: string) {
  const state = await getChannelMemoryState(channelId);
  return state.settings;
}

export async function toggleChannelActiveListening(channelId: string) {
  const redis = await getRedisClient();

  if (!redis) {
    return {
      ok: false as const,
      reason: "Redis is not configured."
    };
  }

  const state = await getChannelMemoryState(channelId);
  const settings = {
    ...state.settings,
    activeListening: !state.settings.activeListening
  };
  await saveChannelMemoryState(channelId, {
    ...state,
    settings
  });

  return {
    ok: true as const,
    settings
  };
}

export async function setChannelActiveListening(channelId: string, activeListening: boolean) {
  const redis = await getRedisClient();

  if (!redis) {
    return {
      ok: false as const,
      reason: "Redis is not configured."
    };
  }

  const state = await getChannelMemoryState(channelId);
  const settings = {
    ...state.settings,
    activeListening
  };
  await saveChannelMemoryState(channelId, {
    ...state,
    settings
  });

  return {
    ok: true as const,
    settings
  };
}

export async function appendChannelMemory(
  channelId: string,
  entries: ChannelMemoryEntry | ChannelMemoryEntry[]
) {
  const redis = await getRedisClient();

  if (!redis) {
    return {
      ok: false as const,
      reason: "Redis is not configured."
    };
  }

  const nextEntries = (Array.isArray(entries) ? entries : [entries])
    .map(normalizeChannelMemoryEntry)
    .filter((entry): entry is ChannelMemoryEntry => entry !== null);

  if (nextEntries.length === 0) {
    return {
      ok: true as const,
      status: "empty" as const,
      memories: (await getChannelMemoryState(channelId)).memories
    };
  }

  const state = await getChannelMemoryState(channelId);
  const nextMemories = [...state.memories, ...nextEntries];
  await saveChannelMemoryState(channelId, {
    ...state,
    memories: nextMemories
  });

  return {
    ok: true as const,
    status: "added" as const,
    memories: nextMemories
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

function getChannelMemoryKey(channelId: string) {
  return `slack-channel-memory:${channelId}`;
}

async function getChannelMemoryState(channelId: string): Promise<ChannelMemoryState> {
  const redis = await getRedisClient();

  if (!redis) {
    return createEmptyChannelMemoryState();
  }

  const payload = await redis.get(getChannelMemoryKey(channelId));

  if (!payload) {
    return createEmptyChannelMemoryState();
  }

  return parseChannelMemoryState(payload);
}

async function saveChannelMemoryState(channelId: string, state: ChannelMemoryState) {
  const redis = await getRedisClient();

  if (!redis) {
    return;
  }

  await redis.set(getChannelMemoryKey(channelId), JSON.stringify(state));
}

function createEmptyChannelMemoryState(): ChannelMemoryState {
  return {
    memories: [],
    settings: { ...DEFAULT_CHANNEL_MEMORY_SETTINGS }
  };
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

function simplify(value: string) {
  return normalize(value)
    .replace(/[`"'“”‘’()[\]{}.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findMemoryMatch(memories: string[], query: string) {
  const trimmedQuery = query.trim();
  const indexMatch = trimmedQuery.match(/^#?(\d+)$/);

  if (indexMatch) {
    const index = Number(indexMatch[1]) - 1;

    if (index >= 0 && index < memories.length) {
      return {
        status: "removed" as const,
        index,
        memory: memories[index]
      };
    }
  }

  const normalizedQuery = normalize(trimmedQuery);
  const exactIndex = memories.findIndex((entry) => normalize(entry) === normalizedQuery);

  if (exactIndex >= 0) {
    return {
      status: "removed" as const,
      index: exactIndex,
      memory: memories[exactIndex]
    };
  }

  const simplifiedQuery = simplify(trimmedQuery);
  const partialMatches = memories
    .map((entry, index) => ({ entry, index, simplified: simplify(entry) }))
    .filter(({ simplified }) =>
      simplifiedQuery.length > 0 &&
      (simplified.includes(simplifiedQuery) || simplifiedQuery.includes(simplified))
    );

  if (partialMatches.length === 1) {
    return {
      status: "removed" as const,
      index: partialMatches[0].index,
      memory: partialMatches[0].entry
    };
  }

  if (partialMatches.length > 1) {
    return {
      status: "ambiguous" as const,
      matches: partialMatches.map(({ entry, index }) => ({
        index,
        memory: entry
      }))
    };
  }

  return {
    status: "missing" as const
  };
}

function parseChannelMemoryPayload(payload: string) {
  return parseChannelMemoryState(payload).memories;
}

function parseChannelMemoryState(payload: string): ChannelMemoryState {
  try {
    const parsed = JSON.parse(payload) as { memories?: unknown; settings?: unknown };

    const memories = Array.isArray(parsed.memories)
      ? parsed.memories
          .map(normalizeChannelMemoryEntry)
          .filter((entry): entry is ChannelMemoryEntry => entry !== null)
      : [];

    return {
      memories,
      settings: normalizeChannelMemorySettings(parsed.settings)
    };
  } catch {
    return createEmptyChannelMemoryState();
  }
}

function normalizeChannelMemorySettings(input: unknown): ChannelMemorySettings {
  if (typeof input !== "object" || input === null) {
    return { ...DEFAULT_CHANNEL_MEMORY_SETTINGS };
  }

  const record = input as Partial<Record<keyof ChannelMemorySettings, unknown>>;

  return {
    activeListening:
      typeof record.activeListening === "boolean"
        ? record.activeListening
        : DEFAULT_CHANNEL_MEMORY_SETTINGS.activeListening
  };
}

function normalizeChannelMemoryEntry(input: unknown): ChannelMemoryEntry | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const entry = input as Partial<Record<keyof ChannelMemoryEntry, unknown>>;
  const role = entry.role;
  const content = typeof entry.content === "string" ? entry.content.trim() : "";

  if ((role !== "user" && role !== "assistant") || !content) {
    return null;
  }

  return {
    role,
    content,
    ...(typeof entry.ts === "string" ? { ts: entry.ts } : {}),
    ...(typeof entry.threadTs === "string" ? { threadTs: entry.threadTs } : {}),
    ...(typeof entry.userId === "string" ? { userId: entry.userId } : {})
  };
}

export const __testing = {
  getChannelMemoryKey,
  parseChannelMemoryPayload,
  parseChannelMemoryState
};
