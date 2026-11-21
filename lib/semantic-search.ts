import { readFile } from "node:fs/promises";
import MiniSearch from "minisearch";
import { listArtifacts, type ListedArtifact } from "./artifacts.js";
import { fetchSlackChannelHistory, type SlackChannelHistoryEntry } from "./channel-history.js";

type SemanticSearchSource = "channel-message" | "artifact";

export type SemanticSearchDocument = {
  id: string;
  source: SemanticSearchSource;
  title: string;
  text: string;
  createdAt?: string;
  url?: string;
  metadata?: Record<string, string | number | boolean | undefined>;
};

export type SemanticSearchResult = {
  document: SemanticSearchDocument;
  score: number;
  excerpt: string;
};

export interface SemanticSearchProvider {
  search(
    query: string,
    documents: SemanticSearchDocument[],
    options?: { limit?: number }
  ): SemanticSearchResult[];
}

export type SemanticSearchCommandDependencies = {
  fetchChannelHistory?: typeof fetchSlackChannelHistory;
  listArtifacts?: typeof listArtifacts;
  readArtifactContent?: (artifact: ListedArtifact) => Promise<string>;
  provider?: SemanticSearchProvider;
};

const DEFAULT_HISTORY_DAYS = 14;
const DEFAULT_HISTORY_LIMIT = 200;
const DEFAULT_RESULT_LIMIT = 5;
const MAX_ARTIFACT_SEARCH_CHARS = 20000;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "this",
  "to",
  "we",
  "with"
]);

export class LexicalSemanticSearchProvider implements SemanticSearchProvider {
  search(query: string, documents: SemanticSearchDocument[], options: { limit?: number } = {}) {
    const queryTokens = tokenize(query);

    if (queryTokens.length === 0 || documents.length === 0) {
      return [];
    }

    const index = new MiniSearch<{ id: number; title: string; text: string }>({
      fields: ["title", "text"],
      tokenize: (value) => value.toLowerCase().match(/[a-z0-9]+/g) ?? [],
      processTerm: (term) => (term.length > 1 && !STOP_WORDS.has(term) ? term : null)
    });
    index.addAll(documents.map((document, idx) => ({ id: idx, title: document.title, text: document.text })));

    const hits = index.search(query, {
      boost: { title: 3, text: 1 },
      prefix: (term) => term.length >= 3,
      fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
      combineWith: "OR"
    });
    const normalizedQuery = normalizeForPhrase(query);

    return hits
      .map((hit) => {
        const document = documents[hit.id as number];
        if (!document) return null;
        let score = hit.score;
        if (normalizedQuery.length > 2) {
          const titlePhrase = normalizeForPhrase(document.title);
          const textPhrase = normalizeForPhrase(document.text);
          if (titlePhrase.includes(normalizedQuery)) score += 8;
          if (textPhrase.includes(normalizedQuery)) score += 5;
        }
        return {
          document,
          score,
          excerpt: createExcerpt(document.text, [...new Set([...queryTokens, ...hit.terms])])
        };
      })
      .filter((result): result is SemanticSearchResult => result !== null && result.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || compareDates(right.document.createdAt, left.document.createdAt)
      )
      .slice(0, normalizePositiveInteger(options.limit, DEFAULT_RESULT_LIMIT));
  }
}

export async function handleSemanticSearchCommandText(
  commandText: string,
  context: { channelId?: string; ownerUserId?: string },
  dependencies: SemanticSearchCommandDependencies = {}
) {
  const query = commandText.trim();

  if (!query || /^help$/i.test(query)) {
    return formatSemanticSearchHelp();
  }

  const notes: string[] = [];
  const documents: SemanticSearchDocument[] = [];
  const fetchHistory = dependencies.fetchChannelHistory ?? fetchSlackChannelHistory;
  const listUserArtifacts = dependencies.listArtifacts ?? listArtifacts;
  const provider = dependencies.provider ?? createSemanticSearchProvider();

  if (context.channelId) {
    try {
      const messages = await fetchHistory({
        channel: context.channelId,
        days: getSemanticSearchHistoryDays(),
        limit: getSemanticSearchHistoryLimit()
      });
      documents.push(...messages.map((message) => channelMessageToDocument(message)));
    } catch (error) {
      notes.push(`Skipped channel history: ${summarizeError(error)}.`);
    }
  } else {
    notes.push("Skipped channel history: Slack did not send a channel.");
  }

  if (context.ownerUserId) {
    const artifacts = await listUserArtifacts({
      ownerUserId: context.ownerUserId,
      limit: getSemanticSearchArtifactLimit()
    });
    const artifactDocuments = await Promise.all(
      artifacts.map(async (artifact) => artifactToDocument(artifact, dependencies.readArtifactContent))
    );
    documents.push(...artifactDocuments);
  } else {
    notes.push("Skipped artifacts: Slack did not send a user.");
  }

  const results = provider.search(query, documents, { limit: getSemanticSearchResultLimit() });
  return formatSemanticSearchResults(query, results, notes);
}

export function formatSemanticSearchHelp() {
  return [
    "*NoBo semantic search*",
    "`/nobo-search <query>`: search recent channel history and your artifacts",
    "`@NoBo semantic-search <query>`: same search from a mention"
  ].join("\n");
}

export function createSemanticSearchProvider() {
  const providerName = (process.env.NOBO_SEMANTIC_SEARCH_PROVIDER || "lexical").toLowerCase();

  if (providerName !== "lexical") {
    throw new Error(`Unsupported semantic search provider: ${providerName}`);
  }

  return new LexicalSemanticSearchProvider();
}

function channelMessageToDocument(message: SlackChannelHistoryEntry): SemanticSearchDocument {
  return {
    id: `slack:${message.ts}`,
    source: "channel-message",
    title: `${message.speaker} at ${message.datetime.slice(0, 16).replace("T", " ")}`,
    text: message.text,
    createdAt: message.datetime,
    metadata: {
      ts: message.ts,
      speaker: message.speaker
    }
  };
}

async function artifactToDocument(
  artifact: ListedArtifact,
  readArtifactContent = defaultReadArtifactContent
): Promise<SemanticSearchDocument> {
  let content = "";

  try {
    content = await readArtifactContent(artifact);
  } catch {
    content = "";
  }

  return {
    id: `artifact:${artifact.id}`,
    source: "artifact",
    title: artifact.title,
    text: cleanSearchText(content).slice(0, MAX_ARTIFACT_SEARCH_CHARS),
    createdAt: artifact.updatedAt ?? artifact.createdAt,
    url: artifact.previewUrl,
    metadata: {
      shortId: artifact.shortId,
      kind: artifact.kind,
      bytes: artifact.bytes
    }
  };
}

async function defaultReadArtifactContent(artifact: ListedArtifact) {
  return readFile(artifact.path, "utf8");
}

function tokenize(input: string) {
  const tokens = input
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((token) => token.length > 1 && !STOP_WORDS.has(token));

  return tokens && tokens.length > 0 ? tokens : input.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function createExcerpt(text: string, queryTokens: string[]) {
  const cleanText = cleanSearchText(text);
  const lowerText = cleanText.toLowerCase();
  const firstMatch = queryTokens
    .map((token) => lowerText.indexOf(token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const start = Math.max(0, (firstMatch ?? 0) - 60);
  const excerpt = cleanText.slice(start, start + 220).trim();

  return `${start > 0 ? "... " : ""}${excerpt}${start + 220 < cleanText.length ? " ..." : ""}`;
}

function cleanSearchText(input: string) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForPhrase(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function compareDates(left: string | undefined, right: string | undefined) {
  return Date.parse(left ?? "0") - Date.parse(right ?? "0");
}

function formatSemanticSearchResults(query: string, results: SemanticSearchResult[], notes: string[]) {
  const escapedQuery = escapeSlackText(query);
  const noteText = notes.length ? `\n_${notes.map(escapeSlackText).join(" ")}_` : "";

  if (results.length === 0) {
    return `No matching channel messages or artifacts found for \`${escapedQuery}\`.${noteText}`;
  }

  return [
    `*Search results for* \`${escapedQuery}\``,
    ...results.map(formatSemanticSearchResult),
    noteText.trim()
  ].filter(Boolean).join("\n");
}

function formatSemanticSearchResult(result: SemanticSearchResult, index: number) {
  const document = result.document;
  const score = result.score.toFixed(2);
  const excerpt = escapeSlackText(result.excerpt);

  if (document.source === "artifact") {
    return `${index + 1}. *Artifact* \`${document.metadata?.shortId}\` ${escapeSlackText(document.title)} <${document.url}|preview> _score ${score}_\n${excerpt}`;
  }

  return `${index + 1}. *Channel* ${escapeSlackText(document.title)} _score ${score}_\n${excerpt}`;
}

function summarizeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function getSemanticSearchHistoryDays() {
  return normalizePositiveInteger(process.env.NOBO_SEMANTIC_SEARCH_HISTORY_DAYS, DEFAULT_HISTORY_DAYS);
}

function getSemanticSearchHistoryLimit() {
  return normalizePositiveInteger(process.env.NOBO_SEMANTIC_SEARCH_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT);
}

function getSemanticSearchArtifactLimit() {
  return normalizePositiveInteger(process.env.NOBO_SEMANTIC_SEARCH_ARTIFACT_LIMIT, DEFAULT_HISTORY_LIMIT);
}

function getSemanticSearchResultLimit() {
  return normalizePositiveInteger(process.env.NOBO_SEMANTIC_SEARCH_RESULTS, DEFAULT_RESULT_LIMIT);
}

function normalizePositiveInteger(input: string | number | undefined, fallback: number) {
  const value = typeof input === "number" ? input : Number.parseInt(input ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function escapeSlackText(input: string) {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
