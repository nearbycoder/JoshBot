import type { WebClient } from "@slack/web-api";
import { summarizeOpsError } from "./ops-errors.js";

export type SlackAgentReadiness = {
  state: "unchecked" | "disabled" | "missing-scopes" | "scopes-present" | "error";
  missingScopes: string[];
  detail: string;
};
let readiness: SlackAgentReadiness = {
  state: "unchecked", missingScopes: [],
  detail: "Slack grants have not been checked in this process."
};
export function getSlackAgentReadiness() { return { ...readiness, missingScopes: [...readiness.missingScopes] }; }
export function assessSlackAgentScopes(scopes: string[] | undefined, mode = process.env.SLACK_NATIVE_AI): SlackAgentReadiness {
  if (/^(0|false|off|legacy)$/i.test(mode?.trim() ?? "")) {
    return { state: "disabled", missingScopes: [], detail: "Native Agent UI disabled by SLACK_NATIVE_AI." };
  }
  if (!scopes) {
    return { state: "unchecked", missingScopes: [], detail: "Slack did not return granted scopes; check OAuth & Permissions manually." };
  }
  const missingScopes = ["assistant:write", "chat:write"].filter((scope) => !scopes.includes(scope));
  if (missingScopes.length) {
    return { state: "missing-scopes", missingScopes,
      detail: `Missing ${missingScopes.join(", ")}. Enable Agents, reinstall the Slack app, update its Railway bot token if changed, and restart.` };
  }
  return { state: "scopes-present", missingScopes: [],
    detail: "Agent OAuth grants present. Agent view, event subscriptions and workspace plan still require verification in Slack." };
}

/** Read-only, bounded startup check. Never logs tokens or the raw auth response. */
export async function checkSlackAgentReadiness(client: Pick<WebClient, "auth">) {
  try {
    const result = await client.auth.test();
    readiness = assessSlackAgentScopes(result.response_metadata?.scopes);
    if (result.user_id && !process.env.SLACK_BOT_USER_ID) process.env.SLACK_BOT_USER_ID = result.user_id;
  } catch (error) {
    readiness = { state: "error", missingScopes: [], detail: `Slack grant check failed: ${summarizeOpsError(error)}` };
  }
  return getSlackAgentReadiness();
}
