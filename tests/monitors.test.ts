import assert from "node:assert/strict";
import test from "node:test";
import { __testing, type MonitorToolInput } from "../lib/monitors.js";

test("parses interval monitor commands", () => {
  const parsed = __testing.parseMonitorCommandText(
    'monitor every 10 minutes alert if "deploy failed" appears'
  );

  assert.equal(parsed?.action, "create");
  if (parsed?.action !== "create") {
    assert.fail("expected create command");
  }
  assert.equal(parsed.monitor.kind, "interval");
  assert.equal(parsed.monitor.amount, "10");
  assert.equal(parsed.monitor.unit, "minutes");
  assert.equal(parsed.monitor.query, "deploy failed");
  assert.equal(parsed.monitor.conditionType, "appears");
  assert.equal(parsed.monitor.source, "channel_history");
});

test("parses monitor list and cancel commands", () => {
  assert.deepEqual(__testing.parseMonitorCommandText("list monitors"), { action: "list" });
  assert.deepEqual(__testing.parseMonitorCommandText("monitor cancel abc123"), {
    action: "cancel",
    idPrefix: "abc123"
  });
});

test("monitor input accepts numeric strings and infers source", () => {
  const input: MonitorToolInput = {
    kind: "interval",
    amount: "2",
    unit: "hours",
    query: "OpenAI pricing",
    conditionType: "changes"
  };
  const parsed = __testing.monitorToolInputToParsedMonitor(input);

  assert.equal(parsed.kind, "interval");
  assert.equal(parsed.intervalMs, 2 * 60 * 60 * 1000);
  assert.equal(parsed.source, "web_search");
});

test("channel history appears monitor matches only new messages", () => {
  const result = __testing.evaluateChannelHistoryMonitor(
    {
      query: "deploy failed",
      conditionType: "appears",
      lastCheckedAt: "2026-06-25T12:00:00.000Z"
    },
    [
      {
        ts: "1.000",
        datetime: "2026-06-25T11:59:00.000Z",
        speaker: "User U1",
        text: "deploy failed earlier"
      },
      {
        ts: "2.000",
        datetime: "2026-06-25T12:01:00.000Z",
        speaker: "User U2",
        text: "deploy failed again"
      }
    ]
  );

  assert.equal(result.matched, true);
  assert.match(result.summary, /User U2/);
  assert.match(result.summary, /deploy failed again/);
});

test("monitor alert posting is idempotent by fingerprint", () => {
  const result = {
    matched: true,
    summary: "deploy failed",
    fingerprint: "abc"
  };

  assert.equal(__testing.shouldPostMonitorAlert({ lastAlertFingerprint: undefined }, result), true);
  assert.equal(__testing.shouldPostMonitorAlert({ lastAlertFingerprint: "abc" }, result), false);
});
