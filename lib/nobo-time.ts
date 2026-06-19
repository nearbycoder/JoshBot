export function formatCurrentTimePrompt() {
  const currentTime = formatCurrentTime("America/Chicago");

  return `Current time:
- UTC: ${currentTime.utc}
- America/Chicago: ${currentTime.local}
- Timezone: ${currentTime.timeZone}

Use this for relative phrases like now, today, tomorrow, yesterday, in 5 minutes, next Monday, and over the past week.`;
}

export function formatCurrentTime(timeZone: string) {
  const now = new Date();

  try {
    return {
      iso: now.toISOString(),
      utc: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: "UTC"
      }).format(now),
      local: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone
      }).format(now),
      timeZone
    };
  } catch {
    return {
      iso: now.toISOString(),
      utc: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: "UTC"
      }).format(now),
      local: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: "America/Chicago"
      }).format(now),
      timeZone: "America/Chicago"
    };
  }
}
