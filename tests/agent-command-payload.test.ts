import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import feature from "../lib/agent-features/data-cleanroom.js";
import { handleAgentCommand } from "../lib/agent-features/index.js";
import { handleSlackSlashCommandPayload } from "../lib/slack-commands.js";
import { createSlackBolt } from "../src/slack-bolt.js";
import { createAgentFeatureFixture, createMemoryAgentBackend, deferred } from "./helpers/agent-feature-fixture.js";

const cases = [
  { source: "name\n  tail  ", cells: [["  tail  "]] },
  { source: "name\nx\n\n", cells: [["x"], [""]] },
  { source: 'name\r\n"界😀\r\n\tquoted"\r\n\t tail\t \r\n\r\n', cells: [["界😀\r\n\tquoted"], ["\t tail\t "], [""]] },
];
// Independent token-regex CSV oracle: a terminating newline ends a record;
// another newline is an empty single-column record. Canonical export quotes "".
function csvOracle(source: string) {
  const rows: string[][] = [], token = /(?:"((?:[^"]|"")*)"|([^",\r\n]*))(,|\r\n|\n|$)/gy;
  let row: string[] = [];
  while (token.lastIndex < source.length) {
    const match = token.exec(source); assert.ok(match);
    row.push(match[1] === undefined ? match[2] : match[1].replace(/""/g, '"'));
    if (match[3] !== ",") { rows.push(row); row = []; }
    if (!match[3]) break;
  }
  return rows;
}
const uid = (reply: string, role: string) => { const id = reply.match(new RegExp(`${role}-[a-f0-9-]{36}`))?.[0]; assert.ok(id, reply); return id; };
for (const boundary of ["runtime", "dispatcher", "slash"] as const) {
  for (const [i, sample] of cases.entries()) test(`${boundary}: lossless CSV create/replace/trim/undo/export ${i + 1}`, async () => {
    const f = createAgentFeatureFixture(feature);
    const options = { backend: f.backend, services: f.services, timezone: "UTC" };
    let request = 0;
    const run = async (command: string) => {
      if (boundary === "runtime") return f.run(` \t${command}`);
      if (boundary === "dispatcher") return handleAgentCommand(` \tDATA-CLEANROOM \t${command}`, f.owner, options);
      const reply = await handleSlackSlashCommandPayload({ command: "/nobo-help", text: ` \tAgEnT \tDATA-CLEANROOM \t${command}`, team_id: f.owner.teamId, user_id: f.owner.userId, channel_id: f.owner.channelId!, trigger_id: `csv-${++request}` }, {
        evaluateAccess: async () => ({ allowed: true }), handleAgentCommand: (text, owner) => handleAgentCommand(text, owner, options),
      });
      assert.equal(reply.response.response_type, "ephemeral"); assert.equal(reply.response.mrkdwn, false); assert.equal(reply.task, undefined);
      return reply.response.text;
    };
    const read = async () => (JSON.parse(await run(`export ${id}`))).record;
    const id = uid(await run(`create Exact | ${sample.source}`), "table");
    for (const replace of [false, true]) {
      if (replace) assert.match(await run(`replace ${id} confirm | ${sample.source}`), /Saved privately/);
      const original = await read();
      assert.deepEqual(original.original.rows.map((row: any) => row.cells), sample.cells);
      assert.deepEqual(original.current, original.original);
      const exported = await run(`export-csv ${id}`), header = /^.*\nPage 1\/1\n/.exec(exported); assert.ok(header, exported);
      assert.deepEqual(csvOracle(exported.slice(header[0].length)), [["name"], ...sample.cells]);
      const preview = uid(await run(`preview ${id} | trim | all`), "preview");
      assert.match(await run(`apply ${id} ${preview}`), /Saved privately/);
      const applied = await read(); assert.deepEqual(applied.original, original.original); assert.deepEqual(applied.undo, original.current);
      assert.deepEqual(applied.current.rows.map((row: any) => row.cells), sample.cells.map(row => row.map(cell => cell.trim())));
      assert.match(await run(`undo ${id} confirm`), /Saved privately/);
      assert.deepEqual((await read()).current, original.current);
    }
    assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
  });
}

test("routing preserves cheap blank/help, unknown commands and rejects actual oversized CSV command bytes", async () => {
  const f = createAgentFeatureFixture(feature), options = { backend: f.backend, services: f.services, timezone: "UTC" };
  for (const command of ["data-cleanroom", " data-cleanroom \t\r\n", "data-cleanroom  HeLp \n"]) assert.equal(await handleAgentCommand(command, f.owner, options), feature.help);
  assert.match(await handleAgentCommand("  \n", f.owner, options), /Personal agents/);
  assert.match(await handleAgentCommand(" unknown \t", f.owner, options), /Unknown personal agent/);
  assert.equal(f.backend.calls.gets, 0); assert.equal(f.backend.calls.compareSets, 0);
  for (const command of [`create Bound | name\nx${" ".repeat(16_000)}`, `${" ".repeat(16_000)}create Bound | name\nx`]) {
    assert.match(await handleAgentCommand(`data-cleanroom ${command}`, f.owner, options), /Command.*too long|Command.*16000/i);
    assert.equal(f.backend.data.size, 0);
  }
});

test("runtime request fingerprint hashes the exact supplied command, including boundary whitespace", async () => {
  const command = " \tcreate Hash | name\n  tail  \n\n";
  let hash: string | undefined;
  const backend = createMemoryAgentBackend({ beforeCompareSet(key, _previous, next) {
    if (key.includes("agent-requests") && JSON.parse(next).state === "started") hash = JSON.parse(next).commandHash;
  } });
  const f = createAgentFeatureFixture(feature, { backend });
  assert.match(await f.run(command, { requestId: "raw-receipt" }), /Saved privately/);
  assert.equal(hash, createHash("sha256").update(command).digest("hex"));
  const before = [...backend.data]; assert.match(await f.run(command, { requestId: "raw-receipt" }), /already received/); assert.deepEqual([...backend.data], before);
});

// Same signed local Bolt fixture pattern as tests/slack-bolt.test.ts. All traffic
// is loopback; fake authorization and feature services prohibit external calls.
for (const [i, sample] of cases.entries()) test(`signed local Slack -> actual dispatcher -> runtime retains CSV ${i + 1}`, { timeout: 10_000 }, async () => {
  const f = createAgentFeatureFixture(feature), delivered = deferred<string>();
  const replyServer = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    response.end("ok"); delivered.resolve(raw);
  }).listen(0, "127.0.0.1");
  await once(replyServer, "listening");
  const secret = "test-csv-signing-secret";
  const { bolt, receiver } = createSlackBolt({ signingSecret: secret, bodyLimit: 4096,
    authorize: async () => ({ botToken: "xoxb-test", botId: "BTEST", botUserId: "UTEST" }),
    handlers: {
      command: payload => handleSlackSlashCommandPayload(payload, {
        evaluateAccess: async () => ({ allowed: true }),
        handleAgentCommand: (text, owner) => handleAgentCommand(text, owner, { backend: f.backend, services: f.services, timezone: "UTC" }),
      }),
      memory: async () => assert.fail("No channel memory write"), task: async () => assert.fail("No public task"),
    },
  });
  await bolt.init();
  const server = createServer(receiver.requestListener).listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const body = new URLSearchParams({ command: "/nobo-help", text: ` \tAgEnT data-cleanroom create Signed | ${sample.source}`, team_id: f.owner.teamId, user_id: f.owner.userId, channel_id: f.owner.channelId!, trigger_id: `signed-csv-${i}`, response_url: `http://127.0.0.1:${(replyServer.address() as { port: number }).port}/reply` }).toString();
    const timestamp = String(Math.floor(Date.now() / 1000)), signature = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/slack/commands`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } });
    assert.equal(response.status, 200);
    const reply = JSON.parse(await delivered.promise); assert.equal(reply.response_type, "ephemeral"); assert.equal(reply.mrkdwn, false); assert.match(reply.text, /Saved privately/);
    const record = (await f.store().read<any>("state"))!.records[0];
    assert.deepEqual(record.original.rows.map((row: any) => row.cells), sample.cells);
    assert.deepEqual(record.current, record.original); assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
  } finally {
    await Promise.all([server, replyServer].map(s => new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); })));
  }
});
