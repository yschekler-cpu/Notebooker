/** Calcule le prochain déclenchement local pour une heure HH:MM (optionnellement jours ouvrés). */
export function nextDailyRun(time: string, weekdaysOnly: boolean, from: Date = new Date()): Date {
  const [hh, mm] = parseTime(time);
  const candidate = new Date(from);
  candidate.setHours(hh, mm, 0, 0);
  if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
  while (weekdaysOnly && isWeekend(candidate)) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

/**
 * Rattrapage : Chrome était fermé à l'heure prévue. On relance si le dernier run réussi
 * est antérieur au créneau du jour et qu'on est encore dans la fenêtre (avant midi).
 */
export function shouldCatchUp(
  time: string,
  weekdaysOnly: boolean,
  lastSuccessAt: Date | null,
  now: Date = new Date(),
  catchUpUntilHour = 12,
): boolean {
  if (weekdaysOnly && isWeekend(now)) return false;
  const [hh, mm] = parseTime(time);
  const slot = new Date(now);
  slot.setHours(hh, mm, 0, 0);
  if (now < slot || now.getHours() >= catchUpUntilHour) return false;
  return !lastSuccessAt || lastSuccessAt < slot;
}

export function isDue(lastCheckedAt: string | null, refreshMinutes: number, now: Date = new Date()): boolean {
  if (!lastCheckedAt) return true;
  if (refreshMinutes <= 0) return false;
  return now.getTime() - new Date(lastCheckedAt).getTime() >= refreshMinutes * 60_000;
}

function parseTime(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) throw new Error(`Heure invalide: ${time}`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error(`Heure invalide: ${time}`);
  return [hh, mm];
}

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

export function formatDateFR(d: Date = new Date()): string {
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
