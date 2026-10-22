import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_BUSY_MESSAGE, agentInvocationSignal, withAgentAdmission } from "../lib/agent-features/admission.js";
import { runAgentFeature } from "../lib/agent-features/runtime.js";
import type { AgentFeature } from "../lib/agent-features/types.js";
import inbox from "../lib/agent-features/inbox.js";
import { createAgentFeatureFixture, deferred } from "./helpers/agent-feature-fixture.js";

test("sequential immediate-backend inbox commands allow a real timer to run before completion", async () => {
  const f = createAgentFeatureFixture(inbox);
  let completed = 0, timerAt = -1;
  const timer = setTimeout(() => { timerAt = completed; }, 0);
  try {
    for (; completed < 40; completed++) assert.match(await f.run(`capture Fairness item ${completed}`), /Captured/);
    assert.ok(timerAt >= 0 && timerAt < 40, `timer observed ${timerAt} completed commands`);
    assert.equal((await f.store().read<{ items: unknown[] }>("state"))!.items.length, 40);
    assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
  } finally { clearTimeout(timer); }
});

for (const phase of ["before", "during"] as const) for (const trigger of ["stop", "deadline"] as const) {
  test(`${trigger} ${phase} the admitted yield prevents backend, receipts, services and feature work`, async t => {
    const f = createAgentFeatureFixture(inbox), deadline = new AbortController(), stop = new AbortController();
    let deadlines = 0, backendLookups = 0;
    t.mock.method(AbortSignal, "timeout", (ms: number) => { deadlines++; assert.equal(ms, 120_000); return deadline.signal; });
    const reason = new Error(`${trigger} original invocation`), controller = trigger === "stop" ? stop : deadline;
    const options = { get backend() { backendLookups++; return f.backend; }, services: f.services, timezone: "UTC", signal: stop.signal };
    let scheduled: NodeJS.Immediate | undefined;
    try {
      if (phase === "before") controller.abort(reason);
      else scheduled = setImmediate(() => controller.abort(reason));
      const pending = withAgentAdmission(f.owner, async () => {
        agentInvocationSignal(stop.signal); // Existing policy/startup scope owns the deadline.
        return runAgentFeature(inbox, "capture Must not start", { ...f.owner, requestId: "yield-retry" }, options);
      }, () => AGENT_BUSY_MESSAGE);
      await assert.rejects(pending, error => error === reason);
      assert.equal(deadlines, 1, "runtime must inherit the original deadline");
      assert.equal(backendLookups, 0);
      assert.equal(f.backend.data.size, 0);
      assert.deepEqual(f.backend.calls, { gets: 0, compareSets: 0, writes: 0, conflicts: 0 });
      assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
    } finally { if (scheduled) clearImmediate(scheduled); t.mock.restoreAll(); }
    assert.match(await f.run("capture Retry after yield cancellation", { requestId: "yield-retry" }), /Captured/, "no poisoned receipt or hanging permit");
  });
}

test("admitted yield has no queue, retains 3/2 limits and cancelled physical work until settlement", async () => {
  const gates = Array.from({ length: 3 }, () => deferred<string>()), entered = deferred<void>();
  let calls = 0;
  const feature: AgentFeature = { id: "fairness-pending", title: "Fairness", description: "Test", help: "Help",
    async execute(command, ctx) { if (command === "quick") return "complete"; return ctx.services.generate({ instructions: "fake", input: command }); },
  };
  const f = createAgentFeatureFixture(feature, { services: { generate: async ({ input }) => { if (++calls === 3) entered.resolve(); return gates[Number(input)].promise; } } });
  const controllers = [new AbortController(), new AbortController()];
  const running = [f.run("0", { signal: controllers[0].signal }), f.run("1", { signal: controllers[1].signal }), f.run("2", { owner: { userId: "UOTHER" } })];
  const settled = Promise.allSettled(running);
  try {
    assert.equal(calls, 0, "admission must precede the yield and feature startup must follow it");
    for (let i = 0; i < 32; i++) assert.equal(await f.run("quick", { owner: { userId: i % 2 ? "UFIXTURE" : "UTHIRD" }, requestId: `busy-${i}` }), AGENT_BUSY_MESSAGE);
    await entered.promise;
    controllers.forEach(controller => controller.abort());
    await Promise.all(running.slice(0, 2).map(pending => assert.rejects(pending, /abort/i)));
    assert.equal(await f.run("quick"), AGENT_BUSY_MESSAGE);
    gates[2].resolve("other complete"); assert.equal(await running[2], "other complete");
    assert.equal(await f.run("quick", { owner: { userId: "UTHIRD" } }), "complete", "third global slot remains available for another owner");
    for (let i = 0; i < 16; i++) assert.equal(await f.run("quick", { requestId: `busy-${i}` }), AGENT_BUSY_MESSAGE);
    assert.equal(f.backend.calls.compareSets, 0, "busy attempts must not claim receipts");
    gates[0].resolve("late one");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await f.run("quick", { requestId: "busy-0" }), "complete", "settlement releases exactly one owner slot");
    gates[1].reject(new Error("late physical failure"));
    await settled;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await f.run("quick", { requestId: "busy-1" }), "complete");
    assert.equal(calls, 3, "busy retries start no queued generation work");
  } finally { gates.forEach(gate => gate.resolve("cleanup")); controllers.forEach(controller => controller.abort()); await settled; }
});

test("help bypasses the admitted yield, backend and deadline", async t => {
  const f = createAgentFeatureFixture(inbox);
  t.mock.method(AbortSignal, "timeout", () => { throw new Error("Help created a deadline"); });
  assert.equal(await f.run("help"), inbox.help);
  assert.equal(f.backend.data.size, 0);
  assert.deepEqual(f.calls, { generate: 0, search: 0, readContext: 0 });
});
