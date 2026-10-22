import inbox from "./inbox.js";
import meetingPrep from "./meeting-prep.js";
import recall from "./recall.js";
import type { AgentFeature } from "./types.js";

/** Add each implementation only after its integration checks pass. */
export const agentFeatures: readonly AgentFeature[] = [inbox, meetingPrep, recall];

export function formatAgentHelp() {
  return [
    "Personal agents",
    "Use /nobo-help agent <name> help for commands and examples.",
    "Results stay private. Some commands use NoBo's configured model or web search.",
    "",
    ...agentFeatures.map((feature) => `${feature.id}: ${feature.title} — ${feature.description}`),
  ].join("\n");
}
