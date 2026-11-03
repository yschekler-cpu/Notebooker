import type { AudioOptions, BriefProfile, Settings } from "./types";

/**
 * Profils de brief : modèle par défaut, normalisation (données stockées potentiellement
 * anciennes ou partielles) et migration du format v0.1 (`settings.briefing` unique).
 */

export const WEEKDAYS = [1, 2, 3, 4, 5];

export const DEFAULT_AUDIO: AudioOptions = {
  format: "deep_dive",
  length: "default",
  language: "fr",
  instructions:
    "Commence par les 3 sujets les plus urgents (décisions attendues, deadlines du jour), puis les réunions du jour, puis les mises à jour projets. Ton factuel, pas de remplissage.",
};

export function defaultProfile(id = "daily", name = "Brief du matin"): BriefProfile {
  return {
    id,
    name,
    enabled: false,
    schedule: { time: "07:30", days: [...WEEKDAYS] },
    lookbackHours: 24,
    sources: { gmail: true, calendar: true, notionPersonal: true, notionCompany: true },
    gmailQuery: "in:inbox -category:promotions -category:social",
    gmailMaxMessages: 40,
    notebookTitleTemplate: "☀️ Brief du {date}",
    audio: { ...DEFAULT_AUDIO },
    synthesisFocus: "",
    memory: true,
    extractActions: false,
    retentionDays: 7,
  };
}

/** Modèles prêts à l'emploi proposés à la création d'un profil. */
export const PROFILE_TEMPLATES: Record<string, () => Omit<BriefProfile, "id">> = {
  daily: () => {
    const { id: _id, ...p } = defaultProfile();
    return p;
  },
  weeklyCompliance: () => {
    const { id: _id, ...p } = defaultProfile("x", "Récap conformité (vendredi)");
    return {
      ...p,
      schedule: { time: "16:30", days: [5] },
      lookbackHours: 24 * 7,
      sources: { gmail: true, calendar: false, notionPersonal: false, notionCompany: true },
      notebookTitleTemplate: "🛡️ Conformité — semaine du {date}",
      synthesisFocus: "Angle conformité : KYC/KYD, LCB-FT, réclamations, incidents, échéances réglementaires (AMF, CSSF, FSMA, CONSOB). Ignore le reste.",
      audio: { ...DEFAULT_AUDIO, format: "brief", instructions: "Récap hebdomadaire conformité : points ouverts, risques, échéances de la semaine prochaine." },
      memory: true,
      retentionDays: 30,
    };
  },
  comex: () => {
    const { id: _id, ...p } = defaultProfile("x", "Digest Comex (lundi)");
    return {
      ...p,
      schedule: { time: "07:00", days: [1] },
      lookbackHours: 24 * 7,
      sources: { gmail: false, calendar: false, notionPersonal: false, notionCompany: true },
      notebookTitleTemplate: "📊 Digest Comex — {date}",
      synthesisFocus: "Angle Comex : décisions à prendre, risques, avancement roadmap, KPI. Pas de détail opérationnel ni de donnée nominative.",
      audio: { ...DEFAULT_AUDIO, format: "brief", length: "short", instructions: "Synthèse exécutive : décisions, risques, avancement. 5 minutes maximum." },
      memory: false,
      retentionDays: 30,
    };
  },
};

const AUDIO_FORMATS = ["deep_dive", "brief", "critique", "debate"] as const;
const AUDIO_LENGTHS = ["short", "default", "long"] as const;

/** Fusionne un profil stocké (potentiellement partiel / ancien) avec les valeurs par défaut. */
export function normalizeProfile(raw: Partial<BriefProfile> & { id?: string }): BriefProfile {
  const d = defaultProfile(raw.id || crypto.randomUUID(), raw.name || "Brief");
  const days = Array.isArray(raw.schedule?.days) ? raw.schedule!.days.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6) : d.schedule.days;
  const audio = { ...d.audio, ...(raw.audio ?? {}) };
  if (!AUDIO_FORMATS.includes(audio.format)) audio.format = d.audio.format;
  if (!AUDIO_LENGTHS.includes(audio.length)) audio.length = d.audio.length;
  return {
    ...d,
    ...raw,
    id: d.id,
    name: (raw.name ?? d.name).slice(0, 60) || d.name,
    schedule: { time: /^\d{1,2}:\d{2}$/.test(raw.schedule?.time ?? "") ? raw.schedule!.time : d.schedule.time, days: Array.from(new Set(days)).sort() },
    sources: { ...d.sources, ...(raw.sources ?? {}) },
    audio,
  };
}

interface LegacyBriefing {
  enabled?: boolean;
  time?: string;
  weekdaysOnly?: boolean;
  lookbackHours?: number;
  gmailQuery?: string;
  gmailMaxMessages?: number;
  gmailExclusions?: string[];
  notebookTitleTemplate?: string;
  audioInstructions?: string;
  retentionDays?: number;
}

/**
 * Migration v0.1 → v0.2 : `settings.briefing` devient le profil « daily »,
 * `briefing.gmailExclusions` devient `compliance.gmailExclusions` (commun à tous les profils).
 * Idempotente : sans `briefing`, rien ne change.
 */
export function migrateRawSettings(raw: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!raw || !raw.briefing || raw.profiles) return raw;
  const b = raw.briefing as LegacyBriefing;
  const profile = normalizeProfile({
    id: "daily",
    name: "Brief du matin",
    enabled: b.enabled ?? false,
    schedule: { time: b.time ?? "07:30", days: b.weekdaysOnly === false ? [0, 1, 2, 3, 4, 5, 6] : [...WEEKDAYS] },
    lookbackHours: b.lookbackHours ?? 24,
    gmailQuery: b.gmailQuery,
    gmailMaxMessages: b.gmailMaxMessages,
    notebookTitleTemplate: b.notebookTitleTemplate,
    retentionDays: b.retentionDays,
    audio: { ...DEFAULT_AUDIO, ...(b.audioInstructions ? { instructions: b.audioInstructions } : {}) },
  } as Partial<BriefProfile>);
  const { briefing: _drop, ...rest } = raw;
  const compliance = (rest.compliance as Settings["compliance"] | undefined) ?? { gmailExclusions: [] };
  return {
    ...rest,
    profiles: [profile],
    compliance: { ...compliance, gmailExclusions: Array.from(new Set([...(compliance.gmailExclusions ?? []), ...(b.gmailExclusions ?? [])])) },
  };
}
