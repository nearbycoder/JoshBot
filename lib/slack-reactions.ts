import { respondToSlackMention } from "./slack.js";

export type SlackReactionAddedEvent = {
  type: "reaction_added";
  user: string;
  reaction: string;
  item_user?: string;
  item: {
    type: "message";
    channel: string;
    ts: string;
    channel_type?: string;
  };
  event_ts: string;
  team_id?: string;
};

type SlackReactionShortcut = "summary" | "note" | "reminder";

const SUMMARY_REACTIONS = new Set([
  "nobo-summary",
  "summary",
  "summarize",
  "summarise",
  "thread-summary"
]);
const NOTE_REACTIONS = new Set([
  "nobo-note",
  "nobo-artifact",
  "note",
  "artifact",
  "memo",
  "page-facing-up",
  "spiral-note-pad"
]);
const REMINDER_REACTIONS = new Set([
  "nobo-remind",
  "nobo-reminder",
  "remind",
  "reminder",
  "alarm-clock"
]);

export async function handleSlackReactionShortcut(event: SlackReactionAddedEvent) {
  const shortcut = getSlackReactionShortcut(event.reaction);

  if (!shortcut || shouldIgnoreReactionShortcutEvent(event)) {
    return;
  }

  await respondToSlackMention(createReactionShortcutMessageEvent(event, shortcut));
}

function getSlackReactionShortcut(reaction: string): SlackReactionShortcut | null {
  const normalized = normalizeReactionName(reaction);

  if (SUMMARY_REACTIONS.has(normalized)) {
    return "summary";
  }

  if (NOTE_REACTIONS.has(normalized)) {
    return "note";
  }

  if (REMINDER_REACTIONS.has(normalized)) {
    return "reminder";
  }

  return null;
}

function shouldIgnoreReactionShortcutEvent(event: SlackReactionAddedEvent) {
  const botUserId = process.env.SLACK_BOT_USER_ID;

  return Boolean(botUserId && (event.user === botUserId || event.item_user === botUserId));
}

function createReactionShortcutMessageEvent(
  event: SlackReactionAddedEvent,
  shortcut: SlackReactionShortcut
) {
  return {
    channel: event.item.channel,
    channel_type: event.item.channel_type,
    text: getReactionShortcutPrompt(shortcut),
    thread_ts: event.item.ts,
    ts: event.event_ts,
    team_id: event.team_id,
    user: event.user
  };
}

function getReactionShortcutPrompt(shortcut: SlackReactionShortcut) {
  switch (shortcut) {
    case "summary":
      return "summarize-thread";
    case "note":
      return "Create a concise Markdown note artifact from this Slack thread. Include a short summary, key decisions, open questions, and next actions. Use the create_artifact tool and link the artifact.";
    case "reminder":
      return "Create a reminder for me tomorrow at 9 AM America/Chicago to revisit this Slack thread. Use a short reminder text that references the thread context.";
  }
}

function normalizeReactionName(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/^:+|:+$/g, "")
    .replace(/[_\s]+/g, "-");
}

export const __testing = {
  createReactionShortcutMessageEvent,
  getSlackReactionShortcut,
  normalizeReactionName,
  shouldIgnoreReactionShortcutEvent
};
