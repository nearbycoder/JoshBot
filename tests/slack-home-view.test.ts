import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@slack/bolt";
import {
  buildSlackAppHomeView,
  buildSlackHomeDetailsView,
  homeTimestamp,
  type SlackHomeDashboardData,
} from "../lib/slack-home-view.js";
import {
  registerSlackHomeActions,
  resolveHomeDestination,
} from "../src/slack-home-actions.js";
import { __testing as monitorTesting } from "../lib/monitors.js";
import type { getRedisClient } from "../lib/redis.js";
import { SchedulerRedis } from "./helpers/scheduler-redis.js";

const empty = (): SlackHomeDashboardData => ({
  userId: "U1",
  schedules: [],
  monitors: [],
  artifacts: [],
  memories: [],
  channelStatuses: [],
  preferences: {
    timeZone: "America/Los_Angeles",
    verbosity: "concise",
    newsInterests: [],
    reminderStyle: "gentle",
  },
  updatedAt: new Date("2026-09-07T16:00:00Z"),
});

test("Home puts two clear primary actions first and avoids the command wall", () => {
  const view = buildSlackAppHomeView(empty()),
    json = JSON.stringify(view);
  const actions = view.blocks.filter((b) => b.type === "actions") as {
    elements: { text?: { text: string }; style?: string }[];
  }[];
  assert.equal(actions.length, 2);
  assert.equal(actions[0].elements.length, 2);
  assert.equal(actions[0].elements[0].text?.text, "Open toolbox");
  assert.equal(actions[0].elements[0].style, "primary");
  assert.equal(actions[0].elements[1].text?.text, "New reminder");
  assert.match(json, /Nothing scheduled yet|saved work will appear/);
  assert.doesNotMatch(
    json,
    /Quick Actions|Dashboard|Watching for you|\/nobo-polls|abcdef/,
  );
  assert.ok(view.blocks.length <= 15);
});

test("Home bounds previews, sorts upcoming and recent work, and preserves source data", () => {
  const data = empty();
  data.schedules = [5, 3, 1, 4, 2].map((n) => ({
    id: `reminder${n}`,
    summary: `Reminder ${n} ` + "x".repeat(5000),
    nextRunAt: `2026-09-0${n + 1}T18:00:00Z`,
  }));
  data.monitors = [1, 2, 3, 4, 5].map((n) => ({
    id: `monitor${n}`,
    summary: `Monitor ${n}`,
    nextRunAt: "2026-09-08T18:00:00Z",
  }));
  data.artifacts = [1, 2, 3, 4, 5].map((n) => ({
    title: `Document ${n}`,
    kind: "markdown",
    previewUrl: `https://example.com/${n}`,
    updatedAt: `2026-09-0${n}T18:00:00Z`,
  })) as SlackHomeDashboardData["artifacts"];
  const before = JSON.stringify(data),
    view = buildSlackAppHomeView(data),
    json = JSON.stringify(view);
  assert.equal(JSON.stringify(data), before);
  assert.ok(json.indexOf("Reminder 1") < json.indexOf("Reminder 2"));
  assert.doesNotMatch(
    json,
    /Reminder 4|Reminder 5|Monitor 3|Document 1|Document 2/,
  );
  assert.ok(json.indexOf("Document 5") < json.indexOf("Document 4"));
  assert.ok(view.blocks.length < 30);
  for (const block of view.blocks) {
    if (block.type === "section")
      assert.ok((block.text as { text: string }).text.length <= 3000);
    if (block.type === "actions")
      assert.ok((block.elements as unknown[]).length <= 3);
  }
});

test("Home uses saved timezone including DST and tolerates stale invalid dates", () => {
  assert.match(
    homeTimestamp("2026-09-07T16:00:00Z", "America/Los_Angeles"),
    /9:00 AM/,
  );
  assert.match(
    homeTimestamp("2026-01-07T16:00:00Z", "America/Los_Angeles"),
    /8:00 AM/,
  );
  assert.match(homeTimestamp("2026-09-07T16:00:00Z", "invalid"), /4:00 PM/);
  assert.equal(homeTimestamp("invalid", "UTC"), "Time unavailable");
  assert.match(
    JSON.stringify(buildSlackAppHomeView(empty())),
    /America\/Los_Angeles/,
  );
});
test("unavailable Home data is not presented as a genuinely empty account", () => {
  const data = empty();
  data.unavailable = ["schedules", "artifacts", "monitors", "memories"];
  const rendered = JSON.stringify(buildSlackAppHomeView(data));
  assert.match(rendered, /Reminders couldn’t be loaded/);
  assert.match(rendered, /Documents couldn’t be loaded/);
  assert.doesNotMatch(rendered, /Nothing scheduled yet|saved work will appear/);
  assert.match(
    JSON.stringify(buildSlackHomeDetailsView(data, "memory")),
    /couldn’t be loaded/,
  );
  assert.doesNotMatch(
    JSON.stringify(buildSlackHomeDetailsView(data, "memory")),
    /No personal memories/,
  );
});

test("secondary information and commands remain accessible in focused detail modals", () => {
  const data = empty();
  data.memories = ["Private preference <@UOTHER>"];
  data.channelStatuses = [
    {
      channelId: "C123",
      activeListening: true,
      memoryCount: 4,
      modelId: "deepseek-v4-pro",
      modelSource: "channel",
    },
  ];
  const memory = buildSlackHomeDetailsView(data, "memory");
  assert.equal((memory.blocks[1].text as { type: string }).type, "plain_text");
  assert.equal((memory.blocks[1].accessory as { action_id?: string }).action_id, "nobo_home_forget_memory");
  assert.match(JSON.stringify(memory), /Private preference/);
  assert.match(
    JSON.stringify(buildSlackHomeDetailsView(data, "channels")),
    /deepseek-v4-pro.*channel override/,
  );
  data.monitors = [{ id: "mon123456789", summary: "Alert on deploy failed", nextRunAt: "2026-09-08T18:00:00Z" }];
  const monitors = buildSlackHomeDetailsView(data, "monitors");
  assert.equal((monitors.blocks[1].accessory as { action_id?: string }).action_id, "nobo_home_cancel_monitor");
  const help = JSON.stringify(buildSlackHomeDetailsView(data, "help"));
  for (const command of [
    "summarize-thread",
    "meeting-notes artifact",
    "/nobo-polls",
    "/nobo-channel-digest",
    "/nobo-search",
  ])
    assert.ok(help.includes(command));
  assert.doesNotMatch(
    JSON.stringify(buildSlackAppHomeView(data)),
    /Private preference|deepseek-v4-pro/,
  );
});

test("document previews reject unsafe URLs and cannot create injected Slack mentions", () => {
  const data = empty();
  data.artifacts = [
    {
      title: "<@UOTHER>|bad",
      kind: "html",
      previewUrl: "javascript:alert(1)",
      updatedAt: "invalid",
    },
  ] as SlackHomeDashboardData["artifacts"];
  const json = JSON.stringify(buildSlackAppHomeView(data));
  assert.doesNotMatch(json, /javascript:|<@UOTHER>/);
  assert.match(json, /&lt;@UOTHER&gt;¦bad/);
});

test("Home buttons and legacy menu route correctly; refresh stays private and skips modals", async () => {
  assert.equal(
    resolveHomeDestination({
      action_id: "nobo_home_open_toolbox",
      value: "toolbox",
    }),
    "toolbox",
  );
  assert.equal(
    resolveHomeDestination({
      action_id: "nobo_home_tools",
      selected_option: { value: "models" },
    }),
    "models",
  );
  assert.equal(
    resolveHomeDestination({ action_id: "nobo_home_cancel", value: "id" }),
    undefined,
  );
  let actionHandler: (args: any) => Promise<void> = async () => {};
  const calls: string[] = [];
  let allowed = true;
  registerSlackHomeActions(
    {
      action: (_pattern: unknown, handler: typeof actionHandler) =>
        (actionHandler = handler),
      view: () => {},
    } as unknown as App,
    {
      access: (async () => ({ allowed })) as any,
      publish: (async (user: string) => {
        calls.push(`publish:${user}`);
      }) as any,
      details: async (user, kind) => {
        calls.push(`details:${user}:${kind}`);
        return buildSlackHomeDetailsView(empty(), kind);
      },
    },
  );
  const input = {
    ack: async () => {
      calls.push("ack");
    },
    body: { user: { id: "UOWNER" }, team: { id: "T1" }, trigger_id: "trigger" },
    action: { action_id: "nobo_home_refresh" },
    client: {
      views: {
        open: async () => {
          calls.push("open");
          return { view: { id: "V1" } };
        },
        update: async () => {
          calls.push("update");
        },
      },
    },
  };
  await actionHandler(input);
  assert.deepEqual(calls, ["ack", "publish:UOWNER"]);
  calls.length = 0;
  await actionHandler({
    ...input,
    action: { action_id: "nobo_home_open_memory", value: "memory" },
  });
  assert.deepEqual(calls, ["ack", "open", "details:UOWNER:memory", "update"]);
  calls.length = 0;
  allowed = false;
  await actionHandler(input);
  assert.deepEqual(calls, ["ack"]);
});

test("Home monitor cancel action cancels owned monitor and refreshes Home", async (t) => {
  const redis = new SchedulerRedis();
  monitorTesting.setRedisProvider(
    async () => redis as unknown as NonNullable<Awaited<ReturnType<typeof getRedisClient>>>,
  );
  t.after(() => monitorTesting.setRedisProvider());
  const id = "mon123456789";
  await redis.set(
    `monitors:job:${id}`,
    JSON.stringify({
      id,
      ownerUserId: "UOWNER",
      channel: "C123",
      timezone: "America/Chicago",
      createdAt: "2026-11-20T00:00:00.000Z",
      nextRunAt: "2026-11-21T00:00:00.000Z",
      kind: "interval",
      intervalMs: 60_000,
      source: "prompt",
      conditionType: "appears",
      query: "deploy failed",
    }),
  );
  await redis.sAdd("monitors:user:UOWNER", id);
  await redis.zAdd("monitors:due", { value: id, score: Date.now() + 60_000 });

  let actionHandler: (args: any) => Promise<void> = async () => {};
  const updates: unknown[] = [];
  const published: string[] = [];
  registerSlackHomeActions(
    {
      action: (_pattern: unknown, handler: typeof actionHandler) =>
        (actionHandler = handler),
      view: () => {},
    } as unknown as App,
    {
      access: (async () => ({ allowed: true })) as any,
      publish: (async (user: string) => {
        published.push(user);
      }) as any,
      details: async (_user, kind) => buildSlackHomeDetailsView(empty(), kind),
    },
  );

  await actionHandler({
    ack: async () => {},
    body: {
      user: { id: "UOWNER" },
      team: { id: "T1" },
      trigger_id: "trigger",
      view: { type: "modal" },
    },
    action: { action_id: "nobo_home_cancel_monitor", value: id },
    client: {
      views: {
        push: async () => ({ view: { id: "V2" } }),
        update: async (args: unknown) => {
          updates.push(args);
        },
      },
    },
  });

  assert.equal(await redis.get(`monitors:job:${id}`), null);
  assert.deepEqual(published, ["UOWNER"]);
  assert.match(JSON.stringify(updates), /Canceled monitor `mon12345`/);
});
