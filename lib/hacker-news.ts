export type HackerNewsStory = {
  id: string;
  title: string;
  url: string;
  points?: number;
  comments?: number;
  createdAt?: string;
};

type HackerNewsItem = {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  url?: unknown;
  score?: unknown;
  descendants?: unknown;
  time?: unknown;
  deleted?: unknown;
  dead?: unknown;
};

const HACKER_NEWS_TOP_STORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HACKER_NEWS_ITEM_URL = "https://hacker-news.firebaseio.com/v0/item";
const HACKER_NEWS_TOP_STORIES_SCAN_LIMIT = 100;
const DEFAULT_HACKER_NEWS_LIMIT = 10;

export async function createHackerNewsSlackDigest({ focus }: { focus: string }) {
  const stories = await fetchTrendingHackerNewsStories({
    query: focus,
    limit: DEFAULT_HACKER_NEWS_LIMIT
  });

  return formatHackerNewsSlackDigest(stories, focus);
}

export async function fetchTrendingHackerNewsStories({
  query,
  limit
}: {
  query: string;
  limit: number;
}) {
  const safeLimit = Math.max(0, Math.floor(limit));

  if (safeLimit === 0) {
    return [];
  }

  const ids = await fetchHackerNewsTopStoryIds();
  const scanLimit = Math.min(Math.max(safeLimit * 10, safeLimit), HACKER_NEWS_TOP_STORIES_SCAN_LIMIT);
  const items = await Promise.all(ids.slice(0, scanLimit).map(fetchHackerNewsItem));

  return items
    .map(normalizeHackerNewsItem)
    .filter((story): story is HackerNewsStory => story !== null)
    .filter((story) => storyMatchesFocus(story, query))
    .slice(0, safeLimit);
}

export function formatHackerNewsSlackDigest(stories: HackerNewsStory[], focus: string) {
  const trimmedFocus = focus.trim();
  const heading = trimmedFocus
    ? `*Top Trending Hacker News for "${escapeSlackText(trimmedFocus)}"*`
    : "*Top Trending Hacker News*";

  if (stories.length === 0) {
    return trimmedFocus
      ? `${heading}\nI couldn't find top Hacker News stories matching that focus.`
      : `${heading}\nI couldn't find top Hacker News stories.`;
  }

  return [
    heading,
    ...stories.map((story, index) => `${index + 1}. ${formatHackerNewsStory(story)}`),
    "",
    "<https://news.ycombinator.com/|Hacker News top>"
  ].join("\n");
}

async function fetchHackerNewsTopStoryIds() {
  const response = await fetch(HACKER_NEWS_TOP_STORIES_URL, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Hacker News top stories request failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as unknown;

  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.map(getNumber).filter((id): id is number => typeof id === "number");
}

async function fetchHackerNewsItem(id: number) {
  const response = await fetch(`${HACKER_NEWS_ITEM_URL}/${id}.json`, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Hacker News item ${id} request failed with HTTP ${response.status}`);
  }

  return (await response.json()) as unknown;
}

function normalizeHackerNewsItem(input: unknown): HackerNewsStory | null {
  if (!isRecord(input)) {
    return null;
  }

  const item = input as HackerNewsItem;
  const id = getNumber(item.id);
  const type = getString(item.type);
  const title = getString(item.title);

  if (!id || !title) {
    return null;
  }

  if ((type && type !== "story") || item.deleted === true || item.dead === true) {
    return null;
  }

  const time = getNumber(item.time);
  const url = getString(item.url) || `https://news.ycombinator.com/item?id=${id}`;

  return {
    id: String(id),
    title,
    url,
    points: getNumber(item.score),
    comments: getNumber(item.descendants),
    createdAt: typeof time === "number" ? new Date(time * 1000).toISOString() : undefined
  };
}

function storyMatchesFocus(story: HackerNewsStory, focus: string): boolean {
  const phrases = focus
    .split(/[,;]+/)
    .map((phrase) => phrase.trim())
    .filter(Boolean);

  if (phrases.length > 1) {
    return phrases.some((phrase) => storyMatchesFocus(story, phrase));
  }

  const terms = focus
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) {
    return true;
  }

  const haystack = `${story.title} ${story.url}`.toLowerCase();
  return haystack.includes(terms.join(" ")) || terms.every((term) => haystack.includes(term));
}

function formatHackerNewsStory(story: HackerNewsStory) {
  const title = escapeSlackLinkLabel(story.title);
  const url = escapeSlackUrl(story.url);
  const meta = [
    typeof story.points === "number" ? `${story.points} pts` : null,
    typeof story.comments === "number" ? `${story.comments} comments` : null,
    story.createdAt ? formatStoryDate(story.createdAt) : null
  ].filter(Boolean);

  return `<${url}|${title}>${meta.length > 0 ? ` - ${meta.join(", ")}` : ""}`;
}

function formatStoryDate(input: string) {
  const date = new Date(input);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric"
  }).format(date);
}

function getString(input: unknown) {
  return typeof input === "string" ? input.trim() : "";
}

function getNumber(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function escapeSlackText(input: string) {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeSlackLinkLabel(input: string) {
  return escapeSlackText(input).replace(/\|/g, "¦");
}

function escapeSlackUrl(input: string) {
  return input.replace(/>/g, encodeURIComponent(">"));
}
