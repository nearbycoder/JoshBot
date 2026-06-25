import assert from "node:assert/strict";
import test from "node:test";
import {
  __testing,
  evaluateNoboAccess,
  formatNoboAuditLog,
  getAccessConfig,
  listNoboAuditEvents,
  updateAccessControl
} from "../lib/access-controls.js";

test("bootstrap deny rules block users and channels", async () => {
  await withEnv({
    NOBO_DENIED_USER_IDS: "U123",
    NOBO_DENIED_CHANNEL_IDS: "C999"
  }, async () => {
    assert.equal((await evaluateNoboAccess({ userId: "U123", channelId: "C123" })).allowed, false);
    assert.equal((await evaluateNoboAccess({ userId: "U456", channelId: "C999" })).allowed, false);
    assert.equal((await evaluateNoboAccess({ userId: "U456", channelId: "C123" })).allowed, true);
  });
});

test("bootstrap allow rules require listed users and channels", async () => {
  await withEnv({
    NOBO_ALLOWED_USER_IDS: "U123",
    NOBO_ALLOWED_CHANNEL_IDS: "C123"
  }, async () => {
    assert.equal((await evaluateNoboAccess({ userId: "U123", channelId: "C123" })).allowed, true);
    assert.equal((await evaluateNoboAccess({ userId: "U456", channelId: "C123" })).allowed, false);
    assert.equal((await evaluateNoboAccess({ userId: "U123", channelId: "C999" })).allowed, false);
  });
});

test("Redis-backed admin updates merge with bootstrap config and audit", async () => {
  const redis = new FakeRedis();

  await withEnv({ NOBO_ADMIN_USER_IDS: "UADMIN" }, async () => {
    __testing.setRedisClient(redis);
    try {
      const result = await updateAccessControl({
        actorUserId: "UADMIN",
        mode: "deny",
        kind: "channels",
        targetId: "C123"
      });

      assert.equal(result.ok, true);
      assert.equal((await getAccessConfig()).deny.channels.has("C123"), true);
      assert.equal((await listNoboAuditEvents()).length, 1);
    } finally {
      __testing.setRedisClient(undefined);
    }
  });
});

test("audit formatting sanitizes arbitrary secret-like text", () => {
  const formatted = formatNoboAuditLog([
    {
      actorUserId: "UADMIN",
      action: "allow redis://user:secret@example.com",
      targetType: "channel",
      targetId: "C123",
      ok: true
    }
  ]);

  assert.match(formatted, /NoBo audit log/);
  assert.doesNotMatch(formatted, /secret/);
  assert.doesNotMatch(formatted, /redis:\/\/user/);
});

class FakeRedis {
  sets = new Map<string, Set<string>>();
  lists = new Map<string, string[]>();

  async sMembers(key: string) {
    return [...(this.sets.get(key) ?? new Set<string>())];
  }

  async sAdd(key: string, value: string) {
    const set = this.sets.get(key) ?? new Set<string>();
    const before = set.size;
    set.add(value);
    this.sets.set(key, set);
    return set.size - before;
  }

  async sRem(key: string, value: string) {
    const set = this.sets.get(key) ?? new Set<string>();
    const removed = set.delete(value);
    this.sets.set(key, set);
    return removed ? 1 : 0;
  }

  async lPush(key: string, value: string) {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  async lTrim(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list.slice(start, stop + 1));
    return "OK";
  }

  async lRange(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    return list.slice(start, stop + 1);
  }
}

async function withEnv(values: Record<string, string>, run: () => Promise<void>) {
  const names = [
    "NOBO_ADMIN_USER_IDS",
    "NOBO_ADMIN_USERS",
    "NOBO_ALLOWED_CHANNEL_IDS",
    "NOBO_ALLOW_CHANNEL_IDS",
    "NOBO_DENIED_CHANNEL_IDS",
    "NOBO_DENY_CHANNEL_IDS",
    "NOBO_ALLOWED_USER_IDS",
    "NOBO_ALLOW_USER_IDS",
    "NOBO_DENIED_USER_IDS",
    "NOBO_DENY_USER_IDS",
    "REDIS_URL"
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  for (const name of names) {
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(values)) {
    process.env[name] = value;
  }

  try {
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}
