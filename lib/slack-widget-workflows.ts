import type { ViewsOpenArguments } from "@slack/web-api";
import { createArtifact, findArtifact, listArtifactVersions, updateArtifact } from "./artifacts.js";
import { readFile } from "node:fs/promises";
import { createWidgetContinuation, createWidgetRevision } from "./ai.js";
import { postGeneratedSlackMessage } from "./slack.js";
import { withSlackAgentRun } from "./slack-agent-runs.js";
import { FALLBACK_SLACK_TEXT_MODEL, getDefaultSlackTextModel } from "./nobo-models.js";
import { claimWidgetAction, renderWidget, saveWidget, widgetContent, plain, textBlocks, escapeSlack, type WidgetRecord, type WidgetBlock, type WidgetStore } from "./slack-widgets.js";
import { cancelScheduleById, createScheduleFromTool, editOwnedSchedule, getOwnedSchedule, getUserScheduleDashboardItems } from "./schedules.js";
import { buildIssueDraft, getIssueDestinations, handleIssueDrafts, parseFollowUpsFromText, type IssueTarget } from "./issue-drafts.js";
import { queueWidgetApproval } from "./slack-approvals.js";
import { assertSlackTargetChannelAllowed } from "./slack-targets.js";

export type WidgetIO = {
  tell(text: string): Promise<unknown>;
  reply(text: string, blocks?: WidgetBlock[]): Promise<unknown>;
  open(view: ViewsOpenArguments["view"]): Promise<unknown>;
  postElsewhere?(channelId: string, text: string): Promise<unknown>;
  privateCard?(text: string, blocks?: WidgetBlock[]): Promise<unknown>;
};
const defaults = { createArtifact, createWidgetContinuation, createWidgetRevision, postGeneratedSlackMessage,
  findArtifact, listArtifactVersions, updateArtifact, cancelScheduleById, createScheduleFromTool,
  editOwnedSchedule, getOwnedSchedule, getUserScheduleDashboardItems, handleIssueDrafts,
  assertSlackTargetChannelAllowed, readFile };
export type WidgetWorkflowDeps = Partial<typeof defaults> & { store?: WidgetStore | null };
const followups: Record<string, string> = {
  shorter: "Make the previous answer shorter while keeping important caveats and sources.",
  deeper: "Research the previous topic more deeply. Verify new claims and include sources.",
  compare: "Compare practical alternatives to the previous answer, including tradeoffs and sources.",
  tasks: "Turn the previous answer into a draft checklist of concrete tasks. Preserve only explicitly known owners and dates; mark unknowns. Do not create issues or reminders.",
  retry: "Retry the original request. Do not repeat external writes.",
  alternate: "Retry the original request using a different model. Do not repeat external writes."
};
export async function performWidgetAction(record: WidgetRecord, action: string, io: WidgetIO, dependencies: WidgetWorkflowDeps = {}) {
  const deps = { ...defaults, ...dependencies };
  if (action === "approve" || action === "reject") {
    if (!record.approval) throw new Error("This is not an approval card.");
    if (!await claimWidgetAction(record.id, "decision", deps.store)) return io.tell("This approval was already decided or is processing. Check the thread; it will not run twice.");
    if (action === "reject") return io.tell("Rejected. Nothing was executed.");
    const approval = record.approval;
    if (approval.type === "schedule") {
      const created = await deps.createScheduleFromTool({ ...approval.context, sourceTs: "approval:" + record.id }, approval.schedule, { firstRunAt: approval.firstRunAt });
      if (!created.nextRunAt) throw new Error("Schedule is still processing. Check My reminders before retrying.");
      const schedule = await deps.getOwnedSchedule(created.id, record.target.userId);
      return publishReminder(record, schedule, io, deps.store);
    }
    if (approval.type === "post") {
      await deps.assertSlackTargetChannelAllowed({ userId: record.target.userId, channelId: approval.channelId,
        action: "widget_post", surface: "slack-interaction" });
      // A separate port binds the confirmed destination; never repurpose the source reply channel.
      if (!io.postElsewhere) throw new Error("Posting is unavailable.");
      await io.postElsewhere(approval.channelId, approval.text);
      return io.tell("Posted the approved text to the selected channel.");
    }
    if (JSON.stringify(getIssueDestinations(approval.targets)) !== JSON.stringify(approval.destinations)) {
      throw new Error("The configured issue destination changed. Prepare a fresh approval.");
    }
    const result = await deps.handleIssueDrafts(approval.tasks, { targets: approval.targets, context: approval.context, create: true, approved: true });
    return io.reply(result);
  }
  if (action === "reminders") {
    const items = await deps.getUserScheduleDashboardItems(record.target.userId, 5);
    if (!items.length) return io.tell("You have no active reminders. Use /nobo-reminder to create one.");
    for (const item of items) await publishReminder(record, await deps.getOwnedSchedule(item.id, record.target.userId), io, deps.store, true);
    return;
  }
  if (action === "cancel_reminder") {
    if (!record.schedule) throw new Error("No reminder attached to this card.");
    const schedule = await deps.getOwnedSchedule(record.schedule.id, record.target.userId);
    await deps.assertSlackTargetChannelAllowed({ userId: record.target.userId, channelId: schedule.channel,
      action: "cancel_schedule", surface: "slack-interaction" });
    if (!await claimWidgetAction(record.id, "cancel_reminder", deps.store)) return io.tell("This cancellation is already processing or was processed.");
    await deps.cancelScheduleById(schedule.id, record.target.userId);
    return io.tell("Reminder cancelled. Future occurrences are stopped; a delivery already in progress may still finish.");
  }
  if (action === "versions") {
    if (!record.artifact) throw new Error("No artifact attached to this card.");
    const result = await deps.listArtifactVersions(record.artifact.id, { ownerUserId: record.target.userId });
    if (!result.ok) throw new Error("This artifact is unavailable or no longer belongs to you.");
    return io.tell(result.versions.length ? "Retained versions:\n" + result.versions.slice(0, 10)
      .map((version) => `${version.versionId} · ${version.savedAt} · ${version.bytes} bytes`).join("\n") : "No previous versions yet.");
  }
  if (["share", "issues", "revise", "edit_reminder"].includes(action)) {
    const blocks: WidgetBlock[] = [];
    if (action === "share") {
      blocks.push({ type: "input", block_id: "channel", label: plain("Destination"),
        element: { type: "conversations_select", action_id: "value", filter: { include: ["public", "private"], exclude_bot_users: true } } },
      input("text", "Exact message to post", widgetContent(record).slice(0, 3000), 3000));
    } else if (action === "issues") {
      blocks.push({ type: "input", block_id: "target", label: plain("Issue provider"),
        element: { type: "static_select", action_id: "value", options: ["github", "linear"].map((value) => ({ text: plain(value), value })) } },
      input("text", "Tasks to create (one per line; review before approval)", "", 2500));
    } else if (action === "revise") {
      if (!record.artifact) throw new Error("No artifact attached.");
      const found = await deps.findArtifact(record.artifact.id, { ownerUserId: record.target.userId });
      if (found.status !== "found") throw new Error("Artifact is unavailable.");
      blocks.push(input("text", "Describe the revision to save", "", 1000),
        ...textBlocks("This updates the document and retains its previous version. Other documents will not be changed."));
    } else {
      if (!record.schedule) throw new Error("No reminder attached.");
      const schedule = await deps.getOwnedSchedule(record.schedule.id, record.target.userId);
      blocks.push(input("text", "Reminder text", schedule.task, 1000),
        { type: "input", block_id: "when", label: plain("Next occurrence"),
          element: { type: "datetimepicker", action_id: "value", initial_date_time: Math.floor(new Date(schedule.nextRunAt).getTime() / 1000) } },
        ...textBlocks(`Timezone: ${escapeSlack(schedule.timezone)}. Recurring cadence and destination stay unchanged; this edits the text and next occurrence only.`));
    }
    return io.open({ type: "modal", callback_id: "nobo_widget_workflow", title: plain({
      share: "Post elsewhere", issues: "Create issues", revise: "Revise document", edit_reminder: "Edit reminder"
    }[action] ?? "NoBo"), submit: plain(action === "share" || action === "issues" ? "Review" : "Save"), close: plain("Cancel"),
      private_metadata: JSON.stringify({ id: record.id, channelId: record.target.channelId, action }), blocks
    } as unknown as ViewsOpenArguments["view"]);
  }
  if (action === "save") {
    if (!await claimWidgetAction(record.id, "save", deps.store)) return io.tell("This save is already processing or was processed. Check the thread for its result.");
    const artifact = await deps.createArtifact({ kind: "markdown", title: record.title, content: widgetContent(record), ownerUserId: record.target.userId });
    const card = await saveWidget({ target: record.target, kind: "artifact", title: "Saved note", text: "Saved your answer and sources as a Markdown note.",
      artifact: { id: artifact.id, title: artifact.title, url: artifact.previewUrl } }, deps.store);
    return io.reply(`Saved note: ${artifact.previewUrl}`, card ? renderWidget(card) : undefined);
  }
  if (followups[action]) {
    if ((action === "retry" || action === "alternate") && (!record.replaySafe || !record.prompt)) {
      return io.tell("Automatic retry is unavailable because this run may have performed actions or included an image. Review its results and send a fresh request.");
    }
    if (!await claimWidgetAction(record.id, action, deps.store)) return io.tell("That follow-up is already processing or was processed. Check the thread.");
    let model: string | undefined;
    if (action === "alternate") {
      model = record.model?.used === FALLBACK_SLACK_TEXT_MODEL ? getDefaultSlackTextModel() : FALLBACK_SLACK_TEXT_MODEL;
      if (model === record.model?.used) model = "deepseek-v4-pro";
    }
    await io.tell("Working on that follow-up in the thread.");
    return withSlackAgentRun(record.target, () => deps.postGeneratedSlackMessage({
      channel: record.target.channelId, threadTs: record.target.threadTs,
      createReply: (onTextDelta) => deps.createWidgetContinuation(record, followups[action]!, onTextDelta, model)
    }), undefined, followups[action]);
  }
  return io.tell("This action is not available yet.");
}

function input(id: string, label: string, value: string, maxLength: number): WidgetBlock {
  return { type: "input", block_id: id, label: plain(label), element: { type: "plain_text_input",
    action_id: "value", multiline: true, max_length: maxLength, ...(value ? { initial_value: value } : {}) } };
}
async function publishReminder(source: WidgetRecord, schedule: Awaited<ReturnType<typeof getOwnedSchedule>>, io: WidgetIO, store?: WidgetStore | null, privateReply = false) {
  const card = await saveWidget({ target: source.target, kind: "reminder", title: "Reminder confirmation", text: "Reminder is active.",
    schedule: { id: schedule.id, summary: schedule.summary, nextRunAt: schedule.nextRunAt, timeZone: schedule.timezone, channelId: schedule.channel }
  }, store);
  if (privateReply && io.privateCard) return io.privateCard(schedule.summary, card ? renderWidget(card) : undefined);
  return io.reply(schedule.summary, card ? renderWidget(card) : undefined);
}
export type WidgetSubmission = { action: string; text: string; channelId?: string; target?: string; when?: number };
export function validateWidgetSubmission(input: WidgetSubmission) {
  const errors: Record<string, string> = {};
  if (!["share", "issues", "revise", "edit_reminder"].includes(input.action)) errors.text = "Unknown action.";
  if (!input.text.trim()) errors.text = "Enter some text.";
  if (input.text.length > (input.action === "share" ? 3000 : input.action === "issues" ? 2500 : 1000)) errors.text = "This text is too long.";
  if (input.action === "share" && !/^[CG][A-Z0-9]+$/.test(input.channelId ?? "")) errors.channel = "Select a channel.";
  if (input.action === "issues") {
    if (!["github", "linear"].includes(input.target ?? "")) errors.target = "Select an issue provider.";
    if (parseFollowUpsFromText(input.text).length > 5) errors.text = "Create at most five tasks per approval.";
  }
  if (input.action === "edit_reminder" && (!input.when || !Number.isFinite(input.when) || input.when * 1000 <= Date.now())) errors.when = "Choose a future time.";
  return errors;
}
export async function submitWidgetWorkflow(record: WidgetRecord, submission: WidgetSubmission, io: WidgetIO, dependencies: WidgetWorkflowDeps = {}) {
  const deps = { ...defaults, ...dependencies };
  if (Object.keys(validateWidgetSubmission(submission)).length) throw new Error("Invalid form values. Open the form again.");
  if (submission.action === "share" || submission.action === "issues") {
    const approval = submission.action === "share"
      ? { type: "post" as const, channelId: submission.channelId!, text: submission.text }
      : { type: "issues" as const, targets: [submission.target as IssueTarget], tasks: parseFollowUpsFromText(submission.text),
        destinations: getIssueDestinations([submission.target as IssueTarget]) };
    if (approval.type === "post") await deps.assertSlackTargetChannelAllowed({ userId: record.target.userId,
      channelId: approval.channelId, action: "preview_post", surface: "slack-interaction" });
    if (!await claimWidgetAction(record.id, submission.action + "_review", deps.store)) return io.tell("A review card was already created. Use that card to approve or reject.");
    return queueWidgetApproval(record.target, approval, "Review before sending",
      approval.type === "post" ? `Destination: <#${approval.channelId}>\n\n${escapeSlack(approval.text)}`
        : `Provider: ${submission.target}\nDestination: ${escapeSlack(Object.values(approval.destinations).join(", "))}\n\n` +
          approval.tasks.map((task) => { const draft = buildIssueDraft(approval.targets[0]!, task);
            return escapeSlack(draft.title + "\n" + draft.body); }).join("\n\n"),
      { store: deps.store, publish: (text, blocks) => io.privateCard ? io.privateCard(text, blocks) : io.reply(text, blocks) });
  }
  if (submission.action === "edit_reminder") {
    if (!record.schedule) throw new Error("No reminder attached.");
    if (!await claimWidgetAction(record.id, "edit_reminder", deps.store)) return io.tell("This edit is already processing or was processed.");
    const updated = await deps.editOwnedSchedule(record.schedule.id, record.target.userId, submission.text, new Date(submission.when! * 1000).toISOString());
    return publishReminder(record, updated, io, deps.store);
  }
  if (!record.artifact) throw new Error("No artifact attached.");
  const found = await deps.findArtifact(record.artifact.id, { ownerUserId: record.target.userId });
  if (found.status !== "found") throw new Error("Artifact is unavailable.");
  if (found.artifact.bytes > 24000) throw new Error("This document is too large for guided revision. Use /nobo-artifacts update with complete replacement content.");
  if (!await claimWidgetAction(record.id, "revise", deps.store)) return io.tell("This revision is already processing or was processed.");
  const content = await deps.readFile(found.artifact.path, "utf8");
  await io.tell("Revising the document. Its previous version will be retained.");
  const replacement = await deps.createWidgetRevision(content, submission.text, record.target.userId, found.artifact.kind);
  if (!replacement.trim()) throw new Error("The model returned an empty revision. Nothing was overwritten.");
  const latest = await deps.findArtifact(record.artifact.id, { ownerUserId: record.target.userId });
  if (latest.status !== "found" || latest.artifact.updatedAt !== found.artifact.updatedAt) throw new Error("The artifact changed while revising. Nothing was overwritten; start a fresh revision.");
  const result = await deps.updateArtifact({ idPrefix: record.artifact.id, ownerUserId: record.target.userId,
    expectedRevision: found.artifact.updatedAt ?? found.artifact.createdAt,
    content: replacement.replace(/^\`\`\`(?:html|markdown|md)?\s*\n([\s\S]*?)\n\`\`\`\s*$/, "$1") });
  if (!result.ok) throw new Error("Unable to save the revision: " + result.reason);
  const card = await saveWidget({ target: record.target, kind: "artifact", title: "Document revised", text: "Saved the revision. The previous version is retained.",
    artifact: { id: result.artifact.id, title: result.artifact.title, url: result.artifact.previewUrl } }, deps.store);
  return io.reply("Document revised: " + result.artifact.previewUrl, card ? renderWidget(card) : undefined);
}
