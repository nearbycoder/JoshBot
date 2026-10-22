import type { AgentContextItem, AgentFeatureResourceBudgets } from "./types.js";

export const DEFAULT_AGENT_BUDGETS = Object.freeze({ generations: 8, searches: 6, contextReads: 8, storeReads: 64, storeUpdates: 32 });
export const AGENT_CONTEXT_LIMITS = Object.freeze({ items: 2_000, bytes: 16 * 1024 * 1024, invocationBytes: 32 * 1024 * 1024, nodes: 250_000, depth: 16 });

export function resolveAgentBudgets(requested: AgentFeatureResourceBudgets = {}) {
  const resolved: Required<AgentFeatureResourceBudgets> = { ...DEFAULT_AGENT_BUDGETS };
  for (const key of Object.keys(requested)) {
    if (!(key in DEFAULT_AGENT_BUDGETS)) throw new Error(`Unknown personal-agent resource budget: ${key}.`);
    const name = key as keyof AgentFeatureResourceBudgets;
    const value = requested[name];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0 || value > DEFAULT_AGENT_BUDGETS[name]) throw new Error(`${name} must be an integer from 0 to ${DEFAULT_AGENT_BUDGETS[name]}.`);
    resolved[name] = value;
  }
  return resolved;
}

const contextTooLarge = () => new Error("Personal context exceeds this command's complete-read budget. Request fewer source kinds or reduce the selected source records, then retry. No source data was truncated.");

/** Count JSON-equivalent bytes incrementally: no serialized copy of the snapshot.
 * Metadata traversal itself is bounded, including depth/cycles and tiny-node floods. */
export function measureAgentContext(items: AgentContextItem[]): number {
  if (!Array.isArray(items) || items.length > AGENT_CONTEXT_LIMITS.items) throw contextTooLarge();
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const add = (amount: number) => { bytes += amount; if (bytes > AGENT_CONTEXT_LIMITS.bytes) throw contextTooLarge(); };
  const string = (value: string) => {
    add(Buffer.byteLength(value) + 2);
    // JSON escapes quotes/backslashes/control characters. Valid Unicode stays UTF8.
    for (const match of value.matchAll(/["\\\u0000-\u001f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g)) {
      const code = match[0].charCodeAt(0);
      if (code >= 0xd800) {
        add(3); // UTF8 replacement bytes -> six ASCII escape bytes.
      } else add(code < 32 && ![8, 9, 10, 12, 13].includes(code) ? 5 : 1);
    }
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > AGENT_CONTEXT_LIMITS.nodes || depth > AGENT_CONTEXT_LIMITS.depth) throw contextTooLarge();
    if (typeof value === "string") { string(value); return; }
    if (value === null || value === undefined) { add(4); return; }
    if (typeof value === "boolean") { add(value ? 4 : 5); return; }
    if (typeof value === "number" && Number.isFinite(value)) { add(String(value).length); return; }
    if (typeof value !== "object") throw new Error("Personal context contains unsupported metadata.");
    if (ancestors.has(value)) throw new Error("Personal context contains cyclic metadata.");
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Personal context contains unsupported metadata.");
    ancestors.add(value); add(2);
    let count = 0;
    if (array) {
      if (value.length > AGENT_CONTEXT_LIMITS.nodes) throw contextTooLarge();
      for (const child of value) { if (count++) add(1); visit(child, depth + 1); }
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const child = (value as Record<string, unknown>)[key];
        if (child === undefined) continue;
        if (count++) add(1); string(key); add(1); visit(child, depth + 1);
      }
    }
    ancestors.delete(value);
  };
  visit(items, 0);
  return bytes;
}
