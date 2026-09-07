import assert from "node:assert/strict";
import test from "node:test";
import { renderWidget, refreshWidgetBlocks, saveWidget, loadWidget, type WidgetRecord, type WidgetStore } from "../lib/slack-widgets.js";
import { performWidgetAction } from "../lib/slack-widget-workflows.js";
import { refreshWidgetMessage, validSlackResponseUrl } from "../lib/slack-widget-presentation.js";
import { integrationStatus } from "../src/slack-home-actions.js";
import type { WebClient } from "@slack/web-api";

const target = { teamId: "T123", channelId: "C123", threadTs: "1.1", userId: "U123" };
const base: WidgetRecord = { id: "12345678-1234-1234-1234-123456789abc", target, createdAt: "2026-01-01", kind: "answer", title: "Answer", text: "Hello",
  model: { selected: "kimi-k3", used: "kimi-k3" } };
function elements(record: WidgetRecord) { return renderWidget(record).flatMap((block) => block.type === "actions" ? block.elements as Array<Record<string, any>> : []); }
function store(): WidgetStore { const values = new Map<string, string>(); return { get: async (key) => values.get(key) ?? null,
  set: async (key, value, options) => { if (options.NX && values.has(key)) return null; values.set(key, value); return "OK"; } }; }

test("every response type has at most two buttons and one five-item overflow", () => {
  for (const kind of ["answer", "research", "catchup", "tasks", "artifact", "reminder", "error", "approval"] as const) {
    const record = { ...base, kind, text: "Long response ".repeat(80),
      ...(kind === "artifact" ? { artifact: { id: "art1", title: "Meme", url: "https://example.com/meme" } } : {}),
      ...(kind === "reminder" ? { schedule: { id: "job1", summary: "Check logs", nextRunAt: "2099-01-01", timeZone: "UTC", channelId: "C123" } } : {}),
      ...(kind === "approval" ? { approval: { type: "post" as const, channelId: "C123", text: "Approved text" } } : {}) };
    const controls = elements(record);
    assert.ok(controls.filter((e) => e.type === "button").length <= 2, kind);
    const menus = controls.filter((e) => e.type === "overflow");
    assert.ok(menus.length <= 1); assert.ok(menus.every((e) => e.options.length <= 5));
    assert.doesNotMatch(JSON.stringify(controls), /nobo_widget_reminders|nobo_widget_feedback_detail/);
  }
});
test("meme cards show the image and only Open, Revise, Versions, Share and details", () => {
  const record = { ...base, kind: "artifact" as const, artifact: { id: "art1", title: "Odin Meme", url: "https://example.com/meme", imageUrl: "https://example.com/meme.png" } };
  const blocks = renderWidget(record);
  assert.equal(blocks[0]?.type, "image"); assert.equal(blocks[0]?.image_url, record.artifact.imageUrl);
  const controls = elements(record);
  assert.deepEqual(controls.filter((e) => e.type === "button").map((e) => e.text.text), ["Open meme", "Revise"]);
  assert.doesNotMatch(JSON.stringify(controls), /save|shorter|deeper|compare|tasks|issues|reminders/);
  assert.doesNotMatch(JSON.stringify(blocks), /Model: kimi/);
  assert.match(JSON.stringify(controls), /model_info/);
});
test("fallback metadata remains visible while normal metadata is on demand", () => {
  const json = JSON.stringify(renderWidget({ ...base, model: { selected: "muse", used: "kimi-k3", reason: "Provider consent required" } }));
  assert.match(json, /Provider consent required/);
  assert.doesNotMatch(JSON.stringify(renderWidget(base)), /Model:/);
});
test("refresh replaces only this response's footer and retains native text/tasks", () => {
  const record = { ...base, presentation: "footer" as const, kind: "research" as const };
  const native = { type: "markdown", block_id: "native-content", text: "Original answer and task content" };
  const original = [native, ...renderWidget(record, false)];
  const result = refreshWidgetBlocks({ ...record, actions: { save: { status: "done", label: "Saved" } } }, original);
  assert.deepEqual(result[0], native);
  assert.doesNotMatch(JSON.stringify(result), /nobo_widget_save/);
  assert.equal(result.filter((b) => b.block_id === "native-content").length, 1);
  assert.match(JSON.stringify(result), /Saved/);
});
test("approval refresh removes controls, persists status, and failed UI cannot repeat posting", async () => {
  const db = store();
  const record = (await saveWidget({ ...base, kind: "approval", approval: { type: "post", channelId: "CDEST", text: "Exact" } }, db))!;
  let posts = 0; const states: string[] = [];
  const io = { tell: async () => {}, reply: async () => {}, open: async () => {}, postElsewhere: async () => { posts++; },
    refresh: async (r: WidgetRecord) => { states.push(r.actions!.decision!.status); throw new Error("Slack update unavailable"); } };
  const deps = { store: db, assertSlackTargetChannelAllowed: async () => {} };
  await performWidgetAction(record, "approve", io, deps); await performWidgetAction(record, "approve", io, deps);
  assert.equal(posts, 1); assert.deepEqual(states, ["working", "done"]);
  const reloaded = await loadWidget(record.id, target, db, async () => ({ allowed: true }));
  assert.equal(reloaded.actions?.decision?.status, "done");
  assert.doesNotMatch(JSON.stringify(renderWidget(reloaded)), /nobo_widget_approve|nobo_widget_reject/);
});
test("ephemeral refresh uses only signed Slack response destinations; public refresh uses timestamp", async (t) => {
  for (const url of ["https://evil.example/actions/id", "https://hooks.slack.com.evil.test/actions/id", "http://hooks.slack.com/actions/id", "https://secret@hooks.slack.com/actions/id"]) assert.equal(validSlackResponseUrl(url), false);
  assert.equal(validSlackResponseUrl("https://hooks.slack.com/actions/test"), true);
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let sends = 0, updates = 0;
  globalThis.fetch = (async (_url, options) => { sends++; assert.equal(JSON.parse(String(options?.body)).replace_original, true); return new Response("ok"); }) as typeof fetch;
  const client = { chat: { update: async (args: any) => { updates++; assert.equal(args.ts, "2.2"); } } } as unknown as WebClient;
  await refreshWidgetMessage(client, base, { ephemeral: true, responseUrl: "https://evil.test/actions/id" });
  assert.equal(sends, 0);
  await refreshWidgetMessage(client, base, { ephemeral: true, responseUrl: "https://hooks.slack.com/actions/test" });
  await refreshWidgetMessage(client, base, { ts: "2.2" });
  assert.equal(sends, 1); assert.equal(updates, 1);
});
test("integration readiness shows setup needs but never secrets", () => {
  const status = integrationStatus({ NOBO_GITHUB_TOKEN: "super-secret", NOBO_GITHUB_REPOSITORY: "owner/repo" });
  assert.match(status, /GitHub issues: configured/); assert.match(status, /Linear issues: needs/);
  assert.doesNotMatch(status, /super-secret/);
});
