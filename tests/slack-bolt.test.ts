import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createSlackBolt } from "../src/slack-bolt.js";
import { getSlackAgentRun, withSlackAgentRun } from "../lib/slack-agent-runs.js";
import type { SlackInteractionResult } from "../lib/slack-commands.js";

const secret = "test-signing-secret";
async function fixture(
  handlers: Parameters<typeof createSlackBolt>[0]["handlers"] = {},
  clientOptions?: Parameters<typeof createSlackBolt>[0]["clientOptions"]
) {
  const { bolt, receiver } = createSlackBolt({
    signingSecret: secret, bodyLimit: 4096, handlers, clientOptions,
    authorize: async () => ({ botToken: "xoxb-test", botId: "B_BOT", botUserId: "U_BOT" })
  });
  await bolt.init();
  const server = createServer(receiver.requestListener).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  async function send(path: string, body: object | string, extra: Record<string, string> = {}) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const timestamp = extra["x-slack-request-timestamp"] ?? String(Math.floor(Date.now() / 1000));
    const signature = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex");
    return fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST", body: raw,
      headers: {
        "content-type": typeof body === "string" ? "application/x-www-form-urlencoded" : "application/json",
        "x-slack-request-timestamp": timestamp, "x-slack-signature": signature, ...extra
      }
    });
  }
  return { send, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

test("Bolt verifies signed challenges on the existing event URLs", async () => {
  const f = await fixture();
  try {
    for (const path of ["/api/slack/events", "/slack/events"]) {
      const response = await f.send(path, { type: "url_verification", challenge: "hello" });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /hello/);
    }
    assert.equal((await f.send("/api/slack/events", {}, { "x-slack-signature": "v0=invalid" })).status, 401);
    assert.equal((await f.send("/api/slack/events", {}, { "x-slack-request-timestamp": "1" })).status, 401);
    assert.equal((await f.send("/api/slack/events", { text: "x".repeat(5000) })).status, 413);
  } finally { await f.close(); }
});

test("Bolt acknowledges events before work finishes and suppresses retries", async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture({ event: async () => { calls++; await blocked; } });
  const body = { type: "event_callback", team_id: "T_TEST", event: { type: "app_mention", user: "U_TEST", channel: "C_TEST", text: "<@U_BOT> hi", ts: "1.1" } };
  try {
    assert.equal((await f.send("/api/slack/events", body)).status, 200);
    assert.equal(calls, 1);
    assert.equal((await f.send("/api/slack/events", body, { "x-slack-retry-num": "1" })).status, 200);
    assert.equal(calls, 1);
  } finally { release(); await f.close(); }
});

test("Bolt slash commands acknowledge immediately and deliver response_url messages", async () => {
  let received!: (body: string) => void;
  const delivered = new Promise<string>((resolve) => { received = resolve; });
  const responseServer = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received(body); res.end("ok");
  }).listen(0, "127.0.0.1");
  await once(responseServer, "listening");
  const { port } = responseServer.address() as { port: number };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture({ command: async () => {
    await blocked;
    return { response: { response_type: "ephemeral", text: "Bolt works", mrkdwn: true } };
  } });
  try {
    const response = await f.send("/api/slack/commands", new URLSearchParams({
      command: "/nobo-status", text: "", user_id: "U_TEST", channel_id: "C_TEST", team_id: "T_TEST",
      response_url: `http://127.0.0.1:${port}/reply`
    }).toString());
    assert.equal(response.status, 200);
    release();
    assert.equal(JSON.parse(await delivered).text, "Bolt works");
  } finally {
    release(); await f.close();
    responseServer.close(); responseServer.closeAllConnections();
  }
});

test("Bolt returns modal updates through view acknowledgement", async () => {
  const view = { type: "modal", title: { type: "plain_text", text: "Updated" }, blocks: [] };
  const f = await fixture({ interaction: async () => ({ response: { response_action: "update", view } }) });
  try {
    const response = await f.send("/api/slack/interactions", new URLSearchParams({ payload: JSON.stringify({
      type: "view_submission", team: { id: "T_TEST" }, user: { id: "U_TEST" },
      view: { id: "V_TEST", callback_id: "nobo_modal", state: { values: {} } }
    }) }).toString());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { response_action: "update", view });
  } finally { await f.close(); }
});

test("Bolt dispatches model actions, shortcut modals, Agent prompts and Stop through official clients", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let nextCall: (() => void) | undefined;
  const fakeApi = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = req.headers["content-type"]?.includes("application/json")
      ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ path: req.url!, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    nextCall?.();
  }).listen(0, "127.0.0.1");
  await once(fakeApi, "listening");
  const { port } = fakeApi.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;
  const f = await fixture({ interaction: async (payload): Promise<SlackInteractionResult> => payload.type === "shortcut"
    ? { response: {}, modal: { triggerId: "trigger", view: { type: "modal", title: { type: "plain_text", text: "Prefs" }, blocks: [] } } }
    : { response: { response_type: "ephemeral", text: "Model updated", mrkdwn: true, replace_original: true } }
  }, { slackApiUrl: origin + "/api/", retryConfig: { retries: 0 } });
  async function sendAndWait(path: string, body: object | string) {
    const delivered = new Promise<void>((resolve) => { nextCall = resolve; });
    assert.equal((await f.send(path, body)).status, 200);
    await delivered;
    nextCall = undefined;
  }
  const interaction = (payload: object) => new URLSearchParams({ payload: JSON.stringify({
    team: { id: "T_TEST" }, user: { id: "U_TEST" }, ...payload
  }) }).toString();
  try {
    await sendAndWait("/api/slack/interactions", interaction({
      type: "block_actions", channel: { id: "C_TEST" }, response_url: origin + "/response",
      actions: [{ type: "static_select", action_id: "nobo_channel_model", selected_option: { value: "kimi-k3" } }]
    }));
    assert.equal(calls.at(-1)?.path, "/response");
    assert.equal(calls.at(-1)?.body.replace_original, true);
    await sendAndWait("/api/slack/interactions", interaction({ type: "shortcut", callback_id: "nobo_prefs", trigger_id: "trigger" }));
    assert.equal(calls.at(-1)?.path, "/api/views.open");
    await sendAndWait("/api/slack/events", {
      type: "event_callback", team_id: "T_TEST",
      event: { type: "app_home_opened", tab: "messages", user: "U_TEST", channel: "D_TEST" }
    });
    assert.equal(calls.at(-1)?.path, "/api/assistant.threads.setSuggestedPrompts");
    let cancelled = false;
    await withSlackAgentRun({ teamId: "T_TEST", channelId: "D_TEST", threadTs: "1.1", userId: "U_TEST" }, async () => {
      getSlackAgentRun()!.cancellers.add(async () => { cancelled = true; });
      await sendAndWait("/api/slack/events", {
        type: "event_callback", team_id: "T_TEST",
        event: { type: "agent_session_stopped", channel: "D_TEST", thread_ts: "1.1", user: "U_TEST", streaming_message_ts: [], event_ts: "2.2" }
      });
      assert.equal(cancelled, true);
      assert.equal(calls.at(-1)?.path, "/api/agents.sessions.setStatus");
      assert.equal(calls.at(-1)?.body.status, "active");
    });
  } finally {
    await f.close();
    fakeApi.close(); fakeApi.closeAllConnections();
  }
});
