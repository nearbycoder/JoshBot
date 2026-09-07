import {
  add,
  date,
  find,
  InputError,
  label,
  number,
  parts,
  touch,
  type Feature,
} from "./core.js";
function zone(value: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    throw new InputError(
      "Use valid IANA zones, for example America/Chicago or Europe/London.",
    );
  }
}
function instant(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new InputError("Use an ISO timestamp with Z or a numeric offset.");
  date(value.slice(0, 10));
  return Date.parse(value);
}
const formatter = (z: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: z,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
export const timezones: Feature = {
  render: (e) =>
    `${label(e)}\n${(e.data.zones as string[]).join("\n")}\nUse convert or overlap; help shows examples.`,
  id: "timezones",
  title: "Timezone meeting planner",
  description:
    "Save groups of timezones, convert exact instants and find weekday working-hour overlap.",
  help: "create Team | America/Chicago, Europe/London\nconvert <id> | 2026-09-07T15:00:00Z\noverlap <id> | 2026-09-07T00:00:00Z | 60 | 9 | 17\nOverlap fields: start instant, meeting minutes, local start hour, local end hour. Search covers 48 hours.\nzone <id> | Asia/Tokyo\nremove-zone <id> | Asia/Tokyo | confirm",
  run(entries, verb, args, now) {
    if (verb === "create") {
      const [title, raw] = parts(args, 2),
        zones = [...new Set(raw.split(",").map((v) => zone(v.trim())))];
      if (zones.length > 8)
        throw new InputError("Use at most eight timezones.");
      return label(add(entries, title, zones.join(", "), now, { zones }));
    }
    if (["zone", "remove-zone"].includes(verb)) {
      const [id, value, confirm] = parts(args, verb === "zone" ? 2 : 3),
        e = find(entries, id),
        z = zone(value),
        zones = e.data.zones as string[];
      if (verb === "zone") {
        if (zones.includes(z))
          throw new InputError("Timezone already in this group.");
        if (zones.length >= 8)
          throw new InputError("Use at most eight timezones.");
        zones.push(z);
      } else {
        if (confirm !== "confirm")
          throw new InputError("Removal needs | confirm.");
        if (!zones.includes(z) || zones.length === 1)
          throw new InputError(
            "Keep at least one timezone; choose one in this group.",
          );
        e.data.zones = zones.filter((v) => v !== z);
      }
      e.body = (e.data.zones as string[]).join(", ");
      touch(e, now);
      return label(e) + "\n" + e.body;
    }
    if (verb === "convert") {
      const [id, value] = parts(args, 2),
        e = find(entries, id),
        ms = instant(value);
      return (e.data.zones as string[])
        .map((z) => z + ": " + formatter(z).format(ms))
        .join("\n");
    }
    if (verb === "overlap") {
      const [id, value, durationText, startText, endText] = parts(args, 5),
        e = find(entries, id),
        from = instant(value),
        duration = number(durationText, 30, 240),
        start = number(startText, 0, 23),
        end = number(endText, 1, 24);
      if (
        duration % 30 ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start >= end
      )
        throw new InputError(
          "Use 30-minute duration increments and whole daytime hours with start before end.",
        );
      const formats = (e.data.zones as string[]).map((z) => ({
          z,
          fmt: formatter(z),
        })),
        slots: number[] = [];
      const allowed = (ms: number) =>
        formats.every(({ fmt }) => {
          const p = Object.fromEntries(
            fmt.formatToParts(ms).map((p) => [p.type, p.value]),
          );
          return (
            !["Sat", "Sun"].includes(p.weekday) &&
            Number(p.hour) * 60 + Number(p.minute) >= start * 60 &&
            Number(p.hour) * 60 + Number(p.minute) < end * 60
          );
        });
      for (
        let ms = from;
        ms + duration * 60000 <= from + 48 * 3600000;
        ms += 1800000
      ) {
        let valid = true;
        for (let offset = 0; offset < duration; offset += 30)
          if (!allowed(ms + offset * 60000)) {
            valid = false;
            break;
          }
        if (valid && allowed(ms + duration * 60000 - 1)) slots.push(ms);
      }
      return slots.length
        ? `${slots.length} matching starts; first 10 shown (no holidays excluded):\n${slots
            .slice(0, 10)
            .map(
              (ms) =>
                new Date(ms).toISOString() +
                "\n" +
                formats
                  .map(({ z, fmt }) => z + ": " + fmt.format(ms))
                  .join("\n"),
            )
            .join("\n\n")}\nNo invitations sent.`
        : "No shared weekday working window in the next 48 hours. Try another start date or wider hours.";
    }
  },
};
