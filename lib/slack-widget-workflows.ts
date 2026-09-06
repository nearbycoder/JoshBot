import type { ViewsOpenArguments } from "@slack/web-api";
import { createArtifact } from "./artifacts.js";
import { createWidgetContinuation } from "./ai.js";
import { postGeneratedSlackMessage } from "./slack.js";
import { withSlackAgentRun } from "./slack-agent-runs.js";
import { FALLBACK_SLACK_TEXT_MODEL, getDefaultSlackTextModel } from "./nobo-models.js";
import { claimWidgetAction, renderWidget, saveWidget, widgetContent, type WidgetRecord, type WidgetBlock, type WidgetStore } from "./slack-widgets.js";

export type WidgetIO = {
  tell(text: string): Promise<unknown>;
  reply(text: string, blocks?: WidgetBlock[]): Promise<unknown>;
  open(view: ViewsOpenArguments["view"]): Promise<unknown>;
};
const defaults = { createArtifact, createWidgetContinuation, postGeneratedSlackMessage };
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
