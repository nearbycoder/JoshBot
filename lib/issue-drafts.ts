import type { ThreadFollowUpDraft } from "./follow-ups.js";
import type { SlackScheduleContext } from "./schedules.js";

export type IssueTarget = "github" | "linear";

export type IssueCommandIntent =
  | { action: "help" }
  | {
      action: "draft";
      targets: IssueTarget[];
      create: boolean;
      text: string;
    };

export type IssueDraft = {
  target: IssueTarget;
  title: string;
  body: string;
  payload: Record<string, unknown>;
};

export type IssueCreateResult =
  | {
      ok: true;
      target: IssueTarget;
      title: string;
      url: string;
    }
  | {
      ok: false;
      target: IssueTarget;
      title: string;
      reason: string;
      missingConfig?: string[];
    };

export type IssueDraftOptions = {
  targets: IssueTarget[];
  create?: boolean;
  context?: SlackScheduleContext;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
};

type IssueProviderConfig = {
  target: IssueTarget;
  canCreate: boolean;
  missing: string[];
  repo?: string;
  token?: string;
  teamId?: string;
  labels: string[];
};

const DEFAULT_TARGETS: IssueTarget[] = ["github", "linear"];
const MAX_ISSUES_PER_RUN = 10;
const GITHUB_API = "https://api.github.com";
const LINEAR_API = "https://api.linear.app/graphql";
const LINEAR_CREATE_ISSUE_MUTATION = `
mutation NoBoIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      title
      url
    }
  }
}`;

export function parseIssueCommandIntent(args: string): IssueCommandIntent {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return { action: "draft", targets: DEFAULT_TARGETS, create: false, text: "" };
  }

  if (tokens.length === 1 && /^help$/i.test(tokens[0] ?? "")) {
    return { action: "help" };
  }

  const targets = new Set<IssueTarget>();
  let create = false;
  let index = 0;

  for (; index < tokens.length; index += 1) {
    const token = normalizeToken(tokens[index] ?? "");

    if (token === "github" || token === "gh") {
      targets.add("github");
      continue;
    }

    if (token === "linear") {
      targets.add("linear");
      continue;
    }

    if (token === "both" || token === "all") {
      targets.add("github");
      targets.add("linear");
      continue;
    }

    if (token === "create" || token === "open" || token === "post") {
      create = true;
      continue;
    }

    break;
  }

  return {
    action: "draft",
    targets: targets.size > 0 ? Array.from(targets) : DEFAULT_TARGETS,
    create,
    text: tokens.slice(index).join(" ")
  };
}

export function parseFollowUpsFromText(text: string): ThreadFollowUpDraft[] {
  return text
    .split(/\r?\n|;\s+/)
    .map((line) => normalizeTaskText(line))
    .filter((task): task is string => Boolean(task))
    .slice(0, MAX_ISSUES_PER_RUN)
    .map((task) => ({ task }));
}

export async function handleIssueDrafts(
  followUps: ThreadFollowUpDraft[],
  options: IssueDraftOptions
) {
  const normalized = followUps
    .filter((followUp) => followUp.task.trim())
    .slice(0, MAX_ISSUES_PER_RUN);

  if (normalized.length === 0) {
    return "No clear issue-worthy follow-ups found.";
  }

  const env = options.env ?? process.env;
  const drafts = options.targets.flatMap((target) =>
    normalized.map((followUp) => buildIssueDraft(target, followUp, options.context, env))
  );

  if (!options.create) {
    return formatIssueDrafts(drafts, {
      mode: "draft",
      configs: options.targets.map((target) => getIssueProviderConfig(target, env))
    });
  }

  const results = await createIssues(drafts, {
    env,
    fetch: options.fetch ?? fetch
  });

  return formatIssueCreateResults(results, drafts);
}

export function buildIssueDraft(
  target: IssueTarget,
  followUp: ThreadFollowUpDraft,
  context?: SlackScheduleContext,
  env: NodeJS.ProcessEnv = process.env
): IssueDraft {
  const title = toIssueTitle(followUp.task);
  const body = buildIssueBody(followUp, context);

  if (target === "github") {
    return {
      target,
      title,
      body,
      payload: {
        title,
        body,
        labels: getCommaList(env.NOBO_GITHUB_LABELS ?? env.NOBO_ISSUE_LABELS)
      }
    };
  }

  return {
    target,
    title,
    body,
    payload: {
      query: LINEAR_CREATE_ISSUE_MUTATION.trim(),
      variables: {
        input: {
          teamId: env.NOBO_LINEAR_TEAM_ID ?? env.LINEAR_TEAM_ID,
          title,
          description: body,
          labelIds: getCommaList(env.NOBO_LINEAR_LABEL_IDS ?? env.LINEAR_LABEL_IDS)
        }
      }
    }
  };
}

export function formatIssueHelp() {
  return [
    "*NoBo issues*",
    "`@NoBo issues [github|linear|both]`: draft issues from current thread follow-ups",
    "`@NoBo issues [github|linear|both] create`: create them when API config is present",
    "`/nobo-issues [github|linear|both] <follow-up bullets>`: draft issues from pasted text",
    "`/nobo-issues [github|linear|both] create <follow-up bullets>`: create or return actionable drafts"
  ].join("\n");
}

async function createIssues(
  drafts: IssueDraft[],
  options: { env: NodeJS.ProcessEnv; fetch: typeof fetch }
): Promise<IssueCreateResult[]> {
  const results: IssueCreateResult[] = [];

  for (const draft of drafts) {
    const config = getIssueProviderConfig(draft.target, options.env);

    if (!config.canCreate) {
      results.push({
        ok: false,
        target: draft.target,
        title: draft.title,
        reason: `Missing config: ${config.missing.join(", ")}`,
        missingConfig: config.missing
      });
      continue;
    }

    results.push(await createIssue(draft, config, options.fetch));
  }

  return results;
}

async function createIssue(
  draft: IssueDraft,
  config: IssueProviderConfig,
  fetchImpl: typeof fetch
): Promise<IssueCreateResult> {
  try {
    return draft.target === "github"
      ? await createGitHubIssue(draft, config, fetchImpl)
      : await createLinearIssue(draft, config, fetchImpl);
  } catch (error) {
    return {
      ok: false,
      target: draft.target,
      title: draft.title,
      reason: summarizeError(error)
    };
  }
}

async function createGitHubIssue(
  draft: IssueDraft,
  config: IssueProviderConfig,
  fetchImpl: typeof fetch
): Promise<IssueCreateResult> {
  const response = await fetchImpl(`${GITHUB_API}/repos/${config.repo}/issues`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      "user-agent": "NoBo"
    },
    body: JSON.stringify(draft.payload)
  });

  const data = await readJson(response);

  if (!response.ok) {
    return apiFailure(draft, response, data);
  }

  const url = getString(data, "html_url") ?? getString(data, "url") ?? "";
  return { ok: true, target: "github", title: draft.title, url };
}

async function createLinearIssue(
  draft: IssueDraft,
  config: IssueProviderConfig,
  fetchImpl: typeof fetch
): Promise<IssueCreateResult> {
  const response = await fetchImpl(LINEAR_API, {
    method: "POST",
    headers: {
      authorization: config.token ?? "",
      "content-type": "application/json"
    },
    body: JSON.stringify(draft.payload)
  });

  const data = await readJson(response);

  if (!response.ok || Array.isArray((data as { errors?: unknown }).errors)) {
    return apiFailure(draft, response, data);
  }

  const issueCreate = (data as { data?: { issueCreate?: { issue?: { url?: string } } } }).data
    ?.issueCreate;
  return {
    ok: true,
    target: "linear",
    title: draft.title,
    url: issueCreate?.issue?.url ?? ""
  };
}

function formatIssueDrafts(
  drafts: IssueDraft[],
  options: { mode: "draft"; configs: IssueProviderConfig[] }
) {
  const configLines = options.configs.map((config) =>
    config.canCreate
      ? `${formatTarget(config.target)} create config: ready.`
      : `${formatTarget(config.target)} create config missing: ${config.missing.join(", ")}.`
  );

  return [
    "*NoBo issue drafts*",
    "Draft mode. Add `create` to attempt API creation.",
    ...configLines,
    ...drafts.map(formatIssueDraft)
  ].join("\n");
}

function formatIssueCreateResults(results: IssueCreateResult[], drafts: IssueDraft[]) {
  const lines = ["*NoBo issue creation*"];

  for (const result of results) {
    if (result.ok) {
      lines.push(`- Created ${formatTarget(result.target)} issue: ${result.url || result.title}`);
      continue;
    }

    const draft = drafts.find(
      (candidate) => candidate.target === result.target && candidate.title === result.title
    );
    lines.push(`- Couldn't create ${formatTarget(result.target)} issue "${result.title}": ${result.reason}`);
    if (draft) {
      lines.push(formatIssueDraft(draft));
    }
  }

  return lines.join("\n");
}

function formatIssueDraft(draft: IssueDraft) {
  return [
    `*${formatTarget(draft.target)} draft*: ${draft.title}`,
    "```json",
    JSON.stringify(draft.payload, null, 2),
    "```"
  ].join("\n");
}

function getIssueProviderConfig(target: IssueTarget, env: NodeJS.ProcessEnv): IssueProviderConfig {
  if (target === "github") {
    const token = env.NOBO_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
    const repo = env.NOBO_GITHUB_REPOSITORY ?? env.GITHUB_REPOSITORY;
    const missing = [
      ...(token ? [] : ["NOBO_GITHUB_TOKEN or GITHUB_TOKEN"]),
      ...(repo ? [] : ["NOBO_GITHUB_REPOSITORY or GITHUB_REPOSITORY"])
    ];

    return {
      target,
      token,
      repo,
      missing,
      canCreate: missing.length === 0,
      labels: getCommaList(env.NOBO_GITHUB_LABELS ?? env.NOBO_ISSUE_LABELS)
    };
  }

  const token = env.NOBO_LINEAR_API_KEY ?? env.LINEAR_API_KEY;
  const teamId = env.NOBO_LINEAR_TEAM_ID ?? env.LINEAR_TEAM_ID;
  const missing = [
    ...(token ? [] : ["NOBO_LINEAR_API_KEY or LINEAR_API_KEY"]),
    ...(teamId ? [] : ["NOBO_LINEAR_TEAM_ID or LINEAR_TEAM_ID"])
  ];

  return {
    target,
    token,
    teamId,
    missing,
    canCreate: missing.length === 0,
    labels: getCommaList(env.NOBO_LINEAR_LABEL_IDS ?? env.LINEAR_LABEL_IDS)
  };
}

function buildIssueBody(followUp: ThreadFollowUpDraft, context?: SlackScheduleContext) {
  const lines = [
    "Generated by NoBo from a Slack thread follow-up.",
    "",
    `Follow-up: ${followUp.task}`
  ];

  if (followUp.assigneeUserId) {
    lines.push(`Slack assignee: <@${followUp.assigneeUserId}>`);
  } else if (followUp.assigneeName) {
    lines.push(`Assignee: ${followUp.assigneeName}`);
  }

  if (followUp.dueAt) {
    lines.push(`Due: ${followUp.dueAt}`);
  }

  if (followUp.source) {
    lines.push(`Source: ${followUp.source}`);
  }

  if (context) {
    lines.push("", `Slack channel: ${context.channel}`, `Slack thread: ${context.threadTs}`);
  }

  return lines.join("\n");
}

function toIssueTitle(task: string) {
  const title = task.replace(/\s+/g, " ").trim();
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

function normalizeTaskText(input: string) {
  return input
    .replace(/^\s*(?:[-*]|\d+[.)])\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeToken(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function getCommaList(input: string | undefined) {
  return (input ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function formatTarget(target: IssueTarget) {
  return target === "github" ? "GitHub" : "Linear";
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function apiFailure(draft: IssueDraft, response: Response, data: unknown): IssueCreateResult {
  const message = getString(data, "message") ?? summarizeLinearErrors(data) ?? response.statusText;
  return {
    ok: false,
    target: draft.target,
    title: draft.title,
    reason: `${response.status} ${message}`.trim()
  };
}

function summarizeLinearErrors(data: unknown) {
  const errors = (data as { errors?: Array<{ message?: string }> }).errors;
  return errors?.map((error) => error.message).filter(Boolean).join("; ");
}

function getString(data: unknown, key: string) {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }

  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function summarizeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

export const __testing = {
  buildIssueBody,
  getIssueProviderConfig,
  parseIssueCommandIntent
};
