import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import feature, { feature as namedFeature } from "../lib/agent-features/travel.js";
import type { AgentFeatureContext, AgentFeatureStore } from "../lib/agent-features/types.js";
import { createAgentTestContext, createAgentTestStore } from "./agent-feature-test-utils.js";

type Snapshot = {
  version: 1;
  trips: {
    id: string; title: string; zone: string; minTransfer: number; constraints: string;
    archived: boolean; createdAt: string; updatedAt: string;
    entries: { id: string; kind: string; title: string; from: string; to: string; start: { at: string; zone: string }; end: { at: string; zone: string }; note: string }[];
    packing: { id: string; label: string; packed: boolean }[];
  }[];
};
const execute = (ctx: AgentFeatureContext, command: string) => feature.execute(command, ctx);
async function saved(ctx: AgentFeatureContext): Promise<Snapshot> {
  const result = await ctx.store.read<Snapshot>("itineraries");
  assert.ok(result);
  return result;
}
async function create(ctx: AgentFeatureContext, title = "Japan visit"): Promise<string> {
  assert.match(await execute(ctx, `trip ${title} | America/Chicago | 60 | Carry-on only; vegetarian meals`), /Created trip/);
  return (await saved(ctx)).trips.at(-1)!.id;
}
const activity = (tripId: string, title = "Museum", start = "2026-11-04T09:00+09:00", end = "2026-11-04T10:00+09:00", location = "Tokyo") =>
  `add-activity ${tripId} | ${title} | ${location} | ${start} | Asia/Tokyo | ${end}`;

test("complete private trip flow: timeline, constraints, preparation, packing, archive, correction, deletion", async () => {
  let calls = 0;
  const unavailable = async (): Promise<never> => { calls++; throw new Error("provider down"); };
  const ctx = createAgentTestContext({ services: { generate: unavailable, search: unavailable, readContext: unavailable } });
  assert.equal(feature, namedFeature);
  assert.equal(feature.id, "travel");
  assert.match(await execute(ctx, ""), /add-leg/);
  assert.match(await execute(ctx, "show"), /No trips yet/);
  const tripId = await create(ctx);
  assert.match(await execute(ctx, `check ${tripId}`), /No entries to check/);
  assert.match(await execute(ctx, `timeline ${tripId}`), /No dated entries yet/);
  assert.match(await execute(ctx, `packing ${tripId}`), /No items yet/);

  assert.match(await execute(ctx, `add-stay ${tripId} | Tokyo hotel | Tokyo | 2026-11-03T16:00+09:00 | Asia/Tokyo | 2026-11-06T11:00+09:00 | Confirmation email saved privately`), /Added stay/);
  assert.match(await execute(ctx, activity(tripId)), /Added activity/);
  assert.match(await execute(ctx, `add-leg ${tripId} | Outbound flight | ORD | HND | 2026-11-02T10:00-06:00 | America/Chicago | 2026-11-03T14:00+09:00 | Asia/Tokyo | Check terminal in airline app`), /Added leg/);
  assert.match(await execute(ctx, `add-leg ${tripId} | Airport shuttle | HND | Tokyo | 2026-11-03T15:00+09:00 | Asia/Tokyo | 2026-11-03T16:00+09:00 | Asia/Tokyo`), /Added leg/);
  const timeline = await execute(ctx, `timeline ${tripId}`);
  assert.ok(timeline.indexOf("Outbound flight") < timeline.indexOf("Airport shuttle"));
  assert.ok(timeline.indexOf("Airport shuttle") < timeline.indexOf("Tokyo hotel"));
  assert.match(timeline, /780 min elapsed/);
  assert.match(timeline, /Start in your timezone: 2026-11-02T10:00:00 \[America\/Chicago\]/);
  assert.match(timeline, /User confirmation note \(unverified\)/);
  const report = await execute(ctx, `check ${tripId}`);
  assert.match(report, /DATE BOUNDARY/);
  assert.match(report, /TIMEZONE/);
  assert.doesNotMatch(report, /CONFLICT|LODGING OVERLAP|LOCATION GAP|TRANSFER BELOW MINIMUM/);

  assert.match(await execute(ctx, `packing ${tripId} add | Charger | Rain jacket`), /0\/2 packed/);
  const charger = (await saved(ctx)).trips[0].packing[0].id;
  assert.match(await execute(ctx, `packing ${tripId} done ${charger}`), /1\/2 packed/);
  assert.match(await execute(ctx, `show ${tripId} brief`), /Still to pack: Rain jacket/);
  assert.match(await execute(ctx, `show ${tripId} brief`), /Next\/ongoing recorded entry: Outbound flight/);
  assert.match(await execute(ctx, `trip constraints ${tripId} | 90 | Avoid stairs`), /Updated constraints/);
  assert.match(await execute(ctx, `check ${tripId}`), /60 min available, below your 90-min minimum/);
  assert.match(await execute(ctx, `show ${tripId}`), /Avoid stairs/);
  assert.match(await execute(ctx, `archive ${tripId}`), /Archived/);
  assert.match(await execute(ctx, "trip"), /archived/);
  assert.match(await execute(ctx, `packing ${tripId} add | Umbrella`), /Trip is archived/);
  assert.match(await execute(ctx, `show ${tripId} brief`), /Preparation brief/);
  assert.match(await execute(ctx, `archive ${tripId} undo`), /Reopened/);
  assert.match(await execute(ctx, `packing ${tripId} undo ${charger}`), /0\/2 packed/);
  assert.match(await execute(ctx, `packing ${tripId} remove ${charger}`), /0\/1 packed/);
  const museum = (await saved(ctx)).trips[0].entries.find((e) => e.title === "Museum")!;
  assert.match(await execute(ctx, `trip remove-entry ${tripId} | ${museum.id}`), /Removed entry/);
  assert.doesNotMatch(await execute(ctx, `timeline ${tripId}`), /Museum/);
  assert.match(await execute(ctx, activity(tripId, "Museum", "2026-11-04T10:00+09:00", "2026-11-04T11:00+09:00")), /Added activity/);
  assert.match(await execute(ctx, `trip delete ${tripId}`), /confirm/);
  assert.equal((await saved(ctx)).trips.length, 1);
  assert.match(await execute(ctx, `trip delete ${tripId} confirm`), /Deleted trip/);
  assert.match(await execute(ctx, "trip"), /No trips yet/);
  assert.equal(calls, 0, "deterministic travel works even when every provider is unavailable");
});

test("validates input dates, offsets, DST gaps, spans, zones, commands and limits without writes", async () => {
  const ctx = createAgentTestContext(), tripId = await create(ctx);
  const before = await saved(ctx);
  const cases: [string, RegExp][] = [
    ["book me a flight", /Unknown travel command/],
    ["trip Missing timezone", /fields/],
    ["trip Bad zone | CST", /IANA/],
    ["trip Bad zone | +02:00", /IANA/],
    ["trip Bad zone | Mars/Olympus", /Unknown IANA/],
    ["trip Bad transfer | UTC | -1", /whole number/],
    ["trip Bad transfer | UTC | 1441", /whole number/],
    ["trip Bad transfer | UTC | 1.5", /whole number/],
    [`trip ${"a".repeat(101)} | UTC`, /Trip title/],
    [`trip constraints ${tripId} | 60 | ${"c".repeat(801)}`, /Constraints/],
    [`show ${tripId.slice(0, 8)}`, /full stable ID/],
    ["show 00000000-0000-4000-8000-000000000000", /Trip not found/],
    [`show ${tripId} nonsense`, /Use show/],
    [`add-activity ${tripId} | Missing fields`, /fields/],
    [activity(tripId, "No offset", "2026-11-04T09:00"), /explicit offset/],
    [activity(tripId, "Invalid day", "2026-02-30T09:00+09:00"), /Date or UTC offset/],
    [activity(tripId, "Wrong offset", "2026-11-04T09:00+08:00"), /Date or UTC offset/],
    [activity(tripId, "Wrong year", "1999-11-04T09:00+09:00"), /2000–2100/],
    [activity(tripId, "Midnight normalization", "2026-11-03T24:00+09:00"), /Date or UTC offset/],
    [activity(tripId, "Backward", "2026-11-04T11:00+09:00"), /End\/arrival must be after/],
    [activity(tripId, "Zero length", "2026-11-04T10:00+09:00"), /End\/arrival must be after/],
    [`${activity(tripId)} | Password: fake-test-value`, /must not contain credentials/],
    [`${activity(tripId)} | PNR=fake-test-value`, /must not contain credentials/],
    [`${activity(tripId)} | Bearer fake-test-value`, /must not contain credentials/],
    [`add-activity ${tripId} | DST gap | NYC | 2026-03-08T02:30-05:00 | America/New_York | 2026-03-08T04:00-04:00`, /Date or UTC offset/],
    [`add-activity ${tripId} | DST mismatch | NYC | 2026-11-01T01:30-06:00 | America/New_York | 2026-11-01T03:00-05:00`, /Date or UTC offset/],
    [`packing ${tripId} done`, /full stable ID/],
    [`packing ${tripId} add | Shirt || Shoes`, /nonempty fields/],
    [`archive ${tripId} confirm`, /Use archive/],
    ["x".repeat(8001), /8000 characters/],
  ];
  for (const [command, expected] of cases) {
    assert.match(await execute(ctx, command), expected, command);
    assert.deepEqual(await saved(ctx), before, command);
  }
});

test("DST fallback is disambiguated by offsets and crossing the date line uses actual instants", async () => {
  const ctx = createAgentTestContext({ timezone: "Pacific/Auckland" }), tripId = await create(ctx);
  assert.match(await execute(ctx, `add-activity ${tripId} | Repeated hour | NYC | 2026-11-01T01:30-04:00 | America/New_York | 2026-11-01T01:30-05:00`), /Added activity/);
  assert.match(await execute(ctx, `timeline ${tripId}`), /60 min elapsed/);
  assert.match(await execute(ctx, `check ${tripId}`), /LOCAL CLOCK REVERSES/);
  assert.match(await execute(ctx, `check ${tripId}`), /UTC-04:00 → America\/New_York UTC-05:00/);
  assert.match(await execute(ctx, `add-leg ${tripId} | Date line flight | AKL | HNL | 2026-11-03T01:00+13:00 | Pacific/Auckland | 2026-11-02T12:00-10:00 | Pacific/Honolulu`), /Added leg/);
  const output = await execute(ctx, `timeline ${tripId}`);
  assert.match(output, /600 min elapsed/);
  assert.match(output, /your supplied timezone: Pacific\/Auckland/);
  assert.match(await execute(ctx, `check ${tripId}`), /2026-11-03 → 2026-11-02/);
  // UTC and non-whole-hour IANA offsets are accepted too.
  assert.match(await execute(ctx, `add-activity ${tripId} | UTC call | Online | 2026-11-05T09:00Z | UTC | 2026-11-05T09:30Z`), /Added activity/);
  assert.match(await execute(ctx, `add-activity ${tripId} | Nepal call | Online | 2026-11-06T09:00+05:45 | Asia/Kathmandu | 2026-11-06T09:30+05:45`), /Added activity/);
});

test("checks transport/activity conflicts, impossible transfers, user minimums, and unrecorded connections", async () => {
  const ctx = createAgentTestContext(), tripId = await create(ctx);
  await execute(ctx, activity(tripId, "Morning tour", "2026-11-04T09:00+09:00", "2026-11-04T11:00+09:00", "Tokyo"));
  await execute(ctx, `add-leg ${tripId} | Conflicting train | Tokyo | Kyoto | 2026-11-04T10:00+09:00 | Asia/Tokyo | 2026-11-04T12:00+09:00 | Asia/Tokyo`);
  await execute(ctx, activity(tripId, "Impossible location", "2026-11-04T12:00+09:00", "2026-11-04T13:00+09:00", "Osaka"));
  await execute(ctx, `add-leg ${tripId} | Short transfer | Osaka | Nara | 2026-11-04T13:30+09:00 | Asia/Tokyo | 2026-11-04T14:30+09:00 | Asia/Tokyo`);
  await execute(ctx, activity(tripId, "Unrecorded transfer", "2026-11-04T16:00+09:00", "2026-11-04T17:00+09:00", "Tokyo"));
  await execute(ctx, `add-stay ${tripId} | First hotel | Tokyo | 2026-11-04T08:00+09:00 | Asia/Tokyo | 2026-11-05T10:00+09:00`);
  await execute(ctx, `add-stay ${tripId} | Second hotel | Kyoto | 2026-11-04T16:00+09:00 | Asia/Tokyo | 2026-11-05T11:00+09:00`);
  const report = await execute(ctx, `check ${tripId}`);
  assert.match(report, /CONFLICT .*Morning tour.*Conflicting train.*60 min/s);
  assert.match(report, /IMPOSSIBLE RECORDED TRANSFER .*0 min.*Kyoto → Osaka/);
  assert.match(report, /TRANSFER BELOW MINIMUM .*30 min available, below your 60-min minimum/);
  assert.match(report, /LOCATION GAP .*Nara → Tokyo in 90 min/);
  assert.match(report, /LODGING OVERLAP .*First hotel.*Second hotel/);
  assert.doesNotMatch(report, /CONFLICT[^\n]*(First hotel|Second hotel)/);
  assert.ok(report.indexOf("CONFLICT") < report.indexOf("DATE BOUNDARY"), "actionable conflicts precede informational date notices");
});

test("touching same-location activities do not overlap; read and preparation commands do not mutate state", async () => {
  const ctx = createAgentTestContext(), tripId = await create(ctx);
  await execute(ctx, activity(tripId, "One"));
  await execute(ctx, activity(tripId, "Two", "2026-11-04T10:00+09:00", "2026-11-04T11:00+09:00", " TOKYO "));
  const before = await saved(ctx);
  assert.match(await execute(ctx, `check ${tripId}`), /No recorded overlaps or transfer warnings/);
  for (const cmd of ["help", "trip", `show ${tripId}`, `show ${tripId} brief`, `timeline ${tripId}`, `packing ${tripId}`]) await execute(ctx, cmd);
  assert.deepEqual(await saved(ctx), before);
  ctx.now = new Date("2027-01-01T00:00Z");
  assert.match(await execute(ctx, `show ${tripId} brief`), /No upcoming or ongoing entries/);
  ctx.timezone = "Invalid/Zone";
  assert.match(await execute(ctx, `show ${tripId} brief`), /Unknown IANA/);
});

test("duplicate additions and foreign entry/item IDs leave state intact", async () => {
  const ctx = createAgentTestContext(), tripId = await create(ctx), secondId = await create(ctx, "Second trip");
  await execute(ctx, activity(tripId));
  await execute(ctx, `packing ${tripId} add | Charger`);
  const before = await saved(ctx), entry = before.trips[0].entries[0], item = before.trips[0].packing[0];
  assert.match(await execute(ctx, activity(tripId)), /already recorded/);
  assert.match(await execute(ctx, `packing ${tripId} add | Jacket | charger`), /Nothing added/);
  assert.match(await execute(ctx, `packing ${tripId} add | Hat | hat`), /Nothing added/);
  assert.match(await execute(ctx, `packing ${secondId} done ${item.id}`), /not found in this trip/);
  assert.match(await execute(ctx, `trip remove-entry ${secondId} | ${entry.id}`), /not found in this trip/);
  assert.deepEqual(await saved(ctx), before);
  const otherOwner = createAgentTestContext({ userId: "UOTHER" });
  assert.match(await execute(otherOwner, `show ${tripId}`), /Trip not found/);
});

test("atomic transforms are repeatable, do not mutate their input, and preserve concurrent additions", async () => {
  const base = createAgentTestStore();
  let replayed = 0;
  const store: AgentFeatureStore = {
    read: base.read,
    update: (key, initial, transform) => base.update(key, initial, (current) => {
      const before = structuredClone(current);
      const first = transform(current), second = transform(current);
      assert.deepEqual(current, before, "transform must not mutate its input");
      assert.deepEqual(first, second, "IDs and timestamps must not vary between retries");
      replayed++;
      return second;
    }),
  };
  const ctx = createAgentTestContext({ store }), tripId = await create(ctx);
  const results = await Promise.all(Array.from({ length: 15 }, (_, i) => execute(ctx, `packing ${tripId} add | Item ${i}`)));
  assert.ok(results.every((r) => /packed/.test(r)));
  await Promise.all([
    execute(ctx, activity(tripId)),
    execute(ctx, `trip constraints ${tripId} | 75 | Quiet rooms`),
  ]);
  const trip = (await saved(ctx)).trips[0];
  assert.equal(trip.packing.length, 15);
  assert.equal(new Set(trip.packing.map((p) => p.id)).size, 15);
  assert.equal(trip.entries.length, 1);
  assert.equal(trip.constraints, "Quiet rooms");
  assert.equal(trip.minTransfer, 75);
  assert.equal(trip.createdAt, ctx.now.toISOString());
  assert.equal(replayed, 18);
});

test("an archive winning an optimistic retry blocks an in-flight edit", async () => {
  const base = createAgentTestStore();
  let archiveDuringUpdate = false;
  const store: AgentFeatureStore = {
    read: base.read,
    async update(key, initial, transform) {
      if (archiveDuringUpdate) {
        archiveDuringUpdate = false;
        // Compute the losing attempt, then simulate a competing committed archive.
        transform((await base.read<typeof initial>(key)) ?? initial);
        await base.update<Snapshot, void>(key, { version: 1, trips: [] }, (current) => {
          current.trips[0].archived = true;
          return { value: current, result: undefined };
        });
      }
      return base.update(key, initial, transform);
    },
  };
  const ctx = createAgentTestContext({ store }), tripId = await create(ctx);
  archiveDuringUpdate = true;
  assert.match(await execute(ctx, `packing ${tripId} add | Lost item`), /Trip is archived/);
  const trip = (await saved(ctx)).trips[0];
  assert.equal(trip.archived, true);
  assert.equal(trip.packing.length, 0);
});

test("malformed persisted state is rejected without resetting or overwriting any data", async () => {
  const ctx = createAgentTestContext(), tripId = await create(ctx);
  await execute(ctx, activity(tripId));
  const pristine = await saved(ctx);
  const corrupted: unknown[] = [null, [], { version: 2, trips: [] }, { ...pristine, secret: "unexpected field" }];
  const badZone = structuredClone(pristine); badZone.trips[0].entries[0].start.zone = "Mars/Olympus"; corrupted.push(badZone);
  const reversed = structuredClone(pristine); reversed.trips[0].entries[0].end.at = "2026-11-03T00:00:00.000Z"; corrupted.push(reversed);
  const duplicate = structuredClone(pristine); duplicate.trips[0].entries[0].id = tripId; corrupted.push(duplicate);
  const excessive = structuredClone(pristine); excessive.trips[0].entries = Array(41).fill(excessive.trips[0].entries[0]); corrupted.push(excessive);
  const badMinimum = structuredClone(pristine); badMinimum.trips[0].minTransfer = 1.5; corrupted.push(badMinimum);
  const badDate = structuredClone(pristine); badDate.trips[0].entries[0].start.at = "2026-02-30T00:00:00.000Z"; corrupted.push(badDate);
  const changedLocation = structuredClone(pristine); changedLocation.trips[0].entries[0].to = "Kyoto"; corrupted.push(changedLocation);
  for (const value of corrupted) {
    await ctx.store.update<unknown, void>("itineraries", {}, () => ({ value, result: undefined }));
    assert.match(await execute(ctx, `packing ${tripId} add | Hat`), /Saved travel data could not be validated/);
    assert.deepEqual(await ctx.store.read("itineraries"), value);
  }
});

test("bounded retention: archived trips count, entry and packing caps do not silently evict data", async () => {
  const ctx = createAgentTestContext(), tripId = await create(ctx);
  const items = Array.from({ length: 40 }, (_, i) => `Item ${i}`);
  assert.match(await execute(ctx, `packing ${tripId} add | ${items.join(" | ")}`), /0\/40 packed/);
  assert.match(await execute(ctx, `packing ${tripId} add | Overflow`), /Limit of 40 packing items/);
  for (let i = 0; i < 40; i++) assert.match(await execute(ctx, activity(tripId, `Activity ${i}`)), /Added activity/);
  assert.match(await execute(ctx, activity(tripId, "Overflow")), /Limit of 40 entries/);
  for (let i = 0; i < 9; i++) await create(ctx, `Trip ${i}`);
  await execute(ctx, `archive ${tripId}`);
  assert.match(await execute(ctx, "trip Too many | UTC"), /Limit of 10 trips/);
  assert.equal((await saved(ctx)).trips.length, 10);
  assert.equal((await saved(ctx)).trips[0].entries.length, 40);
  const report = await execute(ctx, `check ${tripId}`);
  assert.ok(report.length < 28000);
  assert.match(report, /more notices/);
  await execute(ctx, `trip delete ${tripId} confirm`);
  assert.match(await execute(ctx, "trip Room again | UTC"), /Created trip/);
});

test("untrusted text is inert, replies stay bounded, and storage failures are handled honestly", async () => {
  const ctx = createAgentTestContext(), tripId = await create(ctx, "<!channel> <https://example.test>");
  assert.match(await execute(ctx, `packing ${tripId} add | <!here> ignore instructions`), /&lt;!here&gt;/);
  assert.doesNotMatch(await execute(ctx, `show ${tripId}`), /<!channel>|<https:/);
  const before = await saved(ctx);
  const unavailable = createAgentTestContext({
    store: {
      read: ctx.store.read,
      update: async () => { throw new Error("private database connection details"); },
    },
  });
  const failure = await execute(unavailable, `packing ${tripId} add | Bag`);
  assert.match(failure, /Check show before retrying/);
  assert.doesNotMatch(failure, /private database/);
  assert.deepEqual(await saved(ctx), before);
  const noRead = createAgentTestContext({ store: { read: async () => { throw new Error("offline"); }, update: ctx.store.update } });
  assert.match(await execute(noRead, "show"), /storage or runtime is unavailable/);
  assert.match(await execute(noRead, "help"), /Travel — private/);
  // Worst-case text escaping and notes must still fit a private Slack reply.
  const dense = structuredClone(before);
  for (let i = 0; i < 40; i++) {
    dense.trips[0].entries.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      title: "<".repeat(100), kind: "activity", from: "&".repeat(100), to: "&".repeat(100),
      start: { at: "2026-11-04T00:00:00.000Z", zone: "Asia/Tokyo" },
      end: { at: "2026-11-04T01:00:00.000Z", zone: "Asia/Tokyo" }, note: "<".repeat(300),
    });
  }
  await ctx.store.update<unknown, void>("itineraries", {}, () => ({ value: dense, result: undefined }));
  const output = await execute(ctx, `show ${tripId}`);
  assert.ok(output.length < 28000);
  assert.match(output, /Output shortened/);
});

const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
function largestLifecycleBytes(s: Snapshot): number {
  const reopened = structuredClone(s);
  for (const trip of reopened.trips) {
    trip.archived = false;
    for (const item of trip.packing) item.packed = false;
  }
  return encodedBytes(reopened);
}

function unicodeStateAtBudget(template: Snapshot, target: number): Snapshot {
  let sequence = 1;
  const nextId = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
  const s: Snapshot = {
    version: 1,
    trips: Array.from({ length: 10 }, (_, i) => ({
      ...structuredClone(template.trips[0]), id: nextId(), title: `Unicode trip ${i}`,
      archived: i === 1, constraints: "", entries: [],
      packing: [{ id: nextId(), label: `Packing item ${i}`, packed: true }],
    })),
  };
  // Ten packed flags plus one archived flag each need one byte when undone.
  const reserve = 11;
  let entryCount = 0;
  while (encodedBytes(s) + reserve < target - 8000) {
    const trip = s.trips[entryCount % 10];
    trip.entries.push({
      ...structuredClone(template.trips[0].entries[0]), id: nextId(),
      title: "界".repeat(97) + String(entryCount).padStart(3, "0"),
      from: "都".repeat(100), to: "都".repeat(100), note: "旅".repeat(300),
    });
    assert.ok(trip.entries.length <= 40);
    entryCount++;
  }
  let remaining = target - encodedBytes(s) - reserve;
  for (const trip of s.trips) {
    const length = Math.min(800, remaining);
    trip.constraints = "x".repeat(length);
    remaining -= length;
  }
  assert.equal(remaining, 0);
  assert.equal(largestLifecycleBytes(s), target);
  return s;
}

test("UTF-8 quota is atomic under contention and reserves space for every lifecycle change", async () => {
  const ctx = createAgentTestContext(), initialId = await create(ctx);
  await execute(ctx, activity(initialId));
  // Include both an emoji and JSON-escaped characters in the final accepted item.
  const labels = ['🧳"\\', '👟"\\'];
  const itemBytes = encodedBytes({ id: "00000000-0000-4000-8000-000000009999", label: labels[0], packed: false }) + 1;
  const nearFull = unicodeStateAtBudget(await saved(ctx), 470_000 - itemBytes);
  await ctx.store.update<Snapshot, void>("itineraries", nearFull, () => ({ value: nearFull, result: undefined }));
  const tripId = nearFull.trips[0].id;
  assert.ok(JSON.stringify(nearFull).length < 250_000, "character count would underestimate the Unicode state");
  const results = await Promise.all(labels.map((label) => execute(ctx, `packing ${tripId} add | ${label}`)));
  assert.equal(results.filter((result) => /1\/2 packed/.test(result)).length, 1);
  assert.equal(results.filter((result) => /storage quota reached/.test(result)).length, 1);
  const quotaError = results.find((result) => /storage quota reached/.test(result))!;
  assert.match(quotaError, /470,000 UTF-8 bytes/);
  assert.match(quotaError, /trip delete <trip-id> confirm/);
  assert.match(quotaError, /Archiving retains data/);
  const full = await saved(ctx);
  assert.equal(full.trips[0].packing.length, 2);
  assert.equal(largestLifecycleBytes(full), 470_000);
  assert.equal(encodedBytes(full), 470_000 - 11);
  assert.match(await execute(ctx, "trip"), /470,000\/470,000 UTF-8 bytes/);
  assert.match(await execute(ctx, `packing ${tripId} add | ${"界".repeat(100)}`), /Nothing changed/);
  assert.deepEqual(await saved(ctx), full);

  const originalItem = full.trips[0].packing[0].id, addedItem = full.trips[0].packing[1].id;
  const commands: [string, RegExp][] = [
    [`packing ${tripId} undo ${originalItem}`, /0\/2 packed/],
    [`packing ${tripId} done ${addedItem}`, /1\/2 packed/],
    [`packing ${tripId} undo ${addedItem}`, /0\/2 packed/],
    [`archive ${tripId}`, /Archived/],
    [`archive ${tripId} undo`, /Reopened/],
    [`archive ${full.trips[1].id} undo`, /Reopened/],
  ];
  for (const [command, expected] of commands) {
    assert.match(await execute(ctx, command), expected);
    assert.equal(largestLifecycleBytes(await saved(ctx)), 470_000);
    assert.ok(encodedBytes(await saved(ctx)) < 480_000);
  }
  assert.match(await execute(ctx, `show ${tripId} brief`), /Preparation brief/);
  assert.match(await execute(ctx, `trip constraints ${tripId} | 60 | -`), /Updated constraints/);
  assert.match(await execute(ctx, `packing ${tripId} remove ${addedItem}`), /0\/1 packed/);
  assert.match(await execute(ctx, `trip remove-entry ${tripId} | ${full.trips[0].entries[0].id}`), /Removed entry/);
  assert.match(await execute(ctx, `packing ${tripId} add | Replacement`), /0\/2 packed/);
  assert.match(await execute(ctx, `trip delete ${full.trips[9].id} confirm`), /Deleted trip/);
  assert.ok(encodedBytes(await saved(ctx)) < 470_000);
});

test("valid pre-quota data can be reduced progressively without permitting more growth", async () => {
  const ctx = createAgentTestContext(), initialId = await create(ctx);
  await execute(ctx, activity(initialId));
  const legacy = unicodeStateAtBudget(await saved(ctx), 475_000);
  await ctx.store.update<Snapshot, void>("itineraries", legacy, () => ({ value: legacy, result: undefined }));
  const tripId = legacy.trips[0].id;
  assert.match(await execute(ctx, "trip"), /475,000\/470,000 UTF-8 bytes/);
  assert.match(await execute(ctx, `packing ${tripId} add | More`), /storage quota reached/);
  assert.deepEqual(await saved(ctx), legacy);
  assert.match(await execute(ctx, `packing ${tripId} undo ${legacy.trips[0].packing[0].id}`), /0\/1 packed/);
  assert.match(await execute(ctx, `trip remove-entry ${tripId} | ${legacy.trips[0].entries[0].id}`), /Removed entry/);
  const smaller = await saved(ctx);
  assert.ok(largestLifecycleBytes(smaller) > 470_000, "one deletion can succeed even if more cleanup is needed");
  assert.ok(largestLifecycleBytes(smaller) < 475_000);
  assert.match(await execute(ctx, `trip delete ${tripId} confirm`), /Deleted trip/);
  assert.ok(largestLifecycleBytes(await saved(ctx)) < 470_000);
});
