import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../lib/ai.js";

test("current time uses requested timezone", () => {
  const currentTime = __testing.formatCurrentTime("America/Chicago");

  assert.equal(currentTime.timeZone, "America/Chicago");
  assert.match(currentTime.iso, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(currentTime.local, /Central|GMT-5|GMT-6|CDT|CST/);
  assert.match(currentTime.utc, /UTC|Coordinated Universal Time|GMT/);
});

test("current time falls back to America/Chicago for invalid timezone", () => {
  const currentTime = __testing.formatCurrentTime("Nope/Nowhere");

  assert.equal(currentTime.timeZone, "America/Chicago");
});

test("current time prompt names relative date phrases", () => {
  const prompt = __testing.formatCurrentTimePrompt();

  assert.match(prompt, /Current time:/);
  assert.match(prompt, /America\/Chicago/);
  assert.match(prompt, /in 5 minutes/);
  assert.match(prompt, /over the past week/);
});

test("Slack markdown normalization converts Markdown links and bold", () => {
  const normalized = __testing.normalizeSlackMrkdwn(
    "See [OpenAI](https://openai.com) and **bold** text"
  );

  assert.equal(normalized, "See <https://openai.com|OpenAI> and *bold* text");
});
