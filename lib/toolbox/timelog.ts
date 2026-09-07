import {
  add,
  date,
  find,
  InputError,
  label,
  parts,
  touch,
  type Entry,
  type Feature,
} from "./core.js";
function instant(text: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      text,
    )
  )
    throw new InputError("Use an ISO timestamp with Z or an explicit offset.");
  date(text.slice(0, 10));
  const value = Date.parse(text);
  if (!Number.isFinite(value)) throw new InputError("Invalid timestamp.");
  return value;
}
function validate(
  entries: Entry[],
  start: number,
  end: number,
  now: Date,
  exclude?: string,
) {
  if (end <= start || end > now.getTime() || end - start > 86400000)
    throw new InputError(
      "End must follow start, be no later than now, and span at most 24 hours.",
    );
  if (
    entries.some(
      (e) =>
        e.id !== exclude &&
        start < Number(e.data.end ?? now.getTime()) &&
        end > Number(e.data.start),
    )
  )
    throw new InputError(
      "That time overlaps another log. Adjust the existing entry first.",
    );
}
export const timelog: Feature = {
  render: (e, now) =>
    `${label(e)}\nProject: ${e.data.project}\nStart: ${new Date(Number(e.data.start)).toISOString()}\nEnd: ${e.data.end === null ? "Running" : new Date(Number(e.data.end)).toISOString()}\nElapsed: ${((Number(e.data.end ?? now.getTime()) - Number(e.data.start)) / 60000).toFixed(1)} minutes`,
  id: "timelog",
  title: "Time tracking",
  description:
    "Track one running task, correct entries and total project time across UTC date ranges.",
  help: "start NoBo | Review PRs\nstop\nactive\nlog NoBo | 2026-09-07T09:00:00Z | 2026-09-07T10:00:00Z | Review PRs\nadjust <id> | <start ISO> | <end ISO>\nreport 2026-09-01 | 2026-09-07",
  run(entries, verb, args, now) {
    if (verb === "active") {
      const e = entries.find((e) => e.data.end === null);
      return e
        ? `${label(e)}\n${e.data.project} · ${Math.floor((now.getTime() - Number(e.data.start)) / 60000)} minutes running`
        : "No timer running.";
    }
    if (verb === "start") {
      if (entries.some((e) => e.data.end === null))
        throw new InputError("Stop the current timer first.");
      const [project, task] = parts(args, 2);
      return label(
        add(entries, task, project, now, {
          project,
          start: now.getTime(),
          end: null,
        }),
      );
    }
    if (verb === "stop") {
      const e = entries.find((e) => e.data.end === null);
      if (!e) throw new InputError("No timer running.");
      validate(entries, Number(e.data.start), now.getTime(), now, e.id);
      e.data.end = now.getTime();
      touch(e, now);
      return `${label(e)}\nLogged ${((Number(e.data.end) - Number(e.data.start)) / 60000).toFixed(1)} minutes.`;
    }
    if (verb === "log") {
      const [project, from, to, task] = parts(args, 4),
        start = instant(from),
        end = instant(to);
      validate(entries, start, end, now);
      return label(add(entries, task, project, now, { project, start, end }));
    }
    if (verb === "adjust") {
      const [id, from, to] = parts(args, 3),
        e = find(entries, id),
        start = instant(from),
        end = instant(to);
      validate(entries, start, end, now, e.id);
      e.data.start = start;
      e.data.end = end;
      touch(e, now);
      return label(e) + " corrected.";
    }
    if (verb === "report") {
      const [from, to] = parts(args, 2);
      date(from);
      date(to);
      if (from > to) throw new InputError("Start date must precede end date.");
      const start = Date.parse(from),
        end = Math.min(Date.parse(to) + 86400000, now.getTime()),
        totals = new Map<string, number>();
      for (const e of entries) {
        const ms = Math.max(
          0,
          Math.min(Number(e.data.end ?? now.getTime()), end) -
            Math.max(Number(e.data.start), start),
        );
        if (ms)
          totals.set(
            String(e.data.project),
            (totals.get(String(e.data.project)) ?? 0) + ms,
          );
      }
      return totals.size
        ? `UTC ${from} through ${to} (inclusive; running time included)\n${[...totals].map(([project, ms]) => `${project}: ${(ms / 3600000).toFixed(2)} h`).join("\n")}\nTotal: ${([...totals.values()].reduce((a, b) => a + b, 0) / 3600000).toFixed(2)} h`
        : "No time logged in that range.";
    }
  },
};
