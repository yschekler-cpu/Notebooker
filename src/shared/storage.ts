import { defaultProfile, migrateRawSettings, normalizeProfile } from "./profiles";
import type { ActionItem, BriefingRun, BriefMemory, Folder, NotebookMeta, NotionOAuthState, Settings, Subscription } from "./types";

/**
 * Règle de stockage :
 * - chrome.storage.sync  → données non sensibles (dossiers, tags) synchronisées entre postes.
 * - chrome.storage.local → secrets (tokens Notion, clé Claude) + état volumineux. Jamais synchronisé.
 */

export function emptyOAuth(): NotionOAuthState {
  return { clientId: "", clientSecret: "", accessToken: "", refreshToken: "", workspaceName: "", workspaceId: "", botId: "", connectedAt: null };
}

export const DEFAULT_SETTINGS: Settings = {
  profiles: [defaultProfile()],
  localInbox: { path: "", pollMinutes: 10 },
  compliance: { gmailExclusions: [] },
  calendar: { calendarIds: ["primary"], hidePrivateEvents: true, skipDeclined: true },
  backlog: { workspace: "company", databaseId: "", defaultStatus: "" },
  notion: {
    personal: { label: "Notion perso", authMode: "token", token: "", oauth: emptyOAuth(), briefingRootIds: [] },
    company: { label: "Notion entreprise", authMode: "token", token: "", oauth: emptyOAuth(), briefingRootIds: [] },
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
  return resolveSettings(settings as Record<string, unknown> | undefined);
}

/** Migration + valeurs par défaut + normalisation des profils (pur, testable). */
export function resolveSettings(raw: Record<string, unknown> | undefined): Settings {
  const merged = deepMerge(DEFAULT_SETTINGS, migrateRawSettings(raw));
  const profiles = Array.isArray(merged.profiles) && merged.profiles.length ? merged.profiles : DEFAULT_SETTINGS.profiles;
  const ids = new Set<string>();
  merged.profiles = profiles.map((p) => normalizeProfile(p)).filter((p) => !ids.has(p.id) && ids.add(p.id));
  return merged;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

let settingsChain: Promise<unknown> = Promise.resolve();

/**
 * Modification sérialisée des réglages depuis le service worker (ex. jetons OAuth renouvelés) :
 * relit l'état courant juste avant d'écrire, pour ne jamais écraser une modification concurrente.
 */
export function mutateSettings(fn: (s: Settings) => Settings): Promise<Settings> {
  const run = settingsChain.then(async () => {
    const next = fn(await getSettings());
    await saveSettings(next);
    return next;
  });
  settingsChain = run.catch(() => undefined);
  return run;
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

let subsChain: Promise<unknown> = Promise.resolve();

/**
 * Lecture-modification-écriture sérialisée des abonnements (dans un même contexte d'exécution) :
 * évite qu'une mise à jour concurrente écrase un abonnement ajouté ou des clés « vues ».
 */
export function mutateSubscriptions<T>(fn: (subs: Subscription[]) => { subs: Subscription[]; result: T } | Subscription[]): Promise<T | undefined> {
  const run = subsChain.then(async () => {
    const out = fn(await getSubscriptions());
    const { subs, result } = Array.isArray(out) ? { subs: out, result: undefined } : out;
    await saveSubscriptions(subs);
    return result;
  });
  subsChain = run.catch(() => undefined);
  return run;
}

export async function updateSubscription(id: string, patch: Partial<Subscription>): Promise<void> {
  await mutateSubscriptions((subs) => subs.map((s) => (s.id === id ? { ...s, ...patch } : s)));
}

export async function getSubscription(id: string): Promise<Subscription | undefined> {
  return (await getSubscriptions()).find((s) => s.id === id);
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

// ─── Actions à valider (local) ────────────────────────────────────────────────

const MAX_ACTIONS = 300;
let actionsChain: Promise<unknown> = Promise.resolve();

export async function getActions(): Promise<ActionItem[]> {
  const { actionItems } = await chrome.storage.local.get("actionItems");
  return (actionItems as ActionItem[] | undefined) ?? [];
}

/** Lecture-modification-écriture sérialisée de la file d'actions. */
export function mutateActions(fn: (items: ActionItem[]) => ActionItem[]): Promise<ActionItem[]> {
  const run = actionsChain.then(async () => {
    const next = fn(await getActions())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_ACTIONS);
    await chrome.storage.local.set({ actionItems: next });
    return next;
  });
  actionsChain = run.catch(() => undefined);
  return run;
}

// ─── Mémoire des briefs (local) ───────────────────────────────────────────────

export async function getMemory(profileId: string): Promise<BriefMemory> {
  const key = `briefMemory:${profileId}`;
  const v = (await chrome.storage.local.get(key))[key] as BriefMemory | undefined;
  return v ?? { lastBriefDate: null, previousBriefDate: null, topics: {} };
}

export async function saveMemory(profileId: string, memory: BriefMemory): Promise<void> {
  await chrome.storage.local.set({ [`briefMemory:${profileId}`]: memory });
}
