import { randomUUID } from "node:crypto";
import type { AgentFeature, AgentFeatureContext } from "./types.js";
import { instant, iso, minuteOfDay, PlannerError, validDate, ZonedTime } from "./day-planner/time.js";

const KEY = "state";
const MINUTE = 60_000;
const MAX_TASKS = 50;
const MAX_EVENTS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Priority = "high" | "normal" | "low";
type Range = { start: string; end: string };
type Settings = { hours: Range; breaks: Range[] };
type Task = { id: string; title: string; minutes: number; priority: Priority; deadline: string | null; createdAt: string };
type EventLabel = { id: string; title: string };
type Block = { startAt: string; endAt: string } & (
  { kind: "task"; taskId: string } |
  { kind: "unavailable"; eventIds: string[]; hasBreak: boolean }
);
type Plan = {
  date: string; timezone: string; createdAt: string; workStartAt: string; workEndAt: string;
  availableFrom: string; blocks: Block[]; events: EventLabel[];
  unscheduled: { taskId: string; reason: string }[];
};
type State = { version: 1; revision: string; tasks: Task[]; settings: Settings; plan: Plan | null };
type Busy = { start: number; end: number; eventIds: string[]; hasBreak: boolean };

function initial(): State {
  return { version: 1, revision: "initial", tasks: [],
    settings: { hours: { start: "09:00", end: "17:00" }, breaks: [{ start: "12:00", end: "12:30" }] }, plan: null };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function cleanString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}
function canonicalInstant(value: unknown): value is string {
  const epoch = instant(value);
  return epoch !== null && iso(epoch) === value;
}
function priority(value: unknown): value is Priority { return value === "high" || value === "normal" || value === "low"; }
function validRange(value: unknown): value is Range {
  if (!record(value)) return false;
  const start = minuteOfDay(value.start), end = minuteOfDay(value.end, true);
  return start !== null && end !== null && start < end;
}
function validSettings(value: unknown): value is Settings {
  if (!record(value) || !validRange(value.hours) || !Array.isArray(value.breaks) || value.breaks.length > 4) return false;
  const breaks = value.breaks;
  return breaks.every((range, index) => validRange(range) &&
    (index === 0 || minuteOfDay(breaks[index - 1].end, true)! <= minuteOfDay(range.start)!));
}
function validTask(value: unknown): value is Task {
  return record(value) && typeof value.id === "string" && UUID.test(value.id) && cleanString(value.title, 160) &&
    Number.isInteger(value.minutes) && Number(value.minutes) >= 1 && Number(value.minutes) <= 720 &&
    priority(value.priority) && (value.deadline === null || canonicalInstant(value.deadline)) && canonicalInstant(value.createdAt);
}
function validPlan(value: unknown, tasks: Task[]): value is Plan {
  if (!record(value) || !validDate(value.date) || !cleanString(value.timezone, 100) || !canonicalInstant(value.createdAt) ||
    !canonicalInstant(value.workStartAt) || !canonicalInstant(value.workEndAt) || !canonicalInstant(value.availableFrom) ||
    !Array.isArray(value.events) || value.events.length > MAX_EVENTS || !Array.isArray(value.blocks) || value.blocks.length > 254 ||
    !Array.isArray(value.unscheduled) || value.unscheduled.length > MAX_TASKS) return false;
  try { new ZonedTime(value.timezone); } catch { return false; }
  const workStart = Date.parse(value.workStartAt), workEnd = Date.parse(value.workEndAt);
  let cursor = Date.parse(value.availableFrom);
  if (workStart >= workEnd || workEnd - workStart > 48 * 60 * MINUTE || cursor < workStart || cursor > workEnd) return false;
  const ids = new Set<string>();
  for (const event of value.events) {
    if (!record(event) || !cleanString(event.id, 120) || !cleanString(event.title, 160) || ids.has(event.id)) return false;
    ids.add(event.id);
  }
  const accounted = new Set<string>();
  for (const block of value.blocks) {
    if (!record(block) || !canonicalInstant(block.startAt) || !canonicalInstant(block.endAt)) return false;
    const start = Date.parse(block.startAt), end = Date.parse(block.endAt);
    if (start < cursor || start >= end || end > workEnd) return false;
    cursor = end;
    if (block.kind === "task") {
      const task = tasks.find(task => task.id === block.taskId);
      if (!task || accounted.has(task.id) || end - start !== task.minutes * MINUTE || (task.deadline && end > Date.parse(task.deadline))) return false;
      accounted.add(task.id);
    } else if (block.kind === "unavailable") {
      if (typeof block.hasBreak !== "boolean" || !Array.isArray(block.eventIds) || block.eventIds.length > MAX_EVENTS ||
        !block.eventIds.every(id => typeof id === "string" && ids.has(id)) ||
        new Set(block.eventIds).size !== block.eventIds.length || (!block.hasBreak && block.eventIds.length === 0)) return false;
    } else return false;
  }
  for (const item of value.unscheduled) {
    if (!record(item) || typeof item.taskId !== "string" || !tasks.some(task => task.id === item.taskId) || accounted.has(item.taskId) || !cleanString(item.reason, 400)) return false;
    accounted.add(item.taskId);
  }
  return accounted.size === tasks.length;
}
function state(value: unknown): State {
  if (value === null) return initial();
  if (!record(value) || value.version !== 1 || typeof value.revision !== "string" ||
    (value.revision !== "initial" && !UUID.test(value.revision)) || !Array.isArray(value.tasks) ||
    value.tasks.length > MAX_TASKS || !value.tasks.every(validTask) || new Set(value.tasks.map(task => task.id)).size !== value.tasks.length ||
    !validSettings(value.settings) || (value.plan !== null && !validPlan(value.plan, value.tasks)) || JSON.stringify(value).length > 150_000) {
    throw new PlannerError("Saved day-planner data is invalid or from an unsupported version. It was left unchanged. Use clear confirm only if you want to delete it and start over.");
  }
  return { version: 1, revision: value.revision, tasks: value.tasks, settings: value.settings, plan: value.plan };
}

function rangeInput(input: string): Range {
  const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(input);
  const range = match ? { start: match[1], end: match[2] } : null;
  if (!validRange(range)) throw new PlannerError("Use a same-day range such as 09:00-17:00, with start before end. Only an end time may be 24:00; overnight work is not supported.");
  return range;
}
function safe(value: string): string {
  // Neutralize Slack mention/link syntax without expanding a bounded plain-text reply.
  return value.replace(/&/g, "＆").replace(/</g, "＜").replace(/>/g, "＞");
}
function bounded(value: string): string {
  if (value.length <= 27_000) return value;
  const cut = value.lastIndexOf("\n", 26_800);
  return `${value.slice(0, cut > 0 ? cut : 26_800)}\n…Display shortened. All items remain saved; use tasks to inspect task IDs.`;
}
function settingsText(settings: Settings): string {
  return `Working hours: ${settings.hours.start}-${settings.hours.end}. Breaks: ${settings.breaks.map(range => `${range.start}-${range.end}`).join(", ") || "none"}.`;
}
function taskText(task: Task): string {
  return `${task.id} — ${safe(task.title)} (${task.minutes}m, ${task.priority}${task.deadline ? `, finish by ${task.deadline}` : ""})`;
}
function render(plan: Plan, tasks: Task[]): string {
  const zone = new ZonedTime(plan.timezone);
  const clock = (value: string) => {
    const epoch = Date.parse(value), date = zone.date(epoch);
    return `${zone.clock(epoch)}${date === plan.date ? "" : ` (${date})`}`;
  };
  const lines = [`Day plan for ${plan.date} (${safe(plan.timezone)})`,
    `Work: ${clock(plan.workStartAt)}–${clock(plan.workEndAt)}. Available from ${clock(plan.availableFrom)}.`,
    `Saved ${plan.createdAt}. Private proposal; no calendar writes. Events are a snapshot; rerun plan to refresh.`];
  if (tasks.length === 0) lines.push("No tasks yet. Try add Draft proposal | 60 | high.");
  if (plan.events.length === 0) lines.push("No busy owned events overlap this planning window; this does not verify external calendars.");
  let shownBusy = 0, omittedBusy = 0;
  for (const block of plan.blocks) {
    const times = `${clock(block.startAt)}–${clock(block.endAt)}`;
    if (block.kind === "task") {
      const task = tasks.find(task => task.id === block.taskId)!;
      lines.push(`${times} — ${safe(task.title)} (${task.minutes}m, ${task.priority}; ${task.id})`);
    } else {
      if (shownBusy++ >= 12) { omittedBusy++; continue; }
      const labels = block.eventIds.slice(0, 2).map(id => {
        const event = plan.events.find(event => event.id === id)!;
        return `${safe(event.title.slice(0, 64))}${event.title.length > 64 ? "…" : ""} [${safe(id)}]`;
      });
      if (block.eventIds.length > 2) labels.push(`+${block.eventIds.length - 2} other events`);
      if (block.hasBreak) labels.push("scheduled break");
      lines.push(`${times} — Unavailable: ${labels.join("; ")}`);
    }
  }
  if (omittedBusy) lines.push(`${omittedBusy} additional unavailable intervals omitted from display; all were excluded when scheduling.`);
  lines.push(`Scheduled: ${plan.blocks.filter(block => block.kind === "task").length}/${tasks.length} tasks.`);
  if (plan.unscheduled.length) {
    lines.push("Unscheduled:");
    for (const item of plan.unscheduled) {
      const task = tasks.find(task => task.id === item.taskId)!;
      lines.push(`${task.id} — ${safe(task.title)}: ${safe(item.reason.slice(0, 160))}${item.reason.length > 160 ? "…" : ""}`);
    }
  }
  return lines.join("\n");
}

function eventIntervals(raw: unknown, start: number, end: number): { busy: Busy[]; events: EventLabel[] } {
  if (!Array.isArray(raw) || raw.length > MAX_EVENTS) {
    throw new PlannerError(`Owned event context must be an array of at most ${MAX_EVENTS} records. No plan was replaced; the adapter must return complete, bounded event context.`);
  }
  const busy: Busy[] = [], events: EventLabel[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!record(item) || item.kind !== "event") throw new PlannerError("Owned event context contained a non-event record. No plan was replaced.");
    if (item.status === "cancelled" || item.status === "canceled") continue;
    if (!record(item.metadata)) throw new PlannerError("An owned event is missing startAt/endAt metadata. No plan was replaced; repair or remove that event first.");
    if (item.metadata.busy === false) continue;
    const startAt = instant(item.metadata.startAt), endAt = instant(item.metadata.endAt);
    if (!cleanString(item.id, 120) || seen.has(item.id) || typeof item.title !== "string" || item.title.length > 2_000 ||
      (item.metadata.busy !== undefined && typeof item.metadata.busy !== "boolean") || startAt === null || endAt === null || startAt >= endAt) {
      throw new PlannerError("An owned event has an invalid/duplicate ID or invalid interval. Every busy event needs startAt/endAt ISO timestamps with explicit offsets and start before end. No plan was replaced.");
    }
    seen.add(item.id);
    if (startAt >= end || endAt <= start || start === end) continue;
    const title = item.title.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 160).trim() || "Untitled event";
    events.push({ id: item.id, title });
    busy.push({ start: Math.max(start, startAt), end: Math.min(end, endAt), eventIds: [item.id], hasBreak: false });
  }
  return { busy, events };
}
function mergeBusy(intervals: Busy[]): Busy[] {
  const result: Busy[] = [];
  for (const interval of intervals.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result.at(-1);
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
      last.eventIds.push(...interval.eventIds);
      last.hasBreak ||= interval.hasBreak;
    } else result.push({ ...interval, eventIds: [...interval.eventIds] });
  }
  return result;
}
function makePlan(date: string, context: AgentFeatureContext, snapshot: State, rawEvents: unknown, zone: ZonedTime): Plan {
  const workStart = zone.local(date, snapshot.settings.hours.start), workEnd = zone.local(date, snapshot.settings.hours.end);
  if (workEnd <= workStart) throw new PlannerError("The working-hour boundaries do not form a positive interval on that date. Choose different hours.");
  const start = Math.min(workEnd, Math.max(workStart, Math.ceil(context.now.getTime() / MINUTE) * MINUTE));
  const { busy, events } = eventIntervals(rawEvents, start, workEnd);
  for (const range of snapshot.settings.breaks) {
    // Ignore breaks entirely outside working hours before resolving civil-time boundaries.
    if (minuteOfDay(range.end, true)! <= minuteOfDay(snapshot.settings.hours.start)! ||
      minuteOfDay(range.start)! >= minuteOfDay(snapshot.settings.hours.end, true)!) continue;
    const breakStart = Math.max(start, zone.local(date, range.start));
    const breakEnd = Math.min(workEnd, zone.local(date, range.end));
    if (breakStart < breakEnd) busy.push({ start: breakStart, end: breakEnd, eventIds: [], hasBreak: true });
  }
  const blocked = mergeBusy(busy);
  const blocks: Block[] = blocked.map(interval => ({ kind: "unavailable", startAt: iso(interval.start), endAt: iso(interval.end), eventIds: interval.eventIds, hasBreak: interval.hasBreak }));
  const free: { start: number; end: number }[] = [];
  let cursor = start;
  for (const interval of blocked) {
    if (interval.start > cursor) free.push({ start: cursor, end: interval.start });
    cursor = interval.end;
  }
  if (cursor < workEnd) free.push({ start: cursor, end: workEnd });
  const rank = { high: 0, normal: 1, low: 2 };
  const tasks = [...snapshot.tasks].sort((a, b) => rank[a.priority] - rank[b.priority] ||
    (a.deadline ? Date.parse(a.deadline) : Infinity) - (b.deadline ? Date.parse(b.deadline) : Infinity) ||
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const unscheduled: Plan["unscheduled"] = [];
  for (const task of tasks) {
    const deadline = task.deadline ? Date.parse(task.deadline) : Infinity;
    const slot = free.find(slot => slot.start + task.minutes * MINUTE <= Math.min(slot.end, deadline));
    if (slot) {
      const end = slot.start + task.minutes * MINUTE;
      blocks.push({ kind: "task", taskId: task.id, startAt: iso(slot.start), endAt: iso(end) });
      slot.start = end;
    } else {
      const reason = start === workEnd ? "Working hours have ended for this date." : deadline <= start ?
        "Deadline is at or before available work begins." :
        `No continuous ${task.minutes}m slot${task.deadline ? ` finishing by ${task.deadline}` : ""} after events, breaks, and higher-ranked tasks.`;
      unscheduled.push({ taskId: task.id, reason });
    }
  }
  blocks.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  return { date, timezone: context.timezone, createdAt: context.now.toISOString(), workStartAt: iso(workStart), workEndAt: iso(workEnd),
    availableFrom: iso(start), blocks, events, unscheduled };
}

const help = `Private time-blocked day planner
/nobo-help agent day-planner <command>
tasks — list tasks and stable IDs
add <title> | <minutes 1-720> | <high|normal|low> [| <deadline>]
remove <task-id>
settings — show working hours and breaks
settings hours HH:mm-HH:mm
settings breaks HH:mm-HH:mm[,HH:mm-HH:mm] — up to 4; or none
plan YYYY-MM-DD — save a deterministic proposal around owned events
show — last saved plan, with its original timezone and event snapshot
clear confirm — delete all planner tasks, settings, and saved plan
Example: add Draft proposal | 60 | high | 2026-10-23T16:00
Example: settings breaks 12:00-12:30,15:00-15:15
Example: plan 2026-10-23
Deadlines are local to the supplied timezone unless they include Z or an offset. Ambiguous/nonexistent local times are rejected. Working/break boundaries must be unambiguous. End time may be 24:00; no overnight work. Tasks are whole blocks: priority first, then deadline, then creation time/ID. For today, planning starts at the next minute. No model calls or calendar writes. 50 tasks and one plan retained; edits invalidate the saved plan.`;

async function execute(command: string, context: AgentFeatureContext): Promise<string> {
  if (typeof command !== "string" || command.length > 2_000) throw new PlannerError("Command is too long (maximum 2,000 characters). Use help for syntax.");
  const input = command.trim();
  if (!input || input === "help") return help;
  if (input === "clear confirm") {
    const revision = randomUUID();
    await context.store.update<unknown, void>(KEY, initial(), () => ({ value: { ...initial(), revision }, result: undefined }));
    return "Deleted all day-planner tasks and the saved plan; working hours/breaks are reset to defaults.";
  }
  if (input === "clear") return "Use clear confirm to delete all planner tasks, settings, and the saved plan.";
  if (input === "tasks" || input === "settings" || input === "show") {
    const saved = state(await context.store.read<unknown>(KEY));
    if (input === "tasks") return saved.tasks.length ? saved.tasks.map(taskText).join("\n") : "No tasks yet. Try add Draft proposal | 60 | high, then plan YYYY-MM-DD.";
    if (input === "settings") return `${settingsText(saved.settings)}\nTimes use the supplied timezone (${safe(String(context.timezone))}); breaks apply only within working hours. Use settings hours 09:00-17:00 or settings breaks none.`;
    return saved.plan ? render(saved.plan, saved.tasks) : "No saved plan. Add tasks, check settings, then run plan YYYY-MM-DD. Task/settings edits invalidate the previous plan.";
  }
  if (input.startsWith("add ")) {
    const fields = input.slice(4).split("|").map(field => field.trim());
    const [title, duration, taskPriority, due] = fields;
    if ((fields.length !== 3 && fields.length !== 4) || !cleanString(title, 160) || !/^\d{1,3}$/.test(duration ?? "") ||
      Number(duration) < 1 || Number(duration) > 720 || !priority(taskPriority) || (fields.length === 4 && !due)) {
      throw new PlannerError("Use add <title, 1-160 characters> | <minutes, integer 1-720> | <high|normal|low> [| <deadline>]. Titles cannot contain | or line breaks.");
    }
    if (!Number.isFinite(context.now.getTime())) throw new PlannerError("The runtime supplied an invalid current time.");
    const task: Task = { id: randomUUID(), title, minutes: Number(duration), priority: taskPriority,
      deadline: due ? new ZonedTime(context.timezone).deadline(due) : null, createdAt: context.now.toISOString() };
    const revision = randomUUID();
    await context.store.update<unknown, void>(KEY, initial(), raw => {
      const saved = state(raw);
      if (saved.tasks.length >= MAX_TASKS) throw new PlannerError("The planner holds at most 50 tasks. Remove a task before adding another.");
      return { value: { ...saved, revision, tasks: [...saved.tasks, task], plan: null }, result: undefined };
    });
    return `Added ${taskText(task)}. Run plan YYYY-MM-DD to schedule it.`;
  }
  if (input.startsWith("remove ")) {
    const id = input.slice(7).trim();
    if (!UUID.test(id)) throw new PlannerError("Use remove <full task-id> from tasks.");
    const revision = randomUUID();
    const removed = await context.store.update<unknown, boolean>(KEY, initial(), raw => {
      const saved = state(raw);
      if (!saved.tasks.some(task => task.id === id)) return { value: saved, result: false };
      return { value: { ...saved, revision, tasks: saved.tasks.filter(task => task.id !== id), plan: null }, result: true };
    });
    return removed ? `Removed ${id}. Run plan YYYY-MM-DD to refresh the plan.` : "Task not found. Use tasks to see current IDs.";
  }
  if (input.startsWith("settings ")) {
    const match = /^settings (hours|breaks) (.+)$/.exec(input);
    if (!match) throw new PlannerError("Use settings hours 09:00-17:00 or settings breaks 12:00-12:30 (or none).");
    const hours = match[1] === "hours" ? rangeInput(match[2]) : null;
    const breaks = match[1] === "breaks" ? (match[2] === "none" ? [] : match[2].split(",").map(value => rangeInput(value.trim())).sort((a, b) => minuteOfDay(a.start)! - minuteOfDay(b.start)!)) : null;
    const revision = randomUUID();
    const next = await context.store.update<unknown, Settings>(KEY, initial(), raw => {
      const saved = state(raw);
      const settings = { hours: hours ?? saved.settings.hours, breaks: breaks ?? saved.settings.breaks };
      if (!validSettings(settings)) throw new PlannerError("Choose at most four nonoverlapping breaks within a single day.");
      return { value: { ...saved, revision, settings, plan: null }, result: settings };
    });
    return `${settingsText(next)} Local times use the supplied timezone and are checked for clock changes when planning. Saved plan cleared; run plan YYYY-MM-DD.`;
  }
  if (input.startsWith("plan ")) {
    const date = input.slice(5).trim();
    if (!validDate(date)) throw new PlannerError("Use plan YYYY-MM-DD with a real date (years 1900-2200).");
    if (!Number.isFinite(context.now.getTime())) throw new PlannerError("The runtime supplied an invalid current time.");
    const zone = new ZonedTime(context.timezone);
    if (date < zone.date(context.now.getTime())) throw new PlannerError("Choose today or a future date in your timezone; past days cannot be scheduled.");
    const snapshot = state(await context.store.read<unknown>(KEY));
    // Validate civil boundaries before calling a provider; no state is changed on failure.
    zone.local(date, snapshot.settings.hours.start);
    zone.local(date, snapshot.settings.hours.end);
    let events: unknown;
    try { events = await context.services.readContext(["event"]); }
    catch { throw new PlannerError("Could not read your owned events. Tasks, settings, and any saved plan were kept. Retry plan when event context is available."); }
    const plan = makePlan(date, context, snapshot, events, zone);
    if (context.signal?.aborted) throw new PlannerError("Planning was cancelled. No saved plan was replaced.");
    const revision = randomUUID();
    const committed = await context.store.update<unknown, boolean>(KEY, initial(), raw => {
      const saved = state(raw);
      if (saved.revision !== snapshot.revision) return { value: saved, result: false };
      return { value: { ...saved, revision, plan }, result: true };
    });
    if (!committed) return "Tasks, settings, or the saved plan changed while planning. This stale proposal was discarded. Run plan YYYY-MM-DD again.";
    return render(plan, snapshot.tasks);
  }
  return `Unknown day-planner command.\n${help}`;
}

export const feature: AgentFeature = {
  id: "day-planner",
  title: "Time-blocked day planner",
  description: "Build a private, timezone-aware day plan around owned events, task priorities, deadlines, and breaks.",
  help,
  async execute(command, context) {
    try { return bounded(await execute(command, context)); }
    catch (error) {
      return error instanceof PlannerError ? bounded(error.message) : "The day planner could not complete this command. Retry when storage is available; use show to check the last saved plan.";
    }
  },
};

export default feature;
