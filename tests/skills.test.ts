import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createArtifact } from "../lib/artifacts.js";
import { maybeHandleSlackSkillCommand } from "../lib/skills.js";

test("lists artifacts through Slack skill command", async () => {
  await withTempArtifactDir(async () => {
    const artifact = await createArtifact({
      kind: "markdown",
      title: "Skill artifact",
      content: "hello",
      ownerUserId: "U123"
    });
    const reply = await maybeHandleSlackSkillCommand({
      commandText: "artifacts",
      modelMessages: [],
      memories: [],
      currentUserId: "U123"
    });

    assert.match(reply ?? "", /\*Artifacts\*/);
    assert.match(reply ?? "", new RegExp(artifact.id.slice(0, 8)));
  });
});

test("shows issue skill help without model calls", async () => {
  const reply = await maybeHandleSlackSkillCommand({
    commandText: "issues help",
    modelMessages: [],
    memories: [],
    currentUserId: "U123"
  });

  assert.match(reply ?? "", /NoBo issues/);
  assert.match(reply ?? "", /current thread follow-ups/);
});

async function withTempArtifactDir(run: () => Promise<void>) {
  const previousDir = process.env.ARTIFACT_DIR;
  const previousBaseUrl = process.env.ARTIFACT_BASE_URL;
  const previousTtlDays = process.env.ARTIFACT_TTL_DAYS;
  const artifactDir = await mkdtemp(path.join(tmpdir(), "nobo-skill-artifacts-"));

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
