# Small personal-agent authoring toolkit

These pure helpers support feature-specific implementations; they do not add an agent, commands, a store schema, authorization, services, or background work. Import individual modules from `lib/agent-features/feature-kit/`. They import no feature implementations, runtime, providers, or storage; only `evidence.ts` imports Node's built-in crypto module. The unchanged entrypoint remains `AgentFeature.execute(command, context)`.

## Commands and complete replies

[`command-and-display.ts`](../../lib/agent-features/feature-kit/command-and-display.ts) exports:

```ts
type TextLimit = {
  label: string; maxBytes: number; maxUnits?: number;
  trim?: boolean; allowEmpty?: boolean;
};
boundedText(value: unknown, limit: TextLimit): string;
pipeFields(input: string, limits: readonly TextLimit[]): string[];
type NumberLimit = { min: number; max: number; label?: string };
parseInteger(input: string, limit: NumberLimit): number;
parseDecimal(input: string, limit: NumberLimit): number;
parsePage(input?: string): number;

type DisplayMode = "plain" | "mrkdwn";
renderText(text: string, mode: DisplayMode): string;
type DisplayPart = { text: string; atomic?: boolean };
type DisplayPage = {
  text: string; body: string; page: number; total: number; nextCommand?: string;
};
type PaginationOptions = {
  mode: DisplayMode; command: (page: number) => string;
  title?: string; maxUnits?: number;
};
paginateParts(parts: readonly DisplayPart[], options: PaginationOptions): DisplayPage[];
pageAt(pages: readonly DisplayPage[], page: number): DisplayPage;
```

`boundedText` rejects rather than clips. It checks incoming UTF-8 bytes and JavaScript string units before optional trimming. Default `maxUnits` is `maxBytes`. It rejects lone surrogates and controls other than tab/newline/carriage return. Set `trim: false` to retain accepted text exactly. A domain may impose stricter single-line/content rules.

`pipeFields` accepts **only** `\|` for a literal pipe and `\\` for a literal backslash. Unescaped pipes separate fields; the decoded count must match `limits.length` exactly. Unknown escapes and a trailing backslash fail. Input is bounded to 48,000 units and 1–32 fields; decoded fields each pass their own `TextLimit`. For example, raw `Plan \| review | C:\\notes` becomes `Plan | review` and `C:\notes`. The feature parses its own verb, IDs, optional fields, and page syntax; `parsePage` takes only the numeric token, defaults to 1, and accepts 1–10,000. Numbers reject whitespace, leading zeros, exponents, `+`, negative zero, and trailing text. Decimal results are JavaScript numbers; domain-specific precision remains the author's responsibility.

Existing slash replies set `mrkdwn: false`: use **`mode: "plain"`**, with no HTML entity escaping. Use `mrkdwn` only for a surface actually rendered that way; it escapes `&`, `<`, and `>`. It is not a sanitizer for all Markdown formatting. Pass raw text once; pre-escaping would double-escape retained values.

`NORMAL_REPLY_UNITS` is 3,500. Pagination counts the escaped title, page counter, body, and complete next command in this budget. All pages' raw `body` strings concatenate to the exact input. Prose splits at code-point boundaries without creating lone surrogates; combining sequences may cross a page boundary. Mark **every known identifier, URL, and entire command** `atomic: true`, including IDs in JSON/detail views. The helper also protects HTTP(S) tokens and `/nobo-help` command lines found in prose. It cannot discover arbitrary domain identifiers hidden in prose.

```ts
const pages = paginateParts([
  { text: `Record ${record.id}\n`, atomic: true },
  { text: record.description },
  { text: `\n${record.sourceUrl}\n`, atomic: true },
], {
  mode: "plain",
  title: `Saved detail · revision ${record.revision}`,
  command: page => `/nobo-help agent sample show ${record.id} page ${page}`,
});
return pageAt(pages, parsePage(pageToken)).text;
```

The example's `sample` feature/record are placeholders; implement that feature's actual parser and continuation command. Callback execution is synchronous and must be pure. Pages do not save data, refresh sources, or freeze a changing list: authors supply stable ordering, ID tie-breaks, snapshot/revision rules, and any row/range/count labels. For lists, construct atomic rows and retain a separate reopen-by-ID path. Return only the requested page.

Budgets must be integer 32–3,500 units. One operation accepts at most 4,096 input parts and 262,144 input units, with at most 10,000 output pages. An oversized atomic value or header/continuation fails with actionable guidance; it is never split or dropped. Validate the worst-case rendering before admitting a value that must remain retrievable. Smaller titles/commands can make room; beyond 3,500, reject or narrow the accepted input. No byte-size claim is implied for a 3,500-unit reply.

## State admission inside synchronous transforms

[`bounded-state.ts`](../../lib/agent-features/feature-kit/bounded-state.ts) exports:

```ts
type StateLimits = {
  maxBytes: number; contentBytes: number; maxRecordBytes: number; maxRecords: number;
};
serializedBytes(value: unknown): number;
assertStateVersion(value: unknown, version: number): asserts value is
  Record<string, unknown> & { version: number };
assertRevision(actual: unknown, expected: unknown): void;
type QuotaCheck = { records: readonly unknown[]; limits?: Partial<StateLimits> } & (
  | { kind: "content"; future: { value: unknown; records: readonly unknown[] } }
  | { kind: "lifecycle" }
);
assertQuota(value: unknown, check: QuotaCheck): void;
```

`DEFAULT_STATE_LIMITS` is 49,152 total serialized UTF-8 bytes, 32,768 for new content, 24,576 per record, and 12 root records. The 16,384-byte margin is a default, **not proof of lifecycle capacity**. Supply your catalog limits explicitly when they differ. `maxBytes` cannot exceed the actual store's 512,000-byte ceiling. Count nested children and field/history limits in the domain schema; pass the actual complete root records, including any export envelope needed within the record bound.

`serializedBytes` counts `JSON.stringify` UTF-8 bytes including quotes/escaping. It rejects undefined, nonfinite numbers, bigint, sparse arrays, custom objects/serialization, accessors, symbols, cycles, and malformed Unicode instead of accepting JSON's silent coercions. Traversal is bounded to depth 24 and 50,000 values. Repeated noncyclic references are permitted. These helpers never mutate inputs or persisted state.

`assertStateVersion` checks **only the version envelope**. Always validate the complete feature schema, stable/unique IDs, dates, statuses, revisions, and nested values afterward, including before deletion. Never recover malformed JSON/state by substituting an empty initial state. The actual store uses `initial` only for an absent key.

```ts
return context.store.update("state", initialState, raw => {
  assertStateVersion(raw, 1);
  const current = validateDomainState(raw); // your full validator
  const next = applyDomainChange(current, parsedInput); // your pure transform
  const future = worstCaseLifecycle(next); // your bounded, explicit projection
  assertQuota(next, {
    kind: "content", records: next.records, limits,
    future: { value: future, records: future.records },
  });
  return { value: next, result: savedAcknowledgement };
});
```

The **author supplies** a worst-case projection containing all records and all promised remaining lifecycle fields, including revision growth, completion/status/preview/checkpoint space and JSON overhead. The helper checks that projection's full-state and per-record bytes; it cannot infer the projection, prove it is conservative, or discover omitted records. Test completing an admitted near-quota record. Optional large notes are new content, not lifecycle reserve. For a promised lifecycle transition, use `kind: "lifecycle"` with the actual next records. Check all admissions within the synchronous CAS transform, because it may rerun against concurrent edits.

Compute random IDs, time values, and service results outside transforms. Validate the current revision/attempt token again inside a saving transform. `assertRevision` rejects nonpositive/unsafe/mismatching revisions; it does not increment revisions, authenticate the caller, or implement deletion/preview policies. No helper performs I/O or accepts an asynchronous transform.

Malformed and previously valid data remain untouched on failure. Do not use admission quotas as read validators or unconditional gates on a size-reducing deletion: runtime-readable legacy data must remain inspectable/deletable after full domain validation. No automatic eviction, reset, cache, or history trimming is provided.

## Bounded evidence snapshots

[`evidence.ts`](../../lib/agent-features/feature-kit/evidence.ts) exports:

```ts
type EvidenceOptions = {
  kinds: readonly AgentContextKind[];
  maxItems?: number; maxBytes?: number; metadataKeys?: readonly string[];
};
type EvidenceSnapshot = { version: 1; sources: AgentContextItem[]; fingerprint: string };
captureEvidence(items: readonly unknown[], options: EvidenceOptions): EvidenceSnapshot;
```

Pass an already selected permitted subset from `readContext`, with the feature's declared kinds. This helper does not fetch, silently select, authorize, follow links, access sibling stores, or manufacture provenance. It validates the known `AgentContextItem` shape, requires exact bounded source IDs, rejects unexpected top-level fields/foreign kinds, and rejects duplicate kind+ID pairs or the same ID across different kinds. It cannot identify an unauthorized record masquerading as a well-formed source; authorization remains the runtime/adapter's job. User-supplied citations need their own explicit domain representation and validator; do not relabel them as adapter evidence.

Known fields are ID/kind/title/text, optional update/due dates, status, credential-free HTTP(S) source URL, and explicitly selected metadata. Source IDs, URLs (including query order/escapes/fragments), and civil due dates are retained exactly. Offset instants normalize to UTC. Metadata values are copied, not aliased to the source response. Unknown update/publication times remain absent. Select relevant dated/numeric/status/provenance metadata keys; arrays retain their order, so normalize genuinely set-like fields deliberately before capture.

`coverage`, `textTruncated`, and `titleTruncated` are automatically retained when supplied by the adapter. Their changes affect the fingerprint. Requested metadata keys cannot include `readAt`, `observedAt`, `capturedAt`, or `enumerationIndex`. Unselected observation metadata is excluded from the digest. Do not select a nested wrapper that mixes observation time into meaningful fields. Validate the entire incoming JSON shape before projection; unsupported/cyclic unselected metadata also fails.

Canonical SHA-256 fingerprints start `e1:`. Source order is deterministic by kind then ID, object keys are sorted, and the schema version, declared kind scope and selected metadata keys are included. Reordering the same source set or object keys is stable; changes in meaningful fields/scope are detectable. A fingerprint is **not authorization** or proof of source truth. Record capture time separately and label excerpt-only coverage; a digest cannot detect changes outside a supplied excerpt. Refresh/current-source confirmation must reread the declared scope, compare evidence and local revisions, and preserve prior data on read/validation failure.

Defaults: 40 sources and 24,576 serialized bytes for the selected canonical envelope (including scope/schema). Configurable bounds are 0–200 items and 64–196,608 bytes; full incoming source JSON is at most 65,536 bytes each. IDs are at most 256 UTF-8 bytes, titles 4,096, text 49,152, status 128, and URLs 2,048. At most 32 explicitly selected unique metadata keys are allowed. Author/catalog limits may be smaller. All bounds reject; none clip.

## Civil dates and explicit instants

[`civil-time.ts`](../../lib/agent-features/feature-kit/civil-time.ts) exports:

```ts
civilDate(value: unknown): string;
addCivilDays(value: string, days: number): string;
compareCivilDates(a: string, b: string): -1 | 0 | 1;
civilDaysBetween(start: string, end: string): number;
normalizeInstant(value: unknown): string;
dateInZone(now: Date, zone: string): string;
civilRange(start: string, endExclusive: string): { start: string; endExclusive: string };
instantRange(start: string, end?: string): { start: string; end: string; point: boolean };
```

Civil labels use valid Gregorian `YYYY-MM-DD`, years 0000–9999, without timezone conversion. Arithmetic counts whole calendar days, including across leap/DST dates. Internal UTC arithmetic coordinates are never exposed as event instants. Differences are signed `end − start`; out-of-range dates/arithmetic reject.

Instants require `T`, hours/minutes, optional seconds with 1–3 fractional digits, and explicit `Z` or an offset within ±14:00. Invalid civil dates, 24:00, leap seconds, missing offsets, unknown `-00:00`, and UTC year overflow reject. No DST/local-wall-time resolution is invented. `dateInZone(context.now, context.timezone)` derives a civil label from the injected request clock and explicit IANA timezone; it never reads the process timezone or current time itself.

All-day ranges retain exclusive civil ends and must be nonempty. Missing or equal timed endpoints produce `point: true`; consumers must preserve their nonblocking nature. These primitives do not infer busy status, create schedules, select weekdays/holidays, or assign completion times.

## Tests and integration

[`agent-feature-fixture.ts`](../../tests/helpers/agent-feature-fixture.ts) exports `createMemoryAgentBackend`, `createAgentFeatureFixture`, `FeatureFixtureOptions`, and `deferred<T>()`. The small exact-CAS Map backend stores serialized JSON, tracks get/CAS/write/conflict counts, and supports `beforeGet`/`beforeCompareSet` hooks for deferred I/O or controlled contention. Its injected millisecond clock handles receipt TTLs. Seed malformed raw values through its explicit `data` Map only in corruption tests.

```ts
const fixture = createAgentFeatureFixture(feature, {
  now: new Date("2026-10-22T15:00:00Z"), timezone: "America/Chicago",
  services: { generate: async () => "fake draft" },
});
const reply = await fixture.run("create Example", { requestId: "unique-trigger" });
const state = await fixture.store().read("state");
```

`fixture.run(command, { owner?, requestId?, signal? })` uses real `runAgentFeature` with real `createAgentFeatureStore`; `fixture.store(scope?)` makes a fresh scoped store for setup/assertions. The fixture supplies no request ID unless requested, so test repeated invocations explicitly. `owner`, a fixed/function `now`, timezone, fake/throwing services, and backend are injectable. The default services throw and their calls are counted. No production backend/provider fallback is possible. This fixture does not emulate source adapters: source integration tests must inject dependencies into the actual production adapters.

The shared [kit suite](../../tests/agent-feature-kit.test.ts) covers decoded input, UTF-8/escaping, exact maximum-record pagination, complete continuations, source identity/date/status fingerprints, leap/timezone/point cases, atomic quota preservation, and representative real-runtime CAS/cancellation/receipt behavior. Feature authors still test their distinct schemas, commands, source transforms, lifecycle projection, stale generations, complete retrieval, and useful deterministic outcome. Optional generated suggestions remain unsaved unless the feature implements a separate reviewed apply flow. This toolkit adds no provider calls or provider token-ceiling contract.

Run with Node 24:

```sh
node --import tsx --test --test-concurrency=1 tests/agent-feature-kit.test.ts
npm run typecheck
git diff --check
```

Local fake-backed checks do not establish production performance, Slack delivery, live Redis behavior, or the pending release benchmark gate.
