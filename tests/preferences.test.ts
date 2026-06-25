import assert from "node:assert/strict";
import test from "node:test";
import { __testing, formatUserPreferencesForSlack } from "../lib/preferences.js";

test("preference parser normalizes timezone aliases and values", () => {
  assert.equal(__testing.normalizeTimeZone("ET"), "America/New_York");
  assert.equal(__testing.normalizeTimeZone("America/Los_Angeles"), "America/Los_Angeles");
  assert.equal(__testing.normalizeTimeZone("Nope/Nowhere"), "America/Chicago");
});

test("preference parser normalizes stored payloads", () => {
  const preferences = __testing.normalizeUserPreferences({
    timeZone: "PT",
    verbosity: "brief",
    newsInterests: ["AI", " ai ", "security"],
    reminderStyle: "friendly"
  });

  assert.deepEqual(preferences, {
    timeZone: "America/Los_Angeles",
    verbosity: "concise",
    newsInterests: ["AI", "security"],
    reminderStyle: "gentle"
  });
});

test("channel preferences normalize model ids", () => {
  const preferences = __testing.normalizeChannelPreferences({
    modelId: "opencode-go/DeepSeek-V4-Pro"
  });

  assert.deepEqual(preferences, {
    modelId: "deepseek-v4-pro"
  });

  assert.deepEqual(
    __testing.normalizeChannelPreferences({
      modelId: "qwen3.7-max"
    }),
    { modelId: null }
  );
});

test("preference prompt injects relevant user prefs", () => {
  const prompt = __testing.formatUserPreferencesPrompt(
    {
      timeZone: "America/New_York",
      verbosity: "detailed",
      newsInterests: ["markets", "AI"],
      reminderStyle: "gentle"
    },
    "U123"
  );

  assert.match(prompt, /Personal preferences for Slack user U123/);
  assert.match(prompt, /Timezone: America\/New_York/);
  assert.match(prompt, /Verbosity: detailed/);
  assert.match(prompt, /News interests: markets, AI/);
  assert.match(prompt, /Reminder style: gentle/);
});

test("preference Slack formatter lists defaults and interests", () => {
  const text = formatUserPreferencesForSlack({
    timeZone: "UTC",
    verbosity: "normal",
    newsInterests: ["robotics"],
    reminderStyle: "direct"
  });

  assert.match(text, /Timezone: `UTC`/);
  assert.match(text, /News interests: `robotics`/);
});
