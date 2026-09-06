import { AsyncLocalStorage } from "node:async_hooks";

export type AgentTaskUpdate = {
  type: "task_update"; id: string; title: string;
  status: "in_progress" | "complete" | "error";
};
type RunTarget = { teamId: string; channelId: string; threadTs: string; userId: string };
type AgentRun = RunTarget & {
  controller: AbortController;
  cancellers: Set<() => Promise<unknown>>;
  progress?: (update: AgentTaskUpdate) => Promise<void>;
  contextHint?: string;
};
const current = new AsyncLocalStorage<AgentRun>();
const runs = new Map<string, Set<AgentRun>>();
const key = (target: RunTarget) => JSON.stringify([target.teamId, target.channelId, target.threadTs]);

export class SlackAgentStoppedError extends Error {
  constructor() { super("The user stopped this Slack agent session."); this.name = "SlackAgentStoppedError"; }
}
export function getSlackAgentRun() { return current.getStore(); }
export function throwIfSlackAgentStopped() {
  if (current.getStore()?.controller.signal.aborted) throw new SlackAgentStoppedError();
}
export async function withSlackAgentRun<T>(target: RunTarget, work: () => Promise<T>, contextHint?: string) {
  const run: AgentRun = { ...target, controller: new AbortController(), cancellers: new Set(), contextHint };
  const id = key(target);
  const active = runs.get(id) ?? new Set<AgentRun>();
  runs.set(id, active);
  active.add(run);
  try { return await current.run(run, work); }
  finally {
    active.delete(run);
    if (!active.size) runs.delete(id);
  }
}
/** Stop only this user's work in the exact workspace/channel/thread. Single-replica registry. */
export async function stopSlackAgentRuns(target: RunTarget) {
  const active = [...(runs.get(key(target)) ?? [])].filter((run) => run.userId === target.userId);
  for (const run of active) run.controller.abort();
  const outcomes = await Promise.allSettled(active.flatMap((run) => [...run.cancellers].map((cancel) => cancel())));
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return active.length;
}

/** Keep tool inputs, outputs, errors, and model reasoning out of Slack progress cards. */
export function createAgentTaskProjector() {
  const titles = new Map<string, string>();
  return (chunk: { type: string; toolCallId?: string; toolName?: string }): AgentTaskUpdate | undefined => {
    if (!chunk.toolCallId) return;
    if (chunk.type === "tool-input") {
      const title = (chunk.toolName ?? "Tool").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 80) || "Tool";
      titles.set(chunk.toolCallId, title);
      return { type: "task_update", id: chunk.toolCallId, title, status: "in_progress" };
    }
    if (chunk.type !== "tool-output" && chunk.type !== "tool-output-error") return;
    const title = titles.get(chunk.toolCallId) ?? "Tool";
    titles.delete(chunk.toolCallId);
    return { type: "task_update", id: chunk.toolCallId, title, status: chunk.type === "tool-output" ? "complete" : "error" };
  };
}
