import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, readFile, readlink, realpath, symlink, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";

// The CLI is an import-safe JS harness, not a second implementation of the app.
const harness = await import(pathToFileURL(resolve("scripts/bench-agent-release.mjs")).href);

test("positive workload oracles reject unknown, failed and incomplete commands", () => {
  for (const reply of ["Unknown personal agent", "Recall cancelled.", "Your personal context could not be read.", "No matching personal sources", "Personal recall results for: Atlas\nShowing 10 of 599 lexical matches"])
    assert.throws(() => harness.classifyBaseline("recall search Atlas --limit 10", reply));
  assert.throws(() => harness.classifyBaseline("inbox list", "Private inbox: 0 unprocessed, 0 processed (0/100 retained)."));
  assert.throws(() => harness.classifyBaseline("inbox capture fixture", "Inbox storage is full"));
  assert.throws(() => harness.classifyBaseline("not-an-oracle", "done"));
  assert.equal(harness.classifyBaseline("inbox list", "Personal agents are busy. This command has not started or saved anything. Please retry shortly."), "busy");
});

test("external transports and Unix sockets are blocked even with loopback enabled", async () => {
  const fetch = globalThis.fetch, connect = net.Socket.prototype.connect;
  const guard = harness.installNetworkGuard({ loopback: true });
  try {
    assert.throws(() => globalThis.fetch("https://example.invalid/"), /forbids fetch/);
    assert.throws(() => globalThis.fetch("http://127.0.0.1.example.invalid/"), /forbids fetch/);
    assert.throws(() => net.connect({ host: "203.0.113.1", port: 80 }), /forbids socket/);
    assert.throws(() => net.connect({ path: "/tmp/not-an-owned-socket" }), /forbids socket/);
    assert.throws(() => tls.connect({ host: "127.0.0.1", port: 443 }), /forbids TLS/);
    assert.throws(() => dns.lookup("example.invalid", () => {}), /forbids DNS/);
    assert.throws(() => dns.promises.resolve4("example.invalid"), /forbids DNS/);
    assert.throws(() => dgram.createSocket("udp4"), /forbids UDP/);
    assert.equal(guard.blocked.length, 8);
    const server = net.createServer(socket => socket.end("owned"));
    try {
      await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
      const address = server.address(); assert.ok(address && typeof address !== "string");
      const result = await new Promise<string>((yes, no) => {
        let body = ""; const socket = net.connect({ host: "127.0.0.1", port: address.port });
        socket.on("data", chunk => { body += chunk; }); socket.once("end", () => yes(body)); socket.once("error", no);
      });
      assert.equal(result, "owned");
    } finally { await new Promise<void>(r => server.close(() => r())); }
  } finally { guard.restore(); }
  assert.equal(globalThis.fetch, fetch); assert.equal(net.Socket.prototype.connect, connect);
});

test("worker environment excludes inherited credentials, loaders, and proxies", () => {
  const environment = harness.cleanEnvironment("/tmp/owned-release-home");
  assert.deepEqual(Object.keys(environment).sort(), ["HOME", "NODE_ENV", "NOBO_AGENT_MAX_INFLIGHT", "NOBO_AGENT_MAX_PER_USER", "PATH", "TMPDIR", "TZ"].sort());
  assert.equal(environment.HOME, "/tmp/owned-release-home");
  assert.equal(environment.NOBO_AGENT_MAX_INFLIGHT, "3"); assert.equal(environment.NOBO_AGENT_MAX_PER_USER, "2");
});

test("append-only history keeps failed samples, profiles and earlier text intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-history-test-")), file = join(directory, "results.json");
  try {
    await harness.appendHistory(file, { type: "sample", status: "error", error: "first failure", eventLoopMaxMs: 188 });
    const first = await readFile(file, "utf8");
    await harness.appendHistory(file, { type: "profile", path: "diagnostic-only" });
    await harness.appendHistory(file, { type: "sample", status: "complete", eventLoopMaxMs: 95 });
    const text = await readFile(file, "utf8"), events = JSON.parse(text);
    assert.ok(text.startsWith(first.slice(0, first.lastIndexOf("]")).trimEnd()));
    assert.deepEqual(events.map((x: { type: string }) => x.type), ["sample", "profile", "sample"]);
    assert.equal(events[0].error, "first failure"); assert.equal(events[0].eventLoopMaxMs, 188);
    assert.equal(harness.releaseGate(events).passed, false);
    assert.ok(!existsSync(`${file}.lock`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing workers, worker errors and timeouts cannot pass and children exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-worker-test-"));
  try {
    const file = join(directory, "worker.mjs");
    await writeFile(file, "setInterval(() => {}, 1000);\n");
    const hung = await harness.spawnWorker(file, [], { cwd: directory, timeoutMs: 100 });
    assert.equal(hung.status, "error"); assert.equal(hung.timedOut, true);
    assert.throws(() => process.kill(hung.pid, 0), /ESRCH/);
    await writeFile(file, "process.send({error:'synthetic failing worker'});process.exitCode=1;\n");
    const failed = await harness.spawnWorker(file, [], { cwd: directory });
    assert.equal(failed.status, "error"); assert.equal(failed.error, "synthetic failing worker");
    const missing = await harness.spawnWorker(join(directory, "missing.mjs"), [], { cwd: directory });
    assert.equal(missing.status, "error"); assert.match(missing.stderr, /MODULE_NOT_FOUND/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("gates fail on a worst sample, missing counts, profiles, and nonfinite metrics", async () => {
  // Use the retained REAL preparatory runtime output as the successful-count
  // fixture, not a synthetic implementation-shaped benchmark response.
  const history = JSON.parse(await readFile(resolve("scripts/bench-agent-release.results.json"), "utf8"));
  const runtime = history.find((e: { type: string; mode: string; status: string }) => e.type === "sample" && e.mode === "runtime" && e.status === "complete");
  assert.ok(runtime, "Preparation must retain a real completed baseline sample");
  assert.deepEqual(harness.sampleFailures(runtime, { timings: false }), []);
  for (const mutation of [
    { status: "error", error: "late failure" }, { status: "pending" }, { profile: "cpu.cpuprofile" },
    { cpuMs: NaN }, { peakRssMiB: Infinity }, { networkBlocked: 1 },
    { overload: { ...runtime.overload, accepted: 8, rejected: 88 } },
    { mixed: { ...runtime.mixed, deterministicAccepted: 44 } },
  ]) assert.ok(harness.sampleFailures({ ...runtime, ...mutation }, { timings: false }).length);
  for (const mutation of [{ eventLoopMaxMs: 150.001 }, { peakRssMiB: 256.001 }, { deterministic: { ...runtime.deterministic, p95Ms: 50.001 } }, { overload: { ...runtime.overload, p95Ms: 250.001 } }])
    assert.ok(harness.sampleFailures({ ...runtime, ...mutation }).length);
  assert.equal(harness.releaseGate([{ type: "sample", ...runtime }]).passed, false, "one sample cannot be final approval");
  const feature = history.find((e: { mode: string; status: string }) => e.mode === "meeting-prep" && e.status === "complete");
  assert.ok(harness.sampleFailures({ ...feature, active: { eventLoopMaxMs: 150.001 } }).includes("Active feature event loop exceeds 150 ms"));
});

test("release builds use checkout dependencies by default and retain explicit overrides without a home fallback", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "release-checkout-test-"));
  const checkout = join(directory, "checkout"), dependencies = await realpath(resolve("node_modules"));
  try {
    execFileSync("git", ["clone", "--local", "--shared", "--quiet", process.cwd(), checkout]);
    // Exercise this working-tree harness even before its fix is committed.
    await copyFile(resolve("scripts/bench-agent-release.mjs"), join(checkout, "scripts/bench-agent-release.mjs"));
    const checkoutDependencies = join(checkout, "node_modules");
    await symlink(dependencies, checkoutDependencies, "dir");
    const build = await harness.prepareBuild(checkout);
    try {
      assert.equal(await readlink(join(build.directory, "node_modules")), checkoutDependencies);
      assert.equal(build.build.status, "complete");
      t.diagnostic(`Default dependency link uses the supplied temporary checkout: ${checkoutDependencies}`);
    } finally { await build.cleanup(); }
    assert.equal(existsSync(build.directory), false);

    await rm(checkoutDependencies);
    await assert.rejects(() => harness.prepareBuild(checkout), /Cannot find package 'vite'/,
      "Missing checkout dependencies must fail rather than fall back to an author's home");
    const overridden = await harness.prepareBuild(checkout, dependencies);
    try {
      assert.equal(await readlink(join(overridden.directory, "node_modules")), dependencies);
      assert.equal(overridden.build.status, "complete");
    } finally { await overridden.cleanup(); }
    assert.equal(existsSync(overridden.directory), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("production Vite entrypoints verify catalog parity, real policy siblings and full CSV retrieval", { timeout: 60000 }, async t => {
  const build = await harness.prepareBuild(process.cwd());
  try {
    for (const mode of ["parity", "catalog", "adapter-six", "capacity", "policy", "csv"]) {
      const sample = await harness.runSample(build, mode);
      assert.equal(sample.status, "complete", JSON.stringify(sample));
      if (mode === "parity") { assert.equal(sample.registered, 70); assert.equal(sample.additions, 50); }
      else assert.deepEqual(harness.sampleFailures(sample, { timings: false }), [], JSON.stringify(sample));
      if (mode === "adapter-six") { assert.equal(sample.items, 1500); assert.equal(sample.batches.length, 6); assert.equal(sample.counts.get, 807); assert.equal(sample.counts.eval, 4); }
      if (mode === "capacity") { assert.ok(sample.totalBytes > 32 * 1048576); assert.equal(sample.capacityRejected, 1); assert.equal(sample.counts.writes, 0); assert.equal(sample.counts.generate, 0); }
      t.diagnostic(JSON.stringify({ mode, status: sample.status, registered: sample.registered, cycles: sample.cycles, totalCalls: sample.totalCalls, pages: sample.pages, scope: "correctness only; no performance gate" }));
    }
  } finally { await build.cleanup(); }
  assert.equal(existsSync(build.directory), false, "Temporary sources, bundles and dependency symlink removed");
});
