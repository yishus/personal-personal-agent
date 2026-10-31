import { Cron } from "croner";

export function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function nextCronDate(
  cron: string,
  timezone: string,
  after = new Date()
): Date {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new Error(
      "Use a five-field cron expression (minute hour day month weekday)."
    );
  }
  // No timer is started: Durable Object alarms handle execution.
  const next = new Cron(cron, { timezone, paused: true }).nextRun(after);
  if (!next) throw new Error("This schedule has no future occurrence.");
  return next;
}

export function scheduledDate(date: string, now = new Date()): Date {
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(date)) {
    throw new Error(
      "Include a timezone offset in the ISO date, for example +08:00."
    );
  }
  const parsed = new Date(date);
  if (!Number.isFinite(parsed.getTime()) || parsed <= now) {
    throw new Error("The scheduled date must be in the future.");
  }
  return parsed;
}
