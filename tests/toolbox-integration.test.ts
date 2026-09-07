import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@slack/bolt";
import { features } from "../lib/toolbox/index.js";
import { toolboxExamples } from "../lib/toolbox/examples.js";
import {
  execute,
  runFeature,
  parts,
  type Store,
  type Entry,
} from "../lib/toolbox/core.js";
import { notes } from "../lib/toolbox/notes.js";
import { registerSlackToolbox, toolboxView } from "../src/slack-toolbox.js";

function memoryStore(): Store {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    compareSet: async (key, previous, next) => {
      if ((data.get(key) ?? null) !== previous) return false;
      data.set(key, next);
      return true;
    },
  };
}
for (const feature of features) {
  test(`${feature.id}: persisted private lifecycle, readable view, export and confirmed deletion`, async () => {
    const store = memoryStore(),
      owner = { userId: "UCASE", teamId: "TCASE" },
      now = new Date("2026-09-07T12:00:00Z");
    const result = await runFeature(
      feature,
      toolboxExamples[feature.id],
      owner,
      "create",
      store,
      now,
    );
    const id = result.match(/[a-f0-9]{8}(?= ·)/)?.[0];
    assert.ok(id, result);
    assert.equal(
      await runFeature(
        feature,
        toolboxExamples[feature.id],
        owner,
        "create",
        store,
        now,
      ),
      result,
    );
    const exported = JSON.parse(
      await runFeature(feature, `export ${id}`, owner, undefined, store, now),
    );
    assert.equal(exported.id.slice(0, 8), id);
    const shown = await runFeature(
      feature,
      `show ${id}`,
      owner,
      undefined,
      store,
      now,
    );
    assert.ok(shown.length > 10);
    assert.doesNotMatch(shown, /"createdAt"|"updatedAt"/);
    assert.match(
      await runFeature(
        feature,
        `show ${id}`,
        { ...owner, userId: "UOTHER" },
        undefined,
        store,
        now,
      ),
      /not found/,
    );
    assert.match(
      await runFeature(
        feature,
        `show ${id}`,
        { ...owner, teamId: "TOTHER" },
        undefined,
        store,
        now,
      ),
      /not found/,
    );
    assert.match(
      await runFeature(feature, `delete ${id}`, owner, undefined, store, now),
      /confirm/,
    );
    assert.match(
      await runFeature(
        feature,
        `delete ${id} confirm`,
        owner,
        "delete",
        store,
        now,
      ),
      /Deleted/,
    );
    assert.match(
      await runFeature(feature, "list", owner, undefined, store, now),
      /No entries/,
    );
  });
}
test("all twenty tools are discoverable in the compact alphabetical picker", () => {
  assert.equal(features.length, 20);
  assert.equal(new Set(features.map((f) => f.id)).size, 20);
  assert.deepEqual(
    Object.keys(toolboxExamples).sort(),
    features.map((f) => f.id).sort(),
  );
  assert.deepEqual(
    features.map((f) => f.title),
    features.map((f) => f.title).sort((a, b) => a.localeCompare(b, "en")),
  );
  const view = toolboxView(),
    again = toolboxView();
  assert.equal(view.blocks.length, 3);
  assert.notEqual(view.blocks[2].block_id, again.blocks[2].block_id);
  assert.ok(view.blocks[2].block_id?.includes(view.private_metadata!));
});
test("escaped field separators preserve code and out-of-range pages are honest", () => {
  assert.deepEqual(
    parts(String.raw`Title | const flags = a \| b; C:\\tmp`, 2),
    ["Title", "const flags = a | b; C:\\tmp"],
  );
  const entries: Entry[] = [];
  execute(notes, entries, "add Note | Text");
  assert.match(execute(notes, entries, "page 5"), /page has no entries/);
});
test("storage failure, contention and limits do not falsely report a saved entry", async () => {
  const owner = { userId: "U1", teamId: "T1" };
  const broken: Store = {
    get: async () => {
      throw new Error("secret connection string");
    },
    compareSet: async () => false,
  };
  const error = await runFeature(notes, "add Note | Text", owner, "r", broken);
  assert.doesNotMatch(error, /secret connection/);
  assert.match(error, /could not complete/);
  assert.match(
    await runFeature(notes, "add Note | Text", owner, "r", {
      get: async () => null,
      compareSet: async () => false,
    }),
    /Another change/,
  );
  assert.match(
    await runFeature(notes, "x".repeat(3001), owner, "r", memoryStore()),
    /3000/,
  );
  const full: Entry[] = [];
  for (let i = 0; i < 100; i++) execute(notes, full, `add Note ${i} | Text`);
  assert.throws(
    () => execute(notes, full, "add Overflow | Text"),
    /100 entries/,
  );
});

test("modal acknowledges before work, binds authenticated identity, and rechecks access", async () => {
  let handler: (args: any) => Promise<void> = async () => {};
  const events: string[] = [],
    calls: unknown[][] = [],
    views: unknown[] = [];
  const bolt = {
    view: (_name: string, fn: typeof handler) => {
      handler = fn;
    },
  } as unknown as App;
  let allowed = true;
  registerSlackToolbox(bolt, {
    access: (async () => {
      events.push("access");
      return { allowed };
    }) as any,
    run: async (...args) => {
      events.push("run");
      calls.push(args);
      return "Saved privately";
    },
  });
  const input = {
    ack: async () => {
      events.push("ack");
    },
    body: { user: { id: "UAUTH" }, team: { id: "TAUTH" } },
    view: {
      id: "V1",
      private_metadata: "nonce",
      state: {
        values: {
          tool: { value: { selected_option: { value: "notes" } } },
          command_nonce: { value: { value: "add Title | Body" } },
          command_attacker: { value: { value: "delete stolen confirm" } },
        },
      },
    },
    client: {
      views: {
        update: async (view: unknown) => {
          events.push("update");
          views.push(view);
        },
      },
    },
  };
  await handler(input);
  assert.deepEqual(events, ["ack", "access", "run", "update"]);
  assert.deepEqual(calls[0], [
    "notes add Title | Body",
    { userId: "UAUTH", teamId: "TAUTH" },
    "V1:nonce",
  ]);
  allowed = false;
  await handler(input);
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(views.at(-1)), /restricted/);
});
test("deletion clears cached content without allowing old retries to recreate it", async () => {
  const store = memoryStore(),
    owner = { userId: "UPRIVACY", teamId: "TPRIVACY" };
  const result = await runFeature(
    notes,
    "add Sensitive title | Sensitive body",
    owner,
    "create",
    store,
  );
  const id = result.match(/[a-f0-9]{8}(?= ·)/)![0];
  await runFeature(notes, `delete ${id} confirm`, owner, "delete", store);
  const raw = await store.get("nobo:toolbox:v1:TPRIVACY:UPRIVACY:notes");
  assert.doesNotMatch(raw!, /Sensitive/);
  assert.match(
    await runFeature(
      notes,
      "add Sensitive title | Sensitive body",
      owner,
      "create",
      store,
    ),
    /already completed/,
  );
  assert.match(
    await runFeature(notes, "list", owner, undefined, store),
    /No entries/,
  );
});
test("entry limits count UTF-8 bytes and reject an oversized append atomically", async () => {
  const store = memoryStore(),
    owner = { userId: "UBYTES", teamId: "TBYTES" },
    chunk = "🦊".repeat(600);
  const result = await runFeature(
    notes,
    `add Unicode | ${chunk}`,
    owner,
    "create",
    store,
  );
  const id = result.match(/[a-f0-9]{8}(?= ·)/)![0];
  for (let i = 0; i < 5; i++)
    await runFeature(
      notes,
      `append ${id} | ${chunk}`,
      owner,
      `append${i}`,
      store,
    );
  const before = await runFeature(
    notes,
    `export ${id}`,
    owner,
    undefined,
    store,
  );
  assert.match(
    await runFeature(
      notes,
      `append ${id} | ${chunk}`,
      owner,
      "too-large",
      store,
    ),
    /16 KB/,
  );
  assert.equal(
    await runFeature(notes, `export ${id}`, owner, undefined, store),
    before,
  );
});
