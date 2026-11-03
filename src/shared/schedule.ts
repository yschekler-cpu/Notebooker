/**
 * Prochain déclenchement local à HH:MM un des jours `days` (0 = dimanche … 6 = samedi).
 * Retourne null si aucun jour n'est sélectionné.
 */
export function nextRun(time: string, days: number[], from: Date = new Date()): Date | null {
  if (days.length === 0) return null;
  const [hh, mm] = parseTime(time);
  const candidate = new Date(from);
  candidate.setHours(hh, mm, 0, 0);
  if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
  for (let i = 0; i < 8 && !days.includes(candidate.getDay()); i++) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

/**
 * Rattrapage : Chrome était fermé à l'heure prévue. On relance si le dernier run réussi
 * est antérieur au créneau du jour et qu'on est encore dans la fenêtre (avant midi).
 */
export function shouldCatchUp(
  time: string,
  days: number[],
  lastSuccessAt: Date | null,
  now: Date = new Date(),
  catchUpUntilHour = 12,
): boolean {
  if (!days.includes(now.getDay())) return false;
  const [hh, mm] = parseTime(time);
  const slot = new Date(now);
  slot.setHours(hh, mm, 0, 0);
  // Fenêtre de rattrapage : jusqu'à midi, ou 4 h après le créneau s'il est l'après-midi.
  const limit = Math.max(catchUpUntilHour, hh + 4);
  if (now < slot || now.getHours() >= limit) return false;
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

export function formatDateFR(d: Date = new Date()): string {
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/** Date locale AAAA-MM-JJ (clé de jour pour la mémoire et les échéances). */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const DAY_LABELS = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
