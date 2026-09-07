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
export function businessDays(from: string, to: string): number {
  if (from > to) return -businessDays(to, from);
  const diff = (Date.parse(to) - Date.parse(from)) / 86400000,
    weeks = Math.floor(diff / 7);
  let result = weeks * 5;
  for (let i = weeks * 7 + 1; i <= diff; i++) {
    const day = new Date(Date.parse(from) + i * 86400000).getUTCDay();
    if (day !== 0 && day !== 6) result++;
  }
  return result;
}
const summary = (e: Entry, now: Date) => {
  const today = now.toISOString().slice(0, 10),
    due = String(e.data.day),
    days = (Date.parse(due) - Date.parse(today)) / 86400000;
  return `${label(e)} · ${due}\n${days === 0 ? "Today" : days > 0 ? days + " calendar days left" : Math.abs(days) + " calendar days ago"} · ${Math.abs(businessDays(today, due))} weekdays ${days < 0 ? "since" : "remaining"}${e.data.archived ? " · archived" : ""}`;
};
export const countdowns: Feature = {
  render: summary,
  id: "countdowns",
  title: "Milestone countdowns",
  description:
    "Watch personal dates with calendar-day and weekday countdowns, rescheduling and archives.",
  help: "add Launch | 2026-10-01\ncount <id>\nupcoming 30\nreschedule <id> | 2026-10-15\narchive <id> · restore <id>\nDates use UTC. Weekdays exclude weekends, not holidays. No notifications.",
  run(entries, verb, args, now) {
    if (verb === "add") {
      const [title, day] = parts(args, 2);
      date(day);
      return summary(
        add(entries, title, day, now, { day, archived: false }),
        now,
      );
    }
    if (verb === "count") return summary(find(entries, args), now);
    if (verb === "upcoming") {
      const span = number(args, 0, 3650),
        today = now.toISOString().slice(0, 10),
        end = new Date(Date.parse(today) + span * 86400000)
          .toISOString()
          .slice(0, 10);
      if (!Number.isInteger(span))
        throw new InputError("Choose a whole number of days.");
      return (
        entries
          .filter(
            (e) =>
              !e.data.archived &&
              String(e.data.day) >= today &&
              String(e.data.day) <= end,
          )
          .sort((a, b) => String(a.data.day).localeCompare(String(b.data.day)))
          .map((e) => summary(e, now))
          .join("\n\n") || "No active milestones in that range."
      );
    }
    if (["reschedule", "archive", "restore"].includes(verb)) {
      const [id, day] = verb === "reschedule" ? parts(args, 2) : [args, ""],
        e = find(entries, id);
      if (verb === "reschedule") {
        e.data.day = date(day);
        e.body = day;
      } else e.data.archived = verb === "archive";
      touch(e, now);
      return summary(e, now);
    }
  },
};
