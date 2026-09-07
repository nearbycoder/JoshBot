import { randomUUID } from "node:crypto";
import { getRedisClient } from "./redis.js";
import { evaluateNoboAccess } from "./access-controls.js";
import type { SlackScheduleContext, ScheduleToolInput } from "./schedules.js";
import type { IssueTarget } from "./issue-drafts.js";
import type { ThreadFollowUpDraft } from "./follow-ups.js";

export type WidgetTarget = { teamId: string; channelId: string; threadTs: string; userId: string };
export type WidgetSource = { title: string; url: string };
export type WidgetApproval =
  | { type: "schedule"; context: SlackScheduleContext; schedule: ScheduleToolInput; firstRunAt: string }
  | { type: "post"; channelId: string; text: string }
  | { type: "issues"; targets: IssueTarget[]; tasks: ThreadFollowUpDraft[]; context?: SlackScheduleContext; destinations: Partial<Record<IssueTarget, string>> };
export type WidgetRecord = {
  id: string; target: WidgetTarget; createdAt: string;
  kind: "answer" | "research" | "catchup" | "tasks" | "artifact" | "reminder" | "approval" | "error";
  title: string; text: string; prompt?: string;
  sources?: WidgetSource[];
  sections?: Array<{ title: string; text: string }>;
  model?: { selected: string; used: string; reason?: string };
  artifact?: { id: string; title: string; url: string; imageUrl?: string };
  presentation?: "footer";
  actions?: Record<string, WidgetActionState>;
  schedule?: { id: string; summary: string; nextRunAt: string; timeZone: string; channelId: string };
  approval?: WidgetApproval;
  // These are offered only on read-only runs. Never replay tool side effects.
  replaySafe?: boolean;
};
export type WidgetActionState = { status: "working" | "done" | "failed"; label: string };
const stateActions = ["decision", "save", "revise", "edit_reminder", "cancel_reminder", "share_review", "issues_review", "shorter", "deeper", "compare", "tasks", "retry", "alternate"];
export type WidgetOrigin = { ts?: string; blocks?: WidgetBlock[]; responseUrl?: string; ephemeral?: boolean };
export type WidgetStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number; NX?: boolean }): Promise<string | null>;
};
export const WIDGET_TTL_SECONDS = 86_400;
export function widgetContent(record: WidgetRecord) {
  return [record.text, ...(record.sections ?? []).map((s) => `## ${s.title}\n${s.text}`),
    ...(record.sources?.length ? ["## Sources\n" + record.sources.map((s) => `- ${s.title}: ${s.url}`).join("\n")] : [])
  ].join("\n\n").slice(0, 32000);
}
const prefix = "nobo:widget:v1:";
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
export async function widgetStore(): Promise<WidgetStore | null> {
  const redis = await getRedisClient();
  return redis ? { get: (key) => redis.get(key), set: (key, value, options) => redis.set(key, value, options) } : null;
}
export async function saveWidget(record: Omit<WidgetRecord, "id" | "createdAt">, store?: WidgetStore | null) {
  const db = store === undefined ? await widgetStore() : store;
  if (!db) return null;
  const { teamId, channelId, threadTs, userId } = record.target;
  const saved: WidgetRecord = { ...record, target: { teamId, channelId, threadTs, userId }, id: randomUUID(), createdAt: new Date().toISOString() };
  if (Buffer.byteLength(JSON.stringify(saved)) > 100_000) throw new Error("Widget exceeds storage limit");
  await db.set(prefix + saved.id, JSON.stringify(saved), { EX: WIDGET_TTL_SECONDS });
  return saved;
}
export async function loadWidget(id: string, target: Omit<WidgetTarget, "threadTs">,
  store?: WidgetStore | null, checkAccess = evaluateNoboAccess) {
  if (!validId(id)) throw new Error("This action is invalid.");
  const db = store === undefined ? await widgetStore() : store;
  if (!db) throw new Error("Interactive actions require Redis. Please try again later.");
  const raw = await db.get(prefix + id);
  if (!raw) throw new Error("This card expired. Ask NoBo for a fresh response.");
  const record = JSON.parse(raw) as WidgetRecord;
  if (record.target.userId !== target.userId || record.target.channelId !== target.channelId ||
      record.target.teamId !== target.teamId) throw new Error("This card belongs to another conversation or user.");
  if (!(await checkAccess({ userId: target.userId, teamId: target.teamId, channelId: target.channelId,
    action: "widget", surface: "slack-interaction" })).allowed) throw new Error("NoBo access is restricted here.");
  record.actions = Object.fromEntries((await Promise.all(stateActions.map(async (action) => {
    const state = await db.get(prefix + id + ":state:" + action);
    return state ? [action, JSON.parse(state)] : null;
  }))).filter((entry) => entry !== null));
  return record;
}
export async function setWidgetActionState(record: WidgetRecord, action: string, state: WidgetActionState, store?: WidgetStore | null) {
  if (!stateActions.includes(action)) throw new Error("Invalid widget state.");
  const db = store === undefined ? await widgetStore() : store;
  if (!db) throw new Error("Interactive actions require Redis.");
  await db.set(prefix + record.id + ":state:" + action, JSON.stringify(state), { EX: WIDGET_TTL_SECONDS });
  (record.actions ??= {})[action] = state;
}
export async function storeWidgetOrigin(record: WidgetRecord, origin: WidgetOrigin) {
  const db = await widgetStore();
  if (JSON.stringify(origin).length > 150000) return;
  await db?.set(prefix + record.id + ":origin", JSON.stringify(origin), { EX: 1800 });
}
export async function loadWidgetOrigin(record: WidgetRecord): Promise<WidgetOrigin | null> {
  const db = await widgetStore();
  const raw = await db?.get(prefix + record.id + ":origin");
  return raw ? JSON.parse(raw) : null;
}
/** Claims persist even after errors: never duplicate an external write after an ambiguous failure. */
export async function claimWidgetAction(id: string, action: string, store?: WidgetStore | null) {
  const db = store === undefined ? await widgetStore() : store;
  if (!db) throw new Error("Interactive actions require Redis.");
  if (!validId(id) || !/^[a-z_-]{1,40}$/.test(action)) throw new Error("Invalid action.");
  return (await db.set(prefix + id + ":claim:" + action, "claimed", { EX: WIDGET_TTL_SECONDS, NX: true })) === "OK";
}
export async function saveWidgetFeedback(record: WidgetRecord, rating: "good" | "bad", detail = "", store?: WidgetStore | null) {
  const db = store === undefined ? await widgetStore() : store;
  if (!db) throw new Error("Feedback storage is unavailable.");
  await db.set(prefix + record.id + ":feedback", JSON.stringify({
    rating, detail: detail.slice(0, 2000), userId: record.target.userId, at: new Date().toISOString()
  }), { EX: WIDGET_TTL_SECONDS });
}

export type WidgetBlock = Record<string, unknown>;
export const plain = (text: string) => ({ type: "plain_text" as const, text: text.slice(0, 150), emoji: true });
export const escapeSlack = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function safeWidgetUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href.replace(/[<>|]/g, (c) => encodeURIComponent(c));
  } catch { return null; }
}
export function widgetButton(label: string, action: string, id: string, confirm?: string): WidgetBlock {
  return { type: "button", text: plain(label), action_id: "nobo_widget_" + action, value: id,
    ...(confirm ? { confirm: { title: plain("Confirm action"), text: plain(confirm), confirm: plain("Confirm"), deny: plain("Go back") } } : {}) };
}
export function textBlocks(text: string): WidgetBlock[] {
  const chunks = text.match(/[\s\S]{1,2900}/g) ?? ["No content."];
  return chunks.slice(0, 12).map((text) => ({ type: "section", text: { type: "mrkdwn", text } }));
}
/** Footer-only mode preserves the existing streamed answer and its task history. */
export function renderWidget(record: WidgetRecord, includeText = true): WidgetBlock[] {
  return renderWidgetContent(record, includeText).map((block, index) => ({ ...block, block_id: `nobo_w:${record.id}:${index}` }));
}
export function refreshWidgetBlocks(record: WidgetRecord, original: WidgetBlock[] = []) {
  const tagged = original.some((block) => String(block.block_id ?? "").startsWith(`nobo_w:${record.id}:`));
  const preserved = tagged ? original.filter((block) => !String(block.block_id ?? "").startsWith(`nobo_w:${record.id}:`)) : [];
  return [...preserved, ...renderWidget(record, tagged ? record.presentation !== "footer" : true)].slice(0, 50);
}
function renderWidgetContent(record: WidgetRecord, includeText: boolean): WidgetBlock[] {
  const blocks: WidgetBlock[] = [];
  const decision = record.actions?.decision;
  const title = record.approval && decision ? decision.status === "working" ? "Processing request"
    : decision.status === "failed" ? "Action needs attention" : decision.label.startsWith("Rejected") ? "Rejected" : "Approved" : record.title;
  if (includeText) blocks.push({ type: "header", text: plain(title.slice(0, 150)) }, ...textBlocks(record.text));
  for (const section of (record.sections ?? []).slice(0, 3)) {
    blocks.push(...textBlocks("*" + escapeSlack(section.title.slice(0, 80)) + "*\n" + section.text.slice(0, 2400)));
  }
  const sources = (record.sources ?? []).flatMap((source) => {
    const url = safeWidgetUrl(source.url);
    return url ? [`• <${url}|${escapeSlack(source.title).replace(/\|/g, " ").slice(0, 150)}>`] : [];
  }).slice(0, 5);
  if (sources.length) blocks.push(...textBlocks("*Sources*\n" + sources.join("\n")));
  const imageUrl = record.artifact?.imageUrl && safeWidgetUrl(record.artifact.imageUrl);
  if (imageUrl) blocks.unshift({ type: "image", image_url: imageUrl, alt_text: record.artifact!.title.slice(0, 2000) });
  if (record.model && (record.model.reason || record.model.selected !== record.model.used)) {
    const { selected, used, reason } = record.model;
    blocks.push({ type: "context", elements: [{ type: "mrkdwn",
      text: escapeSlack(`Model: ${used}${selected !== used ? " · selected: " + selected : ""}${reason ? " · " + reason : ""}`).slice(0, 2000) }] });
  }
  if (record.schedule) {
    const s = record.schedule;
    blocks.push(...textBlocks("*Reminder*\n" + escapeSlack(s.summary).slice(0, 2000) +
      `\nNext: ${escapeSlack(s.nextRunAt)} · Timezone: ${escapeSlack(s.timeZone)} · Destination: <#${s.channelId}>`));
  }
  const states = Object.values(record.actions ?? {});
  if (states.length) blocks.push({ type: "context", elements: [{ type: "plain_text", text:
    [...new Set(states.map((state) => state.label))].slice(-2).join(" · ").slice(0, 2000) }] });
  if (record.approval) {
    if (record.actions?.decision) return blocks;
    blocks.push(...textBlocks("*Review this action before approving.*"));
    blocks.push({ type: "actions", elements: [
      widgetButton("Approve", "approve", record.id, "Perform the exact action shown on this card?"),
      widgetButton("Reject", "reject", record.id)
    ] });
    return blocks.slice(0, 45);
  }
  if (record.schedule) {
    if (!record.actions?.cancel_reminder && !record.actions?.edit_reminder) blocks.push({ type: "actions", elements: [
      widgetButton("Edit", "edit_reminder", record.id),
      widgetButton("Cancel", "cancel_reminder", record.id, "Cancel this reminder?")
    ] });
    return blocks;
  }
  const buttons: WidgetBlock[] = [];
  const overflow: Array<{ label: string; action: string }> = [];
  const addButton = (label: string, action: string) => { if (!record.actions?.[action]) buttons.push(widgetButton(label, action, record.id)); };
  const addMenu = (label: string, action: string) => { if (!record.actions?.[action === "share" || action === "issues" ? action + "_review" : action]) overflow.push({ label, action }); };
  if (record.artifact) {
    const url = safeWidgetUrl(record.artifact.url);
    if (url) buttons.push({ type: "button", text: plain(/meme/i.test(record.artifact.title) ? "Open meme" : "Open document"), action_id: "nobo_widget_open", url });
    addButton("Revise", "revise"); addMenu("Version history", "versions"); addMenu("Post elsewhere…", "share");
  } else if (record.kind === "error") {
    if (record.replaySafe && record.prompt) { addButton("Retry", "retry"); addButton("Try another model", "alternate"); }
  } else if (record.kind === "research") {
    addButton("Save note", "save"); addButton("Dig deeper", "deeper");
    addMenu("Make shorter", "shorter"); addMenu("Compare alternatives", "compare"); addMenu("Turn into tasks", "tasks"); addMenu("Post elsewhere…", "share");
  } else if (record.kind === "catchup" || record.kind === "tasks") {
    addButton("Save note", "save");
    if (record.kind === "catchup") addButton("Turn into tasks", "tasks");
    else addButton("Create issues…", "issues");
    addMenu("Make shorter", "shorter"); addMenu("Post elsewhere…", "share");
    if (record.kind === "catchup") addMenu("Create issues…", "issues");
  } else if (record.text.length > 280) {
    addButton("Save note", "save"); addButton("Make shorter", "shorter"); addMenu("Post elsewhere…", "share");
  }
  if (record.model) addMenu("Response details", "model_info");
  if (overflow.length) buttons.push({ type: "overflow", action_id: "nobo_widget_more", options: overflow.slice(0, 5)
    .map(({ label, action }) => ({ text: plain(label), value: `${record.id}:${action}` })) });
  if (buttons.length) blocks.push({ type: "actions", elements: buttons });
  if (record.kind === "error") return blocks;
  blocks.push({ type: "context_actions", elements: [{
    type: "feedback_buttons", action_id: "nobo_widget_feedback",
    positive_button: { text: plain("Helpful"), value: record.id + ":good" },
    negative_button: { text: plain("Not helpful"), value: record.id + ":bad" }
  }] });
  return blocks.slice(0, 45);
}
