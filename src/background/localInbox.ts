import type { AudioOptions, Settings } from "../shared/types";
import { parseActions, type ExtractedAction } from "./claude";

/**
 * Mode « Dossier local » : Claude Cowork (session planifiée) agrège Gmail / Agenda / Notion et
 * écrit des fichiers dans un dossier du poste ; l'extension les lit (file://), les pousse dans
 * NotebookLM et génère le podcast. Aucun connecteur côté extension.
 *
 * Contrat (manifest JSON, version 1) — voir docs/COWORK-PROMPT.md :
 * {
 *   "format": "notebooker-brief", "version": 1,
 *   "id": "2026-11-03-daily",            // unique par brief : l'extension ne traite jamais 2 fois le même id
 *   "generatedAt": "2026-11-03T06:55:00+01:00",
 *   "title": "☀️ Brief du 3 novembre",   // optionnel
 *   "topics": [                          // recommandé : sujets suivis jour après jour (diff)
 *     { "key": "kyc-italie", "title": "KYC Italie", "status": "updated",
 *       "summary": "Markdown : ce qui a CHANGÉ depuis le dernier brief", "refs": ["[Mail: …]"] }
 *   ],
 *   "sources": [ { "title": "Agenda du jour", "file": "2026-11-03/agenda.md" } ],  // fichiers libres
 *   "audio": { "instructions": "…" },     // optionnel : surcharge du profil
 *   "actions": [ … ]                      // optionnel : même schéma que l'extraction Claude
 * }
 */

export const MAX_FILE_CHARS = 300_000;
export const MAX_SOURCES = 20;
export const MAX_TOPICS = 80;

export type TopicStatus = "new" | "updated" | "ongoing" | "resolved";

export interface InboxTopic {
  key: string;
  title: string;
  status: TopicStatus;
  summary: string;
  refs: string[];
}

export interface InboxSourceRef {
  title: string;
  /** Chemin RELATIF au dossier (ex. « 2026-11-03/agenda.md ») ou texte inline. */
  file?: string;
  text?: string;
}

export interface InboxManifest {
  id: string;
  generatedAt: string;
  title?: string;
  topics: InboxTopic[];
  sources: InboxSourceRef[];
  audio?: Partial<AudioOptions>;
  actions: ExtractedAction[];
}

// ─── Chemins ──────────────────────────────────────────────────────────────────

/**
 * Chemin absolu du dossier (macOS / Linux / Windows) → URL file:// terminée par « / ».
 * « ~ » est refusé : l'extension ne connaît pas le dossier personnel de l'utilisateur.
 */
export function folderToFileUrl(path: string): string {
  let p = path.trim().replace(/^file:\/\//i, "");
  if (!p) throw new Error("Dossier local non renseigné (Réglages › Dossier local).");
  if (p.startsWith("~")) throw new Error("Indique le chemin complet du dossier (ex. /Users/prenom/Notebooker), « ~ » n'est pas interprété.");
  p = p.replace(/\\/g, "/");
  const win = /^[a-zA-Z]:\//.test(p);
  if (!win && !p.startsWith("/")) throw new Error("Le chemin du dossier doit être absolu (ex. /Users/prenom/Notebooker ou C:\\Users\\prenom\\Notebooker).");
  const segments = p.split("/").filter((s, i) => s !== "" || i === 0);
  const encoded = segments.map((s, i) => (win && i === 0 ? s : encodeURIComponent(decodeURIComponentSafe(s)))).join("/");
  return `file://${win ? "/" : ""}${encoded.replace(/\/+$/, "")}/`;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Résout un chemin relatif du manifest ; refuse toute sortie du dossier (« .. », absolu, schéma). */
export function resolveInboxFile(baseUrl: string, rel: string): string {
  const clean = rel.trim().replace(/\\/g, "/");
  if (!clean || clean.startsWith("/") || /^[a-z]+:/i.test(clean) || clean.split("/").some((s) => s === ".." || s === ".")) {
    throw new Error(`Chemin refusé dans le manifest : « ${rel} » (relatif au dossier uniquement, sans « .. »).`);
  }
  if (!/\.(md|markdown|txt)$/i.test(clean)) throw new Error(`Type de fichier refusé : « ${rel} » (.md ou .txt uniquement).`);
  return baseUrl + clean.split("/").map((s) => encodeURIComponent(s)).join("/");
}

// ─── Validation du manifest ───────────────────────────────────────────────────

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const TOPIC_STATUSES: TopicStatus[] = ["new", "updated", "ongoing", "resolved"];

/** Clé de sujet stable et sûre (sert de clé de mémoire). */
export function topicKey(raw: string, fallbackTitle: string): string {
  const base = (raw || fallbackTitle)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return base.slice(0, 80);
}

export function parseManifest(json: string): InboxManifest {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error("Manifest illisible : JSON invalide.");
  }
  if (data.format !== "notebooker-brief" || data.version !== 1) throw new Error("Manifest non reconnu (attendu : format « notebooker-brief », version 1).");
  const id = str(data.id, 120);
  if (!id) throw new Error("Manifest sans « id ».");
  const generatedAt = str(data.generatedAt, 40);
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("Manifest : « generatedAt » doit être une date ISO 8601.");

  const topics: InboxTopic[] = [];
  const seenKeys = new Set<string>();
  for (const t of (Array.isArray(data.topics) ? data.topics : []).slice(0, MAX_TOPICS) as Record<string, unknown>[]) {
    const title = str(t?.title, 200);
    const key = topicKey(str(t?.key, 120), title);
    if (!title || !key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    topics.push({
      key,
      title,
      status: TOPIC_STATUSES.includes(t.status as TopicStatus) ? (t.status as TopicStatus) : "updated",
      summary: str(t.summary, 20_000),
      refs: Array.isArray(t.refs) ? t.refs.map((r) => str(r, 200)).filter(Boolean).slice(0, 10) : [],
    });
  }

  const sources: InboxSourceRef[] = [];
  for (const s of (Array.isArray(data.sources) ? data.sources : []).slice(0, MAX_SOURCES) as Record<string, unknown>[]) {
    const title = str(s?.title, 200);
    const file = str(s?.file, 300);
    const text = str(s?.text, MAX_FILE_CHARS);
    if (!title || (!file && !text)) continue;
    sources.push(file ? { title, file } : { title, text });
  }
  if (!topics.length && !sources.length) throw new Error("Manifest vide : ni « topics », ni « sources ».");

  let audio: Partial<AudioOptions> | undefined;
  if (data.audio && typeof data.audio === "object") {
    const a = data.audio as Record<string, unknown>;
    audio = {};
    if (["deep_dive", "brief", "critique", "debate"].includes(a.format as string)) audio.format = a.format as AudioOptions["format"];
    if (["short", "default", "long"].includes(a.length as string)) audio.length = a.length as AudioOptions["length"];
    if (typeof a.language === "string" && /^[a-z]{2}$/.test(a.language)) audio.language = a.language;
    if (typeof a.instructions === "string") audio.instructions = a.instructions.slice(0, 2000);
  }

  let actions: ExtractedAction[] = [];
  if (Array.isArray(data.actions)) {
    try {
      actions = parseActions(JSON.stringify({ actions: data.actions }));
    } catch {
      actions = [];
    }
  }

  return { id, generatedAt, title: str(data.title, 200) || undefined, topics, sources, audio, actions };
}

// ─── Lecture ──────────────────────────────────────────────────────────────────

export function fileAccessAllowed(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedFileSchemeAccess((ok) => resolve(ok));
    } catch {
      resolve(false);
    }
  });
}

async function readLocal(url: string, label: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch {
    if (!(await fileAccessAllowed())) {
      throw new Error("Accès aux fichiers non autorisé : chrome://extensions › Notebooker › Détails › activer « Autoriser l'accès aux URL de fichier ».");
    }
    throw new Error(`Fichier introuvable : ${label}`);
  }
  if (!res.ok && res.status !== 0) throw new Error(`Lecture impossible (${res.status}) : ${label}`);
  const text = await res.text();
  return text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n\n[… tronqué]` : text;
}

export function manifestUrl(settings: Settings, manifestFile: string): { base: string; url: string } {
  const base = folderToFileUrl(settings.localInbox.path);
  const name = manifestFile.trim() || "latest.json";
  if (!/^[\w.-]+\.json$/.test(name)) throw new Error(`Nom de manifest invalide : « ${manifestFile} » (ex. latest.json).`);
  return { base, url: base + name };
}

/** Lit uniquement le manifest (surveillance périodique : léger). */
export async function readManifest(settings: Settings, manifestFile: string): Promise<InboxManifest> {
  const { url } = manifestUrl(settings, manifestFile);
  return parseManifest(await readLocal(url, manifestFile || "latest.json"));
}

/** Lit le manifest + le contenu de toutes les sources fichiers. */
export async function readInbox(settings: Settings, manifestFile: string): Promise<{ manifest: InboxManifest; files: { title: string; text: string }[] }> {
  const { base } = manifestUrl(settings, manifestFile);
  const manifest = await readManifest(settings, manifestFile);
  const files: { title: string; text: string }[] = [];
  for (const s of manifest.sources) {
    if (s.text) files.push({ title: s.title, text: s.text });
    else if (s.file) files.push({ title: s.title, text: await readLocal(resolveInboxFile(base, s.file), s.file) });
  }
  return { manifest, files };
}
