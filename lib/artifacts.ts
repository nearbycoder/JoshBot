import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type IncomingMessage, type ServerResponse } from "node:http";

export type ArtifactKind = "html" | "markdown";

export type CreatedArtifact = {
  id: string;
  kind: ArtifactKind;
  filename: string;
  title: string;
  rawUrl: string;
  previewUrl: string;
  path: string;
};

const DEFAULT_ARTIFACT_DIR = "artifacts";
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 2;

export async function createArtifact({
  kind,
  title,
  filename,
  content
}: {
  kind: ArtifactKind;
  title: string;
  filename?: string;
  content: string;
}): Promise<CreatedArtifact> {
  const bytes = Buffer.byteLength(content, "utf8");

  if (bytes > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact is too large (${bytes} bytes). Limit is ${MAX_ARTIFACT_BYTES} bytes.`);
  }

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

  return {
    id,
    kind,
    filename: safeFilename,
    title: title.trim() || safeFilename,
    rawUrl,
    previewUrl,
    path: targetPath
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
