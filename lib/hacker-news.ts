export type HackerNewsStory = {
  id: string;
  title: string;
  url: string;
  points?: number;
  comments?: number;
  createdAt?: string;
};

type HackerNewsSearchResponse = {
  hits?: unknown[];
};

type HackerNewsSearchHit = {
  objectID?: unknown;
  title?: unknown;
  story_title?: unknown;
  url?: unknown;
  story_url?: unknown;
  points?: unknown;
  num_comments?: unknown;
  created_at?: unknown;
};

const HACKER_NEWS_SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date";
const DEFAULT_HACKER_NEWS_LIMIT = 10;

export async function createHackerNewsSlackDigest({ focus }: { focus: string }) {
  const stories = await fetchLatestHackerNewsStories({
    query: focus,
    limit: DEFAULT_HACKER_NEWS_LIMIT
  });

  return formatHackerNewsSlackDigest(stories, focus);
}

export async function fetchLatestHackerNewsStories({
  query,
  limit
}: {
  query: string;
  limit: number;
}) {
  const params = new URLSearchParams({
    tags: "story",
    hitsPerPage: String(Math.min(Math.max(limit * 2, limit), 50))
  });
  const trimmedQuery = query.trim();

  if (trimmedQuery) {
    params.set("query", trimmedQuery);
  }

  const response = await fetch(`${HACKER_NEWS_SEARCH_URL}?${params.toString()}`, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Hacker News request failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as HackerNewsSearchResponse;
  const hits = Array.isArray(payload.hits) ? payload.hits : [];

  return hits
    .map(normalizeHackerNewsHit)
    .filter((story): story is HackerNewsStory => story !== null)
    .slice(0, limit);
}

export function formatHackerNewsSlackDigest(stories: HackerNewsStory[], focus: string) {
  const trimmedFocus = focus.trim();
  const heading = trimmedFocus
    ? `*Latest Hacker News for "${escapeSlackText(trimmedFocus)}"*`
    : "*Latest Hacker News*";

  if (stories.length === 0) {
    return trimmedFocus
      ? `${heading}\nI couldn't find recent Hacker News stories matching that focus.`
      : `${heading}\nI couldn't find recent Hacker News stories.`;
  }

  return [
    heading,
    ...stories.map((story, index) => `${index + 1}. ${formatHackerNewsStory(story)}`),
    "",
    "<https://news.ycombinator.com/newest|Hacker News newest>"
  ].join("\n");
}

function normalizeHackerNewsHit(input: unknown): HackerNewsStory | null {
  if (!isRecord(input)) {
    return null;
  }

  const hit = input as HackerNewsSearchHit;
  const id = getString(hit.objectID);
  const title = getString(hit.title) || getString(hit.story_title);

  if (!id || !title) {
    return null;
  }

  const url = getString(hit.url) || getString(hit.story_url) || `https://news.ycombinator.com/item?id=${id}`;

  return {
    id,
    title,
    url,
    points: getNumber(hit.points),
    comments: getNumber(hit.num_comments),
    createdAt: getString(hit.created_at)
  };
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
