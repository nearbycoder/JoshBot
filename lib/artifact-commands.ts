import {
  deleteArtifact,
  deleteExpiredArtifacts,
  listArtifacts,
  updateArtifact,
  type ListedArtifact
} from "./artifacts.js";

const DEFAULT_ARTIFACT_LIST_LIMIT = 10;

export async function handleArtifactCommandText(
  commandText: string,
  options: { ownerUserId?: string } = {}
) {
  const trimmed = commandText.trim();
  const normalized = trimmed.toLowerCase();

  if (!trimmed || normalized === "list") {
    return formatArtifactList(
      await listArtifacts({ limit: DEFAULT_ARTIFACT_LIST_LIMIT, ownerUserId: options.ownerUserId }),
      "Artifacts"
    );
  }

  if (normalized === "help") {
    return formatArtifactCommandHelp();
  }

  if (normalized === "all" || normalized === "list all") {
    return formatArtifactList(
      await listArtifacts({
        includeExpired: true,
        limit: DEFAULT_ARTIFACT_LIST_LIMIT,
        ownerUserId: options.ownerUserId
      }),
      "Artifacts"
    );
  }

  if (normalized === "expired" || normalized === "list expired") {
    const expiredArtifacts = (await listArtifacts({
      includeExpired: true,
      ownerUserId: options.ownerUserId
    })).filter((artifact) => artifact.expired);
    return formatArtifactList(expiredArtifacts.slice(0, DEFAULT_ARTIFACT_LIST_LIMIT), "Expired artifacts");
  }

  if (/^(cleanup|prune)(\s+expired)?$/.test(normalized)) {
    const result = await deleteExpiredArtifacts({ ownerUserId: options.ownerUserId });
    return result.deleted.length === 0
      ? "No expired artifacts to delete."
      : `Deleted ${result.deleted.length} expired artifact(s): ${result.deleted
          .map((artifact) => `\`${artifact.shortId}\``)
          .join(", ")}`;
  }

  const deleteMatch = trimmed.match(/^(?:delete|remove|rm)\s+([0-9a-f-]{4,36})$/i);
  if (deleteMatch) {
    const result = await deleteArtifact(deleteMatch[1] ?? "", {
      ownerUserId: options.ownerUserId
    });

    if (result.ok) {
      return `Deleted artifact \`${result.artifact.shortId}\`: ${escapeSlackText(result.artifact.title)}`;
    }

    if (result.reason === "ambiguous" && result.matches?.length) {
      return `That artifact ID matched more than one artifact:\n${formatArtifactLines(result.matches)}`;
    }

    if (result.reason === "invalid") {
      return "Artifact IDs are UUIDs or visible prefixes like `abc12345`.";
    }

    if (result.reason === "forbidden") {
      return "Artifact changes need a Slack user context.";
    }

    return "I couldn't find one of your artifacts with that ID.";
  }

  const updateMatch = trimmed.match(/^(?:update|edit|modify)\s+([0-9a-f-]{4,36})\s+([\s\S]+)$/i);
  if (updateMatch) {
    const result = await updateArtifact({
      idPrefix: updateMatch[1] ?? "",
      ownerUserId: options.ownerUserId,
      content: updateMatch[2] ?? ""
    });

    if (result.ok) {
      return `Updated artifact \`${result.artifact.shortId}\`: ${escapeSlackText(result.artifact.title)}`;
    }

    if (result.reason === "ambiguous" && result.matches?.length) {
      return `That artifact ID matched more than one artifact:\n${formatArtifactLines(result.matches)}`;
    }

    if (result.reason === "invalid") {
      return "Artifact IDs are UUIDs or visible prefixes like `abc12345`.";
    }

    if (result.reason === "forbidden") {
      return "Artifact changes need a Slack user context.";
    }

    return "I couldn't find one of your artifacts with that ID.";
  }

  return `Usage: ${formatArtifactCommandUsage()}`;
}

export function formatArtifactCommandHelp() {
  return [
    "*NoBo artifacts*",
    formatArtifactCommandUsage(),
    "`list all`: include expired artifacts",
    "`expired`: list only expired artifacts",
    "`update <id> <content>`: replace one of your artifacts",
    "`cleanup`: delete expired artifacts"
  ].join("\n");
}

function formatArtifactCommandUsage() {
  return "`list`, `update <id> <content>`, `delete <id>`, or `cleanup`";
}

function formatArtifactList(artifacts: ListedArtifact[], title: string) {
  if (artifacts.length === 0) {
    return `No ${title.toLowerCase()} found.`;
  }

  return `*${title}*\n${formatArtifactLines(artifacts)}`;
}

function formatArtifactLines(artifacts: ListedArtifact[]) {
  return artifacts.map(formatArtifactLine).join("\n");
}

function formatArtifactLine(artifact: ListedArtifact) {
  const expires = artifact.expired
    ? `expired ${formatDate(artifact.expiresAt)}`
    : artifact.expiresAt
      ? `expires ${formatDate(artifact.expiresAt)}`
      : "no expiry";

  return [
    `- \`${artifact.shortId}\` ${escapeSlackText(artifact.title)}`,
    `(${artifact.kind}, ${formatBytes(artifact.bytes)}, ${expires})`,
    `<${artifact.previewUrl}|preview>`,
    `<${artifact.rawUrl}|raw>`
  ].join(" ");
}

function formatDate(input: string | undefined) {
  return input ? input.slice(0, 10) : "unknown";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kib = bytes / 1024;

  if (kib < 1024) {
    return `${Math.round(kib)} KiB`;
  }

  return `${(kib / 1024).toFixed(1)} MiB`;
}

function escapeSlackText(input: string) {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
