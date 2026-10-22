import achievementPortfolioMetadata from "./achievement-portfolio.metadata.js";
import argumentMapMetadata from "./argument-map.metadata.js";
import assumptionTestsMetadata from "./assumption-tests.metadata.js";
import audienceBriefMetadata from "./audience-brief.metadata.js";
import blockerLabMetadata from "./blocker-lab.metadata.js";
import boundaryScriptMetadata from "./boundary-script.metadata.js";
import capacityForecastMetadata from "./capacity-forecast.metadata.js";
import changeDigestMetadata from "./change-digest.metadata.js";
import checklistLintMetadata from "./checklist-lint.metadata.js";
import claimCheckMetadata from "./claim-check.metadata.js";
import conceptLinksMetadata from "./concept-links.metadata.js";
import contextBatchMetadata from "./context-batch.metadata.js";
import curriculumMetadata from "./curriculum.metadata.js";
import dataCleanroomMetadata from "./data-cleanroom.metadata.js";
import deadlineBackplanMetadata from "./deadline-backplan.metadata.js";
import decisionJournalMetadata from "./decision-journal.metadata.js";
import delegationBriefMetadata from "./delegation-brief.metadata.js";
import difficultConversationMetadata from "./difficult-conversation.metadata.js";
import documentCriticMetadata from "./document-critic.metadata.js";
import energyPatternsMetadata from "./energy-patterns.metadata.js";
import errandBatchMetadata from "./errand-batch.metadata.js";
import estimateCalibrationMetadata from "./estimate-calibration.metadata.js";
import feedbackBuilderMetadata from "./feedback-builder.metadata.js";
import feedbackThemesMetadata from "./feedback-themes.metadata.js";
import goalAlignmentMetadata from "./goal-alignment.metadata.js";
import habitExperimentsMetadata from "./habit-experiments.metadata.js";
import homeMaintenanceMetadata from "./home-maintenance.metadata.js";
import interruptionAuditMetadata from "./interruption-audit.metadata.js";
import interviewPracticeMetadata from "./interview-practice.metadata.js";
import learningTransferMetadata from "./learning-transfer.metadata.js";
import meetingLoadMetadata from "./meeting-load.metadata.js";
import mistakePatternsMetadata from "./mistake-patterns.metadata.js";
import numberAuditMetadata from "./number-audit.metadata.js";
import pantryPlanMetadata from "./pantry-plan.metadata.js";
import practiceLabMetadata from "./practice-lab.metadata.js";
import premortemMetadata from "./premortem.metadata.js";
import processFrictionMetadata from "./process-friction.metadata.js";
import purchaseCompareMetadata from "./purchase-compare.metadata.js";
import questionTriageMetadata from "./question-triage.metadata.js";
import readingPathMetadata from "./reading-path.metadata.js";
import redactionDeskMetadata from "./redaction-desk.metadata.js";
import renewalRadarMetadata from "./renewal-radar.metadata.js";
import scopeSlicerMetadata from "./scope-slicer.metadata.js";
import shutdownReviewMetadata from "./shutdown-review.metadata.js";
import skillMatrixMetadata from "./skill-matrix.metadata.js";
import sourceCompareMetadata from "./source-compare.metadata.js";
import taskBreakdownMetadata from "./task-breakdown.metadata.js";
import teachBackMetadata from "./teach-back.metadata.js";
import timelineBuilderMetadata from "./timeline-builder.metadata.js";
import { formatAgentCatalog, validateAgentCatalog } from "./catalog.js";
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
  lazyAgentFeature(achievementPortfolioMetadata, () => import("./achievement-portfolio.js")),
  lazyAgentFeature(argumentMapMetadata, () => import("./argument-map.js")),
  lazyAgentFeature(assumptionTestsMetadata, () => import("./assumption-tests.js")),
  lazyAgentFeature(audienceBriefMetadata, () => import("./audience-brief.js")),
  lazyAgentFeature(blockerLabMetadata, () => import("./blocker-lab.js")),
  lazyAgentFeature(boundaryScriptMetadata, () => import("./boundary-script.js")),
  lazyAgentFeature(capacityForecastMetadata, () => import("./capacity-forecast.js")),
  lazyAgentFeature(changeDigestMetadata, () => import("./change-digest.js")),
  lazyAgentFeature(checklistLintMetadata, () => import("./checklist-lint.js")),
  lazyAgentFeature(claimCheckMetadata, () => import("./claim-check.js")),
  lazyAgentFeature(conceptLinksMetadata, () => import("./concept-links.js")),
  lazyAgentFeature(contextBatchMetadata, () => import("./context-batch.js")),
  lazyAgentFeature(curriculumMetadata, () => import("./curriculum.js")),
  lazyAgentFeature(dataCleanroomMetadata, () => import("./data-cleanroom.js")),
  lazyAgentFeature(deadlineBackplanMetadata, () => import("./deadline-backplan.js")),
  lazyAgentFeature(decisionJournalMetadata, () => import("./decision-journal.js")),
  lazyAgentFeature(delegationBriefMetadata, () => import("./delegation-brief.js")),
  lazyAgentFeature(difficultConversationMetadata, () => import("./difficult-conversation.js")),
  lazyAgentFeature(documentCriticMetadata, () => import("./document-critic.js")),
  lazyAgentFeature(energyPatternsMetadata, () => import("./energy-patterns.js")),
  lazyAgentFeature(errandBatchMetadata, () => import("./errand-batch.js")),
  lazyAgentFeature(estimateCalibrationMetadata, () => import("./estimate-calibration.js")),
  lazyAgentFeature(feedbackBuilderMetadata, () => import("./feedback-builder.js")),
  lazyAgentFeature(feedbackThemesMetadata, () => import("./feedback-themes.js")),
  lazyAgentFeature(goalAlignmentMetadata, () => import("./goal-alignment.js")),
  lazyAgentFeature(habitExperimentsMetadata, () => import("./habit-experiments.js")),
  lazyAgentFeature(homeMaintenanceMetadata, () => import("./home-maintenance.js")),
  lazyAgentFeature(interruptionAuditMetadata, () => import("./interruption-audit.js")),
  lazyAgentFeature(interviewPracticeMetadata, () => import("./interview-practice.js")),
  lazyAgentFeature(learningTransferMetadata, () => import("./learning-transfer.js")),
  lazyAgentFeature(meetingLoadMetadata, () => import("./meeting-load.js")),
  lazyAgentFeature(mistakePatternsMetadata, () => import("./mistake-patterns.js")),
  lazyAgentFeature(numberAuditMetadata, () => import("./number-audit.js")),
  lazyAgentFeature(pantryPlanMetadata, () => import("./pantry-plan.js")),
  lazyAgentFeature(practiceLabMetadata, () => import("./practice-lab.js")),
  lazyAgentFeature(premortemMetadata, () => import("./premortem.js")),
  lazyAgentFeature(processFrictionMetadata, () => import("./process-friction.js")),
  lazyAgentFeature(purchaseCompareMetadata, () => import("./purchase-compare.js")),
  lazyAgentFeature(questionTriageMetadata, () => import("./question-triage.js")),
  lazyAgentFeature(readingPathMetadata, () => import("./reading-path.js")),
  lazyAgentFeature(redactionDeskMetadata, () => import("./redaction-desk.js")),
  lazyAgentFeature(renewalRadarMetadata, () => import("./renewal-radar.js")),
  lazyAgentFeature(scopeSlicerMetadata, () => import("./scope-slicer.js")),
  lazyAgentFeature(shutdownReviewMetadata, () => import("./shutdown-review.js")),
  lazyAgentFeature(skillMatrixMetadata, () => import("./skill-matrix.js")),
  lazyAgentFeature(sourceCompareMetadata, () => import("./source-compare.js")),
  lazyAgentFeature(taskBreakdownMetadata, () => import("./task-breakdown.js")),
  lazyAgentFeature(teachBackMetadata, () => import("./teach-back.js")),
  lazyAgentFeature(timelineBuilderMetadata, () => import("./timeline-builder.js")),
];
validateAgentCatalog(agentFeatures);

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
  return formatAgentCatalog(agentFeatures);
}
