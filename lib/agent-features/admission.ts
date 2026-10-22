import { AsyncLocalStorage } from "node:async_hooks";
import { validateAgentIdentity } from "./store.js";

export const AGENT_BUSY_MESSAGE = "Personal agents are busy. This command has not started or saved anything. Please retry shortly.";
export const DEFAULT_AGENT_ADMISSION = Object.freeze({ global: 3, perUser: 2 });

type Scope = { signal?: AbortSignal; owner: string; pending: number; closed: boolean; released: boolean; release: () => void };
const current = new AsyncLocalStorage<Scope>();

/** Only lower the measured process limits; no queue or per-user idle cache. */
export function agentAdmissionLimits(environment: NodeJS.ProcessEnv = process.env) {
  const read = (name: string, fallback: number) => {
    const raw = environment[name];
    if (raw === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || Number(raw) > fallback) throw new Error(`${name} must be an integer from 1 to ${fallback}.`);
    return Number(raw);
  };
  const global = read("NOBO_AGENT_MAX_INFLIGHT", DEFAULT_AGENT_ADMISSION.global);
  const perUser = read("NOBO_AGENT_MAX_PER_USER", DEFAULT_AGENT_ADMISSION.perUser);
  return { global, perUser: Math.min(global, perUser) };
}

let active = 0;
const owners = new Map<string, number>();
const maybeRelease = (scope: Scope) => {
  if (!scope.closed || scope.pending || scope.released) return;
  scope.released = true;
  scope.release();
};

/** Internal scope shared by policy, startup and direct runtime calls. */
export async function withAgentAdmission<T>(
  owner: { teamId?: string; userId?: string },
  work: () => Promise<T>,
  busy: () => T,
): Promise<T> {
  validateAgentIdentity(owner);
  const key = `${owner.teamId}:${owner.userId}`;
  const inherited = current.getStore();
  if (inherited && !inherited.closed && inherited.owner === key) return work();
  const limits = agentAdmissionLimits();
  const count = owners.get(key) ?? 0;
  if (active >= limits.global || count >= limits.perUser) return busy();
  active++; owners.set(key, count + 1);
  const scope: Scope = {
    owner: key, pending: 0, closed: false, released: false,
    release() {
      active--;
      const remaining = owners.get(key)! - 1;
      if (remaining) owners.set(key, remaining); else owners.delete(key);
    },
  };
  return current.run(scope, async () => {
    try { return await work(); }
    finally { scope.closed = true; maybeRelease(scope); }
  });
}

/** Count physical promises, including nested Redis reads that outlive cancellation.
 * Counts hold ONE invocation permit, never additional admission slots. No payloads
 * or pending promise lists are retained by the limiter. */
export function trackAgentWork<T>(work: () => Promise<T>): Promise<T> {
  const scope = current.getStore();
  if (!scope) return work();
  if (scope.closed) return Promise.reject(new Error("This personal-agent invocation has already ended."));
  scope.pending++;
  let pending: Promise<T>;
  try { pending = Promise.resolve(work()); }
  catch (error) { pending = Promise.reject(error); }
  return pending.finally(() => { scope.pending--; maybeRelease(scope); });
}

/** One deadline from the first boundary (policy when routed through Slack).
 * Direct runtime callers also receive a timeout when passing a stop-only signal. */
export function agentInvocationSignal(stop?: AbortSignal, timeout: (ms: number) => AbortSignal = AbortSignal.timeout): AbortSignal {
  const scope = current.getStore();
  if (scope?.signal) return stop && stop !== scope.signal ? AbortSignal.any([scope.signal, stop]) : scope.signal;
  const deadline = timeout(120_000);
  const signal = stop ? AbortSignal.any([stop, deadline]) : deadline;
  if (scope) scope.signal = signal;
  return signal;
}
