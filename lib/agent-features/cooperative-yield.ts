import { setImmediate } from "node:timers/promises";

/** Let ready I/O and timers progress without renewing the invocation deadline.
 * Call only inside admitted work: one pending immediate per invocation, no queue
 * of requests and no early release of its permit or outstanding physical work.
 */
export async function yieldAgentWork(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await setImmediate();
  signal?.throwIfAborted();
}
