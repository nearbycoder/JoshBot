import { getOwnedSchedule, getUserScheduleDashboardItems } from "./schedules.js";
import { renderWidget, saveWidget, type WidgetTarget, type WidgetBlock } from "./slack-widgets.js";

export async function getReminderCards(target: WidgetTarget) {
  const items = await getUserScheduleDashboardItems(target.userId, 5);
  const blocks: WidgetBlock[] = [];
  for (const item of items) {
    const schedule = await getOwnedSchedule(item.id, target.userId);
    const card = await saveWidget({ target, kind: "reminder", title: "Your reminder", text: schedule.task,
      schedule: { id: schedule.id, summary: schedule.summary, nextRunAt: schedule.nextRunAt,
        timeZone: schedule.timezone, channelId: schedule.channel } });
    if (card) blocks.push(...renderWidget(card));
  }
  return { text: items.length ? "Your active reminders (up to five, earliest first)." : "No active reminders. Use /nobo-reminder to create one.",
    blocks: blocks.slice(0, 50) };
}
