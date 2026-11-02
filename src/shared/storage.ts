import type { BriefingRun, Folder, NotebookMeta, Settings, Subscription } from "./types";

/**
 * Règle de stockage :
 * - chrome.storage.sync  → données non sensibles (dossiers, tags) synchronisées entre postes.
 * - chrome.storage.local → secrets (tokens Notion, clé Claude) + état volumineux. Jamais synchronisé.
 */

export const DEFAULT_SETTINGS: Settings = {
  briefing: {
    enabled: false,
    time: "07:30",
    weekdaysOnly: true,
    lookbackHours: 24,
    gmailQuery: "in:inbox -category:promotions -category:social",
    gmailMaxMessages: 40,
    gmailExclusions: [],
    notebookTitleTemplate: "☀️ Brief du {date}",
    audioInstructions:
      "Podcast en français, 8-10 minutes. Commence par les 3 sujets les plus urgents (décisions attendues, deadlines du jour), puis les mises à jour projets, puis le reste. Ton factuel, pas de remplissage.",
    retentionDays: 7,
  },
  notion: {
    personal: { label: "Notion perso", token: "", briefingRootIds: [] },
    company: { label: "Notion entreprise", token: "", briefingRootIds: [] },
  },
  claude: {
    enabled: false,
    authMode: "api_key",
    apiKey: "",
    oauthToken: "",
    model: "claude-opus-5-5",
    redactPII: true,
    redactAmounts: false,
  },
  notebooklm: { accountIndex: 0, backgroundTabs: true },
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    return (patch === undefined ? base : patch) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (patch && typeof patch === "object") {
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      out[k] = k in out ? deepMerge(out[k], v) : v;
    }
  }
  return out as T;
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return deepMerge(DEFAULT_SETTINGS, settings);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

// ─── Organisation (sync) ──────────────────────────────────────────────────────

export async function getFolders(): Promise<Folder[]> {
  const { folders } = await chrome.storage.sync.get("folders");
  return ((folders as Folder[] | undefined) ?? []).sort((a, b) => a.order - b.order);
}

export async function saveFolders(folders: Folder[]): Promise<void> {
  await chrome.storage.sync.set({ folders });
}

/**
 * Les métadonnées sont stockées une clé par notebook (`nb:<id>`) pour rester sous
 * la limite de 8 Ko par item de chrome.storage.sync.
 */
export async function getNotebookMetas(): Promise<Record<string, NotebookMeta>> {
  const all = await chrome.storage.sync.get(null);
  const out: Record<string, NotebookMeta> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("nb:")) out[k.slice(3)] = v as NotebookMeta;
  }
  return out;
}

export async function upsertNotebookMeta(
  notebookId: string,
  patch: Partial<NotebookMeta>,
): Promise<NotebookMeta> {
  const key = `nb:${notebookId}`;
  const current = (await chrome.storage.sync.get(key))[key] as NotebookMeta | undefined;
  const next: NotebookMeta = {
    notebookId,
    title: "",
    folderId: null,
    tags: [],
    pinned: false,
    lastSeenAt: new Date().toISOString(),
    ...current,
    ...patch,
  };
  await chrome.storage.sync.set({ [key]: next });
  return next;
}

export async function removeNotebookMeta(notebookId: string): Promise<void> {
  await chrome.storage.sync.remove(`nb:${notebookId}`);
}

// ─── Abonnements & runs (local) ───────────────────────────────────────────────

export async function getSubscriptions(): Promise<Subscription[]> {
  const { subscriptions } = await chrome.storage.local.get("subscriptions");
  return (subscriptions as Subscription[] | undefined) ?? [];
}

export async function saveSubscriptions(subscriptions: Subscription[]): Promise<void> {
  await chrome.storage.local.set({ subscriptions });
}

export async function updateSubscription(id: string, patch: Partial<Subscription>): Promise<void> {
  const subs = await getSubscriptions();
  await saveSubscriptions(subs.map((s) => (s.id === id ? { ...s, ...patch } : s)));
}

const MAX_RUNS = 30;

export async function getBriefingRuns(): Promise<BriefingRun[]> {
  const { briefingRuns } = await chrome.storage.local.get("briefingRuns");
  return (briefingRuns as BriefingRun[] | undefined) ?? [];
}

export async function saveBriefingRun(run: BriefingRun): Promise<void> {
  const runs = (await getBriefingRuns()).filter((r) => r.id !== run.id);
  runs.unshift(run);
  await chrome.storage.local.set({ briefingRuns: runs.slice(0, MAX_RUNS) });
}

export function uid(): string {
  return crypto.randomUUID();
}
