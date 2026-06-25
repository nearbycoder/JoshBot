import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createArtifact,
  deleteArtifact,
  deleteExpiredArtifacts,
  diffArtifactVersion,
  handleArtifactFetchRequest,
  listArtifactVersions,
  listArtifacts,
  listRecentArtifacts,
  rollbackArtifact,
  updateArtifact
} from "../lib/artifacts.js";
import { handleArtifactCommandText } from "../lib/artifact-commands.js";

test("creates artifact metadata, lists it, and serves raw content", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "markdown",
      title: "Launch notes",
      content: "# Hello",
      ownerUserId: "U123",
      expiresInDays: "2"
    });
    const payload = JSON.parse(
      await readFile(path.join(process.env.ARTIFACT_DIR ?? "", artifact.id, ".artifact.json"), "utf8")
    ) as Record<string, unknown>;

    assert.equal(payload.id, artifact.id);
    assert.equal(payload.ownerUserId, "U123");
    assert.equal(payload.expiresAt, artifact.expiresAt);

    const artifacts = await listArtifacts({ ownerUserId: "U123" });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.shortId, artifact.id.slice(0, 8));
    assert.equal(artifacts[0]?.expired, false);
    assert.match(artifacts[0]?.previewUrl ?? "", /^https:\/\/nobo.test\/artifacts\//);

    const recentArtifacts = await listRecentArtifacts(1, { ownerUserId: "U123" });
    assert.equal(recentArtifacts[0]?.id, artifact.id);
    assert.equal(recentArtifacts[0]?.updatedAt, artifact.createdAt);

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
      content: "bye",
      ownerUserId: "U123"
    });
    const result = await deleteArtifact(artifact.id.slice(0, 8), { ownerUserId: "U123" });

    assert.equal(result.ok, true);
    assert.equal((await listArtifacts({ includeExpired: true })).length, 0);
  });
});

test("only owners can update or delete artifacts", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "markdown",
      title: "Owned",
      content: "old",
      ownerUserId: "U123"
    });

    const otherDelete = await deleteArtifact(artifact.id, { ownerUserId: "U999" });
    assert.equal(otherDelete.ok, false);
    assert.equal(otherDelete.reason, "missing");

    const update = await updateArtifact({
      idPrefix: artifact.id.slice(0, 8),
      ownerUserId: "U123",
      content: "new"
    });
    assert.equal(update.ok, true);

    const response = await handleArtifactFetchRequest(new Request(artifact.rawUrl));
    assert.equal(response?.status, 200);
    assert.equal(await response?.text(), "new");
  });
});

test("updates retain capped prior artifact versions", async () => {
  await withTempArtifactDir(async () => {
    process.env.ARTIFACT_MAX_VERSIONS = "2";
    const artifact = await createArtifact({
      kind: "markdown",
      title: "Changelog",
      content: "one",
      ownerUserId: "U123"
    });

    await updateArtifact({
      idPrefix: artifact.id,
      ownerUserId: "U123",
      content: "two"
    });
    await updateArtifact({
      idPrefix: artifact.id,
      ownerUserId: "U123",
      content: "three"
    });
    await updateArtifact({
      idPrefix: artifact.id,
      ownerUserId: "U123",
      content: "four"
    });

    const versions = await listArtifactVersions(artifact.id, { ownerUserId: "U123" });
    assert.equal(versions.ok, true);
    assert.deepEqual(versions.versions.map((version) => version.versionId), ["v3", "v2"]);

    const storedVersion = JSON.parse(
      await readFile(path.join(process.env.ARTIFACT_DIR ?? "", artifact.id, ".versions", "v3.json"), "utf8")
    ) as Record<string, unknown>;
    assert.equal(storedVersion.content, "three");
  });
});

test("diffs a retained version against current content", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "markdown",
      title: "Diff me",
      content: "alpha\nbeta",
      ownerUserId: "U123"
    });
    await updateArtifact({
      idPrefix: artifact.id,
      ownerUserId: "U123",
      content: "alpha\ngamma"
    });

    const diff = await diffArtifactVersion(artifact.id.slice(0, 8), "v1", { ownerUserId: "U123" });
    assert.equal(diff.ok, true);
    assert.match(diff.diff, /^ alpha\n-beta\n\+gamma$/);

    const command = await handleArtifactCommandText(`diff ${artifact.id.slice(0, 8)} v1`, {
      ownerUserId: "U123"
    });
    assert.match(command, /```diff/);
    assert.match(command, /-beta/);
    assert.match(command, /\+gamma/);
  });
});

test("rolls back artifacts without changing same-filename URLs", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "markdown",
      title: "Rollback",
      filename: "rollback.md",
      content: "old",
      ownerUserId: "U123"
    });
    await updateArtifact({
      idPrefix: artifact.id,
      ownerUserId: "U123",
      content: "new"
    });

    const rollback = await rollbackArtifact(artifact.id.slice(0, 8), "v1", { ownerUserId: "U123" });
    assert.equal(rollback.ok, true);
    assert.equal(rollback.artifact.rawUrl, artifact.rawUrl);

    const response = await handleArtifactFetchRequest(new Request(artifact.rawUrl));
    assert.equal(response?.status, 200);
    assert.equal(await response?.text(), "old");

    const versions = await listArtifactVersions(artifact.id, { ownerUserId: "U123" });
    assert.equal(versions.ok, true);
    assert.equal(versions.versions[0]?.versionId, "v2");
  });
});

test("artifact history commands enforce ownership", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "markdown",
      title: "Private history",
      content: "old",
      ownerUserId: "U123"
    });
    await updateArtifact({
      idPrefix: artifact.id,
      ownerUserId: "U123",
      content: "new"
    });

    const list = await listArtifactVersions(artifact.id, { ownerUserId: "U999" });
    assert.equal(list.ok, false);
    assert.equal(list.reason, "missing");

    const diff = await diffArtifactVersion(artifact.id, "v1", { ownerUserId: "U999" });
    assert.equal(diff.ok, false);
    assert.equal(diff.reason, "missing");

    const rollback = await rollbackArtifact(artifact.id, "v1", { ownerUserId: "U999" });
    assert.equal(rollback.ok, false);
    assert.equal(rollback.reason, "missing");

    const command = await handleArtifactCommandText(`rollback ${artifact.id.slice(0, 8)} v1`, {
      ownerUserId: "U999"
    });
    assert.match(command, /one of your artifacts/);
  });
});

async function withTempArtifactDir(run: () => Promise<void>) {
  const previousDir = process.env.ARTIFACT_DIR;
  const previousBaseUrl = process.env.ARTIFACT_BASE_URL;
  const previousTtlDays = process.env.ARTIFACT_TTL_DAYS;
  const previousMaxVersions = process.env.ARTIFACT_MAX_VERSIONS;
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
    restoreEnv("ARTIFACT_MAX_VERSIONS", previousMaxVersions);
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
