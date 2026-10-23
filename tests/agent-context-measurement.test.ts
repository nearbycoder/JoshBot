import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_CONTEXT_LIMITS, AgentContextCapacityError, measureAgentContext } from "../lib/agent-features/budgets.js";
import type { AgentContextItem } from "../lib/agent-features/types.js";

const measure = (value: unknown) => measureAgentContext(value as AgentContextItem[]);
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const source = (text: string, metadata?: object) => [{ id: "note-1", kind: "note", title: "界😀", text, metadata }];

test("context sizing matches JSON for every UTF-16 code unit and surrogate adjacency", () => {
  for (let code = 0; code <= 0xffff; code++) {
    const text = String.fromCharCode(code);
    const value = source(text, { [text]: text });
    assert.equal(measure(value), jsonBytes(value), `code unit ${code.toString(16)}`);
  }
  const boundaries = ["a", "\u0000", "\b", "\t", "\n", "\f", "\r", '"', "\\", "界", "\ud7ff", "\ud800", "\udbff", "\udc00", "\udfff", "\ue000", "😀"];
  for (const a of boundaries) for (const b of boundaries) for (const c of boundaries) {
    const value = source(a + b + c);
    assert.equal(measure(value), jsonBytes(value), JSON.stringify(a + b + c));
  }
});

test("context sizing preserves mixed strings, optional fields, arrays and repeated references", () => {
  let seed = 20261023;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const shared = { escaped: "界😀\"\\\n\u0001\ud800\udc00\ud800", missing: undefined };
  for (let sample = 0; sample < 600; sample++) {
    const text = Array.from({ length: random() % 160 }, () => String.fromCharCode(random() % 65536)).join("");
    const metadata = Object.assign(Object.create(null), { [text]: text, missing: undefined, list: [null, undefined, true, false, -0, 1.25, 1e30, Number.MIN_VALUE, shared, shared] });
    const value = source(text, metadata);
    assert.equal(measure(value), jsonBytes(value));
  }
  const holes = new Array(5); holes[2] = undefined;
  const value = source("optional", { holes, shared, another: shared });
  assert.equal(measure(value), jsonBytes(value));
  assert.equal(measure([]), 2);
  assert.equal(measure(Array(2000).fill(null)), jsonBytes(Array(2000).fill(null)));
});

test("context sizing keeps unsupported types, cycles and traversal failures", () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => measure(source("cycle", cycle)), { name: "Error", message: "Personal context contains cyclic metadata." });
  for (const invalid of [NaN, Infinity, -Infinity, 1n, Symbol("value"), () => 1, new Date(), new Map(), new Set(), Object.create({ inherited: true })]) {
    assert.throws(() => measure(source("invalid", { value: invalid })), { name: "Error", message: "Personal context contains unsupported metadata." });
  }
  const sentinel = new Error("existing getter failure");
  const metadata = Object.defineProperty({}, "value", { enumerable: true, get() { throw sentinel; } });
  assert.throws(() => measure(source("getter", metadata)), error => error === sentinel);
  for (const invalid of [null, {}, "", undefined, Array(2001).fill(null)]) assert.throws(() => measure(invalid), AgentContextCapacityError);
});

test("context sizing enforces exact byte, depth and node ceilings without later traversal", () => {
  for (const text of ["x", '"', "\\", "\u0001", "\ud800", "界", "😀"]) {
    const base = jsonBytes(source(""));
    const bytes = jsonBytes(text) - 2;
    const repetitions = Math.floor((AGENT_CONTEXT_LIMITS.bytes - base) / bytes);
    const remaining = AGENT_CONTEXT_LIMITS.bytes - base - repetitions * bytes;
    const value = source(text.repeat(repetitions) + "x".repeat(remaining));
    assert.equal(jsonBytes(value), AGENT_CONTEXT_LIMITS.bytes);
    assert.equal(measure(value), AGENT_CONTEXT_LIMITS.bytes);
    value[0].text += "x";
    assert.throws(() => measure(value), AgentContextCapacityError);
  }
  let visited = false;
  const metadata = Object.defineProperty({}, "late", { enumerable: true, get() { visited = true; throw new Error("must not reach metadata"); } });
  assert.throws(() => measure(source('"'.repeat(AGENT_CONTEXT_LIMITS.bytes / 2), metadata)), AgentContextCapacityError);
  assert.equal(visited, false);
  let nested: unknown = null;
  for (let depth = 0; depth < AGENT_CONTEXT_LIMITS.depth; depth++) nested = [nested];
  assert.equal(measure(nested), jsonBytes(nested));
  assert.throws(() => measure([nested]), AgentContextCapacityError);
  const exactNodes = [Array(AGENT_CONTEXT_LIMITS.nodes - 2).fill(null)];
  assert.equal(measure(exactNodes), jsonBytes(exactNodes));
  exactNodes[0].push(null);
  assert.throws(() => measure(exactNodes), AgentContextCapacityError);
  assert.throws(() => measure([Array(AGENT_CONTEXT_LIMITS.nodes + 1)]), AgentContextCapacityError);
});
