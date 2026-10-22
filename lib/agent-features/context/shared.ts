import { trackAgentWork } from "../admission.js";
import { AgentContextCapacityError } from "../budgets.js";

/** Run read-only work with an active cancellation guard, including hung providers. */
export async function contextRead<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return trackAgentWork(work);
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return trackAgentWork(work); }).then(
      value => { signal.removeEventListener("abort", abort); signal.aborted ? reject(signal.reason) : resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(signal.aborted ? signal.reason : error); },
    );
  });
}

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parseContextRecord(raw: string, maxBytes: number): Record<string, unknown> {
  if (Buffer.byteLength(raw) > maxBytes) throw new AgentContextCapacityError("Personal context is too large to load completely.");
  const value: unknown = JSON.parse(raw);
  if (!record(value)) throw new Error("Personal context contains unsupported data.");
  return value;
}

export function sourceId(prefix: string, value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)) {
    throw new Error("Personal context contains an invalid source ID.");
  }
  return `${prefix}:${value}`;
}

/** Validate literal dates without rolling impossible Gregorian dates forward. */
export function civilDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function timestamp(value: unknown, allowDate = false): string | undefined {
  if (value === undefined) return undefined;
  if (allowDate && civilDate(value)) return value;
  if (typeof value !== "string") throw new Error("Personal context contains an invalid date.");
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !civilDate(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59 ||
      (match[5] !== "Z" && (+match[5].slice(1, 3) > 14 || +match[5].slice(4) > 59 ||
        (+match[5].slice(1, 3) === 14 && +match[5].slice(4) !== 0))) || !Number.isFinite(Date.parse(value))) {
    throw new Error("Personal context contains an invalid date.");
  }
  return new Date(value).toISOString();
}

export function text(value: unknown, maximum = 12_000): string {
  if (typeof value !== "string") throw new Error("Personal context contains invalid text.");
  return value.slice(0, maximum);
}

export function normalizedStatus(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Personal context contains an invalid status.");
  const status = value.trim().toLowerCase();
  return ({ enabled: "active", canceled: "cancelled", complete: "completed", done: "completed" } as Record<string, string>)[status] ?? status.slice(0, 64);
}
