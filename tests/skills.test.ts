import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createArtifact } from "../lib/artifacts.js";
import { __testing, maybeHandleSlackSkillCommand } from "../lib/skills.js";

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

test("parses meeting notes skill aliases", () => {
  assert.deepEqual(__testing.parseSkillCommand("meeting-notes artifact"), {
    name: "meeting-notes",
    args: "artifact"
  });
  assert.deepEqual(__testing.parseSkillCommand("meeting notes as markdown"), {
    name: "meeting-notes",
    args: "as markdown"
  });
  assert.deepEqual(__testing.parseSkillCommand("notes focus on launch risks"), {
    name: "meeting-notes",
    args: "focus on launch risks"
  });
});

test("builds meeting notes prompts with artifact intent", () => {
  assert.equal(__testing.isMeetingNotesArtifactRequested("save as markdown artifact"), true);

  const prompt = __testing.buildMeetingNotesUserPrompt("save as markdown artifact for launch", true);
  const instructions = __testing.buildMeetingNotesInstructions(true);

  assert.match(prompt, /meeting-notes skill/);
  assert.match(prompt, /Create a Markdown artifact/);
  assert.match(prompt, /Extra user guidance: for launch/);
  assert.match(instructions, /Summary, Decisions, Action items, Blockers/);
  assert.match(instructions, /Slack huddle\/transcript metadata/);
  assert.match(instructions, /create_artifact/);
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
