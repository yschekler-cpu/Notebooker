import { getFolders, getNotebookMetas } from "./storage";
import type { Folder, NotebookMeta } from "./types";

export interface OrgExport {
  format: "notebooker-org";
  version: 1;
  exportedAt: string;
  folders: Folder[];
  notebooks: NotebookMeta[];
}

export async function exportOrganization(): Promise<OrgExport> {
  const [folders, metas] = await Promise.all([getFolders(), getNotebookMetas()]);
  return { format: "notebooker-org", version: 1, exportedAt: new Date().toISOString(), folders, notebooks: Object.values(metas) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

const MAX_FOLDERS = 60; // la clé `folders` doit tenir sous la limite de 8 Ko par item de storage.sync
const MAX_NOTEBOOKS = 400; // quota total storage.sync : 100 Ko

/** Validation stricte du fichier importé (fichier non fiable) puis fusion avec l'existant, en une seule écriture. */
export async function importOrganization(raw: unknown): Promise<{ folders: number; notebooks: number }> {
  const data = raw as Partial<OrgExport>;
  if (!data || data.format !== "notebooker-org" || data.version !== 1) throw new Error("Format inconnu (attendu : export Notebooker v1).");
  if (!Array.isArray(data.folders) || !Array.isArray(data.notebooks)) throw new Error("Fichier incomplet.");

  const folders: Folder[] = data.folders
    .filter((f) => f && typeof f.id === "string" && UUID.test(f.id) && typeof f.name === "string" && f.name.trim())
    .map((f, i) => ({ id: f.id.toLowerCase(), name: str(f.name, 60), color: /^#[0-9a-f]{3,8}$/i.test(f.color) ? f.color : "#64748b", order: Number.isFinite(f.order) ? f.order : i }));
  const existing = await getFolders();
  const merged = [...existing.filter((e) => !folders.some((f) => f.id === e.id)), ...folders];
  if (merged.length > MAX_FOLDERS) throw new Error(`Trop de dossiers (${merged.length} > ${MAX_FOLDERS}).`);

  const ids = new Set(merged.map((f) => f.id));
  const current = await getNotebookMetas();
  const items: Record<string, NotebookMeta> = {};
  for (const m of data.notebooks) {
    if (!m || typeof m.notebookId !== "string" || !UUID.test(m.notebookId)) continue;
    const id = m.notebookId.toLowerCase();
    items[`nb:${id}`] = {
      notebookId: id,
      title: str(m.title, 200),
      folderId: typeof m.folderId === "string" && ids.has(m.folderId.toLowerCase()) ? m.folderId.toLowerCase() : null,
      tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === "string").map((t) => t.slice(0, 40)).slice(0, 20) : [],
      pinned: m.pinned === true,
      lastSeenAt: current[id]?.lastSeenAt ?? new Date().toISOString(),
    };
  }
  const total = new Set([...Object.keys(current).map((k) => `nb:${k}`), ...Object.keys(items)]).size;
  if (total > MAX_NOTEBOOKS) throw new Error(`Trop de notebooks (${total} > ${MAX_NOTEBOOKS}).`);
  const size = new TextEncoder().encode(JSON.stringify({ folders: merged, ...items })).length;
  if (size > 90_000) throw new Error("Organisation trop volumineuse pour la synchronisation Chrome (> 90 Ko).");

  // Une seule écriture : respecte la limite de 120 écritures/min de storage.sync.
  await chrome.storage.sync.set({ folders: merged, ...items });
  return { folders: folders.length, notebooks: Object.keys(items).length };
}
