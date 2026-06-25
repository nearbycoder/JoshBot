import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type IncomingMessage, type ServerResponse } from "node:http";

export type ArtifactKind = "html" | "markdown";

export type ArtifactMetadata = {
  id: string;
  kind: ArtifactKind;
  filename: string;
  title: string;
  rawUrl: string;
  previewUrl: string;
  path: string;
  createdAt: string;
  expiresAt?: string;
  bytes: number;
};

export type CreatedArtifact = ArtifactMetadata;

export type ListedArtifact = ArtifactMetadata & {
  shortId: string;
  expired: boolean;
};

export type ArtifactLookupResult =
  | { status: "found"; artifact: ListedArtifact }
  | { status: "missing" }
  | { status: "ambiguous"; matches: ListedArtifact[] }
  | { status: "invalid" };

export type DeleteArtifactResult =
  | { ok: true; artifact: ListedArtifact }
  | { ok: false; reason: "invalid" | "missing" | "ambiguous"; matches?: ListedArtifact[] };

export type DeleteExpiredArtifactsResult = {
  deleted: ListedArtifact[];
};

const DEFAULT_ARTIFACT_DIR = "artifacts";
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 2;
const ARTIFACT_METADATA_FILENAME = ".artifact.json";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function createArtifact({
  kind,
  title,
  filename,
  content,
  expiresAt,
  expiresInDays
}: {
  kind: ArtifactKind;
  title: string;
  filename?: string;
  content: string;
  expiresAt?: string;
  expiresInDays?: number | string | null;
}): Promise<CreatedArtifact> {
  const bytes = Buffer.byteLength(content, "utf8");

  if (bytes > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact is too large (${bytes} bytes). Limit is ${MAX_ARTIFACT_BYTES} bytes.`);
  }

  const createdAt = new Date();
  const resolvedExpiresAt = resolveArtifactExpiresAt({ expiresAt, expiresInDays }, createdAt);
  const id = randomUUID();
  const extension = kind === "html" ? ".html" : ".md";
  const safeFilename = sanitizeFilename(filename || title || `artifact${extension}`, extension);
  const artifactDir = getArtifactDirectory();
  const targetDir = path.join(artifactDir, id);
  const targetPath = path.join(targetDir, safeFilename);

  await mkdir(targetDir, { recursive: true });
  await writeFile(targetPath, content, "utf8");

  const rawUrl = `${getArtifactBaseUrl()}/artifacts/${encodeURIComponent(id)}/${encodeURIComponent(safeFilename)}`;
  const previewUrl =
    kind === "markdown"
      ? `${getArtifactBaseUrl()}/artifacts/${encodeURIComponent(id)}/preview`
      : rawUrl;

  const artifact = {
    id,
    kind,
    filename: safeFilename,
    title: title.trim() || safeFilename,
    rawUrl,
    previewUrl,
    path: targetPath,
    createdAt: createdAt.toISOString(),
    ...(resolvedExpiresAt ? { expiresAt: resolvedExpiresAt } : {}),
    bytes
  };

  await writeFile(path.join(targetDir, ARTIFACT_METADATA_FILENAME), JSON.stringify(artifact, null, 2), "utf8");

  return artifact;
}

export async function listArtifacts({
  includeExpired = false,
  limit,
  now = new Date()
}: {
  includeExpired?: boolean;
  limit?: number;
  now?: Date;
} = {}): Promise<ListedArtifact[]> {
  let entries;

  try {
    entries = await readdir(getArtifactDirectory(), { withFileTypes: true });
  } catch {
    return [];
  }

  const artifacts = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && isSafeArtifactId(entry.name))
        .map((entry) => loadArtifactMetadata(entry.name, now))
    )
  ).filter((artifact): artifact is ListedArtifact => artifact !== null);

  const filteredArtifacts = includeExpired
    ? artifacts
    : artifacts.filter((artifact) => !artifact.expired);
  const sortedArtifacts = filteredArtifacts.sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
  );

  return typeof limit === "number" && limit > 0 ? sortedArtifacts.slice(0, limit) : sortedArtifacts;
}

export async function findArtifact(idPrefix: string): Promise<ArtifactLookupResult> {
  const normalizedPrefix = idPrefix.trim().toLowerCase();

  if (!/^[0-9a-f-]{4,36}$/.test(normalizedPrefix)) {
    return { status: "invalid" };
  }

  if (isSafeArtifactId(normalizedPrefix)) {
    const artifact = await loadArtifactMetadata(normalizedPrefix, new Date());
    return artifact ? { status: "found", artifact } : { status: "missing" };
  }

  const matches = (await listArtifacts({ includeExpired: true })).filter((artifact) =>
    artifact.id.startsWith(normalizedPrefix)
  );

  if (matches.length === 0) {
    return { status: "missing" };
  }

  if (matches.length > 1) {
    return { status: "ambiguous", matches };
  }

  return { status: "found", artifact: matches[0] as ListedArtifact };
}

export async function deleteArtifact(idPrefix: string): Promise<DeleteArtifactResult> {
  const match = await findArtifact(idPrefix);

  if (match.status === "invalid") {
    return { ok: false, reason: "invalid" };
  }

  if (match.status === "missing") {
    return { ok: false, reason: "missing" };
  }

  if (match.status === "ambiguous") {
    return { ok: false, reason: "ambiguous", matches: match.matches };
  }

  await rm(path.join(getArtifactDirectory(), match.artifact.id), { recursive: true, force: true });

  return {
    ok: true,
    artifact: match.artifact
  };
}

export async function deleteExpiredArtifacts({
  now = new Date()
}: {
  now?: Date;
} = {}): Promise<DeleteExpiredArtifactsResult> {
  const expiredArtifacts = (await listArtifacts({ includeExpired: true, now })).filter(
    (artifact) => artifact.expired
  );

  await Promise.all(
    expiredArtifacts.map((artifact) =>
      rm(path.join(getArtifactDirectory(), artifact.id), { recursive: true, force: true })
    )
  );

  return {
    deleted: expiredArtifacts
  };
}

export async function handleArtifactRequest(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  url: URL
) {
  if ((request.method ?? "GET") !== "GET") {
    sendText(response, 405, "Method not allowed");
    return true;
  }

  const match = url.pathname.match(/^\/artifacts\/([^/]+)(?:\/([^/]+))?$/);

  if (!match) {
    return false;
  }

  const id = decodeURIComponent(match[1] ?? "");
  const requestedFile = match[2] ? decodeURIComponent(match[2]) : "";

  if (!isSafeArtifactId(id)) {
    sendText(response, 404, "Artifact not found");
    return true;
  }

  const artifactDir = path.join(getArtifactDirectory(), id);

  if (requestedFile === "preview") {
    await sendMarkdownPreview(response, artifactDir);
    return true;
  }

  if (!isSafeFilename(requestedFile)) {
    sendText(response, 404, "Artifact not found");
    return true;
  }

  const filePath = path.join(artifactDir, requestedFile);

  try {
    const content = await readFile(filePath, "utf8");
    response.statusCode = 200;
    response.setHeader("content-type", getContentType(requestedFile));
    response.end(content);
  } catch {
    sendText(response, 404, "Artifact not found");
  }

  return true;
}

export async function handleArtifactFetchRequest(request: Request) {
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return textResponse("Method not allowed", 405);
  }

  const match = url.pathname.match(/^\/artifacts\/([^/]+)(?:\/([^/]+))?$/);

  if (!match) {
    return null;
  }

  const id = decodeURIComponent(match[1] ?? "");
  const requestedFile = match[2] ? decodeURIComponent(match[2]) : "";

  if (!isSafeArtifactId(id)) {
    return textResponse("Artifact not found", 404);
  }

  const artifactDir = path.join(getArtifactDirectory(), id);

  if (requestedFile === "preview") {
    return createMarkdownPreviewResponse(artifactDir);
  }

  if (!isSafeFilename(requestedFile)) {
    return textResponse("Artifact not found", 404);
  }

  const filePath = path.join(artifactDir, requestedFile);

  try {
    const content = await readFile(filePath, "utf8");
    return new Response(content, {
      status: 200,
      headers: {
        "content-type": getContentType(requestedFile)
      }
    });
  } catch {
    return textResponse("Artifact not found", 404);
  }
}

async function loadArtifactMetadata(id: string, now: Date): Promise<ListedArtifact | null> {
  const artifactDir = path.join(getArtifactDirectory(), id);
  const metadataPath = path.join(artifactDir, ARTIFACT_METADATA_FILENAME);

  try {
    const payload = await readFile(metadataPath, "utf8");
    const metadata = await normalizeStoredArtifactMetadata(id, JSON.parse(payload));

    if (metadata) {
      return toListedArtifact(metadata, now);
    }
  } catch {
    // Fall through to legacy artifact discovery below.
  }

  const legacyMetadata = await readLegacyArtifactMetadata(id);
  return legacyMetadata ? toListedArtifact(legacyMetadata, now) : null;
}

async function normalizeStoredArtifactMetadata(
  id: string,
  input: unknown
): Promise<ArtifactMetadata | null> {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const filename = typeof record.filename === "string" ? record.filename : "";

  if (!isSafeFilename(filename)) {
    return null;
  }

  const kind = normalizeArtifactKind(record.kind, filename);
  const filePath = path.join(getArtifactDirectory(), id, filename);
  const fileStats = await stat(filePath);
  const createdAt = normalizeIsoDate(record.createdAt) ?? fileStats.birthtime.toISOString();
  const expiresAt = normalizeIsoDate(record.expiresAt);

  return createArtifactMetadata({
    id,
    kind,
    filename,
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : filename,
    createdAt,
    expiresAt,
    bytes: typeof record.bytes === "number" && record.bytes >= 0 ? record.bytes : fileStats.size
  });
}

async function readLegacyArtifactMetadata(id: string): Promise<ArtifactMetadata | null> {
  const artifactDir = path.join(getArtifactDirectory(), id);

  try {
    const files = await readdir(artifactDir);
    const filename = files.find((file) => isSafeFilename(file));

    if (!filename) {
      return null;
    }

    const fileStats = await stat(path.join(artifactDir, filename));

    return createArtifactMetadata({
      id,
      kind: normalizeArtifactKind(undefined, filename),
      filename,
      title: filename,
      createdAt: fileStats.birthtime.toISOString(),
      bytes: fileStats.size
    });
  } catch {
    return null;
  }
}

function createArtifactMetadata({
  id,
  kind,
  filename,
  title,
  createdAt,
  expiresAt,
  bytes
}: {
  id: string;
  kind: ArtifactKind;
  filename: string;
  title: string;
  createdAt: string;
  expiresAt?: string;
  bytes: number;
}): ArtifactMetadata {
  const rawUrl = `${getArtifactBaseUrl()}/artifacts/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`;
  const previewUrl =
    kind === "markdown"
      ? `${getArtifactBaseUrl()}/artifacts/${encodeURIComponent(id)}/preview`
      : rawUrl;

  return {
    id,
    kind,
    filename,
    title,
    rawUrl,
    previewUrl,
    path: path.join(getArtifactDirectory(), id, filename),
    createdAt,
    ...(expiresAt ? { expiresAt } : {}),
    bytes
  };
}

function toListedArtifact(artifact: ArtifactMetadata, now: Date): ListedArtifact {
  return {
    ...artifact,
    shortId: artifact.id.slice(0, 8),
    expired: isArtifactExpired(artifact, now)
  };
}

function isArtifactExpired(artifact: ArtifactMetadata, now: Date) {
  return Boolean(artifact.expiresAt && Date.parse(artifact.expiresAt) <= now.getTime());
}

function normalizeArtifactKind(kind: unknown, filename: string): ArtifactKind {
  if (kind === "html" || kind === "markdown") {
    return kind;
  }

  return filename.endsWith(".md") ? "markdown" : "html";
}

function normalizeIsoDate(input: unknown) {
  if (typeof input !== "string") {
    return undefined;
  }

  const timestamp = Date.parse(input);

  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  return new Date(timestamp).toISOString();
}

function resolveArtifactExpiresAt(
  input: {
    expiresAt?: string;
    expiresInDays?: number | string | null;
  },
  createdAt: Date
) {
  if (input.expiresAt && input.expiresInDays !== undefined && input.expiresInDays !== null) {
    throw new Error("Use either expiresAt or expiresInDays, not both.");
  }

  if (input.expiresAt) {
    const normalizedDate = normalizeIsoDate(input.expiresAt);

    if (!normalizedDate) {
      throw new Error("Artifact expiresAt must be a valid date.");
    }

    return normalizedDate;
  }

  const expiresInDays =
    input.expiresInDays === undefined || input.expiresInDays === null
      ? parseArtifactTtlDaysFromEnv()
      : parsePositiveDays(input.expiresInDays, "expiresInDays");

  return expiresInDays ? new Date(createdAt.getTime() + expiresInDays * MS_PER_DAY).toISOString() : undefined;
}

function parseArtifactTtlDaysFromEnv() {
  const rawValue = process.env.ARTIFACT_TTL_DAYS?.trim();

  if (!rawValue || rawValue === "0" || rawValue.toLowerCase() === "never") {
    return undefined;
  }

  return parsePositiveDays(rawValue, "ARTIFACT_TTL_DAYS");
}

function parsePositiveDays(input: number | string, label: string) {
  const value = typeof input === "number" ? input : Number(input);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number of days.`);
  }

  return value;
}

async function sendMarkdownPreview(
  response: ServerResponse<IncomingMessage>,
  artifactDir: string
) {
  const markdownPath = await findMarkdownArtifactPath(artifactDir);

  if (!markdownPath) {
    sendText(response, 404, "Artifact not found");
    return;
  }

  const markdown = await readFile(markdownPath, "utf8");
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(renderMarkdownPreview(markdown));
}

async function createMarkdownPreviewResponse(artifactDir: string) {
  const markdownPath = await findMarkdownArtifactPath(artifactDir);

  if (!markdownPath) {
    return textResponse("Artifact not found", 404);
  }

  const markdown = await readFile(markdownPath, "utf8");
  return new Response(renderMarkdownPreview(markdown), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8"
    }
  });
}

async function findMarkdownArtifactPath(artifactDir: string) {
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(artifactDir);
    const markdownFile = files.find((file) => file.endsWith(".md"));
    return markdownFile ? path.join(artifactDir, markdownFile) : null;
  } catch {
    return null;
  }
}

function renderMarkdownPreview(markdown: string) {
  const html = markdown
    .split(/\n{2,}/)
    .map((block) => renderMarkdownBlock(block.trim()))
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Markdown Artifact Preview</title>
  <style>
    body {
      color: #202124;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.6;
      margin: 0 auto;
      max-width: 820px;
      padding: 40px 24px;
    }
    pre {
      background: #f6f8fa;
      border-radius: 6px;
      overflow-x: auto;
      padding: 16px;
    }
    code {
      background: #f6f8fa;
      border-radius: 4px;
      padding: 0.1em 0.3em;
    }
    pre code {
      background: transparent;
      padding: 0;
    }
    blockquote {
      border-left: 4px solid #d0d7de;
      color: #57606a;
      margin-left: 0;
      padding-left: 16px;
    }
  </style>
</head>
<body>
${html}
</body>
</html>`;
}

function renderMarkdownBlock(block: string) {
  if (!block) {
    return "";
  }

  if (block.startsWith("```")) {
    const code = block.replace(/^```\w*\n?/, "").replace(/```$/, "");
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }

  const headingMatch = block.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1]?.length ?? 1;
    return `<h${level}>${formatInlineMarkdown(headingMatch[2] ?? "")}</h${level}>`;
  }

  if (/^[-*]\s+/m.test(block)) {
    const items = block
      .split("\n")
      .filter((line) => /^[-*]\s+/.test(line))
      .map((line) => `<li>${formatInlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }

  if (/^>\s+/m.test(block)) {
    return `<blockquote>${formatInlineMarkdown(block.replace(/^>\s+/gm, ""))}</blockquote>`;
  }

  return `<p>${block.split("\n").map(formatInlineMarkdown).join("<br>")}</p>`;
}

function formatInlineMarkdown(input: string) {
  return escapeHtml(input)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" rel="noreferrer" target="_blank">$1</a>'
    );
}

function sanitizeFilename(filename: string, extension: string) {
  const withoutPath = filename.split(/[\\/]/).at(-1) ?? "";
  const trimmed = withoutPath.trim().toLowerCase();
  const withoutExtension = trimmed.replace(/\.(html|htm|md|markdown)$/i, "");
  const basename = withoutExtension
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${basename || "artifact"}${extension}`;
}

function isSafeArtifactId(input: string) {
  return /^[0-9a-f-]{36}$/.test(input);
}

function isSafeFilename(input: string) {
  return /^[a-z0-9._-]+\.(html|md)$/.test(input);
}

function getContentType(filename: string) {
  if (filename.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (filename.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }

  return "text/plain; charset=utf-8";
}

function getArtifactDirectory() {
  return path.resolve(process.env.ARTIFACT_DIR ?? DEFAULT_ARTIFACT_DIR);
}

function getArtifactBaseUrl() {
  return (
    process.env.ARTIFACT_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    `http://localhost:${process.env.PORT ?? "3000"}`
  ).replace(/\/+$/, "");
}

function sendText(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  body: string
) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}

function textResponse(body: string, status: number) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8"
    }
  });
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
