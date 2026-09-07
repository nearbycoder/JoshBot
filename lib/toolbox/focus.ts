import {
  add,
  find,
  InputError,
  label,
  number,
  parts,
  touch,
  type Entry,
  type Feature,
} from "./core.js";
const remaining = (e: Entry, now: Date) =>
  Math.max(
    0,
    Number(e.data.remainingMs) -
      (e.data.started === null ? 0 : now.getTime() - Number(e.data.started)),
  );
const status = (e: Entry, now: Date) =>
  `${label(e)}\n${e.data.closed ? "Ended" : e.data.phase} · ${e.data.started === null ? "paused" : "running"} · ${Math.ceil(remaining(e, now) / 60000)} min left · ${e.data.cycles} completed focus blocks\n${!e.data.closed && remaining(e, now) === 0 ? "Phase complete. Run next <id> to start the next phase." : "Check status when ready; this timer does not send notifications."}`;
export const focus: Feature = {
  render: status,
  id: "focus",
  title: "Focus sessions",
  description:
    "Restart-safe work/break countdowns with pause, resume and completed-block counts.",
  help: "start Write proposal | 25 | 5\nstatus <id> · pause <id> · resume <id>\nnext <id> (only after the phase completes)\nfinish <id>\nNo background notifications; use NoBo reminders separately if needed.",
  run(entries, verb, args, now) {
    if (verb === "start") {
      if (entries.some((e) => !e.data.closed))
        throw new InputError("Finish your existing focus session first.");
      const [title, workText, breakText] = parts(args, 3),
        work = number(workText, 1, 180),
        rest = number(breakText, 1, 60);
      if (!Number.isInteger(work) || !Number.isInteger(rest))
        throw new InputError("Durations must be whole minutes.");
      return status(
        add(entries, title, "", now, {
          work,
          rest,
          phase: "work",
          cycles: 0,
          remainingMs: work * 60000,
          started: now.getTime(),
          closed: false,
        }),
        now,
      );
    }
    if (["status", "pause", "resume", "next", "finish"].includes(verb)) {
      const e = find(entries, args);
      if (verb === "status") return status(e, now);
      if (e.data.closed)
        throw new InputError("This session has ended. Start a new one.");
      if (verb === "pause") {
        e.data.remainingMs = remaining(e, now);
        e.data.started = null;
      }
      if (verb === "resume") {
        if (e.data.started !== null) throw new InputError("Already running.");
        if (remaining(e, now) === 0)
          throw new InputError("Phase complete; use next.");
        e.data.started = now.getTime();
      }
      if (verb === "next") {
        if (remaining(e, now) > 0)
          throw new InputError("This phase still has time remaining.");
        if (e.data.phase === "work") e.data.cycles = Number(e.data.cycles) + 1;
        e.data.phase = e.data.phase === "work" ? "break" : "work";
        e.data.remainingMs =
          Number(e.data.phase === "work" ? e.data.work : e.data.rest) * 60000;
        e.data.started = now.getTime();
      }
      if (verb === "finish") {
        if (e.data.phase === "work" && remaining(e, now) === 0)
          e.data.cycles = Number(e.data.cycles) + 1;
        e.data.remainingMs = remaining(e, now);
        e.data.started = null;
        e.data.closed = true;
      }
      touch(e, now);
      return status(e, now);
    }
  },
};
