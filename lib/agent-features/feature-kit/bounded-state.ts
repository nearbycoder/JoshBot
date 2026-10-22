/** Pure admission checks. Call within the real store's synchronous CAS transform. */
export type StateLimits = { maxBytes: number; contentBytes: number; maxRecordBytes: number; maxRecords: number };
export const DEFAULT_STATE_LIMITS: Readonly<StateLimits> = Object.freeze({ maxBytes: 49_152, contentBytes: 32_768, maxRecordBytes: 24_576, maxRecords: 12 });

/** Reject JSON's lossy coercions, custom serialization, getters, cycles and huge trees. */
export function serializedBytes(value: unknown): number {
  const active = new Set<object>();
  let visited = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++visited > 50_000 || depth > 24) throw new Error("State exceeds the JSON structure limit.");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string" && item.isWellFormed()) return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || item === null) throw new Error("State must contain only lossless JSON values.");
    const array = Array.isArray(item);
    if ((!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) || active.has(item)) {
      throw new Error("State contains an unsupported object or cycle.");
    }
    active.add(item);
    const keys = Reflect.ownKeys(item);
    if (array && keys.length !== item.length + 1) throw new Error("State arrays must be dense and have no extra properties.");
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== "string" || !key.isWellFormed() || !descriptor.enumerable || !("value" in descriptor) ||
          (array && !/^(?:0|[1-9]\d*)$/.test(key))) throw new Error("State contains unsupported JSON properties.");
      visit(descriptor.value, depth + 1);
    }
    active.delete(item);
  };
  visit(value, 0);
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Only the envelope version: callers MUST still validate their entire domain schema. */
export function assertStateVersion(value: unknown, version: number): asserts value is Record<string, unknown> & { version: number } {
  if (!Number.isSafeInteger(version) || version < 1 || !value || typeof value !== "object" || Array.isArray(value) ||
      Object.getOwnPropertyDescriptor(value, "version")?.value !== version) {
    throw new Error("Saved data has an unsupported state version; it was not reset or changed.");
  }
}

export function assertRevision(actual: unknown, expected: unknown): void {
  if (!Number.isSafeInteger(actual) || !Number.isSafeInteger(expected) || Number(actual) < 1 || actual !== expected) {
    throw new Error("This record changed or has an invalid revision; reopen it before applying this change.");
  }
}

type QuotaBase = { records: readonly unknown[]; limits?: Partial<StateLimits> };
export type QuotaCheck = QuotaBase & (
  | { kind: "content"; future: { value: unknown; records: readonly unknown[] } }
  | { kind: "lifecycle" }
);

/**
 * `future` is an AUTHOR-SUPPLIED worst-case projection of all mandatory remaining
 * lifecycle fields for all records, including JSON/revision overhead. Nothing is
 * inferred. Optional large notes are new content. No mutation, eviction, or I/O.
 */
export function assertQuota(value: unknown, check: QuotaCheck): void {
  const limits = { ...DEFAULT_STATE_LIMITS, ...check.limits };
  for (const limit of Object.values(limits)) if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid state quota.");
  if (limits.maxBytes > 512_000 || limits.contentBytes > limits.maxBytes || limits.maxRecordBytes > limits.maxBytes) throw new Error("Invalid state quota; the shared ceiling is 512000 bytes.");
  const inspect = (candidate: unknown, records: readonly unknown[], maxBytes: number) => {
    if (!Array.isArray(records) || records.length > limits.maxRecords) throw new Error("Record quota reached; use this feature's list/delete commands to free space.");
    if (serializedBytes(candidate) > maxBytes || records.some(record => serializedBytes(record) > limits.maxRecordBytes)) {
      throw new Error("Serialized UTF-8 quota reached; this change was not saved. Use this feature's list/delete commands to free space.");
    }
  };
  if (check.kind !== "content" && check.kind !== "lifecycle") throw new Error("Choose content or lifecycle admission explicitly.");
  inspect(value, check.records, check.kind === "content" ? limits.contentBytes : limits.maxBytes);
  if (check.kind === "content") {
    if (!check.future) throw new Error("Content admission requires an explicit worst-case lifecycle projection.");
    inspect(check.future.value, check.future.records, limits.maxBytes);
  }
}
