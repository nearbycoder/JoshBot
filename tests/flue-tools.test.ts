import assert from "node:assert/strict";
import test from "node:test";
import * as v from "valibot";
import { createNoboTools } from "../lib/flue-tools.js";

test("tool definitions use the Flue v2 input and run contract", () => {
  const originalExaApiKey = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = "test-key";

  try {
    const tools = createNoboTools(createScheduleContext(), "U123");

    for (const tool of tools) {
      assert.ok(tool.input, `${tool.name} is missing its input schema`);
      assert.equal(typeof tool.run, "function", `${tool.name} is missing run()`);
      assert.equal("parameters" in tool, false);
      assert.equal("execute" in tool, false);
    }

    const webSearch = tools.find((tool) => tool.name === "web_search");
    assert.ok(webSearch?.input);
    assert.equal(
      v.safeParse(webSearch.input, { query: "Flue v2", type: "auto" }).success,
      true
    );
    assert.equal(
      v.safeParse(webSearch.input, { query: "Flue v2", type: "slow" }).success,
      false
    );
  } finally {
    if (originalExaApiKey === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = originalExaApiKey;
    }
  }
});

function createScheduleContext() {
  return {
    ownerUserId: "U123",
    channel: "C123",
    threadTs: "123.456",
    sourceTs: "123.456",
    mentionedChannels: []
  };
}
