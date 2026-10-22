import assert from "node:assert/strict";
import test from "node:test";
import { handleAgentCommand, type AgentStartupDependencies } from "../lib/agent-features/index.js";
import type { AgentStateBackend } from "../lib/agent-features/store.js";
import type { AgentFeatureServices } from "../lib/agent-features/types.js";
import { DEFAULT_USER_PREFERENCES } from "../lib/preferences.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("cold injected runtime omits Redis; the default backend still loads it on demand", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-store-import-"));
  try {
    const output = execFileSync(process.execPath, ["--max-old-space-size=512", "--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { installNetworkGuard } from './scripts/bench-agent-release.mjs';
      const guard = installNetworkGuard(), loaded = new Set();
      registerHooks({ load(url, context, next) { loaded.add(url); return next(url, context); } });
      const { handleAgentCommand } = await import('./lib/agent-features/index.ts');
      const data = new Map();
      const backend = { get: async key => data.get(key) ?? null, compareSet: async (key, old, next) => {
        if ((data.get(key) ?? null) !== old) return false; data.set(key, next); return true;
      } };
      const forbidden = async () => { throw new Error('Unexpected service'); };
      const owner = { teamId: 'TCOLD', userId: 'UCOLD' };
      assert.match(await handleAgentCommand('inbox capture Offline import proof', owner, {
        backend, timezone: 'UTC', services: { generate: forbidden, search: forbidden, readContext: forbidden },
      }), /Captured/);
      assert.equal(data.size, 1);
      assert.ok([...loaded].some(url => /agent-features\\/store\\.[jt]s/.test(url)), 'trace must observe store');
      const redisLoads = () => [...loaded].filter(url => /\\/lib\\/redis\\.[jt]s|node_modules\\/(?:@redis|redis)\\//.test(url));
      const stop = new AbortController();
      const abort = setImmediate(() => stop.abort(new Error('Cancel before default backend')));
      try {
        await assert.rejects(handleAgentCommand('inbox capture Cancelled default backend', owner, {
          timezone: 'UTC', signal: stop.signal,
          services: { generate: forbidden, search: forbidden, readContext: forbidden },
        }), /Cancel before default backend/);
      } finally { clearImmediate(abort); }
      assert.deepEqual(redisLoads(), [], 'injected runtime must not initialize the Redis dependency graph');
      const { createAgentStateBackend, validateAgentIdentity } = await import('./lib/agent-features/store.ts');
      validateAgentIdentity(owner);
      assert.equal(await createAgentStateBackend(), null, 'unconfigured default backend retains null result');
      assert.ok(redisLoads().length > 0, 'default backend must load the actual Redis module');
      process.env.REDIS_URL = 'invalid-url';
      await assert.rejects(createAgentStateBackend(), /Invalid URL/);
      assert.deepEqual(guard.blocked, []); guard.restore();
      console.log('cold-store-proof');
    `], { encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, NODE_ENV: "test" } });
    assert.match(output, /cold-store-proof/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

const owner = { teamId: "TSTARTUP", userId: "USTARTUP", channelId: "CSTARTUP", requestId: "startup-request" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function fixture() {
  const data = new Map<string, string>();
  const calls = { backend: 0, preferences: 0, load: 0, factory: 0, reads: 0, writes: 0 };
  const backend: AgentStateBackend = {
    get: async key => { calls.reads++; return data.get(key) ?? null; },
    compareSet: async (key, previous, next) => { calls.writes++; if ((data.get(key) ?? null) !== previous) return false; data.set(key, next); return true; },
  };
  const services: AgentFeatureServices = {
    readContext: async () => { throw new Error("Unexpected context read"); },
    generate: async () => { throw new Error("Unexpected model"); },
    search: async () => { throw new Error("Unexpected search"); },
  };
  const preferences = { ...DEFAULT_USER_PREFERENCES, timeZone: "Pacific/Auckland" };
  const controller = new AbortController();
  const module = { createAgentFeatureServices: (() => { calls.factory++; return services; }) as Awaited<ReturnType<AgentStartupDependencies["loadServices"]>>["createAgentFeatureServices"] };
  const dependencies: AgentStartupDependencies = {
    createBackend: async () => { calls.backend++; return backend; },
    preferences: async userId => { assert.equal(userId, owner.userId); calls.preferences++; return preferences; },
    getRunSignal: () => controller.signal,
    timeoutSignal: ms => { assert.equal(ms, 120_000); return AbortSignal.timeout(ms); },
    loadServices: async () => { calls.load++; return module; },
  };
  return { data, calls, backend, services, preferences, controller, module, dependencies };
}

for (const stage of ["backend", "preferences", "load"] as const) {
  for (const trigger of ["abort", "deadline"] as const) {
    test(`${trigger} while startup ${stage} is pending stops promptly and late completion cannot execute or write`, async () => {
      const f = fixture(), entered = deferred<void>();
      const gate = deferred<unknown>();
      if (stage === "backend") f.dependencies.createBackend = async () => { f.calls.backend++; entered.resolve(); await gate.promise; return f.backend; };
      if (stage === "preferences") f.dependencies.preferences = async () => { f.calls.preferences++; entered.resolve(); await gate.promise; return f.preferences; };
      if (stage === "load") f.dependencies.loadServices = async () => { f.calls.load++; entered.resolve(); await gate.promise; return f.module; };
      if (trigger === "deadline") f.dependencies.timeoutSignal = ms => { assert.equal(ms, 120_000); return AbortSignal.timeout(20); };
      const result = handleAgentCommand("inbox capture Never save this late", owner, undefined, f.dependencies);
      // Keep the loop alive while the native deadline's unref'ed timer fires.
      const watchdog = setTimeout(() => gate.reject(new Error("Test exceeded startup deadline")), 1000);
      try {
        const rejection = assert.rejects(result, error => error instanceof Error &&
          (trigger === "deadline" ? error.name === "TimeoutError" : error.message === "Cancel startup"));
        await entered.promise;
        if (trigger === "abort") f.controller.abort(new Error("Cancel startup"));
        await rejection;
        const stopped = { ...f.calls };
        gate.resolve(undefined);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(f.calls, stopped, "late initialization must not start the next step");
        assert.equal(f.calls.factory, 0); assert.equal(f.calls.reads, 0); assert.equal(f.calls.writes, 0);
        assert.equal(f.data.size, 0, "no request receipt or feature state may be written");
      } finally { clearTimeout(watchdog); }
    });
  }
}

test("an already aborted startup does not initialize a backend or preferences", async () => {
  const f = fixture(); f.controller.abort(new Error("Already stopped"));
  await assert.rejects(() => handleAgentCommand("inbox capture test", owner, undefined, f.dependencies), /Already stopped/);
  assert.deepEqual(f.calls, { backend: 0, preferences: 0, load: 0, factory: 0, reads: 0, writes: 0 });
});

test("late setup rejection is consumed after cancellation without starting feature work", async () => {
  const f = fixture(), entered = deferred<void>(), gate = deferred<AgentStateBackend | null>();
  f.dependencies.createBackend = () => { entered.resolve(); return gate.promise; };
  const result = handleAgentCommand("inbox capture test", owner, undefined, f.dependencies);
  await entered.promise; f.controller.abort(new Error("Stop"));
  await assert.rejects(result, /Stop/);
  gate.reject(new Error("Late Redis connection failure"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.preferences, 0); assert.equal(f.calls.writes, 0);
});

test("startup shares one resolved caller timezone, request clock and combined signal with services and runtime", async () => {
  const f = fixture();
  let clock: Date | undefined, signal: AbortSignal | undefined;
  const before = Date.now();
  f.dependencies.loadServices = async () => ({
    createAgentFeatureServices: (backend, caller, combined, request) => {
      assert.equal(backend, f.backend); assert.deepEqual(caller, owner);
      assert.equal(request.timezone, "Pacific/Auckland"); assert.equal(request.featureId, "inbox");
      assert.ok(request.now.getTime() >= before && request.now.getTime() <= Date.now());
      clock = request.now; signal = combined; return f.services;
    },
  });
  assert.match(await handleAgentCommand("inbox capture Same request time", owner, undefined, f.dependencies), /Captured/);
  assert.ok(clock); assert.ok(signal); assert.equal(f.calls.preferences, 1);
  const inbox = JSON.parse(f.data.get(`nobo:agents:v1:${owner.teamId}:${owner.userId}:inbox:state`)!);
  assert.equal(inbox.items[0].createdAt, clock.toISOString());
  f.controller.abort(new Error("Caller stopped")); assert.equal(signal.aborted, true);
});

test("help bypasses startup and missing backend remains a clear unavailable response", async () => {
  const f = fixture();
  assert.match(await handleAgentCommand("inbox help", owner, undefined, f.dependencies), /capture/);
  assert.equal(f.calls.backend, 0);
  f.dependencies.createBackend = async () => null;
  assert.match(await handleAgentCommand("inbox list", owner, undefined, f.dependencies), /Redis connection/);
  assert.equal(f.calls.preferences, 0); assert.equal(f.calls.writes, 0);
});
