import { AgentContextCapacityError, AGENT_CONTEXT_LIMITS } from "./budgets.js";
import type { AgentContextItem, AgentContextKind, AgentFeatureContext } from "./types.js";

// Three toolbox namespaces (each at most 2 MB before projection) per group;
// calendar/approved memory are small bounded stores. Each legacy kind can nearly
// fill a 16 MiB response on its own. Never retry a failed broad read in chunks.
const GROUPS: readonly (readonly AgentContextKind[])[] = [
  ["note", "goal", "habit"], ["journal", "bookmark", "artifact", "memory", "event"],
  ["follow-up"], ["reminder"], ["monitor"], ["digest"],
];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Read a complete explicit kind scope in <=6 sequential service calls. Use only
 * runtime-wrapped services: every group consumes its normal context-read/byte
 * budget and original deadline. No cache, retries, slices or serialized copies.
 * On failure no partial array is returned. Restores production source ordering
 * so downstream caps/ranking select the same records as a successful broad read.
 */
export async function readBoundedContext(
  context: Pick<AgentFeatureContext, "services" | "signal">,
  kinds: readonly AgentContextKind[],
): Promise<AgentContextItem[]> {
  if (kinds.length > 12 || new Set(kinds).size !== kinds.length || kinds.some(kind => !GROUPS.some(group => group.includes(kind)))) throw new Error("Invalid complete source-kind scope.");
  const groups = GROUPS.map(group => kinds.filter(kind => group.includes(kind))).filter(group => group.length);
  const items: AgentContextItem[] = [];
  for (const group of groups) {
    context.signal?.throwIfAborted();
    const batch = await context.services.readContext(group);
    context.signal?.throwIfAborted();
    // Leave malformed provider-response handling to the existing consumer.
    if (!Array.isArray(batch)) return batch;
    if (items.length + batch.length > AGENT_CONTEXT_LIMITS.items) throw new AgentContextCapacityError();
    for (const item of batch) items.push(item);
  }
  // Single-group consumers retain their provider's order and validation behavior.
  if (groups.length > 1) items.sort((a, b) => Number(b?.kind === "event") - Number(a?.kind === "event") ||
    compare(a?.dueAt ?? "~", b?.dueAt ?? "~") || compare(b?.updatedAt ?? "", a?.updatedAt ?? "") || compare(a?.id ?? "", b?.id ?? ""));
  return items;
}
