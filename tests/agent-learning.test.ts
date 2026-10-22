import assert from "node:assert/strict";
import test from "node:test";
import learning, { feature } from "../lib/agent-features/learning.js";
import type { AgentFeatureContext, AgentFeatureStore } from "../lib/agent-features/types.js";
import { createAgentTestContext, createAgentTestStore } from "./agent-feature-test-utils.js";

const KEY = "learning:v1";
const MATERIAL = "DNS translates domain names to IP addresses. A resolver asks a name server for a record.";
type SavedCard = {
  id: string; question: string; answer: string; sourceId: string; origin: string;
  dueAt: string; intervalDays: number; reviews: number; lapses: number;
  lastRating: string | null; lastReviewedAt: string | null;
};
type SavedDeck = {
  id: string; revision: string; title: string; source: { id: string; text: string };
  cards: SavedCard[]; draft: { id: string; cards: Array<{ id: string }> } | null;
};
type SavedState = { version: number; decks: SavedDeck[]; session: { id: string; cardId: string; recall: string | null; revealedAt: string | null } | null };
const run = (context: AgentFeatureContext, command: string) => feature.execute(command, context);
async function saved(context: AgentFeatureContext): Promise<SavedState> {
  return (await context.store.read<SavedState>(KEY))!;
}
async function setup(context = createAgentTestContext()) {
  assert.match(await run(context, `create Networking | My class notes | ${MATERIAL}`), /Created deck/);
  const deck = (await saved(context)).decks[0];
  return { context, deckId: deck.id, sourceId: deck.source.id };
}
async function addCard(context: AgentFeatureContext, deckId: string, question = "What does DNS do?") {
  const result = await run(context, `card ${deckId} | ${question} | DNS translates domain names to IP addresses.`);
  assert.match(result, /Added and due now/);
  return (await saved(context)).decks.find((d) => d.id === deckId)!.cards.at(-1)!;
}
async function quiz(context: AgentFeatureContext, deckId = "") {
  const response = await run(context, `quiz ${deckId}`);
  const session = (await saved(context)).session;
  assert.ok(session, response);
  return { response, sessionId: session.id };
}
async function rate(context: AgentFeatureContext, deckId: string, rating: string) {
  const { sessionId } = await quiz(context, deckId);
  assert.match(await run(context, `reveal ${sessionId}`), /exact source excerpt/);
  return run(context, `rate ${sessionId} ${rating}`);
}
function fakeGenerator(context: AgentFeatureContext, produce?: (sourceId: string) => unknown) {
  context.services.generate = async ({ instructions, input }) => {
    assert.match(instructions, /untrusted data/);
    assert.match(instructions, /exact contiguous excerpt/);
    const { source } = JSON.parse(input) as { source: { id: string; text: string } };
    assert.equal(source.text, MATERIAL);
    return JSON.stringify(produce ? produce(source.id) : {
      cards: [{ question: "What does a resolver do?", answer: "A resolver asks a name server for a record.", sourceId: source.id }],
    });
  };
}

test("contract, help, empty and invalid commands work without services", async () => {
  assert.equal(learning, feature);
  assert.equal(feature.id, "learning");
  const context = createAgentTestContext();
  for (const key of ["generate", "readContext", "search"] as const) {
    context.services[key] = async () => { throw new Error("No service calls allowed"); };
  }
  assert.match(await run(context, ""), /create/);
  assert.match(await run(context, "help"), /Again = retry in 10 minutes/);
  for (const command of ["list", "due", "progress"]) assert.match(await run(context, command), /No learning decks/);
  assert.match(await run(context, "quiz"), /No accepted cards/);
  const before = await saved(context);
  for (const command of ["unknown", "list extra", "create title | label", "card", "rate x okay", "answer x", "show missing", "due missing", "delete x maybe"]) {
    const response = await run(context, command);
    assert.match(response, /Unknown|Use learning|must|Rate your|not found|To proceed/i, response);
  }
  assert.deepEqual(await saved(context), before);
  assert.match(await run(context, "x".repeat(12_001)), /at most 12,000/);
});

test("complete manual flow: source review, hidden quiz, recall, rating, next review and progress", async () => {
  const { context, deckId, sourceId } = await setup();
  const card = await addCard(context, deckId);
  assert.match(await run(context, `show ${deckId}`), /user supplied; not independently verified/);
  assert.ok((await run(context, `cards ${deckId}`)).includes(sourceId));
  const due = await run(context, `due ${deckId}`);
  assert.match(due, /1 card\(s\) due now/);
  assert.ok(!due.includes(card.answer));
  const { response, sessionId } = await quiz(context, deckId);
  assert.match(response, /What does DNS do/);
  assert.ok(!response.includes(card.answer));
  assert.equal((await quiz(context, deckId)).sessionId, sessionId);
  const before = await saved(context);
  assert.match(await run(context, `rate ${sessionId} good`), /before rating/);
  assert.deepEqual(await saved(context), before);
  const revealed = await run(context, `answer ${sessionId} | It maps names to IP addresses.`);
  assert.match(revealed, /Your recall: It maps names to IP addresses/);
  assert.ok(revealed.includes(card.answer));
  assert.ok(revealed.includes(sourceId));
  assert.match(revealed, /no automatic correctness judgment/);
  const afterReveal = await saved(context);
  assert.match(await run(context, `answer ${sessionId} | replacement`), /already revealed/);
  assert.deepEqual(await saved(context), afterReveal);
  assert.match(await run(context, `rate ${sessionId} good`), /Oct 23, 2026.*America\/Chicago/);
  const state = await saved(context);
  assert.equal(state.session, null);
  assert.equal(state.decks[0].cards[0].dueAt, "2026-10-23T15:00:00.000Z");
  assert.equal(state.decks[0].cards[0].intervalDays, 1);
  assert.equal(state.decks[0].cards[0].reviews, 1);
  assert.match(await run(context, `rate ${sessionId} easy`), /already rated/);
  assert.deepEqual(await saved(context), state);
  assert.match(await run(context, `quiz ${deckId}`), /No cards due now/);
  assert.match(await run(context, `progress ${deckId}`), /New: 0; practiced: 1; due now: 0/);
  assert.match(await run(context, "progress"), /Completed reviews: 1; again ratings: 0/);
  context.now = new Date(card.dueAt); // Creation time is still not due again.
  assert.match(await run(context, "due"), /No cards due now/);
  context.now = new Date("2026-10-23T15:00:00.000Z");
  assert.match(await run(context, "due"), /1 card\(s\) due now/);
  assert.notEqual((await quiz(context)).sessionId, sessionId);
});

test("deterministic spacing, again reset, boundary due times, and 365-day cap", async () => {
  const { context, deckId } = await setup();
  await addCard(context, deckId);
  const sequence: Array<[string, number]> = [["easy", 4], ["hard", 5], ["good", 10], ["again", 0], ["hard", 1], ["good", 2], ["easy", 6], ["easy", 18], ["easy", 54], ["easy", 162], ["easy", 365], ["good", 365]];
  for (const [rating, days] of sequence) {
    const start = context.now.getTime();
    assert.match(await rate(context, deckId, rating), /Recorded your recall/);
    const card = (await saved(context)).decks[0].cards[0];
    assert.equal(card.intervalDays, days);
    const dueTime = start + (rating === "again" ? 600_000 : days * 86_400_000);
    assert.equal(new Date(card.dueAt).getTime(), dueTime);
    context.now = new Date(dueTime - 1);
    assert.match(await run(context, `due ${deckId}`), /No cards due now/);
    context.now = new Date(dueTime);
    assert.match(await run(context, `due ${deckId}`), /1 card\(s\) due now/);
  }
  const card = (await saved(context)).decks[0].cards[0];
  assert.equal(card.reviews, sequence.length);
  assert.equal(card.lapses, 1);
});

test("elapsed-day scheduling crosses DST explicitly and uses the supplied timezone", async () => {
  const { context, deckId } = await setup(createAgentTestContext({ now: new Date("2026-10-31T15:00:00Z"), timezone: "America/Chicago" }));
  await addCard(context, deckId);
  const result = await rate(context, deckId, "good");
  assert.match(result, /Nov 1, 2026, 09:00 AM CST \(America\/Chicago\)/);
  assert.equal((await saved(context)).decks[0].cards[0].dueAt, "2026-11-01T15:00:00.000Z");
  const tokyo = await run({ ...context, timezone: "Asia/Tokyo" }, "due");
  assert.match(tokyo, /Nov 2, 2026, 12:00 AM.*Asia\/Tokyo/);
  const before = await saved(context);
  assert.match(await run({ ...context, timezone: "Not/AZone" }, `delete ${deckId} confirm`), /timezone is invalid/);
  assert.match(await run({ ...context, timezone: "" }, "list"), /timezone is required/);
  assert.match(await run({ ...context, now: new Date("bad") }, "list"), /valid current time/);
  assert.deepEqual(await saved(context), before);
});

test("generated suggestions require grounded JSON, complete preview and explicit acceptance", async () => {
  const { context, deckId, sourceId } = await setup();
  fakeGenerator(context);
  const output = await run(context, `draft ${deckId}`);
  assert.match(output, /Generated suggestions/);
  assert.match(output, /not yet quiz cards/);
  assert.ok(output.includes(sourceId));
  let state = await saved(context);
  assert.equal(state.decks[0].cards.length, 0);
  assert.equal(state.decks[0].draft!.cards.length, 1);
  const draftId = state.decks[0].draft!.id;
  const draftCardId = state.decks[0].draft!.cards[0].id;
  assert.equal(await run(context, `preview ${deckId}`), output);
  assert.match(await run(context, `quiz ${deckId}`), /No accepted cards/);
  assert.match(await run(context, "progress"), /Pending suggestions: 1/);
  assert.match(await run(context, `draft ${deckId}`), /already pending/);
  assert.match(await run(context, `accept ${deckId} wrong-id`), /no longer pending/);
  assert.match(await run(context, `accept ${deckId} ${draftId}`), /Accepted 1/);
  state = await saved(context);
  assert.equal(state.decks[0].draft, null);
  assert.equal(state.decks[0].cards[0].id, draftCardId);
  assert.equal(state.decks[0].cards[0].origin, "generated");
  assert.match(await run(context, `accept ${deckId} ${draftId}`), /no longer pending/);
  assert.match((await quiz(context, deckId)).response, /accepted generated suggestion/);
});

test("provider failures, invalid JSON, unsupported references and duplicates preserve state", async () => {
  const { context, deckId, sourceId } = await setup();
  const before = await saved(context);
  const goodCard = { question: "What does DNS do?", answer: "DNS translates domain names to IP addresses.", sourceId };
  const invalid = [
    "not json", "```json\n{}\n```", "x".repeat(8_001), JSON.stringify({ cards: [] }),
    JSON.stringify({ cards: [{ ...goodCard, sourceId: "00000000-0000-4000-8000-000000000001" }] }),
    JSON.stringify({ cards: [{ ...goodCard, answer: "DNS encrypts everything." }] }),
    JSON.stringify({ cards: [{ ...goodCard, question: "x".repeat(301) }] }),
    JSON.stringify({ cards: [goodCard, goodCard] }),
    JSON.stringify({ cards: [{ ...goodCard, command: "send something" }] }),
    JSON.stringify({ cards: [goodCard], sources: ["https://invented.invalid"] }),
  ];
  for (const generated of invalid) {
    context.services.generate = async () => generated;
    assert.match(await run(context, `draft ${deckId}`), /invalid|failed|not valid JSON/);
    assert.deepEqual(await saved(context), before);
  }
  context.services.generate = async () => { throw new Error("provider detail should not leak"); };
  const failure = await run(context, `draft ${deckId}`);
  assert.match(failure, /unavailable.*preserved/);
  assert.ok(!failure.includes("provider detail"));
  assert.deepEqual(await saved(context), before);
  await addCard(context, deckId);
  const afterCard = await saved(context);
  context.services.generate = async () => JSON.stringify({ cards: [goodCard] });
  assert.match(await run(context, `draft ${deckId}`), /duplicate/);
  assert.deepEqual(await saved(context), afterCard);
});

test("discard and confirmed delete clean up the source, pending draft and active quiz", async () => {
  const { context, deckId } = await setup();
  await addCard(context, deckId);
  fakeGenerator(context);
  await run(context, `draft ${deckId}`);
  const draftId = (await saved(context)).decks[0].draft!.id;
  assert.match(await run(context, `discard ${deckId} ${draftId}`), /Draft discarded/);
  assert.equal((await saved(context)).decks[0].cards.length, 1);
  await run(context, `draft ${deckId}`);
  await quiz(context, deckId);
  const before = await saved(context);
  assert.match(await run(context, `delete ${deckId}`), /To proceed/);
  assert.deepEqual(await saved(context), before);
  assert.match(await run(context, `delete ${deckId} confirm`), /Deleted deck/);
  assert.deepEqual(await saved(context), { version: 1, decks: [], session: null });
});

test("concurrent adds and duplicate ratings avoid lost updates and double advancement", async () => {
  const { context, deckId } = await setup();
  await Promise.all(Array.from({ length: 5 }, (_, index) => addCard(context, deckId, `Question ${index}?`)));
  assert.equal((await saved(context)).decks[0].cards.length, 5);
  const quizzes = await Promise.all([quiz(context, deckId), quiz(context, deckId)]);
  assert.equal(quizzes[0].sessionId, quizzes[1].sessionId);
  const sessionId = quizzes[0].sessionId;
  await run(context, `answer ${sessionId} | I remember.`);
  const replies = await Promise.all([run(context, `rate ${sessionId} good`), run(context, `rate ${sessionId} easy`)]);
  assert.equal(replies.filter((s) => s.includes("Recorded your recall")).length, 1);
  assert.equal(replies.filter((s) => s.includes("already rated")).length, 1);
  assert.equal((await saved(context)).decks[0].cards.reduce((n, c) => n + c.reviews, 0), 1);
  const next = await quiz(context, deckId);
  assert.notEqual(next.sessionId, sessionId);
  const before = await saved(context);
  assert.match(await run(context, `answer ${sessionId} | stale answer`), /no longer active/);
  assert.deepEqual(await saved(context), before);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("in-flight generation cannot overwrite a newer card, deletion, draft or cancellation", async () => {
  for (const mutation of ["card", "delete", "draft", "abort"] as const) {
    const { context, deckId, sourceId } = await setup();
    const pending = deferred<string>();
    const entered = deferred<void>();
    const controller = new AbortController();
    context.signal = controller.signal;
    const generated = JSON.stringify({ cards: [{ question: "Resolver?", answer: "A resolver asks a name server for a record.", sourceId }] });
    context.services.generate = async () => { entered.resolve(); return pending.promise; };
    const slowDraft = run(context, `draft ${deckId}`);
    await entered.promise;
    if (mutation === "card") await addCard(context, deckId);
    if (mutation === "delete") await run(context, `delete ${deckId} confirm`);
    if (mutation === "draft") {
      context.services.generate = async () => generated;
      assert.match(await run(context, `draft ${deckId}`), /Generated suggestions/);
    }
    if (mutation === "abort") controller.abort();
    const before = await saved(context);
    pending.resolve(generated);
    assert.match(await slowDraft, /stale result|not found|cancelled/);
    assert.deepEqual(await saved(context), before);
  }
});

test("optimistic retry transforms are pure with stable IDs and schedule results", async () => {
  const base = createAgentTestStore();
  let retries = 0;
  const store: AgentFeatureStore = {
    read: base.read,
    async update<T, R>(key: string, initial: T, transform: (current: T) => { value: T; result: R }): Promise<R> {
      return base.update(key, initial, (current) => {
        const original = structuredClone(current);
        const first = transform(current);
        assert.deepEqual(current, original, "transform must not mutate its input");
        const second = transform(current);
        assert.deepEqual(first, second, "retry must not generate IDs, sample time or call providers");
        retries++;
        return second;
      });
    },
  };
  const { context, deckId } = await setup(createAgentTestContext({ store }));
  await addCard(context, deckId);
  fakeGenerator(context);
  await run(context, `draft ${deckId}`);
  const draft = (await saved(context)).decks[0].draft!;
  await run(context, `accept ${deckId} ${draft.id}`);
  assert.match(await rate(context, deckId, "good"), /Recorded/);
  assert.ok(retries >= 7);
});

test("persisted data validation refuses invalid shapes and cross-source references without reset", async () => {
  const { context, deckId } = await setup();
  await addCard(context, deckId);
  const original = await saved(context);
  const corruptions: unknown[] = [
    { version: 2, decks: [], session: null },
    { ...original, unexpected: "extra payload" },
    { ...original, decks: [original.decks[0], original.decks[0]] },
    { ...original, decks: [{ ...original.decks[0], cards: [{ ...original.decks[0].cards[0], dueAt: "not a date" }] }] },
    { ...original, decks: [{ ...original.decks[0], cards: [{ ...original.decks[0].cards[0], dueAt: "2026-10-23T15:00:00.000Z" }] }] },
    { ...original, decks: [{ ...original.decks[0], cards: [{ ...original.decks[0].cards[0], answer: "invented" }] }] },
    { ...original, decks: [{ ...original.decks[0], cards: [{ ...original.decks[0].cards[0], sourceId: deckId }] }] },
    { ...original, decks: [{ ...original.decks[0], cards: [{ ...original.decks[0].cards[0], reviews: 1, lapses: 2 }] }] },
    { ...original, session: { id: "00000000-0000-4000-8000-000000000001", deckId, cardId: "00000000-0000-4000-8000-000000000002", startedAt: context.now.toISOString(), revealedAt: null, recall: null } },
  ];
  for (const bad of corruptions) {
    await context.store.update<unknown, void>(KEY, null, () => ({ value: bad, result: undefined }));
    assert.match(await run(context, "list"), /Saved learning data/);
    assert.match(await run(context, "create New | label | text"), /Saved learning data/);
    assert.deepEqual(await context.store.read(KEY), bad);
    assert.match(await run(context, "help"), /Private learning coach/);
  }
});

test("limits, exact excerpts, duplicate cards, pages and private output bounds", async () => {
  const { context, deckId } = await setup();
  assert.match(await run(context, `card ${deckId} | Q | Not in the material`), /exact excerpt/);
  assert.match(await run(context, `card ${deckId} | ${"Q".repeat(301)} | DNS`), /1–300/);
  assert.match(await run(context, `create ${"T".repeat(101)} | label | material`), /1–100/);
  assert.match(await run(context, `create title | label | ${"s".repeat(10_001)}`), /1–10000/);
  await addCard(context, deckId);
  assert.match(await run(context, `card ${deckId} | WHAT DOES DNS DO? | DNS translates domain names to IP addresses.`), /already exist/);
  for (let index = 1; index < 40; index++) await addCard(context, deckId, `Question ${index}`);
  assert.match(await run(context, `card ${deckId} | Too many | DNS`), /40 cards/);
  assert.match(await run(context, `draft ${deckId}`), /40 cards/);
  assert.match(await run(context, `cards ${deckId}`), /page 1\/14/);
  assert.match(await run(context, `cards ${deckId} 14`), /page 14\/14/);
  for (const page of ["0", "-1", "1.5", "1x", "15"]) assert.match(await run(context, `cards ${deckId} ${page}`), /page/);
  for (let index = 1; index < 6; index++) assert.match(await run(context, `create deck ${index} | notes | material`), /Created/);
  assert.match(await run(context, "create seventh | notes | material"), /You have 6 decks/);
  assert.equal((await saved(context)).decks.length, 6);

  const other = createAgentTestContext();
  const source = "<!channel> & ".repeat(750).trim();
  await run(other, `create Escape test | My notes | ${source}`);
  const id = (await saved(other)).decks[0].id;
  const show = await run(other, `show ${id}`);
  assert.ok(show.length <= 28_000);
  assert.ok(!show.includes("<!channel>"));
  assert.match(show, /&lt;!channel&gt;/);
  assert.match(await run(other, `card ${id} | Pipes? | <!channel> &`), /Added and due now/);
});

test("pending drafts respect later manual additions, and current quizzes stay deck-scoped", async () => {
  const { context, deckId, sourceId } = await setup();
  fakeGenerator(context, () => ({ cards: [{ question: "What does DNS do?", answer: "DNS translates domain names to IP addresses.", sourceId }] }));
  await run(context, `draft ${deckId}`);
  const draftId = (await saved(context)).decks[0].draft!.id;
  await addCard(context, deckId);
  const before = await saved(context);
  assert.match(await run(context, `accept ${deckId} ${draftId}`), /already added manually/);
  assert.deepEqual(await saved(context), before);
  await run(context, "create Another | Notes | Other text");
  const otherId = (await saved(context)).decks[1].id;
  const current = await quiz(context, deckId);
  assert.match(await run(context, `quiz ${otherId}`), /Finish the active quiz/);
  await run(context, `delete ${otherId} confirm`);
  assert.equal((await saved(context)).session!.id, current.sessionId);
});

test("feature storage namespaces remain isolated and storage failures are honest", async () => {
  const first = await setup();
  const second = createAgentTestContext({ userId: "OTHER", teamId: "OTHER_TEAM" });
  assert.match(await run(second, "list"), /No learning decks/);
  assert.match(await run(second, `show ${first.deckId}`), /not found/);
  const context = createAgentTestContext({ store: {
    read: async () => { throw new Error("sensitive connection info"); },
    update: async () => { throw new Error("sensitive connection info"); },
  } });
  const response = await run(context, "list");
  assert.match(response, /storage is unavailable.*could not be confirmed/);
  assert.ok(!response.includes("sensitive"));
  assert.match(await run(context, "help"), /Private learning coach/);
});

test("generation shrinks to remaining capacity and accepting after a concurrent addition is all-or-nothing", async () => {
  const { context, deckId, sourceId } = await setup();
  for (let i = 0; i < 39; i++) await addCard(context, deckId, `Question ${i}`);
  context.services.generate = async ({ instructions }) => {
    assert.match(instructions, /Draft 1–1/);
    return JSON.stringify({ cards: [{ question: "Resolver?", answer: "A resolver asks a name server for a record.", sourceId }] });
  };
  assert.match(await run(context, `draft ${deckId}`), /Generated suggestions/);
  const draftId = (await saved(context)).decks[0].draft!.id;
  await addCard(context, deckId, "The final manual card");
  const before = await saved(context);
  assert.match(await run(context, `accept ${deckId} ${draftId}`), /exceed 40 cards/);
  assert.deepEqual(await saved(context), before);
  assert.match(await run(context, `discard ${deckId} ${draftId}`), /Draft discarded/);
});

test("even maximally escaped generated previews remain complete before acceptance", async () => {
  const context = createAgentTestContext();
  const answer = "&".repeat(800);
  await run(context, `create ${"&".repeat(100)} | notes | ${answer}`);
  const deck = (await saved(context)).decks[0];
  context.services.generate = async () => JSON.stringify({ cards: [0, 1, 2].map((index) => ({
    question: "&".repeat(299) + index, answer, sourceId: deck.source.id,
  })) });
  const response = await run(context, `draft ${deck.id}`);
  const draft = (await saved(context)).decks[0].draft!;
  assert.equal(draft.cards.length, 3);
  assert.ok(response.length < 28_000);
  assert.ok(!response.includes("Display shortened"));
  for (const card of draft.cards) assert.ok(response.includes(card.id));
  assert.match(response, /Discard: learning discard/);
  assert.ok(response.includes(`Accept: learning accept ${deck.id} ${draft.id}`));
});

test("backdated clocks cannot record a recall or move a review backwards", async () => {
  const { context, deckId } = await setup();
  await addCard(context, deckId);
  const { sessionId } = await quiz(context, deckId);
  const earlier = { ...context, now: new Date(context.now.getTime() - 1) };
  const before = await saved(context);
  assert.match(await run(earlier, `reveal ${sessionId}`), /predates this quiz/);
  assert.match(await run(earlier, `card ${deckId} | new question | DNS`), /predates this deck/);
  assert.deepEqual(await saved(context), before);
  await run(context, `reveal ${sessionId}`);
  const revealed = await saved(context);
  assert.match(await run(earlier, `rate ${sessionId} easy`), /predates this quiz/);
  assert.deepEqual(await saved(context), revealed);
});

test("UTF-8 quota is atomic and reserves draft acceptance and worst-case recall/review growth", async () => {
  const base = createAgentTestStore();
  let peakBytes = 0;
  const store: AgentFeatureStore = {
    read: base.read,
    async update<T, R>(key: string, initial: T, transform: (current: T) => { value: T; result: R }): Promise<R> {
      return base.update(key, initial, (current) => {
        const next = transform(current);
        const bytes = Buffer.byteLength(JSON.stringify(next.value), "utf8");
        assert.ok(bytes < 480_000, `Feature attempted to persist ${bytes} bytes`);
        peakBytes = Math.max(peakBytes, bytes);
        return next;
      });
    },
  };
  const context = createAgentTestContext({ store });
  const material = "漢".repeat(10_000);
  const answer = "漢".repeat(800);
  for (let i = 0; i < 6; i++) assert.match(await run(context, `create 漢字 ${i} | My notes | ${material}`), /Created deck/);
  const decks = (await saved(context)).decks;
  let generateCalls = 0;
  context.services.generate = async ({ input }) => {
    generateCalls++;
    const { source } = JSON.parse(input) as { source: { id: string } };
    return JSON.stringify({ cards: [0, 1, 2].map((i) => ({ question: `Suggestion ${i}`, answer, sourceId: source.id })) });
  };
  assert.match(await run(context, `draft ${decks[0].id}`), /Generated suggestions/);
  const draftId = (await saved(context)).decks[0].draft!.id;
  let rejectedDeckId = "";
  let ordinal = 0;
  for (const deck of decks.slice(1)) {
    for (let i = 0; i < 40; i++) {
      const before = await saved(context);
      const question = "学".repeat(296) + String(ordinal++).padStart(4, "0");
      const response = await run(context, `card ${deck.id} | ${question} | ${answer}`);
      if (response.includes("storage quota reached")) {
        rejectedDeckId = deck.id;
        assert.match(response, /UTF-8 bytes.*reserved review space/);
        assert.match(response, /learning delete.*confirm/);
        assert.match(response, /learning discard/);
        assert.deepEqual(await saved(context), before);
        break;
      }
      assert.match(response, /Added and due now/);
    }
    if (rejectedDeckId) break;
  }
  assert.ok(rejectedDeckId, "Unicode content must hit the byte quota before the card/deck-count caps");
  const full = await saved(context);
  const serialized = JSON.stringify(full);
  assert.ok(serialized.length < 240_000, "A UTF-16 character-count quota would miss this case");
  assert.ok(Buffer.byteLength(serialized, "utf8") > 460_000);
  const list = await run(context, "list");
  assert.ok(list.includes(`Storage: ${Buffer.byteLength(serialized, "utf8")} UTF-8 bytes saved`));
  const allocation = Number(/(\d+)\/479999 bytes allocated/.exec(list)?.[1]);
  assert.ok(allocation > 476_000 && allocation < 480_000, list);

  assert.match(await run(context, `draft ${rejectedDeckId}`), /storage quota reached/);
  assert.equal(generateCalls, 2);
  assert.deepEqual(await saved(context), full, "An over-budget generated batch must not replace or clear pending state");
  assert.match(await run(context, `accept ${decks[0].id} ${draftId}`), /Accepted 3/);
  assert.equal((await saved(context)).decks[0].cards.length, 3);

  // Mature every card's counters to exercise the lifecycle reserve, rather than
  // replaying a million reviews. All records still satisfy the public schema.
  const mature = await saved(context);
  const reviewedAt = context.now.toISOString();
  context.now = new Date(context.now.getTime() + 600_000);
  for (const deck of mature.decks) for (const card of deck.cards) {
    card.reviews = 999_999; card.lapses = 999_999; card.lastRating = "again";
    card.lastReviewedAt = reviewedAt; card.intervalDays = 0; card.dueAt = context.now.toISOString();
  }
  await context.store.update(KEY, mature, () => ({ value: mature, result: undefined }));
  const { sessionId } = await quiz(context, decks[0].id);
  assert.match(await run(context, `answer ${sessionId} | ${"\u0000".repeat(2_000)}`), /Your recall/);
  assert.ok(peakBytes > 474_000 && peakBytes < 480_000, `Peak serialized state: ${peakBytes}`);
  assert.match(await run(context, `rate ${sessionId} again`), /Recorded your recall/);
  assert.ok((await saved(context)).decks[0].cards.some((card) => card.reviews === 1_000_000 && card.lapses === 1_000_000));
  assert.equal((await saved(context)).session, null);

  assert.match(await run(context, `delete ${decks[0].id} confirm`), /Deleted deck/);
  assert.match(await run(context, `card ${rejectedDeckId} | Space reclaimed | ${answer}`), /Added and due now/);
});

test("escaped source stays intact while generation input fits the runtime's character budget", async () => {
  const context = createAgentTestContext();
  const material = "\u0000".repeat(10_000);
  assert.match(await run(context, `create Escaped input | Notes | ${material}`), /Created deck/);
  const deck = (await saved(context)).decks[0];
  for (let i = 0; i < 39; i++) {
    assert.match(await run(context, `card ${deck.id} | ${"\u0000".repeat(296)}${String(i).padStart(3, "0")} | \u0000`), /Added and due now/);
  }
  let calls = 0;
  context.services.generate = async ({ input, instructions }) => {
    calls++;
    assert.ok(input.length <= 80_000);
    assert.ok(instructions.length <= 24_000);
    const prompt = JSON.parse(input) as { source: { id: string; text: string }; existingQuestions: string[] };
    assert.equal(prompt.source.text, material);
    assert.ok(prompt.existingQuestions.length > 0 && prompt.existingQuestions.length < 39);
    return JSON.stringify({ cards: [{ question: "What is the literal character?", answer: "\u0000", sourceId: prompt.source.id }] });
  };
  assert.match(await run(context, `draft ${deck.id}`), /Generated suggestions/);
  assert.equal(calls, 1);
  const state = await saved(context);
  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") < 480_000);
});

test("an aborted runtime generation reports cancellation and never saves a draft", async () => {
  const { context, deckId } = await setup();
  const controller = new AbortController();
  context.signal = controller.signal;
  context.services.generate = async () => {
    controller.abort();
    throw new Error("Aborted by the runtime deadline");
  };
  const before = await saved(context);
  assert.match(await run(context, `draft ${deckId}`), /cancelled.*No generated cards were saved/);
  assert.deepEqual(await saved(context), before);
});
