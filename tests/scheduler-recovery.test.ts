import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { __testing as accessTesting } from "../lib/access-controls.js";
import { __testing as schedules, cancelScheduleById, editOwnedSchedule } from "../lib/schedules.js";
import { __testing as monitors, cancelMonitorFromTool } from "../lib/monitors.js";
import { __testing as digests, handleChannelDigestCommand } from "../lib/channel-digests.js";
import type { getRedisClient } from "../lib/redis.js";
import { claimScheduledJob } from "../lib/scheduler-lease.js";
import { postSlackMessage } from "../lib/slack.js";
import type { ChannelMemoryEntry } from "../lib/memory.js";
import { SchedulerRedis } from "./helpers/scheduler-redis.js";

type Kind = "schedule" | "monitor" | "digest";
const kinds: Kind[] = ["schedule", "monitor", "digest"];
const context = { ownerUserId: "U123", channel: "C123", threadTs: "1.0", sourceTs: "2.0", mentionedChannels: [] };

async function setup(t: TestContext, kind: Kind) {
  const savedEnv = { ...process.env };
  // Never connect to a configured production Redis or make any real HTTP call.
  delete process.env.REDIS_URL;
  for (const key of Object.keys(process.env)) {
    if (/^NOBO_(ALLOWED|ALLOW|DENIED|DENY)_/.test(key)) delete process.env[key];
  }
  process.env.SLACK_BOT_TOKEN = "fake-scheduler-token";
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request in scheduler test"); });
  accessTesting.setRedisClient(null);
  const redis = new SchedulerRedis();
  const provider = async () => redis as unknown as NonNullable<Awaited<ReturnType<typeof getRedisClient>>>;
  schedules.setRedisProvider(provider);
  monitors.setRedisProvider(provider);
  digests.setRedisProvider(provider);
  t.after(() => {
    schedules.setRedisProvider();
    schedules.setMemoryAppender();
    monitors.setRedisProvider();
    digests.setRedisProvider();
    digests.setDigestGenerator();
    digests.setMemoryAppender();
    accessTesting.setRedisClient(undefined);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  const id = `test-${kind}`;
  const prefix = kind === "digest" ? "channel-digests" : kind === "monitor" ? "monitors" : "schedules";
  const job = { id, recordKey: `${prefix}:${kind === "digest" ? "subscription" : "job"}:${id}`, dueKey: `${prefix}:due` };
  const record = {
    id, ownerUserId: "U123", channel: "C123", timezone: "America/Chicago",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    ...(kind === "schedule" ? { kind: "once", task: "test reminder", responseMode: "prompt" } : {}),
    ...(kind === "monitor" ? { kind: "interval", intervalMs: 60_000, source: "prompt", conditionType: "appears", query: "test query" } : {}),
    ...(kind === "digest" ? { frequency: "daily", hour: 9, minute: 0, focus: "test focus" } : {})
  };
  await redis.set(job.recordKey, JSON.stringify(record));
  await redis.zAdd(job.dueKey, { value: id, score: Date.now() - 1_000 });
  await redis.sAdd(`${prefix}:user:U123`, id);
  if (kind === "digest") await redis.sAdd(`${prefix}:channel:C123`, id);
  let generated = 0;
  const deliveries: string[] = [];
  return {
    redis, job, record, deliveries,
    get generated() { return generated; },
    async cancel() {
      if (kind === "schedule") await cancelScheduleById(id, "U123");
      else if (kind === "monitor") await cancelMonitorFromTool(context, id);
      else await handleChannelDigestCommand({ text: `cancel ${id}`, channelId: "C123", ownerUserId: "U123" });
    },
    async run(hooks: { generate?: () => Promise<void>; post?: () => Promise<void> } = {}) {
      const generate = async () => { generated += 1; await hooks.generate?.(); return "generated text"; };
      const post = async (options: { text: string }) => {
        deliveries.push(options.text);
        await hooks.post?.();
        return { ts: "3.0" };
      };
      if (kind === "schedule") {
        await schedules.runDueSchedules({ runScheduledTask: generate, postSlackMessage: post });
      } else if (kind === "monitor") {
        await monitors.runDueMonitors({
          runMonitorCheck: async () => ({ matched: true, summary: await generate(), fingerprint: "fingerprint", observation: "observation" }),
          postSlackMessage: post
        });
      } else {
        digests.setDigestGenerator(generate);
        await digests.runDueChannelDigestSubscriptions({ postSlackMessage: post });
      }
    }
  };
}

for (const kind of kinds) {
  for (const fails of [false, true]) {
    test(`${kind}: cancellation during generation survives ${fails ? "failure retry" : "completion"}`, async (t) => {
      const fixture = await setup(t, kind);
      const started = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const running = fixture.run({ generate: async () => {
        started.resolve();
        await resume.promise;
        if (fails) throw new Error("generation failed after cancellation");
      } });
      await started.promise;
      await fixture.cancel();
      resume.resolve();
      await running;
      assert.deepEqual(fixture.deliveries, []);
      assert.equal(await fixture.redis.get(fixture.job.recordKey), null);
      assert.equal(await fixture.redis.zScore(fixture.job.dueKey, fixture.job.id), null);
    });

    test(`${kind}: cancellation during Slack delivery survives ${fails ? "ambiguous failure" : "successful delivery"}`, async (t) => {
      const fixture = await setup(t, kind);
      await fixture.run({ post: async () => {
        await fixture.cancel();
        if (fails) throw new Error("ambiguous Slack failure");
      } });
      assert.equal(fixture.deliveries.length, 1);
      assert.equal(await fixture.redis.get(fixture.job.recordKey), null);
      assert.equal(await fixture.redis.zScore(fixture.job.dueKey, fixture.job.id), null);
    });

    test(`${kind}: edits during generation survive ${fails ? "failure retry" : "completion"}`, async (t) => {
      const fixture = await setup(t, kind);
      let edited = "";
      const nextRunAt = Date.parse("2099-01-01T00:00:00.000Z");
      await fixture.run({ generate: async () => {
        if (kind === "schedule") {
          await editOwnedSchedule(fixture.job.id, "U123", "edited task", new Date(nextRunAt).toISOString());
        } else {
          await fixture.redis.set(fixture.job.recordKey, JSON.stringify({ ...fixture.record, nextRunAt: new Date(nextRunAt).toISOString() }));
          await fixture.redis.zAdd(fixture.job.dueKey, { value: fixture.job.id, score: nextRunAt });
        }
        edited = (await fixture.redis.get(fixture.job.recordKey))!;
        if (fails) throw new Error("generation failed after edit");
      } });
      assert.deepEqual(fixture.deliveries, []);
      assert.equal(await fixture.redis.get(fixture.job.recordKey), edited);
      assert.equal(await fixture.redis.zScore(fixture.job.dueKey, fixture.job.id), nextRunAt);
    });
  }

  for (const subject of ["owner", "channel"]) {
    for (const stage of ["before", "after"]) {
      test(`${kind}: denied ${subject} ${stage} generation prevents delivery`, async (t) => {
        const fixture = await setup(t, kind);
        const deny = () => {
          if (subject === "owner") process.env.NOBO_DENIED_USER_IDS = "U123";
          else process.env.NOBO_DENIED_CHANNEL_IDS = "C123";
        };
        if (stage === "before") deny();
        const before = await fixture.redis.get(fixture.job.recordKey);
        await fixture.run({ generate: async () => { deny(); } });
        assert.equal(fixture.generated, stage === "before" ? 0 : 1);
        assert.deepEqual(fixture.deliveries, []);
        assert.equal(await fixture.redis.get(fixture.job.recordKey), before);
        assert.ok((await fixture.redis.zScore(fixture.job.dueKey, fixture.job.id))! > Date.now());
      });
    }
  }

  test(`${kind}: a worker that loses its lease during generation cannot send or finalize`, async (t) => {
    const fixture = await setup(t, kind);
    let reclaimedToken: string | null = null;
    await fixture.run({ generate: async () => {
      fixture.redis.now += 120_001;
      const recovered = await claimScheduledJob(fixture.redis, fixture.job);
      assert.ok(recovered);
      recovered.stop();
      reclaimedToken = await fixture.redis.get(`${fixture.job.recordKey}:lease`);
    } });
    assert.deepEqual(fixture.deliveries, []);
    assert.equal(await fixture.redis.get(`${fixture.job.recordKey}:lease`), reclaimedToken);
    assert.equal(await fixture.redis.get(fixture.job.recordKey), JSON.stringify(fixture.record));
    assert.equal(await fixture.redis.zScore(fixture.job.dueKey, fixture.job.id), fixture.redis.now + 120_000);
  });

  test(`${kind}: successful delivery finalizes once and future ticks do not repeat it`, async (t) => {
    const fixture = await setup(t, kind);
    await fixture.run();
    await fixture.run();
    assert.equal(fixture.deliveries.length, 1);
    assert.equal(await fixture.redis.get(`${fixture.job.recordKey}:lease`), null);
    if (kind === "schedule") {
      assert.equal(await fixture.redis.get(fixture.job.recordKey), null);
      assert.equal(await fixture.redis.zScore(fixture.job.dueKey, fixture.job.id), null);
      assert.deepEqual(await fixture.redis.sMembers("schedules:user:U123"), []);
    } else {
      assert.ok((await fixture.redis.zScore(fixture.job.dueKey, fixture.job.id))! > Date.now());
      const next = JSON.parse((await fixture.redis.get(fixture.job.recordKey))!);
      assert.notEqual(next.nextRunAt, fixture.record.nextRunAt);
      if (kind === "monitor") assert.equal(next.lastAlertFingerprint, "fingerprint");
    }
  });
}

test("reminder memory failure after a successful Slack post does not retry delivery", async (t) => {
  const fixture = await setup(t, "schedule");
  let memoryAttempts = 0;
  schedules.setMemoryAppender(async () => { memoryAttempts += 1; throw new Error("memory unavailable"); });
  await fixture.run();
  await fixture.run();
  assert.equal(memoryAttempts, 1);
  assert.equal(fixture.deliveries.length, 1);
  assert.equal(await fixture.redis.get(fixture.job.recordKey), null);
  assert.equal(await fixture.redis.zScore(fixture.job.dueKey, fixture.job.id), null);
});

for (const failure of ["HTTP 429", "Slack API error"]) {
  test(`digest: real Slack transport ${failure} preserves the occurrence for retry`, async (t) => {
    const fixture = await setup(t, "digest");
    const text = "Complete digest: release approved, follow up on the migration.";
    digests.setDigestGenerator(async () => text);
    const memories: Array<{ channel: string; entries: ChannelMemoryEntry | ChannelMemoryEntry[] }> = [];
    digests.setMemoryAppender(async (channel, entries) => {
      memories.push({ channel, entries });
      return { ok: true, status: "added", memories: [] };
    });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let failing = true;
    // Exercise production postSlackMessage/slackApi; intercept only the HTTP
    // boundary. Any placeholder or update request is an observable regression.
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      if (failing) {
        return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
          status: failure === "HTTP 429" ? 429 : 200,
          headers: { "content-type": "application/json", "retry-after": "1" }
        });
      }
      return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "9.001" }), {
        headers: { "content-type": "application/json" }
      });
    });
    const before = Date.now();
    await digests.runDueChannelDigestSubscriptions({ postSlackMessage });
    const after = Date.now();
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "https://slack.com/api/chat.postMessage");
    assert.equal(requests[0]!.body.text, text);
    assert.equal(requests[0]!.body.channel, "C123");
    assert.equal(await fixture.redis.get(fixture.job.recordKey), JSON.stringify(fixture.record));
    const retryAt = (await fixture.redis.zScore(fixture.job.dueKey, fixture.job.id))!;
    assert.ok(retryAt >= before + 300_000 && retryAt <= after + 300_000);
    assert.equal(await fixture.redis.get(`${fixture.job.recordKey}:lease`), null);
    assert.deepEqual(memories, []);

    failing = false;
    fixture.redis.now = Date.now();
    await fixture.redis.zAdd(fixture.job.dueKey, { value: fixture.job.id, score: 0 });
    await digests.runDueChannelDigestSubscriptions({ postSlackMessage });
    await digests.runDueChannelDigestSubscriptions({ postSlackMessage });
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.url.endsWith("/chat.postMessage") && request.body.text === text));
    const next = JSON.parse((await fixture.redis.get(fixture.job.recordKey))!);
    assert.notEqual(next.nextRunAt, fixture.record.nextRunAt);
    assert.equal(await fixture.redis.zScore(fixture.job.dueKey, fixture.job.id), Date.parse(next.nextRunAt));
    assert.equal(await fixture.redis.get(`${fixture.job.recordKey}:lease`), null);
    assert.deepEqual(memories, [{ channel: "C123", entries: { role: "assistant", content: text, ts: "9.001" } }]);
  });
}

test("digest memory failure after delivery advances the schedule without retrying Slack", async (t) => {
  const fixture = await setup(t, "digest");
  let memoryAttempts = 0;
  digests.setMemoryAppender(async () => { memoryAttempts += 1; throw new Error("memory unavailable"); });
  await fixture.run();
  await fixture.run();
  assert.equal(memoryAttempts, 1);
  assert.equal(fixture.deliveries.length, 1);
  const next = JSON.parse((await fixture.redis.get(fixture.job.recordKey))!);
  assert.notEqual(next.nextRunAt, fixture.record.nextRunAt);
  assert.equal(await fixture.redis.zScore(fixture.job.dueKey, fixture.job.id), Date.parse(next.nextRunAt));
  assert.equal(await fixture.redis.get(`${fixture.job.recordKey}:lease`), null);
});
