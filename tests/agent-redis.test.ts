import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { getRedisClient } from "../lib/redis.js";
import { createAgentFeatureStore, createAgentStateBackend, type AgentStateBackend } from "../lib/agent-features/store.js";
import { runAgentFeature } from "../lib/agent-features/runtime.js";
import type { AgentFeature } from "../lib/agent-features/types.js";
import { createAgentTestContext } from "./agent-feature-test-utils.js";

test("real Redis preserves concurrent agent writes, scoped reads and request receipt expiry", {
  skip: !process.env.POLL_TEST_REDIS_URL,
  timeout: 10_000,
}, async (t) => {
  const url = process.env.POLL_TEST_REDIS_URL!;
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname), "Use an isolated local test Redis");
  const previousUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = url;
  const redis = await getRedisClient();
  assert.ok(redis);
  const written = new Set<string>();
  t.after(async () => {
    try { if (written.size) await redis.del([...written]); }
    finally {
      await redis.close();
      if (previousUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousUrl;
    }
  });
  const actual = await createAgentStateBackend();
  assert.ok(actual);
  const backend: AgentStateBackend = {
    get: (key) => actual.get(key),
    compareSet: (key, previous, next, ttl) => {
      written.add(key);
      return actual.compareSet(key, previous, next, ttl);
    },
  };
  const owner = { teamId: `T${randomBytes(8).toString("hex").toUpperCase()}`, userId: "UTEST" };
  const feature: AgentFeature = {
    id: "persistence-test", title: "Persistence test", description: "Test", help: "Help",
    execute: (_command, context) => context.store.update("count", 0, (count) => ({ value: count + 1, result: String(count + 1) })),
  };
  const settings = { backend, timezone: "UTC", services: createAgentTestContext().services };
  const scoped = createAgentFeatureStore(backend, owner, feature.id);
  const results = await Promise.all(Array.from({ length: 20 }, () => scoped.update("count", 0, count => ({ value: count + 1, result: String(count + 1) }))));
  assert.equal(new Set(results).size, 20);
  assert.equal(await scoped.read("count"), 20);
  for (const caller of [{ ...owner, userId: "UOTHER" }, { ...owner, teamId: "TOTHER" }]) {
    assert.equal(await createAgentFeatureStore(backend, caller, feature.id).read("count"), null);
  }
  assert.equal(await createAgentFeatureStore(backend, owner, "another-feature").read("count"), null);

  const request = { ...owner, requestId: "private-trigger" };
  const replies = await Promise.all([1, 2].map(() => runAgentFeature(feature, "private-input", request, settings)));
  assert.ok(replies.includes("21"));
  assert.ok(replies.some((reply) => reply.includes("already received")));
  assert.equal(await scoped.read("count"), 21);
  const receipt = [...written].find((key) => key.startsWith("nobo:agent-requests:"));
  assert.ok(receipt);
  const encoded = await redis.get(receipt);
  assert.equal(encoded, '{"state":"finished"}');
  assert.ok(!receipt.includes(request.requestId));
  const ttl = await redis.ttl(receipt);
  assert.ok(ttl > 86_390 && ttl <= 86_400, `Unexpected receipt TTL: ${ttl}`);
  assert.equal(await backend.compareSet(receipt, null, "overwrite"), false);
  assert.equal(await backend.compareSet(receipt, '{"state":"started"}', "overwrite"), false);
  assert.equal(await redis.get(receipt), encoded);
});
