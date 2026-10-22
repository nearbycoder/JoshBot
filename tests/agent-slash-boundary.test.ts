import assert from "node:assert/strict";
import test from "node:test";
import { handleSlackSlashCommandPayload } from "../lib/slack-commands.js";
import { handleAgentCommand } from "../lib/agent-features/index.js";
import { stopSlackAgentRuns, withSlackAgentRun } from "../lib/slack-agent-runs.js";
import type { AgentStateBackend } from "../lib/agent-features/store.js";

const target = { teamId: "TBOUNDARY", userId: "UBOUNDARY", channelId: "CBOUNDARY", threadTs: "1.1" };
const payload = { command: "/nobo-help", text: "agent inbox capture Private thought", team_id: target.teamId, user_id: target.userId, channel_id: target.channelId, trigger_id: "boundary-trigger" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

for (const trigger of ["stop", "deadline"] as const) {
  test(`${trigger} interrupts the initial policy read without starting a personal feature`, { timeout: 2_000 }, async (t) => {
    const policy = deferred<{ allowed: boolean }>();
    const entered = deferred<void>();
    let features = 0, deadlines = 0;
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
      assert.equal(milliseconds, 120_000);
      deadlines++;
      return timeout(trigger === "deadline" ? 25 : milliseconds);
    });
    const watchdog = setTimeout(() => policy.reject(new Error("Policy test hung")), 1_000);
    try {
      const pending = withSlackAgentRun(target, () => handleSlackSlashCommandPayload(payload, {
        evaluateAccess: () => { entered.resolve(); return policy.promise; },
        handleAgentCommand: async () => { features++; return "Unexpected work"; },
      }));
      const rejected = assert.rejects(pending, trigger === "stop" ? /abort/i : /timeout/i);
      await entered.promise;
      assert.equal(deadlines, 1, "the deadline must already exist during access evaluation");
      if (trigger === "stop") assert.equal(await stopSlackAgentRuns(target), 1);
      await rejected;
      policy.resolve({ allowed: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(features, 0, "a late policy grant cannot run the feature");
    } finally { clearTimeout(watchdog); policy.resolve({ allowed: false }); }
  });
}

test("policy and production startup share the original deadline without renewing its budget", { timeout: 2_000 }, async (t) => {
  const deadline = new AbortController();
  const policy = deferred<{ allowed: boolean }>();
  const connection = deferred<AgentStateBackend | null>();
  const enteredPolicy = deferred<void>(), enteredBackend = deferred<void>();
  let deadlineCalls = 0, preferenceReads = 0, writes = 0;
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 120_000);
    deadlineCalls++;
    return deadline.signal;
  });
  const pending = handleSlackSlashCommandPayload(payload, {
    evaluateAccess: () => { enteredPolicy.resolve(); return policy.promise; },
    handleAgentCommand: (text, owner, options, startup) => {
      assert.equal(startup?.timeoutSignal?.(120_000), deadline.signal);
      return handleAgentCommand(text, owner, options, {
        ...startup,
        createBackend: () => { enteredBackend.resolve(); return connection.promise; },
        preferences: async () => { preferenceReads++; throw new Error("Unexpected preference read"); },
      });
    },
  });
  const rejected = assert.rejects(pending, /deadline expired/);
  await enteredPolicy.promise;
  policy.resolve({ allowed: true });
  await enteredBackend.promise;
  deadline.abort(new DOMException("Original deadline expired", "TimeoutError"));
  await rejected;
  connection.resolve({ get: async () => null, compareSet: async () => { writes++; return true; } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(deadlineCalls, 1);
  assert.equal(preferenceReads, 0);
  assert.equal(writes, 0, "late initialization cannot write a request receipt or feature state");
});

test("a denied policy stays private and prevents agent initialization", async () => {
  const result = await handleSlackSlashCommandPayload(payload, {
    evaluateAccess: async () => ({ allowed: false, reason: "Denied" }),
    handleAgentCommand: async () => assert.fail("Denied callers cannot initialize agents"),
  });
  assert.equal(result.response.response_type, "ephemeral");
  assert.match(result.response.text, /access denied/i);
});

test("policy admission holds cancelled raw reads and rejects overload before access or receipts", async (t) => {
  const policies = [deferred<{ allowed: boolean }>(), deferred<{ allowed: boolean }>()];
  const entered = deferred<void>();
  const controllers = [new AbortController(), new AbortController()];
  let deadlines = 0, calls = 0, features = 0;
  t.mock.method(AbortSignal, "timeout", () => controllers[deadlines++]?.signal ?? new AbortController().signal);
  const options = {
    evaluateAccess: () => { const policy = policies[calls++]; if (calls === 2) entered.resolve(); return policy.promise; },
    handleAgentCommand: async () => { features++; return "done"; },
  };
  const pending = [1, 2].map(() => handleSlackSlashCommandPayload(payload, options));
  const rejected = pending.map(p => assert.rejects(p, /abort/i));
  await entered.promise; controllers.forEach(c => c.abort()); await Promise.all(rejected);
  const busy = await handleSlackSlashCommandPayload(payload, options);
  assert.equal(busy.response.response_type, "ephemeral"); assert.match(busy.response.text, /busy/);
  assert.equal(calls, 2); assert.equal(deadlines, 2); assert.equal(features, 0);
  policies.forEach(p => p.resolve({ allowed: true })); await new Promise(resolve => setImmediate(resolve));
  // Resolved policy and the inner agent route reuse this one permit.
  const allowed = await handleSlackSlashCommandPayload(payload, {
    evaluateAccess: async () => ({ allowed: true }), handleAgentCommand: async () => "finished",
  });
  assert.equal(allowed.response.text, "finished");
});
