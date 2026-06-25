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
  ownerUserId?: string;
  rawUrl: string;
  previewUrl: string;
  path: string;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;
  bytes: number;
};

export type CreatedArtifact = ArtifactMetadata;

export type ListedArtifact = ArtifactMetadata & {
  shortId: string;
  expired: boolean;
};

export type RecentArtifact = ListedArtifact & {
  updatedAt: string;
};

export type ArtifactVersion = {
  artifactId: string;
  versionId: string;
  kind: ArtifactKind;
  filename: string;
  title: string;
  ownerUserId?: string;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;
  bytes: number;
  savedAt: string;
  content: string;
};

export type ListedArtifactVersion = Omit<ArtifactVersion, "content"> & {
  shortId: string;
};

export type ArtifactLookupResult =
  | { status: "found"; artifact: ListedArtifact }
  | { status: "missing" }
  | { status: "ambiguous"; matches: ListedArtifact[] }
  | { status: "invalid" };

export type DeleteArtifactResult =
  | { ok: true; artifact: ListedArtifact }
  | { ok: false; reason: "invalid" | "missing" | "ambiguous" | "forbidden"; matches?: ListedArtifact[] };

export type UpdateArtifactResult =
  | { ok: true; artifact: ListedArtifact }
  | { ok: false; reason: "invalid" | "missing" | "ambiguous" | "forbidden"; matches?: ListedArtifact[] };

export type ArtifactOperationFailure = {
  ok: false;
  reason: "invalid" | "missing" | "ambiguous" | "forbidden" | "version_missing";
  matches?: ListedArtifact[];
};

export type ArtifactVersionsResult =
  | { ok: true; artifact: ListedArtifact; versions: ListedArtifactVersion[] }
  | ArtifactOperationFailure;

export type ArtifactDiffResult =
  | { ok: true; artifact: ListedArtifact; version: ListedArtifactVersion; diff: string }
  | ArtifactOperationFailure;

export type RollbackArtifactResult =
  | { ok: true; artifact: ListedArtifact; rolledBackTo: ListedArtifactVersion }
  | ArtifactOperationFailure;

export type DeleteExpiredArtifactsResult = {
  deleted: ListedArtifact[];
};

const DEFAULT_ARTIFACT_DIR = "artifacts";
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 2;
const ARTIFACT_METADATA_FILENAME = ".artifact.json";
const ARTIFACT_VERSIONS_DIRNAME = ".versions";
const DEFAULT_MAX_ARTIFACT_VERSIONS = 10;
const MAX_DIFF_LINES = 160;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function createArtifact({
  kind,
  title,
  filename,
  content,
  ownerUserId,
  expiresAt,
  expiresInDays
}: {
  kind: ArtifactKind;
  title: string;
  filename?: string;
  content: string;
  ownerUserId?: string;
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
    ...(ownerUserId ? { ownerUserId } : {}),
    rawUrl,
    previewUrl,
    path: targetPath,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
    ...(resolvedExpiresAt ? { expiresAt: resolvedExpiresAt } : {}),
    bytes
  };

  await writeFile(path.join(targetDir, ARTIFACT_METADATA_FILENAME), JSON.stringify(artifact, null, 2), "utf8");

  return artifact;
}

export async function listArtifacts({
  includeExpired = false,
  limit,
  now = new Date(),
  ownerUserId
}: {
  includeExpired?: boolean;
  limit?: number;
  now?: Date;
  ownerUserId?: string;
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

  const ownedArtifacts = ownerUserId
    ? artifacts.filter((artifact) => artifact.ownerUserId === ownerUserId)
    : artifacts;
  const filteredArtifacts = includeExpired
    ? ownedArtifacts
    : ownedArtifacts.filter((artifact) => !artifact.expired);
  const sortedArtifacts = filteredArtifacts.sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
  );

  return typeof limit === "number" && limit > 0 ? sortedArtifacts.slice(0, limit) : sortedArtifacts;
}

export async function listRecentArtifacts(
  limit = 5,
  options: { ownerUserId?: string } = {}
): Promise<RecentArtifact[]> {
  const artifacts = await listArtifacts({ limit, ownerUserId: options.ownerUserId });
  return artifacts.map((artifact) => ({
    ...artifact,
    updatedAt: artifact.updatedAt ?? artifact.createdAt
  }));
}

export async function findArtifact(
  idPrefix: string,
  options: { ownerUserId?: string } = {}
): Promise<ArtifactLookupResult> {
  const normalizedPrefix = idPrefix.trim().toLowerCase();

  if (!/^[0-9a-f-]{4,36}$/.test(normalizedPrefix)) {
    return { status: "invalid" };
  }

  if (isSafeArtifactId(normalizedPrefix)) {
    const artifact = await loadArtifactMetadata(normalizedPrefix, new Date());
    if (artifact && options.ownerUserId && artifact.ownerUserId !== options.ownerUserId) {
      return { status: "missing" };
    }
    return artifact ? { status: "found", artifact } : { status: "missing" };
  }

  const matches = (await listArtifacts({
    includeExpired: true,
    ownerUserId: options.ownerUserId
  })).filter((artifact) => artifact.id.startsWith(normalizedPrefix));

  if (matches.length === 0) {
    return { status: "missing" };
  }

  if (matches.length > 1) {
    return { status: "ambiguous", matches };
  }

  return { status: "found", artifact: matches[0] as ListedArtifact };
}

export async function deleteArtifact(
  idPrefix: string,
  options: { ownerUserId?: string } = {}
): Promise<DeleteArtifactResult> {
  if (!options.ownerUserId) {
    return { ok: false, reason: "forbidden" };
  }

  const match = await findArtifact(idPrefix, options);

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

export async function updateArtifact({
  idPrefix,
  ownerUserId,
  kind,
  title,
  filename,
  content,
  expiresAt,
  expiresInDays
}: {
  idPrefix: string;
  ownerUserId?: string;
  kind?: ArtifactKind;
  title?: string;
  filename?: string;
  content: string;
  expiresAt?: string;
  expiresInDays?: number | string | null;
}): Promise<UpdateArtifactResult> {
  if (!ownerUserId) {
    return { ok: false, reason: "forbidden" };
  }

  const match = await findArtifact(idPrefix, { ownerUserId });

  if (match.status === "invalid") {
    return { ok: false, reason: "invalid" };
  }

  if (match.status === "missing") {
    return { ok: false, reason: "missing" };
  }

  if (match.status === "ambiguous") {
    return { ok: false, reason: "ambiguous", matches: match.matches };
  }

  const bytes = Buffer.byteLength(content, "utf8");

  if (bytes > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact is too large (${bytes} bytes). Limit is ${MAX_ARTIFACT_BYTES} bytes.`);
  }

  const existing = match.artifact;
  const updatedAt = new Date();
  const nextKind = kind ?? existing.kind;
  const extension = nextKind === "html" ? ".html" : ".md";
  const safeFilename = filename
    ? sanitizeFilename(filename, extension)
    : existing.kind === nextKind
      ? existing.filename
      : sanitizeFilename(existing.filename, extension);
  const artifactDir = path.join(getArtifactDirectory(), existing.id);
  const oldPath = path.join(artifactDir, existing.filename);
  const targetPath = path.join(artifactDir, safeFilename);
  const resolvedExpiresAt =
    expiresAt !== undefined || expiresInDays !== undefined
      ? resolveArtifactExpiresAt({ expiresAt, expiresInDays }, updatedAt)
      : existing.expiresAt;

  await mkdir(artifactDir, { recursive: true });
  await savePreviousArtifactVersion(existing, updatedAt);
  await writeFile(targetPath, content, "utf8");

  if (safeFilename !== existing.filename) {
    await rm(oldPath, { force: true });
  }

  const artifact = createArtifactMetadata({
    id: existing.id,
    kind: nextKind,
    filename: safeFilename,
    title: title?.trim() || existing.title,
    ownerUserId,
    createdAt: existing.createdAt,
    updatedAt: updatedAt.toISOString(),
    expiresAt: resolvedExpiresAt,
    bytes
  });

  await writeFile(path.join(artifactDir, ARTIFACT_METADATA_FILENAME), JSON.stringify(artifact, null, 2), "utf8");

  return {
    ok: true,
    artifact: toListedArtifact(artifact, updatedAt)
  };
}

export async function listArtifactVersions(
  idPrefix: string,
  options: { ownerUserId?: string } = {}
): Promise<ArtifactVersionsResult> {
  if (!options.ownerUserId) {
    return { ok: false, reason: "forbidden" };
  }

  const match = await findArtifact(idPrefix, options);

  if (match.status !== "found") {
    return artifactLookupFailure(match);
  }

  return {
    ok: true,
    artifact: match.artifact,
    versions: await readArtifactVersions(match.artifact.id)
  };
}

export async function diffArtifactVersion(
  idPrefix: string,
  versionId: string | undefined,
  options: { ownerUserId?: string } = {}
): Promise<ArtifactDiffResult> {
  if (!options.ownerUserId) {
    return { ok: false, reason: "forbidden" };
  }

  const match = await findArtifact(idPrefix, options);

  if (match.status !== "found") {
    return artifactLookupFailure(match);
  }

  const version = await findArtifactVersion(match.artifact.id, versionId);

  if (!version) {
    return { ok: false, reason: "version_missing" };
  }

  const currentContent = await readFile(match.artifact.path, "utf8");

  return {
    ok: true,
    artifact: match.artifact,
    version: toListedArtifactVersion(version),
    diff: formatUnifiedLineDiff(version.content, currentContent)
  };
}

export async function rollbackArtifact(
  idPrefix: string,
  versionId: string | undefined,
  options: { ownerUserId?: string } = {}
): Promise<RollbackArtifactResult> {
  if (!options.ownerUserId) {
    return { ok: false, reason: "forbidden" };
  }

  const match = await findArtifact(idPrefix, options);

  if (match.status !== "found") {
    return artifactLookupFailure(match);
  }

  const version = await findArtifactVersion(match.artifact.id, versionId);

  if (!version) {
    return { ok: false, reason: "version_missing" };
  }

  const now = new Date();
  const artifactDir = path.join(getArtifactDirectory(), match.artifact.id);
  const restoredPath = path.join(artifactDir, version.filename);

  await savePreviousArtifactVersion(match.artifact, now);
  await writeFile(restoredPath, version.content, "utf8");

  if (version.filename !== match.artifact.filename) {
    await rm(match.artifact.path, { force: true });
  }

  const artifact = createArtifactMetadata({
    id: match.artifact.id,
    kind: version.kind,
    filename: version.filename,
    title: version.title,
    ownerUserId: options.ownerUserId,
    createdAt: match.artifact.createdAt,
    updatedAt: now.toISOString(),
    expiresAt: version.expiresAt,
    bytes: Buffer.byteLength(version.content, "utf8")
  });

  await writeFile(path.join(artifactDir, ARTIFACT_METADATA_FILENAME), JSON.stringify(artifact, null, 2), "utf8");

  return {
    ok: true,
    artifact: toListedArtifact(artifact, now),
    rolledBackTo: toListedArtifactVersion(version)
  };
}

export async function deleteExpiredArtifacts({
  now = new Date(),
  ownerUserId
}: {
  now?: Date;
  ownerUserId?: string;
} = {}): Promise<DeleteExpiredArtifactsResult> {
  const expiredArtifacts = (await listArtifacts({ includeExpired: true, now, ownerUserId })).filter(
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
  const updatedAt = normalizeIsoDate(record.updatedAt);
  const expiresAt = normalizeIsoDate(record.expiresAt);

  return createArtifactMetadata({
    id,
    kind,
    filename,
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : filename,
    ownerUserId: typeof record.ownerUserId === "string" && record.ownerUserId.trim()
      ? record.ownerUserId.trim()
      : undefined,
    createdAt,
    updatedAt,
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

async function savePreviousArtifactVersion(artifact: ListedArtifact, savedAt: Date) {
  const maxVersions = parseMaxArtifactVersionsFromEnv();

  if (maxVersions <= 0) {
    return;
  }

  const content = await readFile(artifact.path, "utf8");
  const versionId = await getNextArtifactVersionId(artifact.id);
  const version: ArtifactVersion = {
    artifactId: artifact.id,
    versionId,
    kind: artifact.kind,
    filename: artifact.filename,
    title: artifact.title,
    ...(artifact.ownerUserId ? { ownerUserId: artifact.ownerUserId } : {}),
    createdAt: artifact.createdAt,
    ...(artifact.updatedAt ? { updatedAt: artifact.updatedAt } : {}),
    ...(artifact.expiresAt ? { expiresAt: artifact.expiresAt } : {}),
    bytes: artifact.bytes,
    savedAt: savedAt.toISOString(),
    content
  };
  const versionsDir = getArtifactVersionsDirectory(artifact.id);

  await mkdir(versionsDir, { recursive: true });
  await writeFile(path.join(versionsDir, `${versionId}.json`), JSON.stringify(version, null, 2), "utf8");
  await pruneArtifactVersions(artifact.id, maxVersions);
}

async function getNextArtifactVersionId(artifactId: string) {
  const versions = await readArtifactVersions(artifactId);
  const nextNumber =
    versions.reduce((max, version) => Math.max(max, parseArtifactVersionNumber(version.versionId)), 0) + 1;

  return `v${nextNumber}`;
}

async function readArtifactVersions(artifactId: string): Promise<ListedArtifactVersion[]> {
  return (await readArtifactVersionRecords(artifactId)).map(toListedArtifactVersion);
}

async function readArtifactVersionRecords(artifactId: string): Promise<ArtifactVersion[]> {
  let files;

  try {
    files = await readdir(getArtifactVersionsDirectory(artifactId));
  } catch {
    return [];
  }

  const versions = (
    await Promise.all(
      files
        .filter((file) => /^v\d+\.json$/.test(file))
        .map(async (file) => {
          try {
            const payload = await readFile(path.join(getArtifactVersionsDirectory(artifactId), file), "utf8");
            return normalizeArtifactVersion(artifactId, JSON.parse(payload));
          } catch {
            return null;
          }
        })
    )
  ).filter((version): version is ArtifactVersion => version !== null);

  return versions.sort(
    (left, right) => parseArtifactVersionNumber(right.versionId) - parseArtifactVersionNumber(left.versionId)
  );
}

async function findArtifactVersion(artifactId: string, versionId: string | undefined) {
  const versions = await readArtifactVersionRecords(artifactId);
  const normalizedVersionId = normalizeArtifactVersionId(versionId);

  if (!normalizedVersionId) {
    return versions[0] ?? null;
  }

  return versions.find((version) => version.versionId === normalizedVersionId) ?? null;
}

function normalizeArtifactVersion(artifactId: string, input: unknown): ArtifactVersion | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const versionId = normalizeArtifactVersionId(record.versionId);
  const filename = typeof record.filename === "string" ? record.filename : "";
  const content = typeof record.content === "string" ? record.content : null;
  const savedAt = normalizeIsoDate(record.savedAt);

  if (!versionId || !isSafeFilename(filename) || content === null || !savedAt) {
    return null;
  }

  const updatedAt = normalizeIsoDate(record.updatedAt);
  const expiresAt = normalizeIsoDate(record.expiresAt);

  return {
    artifactId,
    versionId,
    kind: normalizeArtifactKind(record.kind, filename),
    filename,
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : filename,
    ownerUserId: typeof record.ownerUserId === "string" && record.ownerUserId.trim()
      ? record.ownerUserId.trim()
      : undefined,
    createdAt: normalizeIsoDate(record.createdAt) ?? savedAt,
    ...(updatedAt ? { updatedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    bytes: typeof record.bytes === "number" && record.bytes >= 0
      ? record.bytes
      : Buffer.byteLength(content, "utf8"),
    savedAt,
    content
  };
}

function toListedArtifactVersion(version: ArtifactVersion): ListedArtifactVersion {
  const { content: _content, ...listedVersion } = version;

  return {
    ...listedVersion,
    shortId: version.artifactId.slice(0, 8)
  };
}

async function pruneArtifactVersions(artifactId: string, maxVersions: number) {
  const versions = await readArtifactVersionRecords(artifactId);

  await Promise.all(
    versions
      .slice(maxVersions)
      .map((version) => rm(path.join(getArtifactVersionsDirectory(artifactId), `${version.versionId}.json`), {
        force: true
      }))
  );
}

function artifactLookupFailure(
  match: Exclude<ArtifactLookupResult, { status: "found" }>
): ArtifactOperationFailure {
  if (match.status === "invalid") {
    return { ok: false, reason: "invalid" };
  }

  if (match.status === "missing") {
    return { ok: false, reason: "missing" };
  }

  if (match.status === "ambiguous") {
    return { ok: false, reason: "ambiguous", matches: match.matches };
  }

  return { ok: false, reason: "missing" };
}

function formatUnifiedLineDiff(before: string, after: string) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const table = Array.from({ length: beforeLines.length + 1 }, () => Array(afterLines.length + 1).fill(0));

  for (let leftIndex = beforeLines.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = afterLines.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex][rightIndex] = beforeLines[leftIndex] === afterLines[rightIndex]
        ? table[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(table[leftIndex + 1][rightIndex], table[leftIndex][rightIndex + 1]);
    }
  }

  const lines: string[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < beforeLines.length || rightIndex < afterLines.length) {
    if (beforeLines[leftIndex] === afterLines[rightIndex]) {
      lines.push(` ${beforeLines[leftIndex] ?? ""}`);
      leftIndex += 1;
      rightIndex += 1;
    } else if (leftIndex >= beforeLines.length) {
      lines.push(`+${afterLines[rightIndex] ?? ""}`);
      rightIndex += 1;
    } else if (rightIndex >= afterLines.length) {
      lines.push(`-${beforeLines[leftIndex] ?? ""}`);
      leftIndex += 1;
    } else if (table[leftIndex + 1][rightIndex] >= table[leftIndex][rightIndex + 1]) {
      lines.push(`-${beforeLines[leftIndex] ?? ""}`);
      leftIndex += 1;
    } else {
      lines.push(`+${afterLines[rightIndex] ?? ""}`);
      rightIndex += 1;
    }

    if (lines.length >= MAX_DIFF_LINES) {
      lines.push("...");
      break;
    }
  }

  return lines.join("\n");
}

function createArtifactMetadata({
  id,
  kind,
  filename,
  title,
  ownerUserId,
  createdAt,
  updatedAt,
  expiresAt,
  bytes
}: {
  id: string;
  kind: ArtifactKind;
  filename: string;
  title: string;
  ownerUserId?: string;
  createdAt: string;
  updatedAt?: string;
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
    ...(ownerUserId ? { ownerUserId } : {}),
    rawUrl,
    previewUrl,
    path: path.join(getArtifactDirectory(), id, filename),
    createdAt,
    ...(updatedAt ? { updatedAt } : {}),
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

function parseMaxArtifactVersionsFromEnv() {
  const rawValue = process.env.ARTIFACT_MAX_VERSIONS?.trim();

  if (!rawValue) {
    return DEFAULT_MAX_ARTIFACT_VERSIONS;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error("ARTIFACT_MAX_VERSIONS must be a non-negative integer.");
  }

  return value;
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

function normalizeArtifactVersionId(input: unknown) {
  if (typeof input !== "string" && typeof input !== "number") {
    return undefined;
  }

  const normalized = String(input).trim().toLowerCase();

  if (/^\d+$/.test(normalized)) {
    return `v${Number(normalized)}`;
  }

  return /^v\d+$/.test(normalized) ? normalized : undefined;
}

function parseArtifactVersionNumber(versionId: string) {
  return Number(versionId.replace(/^v/, ""));
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

function getArtifactVersionsDirectory(artifactId: string) {
  return path.join(getArtifactDirectory(), artifactId, ARTIFACT_VERSIONS_DIRNAME);
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
