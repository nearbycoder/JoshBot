import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { __testing as accessTesting } from "../lib/access-controls.js";
import { __testing } from "../lib/hacker-news-schedule.js";

test("Hacker News schedule defaults to 9am and 2pm Central", () => {
  const originalTimes = process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES;
  delete process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES;

  try {
    assert.deepEqual(__testing.getHackerNewsScheduleTimes(), ["09:00", "14:00"]);
    assert.equal(__testing.timeToCronExpression("09:00"), "0 9 * * *");
    assert.equal(__testing.timeToCronExpression("14:00"), "0 14 * * *");
  } finally {
    if (originalTimes === undefined) {
      delete process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES;
    } else {
      process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES = originalTimes;
    }
  }
});

test("Hacker News schedule accepts configured times", () => {
  const originalTimes = process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES;
  process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES = "08:15, 16:45";

  try {
    assert.deepEqual(__testing.getHackerNewsScheduleTimes(), ["08:15", "16:45"]);
    assert.equal(__testing.timeToCronExpression("08:15"), "15 8 * * *");
    assert.equal(__testing.timeToCronExpression("16:45"), "45 16 * * *");
  } finally {
    if (originalTimes === undefined) {
      delete process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES;
    } else {
      process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES = originalTimes;
    }
  }
});

test("Hacker News schedule rejects invalid times", () => {
  assert.throws(() => __testing.timeToCronExpression("24:00"), /Invalid Hacker News schedule time/);
  assert.throws(() => __testing.timeToCronExpression("9am"), /Invalid Hacker News schedule time/);
});

test("Hacker News delivery checks channel policy before fetching stories or sending a placeholder", async (t) => {
  const fake = setupDelivery(t);
  fake.policy.set("nobo:access:deny:channels", ["C123"]);

  await __testing.postScheduledHackerNewsDigest();

  assert.deepEqual(fake.requests, []);
});

test("Hacker News delivery obeys channel allowlists", async (t) => {
  const fake = setupDelivery(t);
  fake.policy.set("nobo:access:allow:channels", ["COTHER"]);

  await __testing.postScheduledHackerNewsDigest();

  assert.deepEqual(fake.requests, []);
});

test("the ownerless Hacker News schedule cannot bypass a user allowlist", async (t) => {
  const fake = setupDelivery(t);
  fake.policy.set("nobo:access:allow:users", ["UADMIN"]);
  process.env.NOBO_ADMIN_USER_IDS = "UADMIN";

  await __testing.postScheduledHackerNewsDigest();

  assert.deepEqual(fake.requests, []);
});

test("Hacker News delivery rechecks policy after channel resolution", async (t) => {
  const fake = setupDelivery(t);
  delete process.env.NOBO_HACKER_NEWS_CHANNEL_ID;
  fake.onResolve = () => {
    fake.policy.set("nobo:access:deny:channels", ["C123"]);
  };

  await __testing.postScheduledHackerNewsDigest();

  assert.deepEqual(fake.requests.map((request) => new URL(request).pathname), ["/api/conversations.list"]);
  assert.deepEqual(fake.deliveries, []);
});

test("channel denial during Hacker News fetching prevents every Slack write", async (t) => {
  const fake = setupDelivery(t);
  const started = deferred();
  const resume = deferred();
  fake.onItem = async () => {
    started.resolve();
    await resume.promise;
  };

  const run = __testing.postScheduledHackerNewsDigest();
  await started.promise;
  fake.policy.set("nobo:access:deny:channels", ["C123"]);
  resume.resolve();
  await run;

  assert.equal(fake.requests.length, 2);
  assert.ok(fake.requests.every((request) => new URL(request).hostname === "hacker-news.firebaseio.com"));
  assert.deepEqual(fake.deliveries, []);
});

test("a user allowlist added during Hacker News generation blocks the ownerless schedule", async (t) => {
  const fake = setupDelivery(t);
  fake.onItem = () => {
    fake.policy.set("nobo:access:allow:users", ["U123"]);
  };

  await __testing.postScheduledHackerNewsDigest();

  assert.deepEqual(fake.deliveries, []);
});

test("a newly restrictive channel allowlist is enforced immediately before Hacker News delivery", async (t) => {
  const fake = setupDelivery(t);
  fake.onItem = () => {
    fake.policy.set("nobo:access:allow:channels", ["COTHER"]);
  };

  await __testing.postScheduledHackerNewsDigest();

  assert.deepEqual(fake.deliveries, []);
});

test("Hacker News policy lookup errors before generation abort delivery", async (t) => {
  const fake = setupDelivery(t);
  fake.policyError = new Error("fake policy store unavailable");

  await assert.rejects(__testing.postScheduledHackerNewsDigest(), /fake policy store unavailable/);

  assert.deepEqual(fake.requests, []);
});

test("Hacker News policy lookup errors after generation abort delivery and release the local guard", async (t) => {
  const fake = setupDelivery(t);
  fake.onItem = () => {
    fake.policyError = new Error("fake policy store unavailable");
  };

  await assert.rejects(__testing.postScheduledHackerNewsDigest(), /fake policy store unavailable/);
  assert.deepEqual(fake.deliveries, []);

  fake.onItem = undefined;
  fake.policyError = undefined;
  await __testing.postScheduledHackerNewsDigest();
  assert.equal(fake.deliveries.length, 1);
});

test("an allowed Hacker News run posts only the completed digest to the checked channel", async (t) => {
  const fake = setupDelivery(t);
  fake.policy.set("nobo:access:allow:channels", ["C123"]);

  await __testing.postScheduledHackerNewsDigest();

  assert.equal(fake.deliveries.length, 1);
  assert.equal(fake.deliveries[0]?.channel, "C123");
  assert.match(String(fake.deliveries[0]?.text), /\*Top Trending Hacker News\*/);
  assert.match(String(fake.deliveries[0]?.text), /A fake Hacker News story/);
  assert.equal(fake.requests.at(-1), "https://slack.com/api/chat.postMessage");
});

test("disabling the Hacker News schedule during fetching cancels delivery", async (t) => {
  const fake = setupDelivery(t);
  fake.onItem = () => {
    process.env.NOBO_HACKER_NEWS_SCHEDULE = "off";
  };

  await __testing.postScheduledHackerNewsDigest();

  assert.deepEqual(fake.deliveries, []);
});

test("overlapping Hacker News cron jobs share one local guard through delivery", async (t) => {
  const fake = setupDelivery(t);
  const generating = deferred();
  const finishGeneration = deferred();
  const posting = deferred();
  const finishPost = deferred();
  fake.onItem = async () => {
    generating.resolve();
    await finishGeneration.promise;
  };
  fake.onPost = async () => {
    posting.resolve();
    await finishPost.promise;
  };

  const firstRun = __testing.postScheduledHackerNewsDigest();
  try {
    await generating.promise;
    await __testing.postScheduledHackerNewsDigest();
    assert.equal(fake.requests.length, 2);

    finishGeneration.resolve();
    await posting.promise;
    await __testing.postScheduledHackerNewsDigest();
    assert.equal(fake.deliveries.length, 1);
  } finally {
    finishGeneration.resolve();
    finishPost.resolve();
    await firstRun;
  }

  await __testing.postScheduledHackerNewsDigest();
  assert.equal(fake.deliveries.length, 2);
});

test("Hacker News generation failure releases the local guard without posting", async (t) => {
  const fake = setupDelivery(t);
  fake.onItem = () => {
    throw new Error("fake HN failure");
  };

  await assert.rejects(__testing.postScheduledHackerNewsDigest(), /fake HN failure/);
  assert.deepEqual(fake.deliveries, []);

  fake.onItem = undefined;
  await __testing.postScheduledHackerNewsDigest();
  assert.equal(fake.deliveries.length, 1);
});

test("ambiguous Hacker News delivery failure is not automatically retried", async (t) => {
  const fake = setupDelivery(t);
  fake.onPost = () => {
    throw new Error("fake connection lost after Slack accepted message");
  };

  await assert.rejects(__testing.postScheduledHackerNewsDigest(), /fake connection lost/);
  assert.equal(fake.deliveries.length, 1);

  fake.onPost = undefined;
  await __testing.postScheduledHackerNewsDigest();
  assert.equal(fake.deliveries.length, 2);
});

function setupDelivery(t: TestContext) {
  const names = [
    "NOBO_HACKER_NEWS_CHANNEL_ID", "NOBO_HACKER_NEWS_CHANNEL_NAME", "NOBO_HACKER_NEWS_FOCUS",
    "NOBO_HACKER_NEWS_SCHEDULE", "NOBO_ADMIN_USER_IDS", "NOBO_ADMIN_USERS",
    "NOBO_ALLOWED_CHANNEL_IDS", "NOBO_ALLOW_CHANNEL_IDS", "NOBO_DENIED_CHANNEL_IDS", "NOBO_DENY_CHANNEL_IDS",
    "NOBO_ALLOWED_USER_IDS", "NOBO_ALLOW_USER_IDS", "NOBO_DENIED_USER_IDS", "NOBO_DENY_USER_IDS",
    "SLACK_BOT_TOKEN", "REDIS_URL"
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.NOBO_HACKER_NEWS_CHANNEL_ID = "C123";
  process.env.SLACK_BOT_TOKEN = "fake-test-token";
  __testing.resetChannelCache();
  t.after(() => {
    __testing.resetChannelCache();
    accessTesting.setRedisClient(undefined);
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const fake: {
    policy: Map<string, string[]>;
    policyError?: Error;
    requests: string[];
    deliveries: Record<string, unknown>[];
    onResolve?: () => void | Promise<void>;
    onItem?: () => void | Promise<void>;
    onPost?: () => void | Promise<void>;
  } = { policy: new Map(), requests: [], deliveries: [] };

  const unexpectedPolicyWrite = async (): Promise<never> => {
    throw new Error("Unexpected access-policy write");
  };
  accessTesting.setRedisClient({
    sMembers: async (key) => {
      if (fake.policyError) throw fake.policyError;
      return fake.policy.get(key) ?? [];
    },
    sAdd: unexpectedPolicyWrite,
    sRem: unexpectedPolicyWrite,
    lPush: unexpectedPolicyWrite,
    lTrim: unexpectedPolicyWrite,
    lRange: unexpectedPolicyWrite
  });

  // Every network request stays inside this fake. Unexpected endpoints fail closed.
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    fake.requests.push(url);
    if (url === "https://hacker-news.firebaseio.com/v0/topstories.json") {
      return jsonResponse([101]);
    }
    if (url === "https://hacker-news.firebaseio.com/v0/item/101.json") {
      await fake.onItem?.();
      return jsonResponse({ id: 101, type: "story", title: "A fake Hacker News story", score: 42 });
    }
    if (url.startsWith("https://slack.com/api/conversations.list?")) {
      await fake.onResolve?.();
      return jsonResponse({ ok: true, channels: [{ id: "C123", name: "hacker-news" }] });
    }
    if (url === "https://slack.com/api/chat.postMessage") {
      assert.equal(init?.method, "POST");
      fake.deliveries.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      await fake.onPost?.();
      return jsonResponse({ ok: true, channel: "C123", ts: "1234.5678" });
    }
    throw new Error(`Unexpected fake-network request: ${url}`);
  });

  return fake;
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
