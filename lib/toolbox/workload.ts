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
type Task = {
  number: number;
  title: string;
  hours: number;
  priority: number;
  due: string;
  done: boolean;
};
const tasks = (e: Entry) => e.data.tasks as Task[];
export function planWorkload(e: Entry, now: Date) {
  const capacity = Number(e.data.capacity),
    done = tasks(e)
      .filter((t) => t.done)
      .reduce((n, t) => n + t.hours, 0),
    today = now.toISOString().slice(0, 10);
  let available = Math.max(0, capacity - done);
  const selected: Task[] = [],
    deferred: Task[] = [];
  for (const t of tasks(e)
    .filter((t) => !t.done)
    .sort(
      (a, b) =>
        Number(b.due < today) - Number(a.due < today) ||
        b.priority - a.priority ||
        a.due.localeCompare(b.due) ||
        a.number - b.number,
    )) {
    if (t.hours <= available + 1e-9) {
      selected.push(t);
      available -= t.hours;
    } else deferred.push(t);
  }
  const line = (t: Task) =>
    `#${t.number} ${t.title} · ${t.hours} h · P${t.priority} · due ${t.due}${t.due < today ? " · OVERDUE" : ""}`;
  return `${label(e)} · week of ${e.data.week}\nCapacity ${capacity} h · completed ${done} h · planned ${selected.reduce((n, t) => n + t.hours, 0).toFixed(2)} h · spare ${available.toFixed(2)} h${done > capacity ? " · OVER CAPACITY" : ""}\n\nPLAN\n${selected.map(line).join("\n") || "No tasks fit the remaining capacity."}\n\nDEFERRED\n${deferred.map(line).join("\n") || "None"}\nBased on your estimates; no tasks assigned or calendar time booked.`;
}
export const workload: Feature = {
  render: planWorkload,
  id: "workload",
  title: "Weekly workload planner",
  description:
    "Fit estimated tasks into a weekly capacity budget, with priorities, overdue flags and explicit deferrals.",
  help: "create This week | 2026-09-07 | 30\ntask <id> | Ship toolbox | 4 | 5 | 2026-09-09\nplan <id>\ndone <id> | 1 · undo <id> | 1\neffort <id> | 1 | 3\npriority <id> | 1 | 4\ndue <id> | 1 | 2026-09-10\ncapacity <id> | 25\nWeek date must be a Monday. Priority 5 is highest.",
  run(entries, verb, args, now) {
    if (verb === "create") {
      const [title, week, hours] = parts(args, 3);
      date(week);
      if (new Date(week).getUTCDay() !== 1)
        throw new InputError("Choose a Monday for the start of the week.");
      return label(
        add(entries, title, "", now, {
          week,
          capacity: number(hours, 0, 168),
          tasks: [],
          next: 1,
        }),
      );
    }
    if (verb === "plan") return planWorkload(find(entries, args), now);
    if (
      [
        "task",
        "done",
        "undo",
        "effort",
        "priority",
        "due",
        "capacity",
      ].includes(verb)
    ) {
      const fields = parts(
          args,
          verb === "task"
            ? 5
            : ["done", "undo", "capacity"].includes(verb)
              ? 2
              : 3,
        ),
        e = find(entries, fields[0]);
      if (verb === "task") {
        if (tasks(e).length >= 50)
          throw new InputError("Use at most 50 tasks.");
        const hours = number(fields[2], 0.25, 168),
          priority = number(fields[3], 1, 5);
        if (!Number.isInteger(priority))
          throw new InputError("Priority must be a whole number.");
        date(fields[4]);
        tasks(e).push({
          number: Number(e.data.next),
          title: fields[1],
          hours,
          priority,
          due: fields[4],
          done: false,
        });
        e.data.next = Number(e.data.next) + 1;
      } else if (verb === "capacity")
        e.data.capacity = number(fields[1], 0, 168);
      else {
        const t = tasks(e).find((t) => t.number === number(fields[1], 1));
        if (!t) throw new InputError("Task number not found.");
        if (verb === "effort") t.hours = number(fields[2], 0.25, 168);
        else if (verb === "priority") {
          const p = number(fields[2], 1, 5);
          if (!Number.isInteger(p))
            throw new InputError("Priority must be a whole number.");
          t.priority = p;
        } else if (verb === "due") t.due = date(fields[2]);
        else t.done = verb === "done";
      }
      e.body = tasks(e)
        .map((t) => t.title)
        .join("\n");
      touch(e, now);
      return planWorkload(e, now);
    }
  },
};
