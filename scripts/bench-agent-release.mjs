#!/usr/bin/env node
/** Offline release verification. No runtime implementation is substituted. */
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, copyFile, symlink, rm, writeFile, readFile, rename, open } from 'node:fs/promises';
import { dirname, resolve, join, relative } from 'node:path';
import { tmpdir, cpus, loadavg, freemem, totalmem } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';

export const SEED = 20261022;
export const START_HEAD = '42013b01e7dcdc44b3e0655d0f36813e8cf93afd';
export const BUDGET = Object.freeze({ runtimeRssMiB: 256, deterministicP95Ms: 50, recallP95Ms: 250, eventLoopMaxMs: 150, contextConcurrency: 3 });
export const MODES = ['catalog', 'runtime', 'server', 'adapter-six', 'meeting-prep', 'morning-brief', 'weekly-review', 'capacity', 'policy', 'csv'];
const HERE = fileURLToPath(import.meta.url);
const NOW = new Date('2026-10-22T12:00:00Z');
const OWNER = { teamId: 'TBENCH', userId: 'UBENCH', channelId: 'CBENCH' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tick = () => new Promise(r => setImmediate(r));
const sha = data => createHash('sha256').update(data).digest('hex');
const round = n => +n.toFixed(3);
const mib = n => n / 1048576;
const cpuMs = start => { const used = process.cpuUsage(start); return (used.user + used.system) / 1000; };
const peakRss = () => process.platform === 'linux'
  ? Number(readFileSync('/proc/self/status', 'utf8').match(/^VmHWM:\s+(\d+)/m)[1]) * 1024
  : process.memoryUsage().rss;
const p95 = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : null;
const fail = message => { throw new Error(message); };
const forbidden = () => fail('No provider/search/context calls allowed in this workload');

export function cleanEnvironment(home) {
  return { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: home,
    NODE_ENV: 'production', TZ: 'UTC', NOBO_AGENT_MAX_INFLIGHT: '3', NOBO_AGENT_MAX_PER_USER: '2' };
}

/** Install before app import. No DNS, UDP, TLS, Unix socket or external TCP escape.
 * Only the server worker may connect/listen on explicitly named loopback IPs. */
export function installNetworkGuard({ loopback = false } = {}) {
  const blocked = [], restores = [];
  const deny = kind => { blocked.push(kind); throw new Error(`Offline benchmark forbids ${kind}`); };
  const patch = (object, name, replacement) => {
    const old = object[name]; object[name] = replacement; restores.push(() => { object[name] = old; }); return old;
  };
  const allowed = host => loopback && ['127.0.0.1', '::1', '[::1]'].includes(host);
  const fetch = globalThis.fetch;
  patch(globalThis, 'fetch', (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'http:' || !allowed(url.hostname)) deny('fetch');
    return fetch(input, options);
  });
  const connect = net.Socket.prototype.connect;
  patch(net.Socket.prototype, 'connect', function (...args) {
    const a = Array.isArray(args[0]) ? args[0] : args;
    const options = typeof a[0] === 'object' ? a[0] : { port: a[0], host: a[1] };
    if (options.path || !options.port || !allowed(options.host)) deny('socket');
    return connect.apply(this, args);
  });
  const listen = net.Server.prototype.listen;
  patch(net.Server.prototype, 'listen', function (...args) {
    const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
    if (options.path || !allowed(options.host)) deny('listen');
    return listen.apply(this, args);
  });
  patch(tls, 'connect', () => deny('TLS'));
  patch(dgram, 'createSocket', () => deny('UDP'));
  for (const object of [dns, dns.promises]) for (const name of Object.keys(object)) {
    if (typeof object[name] === 'function' && /^(lookup|resolve|reverse)/.test(name)) {
      const original = object[name];
      patch(object, name, (...args) => {
        // Node's listen(0, '127.0.0.1') calls lookup even for a literal IP;
        // this path cannot ask an external resolver or resolve an arbitrary name.
        if (name === 'lookup' && allowed(args[0])) return original.apply(object, args);
        return deny('DNS');
      });
    }
  }
  syncBuiltinESMExports();
  return { blocked, restore() { restores.reverse().forEach(f => f()); syncBuiltinESMExports(); } };
}

export function classifyBaseline(command, response) {
  if (response === 'Personal agents are busy. This command has not started or saved anything. Please retry shortly.') return 'busy';
  assert.equal(typeof response, 'string');
  if (command.startsWith('inbox capture ')) assert.match(response, /^Captured inb_[a-f0-9-]{36} — unprocessed\./);
  else if (command === 'inbox list') assert.match(response, /^Private inbox: 40 unprocessed, 0 processed \(40\/100 retained\)\./);
  else if (command === 'recall search Atlas --limit 10') {
    assert.match(response, /^Personal recall results for: Atlas/);
    assert.match(response, /Showing 10 of 600 lexical matches/);
    assert.match(response, /Searched 600 valid source\(s\)/);
  } else fail(`No success oracle for ${command}`);
  return 'complete';
}

export function sampleFailures(sample, { timings = true } = {}) {
  const errors = [];
  const need = (condition, text) => { if (!condition) errors.push(text); };
  need(sample.status === 'complete', `${sample.mode}: ${sample.status ?? 'missing status'} ${sample.error ?? ''}`);
  need(!sample.profile, 'Profile is diagnostic evidence, never a timing gate sample');
  need(sample.networkBlocked === 0, 'Forbidden network attempted');
  if (sample.status !== 'complete') return errors;
  for (const field of ['cpuMs', 'peakRssMiB', 'eventLoopMaxMs']) need(Number.isFinite(sample[field]) && sample[field] >= 0, `Invalid ${field}`);
  if (sample.mode === 'catalog') {
    need(sample.registered === 70 && new Set(sample.ids).size === 70, 'Final catalog must contain 70 distinct registrations');
    need(sample.navigationComplete && sample.helpCount === 70 && sample.forbiddenLoads.length === 0, 'Catalog/help/navigation incomplete or eager services');
  }
  if (sample.mode === 'runtime') {
    const o = sample.overload ?? {}, m = sample.mixed ?? {};
    need(sample.setupCompleted === 40 && sample.deterministic?.count === 100, 'Incomplete inbox setup/cheap commands');
    need(o.offered === 96 && o.accepted === 9 && o.rejected === 87 && o.failed === 0 && o.contextCalls === 9, 'Incorrect recall overload outcomes');
    need(m.offered === 60 && m.accepted === 60 && m.rejected === 0 && m.failed === 0 && m.deterministicAccepted === 45 && m.recallAccepted === 15, 'Incomplete mixed workload');
    need(o.peakContextCalls <= 3, 'Physical context concurrency exceeded');
    if (timings) {
      need(sample.peakRssMiB <= BUDGET.runtimeRssMiB, 'Runtime RSS exceeds 256 MiB');
      need(sample.deterministic?.p95Ms <= BUDGET.deterministicP95Ms && m.deterministicP95Ms <= BUDGET.deterministicP95Ms, 'Deterministic p95 exceeds 50 ms');
      need(o.p95Ms <= BUDGET.recallP95Ms && m.recallP95Ms <= BUDGET.recallP95Ms, 'Accepted recall p95 exceeds 250 ms');
      need(sample.eventLoopMaxMs <= BUDGET.eventLoopMaxMs, 'Runtime event loop exceeds 150 ms');
    }
  }
  if (['adapter-six', 'meeting-prep', 'morning-brief', 'weekly-review', 'capacity', 'csv'].includes(sample.mode) && timings) {
    need(sample.peakRssMiB <= BUDGET.runtimeRssMiB, 'Dedicated feature process RSS exceeds 256 MiB');
    need(sample.active?.eventLoopMaxMs <= BUDGET.eventLoopMaxMs, 'Active feature event loop exceeds 150 ms');
  }
  if (sample.mode === 'policy' && timings) need(sample.active?.eventLoopMaxMs <= BUDGET.eventLoopMaxMs, 'Active policy event loop exceeds 150 ms');
  if (sample.mode === 'server') need(sample.health === 200 && sample.backgroundRunners === false, 'Full-server bootstrap health incomplete');
  if (['adapter-six', 'meeting-prep', 'morning-brief', 'weekly-review', 'capacity'].includes(sample.mode)) {
    need(sample.counts?.logical <= 8 && sample.counts?.peakPhysical === 1 && sample.counts?.generate === 0 && sample.counts?.search === 0, 'Context call bounds violated');
    need(sample.batches?.length === sample.counts?.logical && sample.batches?.every(b => b.bytes <= 16777216 && b.count <= 2000), 'Incomplete context byte/count evidence');
    need(sample.mode === 'capacity' ? sample.totalBytes > 33554432 && sample.capacityRejected === 1 && sample.counts?.writes === 0 : sample.totalBytes < 33554432 && sample.accepted === 1, 'Context outcome or total byte boundary invalid');
  }
  if (sample.mode === 'policy') need(sample.cycles === 6 && sample.totalCalls === 60 && sample.totalSettled === 60 && sample.pendingAtEnd === 0 && sample.maxPending === 10 && sample.startup === 0 && sample.originalDeadlineAcrossPhases, 'Policy work leaked or correctness proof incomplete');
  if (sample.mode === 'csv') need(sample.fullRetrieval && sample.rows === 40 && sample.columns === 8 && sample.completed === sample.offered && sample.stateBytes <= 65536, 'CSV lifecycle incomplete');
  return errors;
}

export function releaseGate(events, { timings = true } = {}) {
  const failures = [];
  for (const mode of MODES) {
    const samples = events.filter(x => x.type === 'sample' && x.mode === mode);
    if (samples.length !== 3) failures.push(`${mode}: expected 3 fresh samples, got ${samples.length}`);
    for (const sample of samples) failures.push(...sampleFailures(sample, { timings }).map(x => `${mode}[${sample.ordinal}]: ${x}`));
  }
  for (const event of events) if (event.type === 'error' || event.type === 'profile') failures.push(`${event.type}: ${event.error ?? 'diagnostic run cannot pass release'}`);
  return { passed: failures.length === 0, failures, budget: BUDGET };
}

/** Preserve the exact text of every existing event, including errors/profiles. */
export async function appendHistory(path, event) {
  await mkdir(dirname(path), { recursive: true });
  const lock = await open(`${path}.lock`, 'wx');
  try {
    const old = existsSync(path) ? await readFile(path, 'utf8') : '[\n]\n';
    const history = JSON.parse(old); assert.ok(Array.isArray(history), 'History must be a JSON array');
    const end = old.lastIndexOf(']');
    const next = `${old.slice(0, end).trimEnd()}${history.length ? ',' : ''}\n${JSON.stringify(event, null, 2)}\n]\n`;
    const temp = `${path}.${process.pid}.tmp`;
    try { await writeFile(temp, next); await rename(temp, path); } finally { await rm(temp, { force: true }); }
  } finally { await lock.close(); await rm(`${path}.lock`, { force: true }); }
}

function sourceSnapshot(root) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
    .filter(x => /^(lib\/|src\/|server\.ts$|vite\.config\.ts$|package(?:-lock)?\.json$|scripts\/bench-agent-(features|release)\.mjs$)/.test(x));
  if (!files.includes('scripts/bench-agent-release.mjs')) files.push('scripts/bench-agent-release.mjs');
  files.sort();
  const hashes = Object.fromEntries(files.map(file => [file, sha(readFileSync(join(root, file)))]));
  return { files: hashes, sha256: sha(JSON.stringify(hashes)),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    status: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    historicalResultsSha256: sha(readFileSync(join(root, 'scripts/bench-agent-features.results.json'))) };
}

export async function spawnWorker(script, args, { cwd, home, timeoutMs = 45000, heapMiB = 1024, baseline = false, profile = false } = {}) {
  return new Promise(resolveResult => {
    const child = fork(script, args, { cwd, execArgv: ['--expose-gc', `--max-old-space-size=${heapMiB}`, ...(baseline ? ['--import', join(cwd, 'scripts/bench-agent-release.mjs')] : []),
      ...(profile ? ['--cpu-prof', `--cpu-prof-dir=${home}`, '--cpu-prof-name=release.cpuprofile'] : [])],
      env: { ...cleanEnvironment(home ?? cwd ?? tmpdir()), ...(baseline ? { RELEASE_BASELINE_PRELOAD: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let result, error, stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', b => { stdout = (stdout + b).slice(-32000); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-32000); });
    child.on('message', message => { if (message.result) result = message.result; if (message.error) error = message.error; });
    const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', e => { error = String(e.stack); });
    child.on('close', (code, signal) => {
      clearTimeout(deadline);
      resolveResult({ ...(result ?? {}), status: code === 0 && result && !timedOut && !error ? result.status ?? 'complete' : 'error',
        ...(error || timedOut || code !== 0 || !result ? { error: error ?? (timedOut ? 'Worker exceeded bounded deadline' : `Worker exited ${code}/${signal} without complete result`) } : {}),
        exitCode: code, signal, timedOut, stdout, stderr, pid: child.pid });
    });
  });
}

export async function prepareBuild(root, dependencies = '/home/nearby/Sites/JoshBot/node_modules') {
  assert.equal(process.versions.node.split('.')[0], '24', 'Use Node 24');
  const directory = await mkdtemp(join(tmpdir(), 'joshbot-release-'));
  try {
    const source = sourceSnapshot(root);
    for (const file of Object.keys(source.files)) { await mkdir(dirname(join(directory, file)), { recursive: true }); await copyFile(join(root, file), join(directory, file)); }
    await mkdir(join(directory, 'home'));
    await symlink(resolve(dependencies), join(directory, 'node_modules'), 'dir');
    const build = await spawnWorker(join(directory, 'scripts/bench-agent-release.mjs'), ['--build'], { cwd: directory, home: join(directory, 'home'), timeoutMs: 60000 });
    if (build.status !== 'complete') fail(`Production Vite build failed: ${JSON.stringify(build)}`);
    return { directory, source, build, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

async function buildApplication() {
  const guard = installNetworkGuard();
  try {
    const { build, version } = await import('vite');
    const start = performance.now(), cpu = process.cpuUsage();
    const entries = {
      runtime: `export { handleAgentCommand } from './lib/agent-features/index.js'; export * from './lib/agent-features/registry.js'; export * from './lib/agent-features/catalog.js'; export { buildSlackAgentCatalogView } from './src/slack-agent-catalog.js';`,
      parity: `export { agentFeatures } from './lib/agent-features/registry.js'; export { existingAgentMetadata } from './lib/agent-features/catalog-metadata.js'; export const implementations = import.meta.glob('./lib/agent-features/*.ts');`,
      adapters: `export * from './lib/agent-features/runtime.js'; export * from './lib/agent-features/services.js'; export * from './lib/agent-features/bounded-context.js'; export * from './lib/agent-features/budgets.js'; export { eventId } from './lib/agent-features/calendar/ics.js';`,
      policy: `export { handleSlackSlashCommandPayload } from './lib/slack-commands.js'; export { __testing as accessTesting, evaluateNoboAccess } from './lib/access-controls.js'; export * from './lib/agent-features/admission.js'; export { handleAgentCommand } from './lib/agent-features/index.js'; export { runAgentFeature } from './lib/agent-features/runtime.js';`,
    };
    for (const [name, content] of Object.entries(entries)) await writeFile(`release-${name}.ts`, content);
    const input = { ...Object.fromEntries(Object.keys(entries).map(name => [name, resolve(`release-${name}.ts`)])), server: resolve('src/server.ts') };
    for (const name of ['meeting-prep', 'morning-brief', 'weekly-review', 'automation-audit', 'handoffs', 'data-cleanroom']) input[name] = resolve(`lib/agent-features/${name}.ts`);
    const modules = {};
    await build({ configFile: resolve('vite.config.ts'), logLevel: 'error', plugins: [{ name: 'release-module-evidence', generateBundle(_, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) if (chunk.type === 'chunk') modules[name] = Object.keys(chunk.modules).map(id => relative(process.cwd(), id));
    } }], build: { ssr: true, outDir: resolve('release-build'), emptyOutDir: true,
      rollupOptions: { input, output: { entryFileNames: '[name].mjs' } } } });
    await writeFile('release-build/modules.json', JSON.stringify(modules));
    // Original benchmark bundling inputs, output naming, and configuration.
    const baselineArtifacts = {};
    await build({ configFile: resolve('vite.config.ts'), logLevel: 'error', plugins: [{ name: 'baseline-evidence', generateBundle(_, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) if (chunk.type === 'chunk') baselineArtifacts[name] = sha(chunk.code);
    } }], build: { ssr: true, outDir: resolve('baseline-build'), emptyOutDir: true,
      rollupOptions: { input: { runtime: resolve('lib/agent-features/index.ts'), server: resolve('src/server.ts'), engine: resolve('lib/agent-features/runtime.ts') }, output: { entryFileNames: '[name].mjs' } } } });
    await writeFile('baseline-build/checked-runtime.mjs', `import {handleAgentCommand as actual} from './runtime.mjs';\nexport async function handleAgentCommand(...args){const start=performance.now();const result=await actual(...args);globalThis.__releaseValidateCommand(args[0],result,start);return result;}\n`);
    const artifacts = Object.fromEntries(await Promise.all(Object.keys(modules).sort().map(async name => [name, sha(await readFile(join('release-build', name)))])));
    return { status: 'complete', vite: version, cpuMs: cpuMs(cpu), wallMs: performance.now() - start, peakRssMiB: mib(peakRss()), artifacts, baselineArtifacts,
      networkBlocked: guard.blocked.length, note: 'Build process CPU/RSS are excluded from application worker metrics.' };
  } finally { guard.restore(); }
}

async function activeWindow() {
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable(); await sleep(20);
  const start = performance.now(), cpu = process.cpuUsage(), rssAtStartMiB = mib(process.memoryUsage().rss);
  return async () => {
    const wallMs = performance.now() - start, usedCpuMs = cpuMs(cpu);
    await sleep(20); loop.disable();
    return { wallMs, cpuMs: usedCpuMs, eventLoopMaxMs: loop.max / 1e6, rssAtStartMiB, peakRssMiB: mib(peakRss()),
      note: 'Active requests after imports/raw fixture setup; no peak subtraction. VmHWM still includes all earlier allocations.' };
  };
}

function memoryBackend() {
  const data = new Map(), calls = { reads: 0, writes: 0 };
  return { data, calls,
    get: async key => { calls.reads++; return data.get(key) ?? null; },
    compareSet: async (key, previous, next) => { calls.writes++; if ((data.get(key) ?? null) !== previous) return false; data.set(key, next); return true; } };
}
const entry = (directory, name) => pathToFileURL(join(directory, 'release-build', `${name}.mjs`)).href;

async function catalogWorkload(directory, loaded) {
  const start = performance.now();
  const api = await import(entry(directory, 'runtime'));
  const importedMs = performance.now() - start;
  const calls = { backend: 0, preferences: 0, services: 0 };
  const dependencies = Object.fromEntries([['createBackend', 'backend'], ['preferences', 'preferences'], ['loadServices', 'services']]
    .map(([key, count]) => [key, () => { calls[count]++; fail(`Metadata initialized ${count}`); }]));
  const run = command => api.handleAgentCommand(command, OWNER, undefined, dependencies);
  const first = performance.now(), help = await run('help'), helpMs = performance.now() - first;
  assert.ok(help.length > 20 && !/^Unknown/.test(help), 'Root help unavailable');
  const latencies = [];
  for (const feature of api.agentFeatures) {
    const t = performance.now(), response = await run(`${feature.id} help`); latencies.push(performance.now() - t);
    assert.equal(response, api.formatAgentFeatureHelp(feature), `Invalid help: ${feature.id}`);
    assert.ok(response.startsWith(feature.help) && feature.help.length > 50);
  }
  const navigation = [];
  for (const command of ['', 'help', 'catalog page 2', 'catalog group plan page 2', 'search meeting', 'search private page 2']) {
    const t = performance.now(), response = await run(command);
    const parsed = api.parseAgentCatalogCommand(command), expected = api.getAgentCatalogPage(api.agentFeatures, parsed.state);
    assert.equal(response, expected.text);
    navigation.push({ command, ms: performance.now() - t, response, outcome: expected.error ? 'validation-rejected' : 'complete',
      available: expected.error ? expected.pages > 0 && /Choose page/.test(response) : /^Personal agents\n/.test(response) && /of \d+ · page \d+\/\d+/.test(response) });
  }
  const visited = [], grouped = [], search = [];
  let homeViews = 0;
  for (const group of [undefined, ...api.agentCatalogGroups.map(x => x.slug)]) {
    const firstPage = api.getAgentCatalogPage(api.agentFeatures, { group, page: 1 });
    assert.ok(!firstPage.error && firstPage.pages >= 1);
    for (let page = 1; page <= firstPage.pages; page++) {
      const expected = api.getAgentCatalogPage(api.agentFeatures, { group, page });
      const response = await run(`catalog${group ? ` group ${group}` : ''} page ${page}`);
      assert.equal(response, expected.text); assert.ok(response.length <= 3500);
      for (const item of expected.entries) assert.ok(response.includes(`${item.id} —`));
      (group ? grouped : visited).push(...expected.entries.map(x => x.id));
      const view = api.buildSlackAgentCatalogView({ group, page }); assert.ok(view.blocks.length <= 20); homeViews++;
    }
  }
  for (const feature of api.agentFeatures) {
    const response = await run(`search ${feature.id}`);
    assert.ok(response.includes(`${feature.id} —`)); search.push(feature.id);
    const view = api.buildSlackAgentCatalogView({ page: 1, featureId: feature.id }); assert.ok(view.blocks.length <= 20); homeViews++;
  }
  const ids = api.agentFeatures.map(x => x.id).sort();
  assert.deepEqual([...visited].sort(), ids); assert.deepEqual([...grouped].sort(), ids);
  await assert.rejects(() => api.handleAgentCommand('help', {}, undefined, dependencies), /signed Slack/);
  await sleep(50); globalThis.gc?.();
  const modules = JSON.parse(await readFile(join(directory, 'release-build/modules.json'), 'utf8'));
  const evaluated = [...loaded].filter(url => url.startsWith(pathToFileURL(join(directory, 'release-build') + '/').href))
    .flatMap(url => modules[fileURLToPath(url).split('/').pop()] ?? []);
  const forbiddenLoads = [...new Set(evaluated.filter(id => /(?:agent-features\/(?:services|context|runtime|store)\.ts|lib\/(?:ai|redis|preferences)\.ts|provider)/.test(id) || api.agentFeatures.some(f => id === `lib/agent-features/${f.id}.ts`)))];
  assert.deepEqual(calls, { backend: 0, preferences: 0, services: 0 });
  return { registered: api.agentFeatures.length, ids: api.agentFeatures.map(x => x.id), helpCount: latencies.length,
    importedMs, helpMs, coldHelpMs: importedMs + helpMs, helpP95Ms: p95(latencies), navigation,
    navigationComplete: navigation.every(x => x.available), visited, grouped, search, homeViews, forbiddenLoads, evaluatedModules: [...new Set(evaluated)], calls,
    idleRssMiB: mib(process.memoryUsage().rss), idleHeapMiB: mib(process.memoryUsage().heapUsed),
    ...(api.agentFeatures.length !== 70 || navigation.some(x => !x.available) ? { status: 'pending', pending: 'Integrated 70 registrations and catalog route contract' } : {}) };
}

async function runtimeWorkload(directory) {
  // Same seed/strings/arrival sequence as bench-agent-features.mjs. Additional
  // success checks prevent an error string from being counted as useful work.
  const { handleAgentCommand } = await import(entry(directory, 'runtime'));
  await handleAgentCommand('help', OWNER); await sleep(50); globalThis.gc?.();
  const backend = memoryBackend();
  let contextCalls = 0, active = 0, peak = 0;
  const services = { generate: forbidden, search: forbidden, async readContext() {
    contextCalls++; active++; peak = Math.max(peak, active);
    try { await sleep(10); return Array.from({ length: 600 }, (_, i) => ({ id: `note-${SEED}-${i}`, kind: 'note', title: `Atlas evidence ${i}`,
      text: `Atlas reference ${i} ` + 'bounded offline evidence '.repeat(60), updatedAt: '2026-10-22T12:00:00Z' })); }
    finally { active--; }
  } };
  const settings = { backend, services, timezone: 'UTC', now: NOW };
  const run = async (command, owner = OWNER) => classifyBaseline(command, await handleAgentCommand(command, owner, settings));
  for (let i = 0; i < 40; i++) assert.equal(await run(`inbox capture ${i} ` + 'synthetic '.repeat(390)), 'complete');
  const deterministic = [];
  for (let i = 0; i < 100; i++) { const t = performance.now(); assert.equal(await run('inbox list'), 'complete'); deterministic.push(performance.now() - t); }
  const burst = [], busy = [], outcomes = [];
  const start = performance.now(), cpu = process.cpuUsage();
  for (let round = 0; round < 3; round++) await Promise.all(Array.from({ length: 32 }, async (_, i) => {
    const t = performance.now();
    const outcome = await run('recall search Atlas --limit 10', { ...OWNER, userId: `UBENCH${i}`, requestId: `burst-${round}-${i}` });
    (outcome === 'busy' ? busy : burst).push(performance.now() - t); outcomes.push({ round, i, outcome });
  }));
  const overload = { offered: 96, accepted: burst.length, rejected: busy.length, failed: 0, p95Ms: p95(burst), busyP95Ms: p95(busy),
    peakContextCalls: peak, contextCalls, stressWallMs: performance.now() - start, stressCpuMs: cpuMs(cpu), outcomes };
  const mixed = { offered: 60, accepted: 0, rejected: 0, failed: 0, deterministicAccepted: 0, recallAccepted: 0, outcomes: [] };
  const det = [], recall = [], tasks = [], mixedStart = performance.now(), mixedCpu = process.cpuUsage();
  for (let i = 0; i < 60; i++) {
    await sleep(10); const isRecall = i % 4 === 3;
    tasks.push((async () => {
      const t = performance.now(), outcome = await run(isRecall ? 'recall search Atlas --limit 10' : 'inbox list', { ...OWNER, userId: isRecall ? `UMIX${i}` : OWNER.userId });
      mixed.outcomes.push({ i, kind: isRecall ? 'recall' : 'deterministic', outcome });
      if (outcome === 'busy') { mixed.rejected++; return; }
      mixed.accepted++; mixed[isRecall ? 'recallAccepted' : 'deterministicAccepted']++; (isRecall ? recall : det).push(performance.now() - t);
    })());
  }
  await Promise.all(tasks);
  Object.assign(mixed, { wallMs: performance.now() - mixedStart, cpuMs: cpuMs(mixedCpu), deterministicP95Ms: p95(det), recallP95Ms: p95(recall) });
  mixed.completedPerSecond = mixed.accepted / (mixed.wallMs / 1000);
  assert.equal(active, 0);
  return { seed: SEED, setupCompleted: 40, deterministic: { count: deterministic.length, p95Ms: p95(deterministic) }, overload, mixed,
    backend: { ...backend.calls, keys: backend.data.size }, measurementOverhead: 'Positive response regex checks and bounded outcome recording; no extra source serialization. Closed-loop driver.' };
}

const LEGACY = [
  ['follow-up', 'follow-ups:record:', 'follow-ups:user:', 'task'],
  ['reminder', 'schedules:job:', 'schedules:user:', 'task'],
  ['monitor', 'monitors:job:', 'monitors:user:', 'query'],
  ['digest', 'channel-digests:subscription:', 'channel-digests:user:', 'focus'],
];
const ALL_KINDS = ['note', 'goal', 'habit', 'journal', 'bookmark', 'follow-up', 'reminder', 'monitor', 'digest', 'artifact', 'memory', 'event'];

/** Raw persisted source records, exactly the production adapters' schemas. The
 * fake Redis only supplies bounded owner indexes; production code projects them. */
export function sourceFixture(api, variant = 'consumer') {
  const backend = memoryBackend(), indexes = {}, at = NOW.toISOString();
  const counts = { eval: 0, policy: 0, generate: 0, search: 0, logical: 0, active: 0, peakPhysical: 0 };
  const physical = async work => { counts.active++; counts.peakPhysical = Math.max(counts.peakPhysical, counts.active); try { return await work(); } finally { counts.active--; } };
  const oldGet = backend.get; backend.get = key => physical(() => oldGet(key));
  const source = (tool, count, details = false) => {
    const raw = JSON.stringify({ entries: Array.from({ length: count }, (_, i) => ({ id: `item-${i}`, title: `Atlas ${i}`,
      body: variant === 'adapter-six' ? 'x'.repeat(12000) : 'Atlas launch', updatedAt: at, createdAt: at,
      data: details ? { details: '界'.repeat(6000) } : {} })) });
    assert.ok(Buffer.byteLength(raw) < 2000000); backend.data.set(`nobo:toolbox:v1:${OWNER.teamId}:${OWNER.userId}:${tool}`, raw);
  };
  const jobs = (kind, count, wide = true) => {
    const [, prefix, index, field] = LEGACY.find(x => x[0] === kind);
    indexes[index + OWNER.userId] = Array.from({ length: count }, (_, i) => `job-${i}`);
    for (const id of indexes[index + OWNER.userId]) {
      const purpose = variant === 'adapter-six' ? 'x'.repeat(12000) : wide ? 'Atlas ' + '界'.repeat(11994) : 'Atlas launch';
      const raw = JSON.stringify({ id, channel: OWNER.channelId, ownerUserId: OWNER.userId, createdByUserId: OWNER.userId,
        createdAt: at, status: 'active', nextRunAt: '2026-10-23T09:00:00Z', kind: 'daily', frequency: 'daily', hour: 9, minute: 0, timezone: 'UTC', [field]: purpose });
      assert.ok(Buffer.byteLength(raw) < 64000); backend.data.set(prefix + id, raw);
    }
  };
  if (variant === 'capacity') {
    source('notes', 1); for (const kind of ['reminder', 'monitor', 'digest']) jobs(kind, 1, false);
  } else {
    for (const tool of ['notes', 'goals', 'habits', 'journal', 'bookmarks']) source(tool, 100, variant !== 'adapter-six');
    for (const kind of variant === 'adapter-six' ? LEGACY.map(x => x[0]) : ['follow-up', 'reminder']) jobs(kind, 200);
  }
  if (variant === 'adapter-six') {
    backend.data.set(`nobo:agents:v1:${OWNER.teamId}:${OWNER.userId}:calendar:calendar-v1`, JSON.stringify({ version: 1, revision: 1, pending: null,
      events: Array.from({ length: 100 }, (_, i) => ({ id: api.eventId(`event-${i}`), uid: `event-${i}`, title: `Meeting ${i}`, location: 'Office', busy: true,
        allDay: false, updatedAt: at, startAt: at, endAt: '2026-10-22T13:00:00.000Z', timezone: 'UTC' })) }));
    backend.data.set(`nobo:agents:v1:${OWNER.teamId}:${OWNER.userId}:memory-review:cards`, JSON.stringify({ version: 1, cards: Array.from({ length: 100 }, (_, i) => {
      const claim = { fact: `Atlas memory ${i}`, source: 'My confirmation', expiresOn: null, confidence: null };
      return { ...claim, id: `mr_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, subject: `subject${i}`, key: 'key', confirmedAt: at,
        capturedAt: at, updatedAt: at, revision: 2, origin: { kind: 'user' }, history: [{ ...claim, confirmedAt: null, revision: 1, action: 'capture', at }, { ...claim, confirmedAt: at, revision: 2, action: 'confirm', at }] };
    }) }));
  }
  const adapters = api.createProductionContextAdapters({
    redis: async () => ({ eval: async (_, options) => physical(async () => {
      counts.eval++; assert.equal(options.arguments[0], '200');
      assert.ok(Object.hasOwn(indexes, options.keys[0]) || variant === 'consumer');
      return indexes[options.keys[0]] ?? [];
    }) }), evaluateAccess: async owner => physical(async () => { counts.policy++; assert.equal(owner.userId, OWNER.userId); return { allowed: true }; }),
  });
  const batches = [];
  const services = (featureId, signal) => {
    const production = api.createAgentFeatureServices(backend, OWNER, signal, { now: NOW, timezone: 'UTC', featureId }, adapters);
    return { ...production, generate: async () => { counts.generate++; return forbidden(); }, search: async () => { counts.search++; return forbidden(); },
      readContext: async kinds => {
        counts.logical++;
        const items = await production.readContext(kinds);
        batches.push({ kinds: [...kinds], count: items.length }); // no serialization/byte traversal in timed path
        return items;
      } };
  };
  return { backend, jobs, counts, batches, services, adapters };
}

async function contextWorkload(directory, mode) {
  const api = await import(entry(directory, 'adapters'));
  const f = sourceFixture(api, mode === 'adapter-six' ? mode : mode === 'capacity' ? mode : 'consumer');
  const simple = { id: 'release-adapter-probe', title: 'Probe', description: 'Probe', help: 'Probe', execute: async (_, ctx) => {
    const items = await api.readBoundedContext(ctx, ALL_KINDS);
    assert.equal(items.length, 1500); assert.equal(new Set(items.map(x => x.id)).size, 1500);
    return '1500 complete adapter records';
  } };
  const target = mode === 'adapter-six' ? simple : (await import(entry(directory, mode === 'capacity' ? 'automation-audit' : mode))).default;
  const run = command => {
    const controller = new AbortController();
    return api.runAgentFeature(target, command, OWNER, { backend: f.backend, now: NOW, timezone: 'UTC', signal: controller.signal, services: f.services(target.id, controller.signal) });
  };
  const command = mode === 'meeting-prep' ? 'prepare Atlas | purpose: Review launch' : mode === 'morning-brief' ? 'brief' : 'review';
  let savedBefore;
  if (mode === 'capacity') {
    assert.match(await run('review'), /Personal automation review audit-/);
    for (const kind of ['reminder', 'monitor', 'digest']) f.jobs(kind, 180);
    savedBefore = new Map(f.backend.data);
  }
  f.batches.length = 0;
  const finishActive = await activeWindow();
  const before = { ...f.counts, ...f.backend.calls }, start = performance.now(), cpu = process.cpuUsage();
  const response = await run(command), acceptedMs = performance.now() - start, acceptedCpuMs = cpuMs(cpu);
  const active = await finishActive();
  const patterns = { 'adapter-six': /^1500 complete/, 'meeting-prep': /mp-/, 'morning-brief': /Morning brief/i, 'weekly-review': /wr-/, capacity: /total context byte budget \(32 MiB\)/ };
  assert.match(response, patterns[mode]);
  assert.equal(f.counts.generate, 0); assert.equal(f.counts.search, 0);
  const batches = structuredClone(f.batches), counts = { ...f.counts }, backendCalls = { reads: f.backend.calls.reads - before.reads, writes: f.backend.calls.writes - before.writes };
  assert.ok(batches.length <= 8 && batches.every(x => x.count <= 2000));
  assert.equal(counts.active, 0); assert.equal(counts.peakPhysical, 1);
  if (mode === 'adapter-six') { assert.equal(batches.length, 6); assert.equal(backendCalls.writes, 0); }
  else if (mode === 'capacity') { assert.deepEqual(f.backend.data, savedBefore); assert.equal(backendCalls.writes, 0); }
  else if (mode !== 'morning-brief') assert.ok(backendCalls.writes > 0, 'Consumer must retain its bounded snapshot');
  for (const [key, raw] of f.backend.data) if (key.startsWith('nobo:agents:')) assert.ok(Buffer.byteLength(raw) <= 512000, key);
  // Re-read identical immutable sources only AFTER worker timing/RSS snapshots.
  // This explicit diagnostic pass is not a second serialization in the timed path.
  const audit = async () => {
    const services = f.services(target.id, new AbortController().signal), measured = [];
    for (const batch of batches) {
      const items = await services.readContext(batch.kinds);
      assert.equal(items.length, batch.count);
      measured.push({ ...batch, bytes: api.measureAgentContext(items) });
    }
    const totalBytes = measured.reduce((sum, x) => sum + x.bytes, 0);
    assert.ok(measured.every(x => x.bytes <= 16 * 1048576));
    assert.ok(mode === 'capacity' ? totalBytes > 32 * 1048576 : totalBytes < 32 * 1048576);
    if (mode !== 'adapter-six' && mode !== 'capacity') assert.ok(totalBytes > 16 * 1048576, 'Complete consumer must exercise formerly excluded context');
    return { batches: measured, totalBytes, diagnosticBytePass: 'After captured timing/CPU/RSS/loop metrics; incremental production measureAgentContext, no complete JSON copy.' };
  };
  return { active, concurrency: 1, offered: 1, accepted: mode === 'capacity' ? 0 : 1, capacityRejected: mode === 'capacity' ? 1 : 0,
    p95Ms: mode === 'capacity' ? null : acceptedMs, elapsedMs: acceptedMs, acceptedCpuMs,
    consumer: mode === 'adapter-six' ? 'adapter + runtime + bounded helper only; no domain consumer' : target.id,
    counts: { logical: batches.length, get: backendCalls.reads, eval: counts.eval - before.eval, policy: counts.policy - before.policy, writes: backendCalls.writes,
      generate: counts.generate, search: counts.search, peakPhysical: counts.peakPhysical },
    items: batches.reduce((n, b) => n + b.count, 0), response, audit };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } fail('Bounded fixture did not reach the expected phase'); }

export async function policyWorkload(api, cycles = 6) {
  const importIdle = process.memoryUsage();
  const finishActive = await activeWindow();
  const backend = memoryBackend(), records = [];
  const services = { generate: forbidden, search: forbidden, readContext: forbidden };
  const simple = { id: 'release-policy-probe', title: 'Probe', description: 'Probe', help: 'Probe', execute: async () => 'admitted' };
  const run = (userId = OWNER.userId, feature = simple, requestId) => api.runAgentFeature(feature, 'go', { ...OWNER, userId, requestId }, { backend, services, timezone: 'UTC', now: NOW });
  const payload = { command: '/nobo-help', text: 'agent inbox capture Never start', team_id: OWNER.teamId, user_id: OWNER.userId, channel_id: OWNER.channelId };
  let maxPending = 0, totalCalls = 0, totalSettled = 0, startup = 0;
  const originalTimeout = AbortSignal.timeout;
  for (let cycle = 0; cycle < cycles; cycle++) {
    const order = ['reject-before-abort', 'reject-after-abort', 'synchronous-throw'][cycle % 3];
    const gates = Array.from({ length: 10 }, deferred), controllers = [new AbortController(), new AbortController()];
    let calls = 0, settled = 0, deadlines = 0;
    const deadlineControllers = [];
    AbortSignal.timeout = ms => {
      assert.equal(ms, 120000); const c = controllers[deadlines++] ?? new AbortController(); deadlineControllers.push(c); return c.signal;
    };
    api.accessTesting.setRedisClient({ sMembers() {
      const i = calls++; totalCalls++;
      if (order === 'synchronous-throw' && [0, 5].includes(i)) { settled++; totalSettled++; throw new Error('synthetic synchronous policy rejection'); }
      assert.ok(i < 10, 'No policy work may start while this owner is full');
      maxPending = Math.max(maxPending, calls - settled);
      return gates[i].promise.finally(() => { settled++; totalSettled++; });
    }, sAdd: forbidden, sRem: forbidden, lPush: forbidden, lTrim: forbidden, lRange: forbidden });
    const options = { handleAgentCommand: async () => { startup++; fail('Failed policy cannot reach feature startup'); } };
    const pending = [1, 2].map(() => api.handleSlackSlashCommandPayload(payload, options).then(
      () => fail('Aborted/failed policy counted as complete'), e => { assert.match(String(e), /abort|policy rejection/i); return String(e); }));
    try {
      await until(() => calls === 10);
      if (order === 'reject-before-abort') { gates[0].reject(new Error('synthetic policy rejection')); gates[5].reject(new Error('synthetic policy rejection')); await Promise.all(pending); }
      controllers.forEach(c => c.abort()); await Promise.all(pending);
      if (order === 'reject-after-abort') { gates[0].reject(new Error('late policy rejection')); gates[5].reject(new Error('late policy rejection')); }
      await tick(); assert.equal(calls - settled, 8);
      const writes = backend.calls.writes, reads = backend.calls.reads;
      for (let attempt = 0; attempt < 8; attempt++) {
        const result = await api.handleSlackSlashCommandPayload(payload, options);
        assert.equal(result.response.text, api.AGENT_BUSY_MESSAGE); assert.equal(result.response.response_type, 'ephemeral');
        const deniedStartup = await api.handleAgentCommand('inbox capture blocked', { ...OWNER, requestId: `retry-${cycle}` }, undefined, {
          createBackend: () => { startup++; return forbidden(); }, preferences: () => { startup++; return forbidden(); }, loadServices: () => { startup++; return forbidden(); },
        });
        assert.equal(deniedStartup, api.AGENT_BUSY_MESSAGE);
      }
      assert.equal(deadlines, 2); assert.equal(calls, 10); assert.equal(backend.calls.writes, writes); assert.equal(backend.calls.reads, reads);
      assert.equal(await run('UOTHER'), 'admitted');
      for (const i of [1, 2, 3]) gates[i].resolve([]);
      await tick(); assert.equal(await run(), api.AGENT_BUSY_MESSAGE);
      gates[4].reject(new Error('last physical sibling failed')); await tick();
      assert.equal(await run(), 'admitted');
      gates.forEach(g => g.resolve([])); await tick(); assert.equal(calls, settled);
      // Refill all three slots: this detects both leaks and double release.
      const hold = deferred(); let entered = 0;
      const blocking = { ...simple, execute: async () => { entered++; await hold.promise; return 'admitted'; } };
      const fill = ['UONE', 'UTWO', 'UTHREE'].map(user => run(user, blocking));
      try { await until(() => entered === 3); assert.equal(await run(), api.AGENT_BUSY_MESSAGE); }
      finally { hold.resolve(); await Promise.all(fill); }
      assert.equal(await run(OWNER.userId, simple, `retry-${cycle}`), 'admitted');
      records.push({ cycle, order, calls, settled, abandoned: calls - settled, busyAttempts: 16, otherOwner: 1, exactRelease: true });
    } finally {
      gates.forEach(g => g.resolve([])); await Promise.allSettled(pending); await tick();
      deadlineControllers.forEach(c => c.abort()); AbortSignal.timeout = originalTimeout; api.accessTesting.setRedisClient(undefined);
    }
  }
  assert.equal(startup, 0); assert.equal(totalCalls, totalSettled);
  // A policy deadline must also cancel a later real dispatcher startup phase.
  const deadline = new AbortController(), lateBackend = deferred(), entered = deferred(); let deadlines = 0, preferences = 0;
  AbortSignal.timeout = ms => { assert.equal(ms, 120000); deadlines++; return deadline.signal; };
  api.accessTesting.setRedisClient({ sMembers: async () => [], sAdd: forbidden, sRem: forbidden, lPush: forbidden, lTrim: forbidden, lRange: forbidden });
  try {
    const p = api.handleSlackSlashCommandPayload(payload, { handleAgentCommand: text => api.handleAgentCommand(text, OWNER, undefined, {
      createBackend: async () => { entered.resolve(); return lateBackend.promise; }, preferences: () => { preferences++; return forbidden(); },
      loadServices: forbidden,
    }) });
    const rejected = assert.rejects(p, /original policy deadline/);
    await entered.promise; deadline.abort(new Error('original policy deadline')); await rejected;
    lateBackend.resolve(backend); await tick(); assert.equal(deadlines, 1); assert.equal(preferences, 0);
  } finally { lateBackend.resolve(backend); await tick(); AbortSignal.timeout = originalTimeout; api.accessTesting.setRedisClient(undefined); }
  assert.equal(await run(), 'admitted');
  return { active: await finishActive(), importIdleRssMiB: mib(importIdle.rss), importIdleHeapMiB: mib(importIdle.heapUsed),
    cycles, records, totalCalls, totalSettled, maxPending, pendingAtEnd: 0, startup, originalDeadlineAcrossPhases: true,
    backend: { ...backend.calls, receiptKeys: backend.data.size }, note: 'Cancellation stops the waiter; it does not prove upstream billing or physical work stopped.' };
}

async function csvWorkload(directory) {
  const { handleAgentCommand, agentFeatures } = await import(entry(directory, 'runtime'));
  if (!agentFeatures.some(f => f.id === 'data-cleanroom')) return { status: 'pending', pending: 'data-cleanroom registration' };
  const backend = memoryBackend(), latencies = [];
  const settings = { backend, services: { generate: forbidden, search: forbidden, readContext: forbidden }, timezone: 'UTC', now: NOW };
  let commands = 0, pages = 0;
  const run = async command => { const start = performance.now(), response = await handleAgentCommand(`data-cleanroom ${command}`, OWNER, settings); commands++; latencies.push(performance.now() - start); return response; };
  const rows = Array.from({ length: 40 }, (_, i) => Array.from({ length: 8 }, () => String(i % 10)));
  const header = Array.from({ length: 8 }, (_, i) => `c${i}`), source = [header, ...rows].map(row => row.join(',')).join('\n');
  const finishActive = await activeWindow();
  const created = await run(`create Maximum rows and columns | ${source}`);
  assert.match(created, /^Saved privately: table-/); const id = created.match(/table-[a-f0-9-]{36}/)[0];
  const state = () => JSON.parse(backend.data.get(`nobo:agents:v1:${OWNER.teamId}:${OWNER.userId}:data-cleanroom:state`));
  assert.equal(state().records[0].original.rows.length, 40); assert.equal(state().records[0].original.columns.length, 8);
  const allPages = async command => {
    let body = '';
    for (let n = 0; n < 100; n++) {
      const response = await run(command); assert.ok(response.length <= 3500 && response.isWellFormed());
      const heading = /^.*\nPage \d+\/\d+\n/.exec(response); assert.ok(heading, response);
      const next = /\nNext: \/nobo-help agent data-cleanroom ([^\n]+)$/.exec(response);
      body += response.slice(heading[0].length, next?.index ?? response.length); pages++;
      if (!next || !/ rev \d+-[a-f0-9]{64}$/.test(next[1])) return body;
      assert.match(next[1], / rev \d+-[a-f0-9]{64}$/); command = next[1];
    }
    fail('Pagination failed to terminate within 100 pages');
  };
  assert.equal(await allPages(`export-csv ${id}`), [header, ...rows].map(r => r.join(',')).join('\r\n'));
  const preview = await run(`preview ${id} | dedupe | ${header.join(',')}`); assert.match(preview, /^Saved privately:/);
  const token = preview.match(/preview-[a-f0-9-]{36}/)[0];
  assert.equal(state().records[0].preview.output.rows.length, 10);
  await allPages(`preview-show ${id}`);
  assert.match(await run(`apply ${id} ${token}`), /^Saved privately:/);
  assert.equal(state().records[0].current.rows.length, 10); assert.equal(state().records[0].undo.rows.length, 40);
  assert.deepEqual(JSON.parse(await allPages(`show ${id}`)), JSON.parse(await run(`export ${id}`)));
  assert.match(await run(`undo ${id} confirm`), /^Saved privately:/);
  assert.deepEqual(state().records[0].current.rows.map(r => r.cells), rows);
  assert.deepEqual(JSON.parse(await allPages(`show ${id}`)), JSON.parse(await run(`export ${id}`)));
  const bytes = Buffer.byteLength(backend.data.values().next().value); assert.ok(bytes <= 65536);
  const exportBytes = Buffer.byteLength(await run(`export ${id}`));
  return { active: await finishActive(), offered: commands, completed: commands, rows: 40, columns: 8, cells: 320, duplicateGroups: 10, pages, fullRetrieval: true,
    sourceBytes: Buffer.byteLength(source), stateBytes: bytes, exportBytes, p95Ms: p95(latencies),
    backend: backend.calls, generations: 0, searches: 0, contextReads: 0, concurrency: 1,
    note: 'Actual registered deterministic CSV lifecycle and full retrieval at row/column maxima; dynamic byte reserve binds separately. Not a recall comparison.' };
}

async function serverWorkload(directory) {
  const { createServer } = await import('node:http'), { once } = await import('node:events');
  const api = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, bot_id: 'BBENCH', user_id: 'UBENCH', team_id: 'TBENCH' })); });
  let server;
  try {
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const start = performance.now();
    const { startNoboServer } = await import(entry(directory, 'server'));
    server = await startNoboServer({ signingSecret: 'offline-benchmark', token: 'xoxb-offline', port: 0, host: '127.0.0.1', backgroundRunners: false,
      clientOptions: { slackApiUrl: `http://127.0.0.1:${api.address().port}/api/`, retryConfig: { retries: 0 }, timeout: 1000 } });
    const readyMs = performance.now() - start;
    const health = await fetch(`http://127.0.0.1:${server.server.address().port}/healthz`);
    assert.equal(health.status, 200); await health.text();
    await sleep(100); globalThis.gc?.(); const idle = process.memoryUsage();
    return { readyMs, health: 200, backgroundRunners: false, idleRssMiB: mib(idle.rss), idleHeapMiB: mib(idle.heapUsed),
      note: 'Actual full-server production bootstrap; loopback fake Slack; RSS separate from feature-runtime 256 MiB gate.' };
  } finally { await server?.stop(); api.closeAllConnections(); if (api.listening) await new Promise((r, j) => api.close(e => e ? j(e) : r())); }
}

async function measureWorkload(directory, mode) {
  const guard = installNetworkGuard({ loopback: mode === 'server' });
  const loaded = new Set(), hook = registerHooks({ load(url, context, next) { loaded.add(url); return next(url, context); } });
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const errors = [], onUnhandled = error => errors.push(String(error?.stack ?? error)); process.on('unhandledRejection', onUnhandled);
  const start = performance.now(), cpu = process.cpuUsage();
  let result, error;
  try {
    // Arm the histogram before any synchronous work, with no warmup invocation.
    await sleep(20);
    if (mode === 'parity') {
      const { agentFeatures, implementations, existingAgentMetadata } = await import(entry(directory, 'parity'));
      const originalIds = new Set(existingAgentMetadata.map(x => x.id)); assert.equal(originalIds.size, 20);
      let additions = 0;
      for (const metadata of agentFeatures) {
        const implementation = (await implementations[`./lib/agent-features/${metadata.id}.ts`]()).default;
        for (const key of ['id', 'title', 'description', 'help']) assert.equal(implementation[key], metadata[key], `${metadata.id}.${key}`);
        if (!originalIds.has(metadata.id)) { additions++; for (const key of ['group', 'keywords', 'example', 'resourceBudgets']) assert.deepEqual(implementation[key], metadata[key], `${metadata.id}.${key}`); }
      }
      assert.equal(agentFeatures.length, 70); assert.equal(additions, 50);
      result = { registered: agentFeatures.length, additions, parity: true };
    }
    else if (mode === 'catalog') result = await catalogWorkload(directory, loaded);
    else if (mode === 'runtime') result = await runtimeWorkload(directory);
    else if (mode === 'server') result = await serverWorkload(directory);
    else if (mode === 'policy') result = await policyWorkload(await import(entry(directory, 'policy')));
    else if (mode === 'csv') result = await csvWorkload(directory);
    else if (['adapter-six', 'meeting-prep', 'morning-brief', 'weekly-review', 'capacity'].includes(mode)) result = await contextWorkload(directory, mode);
    else fail(`Unknown workload: ${mode}`);
  } catch (e) { error = String(e.stack ?? e); }
  await sleep(30); loop.disable();
  const metrics = { node: process.version, wallMs: performance.now() - start, cpuMs: cpuMs(cpu), peakRssMiB: mib(peakRss()),
    eventLoopMaxMs: loop.max / 1e6, eventLoopP95Ms: loop.percentile(95) / 1e6, networkBlocked: guard.blocked.length,
    rssMethod: process.platform === 'linux' ? 'Linux /proc/self/status VmHWM per exec worker' : 'current RSS only; no Linux peak',
    heapLimitMiB: 1024, unhandledErrors: errors };
  try {
    const { audit, ...rest } = result ?? {};
    if (!error && audit) Object.assign(rest, await audit());
    if (guard.blocked.length || errors.length) error ??= `Forbidden network or unhandled promise: ${JSON.stringify({ blocked: guard.blocked, errors })}`;
    return { mode, ...metrics, status: error ? 'error' : 'complete', ...rest, ...(error ? { status: 'error', error } : {}) };
  } catch (e) { return { mode, ...metrics, status: 'error', error: String(e.stack ?? e), workloadResult: { ...result, audit: undefined } }; }
  finally { hook.deregister(); guard.restore(); process.off('unhandledRejection', onUnhandled); }
}

export async function runSample(build, mode, profile = false) {
  if (mode === 'runtime') return spawnWorker(join(build.directory, 'scripts/bench-agent-features.mjs'),
    ['--worker', pathToFileURL(join(build.directory, 'baseline-build/checked-runtime.mjs')).href, 'runtime'],
    { cwd: build.directory, home: join(build.directory, 'home'), heapMiB: 384, baseline: true, profile });
  return spawnWorker(join(build.directory, 'scripts/bench-agent-release.mjs'), ['--worker', mode], { cwd: build.directory, home: join(build.directory, 'home'), profile });
}

// Run as --import by the UNCHANGED historical worker. The original driver,
// timers, cold/JIT/GC sequence, VmHWM method, workload and 384 MiB heap remain.
// A small boundary validator adds positive-result checks; its CPU overhead is
// included, never subtracted. No response/source is copied or serialized here.
if (process.env.RELEASE_BASELINE_PRELOAD === '1') {
  const guard = installNetworkGuard();
  const audit = { setupCompleted: 0, listsCompleted: 0, recallCompleted: 0, busy: 0, failed: 0, setupWindowMs: 0, maximumCommandMs: 0 };
  let firstSetup;
  globalThis.__releaseValidateCommand = (command, response, start) => {
    if (command === 'help') { assert.match(response, /^Personal agents\n/); return; }
    try {
      const outcome = classifyBaseline(command, response);
      audit.maximumCommandMs = Math.max(audit.maximumCommandMs, performance.now() - start);
      if (outcome === 'busy') audit.busy++;
      else if (command.startsWith('inbox capture ')) { firstSetup ??= start; audit.setupCompleted++; audit.setupWindowMs = performance.now() - firstSetup; }
      else if (command === 'inbox list') audit.listsCompleted++;
      else audit.recallCompleted++;
    } catch (error) { audit.failed++; throw error; }
  };
  const send = process.send.bind(process);
  process.send = message => {
    if (message.result) {
      const raw = message.result;
      const valid = audit.setupCompleted === 40 && audit.listsCompleted === 145 && audit.recallCompleted === 24 && audit.busy === 87 && audit.failed === 0 && guard.blocked.length === 0;
      return send({ result: { ...raw, baselineRaw: raw, status: valid ? 'complete' : 'error', ...(valid ? {} : { error: 'Historical driver output failed positive response/count validation' }),
        setupCompleted: audit.setupCompleted, outcomeAudit: audit, overload: { ...raw.overload, failed: 0 }, mixed: { ...raw.mixed, failed: 0 }, networkBlocked: guard.blocked.length,
        method: 'Unchanged bench-agent-features.mjs --worker and original three-entry Vite build; boundary result checks/timestamps included', heapLimitMiB: 384 } });
    }
    return send({ ...message, audit });
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--build' || args[0] === '--worker') {
    try { process.send?.({ result: args[0] === '--build' ? await buildApplication() : await measureWorkload(process.cwd(), args[1]) }); }
    catch (error) { process.send?.({ error: String(error.stack ?? error) }); process.exitCode = 1; }
    return;
  }
  const final = args.includes('--final'), check = args.includes('--check');
  const get = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const profileMode = get('--profile');
  if (profileMode && (final || !MODES.includes(profileMode))) fail('Profiles are separate single-workload diagnostic runs');
  const modes = get('--modes')?.split(',') ?? MODES;
  if (modes.some(mode => !MODES.includes(mode))) fail('Unknown --modes');
  if (final && get('--modes')) fail('Final release runs every declared workload');
  const output = resolve(get('--output') ?? 'scripts/bench-agent-release.results.json');
  const runId = randomUUID(), events = [], recordedAt = new Date().toISOString();
  const record = async event => { const item = { runId, recordedAt: new Date().toISOString(), ...event }; await appendHistory(output, item); events.push(item); return item; };
  await record({ type: 'start', purpose: profileMode ? 'profile-only' : final ? 'final70' : 'preparatory', recordedAt, node: process.version, command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    seed: SEED, samples: final ? 3 : 1, modes, cpuModel: cpus()[0]?.model, platform: process.platform, arch: process.arch, budget: BUDGET,
    caveats: ['Shared host; cold process/JIT; no outlier removal', 'Explicit idle GC only; normal production GC differs', 'Closed-loop mixed arrivals delay during stalls', 'No provider spend or cloud bill/RSS reduction inference', 'Worker CPU includes setup/import; build CPU separate', 'Final review/deployment approval outside performance scope'] });
  let build;
  try {
    build = await prepareBuild(process.cwd(), get('--dependencies'));
    await record({ type: 'build', source: build.source, ...build.build });
    if (profileMode) {
      const result = await runSample(build, profileMode, true);
      const raw = await readFile(join(build.directory, 'home/release.cpuprofile'), 'utf8');
      await record({ type: 'profile', profile: true, mode: profileMode, result, sha256: sha(raw), raw: JSON.parse(raw), note: 'Profiler overhead and diagnostic byte pass included. Never used as timing gate evidence.' });
      if (result.status !== 'complete') process.exitCode = 1;
      return;
    }
    const parity = await runSample(build, 'parity'); await record({ type: 'parity', ...parity });
    if (parity.status !== 'complete') { process.exitCode = 1; return; }
    // Read-only preflight precedes a costly final series; a missing registration
    // is retained as pending and cannot be mistaken for a successful sample.
    if (final) {
      const preflight = await runSample(build, 'catalog');
      await record({ type: 'preflight', ...preflight });
      if (sampleFailures(preflight, { timings: false }).length) { process.exitCode = 2; await record({ type: 'gate', passed: false, pending: '70-agent metadata/navigation preflight', failures: sampleFailures(preflight, { timings: false }) }); return; }
    }
    for (const mode of modes) for (let ordinal = 1; ordinal <= (final ? 3 : 1); ordinal++) {
      const host = { loadAverage: loadavg(), freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(), logicalCpus: cpus().length };
      const result = await runSample(build, mode); await record({ type: 'sample', ordinal, mode, host, ...result });
      console.log(JSON.stringify({ mode, ordinal, status: result.status, cpuMs: result.cpuMs, peakRssMiB: result.peakRssMiB, eventLoopMaxMs: result.eventLoopMaxMs, error: result.error }));
      // Never rerun a failed worker to select a favorable sample. A correctness
      // error stops immediately; timing failures retain the planned three samples.
      if (result.status === 'error') { process.exitCode = 1; await record({ type: 'gate', passed: false, failures: [result.error], remaining: 'Stopped for concrete workload error' }); return; }
    }
    const gate = final ? releaseGate(events, { timings: check }) : { passed: false, pending: 'Preparatory run is not release approval', failures: events.filter(x => x.type === 'sample').flatMap(x => sampleFailures(x, { timings: false })) };
    await record({ type: 'gate', ...gate, timingsChecked: check, final });
    if (final && (!check || !gate.passed)) process.exitCode = 1;
    console.log(JSON.stringify({ runId, output, ...gate }));
  } catch (error) { await record({ type: 'error', error: String(error.stack ?? error) }); process.exitCode = 1; }
  finally { await build?.cleanup(); await record({ type: 'cleanup', temporarySourceRemoved: !build || !existsSync(build.directory), childrenExited: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) await main();
