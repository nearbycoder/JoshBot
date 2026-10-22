import { createHash } from "node:crypto";
import type { AgentContextItem, AgentContextKind } from "../types.js";
import { serializedBytes } from "./bounded-state.js";
import { boundedText } from "./command-and-display.js";
import { civilDate, normalizeInstant } from "./civil-time.js";

const KINDS: readonly AgentContextKind[] = ["note", "goal", "habit", "journal", "bookmark", "follow-up", "reminder", "monitor", "digest", "artifact", "memory", "event"];
const FIELDS = new Set(["id", "kind", "title", "text", "updatedAt", "dueAt", "status", "sourceUrl", "metadata"]);
const OPTIONAL = ["updatedAt", "dueAt", "status", "sourceUrl", "metadata"];
// Only known optional fields emitted by the source adapters may represent absence
// with an own undefined value. Arbitrary/nested metadata remains lossless JSON.
const OPTIONAL_METADATA: Partial<Record<AgentContextKind, readonly string[]>> = {
  note: ["createdAt"], goal: ["createdAt"], habit: ["createdAt"], journal: ["createdAt"], bookmark: ["createdAt"],
  "follow-up": ["createdAt", "completedAt", "assigneeUserId", "scheduleId"],
  reminder: ["createdAt", "nextRunAt", "schedule", "timezone", "cadence"],
  digest: ["createdAt", "nextRunAt", "schedule", "timezone", "cadence"],
  monitor: ["createdAt", "nextRunAt", "schedule", "timezone", "cadence", "monitorSource", "conditionType", "lastCheckedAt", "lastRunAt"],
};
const COVERAGE = ["coverage", "textTruncated", "titleTruncated"] as const;
const READ_TIME = new Set(["readAt", "observedAt", "capturedAt", "enumerationIndex"]);
export type EvidenceOptions = { kinds: readonly AgentContextKind[]; maxItems?: number; maxBytes?: number; metadataKeys?: readonly string[] };
export type EvidenceSnapshot = { version: 1; sources: AgentContextItem[]; fingerprint: string };

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function projectOptional(value: unknown, optional: readonly string[]): Record<string, unknown> {
  if (!plain(value)) throw new Error("Unsupported source object; use the declared readContext contract.");
  const projected: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Source contains unsupported JSON properties.");
    if (descriptor.value === undefined && optional.includes(key)) continue;
    projected[key] = descriptor.value;
  }
  return projected;
}

/**
 * Capture an already selected, permitted readContext subset, never select/authorize
 * on behalf of the caller. Known fields + explicitly selected metadata are hashed.
 * Coverage/truncation metadata is retained automatically. Source refs remain exact.
 */
export function captureEvidence(items: readonly unknown[], options: EvidenceOptions): EvidenceSnapshot {
  const maxItems = options.maxItems ?? 40, maxBytes = options.maxBytes ?? 24_576;
  if (!Number.isSafeInteger(maxItems) || maxItems < 0 || maxItems > 200 || !Number.isSafeInteger(maxBytes) || maxBytes < 64 || maxBytes > 196_608 ||
      !Array.isArray(items) || items.length > maxItems || !Array.isArray(options.kinds) || options.kinds.some(kind => !KINDS.includes(kind)) ||
      new Set(options.kinds).size !== options.kinds.length) throw new Error("Invalid or exceeded evidence bounds/scope; select a smaller explicit source set.");
  const keys = options.metadataKeys ?? [];
  if (keys.length > 32 || keys.some(key => typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || READ_TIME.has(key)) || new Set(keys).size !== keys.length) {
    throw new Error("Select at most 32 unique meaningful metadata keys; read time and enumeration order are not evidence.");
  }
  const selectedKeys = [...new Set([...COVERAGE, ...keys])].sort();
  const seen = new Set<string>();
  const referenceKinds = new Map<string, AgentContextKind>();
  const sources = items.map(input => {
    // Inspect descriptors without invoking accessors. Project only documented
    // optional absence before strict validation of the ENTIRE remaining shape.
    const item = projectOptional(input, OPTIONAL);
    if (typeof item.kind !== "string" || !KINDS.includes(item.kind as AgentContextKind) || !options.kinds.includes(item.kind as AgentContextKind)) throw new Error("Source kind is outside this feature's declared scope.");
    if (item.metadata !== undefined) item.metadata = projectOptional(item.metadata, OPTIONAL_METADATA[item.kind as AgentContextKind] ?? []);
    if (serializedBytes(item) > 65_536 || Object.keys(item).some(key => !FIELDS.has(key))) throw new Error("Unsupported or oversized source shape; use the declared readContext contract.");
    const id = boundedText(item.id, { label: "Source ID", maxBytes: 256, trim: false });
    if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(id)) throw new Error("Source ID is ambiguous or malformed; preserve the adapter's exact identifier.");
    const identity = `${item.kind}\u0000${id}`;
    if (seen.has(identity)) throw new Error("Duplicate kind+ID source reference; evidence is ambiguous.");
    if (referenceKinds.has(id)) throw new Error("Source ID is shared by different kinds; an ID-only citation would be ambiguous.");
    seen.add(identity);
    referenceKinds.set(id, item.kind as AgentContextKind);
    const source: AgentContextItem = {
      id, kind: item.kind as AgentContextKind,
      title: boundedText(item.title, { label: "Source title", maxBytes: 4_096, trim: false, allowEmpty: true }),
      text: boundedText(item.text, { label: "Source text", maxBytes: 49_152, trim: false, allowEmpty: true }),
    };
    if (item.updatedAt !== undefined) source.updatedAt = normalizeInstant(item.updatedAt);
    if (item.dueAt !== undefined) source.dueAt = typeof item.dueAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.dueAt) ? civilDate(item.dueAt) : normalizeInstant(item.dueAt);
    if (item.status !== undefined) source.status = boundedText(item.status, { label: "Source status", maxBytes: 128, trim: false });
    if (item.sourceUrl !== undefined) {
      const url = boundedText(item.sourceUrl, { label: "Source URL", maxBytes: 2_048, trim: false });
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error("Source URL must be an exact public HTTP(S) reference."); }
      if (!/^https?:\/\//.test(url) || /\s/u.test(url) || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Source URL must be an exact credential-free HTTP(S) reference.");
      source.sourceUrl = url; // Do not reorder query params, strip fragments or resolve the URL.
    }
    if (item.metadata !== undefined) {
      if (!plain(item.metadata)) throw new Error("Source metadata must be a plain JSON object.");
      const metadata: Record<string, unknown> = {};
      for (const key of selectedKeys) if (Object.hasOwn(item.metadata, key)) {
        const value = item.metadata[key];
        if ((key === "titleTruncated" || key === "textTruncated") && typeof value !== "boolean") throw new Error("Source truncation flags must be boolean.");
        if (key === "coverage" && (typeof value !== "string" || value.length > 256)) throw new Error("Source coverage must be a bounded label.");
        // Copy only selected fields; later mutation of an adapter response cannot
        // change the returned snapshot after its fingerprint has been calculated.
        metadata[key] = JSON.parse(canonical(value));
      }
      if (Object.keys(metadata).length) source.metadata = metadata;
    }
    return source;
  }).sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const selected = { version: 1 as const, kinds: [...options.kinds].sort(), metadataKeys: selectedKeys, sources };
  if (serializedBytes(selected) > maxBytes) throw new Error("Selected evidence exceeds its UTF-8 byte limit; no sources were clipped. Select a smaller explicit scope.");
  return { version: 1, sources, fingerprint: `e1:${createHash("sha256").update(canonical(selected)).digest("hex")}` };
}
