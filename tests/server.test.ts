import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { startNoboServer } from "../src/server.js";
import { getSlackAgentReadiness } from "../lib/slack-readiness.js";

test("Standalone production bootstrap starts Flue and Bolt together and shuts down cleanly", async () => {
  const previousBot = process.env.SLACK_BOT_USER_ID;
  const previousMode = process.env.SLACK_NATIVE_AI;
  process.env.SLACK_NATIVE_AI = "auto";
  const slackApi = createServer((req, res) => {
    assert.match(req.url!, /auth.test/);
    res.setHeader("content-type", "application/json");
    res.setHeader("x-oauth-scopes", "chat:write,assistant:write");
    res.end(JSON.stringify({ ok: true, bot_id: "B123", user_id: "U123", team_id: "T123" }));
  }).listen(0, "127.0.0.1");
  await once(slackApi, "listening");
  const apiPort = (slackApi.address() as { port: number }).port;
  let service: Awaited<ReturnType<typeof startNoboServer>> | undefined;
  try {
    service = await startNoboServer({
      signingSecret: "test-secret", token: "xoxb-test", port: 0, host: "127.0.0.1",
      backgroundRunners: false,
      clientOptions: { slackApiUrl: `http://127.0.0.1:${apiPort}/api/`, retryConfig: { retries: 0 }, timeout: 1000 }
    });
    const port = (service.server.address() as { port: number }).port;
    const root = `http://127.0.0.1:${port}`;
    const health = await fetch(root + "/healthz");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).slack, "bolt");
    assert.equal((await fetch(root + "/unknown")).status, 404);
    const body = JSON.stringify({ type: "url_verification", challenge: "booted" });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = "v0=" + createHmac("sha256", "test-secret").update(`v0:${ts}:${body}`).digest("hex");
    const challenge = await fetch(root + "/api/slack/events", {
      method: "POST", body, headers: {
        "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": signature
      }
    });
    assert.equal(challenge.status, 200);
    assert.match(await challenge.text(), /booted/);
    assert.equal(getSlackAgentReadiness().state, "scopes-present");
  } finally {
    await service?.stop();
    slackApi.close(); slackApi.closeAllConnections();
    if (previousBot === undefined) delete process.env.SLACK_BOT_USER_ID;
    else process.env.SLACK_BOT_USER_ID = previousBot;
    if (previousMode === undefined) delete process.env.SLACK_NATIVE_AI;
    else process.env.SLACK_NATIVE_AI = previousMode;
  }
});
