import { existingAgentMetadata } from "./catalog-metadata.js";
import { lazyAgentFeature } from "./lazy.js";
import type { AgentFeature } from "./types.js";

/** Extend with literal metadata + an explicit dynamic import; never eager modules. */
export const agentFeatures: readonly AgentFeature[] = [
  lazyAgentFeature(existingAgentMetadata[0], () => import("./morning-brief.js")),
  lazyAgentFeature(existingAgentMetadata[1], () => import("./weekly-review.js")),
  lazyAgentFeature(existingAgentMetadata[2], () => import("./inbox.js")),
  lazyAgentFeature(existingAgentMetadata[3], () => import("./day-planner.js")),
  lazyAgentFeature(existingAgentMetadata[4], () => import("./meeting-prep.js")),
  lazyAgentFeature(existingAgentMetadata[5], () => import("./reply-coach.js")),
  lazyAgentFeature(existingAgentMetadata[6], () => import("./relationships.js")),
  lazyAgentFeature(existingAgentMetadata[7], () => import("./read-later.js")),
  lazyAgentFeature(existingAgentMetadata[8], () => import("./research.js")),
  lazyAgentFeature(existingAgentMetadata[9], () => import("./project-briefs.js")),
  lazyAgentFeature(existingAgentMetadata[10], () => import("./recall.js")),
  lazyAgentFeature(existingAgentMetadata[11], () => import("./memory-review.js")),
  lazyAgentFeature(existingAgentMetadata[12], () => import("./playbooks.js")),
  lazyAgentFeature(existingAgentMetadata[13], () => import("./workflows.js")),
  lazyAgentFeature(existingAgentMetadata[14], () => import("./learning.js")),
  lazyAgentFeature(existingAgentMetadata[15], () => import("./decision-coach.js")),
  lazyAgentFeature(existingAgentMetadata[16], () => import("./handoffs.js")),
  lazyAgentFeature(existingAgentMetadata[17], () => import("./calendar.js")),
  lazyAgentFeature(existingAgentMetadata[18], () => import("./travel.js")),
  lazyAgentFeature(existingAgentMetadata[19], () => import("./automation-audit.js")),
];

const contextCoverage = "Available context: your private toolbox, confirmed calendar imports, and approved memory cards. Reminders, monitors, digests and follow-ups cover only your records in the channel where you run the command. Saved artifacts and legacy personal memory are not connected.";
const contextFeatures = new Set([
  "morning-brief", "weekly-review", "day-planner", "meeting-prep", "read-later",
  "project-briefs", "recall", "memory-review", "handoffs", "automation-audit",
]);

export function formatAgentFeatureHelp(feature: AgentFeature): string {
  if (!contextFeatures.has(feature.id)) return feature.help;
  const extra = feature.id === "memory-review" ? " Legacy import currently returns no candidates; capture facts explicitly." : "";
  return `${feature.help}\n\n${contextCoverage}${extra}`;
}

export function formatAgentHelp() {
  return [
    "Personal agents",
    "Use /nobo-help agent <name> help for commands and examples.",
    "Results stay private. Some commands use NoBo's configured model or web search.",
    contextCoverage,
    "",
    ...agentFeatures.map((feature) => `${feature.id}: ${feature.title} — ${feature.description}`),
  ].join("\n");
}
