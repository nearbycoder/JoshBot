import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createClient } from "redis";
import { claimScheduledJob } from "../lib/scheduler-lease.js";
import { SchedulerRedis } from "./helpers/scheduler-redis.js";

const job = { id: "test-job", recordKey: "test:job", dueKey: "test:due" };

test("claim is exclusive and abandoned work becomes claimable after lease expiry", async () => {
  const redis = new SchedulerRedis();
  const original = '{ "legacy": true }';
  await redis.set(job.recordKey, original);
  await redis.zAdd(job.dueKey, { value: job.id, score: 0 });
  const contenders = await Promise.all(Array.from({ length: 10 }, () => claimScheduledJob(redis, job)));
  const claims = contenders.filter((lease) => lease !== null);
  assert.equal(claims.length, 1);
  const first = claims[0]!;
  first.stop(); // Simulate process death: no completion or heartbeat.
  assert.equal(await redis.get(job.recordKey), original);
  assert.equal(await redis.zScore(job.dueKey, job.id), redis.now + 120_000);
  redis.now += 119_999;
  assert.equal(await claimScheduledJob(redis, job), null);
  redis.now += 1;
  const recovered = await claimScheduledJob(redis, job);
  assert.ok(recovered);
  recovered.stop();
  await assert.rejects(first.assertCurrent(), /lease lost/);
  assert.equal(await first.finish(null), false);
  await recovered.assertCurrent();
  assert.equal(await recovered.finish('{"done":true}', redis.now + 60_000), true);
  assert.equal(await redis.get(job.recordKey), '{"done":true}');
  assert.equal(await redis.get(`${job.recordKey}:lease`), null);
});

test("cancellation and edits win over both completion and failure retries", async () => {
  for (const action of ["cancel", "edit"]) {
    for (const after of [null, '{"retry":true}']) {
      const redis = new SchedulerRedis();
      await redis.set(job.recordKey, "old");
      await redis.zAdd(job.dueKey, { value: job.id, score: 0 });
      const lease = await claimScheduledJob(redis, job);
      assert.ok(lease);
      lease.stop();
      if (action === "cancel") {
        await redis.del(job.recordKey);
        await redis.zRem(job.dueKey, job.id);
      } else {
        await redis.set(job.recordKey, "edited");
        await redis.zAdd(job.dueKey, { value: job.id, score: redis.now + 600_000 });
      }
      assert.equal(await lease.finish(after, redis.now + 300_000), false);
      assert.equal(await redis.get(job.recordKey), action === "cancel" ? null : "edited");
      assert.equal(await redis.zScore(job.dueKey, job.id), action === "cancel" ? null : redis.now + 600_000);
    }
  }
});

test("healthy heartbeat extends recovery deadline while retaining exclusive ownership", async () => {
  const redis = new SchedulerRedis();
  await redis.set(job.recordKey, "original");
  await redis.zAdd(job.dueKey, { value: job.id, score: 0 });
  const lease = await claimScheduledJob(redis, job, { leaseMs: 120_000, heartbeatMs: 5 });
  assert.ok(lease);
  try {
    redis.now += 100_000;
    await delay(25);
    assert.equal(await redis.zScore(job.dueKey, job.id), redis.now + 120_000);
    redis.now += 30_000;
    assert.equal(await claimScheduledJob(redis, job), null);
    await lease.assertCurrent();
  } finally { lease.stop(); }
});

test("an uncertain renewal fails closed even when Redis later recovers", async () => {
  const redis = new SchedulerRedis();
  await redis.set(job.recordKey, "original");
  await redis.zAdd(job.dueKey, { value: job.id, score: 0 });
  const evaluate = redis.eval.bind(redis);
  redis.eval = async (script, options) => {
    if (script.startsWith("-- scheduler-lease:renew")) throw new Error("Redis disconnected");
    return evaluate(script, options);
  };
  const lease = await claimScheduledJob(redis, job, { leaseMs: 120_000, heartbeatMs: 5 });
  assert.ok(lease);
  try {
    await delay(25);
    await assert.rejects(lease.assertCurrent(), /lease lost/);
    assert.equal(await lease.finish(null), false);
    assert.equal(await redis.get(job.recordKey), "original");
  } finally { lease.stop(); }
});

test("real Redis validates lease Lua, recovery, stale completion, and atomic removal", {
  skip: !process.env.SCHEDULER_TEST_REDIS_SERVER && "Set SCHEDULER_TEST_REDIS_SERVER to run isolated Redis integration",
  timeout: 15_000
}, async (t) => {
  // Never reads REDIS_URL: this server has its own temporary directory and Unix
  // socket, no TCP listener, no persistence, and no production credentials.
  const dir = await mkdtemp(join(tmpdir(), "joshbot-scheduler-test-"));
  const socket = join(dir, "redis.sock");
  const server = spawn(process.env.SCHEDULER_TEST_REDIS_SERVER!, [
    "--port", "0", "--unixsocket", socket, "--save", "", "--appendonly", "no", "--dir", dir
  ], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().toLowerCase().includes("ready to accept connections")) resolve();
    });
    server.once("exit", (code) => reject(new Error(`Redis exited before ready (${code})`)));
  });
  const redis = createClient({ socket: { path: socket, reconnectStrategy: false } });
  redis.on("error", () => {});
  await redis.connect();
  t.after(() => redis.destroy());
  const timing = { leaseMs: 500, heartbeatMs: 10_000 };
  await redis.set(job.recordKey, '{ "legacy": true }');
  await redis.sAdd("test:user", job.id);
  await redis.zAdd(job.dueKey, { value: job.id, score: 0 });
  const claims = (await Promise.all(Array.from({ length: 5 }, () => claimScheduledJob(redis, job, timing))))
    .filter((lease) => lease !== null);
  assert.equal(claims.length, 1);
  const first = claims[0]!;
  first.stop();
  assert.ok(await redis.zScore(job.dueKey, job.id));
  await delay(timing.leaseMs + 50);
  const recovered = await claimScheduledJob(redis, job, timing);
  assert.ok(recovered);
  recovered.stop();
  assert.equal(await first.finish(null, 0, ["test:user"]), false);
  assert.equal(await recovered.finish("recurring", Date.now() + 60_000), true);
  await redis.zAdd(job.dueKey, { value: job.id, score: 0 });
  const renewed = await claimScheduledJob(redis, job, { leaseMs: 500, heartbeatMs: 10 });
  assert.ok(renewed);
  t.after(() => renewed.stop());
  const deadline = await redis.zScore(job.dueKey, job.id);
  await delay(50);
  assert.ok((await redis.zScore(job.dueKey, job.id))! > deadline!);
  await renewed.assertCurrent();
  await redis.set(job.recordKey, "edit");
  await redis.zAdd(job.dueKey, { value: job.id, score: 12345 });
  assert.equal(await renewed.finish("stale", Date.now() + 60_000), false);
  assert.equal(await redis.get(job.recordKey), "edit");
  assert.equal(await redis.zScore(job.dueKey, job.id), 12345);
  // The heartbeat may observe the edit first and mark ownership lost. In that
  // case finish deliberately leaves the old token to expire rather than writing
  // anything. Both interleavings must allow a later worker after expiry.
  await delay(550);
  const completion = await claimScheduledJob(redis, job, timing);
  assert.ok(completion);
  completion.stop();
  assert.equal(await completion.finish(null, 0, ["test:user"]), true);
  assert.equal(await redis.get(job.recordKey), null);
  assert.equal(await redis.zScore(job.dueKey, job.id), null);
  assert.equal(Boolean(await redis.sIsMember("test:user", job.id)), false);
});
