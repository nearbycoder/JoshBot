export type OpsErrorRecord = {
  at: string;
  source: string;
  message: string;
};

const MAX_RECENT_ERRORS = 10;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const recentErrors: OpsErrorRecord[] = [];

export function recordOpsError(source: string, error: unknown) {
  recentErrors.unshift({
    at: new Date().toISOString(),
    source: sanitizeOpsText(source),
    message: summarizeOpsError(error)
  });

  recentErrors.splice(MAX_RECENT_ERRORS);
}

export function getRecentOpsErrors(limit = 5) {
  return recentErrors.slice(0, limit);
}

export function clearRecentOpsErrorsForTesting() {
  recentErrors.splice(0);
}

export function summarizeOpsError(error: unknown) {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : String(error);

  return sanitizeOpsText(message).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function sanitizeOpsText(input: string) {
  let output = input;

  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 4 || !isSensitiveEnvName(name)) {
      continue;
    }

    output = output.split(value).join("[hidden]");
  }

  return output.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[hidden]@");
}

function isSensitiveEnvName(name: string) {
  return /(TOKEN|SECRET|KEY|PASSWORD|REDIS_URL|DATABASE_URL)/i.test(name);
}
