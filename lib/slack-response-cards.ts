import { getSlackAgentRun } from "./slack-agent-runs.js";
import { renderWidget, safeWidgetUrl, saveWidget, type WidgetRecord, type WidgetStore } from "./slack-widgets.js";

export const READ_ONLY_TOOL_NAMES = new Set([
  "web_search", "get_current_time", "read_slack_channel_history", "list_artifacts",
  "list_artifact_versions", "diff_artifact_version", "list_schedules", "list_monitors", "present_result"
]);
export function classifyWidgetPrompt(prompt = ""): WidgetRecord["kind"] {
  if (/turn.{0,30}(tasks|checklist)|action.items|task list/i.test(prompt)) return "tasks";
  if (/catch.?up|summari[sz]e.{0,30}(channel|conversation|thread)|decisions.*(questions|actions)/i.test(prompt)) return "catchup";
  if (/research|search|compare|latest|sources|news/i.test(prompt)) return "research";
  return "answer";
}
export function publicModelFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/rate.?limit|429/i.test(message)) return "The model provider is rate-limiting requests. Wait a little, then retry or try another model.";
  if (/timeout|timed out/i.test(message)) return "The model provider took too long to respond. You can retry or try another model.";
  if (/DataPolicy|opt.in/i.test(message)) return "This model requires a provider consent setting. Try another model; NoBo cannot change that consent for you.";
  if (/invalid.*param|400/i.test(message)) return "The model provider rejected this request. Try another model.";
  return "NoBo could not finish this response. If tools already ran, check their results before asking again.";
}
function jsonOutput(output: unknown): Record<string, unknown> | undefined {
  if (typeof output === "string") {
    try { return jsonOutput(JSON.parse(output)); } catch { return; }
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) return;
  // Flue projects a text tool result as {content:[{type:"text",text:...}]}.
  const result = output as Record<string, unknown>;
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part?.type === "text") {
        const parsed = jsonOutput(part.text);
        if (parsed) return parsed;
      }
    }
  }
  return result;
}
export function createWidgetToolObserver() {
  const names = new Map<string, string>();
  return (chunk: { type: string; toolCallId?: string; toolName?: string; output?: unknown }) => {
    const run = getSlackAgentRun();
    if (!run || !chunk.toolCallId) return;
    if (chunk.type === "tool-input") {
      const name = chunk.toolName ?? "";
      names.set(chunk.toolCallId, name);
      if (!READ_ONLY_TOOL_NAMES.has(name)) run.hasSideEffects = true;
      return;
    }
    if (chunk.type !== "tool-output" && chunk.type !== "tool-output-error") return;
    const name = names.get(chunk.toolCallId);
    names.delete(chunk.toolCallId);
    const result = jsonOutput(chunk.output);
    if (!result || result.error) return;
    if (name === "web_search" && Array.isArray(result.results)) {
      run.widget.kind = "research";
      for (const source of result.results) {
        if (typeof source?.url !== "string" || !safeWidgetUrl(source.url)) continue;
        const sources = run.widget.sources ??= [];
        if (sources.length < 5 && !sources.some((s) => s.url === source.url)) {
          sources.push({ title: String(source.title ?? source.url).slice(0, 150), url: source.url });
        }
      }
    }
    if (name === "read_slack_channel_history" && Array.isArray(result.messages)) {
      run.widget.kind = "catchup";
      const sources = run.widget.sources ??= [];
      for (const entry of result.messages) {
        if (sources.length >= 5) break;
        if (typeof entry?.permalink === "string" && safeWidgetUrl(entry.permalink)) {
          sources.push({ title: String(entry.text ?? "Conversation").slice(0, 100), url: entry.permalink });
        }
      }
    }
    if (name === "present_result" && Array.isArray(result.sections)) {
      run.widget.sections = result.sections.filter((s) => typeof s?.title === "string" && typeof s?.text === "string")
        .slice(0, 3).map((s) => ({ title: s.title.slice(0, 80), text: s.text.slice(0, 2400) }));
      if (result.kind === "research" || result.kind === "catchup") run.widget.kind = result.kind;
    }
    if (name === "create_artifact" || name === "update_artifact") {
      const artifact = result.artifact && typeof result.artifact === "object" ? result.artifact as Record<string, unknown> : result;
      if (typeof artifact.id === "string" && typeof artifact.previewUrl === "string" && safeWidgetUrl(artifact.previewUrl)) {
        run.widget.artifact = { id: artifact.id, title: String(artifact.title ?? "Document"), url: artifact.previewUrl,
          ...(typeof artifact.imageUrl === "string" && safeWidgetUrl(artifact.imageUrl) ? { imageUrl: artifact.imageUrl } : {}) };
        run.widget.kind = "artifact";
      }
    }
  };
}
export async function buildResponseFooter(text: string, failed = false, store?: WidgetStore | null) {
  const run = getSlackAgentRun();
  if (!run || process.env.SLACK_WIDGETS === "off") return [];
  const kind = failed ? "error" : run.widget.kind ?? classifyWidgetPrompt(run.widget.prompt);
  const record = await saveWidget({
    ...run.widget, target: { teamId: run.teamId, userId: run.userId, channelId: run.channelId, threadTs: run.threadTs },
    kind, presentation: "footer", title: failed ? "NoBo needs another try" : kind === "research" ? "Research results" :
      kind === "catchup" ? "Conversation catch-up" : "NoBo response",
    text: text.slice(0, 24000), replaySafe: !run.hasSideEffects && run.widget.replaySafe !== false
  }, store);
  return record ? renderWidget(record, false) : [];
}
