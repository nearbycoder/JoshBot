import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../lib/hacker-news-schedule.js";

test("Hacker News schedule defaults to 9am and 2pm Central", () => {
  const originalTimes = process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES;
  delete process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES;

  try {
    assert.deepEqual(__testing.getHackerNewsScheduleTimes(), ["09:00", "14:00"]);
    assert.equal(__testing.timeToCronExpression("09:00"), "0 9 * * *");
    assert.equal(__testing.timeToCronExpression("14:00"), "0 14 * * *");
  } finally {
    if (originalTimes === undefined) {
      delete process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES;
    } else {
      process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES = originalTimes;
    }
  }
});

test("Hacker News schedule accepts configured times", () => {
  const originalTimes = process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES;
  process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES = "08:15, 16:45";

  try {
    assert.deepEqual(__testing.getHackerNewsScheduleTimes(), ["08:15", "16:45"]);
    assert.equal(__testing.timeToCronExpression("08:15"), "15 8 * * *");
    assert.equal(__testing.timeToCronExpression("16:45"), "45 16 * * *");
  } finally {
    if (originalTimes === undefined) {
      delete process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES;
    } else {
      process.env.NOBO_HACKER_NEWS_SCHEDULE_TIMES = originalTimes;
    }
  }
});

test("Hacker News schedule rejects invalid times", () => {
  assert.throws(() => __testing.timeToCronExpression("24:00"), /Invalid Hacker News schedule time/);
  assert.throws(() => __testing.timeToCronExpression("9am"), /Invalid Hacker News schedule time/);
});
