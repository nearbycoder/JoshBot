import { AGENT_BUSY_MESSAGE, agentInvocationSignal, withAgentAdmission } from "./admission.js";
import type { getUserPreferences } from "../preferences.js";
import { getSlackAgentRun } from "../slack-agent-runs.js";
import { agentFeatures, formatAgentFeatureHelp, formatAgentHelp } from "./registry.js";
import { runAgentFeature, type AgentFeatureOwner, type AgentRuntimeOptions } from "./runtime.js";
import { createAgentStateBackend, validateAgentIdentity } from "./store.js";
import { contextRead } from "./context/shared.js";

export type AgentStartupDependencies = {
  createBackend: typeof createAgentStateBackend;
  preferences: typeof getUserPreferences;
  getRunSignal: () => AbortSignal | undefined;
  timeoutSignal: (milliseconds: number) => AbortSignal;
  loadServices: () => Promise<Pick<typeof import("./services.js"), "createAgentFeatureServices">>;
};

export async function handleAgentCommand(
  text: string,
  owner: AgentFeatureOwner,
  options?: AgentRuntimeOptions,
  dependencies: Partial<AgentStartupDependencies> = {},
): Promise<string> {
  validateAgentIdentity(owner);
  const [, id, command = "help"] = text.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
  if (!id || id.toLowerCase() === "help") return formatAgentHelp();
  const feature = agentFeatures.find((candidate) => candidate.id === id.toLowerCase());
  if (!feature) return "Unknown personal agent. Use /nobo-help agent for available features.";
  if (command.trim().toLowerCase() === "help") return formatAgentFeatureHelp(feature);
  if (options) return runAgentFeature(feature, command, owner, options);

  if (command.length > 48_000) return "This command is too long. Use at most 48,000 characters.";
  return withAgentAdmission(owner, async () => {
    const now = new Date();
    const runSignal = dependencies.getRunSignal ? dependencies.getRunSignal() : getSlackAgentRun()?.controller.signal;
    const signal = agentInvocationSignal(runSignal, dependencies.timeoutSignal);
    const backend = await contextRead(signal, dependencies.createBackend ?? createAgentStateBackend);
    if (!backend) return "Personal agents need the existing Redis connection. Please try again when it is available.";
    const preferences = await contextRead(signal, async () => (dependencies.preferences ?? (await import("../preferences.js")).getUserPreferences)(owner.userId));
    const { createAgentFeatureServices } = await contextRead(signal, dependencies.loadServices ?? (() => import("./services.js")));
    return contextRead(signal, () => runAgentFeature(feature, command, owner, {
      backend, timezone: preferences.timeZone, now, signal,
      services: createAgentFeatureServices(backend, owner, signal, { timezone: preferences.timeZone, now, featureId: feature.id }),
    }));
  }, () => AGENT_BUSY_MESSAGE);
}
