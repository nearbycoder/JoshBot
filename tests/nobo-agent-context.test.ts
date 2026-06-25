import assert from "node:assert/strict";
import test from "node:test";
import { decodeNoboAgentContext, encodeNoboAgentContext } from "../lib/nobo-agent-context.js";

test("agent context ids are unique per run", () => {
  const first = encodeNoboAgentContext({
    modelId: "glm-5.2",
    toolMode: "slack"
  });
  const second = encodeNoboAgentContext({
    modelId: "glm-5.2",
    toolMode: "slack"
  });

  assert.notEqual(first, second);
  assert.notEqual(decodeNoboAgentContext(first).nonce, decodeNoboAgentContext(second).nonce);
});
