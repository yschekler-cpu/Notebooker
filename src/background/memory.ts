import type { BriefMemory, MemoryTopic } from "../shared/types";

/**
 * Mémoire des briefs : chaque sujet (fil Gmail, page Notion) est suivi jour après jour pour
 * étiqueter le brief « nouveau / toujours actif / calmé ». Purement déterministe (sans LLM) ;
 * le résultat est aussi transmis à Claude pour qu'il le reflète dans la synthèse.
 */

export const MEMORY_RETENTION_DAYS = 14;

export interface Observation {
  key: string;
  title: string;
  kind: MemoryTopic["kind"];
}

export interface MemoryDiff {
  fresh: MemoryTopic[];
  ongoing: MemoryTopic[];
  /** Actifs au brief précédent, sans activité depuis. */
  calmed: MemoryTopic[];
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Retire « Re: », « TR: », « Fwd: »… pour rattacher les réponses au même sujet. */
export function topicTitle(subject: string): string {
  return subject.replace(/^(\s*(re|tr|fw|fwd|réf|ref)\s*(\[\d+\])?\s*:\s*)+/i, "").trim() || subject;
}

export function updateMemory(prev: BriefMemory, observations: Observation[], today: string): { memory: BriefMemory; diff: MemoryDiff } {
  const topics: Record<string, MemoryTopic> = structuredClone(prev.topics);
  // Référence « brief précédent » : le dernier jour de brief strictement antérieur à aujourd'hui.
  const reference = prev.lastBriefDate && prev.lastBriefDate !== today ? prev.lastBriefDate : prev.previousBriefDate;
  const observedNow = new Set<string>();
  const fresh: MemoryTopic[] = [];
  const ongoing: MemoryTopic[] = [];

  for (const o of observations) {
    if (observedNow.has(o.key)) continue;
    observedNow.add(o.key);
    const t = topics[o.key];
    if (!t) {
      const created: MemoryTopic = { key: o.key, title: o.title, kind: o.kind, firstSeen: today, lastSeen: today, activeDays: 1 };
      topics[o.key] = created;
      fresh.push(created);
      continue;
    }
    if (t.lastSeen !== today) t.activeDays += 1; // re-run le même jour : pas de double comptage
    t.lastSeen = today;
    t.title = o.title;
    (t.firstSeen === today ? fresh : ongoing).push(t);
  }

  const calmed = reference
    ? Object.values(topics).filter((t) => !observedNow.has(t.key) && t.lastSeen === reference)
    : [];

  for (const [k, t] of Object.entries(topics)) {
    if (daysBetween(t.lastSeen, today) > MEMORY_RETENTION_DAYS) delete topics[k];
  }

  return {
    memory: {
      lastBriefDate: today,
      previousBriefDate: prev.lastBriefDate && prev.lastBriefDate !== today ? prev.lastBriefDate : prev.previousBriefDate,
      topics,
    },
    diff: {
      fresh,
      ongoing: ongoing.sort((a, b) => b.activeDays - a.activeDays),
      calmed,
    },
  };
}

export function memoryToMarkdown(diff: MemoryDiff): string {
  const line = (t: MemoryTopic, suffix = "") => `- ${t.kind === "mail" ? "[Mail]" : t.kind === "notion" ? "[Notion]" : "[Agenda]"} ${t.title}${suffix}`;
  const parts: string[] = [];
  if (diff.fresh.length) parts.push(`### 🆕 Nouveaux sujets (${diff.fresh.length})\n${diff.fresh.map((t) => line(t)).join("\n")}`);
  if (diff.ongoing.length) parts.push(`### 🔁 Toujours actifs (${diff.ongoing.length})\n${diff.ongoing.map((t) => line(t, ` — actif ${t.activeDays} jours`)).join("\n")}`);
  if (diff.calmed.length) parts.push(`### 💤 Sans nouvelle activité depuis le dernier brief (${diff.calmed.length})\n${diff.calmed.map((t) => line(t)).join("\n")}`);
  return parts.join("\n\n");
}
