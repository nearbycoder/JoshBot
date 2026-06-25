import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createArtifact,
  deleteArtifact,
  deleteExpiredArtifacts,
  handleArtifactFetchRequest,
  listArtifacts
} from "../lib/artifacts.js";

test("creates artifact metadata, lists it, and serves raw content", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "markdown",
      title: "Launch notes",
      content: "# Hello",
      expiresInDays: "2"
    });
    const payload = JSON.parse(
      await readFile(path.join(process.env.ARTIFACT_DIR ?? "", artifact.id, ".artifact.json"), "utf8")
    ) as Record<string, unknown>;

    assert.equal(payload.id, artifact.id);
    assert.equal(payload.expiresAt, artifact.expiresAt);

    const artifacts = await listArtifacts();
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.shortId, artifact.id.slice(0, 8));
    assert.equal(artifacts[0]?.expired, false);
    assert.match(artifacts[0]?.previewUrl ?? "", /^https:\/\/nobo.test\/artifacts\//);

    const response = await handleArtifactFetchRequest(new Request(artifact.rawUrl));
    assert.equal(response?.status, 200);
    assert.equal(await response?.text(), "# Hello");
  });
});

test("expired artifacts still serve until cleanup deletes them", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "html",
      title: "Old page",
      content: "<!doctype html><title>Old</title>",
      expiresAt: "2000-01-01T00:00:00.000Z"
    });
    const now = new Date("2000-01-02T00:00:00.000Z");

    assert.equal((await listArtifacts({ includeExpired: true, now }))[0]?.expired, true);
    assert.equal((await listArtifacts({ now })).length, 0);

    const beforeCleanup = await handleArtifactFetchRequest(new Request(artifact.rawUrl));
    assert.equal(beforeCleanup?.status, 200);

    const cleanup = await deleteExpiredArtifacts({ now });
    assert.equal(cleanup.deleted.length, 1);

    const afterCleanup = await handleArtifactFetchRequest(new Request(artifact.rawUrl));
    assert.equal(afterCleanup?.status, 404);
  });
});

test("deletes artifacts by visible ID prefix", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "markdown",
      title: "Delete me",
      content: "bye"
    });
    const result = await deleteArtifact(artifact.id.slice(0, 8));

    assert.equal(result.ok, true);
    assert.equal((await listArtifacts({ includeExpired: true })).length, 0);
  });
});

async function withTempArtifactDir(run: () => Promise<void>) {
  const previousDir = process.env.ARTIFACT_DIR;
  const previousBaseUrl = process.env.ARTIFACT_BASE_URL;
  const previousTtlDays = process.env.ARTIFACT_TTL_DAYS;
  const artifactDir = await mkdtemp(path.join(tmpdir(), "nobo-artifacts-"));

  process.env.ARTIFACT_DIR = artifactDir;
  process.env.ARTIFACT_BASE_URL = "https://nobo.test";
  delete process.env.ARTIFACT_TTL_DAYS;

  try {
    await run();
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    restoreEnv("ARTIFACT_DIR", previousDir);
    restoreEnv("ARTIFACT_BASE_URL", previousBaseUrl);
    restoreEnv("ARTIFACT_TTL_DAYS", previousTtlDays);
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
