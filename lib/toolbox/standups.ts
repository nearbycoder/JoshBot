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
const draft = (e: Entry) =>
  `${e.data.project} — ${e.data.day}\nYesterday\n${e.data.yesterday || "Not filled in"}\nToday\n${e.data.today || "Not filled in"}\nBlockers\n${e.data.blockers || "Not filled in"}\n\nPrivate draft — copy it to your team when ready.`;
const sync = (e: Entry) => {
  e.body = `${e.data.project}\n${e.data.yesterday}\n${e.data.today}\n${e.data.blockers}`;
};
export const standups: Feature = {
  render: draft,
  id: "standups",
  title: "Standup builder",
  description:
    "Prepare dated yesterday/today/blocker updates and carry plans into the next day's draft.",
  help: "create 2026-09-07 | NoBo\nyesterday <id> | Shipped bookmarks\ntoday <id> | Build time tracker\nblockers <id> | None\ndraft <id>\ncarry <id> | 2026-09-08",
  run(entries, verb, args, now) {
    if (verb === "create") {
      const [day, project] = parts(args, 2);
      date(day);
      if (entries.some((e) => e.data.day === day && e.data.project === project))
        throw new InputError(
          "A draft already exists for that project and date.",
        );
      return label(
        add(entries, `${project} · ${day}`, project, now, {
          day,
          project,
          yesterday: "",
          today: "",
          blockers: "",
        }),
      );
    }
    if (verb === "draft") return draft(find(entries, args));
    if (["yesterday", "today", "blockers"].includes(verb)) {
      const [id, text] = parts(args, 2),
        e = find(entries, id);
      e.data[verb] = text;
      sync(e);
      touch(e, now);
      return draft(e);
    }
    if (verb === "carry") {
      const [id, day] = parts(args, 2),
        from = find(entries, id);
      date(day);
      if (day <= String(from.data.day))
        throw new InputError("Choose a later date.");
      if (
        entries.some(
          (e) => e.data.day === day && e.data.project === from.data.project,
        )
      )
        throw new InputError(
          "That day's draft already exists; nothing overwritten.",
        );
      const e = add(entries, `${from.data.project} · ${day}`, "", now, {
        day,
        project: from.data.project,
        yesterday: from.data.today,
        today: "",
        blockers: from.data.blockers,
      });
      sync(e);
      return label(e) + "\n" + draft(e);
    }
  },
};
