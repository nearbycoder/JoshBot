import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@slack/bolt";
import { registerSlackWidgetActions } from "../src/slack-widget-actions.js";
import type { WidgetRecord } from "../lib/slack-widgets.js";

const record: WidgetRecord = { id: "12345678-1234-1234-1234-123456789abc", target: { userId: "U123", channelId: "C123", teamId: "T123", threadTs: "1.1" },
  kind: "answer", title: "Answer", text: "Hello", createdAt: "2026-01-01" };
function fixture() {
  let handler!: (args: any) => Promise<void>;
  const ratings: string[] = [], actions: string[] = [], views: any[] = [];
  let acknowledged = false;
  registerSlackWidgetActions({ action: (_pattern: unknown, fn: typeof handler) => { handler = fn; }, view: () => {} } as unknown as App, {
    loadWidget: async (id, target) => { assert.equal(acknowledged, true); assert.equal(id, record.id); assert.equal(target.userId, "U123"); return record; },
    saveWidgetFeedback: async (_record, rating) => { ratings.push(rating); },
    storeWidgetOrigin: async () => {}, performWidgetAction: async (_r, action) => { actions.push(action); }
  });
  const send = (action: any) => handler({ ack: async () => { acknowledged = true; }, action,
    body: { channel: { id: "C123" }, team: { id: "T123" }, user: { id: "U123" }, trigger_id: "trigger", message: { ts: "2.2", blocks: [] } },
    client: { views: { open: async ({ view }: any) => { views.push(view); } }, chat: { postEphemeral: async () => assert.fail("no noisy feedback receipt") } } });
  return { send, ratings, actions, views };
}
test("overflow selections dispatch their chosen action after acknowledgement and ownership lookup", async () => {
  const f = fixture();
  await f.send({ type: "overflow", action_id: "nobo_widget_more", selected_option: { value: record.id + ":versions" } });
  assert.deepEqual(f.actions, ["versions"]);
});
test("positive feedback is quiet; negative feedback saves rating then offers optional details", async () => {
  const f = fixture();
  await f.send({ type: "feedback_buttons", action_id: "nobo_widget_feedback", value: record.id + ":good" });
  assert.equal(f.views.length, 0);
  await f.send({ type: "feedback_buttons", action_id: "nobo_widget_feedback", value: record.id + ":bad" });
  assert.deepEqual(f.ratings, ["good", "bad"]); assert.equal(f.views.length, 1);
  const view = f.views[0];
  assert.equal(view.blocks[0].element.initial_option.value, "bad"); assert.equal(view.blocks[1].optional, true);
  assert.deepEqual(f.actions, []);
});
