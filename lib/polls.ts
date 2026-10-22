import { randomUUID } from "node:crypto";
import type { ChannelDecision } from "./decisions.js";
import { getRedisClient } from "./redis.js";

const DEFAULT_POLL_LOG_MAX_ITEMS = 50;
const MAX_POLL_MUTATION_ATTEMPTS = 32;

type PollRedis = {
  get(key: string): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

let pollRedis: () => Promise<PollRedis | null> = getRedisClient;

// Compare the exact snapshot, then commit the poll and its optional decision together.
// No decision is appended on a failed comparison, so retries have no side effects.
const SAVE_POLL_MUTATION = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == 'missing' then
  if current then return 0 end
elseif current ~= ARGV[2] then
  return 0
end

if #KEYS == 2 then
  local decision = cjson.decode(ARGV[4])
  local payload = redis.call('GET', KEYS[2])
  local decisions = {}
  if payload then
    local ok, parsed = pcall(cjson.decode, payload)
    if ok and type(parsed) == 'table' then
      local records = parsed.decisions or parsed
      if type(records) == 'table' then
        for _, record in ipairs(records) do
          if type(record) == 'table' and record.channelId == decision.channelId
            and type(record.id) == 'string' and record.id ~= ''
            and type(record.text) == 'string' and string.find(record.text, '[^%s.!?]')
            and type(record.createdAt) == 'string' and record.createdAt ~= '' then
            table.insert(decisions, record)
          end
        end
      end
    end
  end
  table.insert(decisions, decision)
  while #decisions > 50 do table.remove(decisions, 1) end
  local nextDecisions = cjson.encode({ decisions = decisions })
  redis.call('MSET', KEYS[1], ARGV[3], KEYS[2], nextDecisions)
else
  redis.call('SET', KEYS[1], ARGV[3])
end
return 1
`;

export type SlackPoll = {
  id: string;
  channelId: string;
  question: string;
  options: SlackPollOption[];
  votes: Record<string, SlackPollVote>;
  status: "open" | "closed";
  createdAt: string;
  createdBy?: string;
  threadTs?: string;
  messageTs?: string;
  closedAt?: string;
  closedBy?: string;
  decisionId?: string;
};

type SlackPollOption = {
  id: string;
  text: string;
};

type SlackPollVote = {
  userId: string;
  optionId: string;
  source: "command" | "reaction";
  createdAt: string;
};

export type PollIntent =
  | { action: "create"; question: string; options: string[] }
  | { action: "list" }
  | { action: "summary"; pollId?: string }
  | { action: "vote"; pollId?: string; choice: string }
  | { action: "close"; pollId?: string; recordDecision: boolean; decisionText?: string }
  | { action: "decide"; pollId?: string; decisionText?: string }
  | { action: "help" };

export async function handlePollCommandText({
  text,
  channelId,
  userId,
  threadTs,
  messageTs,
  source
}: {
  text: string;
  channelId?: string;
  userId?: string;
  threadTs?: string;
  messageTs?: string;
  source: "slash-command" | "slack-message";
}) {
  if (!channelId) {
    return {
      responseType: "ephemeral" as const,
      text: "Slack did not send a channel for this command. Try again in a channel."
    };
  }

  const intent = parsePollIntent(text);

  if (!intent || intent.action === "help") {
    return {
      responseType: "ephemeral" as const,
      text: formatPollHelp()
    };
  }

  if (intent.action === "create") {
    const result = await createSlackPoll({
      channelId,
      question: intent.question,
      options: intent.options,
      userId,
      threadTs,
      messageTs
    });

    return {
      responseType: result.ok ? "in_channel" as const : "ephemeral" as const,
      text: result.ok ? formatPollCreated(result.poll) : `Couldn't create poll: ${result.reason}`
    };
  }

  if (intent.action === "list") {
    const result = await listSlackPolls(channelId);
    return {
      responseType: "ephemeral" as const,
      text: result.ok ? formatPollList(result.polls) : `Couldn't load polls: ${result.reason}`
    };
  }

  if (intent.action === "summary") {
    const result = await resolvePollForCommand(channelId, intent.pollId, threadTs);
    return {
      responseType: "ephemeral" as const,
      text: result.ok ? formatPollSummary(result.poll) : `Couldn't summarize poll: ${result.reason}`
    };
  }

  if (intent.action === "vote") {
    if (!userId) {
      return {
        responseType: "ephemeral" as const,
        text: "Slack did not send a user for this vote. Try again."
      };
    }

    const result = await recordSlackPollVote({
      channelId,
      pollId: intent.pollId,
      choice: intent.choice,
      userId,
      threadTs,
      source: "command"
    });

    return {
      responseType: result.ok ? "in_channel" as const : "ephemeral" as const,
      text: result.ok ? formatPollVoteRecorded(result.poll, result.option, userId) : `Couldn't record vote: ${result.reason}`
    };
  }

  if (intent.action === "close") {
    const result = await closeSlackPoll({
      channelId,
      pollId: intent.pollId,
      userId,
      threadTs,
      recordDecision: intent.recordDecision,
      decisionText: intent.decisionText,
      source
    });

    return {
      responseType: result.ok ? "in_channel" as const : "ephemeral" as const,
      text: result.ok ? formatPollClosed(result.poll, result.decisionText) : `Couldn't close poll: ${result.reason}`
    };
  }

  const result = await recordPollDecision({
    channelId,
    pollId: intent.pollId,
    userId,
    threadTs,
    decisionText: intent.decisionText,
    source
  });

  return {
    responseType: result.ok ? "in_channel" as const : "ephemeral" as const,
    text: result.ok ? `Recorded decision from poll: ${result.decisionText}` : `Couldn't record decision: ${result.reason}`
  };
}

export function parsePollIntent(input: string): PollIntent | null {
  const trimmed = collapseWhitespace(input);

  if (!trimmed) {
    return { action: "list" };
  }

  const unprefixed = trimmed.replace(/^(?:polls?|votes?)\s+/i, "");

  if (/^help$/i.test(unprefixed)) {
    return { action: "help" };
  }

  if (/^(?:list|show|open)$/i.test(unprefixed)) {
    return { action: "list" };
  }

  const createMatch = unprefixed.match(/^(?:create|new|open|ask)\s+(.+)$/i);
  if (createMatch) {
    return parseCreateIntent(createMatch[1] ?? "");
  }

  const voteMatch = unprefixed.match(/^(?:vote|choose)\s+(.+)$/i);
  if (voteMatch) {
    return parseVoteIntent(voteMatch[1] ?? "");
  }

  const summaryMatch = unprefixed.match(/^(?:summary|summarize|results?|status)(?:\s+(.+))?$/i);
  if (summaryMatch) {
    const pollId = normalizeOptionalText(summaryMatch[1]);
    return { action: "summary", ...(pollId ? { pollId } : {}) };
  }

  const closeMatch = unprefixed.match(/^(?:close|end)(?:\s+(.+))?$/i);
  if (closeMatch) {
    return parseCloseIntent(closeMatch[1] ?? "");
  }

  const decideMatch = unprefixed.match(/^(?:decide|decision|record-decision)(?:\s+(.+))?$/i);
  if (decideMatch) {
    return parseDecideIntent(decideMatch[1] ?? "");
  }

  return null;
}

export async function createSlackPoll({
  channelId,
  question,
  options,
  userId,
  threadTs,
  messageTs,
  createdAt = new Date().toISOString()
}: {
  channelId: string;
  question: string;
  options: string[];
  userId?: string;
  threadTs?: string;
  messageTs?: string;
  createdAt?: string;
}) {
  const redis = await pollRedis();

  if (!redis) {
    return { ok: false as const, reason: "Redis is not configured." };
  }

  const normalizedQuestion = normalizePollText(question);
  const normalizedOptions = normalizePollOptions(options);

  if (!normalizedQuestion) {
    return { ok: false as const, reason: "Question cannot be empty." };
  }

  if (normalizedOptions.length < 2) {
    return { ok: false as const, reason: "Poll needs at least two options." };
  }

  const poll: SlackPoll = {
    id: randomUUID(),
    channelId,
    question: normalizedQuestion,
    options: normalizedOptions.map((text, index) => ({ id: String(index + 1), text })),
    votes: {},
    status: "open",
    createdAt,
    ...(userId ? { createdBy: userId } : {}),
    ...(threadTs ? { threadTs } : {}),
    ...(messageTs ? { messageTs } : {})
  };
  return mutateSlackPollRecords(channelId, (polls) => ({
    ok: true,
    polls: [...polls, poll].slice(-DEFAULT_POLL_LOG_MAX_ITEMS),
    value: { poll }
  }));
}

export async function listSlackPolls(channelId: string) {
  const redis = await pollRedis();

  if (!redis) {
    return { ok: false as const, reason: "Redis is not configured." };
  }

  return { ok: true as const, polls: await getSlackPollRecords(channelId) };
}

export async function recordSlackPollVote({
  channelId,
  pollId,
  choice,
  userId,
  threadTs,
  source,
  createdAt = new Date().toISOString()
}: {
  channelId: string;
  pollId?: string;
  choice: string;
  userId: string;
  threadTs?: string;
  source: SlackPollVote["source"];
  createdAt?: string;
}) {
  let targetPollId = pollId;
  return mutateSlackPollRecords(channelId, (polls) => {
    const resolved = resolveOpenPoll(polls, targetPollId, threadTs);

    if (!resolved.ok) {
      return resolved;
    }

    targetPollId = resolved.poll.id;
    return applyPollVote(polls, resolved.poll, choice, { userId, source, createdAt });
  });
}

export async function recordSlackPollReactionVote(event: {
  channelId: string;
  threadTs: string;
  userId: string;
  reaction: string;
}) {
  const choice = getReactionPollChoice(event.reaction);

  if (!choice) {
    return { ok: false as const, reason: "Reaction is not a poll option." };
  }

  let targetPollId: string | undefined;
  const createdAt = new Date().toISOString();
  return mutateSlackPollRecords(event.channelId, (polls) => {
    const resolved = targetPollId
      ? resolveOpenPoll(polls, targetPollId)
      : resolvePollForReaction(polls, event.threadTs);

    if (!resolved.ok) {
      return resolved;
    }

    targetPollId = resolved.poll.id;
    return applyPollVote(polls, resolved.poll, choice, {
      userId: event.userId,
      source: "reaction",
      createdAt
    });
  });
}

export async function closeSlackPoll({
  channelId,
  pollId,
  userId,
  threadTs,
  recordDecision,
  decisionText,
  source,
  closedAt = new Date().toISOString()
}: {
  channelId: string;
  pollId?: string;
  userId?: string;
  threadTs?: string;
  recordDecision: boolean;
  decisionText?: string;
  source: "slash-command" | "slack-message";
  closedAt?: string;
}) {
  let targetPollId = pollId;
  return mutateSlackPollRecords(channelId, (polls) => {
    const resolved = resolveOpenPoll(polls, targetPollId, threadTs);

    if (!resolved.ok) {
      return resolved;
    }

    targetPollId = resolved.poll.id;
    const resolvedDecisionText = recordDecision && !resolved.poll.decisionId
      ? normalizePollText(decisionText ?? formatPollDecisionText(resolved.poll))
      : undefined;
    const decision = resolvedDecisionText
      ? createPollDecision(resolved.poll, resolvedDecisionText, source, userId)
      : undefined;
    const poll: SlackPoll = {
      ...resolved.poll,
      status: "closed",
      closedAt,
      ...(userId ? { closedBy: userId } : {}),
      ...(decision ? { decisionId: decision.id } : {})
    };

    return {
      ok: true,
      polls: replacePoll(polls, poll),
      decision,
      value: { poll, decisionText: resolvedDecisionText }
    };
  });
}

export async function recordPollDecision({
  channelId,
  pollId,
  userId,
  threadTs,
  decisionText,
  source
}: {
  channelId: string;
  pollId?: string;
  userId?: string;
  threadTs?: string;
  decisionText?: string;
  source: "slash-command" | "slack-message";
}) {
  let targetPollId = pollId;
  return mutateSlackPollRecords(channelId, (polls) => {
    const resolved = resolvePoll(polls, targetPollId, threadTs);

    if (!resolved.ok) {
      return resolved;
    }

    targetPollId = resolved.poll.id;
    if (resolved.poll.decisionId) {
      return { ok: false, reason: "A decision has already been recorded for this poll." };
    }

    const resolvedDecisionText = normalizePollText(decisionText ?? formatPollDecisionText(resolved.poll));

    if (!resolvedDecisionText) {
      return { ok: false, reason: "Decision cannot be empty." };
    }

    const decision = createPollDecision(resolved.poll, resolvedDecisionText, source, userId);
    const poll = { ...resolved.poll, decisionId: decision.id };

    return {
      ok: true,
      polls: replacePoll(polls, poll),
      decision,
      value: { poll, decisionText: resolvedDecisionText }
    };
  });
}

export function formatPollHelp() {
  return [
    "*NoBo polls*",
    "`/nobo-polls create <question> | <option> | <option>`: create a lightweight poll",
    "`/nobo-polls vote [poll-id] <option>`: vote by number, letter, or option text",
    "`/nobo-polls results [poll-id]`: summarize current results",
    "`/nobo-polls close [poll-id] [decision]`: close a poll, optionally logging the winner as a decision",
    "`@NoBo poll ...` works too. React with `:one:`, `:two:`, `:three:`, or `:a:`, `:b:`, `:c:` on a poll thread to vote."
  ].join("\n");
}

export function formatPollCreated(poll: SlackPoll) {
  return [
    `*Poll ${formatPollShortId(poll)}*: ${poll.question}`,
    ...poll.options.map((option) => `${option.id}. ${option.text}`),
    "",
    `Vote: \`/nobo-polls vote ${formatPollShortId(poll)} 1\` or \`@NoBo poll vote 1\` in this thread.`
  ].join("\n");
}

export function formatPollList(polls: SlackPoll[]) {
  if (polls.length === 0) {
    return "No polls yet.";
  }

  return [
    "*Polls*",
    ...[...polls].reverse().map((poll, index) => {
      const counts = countPollVotes(poll);
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      return `${index + 1}. ${formatPollShortId(poll)} ${poll.status}: ${poll.question} (${total} vote${total === 1 ? "" : "s"})`;
    })
  ].join("\n");
}

export function formatPollSummary(poll: SlackPoll) {
  const counts = countPollVotes(poll);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const leaders = getPollLeaders(poll);
  const leaderText =
    leaders.length === 0
      ? "No votes yet."
      : leaders.length === 1
        ? `Leader: ${leaders[0]?.text} (${counts[leaders[0]?.id ?? ""] ?? 0}/${total})`
        : `Tie: ${leaders.map((option) => option.text).join(", ")} (${counts[leaders[0]?.id ?? ""] ?? 0}/${total})`;

  return [
    `*Poll ${formatPollShortId(poll)} ${poll.status}*: ${poll.question}`,
    ...poll.options.map((option) => `${option.id}. ${option.text}: ${counts[option.id] ?? 0}`),
    leaderText
  ].join("\n");
}

export function formatPollVoteRecorded(poll: SlackPoll, option: SlackPollOption, userId: string) {
  return `Recorded <@${userId}>'s vote for poll ${formatPollShortId(poll)}: ${option.text}`;
}

export function formatPollClosed(poll: SlackPoll, decisionText?: string) {
  const decision = decisionText ? `\nDecision logged: ${decisionText}` : "";
  return `${formatPollSummary(poll)}\nClosed.${decision}`;
}

function parseCreateIntent(input: string): PollIntent {
  const parts = input.split("|").map(normalizePollText).filter(Boolean);

  if (parts.length >= 3) {
    const [question = "", ...options] = parts;
    return { action: "create", question, options };
  }

  const match = input.match(/^(.+?)\s+(?:options?|choices?)\s*:?\s+(.+)$/i);
  if (match) {
    const options = (match[2] ?? "").split(/[;,]/).map(normalizePollText).filter(Boolean);
    return { action: "create", question: normalizePollText(match[1] ?? ""), options };
  }

  return { action: "create", question: normalizePollText(input), options: [] };
}

function parseVoteIntent(input: string): PollIntent {
  const trimmed = collapseWhitespace(input);
  const [first = "", ...rest] = trimmed.split(/\s+/);
  const remaining = rest.join(" ");

  if (remaining && looksLikePollId(first)) {
    return { action: "vote", pollId: first, choice: remaining };
  }

  return { action: "vote", choice: trimmed };
}

function parseCloseIntent(input: string): PollIntent {
  const trimmed = collapseWhitespace(input);

  if (!trimmed) {
    return { action: "close", recordDecision: false };
  }

  const decisionMatch = trimmed.match(/^(\S+)?\s*(?:and\s+)?(?:record\s+)?decision(?:\s+(.+))?$/i);
  if (decisionMatch) {
    const maybePollId = normalizeOptionalText(decisionMatch[1]);
    const decisionText = normalizeOptionalText(decisionMatch[2]);
    return {
      action: "close",
      recordDecision: true,
      ...(maybePollId && looksLikePollId(maybePollId) ? { pollId: maybePollId } : {}),
      ...(decisionText ? { decisionText } : {})
    };
  }

  const [first = "", ...rest] = trimmed.split(/\s+/);
  if (looksLikePollId(first)) {
    const tail = rest.join(" ");
    const recordDecision = /^(?:decision|record-decision)$/i.test(tail);
    return {
      action: "close",
      pollId: first,
      recordDecision,
      ...(!recordDecision && tail ? { decisionText: tail } : {})
    };
  }

  return { action: "close", recordDecision: /^decision$/i.test(trimmed) };
}

function parseDecideIntent(input: string): PollIntent {
  const trimmed = collapseWhitespace(input);

  if (!trimmed) {
    return { action: "decide" };
  }

  const [first = "", ...rest] = trimmed.split(/\s+/);
  if (looksLikePollId(first)) {
    const decisionText = normalizeOptionalText(rest.join(" "));
    return { action: "decide", pollId: first, ...(decisionText ? { decisionText } : {}) };
  }

  return { action: "decide", decisionText: trimmed };
}

async function resolvePollForCommand(channelId: string, pollId?: string, threadTs?: string) {
  const state = await loadPollState(channelId);

  if (!state.ok) {
    return state;
  }

  return resolvePoll(state.polls, pollId, threadTs);
}

async function loadPollState(channelId: string) {
  const redis = await pollRedis();

  if (!redis) {
    return { ok: false as const, reason: "Redis is not configured." };
  }

  return { ok: true as const, polls: await getSlackPollRecords(channelId) };
}

type PollMutation<T> =
  | { ok: false; reason: string }
  | { ok: true; polls: SlackPoll[]; value: T; decision?: ChannelDecision };

async function mutateSlackPollRecords<T>(
  channelId: string,
  mutate: (polls: SlackPoll[]) => PollMutation<T>
) {
  const redis = await pollRedis();

  if (!redis) {
    return { ok: false as const, reason: "Redis is not configured." };
  }

  for (let attempt = 0; attempt < MAX_POLL_MUTATION_ATTEMPTS; attempt++) {
    const payload = await redis.get(getPollLogKey(channelId));
    const polls = payload ? parsePollLogPayload(payload).filter((poll) => poll.channelId === channelId) : [];
    const mutation = mutate(polls);

    if (!mutation.ok) {
      return mutation;
    }

    const changed = await redis.eval(SAVE_POLL_MUTATION, {
      keys: [getPollLogKey(channelId), ...(mutation.decision ? [`slack-channel-decisions:${channelId}`] : [])],
      arguments: [
        payload === null ? "missing" : "present",
        payload ?? "",
        JSON.stringify({ polls: mutation.polls }),
        ...(mutation.decision ? [JSON.stringify(mutation.decision)] : [])
      ]
    });

    if (changed === 1) {
      return { ok: true as const, ...mutation.value };
    }
  }

  return { ok: false as const, reason: "Polls changed too often. Please try again." };
}

function replacePoll(polls: SlackPoll[], poll: SlackPoll) {
  return polls.map((candidate) => candidate.id === poll.id ? poll : candidate);
}

function applyPollVote(
  polls: SlackPoll[],
  previous: SlackPoll,
  choice: string,
  vote: Omit<SlackPollVote, "optionId">
): PollMutation<{ poll: SlackPoll; option: SlackPollOption }> {
  const option = resolvePollOption(previous, choice);

  if (!option) {
    return { ok: false, reason: `Unknown option. Use ${formatPollOptionChoices(previous)}.` };
  }

  const poll = {
    ...previous,
    votes: { ...previous.votes, [vote.userId]: { ...vote, optionId: option.id } }
  };
  return { ok: true, polls: replacePoll(polls, poll), value: { poll, option } };
}

function createPollDecision(
  poll: SlackPoll,
  text: string,
  source: ChannelDecision["source"],
  userId?: string
): ChannelDecision {
  return {
    id: randomUUID(),
    channelId: poll.channelId,
    text,
    createdAt: new Date().toISOString(),
    source,
    ...(userId ? { userId } : {}),
    ...(poll.threadTs ? { threadTs: poll.threadTs } : {}),
    ...(poll.messageTs ? { messageTs: poll.messageTs } : {})
  };
}

async function getSlackPollRecords(channelId: string) {
  const redis = await pollRedis();

  if (!redis) {
    return [];
  }

  const payload = await redis.get(getPollLogKey(channelId));

  if (!payload) {
    return [];
  }

  return parsePollLogPayload(payload).filter((poll) => poll.channelId === channelId);
}

function resolveOpenPoll(polls: SlackPoll[], pollId?: string, threadTs?: string) {
  const resolved = resolvePoll(polls.filter((poll) => poll.status === "open"), pollId, threadTs);

  if (!resolved.ok && polls.some((poll) => poll.status === "closed" && matchesPollId(poll, pollId))) {
    return { ok: false as const, reason: "Poll is closed." };
  }

  return resolved;
}

function resolvePoll(polls: SlackPoll[], pollId?: string, threadTs?: string) {
  if (pollId) {
    const matches = polls.filter((poll) => matchesPollId(poll, pollId));

    if (matches.length === 1) {
      return { ok: true as const, poll: matches[0] };
    }

    if (matches.length > 1) {
      return { ok: false as const, reason: "Poll id is ambiguous. Use more characters." };
    }

    return { ok: false as const, reason: "Poll not found." };
  }

  const threadPoll = threadTs
    ? [...polls].reverse().find((poll) => poll.threadTs === threadTs)
    : undefined;

  if (threadPoll) {
    return { ok: true as const, poll: threadPoll };
  }

  const latest = polls.at(-1);

  if (!latest) {
    return { ok: false as const, reason: "No polls found." };
  }

  return { ok: true as const, poll: latest };
}

function resolvePollForReaction(polls: SlackPoll[], messageTs: string) {
  const matches = polls.filter((poll) => poll.threadTs === messageTs || poll.messageTs === messageTs);

  if (matches.some((poll) => poll.status === "closed")) {
    return { ok: false as const, reason: "Poll is closed." };
  }

  const openMatches = matches.filter((poll) => poll.status === "open");

  if (openMatches.length === 1) {
    return { ok: true as const, poll: openMatches[0] };
  }

  if (openMatches.length > 1) {
    return { ok: false as const, reason: "Poll reaction target is ambiguous." };
  }

  return { ok: false as const, reason: "No poll found for that message." };
}

function resolvePollOption(poll: SlackPoll, choice: string) {
  const normalized = normalizePollText(choice).toLowerCase();
  const letterIndex = /^[a-z]$/i.test(normalized) ? normalized.charCodeAt(0) - 97 : -1;

  return poll.options.find((option, index) => {
    return (
      option.id === normalized ||
      index === letterIndex ||
      option.text.toLowerCase() === normalized ||
      option.text.toLowerCase().startsWith(normalized)
    );
  });
}

function countPollVotes(poll: SlackPoll) {
  return Object.values(poll.votes).reduce<Record<string, number>>((counts, vote) => {
    counts[vote.optionId] = (counts[vote.optionId] ?? 0) + 1;
    return counts;
  }, {});
}

function getPollLeaders(poll: SlackPoll) {
  const counts = countPollVotes(poll);
  const max = Math.max(0, ...Object.values(counts));

  if (max === 0) {
    return [];
  }

  return poll.options.filter((option) => (counts[option.id] ?? 0) === max);
}

function formatPollDecisionText(poll: SlackPoll) {
  const leaders = getPollLeaders(poll);

  if (leaders.length === 1) {
    return `${poll.question}: ${leaders[0]?.text}`;
  }

  if (leaders.length > 1) {
    return `${poll.question}: tied between ${leaders.map((option) => option.text).join(", ")}`;
  }

  return `${poll.question}: no consensus`;
}

function formatPollShortId(poll: SlackPoll) {
  return poll.id.slice(0, 8);
}

function formatPollOptionChoices(poll: SlackPoll) {
  return poll.options.map((option) => `${option.id} (${option.text})`).join(", ");
}

function matchesPollId(poll: SlackPoll, pollId?: string) {
  return Boolean(pollId && poll.id.startsWith(pollId));
}

function looksLikePollId(input: string) {
  return /^[a-f0-9-]{4,}$/i.test(input);
}

function getReactionPollChoice(reaction: string) {
  const normalized = reaction
    .trim()
    .toLowerCase()
    .replace(/^:+|:+$/g, "")
    .replace(/[_\s]+/g, "-");
  const numberWords: Record<string, string> = {
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    "keycap-one": "1",
    "keycap-two": "2",
    "keycap-three": "3",
    "keycap-four": "4",
    "keycap-five": "5",
    "keycap-six": "6",
    "keycap-seven": "7",
    "keycap-eight": "8",
    "keycap-nine": "9"
  };
  const letterMatch = normalized.match(/^regional-indicator-([a-z])$/);

  return numberWords[normalized] ?? letterMatch?.[1] ?? (/^[a-z]$/.test(normalized) ? normalized : null);
}

function parsePollLogPayload(payload: string) {
  try {
    const parsed = JSON.parse(payload) as { polls?: unknown } | unknown[];
    const polls = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.polls)
        ? parsed.polls
        : [];

    return polls
      .map(normalizeSlackPoll)
      .filter((poll): poll is SlackPoll => poll !== null);
  } catch {
    return [];
  }
}

function normalizeSlackPoll(input: unknown): SlackPoll | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Partial<Record<keyof SlackPoll, unknown>>;
  const id = typeof record.id === "string" ? record.id : "";
  const channelId = typeof record.channelId === "string" ? record.channelId : "";
  const question = typeof record.question === "string" ? normalizePollText(record.question) : "";
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
  const status = record.status === "closed" ? "closed" : "open";
  const options = Array.isArray(record.options)
    ? record.options.map(normalizeSlackPollOption).filter((option) => option !== null)
    : [];
  const votes = normalizePollVotes(record.votes, options);

  if (!id || !channelId || !question || !createdAt || options.length < 2) {
    return null;
  }

  return {
    id,
    channelId,
    question,
    options,
    votes,
    status,
    createdAt,
    ...(typeof record.createdBy === "string" ? { createdBy: record.createdBy } : {}),
    ...(typeof record.threadTs === "string" ? { threadTs: record.threadTs } : {}),
    ...(typeof record.messageTs === "string" ? { messageTs: record.messageTs } : {}),
    ...(typeof record.closedAt === "string" ? { closedAt: record.closedAt } : {}),
    ...(typeof record.closedBy === "string" ? { closedBy: record.closedBy } : {}),
    ...(typeof record.decisionId === "string" ? { decisionId: record.decisionId } : {})
  };
}

function normalizeSlackPollOption(input: unknown): SlackPollOption | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Partial<Record<keyof SlackPollOption, unknown>>;
  const id = typeof record.id === "string" ? normalizePollText(record.id) : "";
  const text = typeof record.text === "string" ? normalizePollText(record.text) : "";

  return id && text ? { id, text } : null;
}

function normalizePollVotes(input: unknown, options: SlackPollOption[]) {
  if (!input || typeof input !== "object") {
    return {};
  }

  const optionIds = new Set(options.map((option) => option.id));

  return Object.entries(input as Record<string, unknown>).reduce<Record<string, SlackPollVote>>(
    (votes, [userId, vote]) => {
      if (!vote || typeof vote !== "object") {
        return votes;
      }

      const record = vote as Partial<Record<keyof SlackPollVote, unknown>>;
      const optionId = typeof record.optionId === "string" ? record.optionId : "";
      const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
      const source = record.source === "reaction" ? "reaction" : "command";

      if (userId && optionIds.has(optionId) && createdAt) {
        votes[userId] = { userId, optionId, source, createdAt };
      }

      return votes;
    },
    {}
  );
}

function normalizePollOptions(options: string[]) {
  return Array.from(new Set(options.map(normalizePollText).filter(Boolean))).slice(0, 9);
}

function normalizeOptionalText(input: string | undefined) {
  const text = normalizePollText(input ?? "");
  return text || undefined;
}

function normalizePollText(input: string) {
  return collapseWhitespace(input).replace(/[.!?]+$/g, "").trim();
}

function collapseWhitespace(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

function getPollLogKey(channelId: string) {
  return `slack-channel-polls:${channelId}`;
}

export const __testing = {
  setRedisProvider(provider?: () => Promise<PollRedis | null>) { pollRedis = provider ?? getRedisClient; },
  countPollVotes,
  formatPollDecisionText,
  getPollLogKey,
  getReactionPollChoice,
  normalizePollText,
  parsePollLogPayload,
  resolvePollForReaction
};
