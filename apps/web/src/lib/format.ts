function safeTz(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export function formatDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: safeTz(tz) }).format(new Date(iso));
}

export function formatTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: safeTz(tz) }).format(new Date(iso));
}

export function formatDateTime(iso: string | null, tz: string): string {
  if (!iso) return "Not specified";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: safeTz(tz),
    timeZoneName: "short",
  }).format(new Date(iso));
}

export function tzAbbrev(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: safeTz(tz), timeZoneName: "short" }).formatToParts(new Date(iso));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
}

export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Converts a value from <input type="datetime-local"> (browser local time) to ISO UTC. */
export function localInputToIso(value: string): string {
  return new Date(value).toISOString();
}
