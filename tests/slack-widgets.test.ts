import assert from "node:assert/strict";
import test from "node:test";
import { saveWidget, loadWidget, claimWidgetAction, renderWidget, safeWidgetUrl, saveWidgetFeedback, type WidgetStore } from "../lib/slack-widgets.js";
const target = { userId: "U123", teamId: "T123", channelId: "C123", threadTs: "1.1" };
function memoryStore() {
  const values = new Map<string, string>();
  const expirations: number[] = [];
  const store: WidgetStore = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value, options) {
      expirations.push(options.EX);
      if (options.NX && values.has(key)) return null;
      values.set(key, value); return "OK";
    }
  };
  return { store, values, expirations };
}
test("Widget state is expiring, opaque and bound to owner/team/channel and live policy", async () => {
  const { store, expirations } = memoryStore();
  const record = (await saveWidget({ target, kind: "answer", title: "Answer", text: "private answer" }, store))!;
  assert.equal((await loadWidget(record.id, target, store, async () => ({ allowed: true }))).text, "private answer");
  for (const field of ["userId", "teamId", "channelId"] as const) {
    await assert.rejects(loadWidget(record.id, { ...target, [field]: "OTHER" }, store), /another/);
  }
  await assert.rejects(loadWidget(record.id, target, store, async () => ({ allowed: false })), /restricted/);
  await assert.rejects(loadWidget("invalid", target, store), /invalid/);
  assert.equal(expirations[0], 86400);
});
test("Widget writes claim once, including concurrent duplicate clicks", async () => {
  const { store } = memoryStore();
  const r = (await saveWidget({ target, kind: "answer", title: "Hi", text: "hello" }, store))!;
  const claims = await Promise.all(Array.from({ length: 12 }, () => claimWidgetAction(r.id, "save", store)));
  assert.equal(claims.filter(Boolean).length, 1);
});
test("No Redis means no interactive record, and expired cards fail closed", async () => {
  assert.equal(await saveWidget({ target, kind: "answer", title: "Hi", text: "hello" }, null), null);
  await assert.rejects(loadWidget("12345678-1234-1234-1234-123456789abc", target, memoryStore().store), /expired/);
  await assert.rejects(claimWidgetAction("12345678-1234-1234-1234-123456789abc", "save", null), /Redis/);
});
test("Card URLs reject executable and credential-bearing links; titles cannot ping Slack", async () => {
  assert.equal(safeWidgetUrl("javascript:alert(1)"), null);
  assert.equal(safeWidgetUrl("https://token@example.com/"), null);
  const { store } = memoryStore();
  const r = (await saveWidget({ target, kind: "research", title: "Result", text: "Summary",
    sources: [{ title: "<!channel>", url: "https://example.com" }, { title: "bad", url: "javascript:x" }]
  }, store))!;
  const json = JSON.stringify(renderWidget(r));
  assert.doesNotMatch(json, /<!channel>|javascript:/);
  assert.match(json, /&lt;!channel&gt;/);
  assert.match(json, /nobo_widget_save/);
  assert.match(json, /feedback_buttons/);
});
test("Native footer avoids duplicating the answer; error retry is only offered for safe runs", async () => {
  const { store } = memoryStore();
  const r = (await saveWidget({ target, kind: "error", title: "Oops", text: "error details", prompt: "search", replaySafe: false }, store))!;
  assert.doesNotMatch(JSON.stringify(renderWidget(r, false)), /error details|nobo_widget_retry/);
  assert.match(JSON.stringify(renderWidget({ ...r, replaySafe: true })), /nobo_widget_retry/);
});
test("Feedback stores rating and bounded optional detail with expiration", async () => {
  const { store, values } = memoryStore();
  const r = (await saveWidget({ target, kind: "answer", title: "Hi", text: "answer" }, store))!;
  await saveWidgetFeedback(r, "bad", "x".repeat(3000), store);
  const data = JSON.parse([...values.entries()].find(([key]) => key.endsWith(":feedback"))![1]);
  assert.equal(data.rating, "bad");
  assert.equal(data.detail.length, 2000);
});
