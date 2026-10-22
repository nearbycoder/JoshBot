import type { getUserPreferences } from "../preferences.js";
import { agentFeatures, formatAgentFeatureHelp } from "./registry.js";
import { formatAgentCatalog, parseAgentCatalogCommand } from "./catalog.js";
import type { AgentFeatureOwner, AgentRuntimeOptions } from "./runtime.js";
import type { createAgentStateBackend } from "./store.js";
import { validateAgentIdentity } from "./identity.js";

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
  const navigation = parseAgentCatalogCommand(text);
  if (navigation) return navigation.error ?? formatAgentCatalog(agentFeatures, navigation.state);
  // Strip routing syntax only; remaining command bytes belong to the feature.
  const [, id, command = "help"] = text.trimStart().match(/^(\S+)(?:\s([\s\S]*))?$/) ?? [];
  const feature = agentFeatures.find((candidate) => candidate.id === id.toLowerCase());
  if (!feature) return "Unknown personal agent. Use /nobo-help agent for available features.";
  if (!command.trim() || command.trim().toLowerCase() === "help") return formatAgentFeatureHelp(feature);
  if (command.length > 48_000) return "This command is too long. Use at most 48,000 characters.";
  const { runAgentFeature } = await import("./runtime.js");
  if (options) return runAgentFeature(feature, command, owner, options);
  const { AGENT_BUSY_MESSAGE, agentInvocationSignal, withAgentAdmission } = await import("./admission.js");
  const { contextRead } = await import("./context/shared.js");
  return withAgentAdmission(owner, async () => {
    const now = new Date();
    const runSignal = dependencies.getRunSignal ? dependencies.getRunSignal() : (await import("../slack-agent-runs.js")).getSlackAgentRun()?.controller.signal;
    const signal = agentInvocationSignal(runSignal, dependencies.timeoutSignal);
    const backend = await contextRead(signal, dependencies.createBackend ?? (async () => (await import("./store.js")).createAgentStateBackend()));
    if (!backend) return "Personal agents need the existing Redis connection. Please try again when it is available.";
    const preferences = await contextRead(signal, async () => (dependencies.preferences ?? (await import("../preferences.js")).getUserPreferences)(owner.userId));
    const { createAgentFeatureServices } = await contextRead(signal, dependencies.loadServices ?? (() => import("./services.js")));
    return contextRead(signal, () => runAgentFeature(feature, command, owner, {
      backend, timezone: preferences.timeZone, now, signal,
      services: createAgentFeatureServices(backend, owner, signal, { timezone: preferences.timeZone, now, featureId: feature.id }),
    }));
  }, () => AGENT_BUSY_MESSAGE);
}
