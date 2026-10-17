/**
 * Время суток с учётом UTC/GMT: если системный часовой пояс не определён
 * или это UTC — часы берутся прямо из GMT (getUTCHours), иначе локальные.
 * Периоды: утро 5–12, день 12–18, вечер 18–23, ночь — остальное.
 */

export type DayPeriod = "morning" | "afternoon" | "evening" | "night";

let cachedTimeZone: string | null = null;

function getTimeZone(): string {
  if (cachedTimeZone !== null) return cachedTimeZone;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    cachedTimeZone = tz || "UTC";
  } catch {
    cachedTimeZone = "UTC";
  }
  return cachedTimeZone;
}

export function dayPeriod(d: Date = new Date()): DayPeriod {
  let hour: number;
  const tz = getTimeZone();
  if (tz === "UTC") {
    hour = d.getUTCHours();
  } else {
    try {
      hour = d.getHours();
    } catch {
      hour = d.getUTCHours();
    }
  }
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  // Ночь: 23, 0, 1, 2, 3, 4
  return "night";
}

/** Локальный day-key "YYYY-MM-DD" (не UTC) — единый для журнала использования,
    тепловой карты и стриков */
export function dayKeyLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}


