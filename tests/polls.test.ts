import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createClient } from "redis";
import {
  __testing,
  closeSlackPoll,
  createSlackPoll,
  formatPollCreated,
  formatPollList,
  formatPollSummary,
  parsePollIntent,
  recordPollDecision,
  recordSlackPollReactionVote,
  recordSlackPollVote,
  type SlackPoll
} from "../lib/polls.js";

const basePoll: SlackPoll = {
  id: "abcdef12-3456-7890-abcd-ef1234567890",
  channelId: "C123",
  question: "Ship Friday",
  options: [
    { id: "1", text: "Yes" },
    { id: "2", text: "No" }
  ],
  votes: {
    U123: {
      userId: "U123",
      optionId: "1",
      source: "command",
      createdAt: "2026-06-25T15:00:00.000Z"
    },
    U456: {
      userId: "U456",
      optionId: "2",
      source: "reaction",
      createdAt: "2026-06-25T15:01:00.000Z"
    }
  },
  status: "open",
  createdAt: "2026-06-25T15:00:00.000Z",
  createdBy: "U123",
  threadTs: "1000.000"
};

test("poll log uses one Redis key per channel", () => {
  assert.equal(__testing.getPollLogKey("C123"), "slack-channel-polls:C123");
});

test("parses poll commands", () => {
  assert.deepEqual(parsePollIntent("create Ship Friday? | Yes | No"), {
    action: "create",
    question: "Ship Friday",
    options: ["Yes", "No"]
  });
  assert.deepEqual(parsePollIntent("poll vote abc12345 2"), {
    action: "vote",
    pollId: "abc12345",
    choice: "2"
  });
  assert.deepEqual(parsePollIntent("results"), { action: "summary" });
  assert.deepEqual(parsePollIntent("close abc12345 decision"), {
    action: "close",
    pollId: "abc12345",
    recordDecision: true
  });
});

test("poll parser keeps only valid records and votes", () => {
  const polls = __testing.parsePollLogPayload(
    JSON.stringify({
      polls: [
        basePoll,
        {
          id: "bad",
          channelId: "C123",
          question: "",
          createdAt: "2026-06-25T15:00:00.000Z",
          options: []
        }
      ]
    })
  );

  assert.deepEqual(polls, [basePoll]);
});

test("formats poll create list and summary text", () => {
  assert.match(formatPollCreated(basePoll), /\*Poll abcdef12\*: Ship Friday/);
  assert.match(formatPollCreated(basePoll), /1\. Yes/);
  assert.match(formatPollList([basePoll]), /abcdef12 open: Ship Friday \(2 votes\)/);
  assert.match(formatPollSummary(basePoll), /1\. Yes: 1/);
  assert.match(formatPollSummary(basePoll), /Tie: Yes, No \(1\/2\)/);
});

test("reaction names map to poll choices", () => {
  assert.equal(__testing.getReactionPollChoice(":one:"), "1");
  assert.equal(__testing.getReactionPollChoice("two"), "2");
  assert.equal(__testing.getReactionPollChoice("regional_indicator_c"), "c");
  assert.equal(__testing.getReactionPollChoice("summary"), null);
});

test("reaction votes only resolve polls anchored to that message", () => {
  assert.deepEqual(__testing.resolvePollForReaction([basePoll], "1000.000"), {
    ok: true,
    poll: basePoll
  });
  assert.deepEqual(__testing.resolvePollForReaction([basePoll], "9999.000"), {
    ok: false,
    reason: "No poll found for that message."
  });
});

test("poll decision text summarizes consensus", () => {
  assert.equal(__testing.formatPollDecisionText({
    ...basePoll,
    votes: {
      ...basePoll.votes,
      U789: {
        userId: "U789",
        optionId: "1",
        source: "command",
        createdAt: "2026-06-25T15:02:00.000Z"
      }
    }
  }), "Ship Friday: Yes");
});

const pollKey = "slack-channel-polls:C123";
const decisionKey = "slack-channel-decisions:C123";
const emptyPoll = { ...basePoll, votes: {} };
const closeInput = { channelId: "C123", recordDecision: false, source: "slash-command" as const };
const voteInput = { channelId: "C123", userId: "U789", choice: "1", source: "command" as const };

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// The default store models Redis' atomic CAS contract. Set POLL_TEST_REDIS_URL to
// run the same deterministic interleavings against the actual Lua on a test Redis.
async function pollStore(t: TestContext, polls: SlackPoll[] = [emptyPoll]) {
  const memory = new Map<string, string>();
  const prefix = `poll-test:${randomUUID()}:`;
  const keysWritten = new Set<string>();
  const url = process.env.POLL_TEST_REDIS_URL;
  const client = url ? createClient({ url }) : undefined;
  if (client) {
    client.on("error", () => {});
    await client.connect();
  }
  const read = async (key: string) => client ? client.get(prefix + key) : memory.get(key) ?? null;
  const write = async (key: string, value: string) => {
    keysWritten.add(key);
    if (client) await client.set(prefix + key, value);
    else memory.set(key, value);
  };
  let beforeCommit: (() => Promise<void>) | undefined;
  let beforeRead: (() => Promise<void>) | undefined;
  const store = {
    conflicts: 0,
    commits: 0,
    rejectCommits: false,
    failCommit: false,
    read,
    write,
    polls: async () => __testing.parsePollLogPayload((await read(pollKey)) ?? "null"),
    decisions: async () => JSON.parse((await read(decisionKey)) ?? '{"decisions":[]}').decisions as { id: string; text: string }[],
    holdNextCommit() {
      const reached = signal();
      const released = signal();
      beforeCommit = async () => {
        reached.resolve();
        await released.promise;
      };
      return { reached: reached.promise, release: () => released.resolve() };
    },
    synchronizeReads(count: number) {
      const ready = signal();
      let arrived = 0;
      beforeRead = async () => {
        if (++arrived === count) {
          beforeRead = undefined;
          ready.resolve();
        }
        await ready.promise;
      };
    },
    async get(key: string) {
      const payload = await read(key);
      if (key === pollKey) await beforeRead?.();
      return payload;
    },
    async eval(script: string, options: { keys: string[]; arguments: string[] }) {
      store.commits++;
      const hook = beforeCommit;
      beforeCommit = undefined;
      await hook?.();
      if (store.failCommit) throw new Error("Simulated Redis write failure");
      if (store.rejectCommits) {
        store.conflicts++;
        return 0;
      }
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
      // No awaits in the commit: all state changes are visible together.
      if (decisionPayload) {
        const decision = JSON.parse(decisionPayload);
        const previous = JSON.parse(memory.get(options.keys[1]) ?? "[]");
        const decisions = (Array.isArray(previous) ? previous : previous.decisions ?? [])
          .filter((item: { channelId: string }) => item.channelId === decision.channelId);
        memory.set(options.keys[1], JSON.stringify({ decisions: [...decisions, decision].slice(-50) }));
      }
      memory.set(options.keys[0], replacement);
      return 1;
    }
  };
  __testing.setRedisProvider(async () => store);
  t.after(async () => {
    __testing.setRedisProvider();
    if (client) {
      try {
        if (keysWritten.size) await client.del([...keysWritten].map((key) => prefix + key));
      } finally {
        await client.close();
      }
    }
  });
  if (polls.length) await write(pollKey, JSON.stringify({ polls }));
  return store;
}

test("concurrent creates preserve every poll and enforce the existing retention limit", async (t) => {
  const store = await pollStore(t, []);
  store.synchronizeReads(12);
  const created = await Promise.all(Array.from({ length: 12 }, (_, index) => createSlackPoll({
    channelId: "C123", question: `Question ${index}`, options: ["Yes", "No"], userId: "U123"
  })));
  assert.ok(created.every((result) => result.ok));
  assert.equal(new Set((await store.polls()).map((poll) => poll.id)).size, 12);
  assert.ok(store.conflicts > 0);

  const initial = Array.from({ length: 49 }, (_, index) => ({ ...emptyPoll, id: `old-${index}` }));
  await store.write(pollKey, JSON.stringify({ polls: initial }));
  store.synchronizeReads(2);
  const appended = await Promise.all(["A", "B"].map((question) => createSlackPoll({
    channelId: "C123", question, options: ["Yes", "No"]
  })));
  assert.ok(appended.every((result) => result.ok));
  const saved = await store.polls();
  assert.equal(saved.length, 50);
  assert.equal(saved[0].id, "old-1");
  assert.deepEqual(new Set(saved.slice(-2).map((poll) => poll.question)), new Set(["A", "B"]));
});

test("concurrent command and reaction votes preserve all voters across polls", async (t) => {
  const otherPoll = { ...emptyPoll, id: "12345678-other", threadTs: "2000.000" };
  const store = await pollStore(t, [emptyPoll, otherPoll]);
  store.synchronizeReads(12);
  const votes = await Promise.all(Array.from({ length: 12 }, (_, index) => index % 2
    ? recordSlackPollReactionVote({ channelId: "C123", userId: `V${index}`, reaction: "two", threadTs: "1000.000" })
    : recordSlackPollVote({ ...voteInput, userId: `V${index}`, pollId: otherPoll.id })));
  assert.ok(votes.every((result) => result.ok));
  const [first, second] = await store.polls();
  assert.equal(Object.keys(first.votes).length, 6);
  assert.equal(Object.keys(second.votes).length, 6);
  assert.ok(Object.values(first.votes).every((vote) => vote.source === "reaction" && vote.optionId === "2"));
  assert.ok(Object.values(second.votes).every((vote) => vote.source === "command" && vote.optionId === "1"));
  assert.ok(store.conflicts > 0);
});

test("concurrent votes from one user still count once", async (t) => {
  const store = await pollStore(t);
  store.synchronizeReads(2);
  const results = await Promise.all(["1", "2"].map((choice) => recordSlackPollVote({ ...voteInput, choice })));
  assert.ok(results.every((result) => result.ok));
  assert.equal(Object.keys((await store.polls())[0].votes).length, 1);
});

test("a vote racing with creation stays on its originally resolved poll", async (t) => {
  const store = await pollStore(t);
  const held = store.holdNextCommit();
  const vote = recordSlackPollVote(voteInput);
  await held.reached;
  const created = await createSlackPoll({ channelId: "C123", question: "New question", options: ["Yes", "No"] });
  held.release();
  assert.equal(created.ok, true);
  assert.equal((await vote).ok, true);
  const [original, latest] = await store.polls();
  assert.equal(original.votes.U789.optionId, "1");
  assert.deepEqual(latest.votes, {});
  assert.equal(store.conflicts, 1);
});

test("a vote that loses to close cannot reopen or fall back to another open poll", async (t) => {
  for (const reaction of [false, true]) {
    await t.test(reaction ? "reaction" : "command", async (t) => {
      const earlier = { ...emptyPoll, id: "12345678-earlier", threadTs: "2000.000" };
      const store = await pollStore(t, [earlier, emptyPoll]);
      const held = store.holdNextCommit();
      const vote = reaction
        ? recordSlackPollReactionVote({ channelId: "C123", userId: "U789", reaction: "one", threadTs: "1000.000" })
        : recordSlackPollVote(voteInput);
      await held.reached;
      assert.equal((await closeSlackPoll(closeInput)).ok, true);
      held.release();
      assert.deepEqual(await vote, { ok: false, reason: "Poll is closed." });
      const saved = await store.polls();
      assert.equal(saved[0].status, "open");
      assert.equal(saved[1].status, "closed");
      assert.ok(saved.every((poll) => Object.keys(poll.votes).length === 0));
    });
  }
});

test("close retries against the latest votes before recording consensus", async (t) => {
  const store = await pollStore(t);
  const held = store.holdNextCommit();
  const closing = closeSlackPoll({ ...closeInput, recordDecision: true });
  await held.reached;
  assert.equal((await recordSlackPollVote(voteInput)).ok, true);
  held.release();
  const closed = await closing;
  assert.equal(closed.ok, true);
  assert.ok(closed.ok && closed.poll.status === "closed" && closed.poll.votes.U789);
  assert.ok(closed.ok && closed.decisionText === "Ship Friday: Yes");
  assert.deepEqual((await store.decisions()).map((decision) => decision.text), ["Ship Friday: Yes"]);
});

test("concurrent closes only close the original latest poll and create one decision", async (t) => {
  const earlier = { ...emptyPoll, id: "12345678-earlier", threadTs: "2000.000" };
  const store = await pollStore(t, [earlier, emptyPoll]);
  store.synchronizeReads(2);
  const results = await Promise.all(["First decision", "Second decision"].map((decisionText) => closeSlackPoll({
    ...closeInput, recordDecision: true, decisionText
  })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal((await store.decisions()).length, 1);
  const [first, second] = await store.polls();
  assert.equal(first.status, "open");
  assert.equal(second.status, "closed");
  assert.equal(second.decisionId, (await store.decisions())[0].id);
});

test("decision retries cannot duplicate, overwrite votes, or claim unrecorded text", async (t) => {
  const store = await pollStore(t);
  store.synchronizeReads(2);
  const results = await Promise.all(["First choice", "Second choice"].map((decisionText) => recordPollDecision({
    channelId: "C123", source: "slash-command", decisionText
  })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  const winner = results.find((result) => result.ok);
  assert.ok(winner?.ok);
  assert.deepEqual((await store.decisions()).map((decision) => decision.text), [winner.decisionText]);
  assert.equal((await recordPollDecision({ channelId: "C123", source: "slash-command" })).ok, false);
  const closed = await closeSlackPoll({ ...closeInput, recordDecision: true, decisionText: "Different decision" });
  assert.ok(closed.ok);
  assert.equal(closed.decisionText, undefined);
  assert.equal(closed.poll.decisionId, winner.poll.decisionId);
  assert.equal((await store.decisions()).length, 1);
});

test("decision recording racing with a vote preserves both changes", async (t) => {
  const store = await pollStore(t);
  const held = store.holdNextCommit();
  const deciding = recordPollDecision({ channelId: "C123", source: "slash-command" });
  await held.reached;
  assert.equal((await recordSlackPollVote(voteInput)).ok, true);
  held.release();
  const decided = await deciding;
  assert.ok(decided.ok);
  assert.equal(decided.decisionText, "Ship Friday: Yes");
  assert.equal((await store.polls())[0].votes.U789.optionId, "1");
  assert.equal((await store.decisions()).length, 1);
});

test("close and decide racing create at most one linked decision", async (t) => {
  const store = await pollStore(t);
  store.synchronizeReads(2);
  const results = await Promise.all([
    recordPollDecision({ channelId: "C123", source: "slack-message", decisionText: "Decided first" }),
    closeSlackPoll({ ...closeInput, recordDecision: true, decisionText: "Closed first" })
  ]);
  assert.ok(results.some((result) => result.ok));
  const [saved] = await store.polls();
  assert.equal(saved.status, "closed");
  assert.equal(saved.decisionId, (await store.decisions())[0].id);
  assert.equal((await store.decisions()).length, 1);
});

test("legacy payloads, metadata, decision retention and channel boundaries survive mutation", async (t) => {
  const store = await pollStore(t);
  const linked = { ...emptyPoll, messageTs: "1000.001" };
  await store.write(pollKey, JSON.stringify([linked, { ...emptyPoll, channelId: "COTHER", id: "other-channel" }]));
  await store.write(decisionKey, JSON.stringify(Array.from({ length: 50 }, (_, index) => ({
    id: `old-${index}`, channelId: "C123", text: `Decision ${index}`, createdAt: basePoll.createdAt, source: "slack-message"
  }))));
  const closed = await closeSlackPoll({ ...closeInput, recordDecision: true, userId: "U456" });
  assert.ok(closed.ok);
  const [saved] = await store.polls();
  assert.equal((await store.polls()).length, 1);
  assert.equal(saved.threadTs, linked.threadTs);
  assert.equal(saved.messageTs, linked.messageTs);
  assert.equal(saved.createdBy, linked.createdBy);
  assert.equal(saved.closedBy, "U456");
  const decisions = await store.decisions();
  assert.equal(decisions.length, 50);
  assert.equal(decisions[0].id, "old-1");
  assert.equal(decisions.at(-1)?.id, saved.decisionId);
  assert.deepEqual(JSON.parse((await store.read(pollKey)) ?? "null").polls, [saved]);
});

test("unrelated reaction targets and unknown options never mutate state", async (t) => {
  const store = await pollStore(t);
  assert.equal((await recordSlackPollReactionVote({ channelId: "C123", threadTs: "other", userId: "U789", reaction: "one" })).ok, false);
  assert.equal((await recordSlackPollVote({ ...voteInput, choice: "missing" })).ok, false);
  assert.equal((await recordSlackPollVote({ ...voteInput, channelId: "COTHER", pollId: basePoll.id })).ok, false);
  assert.equal(store.commits, 0);
  assert.deepEqual(await store.polls(), [emptyPoll]);
});

test("failed commits and exhausted contention leave the poll and decision log unchanged", async (t) => {
  const store = await pollStore(t);
  store.failCommit = true;
  await assert.rejects(closeSlackPoll({ ...closeInput, recordDecision: true }), /Simulated Redis write failure/);
  assert.deepEqual(await store.polls(), [emptyPoll]);
  assert.deepEqual(await store.decisions(), []);
  store.failCommit = false;
  store.rejectCommits = true;
  const result = await closeSlackPoll({ ...closeInput, recordDecision: true });
  assert.ok(!result.ok && /try again/i.test(result.reason));
  assert.ok(store.commits > 1 && store.commits < 100);
  assert.deepEqual(await store.polls(), [emptyPoll]);
  assert.deepEqual(await store.decisions(), []);
});

test("separate polls can record decisions concurrently without dropping either log entry", async (t) => {
  const otherPoll = { ...emptyPoll, id: "12345678-other", question: "Another question" };
  const store = await pollStore(t, [emptyPoll, otherPoll]);
  store.synchronizeReads(2);
  const results = await Promise.all([emptyPoll.id, otherPoll.id].map((pollId) => recordPollDecision({
    channelId: "C123", pollId, source: "slash-command"
  })));
  assert.ok(results.every((result) => result.ok));
  const saved = await store.polls();
  const decisions = await store.decisions();
  assert.equal(decisions.length, 2);
  assert.deepEqual(new Set(saved.map((poll) => poll.decisionId)), new Set(decisions.map((decision) => decision.id)));
});

test("Lua errors before commit cannot leave a closed poll without its decision", {
  skip: !process.env.POLL_TEST_REDIS_URL
}, async (t) => {
  const channelId = `poll-error-test:${randomUUID()}`;
  const client = createClient({ url: process.env.POLL_TEST_REDIS_URL });
  client.on("error", () => {});
  await client.connect();
  const pollLogKey = `slack-channel-polls:${channelId}`;
  const decisionLogKey = `slack-channel-decisions:${channelId}`;
  __testing.setRedisProvider(async () => client);
  t.after(async () => {
    __testing.setRedisProvider();
    try {
      await client.del([pollLogKey, decisionLogKey]);
    } finally {
      await client.close();
    }
  });
  const previous = JSON.stringify({ polls: [{ ...emptyPoll, channelId }] });
  await client.set(pollLogKey, previous);
  await client.lPush(decisionLogKey, "wrong-type");
  await assert.rejects(closeSlackPoll({ ...closeInput, channelId, recordDecision: true }), /WRONGTYPE/);
  assert.equal(await client.get(pollLogKey), previous);
  assert.deepEqual(await client.lRange(decisionLogKey, 0, -1), ["wrong-type"]);
});

test("a decision retry preserves a concurrently committed close", async (t) => {
  const store = await pollStore(t);
  const held = store.holdNextCommit();
  const deciding = recordPollDecision({ channelId: "C123", source: "slash-command" });
  await held.reached;
  const closed = await closeSlackPoll({ ...closeInput, userId: "U456", closedAt: "2026-10-22T09:00:00.000Z" });
  assert.ok(closed.ok);
  held.release();
  const decided = await deciding;
  assert.ok(decided.ok);
  const [saved] = await store.polls();
  assert.equal(saved.status, "closed");
  assert.equal(saved.closedBy, "U456");
  assert.equal(saved.closedAt, closed.poll.closedAt);
  assert.equal(saved.decisionId, (await store.decisions())[0].id);
});
