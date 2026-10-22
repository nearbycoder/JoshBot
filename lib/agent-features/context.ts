import type { AgentContextItem, AgentContextKind } from "./types.js";
import type { AgentStateBackend } from "./store.js";
import { validateAgentIdentity } from "./store.js";

const TOOLBOX_SOURCES = [
  ["notes", "note"], ["goals", "goal"], ["habits", "habit"],
  ["journal", "journal"], ["bookmarks", "bookmark"],
] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Reads only the caller's existing private toolbox namespaces. */
export async function readAgentToolboxContext(
  backend: AgentStateBackend,
  owner: { teamId: string; userId: string },
  kinds?: AgentContextKind[],
): Promise<AgentContextItem[]> {
  validateAgentIdentity(owner);
  const groups = await Promise.all(TOOLBOX_SOURCES.filter(([, kind]) => !kinds || kinds.includes(kind)).map(async ([tool, kind]) => {
    const raw = await backend.get(`nobo:toolbox:v1:${owner.teamId}:${owner.userId}:${tool}`);
    if (raw === null) return [];
    if (Buffer.byteLength(raw) > 2_000_000) throw new Error("Personal context is too large to load.");
    const state: unknown = JSON.parse(raw);
    if (!record(state) || !Array.isArray(state.entries) || state.entries.length > 100) throw new Error("Personal context contains unsupported data.");
    return state.entries.map((entry): AgentContextItem => {
      if (!record(entry) || typeof entry.id !== "string" || typeof entry.title !== "string" || typeof entry.body !== "string" || !record(entry.data)) {
        throw new Error("Personal context contains an invalid entry.");
      }
      const data = entry.data;
      const dueAt = typeof data.due === "string" ? data.due : undefined;
      const sourceUrl = tool === "bookmarks" && typeof data.url === "string" ? data.url : undefined;
      return {
        id: `toolbox:${tool}:${entry.id}`, kind,
        title: entry.title.slice(0, 300),
        text: [entry.body, JSON.stringify(data)].filter(Boolean).join("\n").slice(0, 12_000),
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
        dueAt, sourceUrl,
        metadata: { ...data, source: `Personal toolbox / ${tool}` },
      };
    });
  }));
  return groups.flat();
}
