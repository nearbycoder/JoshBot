import assert from "node:assert/strict";
import test from "node:test";
import { getNoboModelSpecifier, registerNoboProvider } from "../src/nobo-provider.js";

test("registers every OpenCode Go wire protocol", () => {
  assert.doesNotThrow(() => registerNoboProvider());
});

test("routes OpenCode Go models through their required providers", () => {
  assert.equal(getNoboModelSpecifier("glm-5.3"), "opencode-go/glm-5.3");
  assert.equal(getNoboModelSpecifier("qwen3.8-max"), "opencode-go/qwen3.8-max");
  assert.equal(getNoboModelSpecifier("gpt-5.6-luna"), "opencode-go/gpt-5.6-luna");
});
