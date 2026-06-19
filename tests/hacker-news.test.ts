import assert from "node:assert/strict";
import test from "node:test";
import { formatHackerNewsSlackDigest } from "../lib/hacker-news.js";

test("formats Hacker News stories for Slack", () => {
  const digest = formatHackerNewsSlackDigest(
    [
      {
        id: "123",
        title: "Show HN: Cats < Dogs & Pipes | Too",
        url: "https://example.com/story",
        points: 42,
        comments: 7,
        createdAt: "2026-06-19T12:00:00.000Z"
      },
      {
        id: "456",
        title: "Ask HN: What are you building?",
        url: "https://news.ycombinator.com/item?id=456"
      }
    ],
    "ai agents"
  );

  assert.match(digest, /\*Latest Hacker News for "ai agents"\*/);
  assert.match(digest, /<https:\/\/example\.com\/story\|Show HN: Cats &lt; Dogs &amp; Pipes ¦ Too>/);
  assert.match(digest, /42 pts, 7 comments, Jun 19/);
  assert.match(digest, /<https:\/\/news\.ycombinator\.com\/item\?id=456\|Ask HN: What are you building\?>/);
});

test("formats empty focused Hacker News results", () => {
  const digest = formatHackerNewsSlackDigest([], "very specific topic");

  assert.match(digest, /\*Latest Hacker News for "very specific topic"\*/);
  assert.match(digest, /couldn't find recent Hacker News stories/);
});
