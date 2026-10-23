import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getRedisClient } from "../lib/redis.js";
import { AgentContextCapacityError } from "../lib/agent-features/budgets.js";
import { createAgentStateBackend } from "../lib/agent-features/store.js";
import { AGENT_BUSY_MESSAGE, withAgentAdmission } from "../lib/agent-features/admission.js";
import { contextRead } from "../lib/agent-features/context/shared.js";

test("default Redis bounded batches preserve bytes, slots, errors and physical settlement", {
  skip: !process.env.POLL_TEST_REDIS_URL,
  timeout: 15_000,
}, async t => {
  const url = process.env.POLL_TEST_REDIS_URL!;
  assert.ok(["127.0.0.1", "[::1]"].includes(new URL(url).hostname), "Use isolated loopback Redis");
  const previous = process.env.REDIS_URL;
  process.env.REDIS_URL = url;
  const redis = await getRedisClient(); assert.ok(redis);
  const prefix = `agent-batch-test:${randomUUID()}:`, written: string[] = [];
  const key = (id: string) => { const value = prefix + id; written.push(value); return value; };
  t.after(async () => {
    try { if (written.length) await redis.del(written); }
    finally {
      await redis.close();
      if (previous === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previous;
    }
  });
  const backend = await createAgentStateBackend(); assert.ok(backend?.getMany);
  const read = backend.getMany.bind(backend);
  const exact = key("exact"), utf8 = key("utf8"), oversized = key("oversized"), wrong = key("wrong"), missing = key("missing");
  await redis.set(exact, "x".repeat(64_000));
  const multibyte = "界".repeat(21_333) + "x";
  assert.equal(Buffer.byteLength(multibyte), 64_000);
  await redis.set(utf8, multibyte); await redis.set(oversized, multibyte + "x");
  await redis.hSet(wrong, "field", "value");

  await t.test("maximal response and missing keys retain exact alignment and UTF8 bytes", async () => {
    const outcomes = await read(Array.from({ length: 16 }, () => exact), 64_000);
    assert.equal(outcomes.length, 16);
    for (const slot of outcomes) assert.deepEqual(slot, { status: "fulfilled", value: "x".repeat(64_000) });
    assert.deepEqual(await read([missing, utf8, missing, exact, missing], 64_000),
      [null, multibyte, null, "x".repeat(64_000), null].map(value => ({ status: "fulfilled", value })));
    const slots = await read([exact, oversized, missing, wrong, utf8], 64_000);
    assert.equal(slots[1].status, "rejected");
    assert.ok(slots[1].status === "rejected" && slots[1].reason instanceof AgentContextCapacityError);
    assert.ok(slots[3].status === "rejected" && /WRONGTYPE/.test(slots[3].reason.message));
    assert.deepEqual(slots[4], { status: "fulfilled", value: multibyte });
    await assert.rejects(backend.get(wrong), /WRONGTYPE/);
    assert.deepEqual(await redis.mGet([wrong]), [null], "plain MGET would hide corruption");
    assert.deepEqual(await read([exact], 1), [{ status: "rejected", reason: new AgentContextCapacityError("Personal context is too large to load completely.") }]);
  });

  await t.test("later writes, deletions, CAS and TTL remain visible", async () => {
    const changing = key("changing");
    assert.deepEqual(await read([changing], 64_000), [{ status: "fulfilled", value: null }]);
    assert.equal(await backend.compareSet(changing, null, "first", 30), true);
    assert.equal(await backend.compareSet(changing, null, "lost"), false);
    assert.deepEqual(await read([changing], 64_000), [{ status: "fulfilled", value: "first" }]);
    assert.ok((await redis.ttl(changing)) > 0);
    assert.equal(await backend.compareSet(changing, "first", "later"), true);
    assert.equal(await backend.get(changing), "later");
    await redis.del(changing);
    assert.deepEqual(await read([changing], 64_000), [{ status: "fulfilled", value: null }]);
  });

  await t.test("invalid requests never dispatch a command", async t => {
    let calls = 0;
    t.mock.method(redis, "eval", async () => { calls++; throw new Error("should not dispatch"); });
    for (const keys of [[], Array(17).fill(exact), [""], Array(1), [null], ["x".repeat(513)]]) {
      await assert.rejects(read(keys as string[], 64_000), /Invalid bounded.*request/);
    }
    for (const size of [0, -1, 64_001, 1.5, Infinity, NaN]) await assert.rejects(read([exact], size), /Invalid bounded.*request/);
    assert.equal(calls, 0);
  });

  await t.test("malformed replies and transport failure never become missing data", async t => {
    let reply: unknown, calls = 0;
    t.mock.method(redis, "eval", async () => { calls++; return reply; });
    for (reply of [null, [], [[1]], [[1, undefined]], [[1, 7]], [[2, null]], [[0, "unknown"]], [[1, "x".repeat(64_001)]], Array(1)]) {
      await assert.rejects(read([exact], 64_000), /Invalid bounded.*response/);
    }
    assert.equal(calls, 9);
    t.mock.restoreAll();
    const failure = new Error("isolated transport failure");
    t.mock.method(redis, "eval", async () => { throw failure; });
    await assert.rejects(read([missing], 64_000), error => error === failure);
  });

  for (const settle of ["success", "failure"] as const) await t.test(`aborted default batch holds its permit until late ${settle}`, async t => {
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    let started!: () => void;
    const entered = new Promise<void>(yes => { started = yes; });
    t.mock.method(redis, "eval", () => { started(); return pending; });
    const owner = { teamId: "TBATCH", userId: "UBATCH" }, controller = new AbortController();
    const running = withAgentAdmission<readonly PromiseSettledResult<string | null>[] | string>(owner,
      () => contextRead(controller.signal, () => read([exact], 64_000)), () => AGENT_BUSY_MESSAGE);
    const stopped = assert.rejects(running, /original stop/);
    await entered; controller.abort(new Error("original stop")); await stopped;
    let release!: () => void, holdStarted!: () => void;
    const holdReady = new Promise<void>(yes => { holdStarted = yes; });
    const held = withAgentAdmission(owner, async () => { holdStarted(); await new Promise<void>(yes => { release = yes; }); return "done"; }, () => AGENT_BUSY_MESSAGE);
    await holdReady;
    try {
      assert.equal(await withAgentAdmission(owner, async () => "entered", () => AGENT_BUSY_MESSAGE), AGENT_BUSY_MESSAGE);
      if (settle === "success") resolve([[1, "late"]]); else reject(new Error("late transport error"));
      await new Promise(yes => setImmediate(yes));
      assert.equal(await withAgentAdmission(owner, async () => "released", () => AGENT_BUSY_MESSAGE), "released");
    } finally {
      resolve([[1, "late"]]); release(); await held;
    }
  });
});
