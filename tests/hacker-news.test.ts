import assert from "node:assert/strict";
import test from "node:test";
import { fetchTrendingHackerNewsStories, formatHackerNewsSlackDigest } from "../lib/hacker-news.js";

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

  assert.match(digest, /\*Top Trending Hacker News for "ai agents"\*/);
  assert.match(digest, /<https:\/\/example\.com\/story\|Show HN: Cats &lt; Dogs &amp; Pipes ¦ Too>/);
  assert.match(digest, /42 pts, 7 comments, Jun 19/);
  assert.match(digest, /<https:\/\/news\.ycombinator\.com\/item\?id=456\|Ask HN: What are you building\?>/);
  assert.match(digest, /<https:\/\/news\.ycombinator\.com\/\|Hacker News top>/);
});

test("formats empty focused Hacker News results", () => {
  const digest = formatHackerNewsSlackDigest([], "very specific topic");

  assert.match(digest, /\*Top Trending Hacker News for "very specific topic"\*/);
  assert.match(digest, /couldn't find top Hacker News stories/);
});

test("fetches top trending Hacker News stories by topstories rank", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const items: Record<string, unknown> = {
    "101": {
      id: 101,
      type: "story",
      title: "Rust reaches orbit",
      url: "https://example.com/rust",
      score: 120,
      descendants: 33,
      time: 1781870400
    },
    "102": {
      id: 102,
      type: "job",
      title: "Rust engineer",
      score: 1,
      time: 1781870400
    },
    "103": {
      id: 103,
      type: "story",
      title: "Memory safety with Rust",
      score: 80,
      descendants: 12,
      time: 1781870500
    },
    "104": {
      id: 104,
      type: "story",
      title: "Unrelated top story",
      score: 500,
      descendants: 99,
      time: 1781870600
    }
  };

  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);

    if (url.endsWith("/topstories.json")) {
      return jsonResponse([101, 102, 103, 104]);
    }

    const id = url.match(/\/item\/(\d+)\.json$/)?.[1];
    return jsonResponse(id ? items[id] : null);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const stories = await fetchTrendingHackerNewsStories({
    query: "rust",
    limit: 2
  });

  assert.deepEqual(
    stories.map((story) => story.id),
    ["101", "103"]
  );
  assert.equal(stories[0]?.points, 120);
  assert.equal(stories[0]?.comments, 33);
  assert.equal(stories[0]?.createdAt, "2026-06-19T12:00:00.000Z");
  assert.ok(calls[0]?.endsWith("/topstories.json"));
});

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json"
    }
  });
}
