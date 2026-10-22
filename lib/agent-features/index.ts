import { getUserPreferences } from "../preferences.js";
import { getSlackAgentRun } from "../slack-agent-runs.js";
import { agentFeatures, formatAgentHelp } from "./registry.js";
import { runAgentFeature, type AgentFeatureOwner, type AgentRuntimeOptions } from "./runtime.js";
import { createAgentStateBackend, validateAgentIdentity } from "./store.js";

export async function handleAgentCommand(
  text: string,
  owner: AgentFeatureOwner,
  options?: AgentRuntimeOptions,
): Promise<string> {
  validateAgentIdentity(owner);
  const [, id, command = "help"] = text.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
  if (!id || id.toLowerCase() === "help") return formatAgentHelp();
  const feature = agentFeatures.find((candidate) => candidate.id === id.toLowerCase());
  if (!feature) return "Unknown personal agent. Use /nobo-help agent for available features.";
  if (command.trim().toLowerCase() === "help") return feature.help;
  if (options) return runAgentFeature(feature, command, owner, options);

  const backend = await createAgentStateBackend();
  if (!backend) return "Personal agents need the existing Redis connection. Please try again when it is available.";
  const preferences = await getUserPreferences(owner.userId);
  const runSignal = getSlackAgentRun()?.controller.signal;
  const timeout = AbortSignal.timeout(120_000);
  const signal = runSignal ? AbortSignal.any([runSignal, timeout]) : timeout;
  const { createAgentFeatureServices } = await import("./services.js");
  return runAgentFeature(feature, command, owner, {
    backend, timezone: preferences.timeZone, signal,
    services: createAgentFeatureServices(backend, owner, signal),
  });
}
