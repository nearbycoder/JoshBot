import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createArtifact } from "../lib/artifacts.js";
import type { SlackChannelHistoryEntry } from "../lib/channel-history.js";
import { handleSlackSlashCommandPayload } from "../lib/slack-commands.js";
import {
  handleSemanticSearchCommandText,
  LexicalSemanticSearchProvider,
  type SemanticSearchDocument
} from "../lib/semantic-search.js";

test("lexical semantic search ranks exact phrase matches first", () => {
  const provider = new LexicalSemanticSearchProvider();
  const documents: SemanticSearchDocument[] = [
    {
      id: "1",
      source: "channel-message",
      title: "General update",
      text: "The database is healthy after the cache deploy."
    },
    {
      id: "2",
      source: "artifact",
      title: "Database migration plan",
      text: "Database migration rollout plan with rollback steps and ownership."
    },
    {
      id: "3",
      source: "channel-message",
      title: "Frontend notes",
      text: "Button spacing and menu polish."
    }
  ];

  const results = provider.search("database migration", documents, { limit: 3 });

  assert.equal(results[0]?.document.id, "2");
  assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));
  assert.equal(results.some((result) => result.document.id === "3"), false);
});

test("semantic search scopes artifacts to requester and searches current channel history", async () => {
  await withTempArtifactDir(async () => {
    const ownArtifact = await createArtifact({
      kind: "markdown",
      title: "Billing rollout",
      content: "Billing migration checklist and launch owner map.",
      ownerUserId: "U123"
    });
    await createArtifact({
      kind: "markdown",
      title: "Other user's billing notes",
      content: "Billing migration secret from someone else.",
      ownerUserId: "U999"
    });

    const reply = await handleSemanticSearchCommandText(
      "billing migration",
      { channelId: "C123", ownerUserId: "U123" },
      {
        fetchChannelHistory: async ({ channel }) => {
          assert.equal(channel, "C123");
          return [
            message("1710000000.000001", "C123 billing migration is blocked by pricing review."),
            message("1710000001.000001", "Lunch plans.")
          ];
        }
      }
    );

    assert.match(reply, /Search results/);
    assert.match(reply, new RegExp(ownArtifact.id.slice(0, 8)));
    assert.match(reply, /pricing review/);
    assert.doesNotMatch(reply, /Other user's billing notes/);
  });
});

test("slash command returns semantic search output without requiring Slack API in tests", async () => {
  await withTempArtifactDir(async () => {
    await createArtifact({
      kind: "markdown",
      title: "Launch plan",
      content: "Feature flags, QA checklist, and launch handoff.",
      ownerUserId: "U123"
    });

    const result = await handleSlackSlashCommandPayload(
      {
        command: "/nobo-search",
        text: "launch checklist",
        channel_id: "C123",
        user_id: "U123"
      },
      {
        semanticSearchDependencies: {
          fetchChannelHistory: async () => [
            message("1710000002.000001", "Launch checklist needs signoff by Thursday.")
          ]
        }
      }
    );

    assert.equal(result.response.response_type, "ephemeral");
    assert.match(result.response.text, /\*Search results for\* `launch checklist`/);
    assert.match(result.response.text, /Artifact/);
    assert.match(result.response.text, /Channel/);
    assert.equal(result.task, undefined);
  });
});

test("semantic search reports missing Slack scopes", async () => {
  const reply = await handleSemanticSearchCommandText(
    "anything",
    {},
    {
      provider: new LexicalSemanticSearchProvider()
    }
  );

  assert.match(reply, /No matching channel messages or artifacts/);
  assert.match(reply, /Skipped channel history/);
  assert.match(reply, /Skipped artifacts/);
});

function message(ts: string, text: string): SlackChannelHistoryEntry {
  return {
    ts,
    datetime: new Date(Number(ts.split(".")[0]) * 1000).toISOString(),
    speaker: "User U123",
    text
  };
}

async function withTempArtifactDir(run: () => Promise<void>) {
  const previousDir = process.env.ARTIFACT_DIR;
  const previousBaseUrl = process.env.ARTIFACT_BASE_URL;
  const artifactDir = await mkdtemp(path.join(tmpdir(), "nobo-search-artifacts-"));

  process.env.ARTIFACT_DIR = artifactDir;
  process.env.ARTIFACT_BASE_URL = "https://nobo.test";

  try {
    await run();
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    restoreEnv("ARTIFACT_DIR", previousDir);
    restoreEnv("ARTIFACT_BASE_URL", previousBaseUrl);
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
