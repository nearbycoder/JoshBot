import morningBrief from "./morning-brief.js";
import weeklyReview from "./weekly-review.js";
import inbox from "./inbox.js";
import dayPlanner from "./day-planner.js";
import meetingPrep from "./meeting-prep.js";
import replyCoach from "./reply-coach.js";
import relationships from "./relationships.js";
import readLater from "./read-later.js";
import research from "./research.js";
import projectBriefs from "./project-briefs.js";
import recall from "./recall.js";
import memoryReview from "./memory-review.js";
import playbooks from "./playbooks.js";
import workflows from "./workflows.js";
import learning from "./learning.js";
import decisionCoach from "./decision-coach.js";
import handoffs from "./handoffs.js";
import calendar from "./calendar.js";
import travel from "./travel.js";
import automationAudit from "./automation-audit.js";
import type { AgentFeature } from "./types.js";

/** Private, on-demand tools; registration does not start background work. */
export const agentFeatures: readonly AgentFeature[] = [
  morningBrief, weeklyReview, inbox, dayPlanner, meetingPrep,
  replyCoach, relationships, readLater, research, projectBriefs,
  recall, memoryReview, playbooks, workflows, learning,
  decisionCoach, handoffs, calendar, travel, automationAudit,
];

export function formatAgentHelp() {
  return [
    "Personal agents",
    "Use /nobo-help agent <name> help for commands and examples.",
    "Results stay private. Some commands use NoBo's configured model or web search.",
    "",
    ...agentFeatures.map((feature) => `${feature.id}: ${feature.title} — ${feature.description}`),
  ].join("\n");
}
