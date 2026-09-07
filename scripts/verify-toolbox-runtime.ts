// Opt-in smoke check against the EXISTING Redis, using only a random synthetic owner.
// Run: node --import tsx scripts/verify-toolbox-runtime.ts --confirm-test-writes
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { features } from "../lib/toolbox/index.js";
import { toolboxExamples } from "../lib/toolbox/examples.js";
import { runFeature } from "../lib/toolbox/core.js";
import { getRedisClient } from "../lib/redis.js";

if (!process.argv.includes("--confirm-test-writes"))
  throw new Error(
    "Pass --confirm-test-writes to create and remove isolated smoke-test records.",
  );
assert.equal(features.length, 20, "Expected all twenty deployed features");
const owner = {
  teamId: `TNOBOCHECK${randomUUID().replaceAll("-", "").toUpperCase()}`,
  userId: "UNOBOCHECK",
};
const keys = features.map(
  (f) => `nobo:toolbox:v1:${owner.teamId}:${owner.userId}:${f.id}`,
);
const redis = await getRedisClient();
assert.ok(redis, "Existing Redis connection required");
let verified = 0;
try {
  for (const feature of features) {
    const output = await runFeature(
      feature,
      toolboxExamples[feature.id],
      owner,
      "smoke-create",
    );
    const id = output.match(/[a-f0-9]{8}(?= ·)/)?.[0];
    assert.ok(id, `${feature.id}: create failed`);
    assert.equal(
      await runFeature(
        feature,
        toolboxExamples[feature.id],
        owner,
        "smoke-create",
      ),
      output,
      `${feature.id}: duplicate receipt`,
    );
    const exported = JSON.parse(
      await runFeature(feature, `export ${id}`, owner),
    );
    assert.equal(exported.id.slice(0, 8), id);
    assert.match(
      await runFeature(feature, `show ${id}`, {
        ...owner,
        teamId: `${owner.teamId}OTHER`,
      }),
      /not found/,
    );
    assert.match(
      await runFeature(feature, `delete ${id} confirm`, owner, "smoke-delete"),
      /Deleted/,
    );
    verified++;
  }
  const notes = features.find((f) => f.id === "notes")!;
  await Promise.all([
    runFeature(notes, "add Concurrent A | One", owner, "race-a"),
    runFeature(notes, "add Concurrent B | Two", owner, "race-b"),
  ]);
  assert.match(await runFeature(notes, "list", owner), /2 entries/);
  console.log(
    JSON.stringify({
      verifiedFeatures: verified,
      duplicateProtection: "passed",
      workspaceIsolation: "passed",
      concurrentWrites: "passed",
    }),
  );
} finally {
  // Exact test keys only — no pattern deletion, no real Slack user records.
  await redis.del(keys);
  assert.equal((await redis.mGet(keys)).filter(Boolean).length, 0);
  console.log(JSON.stringify({ syntheticTestKeysRemoved: keys.length }));
  await redis.quit();
}
