import type { BriefMemory, MemoryTopic } from "../shared/types";
import { SECTIONS, type InboxTopic, type TopicSection } from "./localInbox";
import { MEMORY_RETENTION_DAYS } from "./memory";

/**
 * Diff quotidien des sujets (mode dossier local).
 *
 * Objectif : chaque brief est un UPDATE, jamais une redite. Même si l'agent amont (Claude Cowork)
 * répète un sujet à l'identique, l'extension le détecte par empreinte de contenu et le réduit à
 * une ligne. Seuls les sujets nouveaux ou réellement modifiés sont développés dans le podcast.
 */

export interface TopicDiff {
  /** Jamais vus. */
  fresh: { topic: InboxTopic; memory: MemoryTopic }[];
  /** Déjà suivis, contenu modifié depuis le dernier brief. */
  changed: { topic: InboxTopic; memory: MemoryTopic }[];
  /** Déjà suivis, contenu identique → une ligne, pas de redite. */
  unchanged: { topic: InboxTopic; memory: MemoryTopic }[];
  /** Déclarés résolus (première fois). */
  resolved: { topic: InboxTopic; memory: MemoryTopic }[];
  /** Mentionnés au brief précédent, absents aujourd'hui. */
  dropped: MemoryTopic[];
  /**
   * Inchangés mais à rappeler : échéance aujourd'hui ou dépassée, ou priorité haute sur une tâche /
   * un point d'attention. Une ligne chacun — ce n'est pas une redite, c'est le rappel du jour.
   */
  reminders: { topic: InboxTopic; memory: MemoryTopic }[];
}

/** Empreinte stable (FNV-1a 32 bits) du contenu normalisé : insensible à la casse, aux espaces et à la ponctuation. */
export function fingerprint(text: string): string {
  const norm = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function diffTopics(prev: BriefMemory, topics: InboxTopic[], today: string): { diff: TopicDiff; memory: BriefMemory } {
  const memTopics: Record<string, MemoryTopic> = structuredClone(prev.topics);
  const reference = prev.lastBriefDate && prev.lastBriefDate !== today ? prev.lastBriefDate : prev.previousBriefDate;
  const diff: TopicDiff = { fresh: [], changed: [], unchanged: [], resolved: [], dropped: [], reminders: [] };
  const seen = new Set<string>();

  for (const topic of topics) {
    const key = `topic:${topic.key}`;
    seen.add(key);
    const fp = fingerprint(`${topic.summary}`);
    const m = memTopics[key];
    if (!m) {
      const created: MemoryTopic = { key, title: topic.title, kind: "notion", firstSeen: today, lastSeen: today, activeDays: 1, fingerprint: fp, lastChanged: today, resolved: topic.status === "resolved" };
      memTopics[key] = created;
      // Résolu dès sa première apparition : simple mention
      (topic.status === "resolved" ? diff.resolved : diff.fresh).push({ topic, memory: created });
      continue;
    }
    if (m.lastSeen !== today) m.activeDays += 1; // re-run le même jour : pas de double comptage
    m.lastSeen = today;
    m.title = topic.title;

    if (topic.status === "resolved") {
      if (!m.resolved) diff.resolved.push({ topic, memory: m }); // annoncé une seule fois
      m.resolved = true;
      m.fingerprint = fp;
      continue;
    }
    m.resolved = false;
    if (m.firstSeen === today) {
      // Créé aujourd'hui (re-run) : reste « nouveau »
      m.fingerprint = fp;
      diff.fresh.push({ topic, memory: m });
    } else if (m.fingerprint !== fp) {
      m.fingerprint = fp;
      m.lastChanged = today;
      diff.changed.push({ topic, memory: m });
    } else if ((topic.due && topic.due <= today) || (topic.priority === "haute" && (topic.section === "tasks" || topic.section === "attention"))) {
      diff.reminders.push({ topic, memory: m });
    } else {
      diff.unchanged.push({ topic, memory: m });
    }
  }

  if (reference) {
    diff.dropped = Object.values(memTopics).filter((t) => t.key.startsWith("topic:") && !seen.has(t.key) && t.lastSeen === reference && !t.resolved);
  }
  for (const [k, t] of Object.entries(memTopics)) {
    if (daysBetween(t.lastSeen, today) > MEMORY_RETENTION_DAYS) delete memTopics[k];
  }

  return {
    diff,
    memory: {
      lastBriefDate: today,
      previousBriefDate: prev.lastBriefDate && prev.lastBriefDate !== today ? prev.lastBriefDate : prev.previousBriefDate,
      topics: memTopics,
    },
  };
}

export function hasNews(d: TopicDiff, today?: string): boolean {
  // Une échéance du jour justifie à elle seule un brief ; une simple priorité haute inchangée, non.
  const dueToday = today ? d.reminders.some(({ topic }) => topic.due && topic.due <= today) : false;
  return d.fresh.length + d.changed.length + d.resolved.length > 0 || dueToday;
}

function fr(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
}

function refs(t: InboxTopic): string {
  return t.refs.length ? `\n_Sources : ${t.refs.join(" · ")}_` : "";
}

const SECTION_HEADINGS: Record<TopicSection, string> = {
  company: "🌐 Vue 360 — ce qui se passe chez Opale",
  tasks: "✅ Mes tâches & demandes à traiter",
  projects: "🚀 Produit & Tech — avancement des développements",
  attention: "⚠️ Points d'attention",
  other: "📌 Autres sujets",
};

const PRIO: Record<string, string> = { haute: "🔴 priorité haute", moyenne: "🟠 priorité moyenne", basse: "🟢 priorité basse" };

function meta(t: InboxTopic, today?: string): string {
  const bits = [
    t.priority ? PRIO[t.priority] : "",
    t.due ? `${today && t.due < today ? "⏰ en retard — " : today && t.due === today ? "⏰ " : ""}échéance ${fr(t.due)}` : "",
    t.owner ?? "",
  ].filter(Boolean);
  return bits.length ? `\n_${bits.join(" · ")}_` : "";
}

/**
 * Source principale du podcast, ordonnée : vue 360 → tâches → produit & tech → points d'attention.
 * Uniquement ce qui est nouveau, modifié, résolu, ou à rappeler aujourd'hui (échéance / priorité haute).
 */
export function newsToMarkdown(d: TopicDiff, today?: string): string {
  const parts: string[] = [];
  for (const section of SECTIONS) {
    const inSection = (x: { topic: InboxTopic }) => (x.topic.section ?? "other") === section;
    const fresh = d.fresh.filter(inSection);
    const changed = d.changed.filter(inSection);
    const reminders = d.reminders.filter(inSection);
    if (!fresh.length && !changed.length && !reminders.length) continue;
    const blocks = [
      ...fresh.map(({ topic }) => `### 🆕 ${topic.title}${meta(topic, today)}\n${topic.summary}${refs(topic)}`),
      ...changed.map(({ topic, memory }) => `### 🔄 ${topic.title} — suivi depuis le ${fr(memory.firstSeen)} (${memory.activeDays} jours)${meta(topic, today)}\n${topic.summary}${refs(topic)}`),
    ];
    if (reminders.length) {
      blocks.push(`**⏰ Rappels du jour (sans changement depuis le ${fr(reminders[0]!.memory.lastChanged ?? reminders[0]!.memory.firstSeen)}) :**\n${reminders.map(({ topic }) => `- ${topic.title}${meta(topic, today).replace(/\n_|_$/g, " ").trimEnd()}`).join("\n")}`);
    }
    parts.push(`## ${SECTION_HEADINGS[section]}\n\n${blocks.join("\n\n")}`);
  }
  if (d.resolved.length) {
    parts.push(`## ✔️ Résolus\n\n${d.resolved.map(({ topic }) => `- **${topic.title}**${topic.summary ? ` — ${topic.summary.split("\n")[0]}` : ""}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Source secondaire : état des sujets ouverts sans nouveauté, en une ligne chacun (aucune redite). */
export function followUpToMarkdown(d: TopicDiff): string {
  const parts: string[] = [];
  if (d.unchanged.length) {
    parts.push(
      `## ⏸️ Toujours ouverts, sans nouveauté\n\n${d.unchanged
        .map(({ topic, memory }) => `- ${topic.title} — ouvert depuis le ${fr(memory.firstSeen)}, dernier changement le ${fr(memory.lastChanged ?? memory.firstSeen)}`)
        .join("\n")}`,
    );
  }
  if (d.dropped.length) {
    parts.push(`## 💤 Plus mentionnés depuis le dernier brief\n\n${d.dropped.map((t) => `- ${t.title}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Structure de lecture : vue 360 en introduction, puis plongée dans la journée du PM. */
export const STRUCTURE_INSTRUCTIONS =
  "Structure : (1) en introduction, une vue 360 rapide de ce qui se passe chez Opale (2 minutes maximum) ; " +
  "(2) puis plonge dans ma journée : réunions du jour, mes tâches et demandes à traiter (échéances du jour en premier), " +
  "l'avancement des développements et des gros projets, et termine par les points d'attention.";

/** Consigne ajoutée aux animateurs du podcast : un update, pas un récapitulatif. */
export const NO_REPEAT_INSTRUCTIONS =
  "C'est un point d'avancement quotidien, pas un récapitulatif : développe uniquement les nouveaux sujets et ce qui a changé. " +
  "Les sujets « sans nouveauté » se citent en une phrase groupée à la fin, sans les réexpliquer.";
