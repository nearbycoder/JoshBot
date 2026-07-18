import assert from "node:assert/strict";
import test from "node:test";
import { createNoboTools } from "../lib/flue-tools.js";

test("tool schemas give string enums an explicit type", () => {
  const originalExaApiKey = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = "test-key";

  try {
    for (const tool of createNoboTools(createScheduleContext(), "U123")) {
      assertStringEnumsHaveType(tool.parameters, tool.name);
    }
  } finally {
    if (originalExaApiKey === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = originalExaApiKey;
    }
  }
});

function assertStringEnumsHaveType(value: unknown, path: string) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertStringEnumsHaveType(item, `${path}[${index}]`));
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (Array.isArray(value.enum) && value.enum.every((item) => typeof item === "string")) {
    assert.equal(value.type, "string", `${path} has a string enum without type: string`);
  }

  for (const [key, child] of Object.entries(value)) {
    assertStringEnumsHaveType(child, `${path}.${key}`);
  }
}

function createScheduleContext() {
  return {
    ownerUserId: "U123",
    channel: "C123",
    threadTs: "123.456",
    sourceTs: "123.456",
    mentionedChannels: []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
