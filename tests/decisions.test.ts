import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createClient } from "redis";
import {
  __testing,
  addChannelDecision,
  formatChannelDecisionList,
  formatDecisionAdded,
  listChannelDecisions,
  parseDecisionIntent,
  type ChannelDecision
} from "../lib/decisions.js";
import {
  __testing as pollTesting,
  closeSlackPoll,
  recordPollDecision,
  type SlackPoll
} from "../lib/polls.js";

test("decision log uses one Redis key per channel", () => {
  assert.equal(__testing.getDecisionLogKey("C123"), "slack-channel-decisions:C123");
});

test("parses explicit decision commands", () => {
  assert.deepEqual(parseDecisionIntent("decision add Use Redis for cache state."), {
    action: "add",
    text: "Use Redis for cache state"
  });
  assert.deepEqual(parseDecisionIntent("we decided to ship the small controls first"), {
    action: "add",
    text: "ship the small controls first"
  });
  assert.deepEqual(parseDecisionIntent("list channel decisions"), { action: "list" });
  assert.deepEqual(parseDecisionIntent("decision help"), { action: "help" });
});

test("does not treat vague decision talk as a command", () => {
  assert.equal(parseDecisionIntent("did we decide on Redis?"), null);
});

test("decision parser keeps only valid records", () => {
  const decisions = __testing.parseDecisionLogPayload(
    JSON.stringify({
      decisions: [
        {
          id: "d1",
          channelId: "C123",
          text: "  Use Redis  ",
          createdAt: "2026-06-25T15:00:00.000Z",
          userId: "U123",
          threadUrl: "https://example.slack.com/archives/C123/p1",
          source: "slack-message"
        },
        { id: "missing-text", channelId: "C123", createdAt: "2026-06-25T15:00:00.000Z" }
      ]
    })
  );

  assert.deepEqual(decisions, [
    {
      id: "d1",
      channelId: "C123",
      text: "Use Redis",
      createdAt: "2026-06-25T15:00:00.000Z",
      userId: "U123",
      threadUrl: "https://example.slack.com/archives/C123/p1",
      source: "slack-message"
    }
  ]);
});

test("formats added and listed decisions with thread links", () => {
  const decision = {
    id: "d1",
    channelId: "C123",
    text: "Use Redis for the decision log",
    createdAt: "2026-06-25T15:00:00.000Z",
    userId: "U123",
    threadUrl: "https://example.slack.com/archives/C123/p1",
    source: "slack-message" as const
  };

  assert.match(formatDecisionAdded(decision), /Logged decision: Use Redis/);
  assert.match(formatDecisionAdded(decision), /<https:\/\/example\.slack\.com\/archives\/C123\/p1\|2026-06-25>/);

  const list = formatChannelDecisionList([decision]);
  assert.match(list, /\*Channel decisions\*/);
  assert.match(list, /1\. <https:\/\/example\.slack\.com\/archives\/C123\/p1\|2026-06-25> by <@U123>: Use Redis/);
});

const decisionKey = "slack-channel-decisions:C123";
const pollKey = "slack-channel-polls:C123";
const decisionInput = {
  channelId: "C123", text: "Direct decision", source: "slash-command" as const,
  createdAt: "2026-10-22T15:00:00.000Z", userId: "U123", threadTs: "1000.000",
  messageTs: "1000.001", threadUrl: "https://example.slack.com/archives/C123/p1"
};
const oldDecision: ChannelDecision = { ...decisionInput, id: "old", text: "Earlier decision" };
const poll: SlackPoll = {
  id: "abcdef12-3456-7890-abcd-ef1234567890", channelId: "C123", question: "Ship Friday",
  options: [{ id: "1", text: "Yes" }, { id: "2", text: "No" }], votes: {},
  status: "open", createdAt: decisionInput.createdAt, threadTs: "2000.000", messageTs: "2000.001"
};

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Model both atomic CAS contracts; POLL_TEST_REDIS_URL runs these same
// interleavings against the actual Lua, using only randomly prefixed test keys.
async function decisionStore(t: TestContext) {
  const memory = new Map<string, string>();
  const prefix = `decision-test:${randomUUID()}:`;
  const keysWritten = new Set<string>();
  const url = process.env.POLL_TEST_REDIS_URL;
  const client = url ? createClient({ url }) : undefined;
  if (client) {
    client.on("error", () => {});
    await client.connect();
  }
  const read = async (key: string) => client ? client.get(prefix + key) : memory.get(key) ?? null;
  const write = async (key: string, value: string | null) => {
    keysWritten.add(key);
    if (client) {
      if (value === null) await client.del(prefix + key);
      else await client.set(prefix + key, value);
    } else if (value === null) memory.delete(key);
    else memory.set(key, value);
  };
  let beforeCommit: (() => Promise<void>) | undefined;
  let beforeRead: (() => Promise<void>) | undefined;
  const attempts: { keys: string[]; arguments: string[] }[] = [];
  const store = {
    attempts, read, write,
    conflicts: 0,
    rejectCommits: false,
    failCommit: false,
    decisions: async () => JSON.parse((await read(decisionKey)) ?? '{"decisions":[]}').decisions as ChannelDecision[],
    holdNextCommit() {
      const reached = signal();
      const released = signal();
      beforeCommit = async () => { reached.resolve(); await released.promise; };
      t.after(() => released.resolve());
      return { reached: reached.promise, release: () => released.resolve() };
    },
    synchronizeReads(count: number) {
      const ready = signal();
      let arrived = 0;
      beforeRead = async () => {
        if (++arrived === count) { beforeRead = undefined; ready.resolve(); }
        await ready.promise;
      };
    },
    async get(key: string) {
      const payload = await read(key);
      if (key === decisionKey) await beforeRead?.();
      return payload;
    },
    async eval(script: string, options: { keys: string[]; arguments: string[] }) {
      attempts.push(options);
      const hook = beforeCommit;
      beforeCommit = undefined;
      await hook?.();
      if (store.failCommit) throw new Error("Simulated Redis write failure");
      if (store.rejectCommits) { store.conflicts++; return 0; }
      for (const key of options.keys) keysWritten.add(key);
      if (client) {
        const result = await client.eval(script, { ...options, keys: options.keys.map((key) => prefix + key) });
        if (result === 0) store.conflicts++;
        return result;
      }
      const [presence, expected, replacement, decisionPayload] = options.arguments;
      const current = memory.get(options.keys[0]) ?? null;
      if (presence === "missing" ? current !== null : current !== expected) {
        store.conflicts++;
        return 0;
      }
      // No awaits: a poll and its linked decision become visible together.
      if (decisionPayload) {
        const decision = JSON.parse(decisionPayload) as ChannelDecision;
        let previous;
        try { previous = JSON.parse(memory.get(options.keys[1]) ?? "[]"); } catch { previous = []; }
        const records = Array.isArray(previous) ? previous : previous?.decisions;
        const decisions = (Array.isArray(records) ? records : []).filter((item) => item
          && item.channelId === decision.channelId
          && typeof item.id === "string" && item.id !== ""
          && typeof item.text === "string" && /[^\s.!?]/.test(item.text)
          && typeof item.createdAt === "string" && item.createdAt !== "");
        memory.set(options.keys[1], JSON.stringify({ decisions: [...decisions, decision].slice(-50) }));
      }
      memory.set(options.keys[0], replacement);
      return 1;
    }
  };
  __testing.setRedisProvider(async () => store);
  pollTesting.setRedisProvider(async () => store);
  t.after(async () => {
    __testing.setRedisProvider();
    pollTesting.setRedisProvider();
    if (client) {
      try {
        if (keysWritten.size) await client.del([...keysWritten].map((key) => prefix + key));
      } finally {
        await client.close();
      }
    }
  });
  return store;
}

test("concurrent direct appends retain every decision and stable retry identities", async (t) => {
  const store = await decisionStore(t);
  store.synchronizeReads(12);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => addChannelDecision({
    ...decisionInput, text: `Decision ${index}`
  })));
  const saved = await store.decisions();
  assert.equal(saved.length, 12);
  assert.equal(new Set(saved.map((decision) => decision.id)).size, 12);
  assert.ok(store.conflicts > 0);
  for (const result of results) {
    assert.ok(result.ok);
    assert.deepEqual(saved.find((decision) => decision.id === result.decision.id), result.decision);
    const proposed = store.attempts.map((attempt) => JSON.parse(attempt.arguments[2]).decisions.at(-1))
      .filter((decision) => decision.text === result.decision.text);
    assert.ok(proposed.length > 0);
    assert.ok(proposed.every((decision) => JSON.stringify(decision) === JSON.stringify(result.decision)));
  }
  assert.deepEqual(await listChannelDecisions("C123"), { ok: true, decisions: saved });
});

test("concurrent direct appends at capacity retain both additions and the latest 48 prior decisions", async (t) => {
  const store = await decisionStore(t);
  const initial = Array.from({ length: 50 }, (_, index) => ({ ...oldDecision, id: `old-${index}` }));
  await store.write(decisionKey, JSON.stringify({ decisions: initial }));
  store.synchronizeReads(2);
  const results = await Promise.all(["A", "B"].map((text) => addChannelDecision({ ...decisionInput, text })));
  assert.ok(results.every((result) => result.ok));
  const saved = await store.decisions();
  assert.equal(saved.length, 50);
  assert.deepEqual(saved.slice(0, -2), initial.slice(2));
  assert.deepEqual(new Set(saved.slice(-2).map((decision) => decision.text)), new Set(["A", "B"]));
  assert.equal(store.conflicts, 1);
});

test("direct and poll appends preserve both entries and decisionId linkage at capacity", async (t) => {
  for (const close of [false, true]) {
    for (const heldWriter of ["direct", "poll"]) {
      await t.test(`${close ? "closeSlackPoll" : "recordPollDecision"}, ${heldWriter} commits last`, async (t) => {
        const store = await decisionStore(t);
        const initial = Array.from({ length: 50 }, (_, index) => ({ ...oldDecision, id: `old-${index}` }));
        await store.write(decisionKey, JSON.stringify({ decisions: initial }));
        await store.write(pollKey, JSON.stringify({ polls: [poll] }));
        const append = () => addChannelDecision(decisionInput);
        const fromPoll = () => {
          const input = { channelId: "C123", pollId: poll.id, source: "slack-message" as const,
            userId: "UPOLL", decisionText: "Poll decision" };
          return close ? closeSlackPoll({ ...input, recordDecision: true }) : recordPollDecision(input);
        };
        const held = store.holdNextCommit();
        const pending = heldWriter === "direct" ? append() : fromPoll();
        await held.reached;
        const other = await (heldWriter === "direct" ? fromPoll() : append());
        held.release();
        const delayed = await pending;
        assert.ok(other.ok && delayed.ok);
        const saved = await store.decisions();
        const [savedPoll] = JSON.parse((await store.read(pollKey))!).polls as SlackPoll[];
        assert.equal(saved.length, 50);
        assert.deepEqual(saved.slice(0, -2), initial.slice(2));
        assert.deepEqual(new Set(saved.slice(-2).map((decision) => decision.text)),
          new Set([decisionInput.text, "Poll decision"]));
        const directResult = "decision" in other ? other : delayed;
        const pollResult = "poll" in other ? other : delayed;
        assert.ok("decision" in directResult && "poll" in pollResult);
        assert.deepEqual(saved.find((decision) => decision.id === directResult.decision.id), directResult.decision);
        assert.equal(savedPoll.decisionId, pollResult.poll.decisionId);
        assert.deepEqual(saved.find((decision) => decision.id === savedPoll.decisionId), {
          id: savedPoll.decisionId, channelId: "C123", text: "Poll decision",
          createdAt: saved.find((decision) => decision.id === savedPoll.decisionId)?.createdAt,
          source: "slack-message", userId: "UPOLL", threadTs: poll.threadTs, messageTs: poll.messageTs
        });
        assert.equal(savedPoll.status, close ? "closed" : "open");
        assert.equal(store.conflicts, heldWriter === "direct" ? 1 : 0);
      });
    }
  }
});

test("appends normalize and filter legacy arrays and payloads again after a conflict", async (t) => {
  for (const legacy of [true, false]) {
    await t.test(legacy ? "array" : "payload", async (t) => {
      const store = await decisionStore(t);
      const encode = (decisions: unknown[]) => JSON.stringify(legacy ? decisions : { decisions }, null, 2);
      const records = [
        { ...oldDecision, text: " Earlier\n decision!? ", source: "unknown", userId: 123 },
        { ...oldDecision, channelId: "COTHER", id: "other-channel" },
        { ...oldDecision, id: "" }, { ...oldDecision, text: " .!? " }, null
      ];
      const normalized = { ...oldDecision, source: "slack-message" as const };
      delete normalized.userId;
      const original = encode(records);
      await store.write(decisionKey, original);
      assert.deepEqual(await listChannelDecisions("C123"), { ok: true, decisions: [normalized] });
      assert.equal(await store.read(decisionKey), original);
      const held = store.holdNextCommit();
      const pending = addChannelDecision({ ...decisionInput, text: " Direct\n decision... " });
      await held.reached;
      const concurrent = { ...oldDecision, id: "concurrent", text: "Another decision" };
      const updated = encode([...records, { ...concurrent, text: " Another\n decision!? " }]);
      await store.write(decisionKey, updated);
      held.release();
      const result = await pending;
      assert.ok(result.ok);
      assert.deepEqual(result.decision, { ...decisionInput, id: result.decision.id });
      assert.deepEqual(result.decisions, [normalized, concurrent, result.decision]);
      assert.deepEqual(await store.decisions(), result.decisions);
      assert.deepEqual(store.attempts.map((attempt) => attempt.arguments.slice(0, 2)),
        [["present", original], ["present", updated]]);
    });
  }
});

test("CAS distinguishes a missing key from an existing empty raw payload", async (t) => {
  for (const initial of [null, ""]) {
    await t.test(initial === null ? "missing becomes empty" : "empty becomes missing", async (t) => {
      const store = await decisionStore(t);
      await store.write(decisionKey, initial);
      const held = store.holdNextCommit();
      const pending = addChannelDecision(decisionInput);
      await held.reached;
      await store.write(decisionKey, initial === null ? "" : null);
      held.release();
      const result = await pending;
      assert.ok(result.ok);
      assert.deepEqual(await store.decisions(), [result.decision]);
      assert.equal(store.conflicts, 1);
      assert.deepEqual(store.attempts.map((attempt) => ({ keys: attempt.keys, expected: attempt.arguments.slice(0, 2) })), [
        { keys: [decisionKey], expected: [initial === null ? "missing" : "present", ""] },
        { keys: [decisionKey], expected: [initial === null ? "present" : "missing", ""] }
      ]);
    });
  }
});

test("invalid input, write failures and 32 rejected CAS attempts never change the log", async (t) => {
  const store = await decisionStore(t);
  const original = JSON.stringify({ decisions: [oldDecision] });
  await store.write(decisionKey, original);
  assert.deepEqual(await addChannelDecision({ ...decisionInput, text: " .!? " }),
    { ok: false, reason: "Decision cannot be empty." });
  assert.equal(store.attempts.length, 0);
  assert.equal(await store.read(decisionKey), original);
  store.failCommit = true;
  await assert.rejects(addChannelDecision(decisionInput), /Simulated Redis write failure/);
  assert.equal(await store.read(decisionKey), original);
  store.failCommit = false;
  store.rejectCommits = true;
  const attempted = store.attempts.length;
  assert.deepEqual(await addChannelDecision(decisionInput),
    { ok: false, reason: "Decisions changed too often. Please try again." });
  assert.equal(store.attempts.length - attempted, 32);
  assert.equal(await store.read(decisionKey), original);
});

test("decision reads and appends use the configured provider when Redis is unavailable", async (t) => {
  __testing.setRedisProvider(async () => null);
  t.after(() => __testing.setRedisProvider());
  const unavailable = { ok: false, reason: "Redis is not configured." };
  assert.deepEqual(await addChannelDecision(decisionInput), unavailable);
  assert.deepEqual(await listChannelDecisions("C123"), unavailable);
});
