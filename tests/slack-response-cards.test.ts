import assert from "node:assert/strict";
import test from "node:test";
import { withSlackAgentRun, getSlackAgentRun } from "../lib/slack-agent-runs.js";
import { buildResponseFooter, classifyWidgetPrompt, createWidgetToolObserver, publicModelFailure } from "../lib/slack-response-cards.js";
import { performWidgetAction } from "../lib/slack-widget-workflows.js";
import { saveWidget, type WidgetStore } from "../lib/slack-widgets.js";
const target = { userId: "U123", teamId: "T123", channelId: "C123", threadTs: "1.1" };
function db(): WidgetStore {
  const values = new Map<string, string>();
  return { get: async (key) => values.get(key) ?? null, set: async (key, value, options) => {
    if (options.NX && values.has(key)) return null;
    values.set(key, value); return "OK";
  } };
}
test("Tool results populate verified research sources and structured catch-up sections", async () => {
  await withSlackAgentRun(target, async () => {
    const observe = createWidgetToolObserver();
    observe({ type: "tool-input", toolCallId: "1", toolName: "web_search" });
    observe({ type: "tool-output", toolCallId: "1", output: { content: [{ type: "text", text: JSON.stringify({
      results: [{ title: "Source", url: "https://example.com" }, { title: "bad", url: "javascript:alert(1)" }]
    }) }] } });
    assert.deepEqual(getSlackAgentRun()!.widget.sources, [{ title: "Source", url: "https://example.com" }]);
    observe({ type: "tool-input", toolCallId: "2", toolName: "present_result" });
    observe({ type: "tool-output", toolCallId: "2", output: JSON.stringify({
      kind: "catchup", sections: [{ title: "Decisions", text: "Ship Friday." }, { title: "Open questions", text: "Owner unknown." }]
    }) });
    assert.equal(getSlackAgentRun()!.widget.kind, "catchup");
    const footer = JSON.stringify(await buildResponseFooter("Brief summary", false, db()));
    assert.match(footer, /Decisions|Open questions/);
    assert.doesNotMatch(footer, /Brief summary/);
    assert.equal(getSlackAgentRun()!.hasSideEffects, false);
  });
});
test("Attempting a mutating tool removes automatic retry even when the tool fails", async () => {
  await withSlackAgentRun(target, async () => {
    createWidgetToolObserver()({ type: "tool-input", toolCallId: "write1", toolName: "create_artifact" });
    const footer = JSON.stringify(await buildResponseFooter("Failed", true, db()));
    assert.doesNotMatch(footer, /nobo_widget_retry|nobo_widget_alternate/);
  }, undefined, "create a note");
});
test("Artifact cards use actual tool output, never model-invented links", async () => {
  await withSlackAgentRun(target, async () => {
    const observe = createWidgetToolObserver();
    observe({ type: "tool-input", toolCallId: "1", toolName: "update_artifact" });
    observe({ type: "tool-output", toolCallId: "1", output: { ok: true, artifact: {
      id: "abc", title: "Report", previewUrl: "https://example.com/report"
    } } });
    assert.deepEqual(getSlackAgentRun()!.widget.artifact, { id: "abc", title: "Report", url: "https://example.com/report" });
  });
});
test("Public error notices do not echo credentials or raw provider errors", () => {
  const message = publicModelFailure(new Error("HTTP 400 invalid parameters token=secret-123"));
  assert.match(message, /provider rejected/);
  assert.doesNotMatch(message, /secret-123/);
  assert.equal(classifyWidgetPrompt("summarize this channel"), "catchup");
  assert.equal(classifyWidgetPrompt("research latest news"), "research");
});
test("Save action includes sources, is owner-scoped, and executes once", async () => {
  const store = db();
  const r = (await saveWidget({ target, kind: "research", title: "Research", text: "Overview",
    sources: [{ title: "Source", url: "https://example.com" }], sections: [{ title: "Findings", text: "Result" }] }, store))!;
  let writes = 0;
  const notices: string[] = [];
  const deps = { store, createArtifact: async (args: Parameters<typeof import("../lib/artifacts.js").createArtifact>[0]) => {
    writes++;
    assert.equal(args.ownerUserId, target.userId);
    assert.match(args.content, /Overview[\s\S]*Findings[\s\S]*https:\/\/example.com/);
    return { id: "artifact1", title: "Research", kind: "markdown" as const, filename: "note.md", previewUrl: "https://example.com/note",
      rawUrl: "https://example.com/raw", path: "/test/note.md", createdAt: new Date().toISOString(), bytes: 10 };
  } };
  const io = { tell: async (text: string) => { notices.push(text); }, reply: async () => {}, open: async () => {} };
  await performWidgetAction(r, "save", io, deps);
  await performWidgetAction(r, "save", io, deps);
  assert.equal(writes, 1);
  assert.match(notices.join(" "), /already/);
});
test("Unsafe recovery never invokes the model, and read-only follow-up preserves the thread", async () => {
  const store = db();
  const r = (await saveWidget({ target, kind: "error", title: "Error", text: "Oops", prompt: "hello", replaySafe: false }, store))!;
  let generated = 0;
  const io = { tell: async () => {}, reply: async () => {}, open: async () => {} };
  const deps = { store, postGeneratedSlackMessage: async (args: Parameters<typeof import("../lib/slack.js").postGeneratedSlackMessage>[0]) => {
    generated++; assert.equal(args.threadTs, target.threadTs); return null;
  } };
  await performWidgetAction(r, "retry", io, deps);
  assert.equal(generated, 0);
  await performWidgetAction(r, "shorter", io, deps);
  assert.equal(generated, 1);
});
