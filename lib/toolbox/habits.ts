import {
  add,
  date,
  find,
  InputError,
  label,
  number,
  parts,
  touch,
  type Entry,
  type Feature,
} from "./core.js";
const days = (e: Entry) => e.data.days as string[];
const previous = (d: string) =>
  new Date(Date.parse(d) - 86400000).toISOString().slice(0, 10);
export function habitStats(e: Entry, asOf: string) {
  const valid = days(e)
      .filter((d) => d <= asOf)
      .sort(),
    marked = new Set(valid);
  let current = 0,
    cursor = marked.has(asOf) ? asOf : previous(asOf);
  while (marked.has(cursor)) {
    current++;
    cursor = previous(cursor);
  }
  let best = 0,
    run = 0,
    last = "";
  for (const day of valid) {
    run = last === previous(day) ? run + 1 : 1;
    best = Math.max(best, run);
    last = day;
  }
  const start = new Date(Date.parse(asOf) - 6 * 86400000)
      .toISOString()
      .slice(0, 10),
    week = valid.filter((d) => d >= start).length;
  return `${label(e)}\nThrough ${asOf} (UTC dates): current streak ${current} days · best ${best} days\nLast 7 days: ${week}/${e.data.target} target · Total ${valid.length} check-ins`;
}
export const habits: Feature = {
  render: (entry, now) => habitStats(entry, now.toISOString().slice(0, 10)),
  id: "habits",
  title: "Habit tracker",
  description:
    "Log dated check-ins with current/best streaks and a weekly target.",
  help: "create Read for 20 minutes | 5\ncheck <id> | 2026-09-07\nuncheck <id> | 2026-09-07\nstats <id> | 2026-09-07\nDates are UTC; no automatic reminders.",
  run(entries, verb, args, now) {
    if (verb === "create") {
      const [title, target] = parts(args, 2),
        n = number(target, 1, 7);
      if (!Number.isInteger(n))
        throw new InputError("Weekly target must be a whole number.");
      return label(add(entries, title, "", now, { target: n, days: [] }));
    }
    if (["check", "uncheck", "stats"].includes(verb)) {
      const [id, day] = parts(args, 2);
      date(day);
      if (day > now.toISOString().slice(0, 10))
        throw new InputError("Check-ins and reports cannot be future-dated.");
      const e = find(entries, id);
      if (verb === "check") {
        if (!days(e).includes(day)) {
          if (days(e).length >= 366)
            throw new InputError(
              "366 check-ins retained. Export this habit and start a new yearly tracker.",
            );
          days(e).push(day);
          days(e).sort();
        }
        touch(e, now);
      }
      if (verb === "uncheck") {
        e.data.days = days(e).filter((d) => d !== day);
        touch(e, now);
      }
      return habitStats(e, day);
    }
  },
};
