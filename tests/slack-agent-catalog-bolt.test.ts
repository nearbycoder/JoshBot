import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { WebClient } from "@slack/web-api";
import { __testing as access } from "../lib/access-controls.js";
import { agentFeatures } from "../lib/agent-features/registry.js";
import { clearRecentOpsErrorsForTesting, getRecentOpsErrors } from "../lib/ops-errors.js";
import { buildSlackAgentCatalogView } from "../src/slack-agent-catalog.js";
import { createSlackBolt } from "../src/slack-bolt.js";

const secret = "offline-catalog-signing-fixture";
const identity = { team: { id: "TCATALOG" }, user: { id: "UCATALOG" } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Real createSlackBolt registrations, verification and dispatch; only policy storage
// and outbound transports are fake. Streams never start a server or open a socket.
async function fixture(t: TestContext, policyGate?: ReturnType<typeof gate>) {
  const savedEnvironment = { ...process.env };
  for (const name of Object.keys(process.env)) if (/^NOBO_(?:ADMIN|ALLOW|DENY|ALLOWED|DENIED)_/.test(name) || name === "REDIS_URL") delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(savedEnvironment)) if (/^NOBO_(?:ADMIN|ALLOW|DENY|ALLOWED|DENIED)_/.test(name) || name === "REDIS_URL") process.env[name] = value;
    access.setRedisClient(undefined);
    clearRecentOpsErrorsForTesting();
  });
  const policyKeys: string[] = [], transports: Array<{ method: string; args: any }> = [], responses: unknown[] = [];
  let policy: "allow" | "deny" | "error" = "allow", updateError: string | undefined, featureCalls = 0, policyWrites = 0;
  const noWrite = async () => { policyWrites++; assert.fail("catalog wrote policy or audit state"); };
  access.setRedisClient({
    sMembers: async key => {
      policyKeys.push(key);
      // Defer only the first lookup: an overlapping fallback would still race ahead.
      if (policyKeys.length <= 5) await policyGate?.promise;
      if (policy === "error") throw new Error("PRIVATE policy failure");
      return policy === "deny" && key === "nobo:access:deny:users" ? [identity.user.id] : [];
    },
    sAdd: noWrite, sRem: noWrite, lPush: noWrite, lTrim: noWrite, lRange: noWrite,
  });
  for (const feature of agentFeatures) t.mock.method(feature, "execute", async () => { featureCalls++; assert.fail("catalog executed an agent"); });
  t.mock.method(WebClient.prototype, "apiCall", async (method: string, args: any) => {
    transports.push({ method, args });
    assert.ok(["views.open", "views.update"].includes(method), `Unexpected outbound method: ${method}`);
    if (method === "views.update" && updateError) throw { data: { error: updateError }, body: "PRIVATE Slack body" };
    return { ok: true, view: { ...args.view, id: "VCATALOG", hash: "next-hash" } };
  });
  const { bolt, receiver } = createSlackBolt({
    signingSecret: secret,
    authorize: async () => ({ botToken: "xoxb-local-fixture", botId: "BCATALOG", botUserId: "UBOT" }),
  });
  // Bolt's private fetch slot is replaced only to observe response_url sends locally.
  (bolt as unknown as { fetchFn: typeof fetch }).fetchFn = async (_url, init) => {
    responses.push(JSON.parse(String(init?.body))); return new Response("ok");
  };
  await bolt.init();
  clearRecentOpsErrorsForTesting();
  let completion = gate(), acknowledgementCount = 0;
  const originalProcess = bolt.processEvent.bind(bolt);
  t.mock.method(bolt, "processEvent", async (event: Parameters<typeof bolt.processEvent>[0]) => {
    const actualAck = event.ack;
    event.ack = async value => { acknowledgementCount++; return actualAck(value); };
    try { await originalProcess(event); } finally { completion.resolve(); }
  });
  function send(body: object, invalidSignature = false) {
    completion = gate(); acknowledgementCount = 0;
    const completed = completion.promise;
    const raw = new URLSearchParams({ payload: JSON.stringify(body) }).toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex");
    const request = Object.assign(Readable.from([Buffer.from(raw)]), {
      url: "/api/slack/interactions", method: "POST", headers: {
        "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(raw)),
        "x-slack-request-timestamp": timestamp, "x-slack-signature": invalidSignature ? "v0=invalid" : signature,
      },
    });
    let resolve!: (reply: { status: number; body: string }) => void, ends = 0;
    const replied = new Promise<{ status: number; body: string }>(done => { resolve = done; });
    const response = {
      statusCode: 200, headersSent: false, writableEnded: false,
      writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; },
      end(body?: string) { ends++; this.writableEnded = true; resolve({ status: this.statusCode, body: body ?? "" }); },
    };
    receiver.requestListener(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    return { replied, completed, get ends() { return ends; } };
  }
  t.after(() => { assert.equal(featureCalls, 0); assert.equal(policyWrites, 0); });
  return { send, transports, responses, policyKeys,
    get acks() { return acknowledgementCount; },
    set policy(value: typeof policy) { policy = value; },
    set updateError(value: string | undefined) { updateError = value; },
  };
}

function currentView(query = "private") {
  const view = { ...buildSlackAgentCatalogView({ page: 1, ...(query ? { query } : {}) }),
    id: "VCATALOG", team_id: identity.team.id, app_id: "ACATALOG", hash: "provided-hash",
    root_view_id: "VCATALOG", previous_view_id: null,
    state: { values: {} as Record<string, Record<string, { type: string; value: string | null }>> },
  };
  const input = view.blocks.find(block => block.type === "input")!;
  view.state.values[input.block_id!] = { query: { type: "plain_text_input", value: query || null } };
  return view;
}
function actionPayload(action = { type: "button", action_id: "nobo_agent_catalog_page", value: "2" }, view = currentView()) {
  return { type: "block_actions", ...identity, api_app_id: "ACATALOG", trigger_id: "fresh-fixture-trigger",
    container: { type: "view", view_id: view.id }, view, state: view.state,
    actions: [{ ...action, block_id: "fixture-nav", action_ts: "1.1" }],
  };
}
const submission = (view = currentView("meeting")) => ({ type: "view_submission", ...identity, api_app_id: "ACATALOG", trigger_id: "fixture-trigger", view });
async function finish(h: Awaited<ReturnType<typeof fixture>>, request: ReturnType<typeof h.send>) {
  const reply = await request.replied; await request.completed;
  assert.equal(reply.status, 200); assert.equal(request.ends, 1); assert.equal(h.acks, 1);
  assert.equal(h.responses.length, 0, "catalog must never send response_url messages");
  return reply;
}

test("complete signed Bolt catalog action acknowledges once before policy, then updates the supplied hash", async t => {
  const policy = gate(), h = await fixture(t, policy);
  try {
    const request = h.send(actionPayload());
    assert.equal((await request.replied).status, 200);
    await tick(); assert.equal(h.acks, 1); assert.equal(h.transports.length, 0); assert.equal(h.policyKeys.length, 5);
    policy.resolve(); await finish(h, request);
    assert.equal(h.transports.length, 1);
    const { method, args } = h.transports[0];
    assert.equal(method, "views.update"); assert.equal(args.view_id, "VCATALOG"); assert.equal(args.hash, "provided-hash");
    assert.deepEqual(JSON.parse(args.view.private_metadata), { page: 2, query: "private" });
    assert.deepEqual(getRecentOpsErrors(), []);
  } finally { policy.resolve(); }
});

for (const outcome of ["allow", "deny", "error"] as const) test(`complete signed Search waits for ${outcome} policy and acknowledges once with a modal update`, async t => {
  const policy = gate(), h = await fixture(t, policy); h.policy = outcome;
  try {
    const request = h.send(submission());
    let early: unknown; void request.replied.then(reply => { early = reply; });
    for (let i = 0; i < 12; i++) await tick();
    const before = { reply: early, acks: h.acks, reads: h.policyKeys.length };
    policy.resolve(); const reply = await finish(h, request);
    assert.deepEqual(before, { reply: undefined, acks: 0, reads: 5 });
    const body = JSON.parse(reply.body);
    assert.equal(body.response_action, "update"); assert.equal(body.view.type, "modal");
    if (outcome === "allow") assert.deepEqual(JSON.parse(body.view.private_metadata), { page: 1, query: "meeting" });
    else { assert.match(reply.body, /unavailable/); assert.equal(body.view.submit, undefined); }
    assert.equal(h.transports.length, 0);
    assert.doesNotMatch(JSON.stringify(getRecentOpsErrors()), /PRIVATE/);
    if (outcome !== "error") assert.deepEqual(getRecentOpsErrors(), []);
    else assert.ok(getRecentOpsErrors().every(error => error.source === "personal agent catalog"));
  } finally { policy.resolve(); }
});

for (const outcome of ["deny", "error"] as const) test(`signed catalog entry and actions under ${outcome} policy never open or send`, async t => {
  const h = await fixture(t); h.policy = outcome;
  const entry = { ...actionPayload(), view: undefined,
    actions: [{ type: "static_select", action_id: "nobo_home_tools", selected_option: { value: "agents" } }],
  };
  await finish(h, h.send(entry)); assert.equal(h.transports.length, 0);
  const body = actionPayload();
  body.view.private_metadata = JSON.stringify({ page: 1, userId: "UOTHER", teamId: "TOTHER" });
  await finish(h, h.send(body));
  assert.equal(h.policyKeys.length, 10, "each signed interaction reevaluates policy");
  assert.equal(h.transports.length, 1); assert.equal(h.transports[0].method, "views.update");
  assert.equal(h.transports[0].args.hash, "provided-hash");
  assert.match(JSON.stringify(h.transports[0].args.view), /unavailable/);
  assert.doesNotMatch(JSON.stringify(getRecentOpsErrors()), /PRIVATE/);
  if (outcome === "deny") assert.deepEqual(getRecentOpsErrors(), []);
});

test("full signed wiring reevaluates revoked access after opening once", async t => {
  const h = await fixture(t);
  await finish(h, h.send({ ...actionPayload(), view: undefined,
    actions: [{ type: "static_select", action_id: "nobo_home_tools", selected_option: { value: "agents" } }],
  }));
  assert.deepEqual(h.transports.map(call => call.method), ["views.open"]);
  h.policy = "deny";
  await finish(h, h.send(actionPayload()));
  assert.match(JSON.stringify(h.transports[1].args.view), /unavailable/);
  const reply = await finish(h, h.send(submission())); assert.match(reply.body, /unavailable/);
  assert.deepEqual(h.transports.map(call => call.method), ["views.open", "views.update"]);
  assert.equal(h.policyKeys.length, 15); assert.deepEqual(getRecentOpsErrors(), []);
});

test("HTTPReceiver rejects invalid signatures before policy or any catalog handler", async t => {
  const h = await fixture(t);
  for (const body of [actionPayload(), submission()]) {
    const request = h.send(body, true);
    assert.equal((await request.replied).status, 401); assert.equal(request.ends, 1); assert.equal(h.acks, 0);
  }
  assert.equal(h.policyKeys.length, 0); assert.deepEqual(h.transports, []); assert.deepEqual(h.responses, []);
  assert.deepEqual(getRecentOpsErrors(), []);
});

test("signed catalog actions with missing hashes or stale/closed views ack once without fallback", async t => {
  const h = await fixture(t);
  const missing = actionPayload(); delete (missing.view as { hash?: string }).hash;
  await finish(h, h.send(missing)); assert.equal(h.transports.length, 0);
  for (const error of ["hash_conflict", "view_not_found"]) {
    h.updateError = error; await finish(h, h.send(actionPayload()));
  }
  assert.deepEqual(h.transports.map(call => call.method), ["views.update", "views.update"]);
  assert.ok(h.transports.every(call => call.args.hash === "provided-hash"));
  assert.deepEqual(getRecentOpsErrors(), []);
});

test("generic signed submission and view_closed still use their existing single acknowledgements", async t => {
  const h = await fixture(t);
  const generic = submission(); generic.view.callback_id = "unrelated_callback";
  assert.equal((await finish(h, h.send(generic))).body, "");
  assert.equal(h.policyKeys.length, 5, "generic submission still routes through its default policy handler");
  assert.equal((await finish(h, h.send({ ...submission(), type: "view_closed" }))).body, "");
  assert.equal(h.policyKeys.length, 5); assert.deepEqual(h.transports, []); assert.deepEqual(getRecentOpsErrors(), []);
});
