import { isDue } from "../shared/schedule";
import { getSettings, getSubscription, getSubscriptions, updateSubscription } from "../shared/storage";
import type { Settings, SourcePayload, Subscription } from "../shared/types";
import { addSources, keepAlive } from "./notebooklm";
import { NotionClient } from "./notion";
import { parseFeed } from "./rss";
import { clamp, htmlToText, isYouTube, sha256 } from "./text";

export const MAX_SEEN = 500;
export const MAX_ITEMS_PER_RUN = 10;
const MAX_TEXT = 200_000;

/** Un élément à pousser + la clé qui le marque « vu » une fois poussé avec succès. */
export interface DeltaItem {
  source: SourcePayload;
  key: string;
}

export interface Delta {
  items: DeltaItem[];
  /** Empreinte à enregistrer SI tous les items passent (sinon on garde l'ancienne → retry). */
  fingerprint: string | null;
  /** Clés à marquer vues sans pousser (ex. historique d'un flux au premier passage). */
  skippedKeys: string[];
}

/** Fonction de push injectable (tests) : renvoie l'index des sources en échec. */
export type Pusher = (sub: Subscription, sources: SourcePayload[], settings: Settings) => Promise<{ failed: number[]; errors: string[] }>;

let syncChain: Promise<unknown> = Promise.resolve();

/**
 * Mutex unique pour TOUT ce qui pousse des sources (alarme, bouton Sync, ajout via popup /
 * menu contextuel) : deux passes concurrentes travailleraient sur les mêmes `seenItemIds`.
 */
export function withSyncLock<T>(job: () => Promise<T>): Promise<T> {
  const run = syncChain.then(job, job);
  syncChain = run.catch(() => undefined);
  return run;
}

export function refreshDueSubscriptions(force = false): Promise<{ checked: number; pushed: number; errors: number }> {
  return withSyncLock(async () => {
    const stop = keepAlive();
    try {
      const settings = await getSettings();
      const due = (await getSubscriptions()).filter((s) => s.enabled && (force || isDue(s.lastCheckedAt, s.refreshMinutes)));
      let pushed = 0;
      let errors = 0;
      for (const { id } of due) {
        const fresh = await getSubscription(id); // relu : peut avoir été modifié/supprimé entre-temps
        if (!fresh?.enabled) continue;
        const r = await refreshOne(fresh, settings);
        pushed += r.pushed;
        if (r.error) errors++;
      }
      return { checked: due.length, pushed, errors };
    } finally {
      stop();
    }
  });
}

/** Rafraîchit un abonnement précis sous le mutex (ajout depuis le popup / menu contextuel). */
export function refreshSubscriptionNow(id: string): Promise<{ pushed: number; error: string | null }> {
  return withSyncLock(async () => {
    const stop = keepAlive();
    try {
      const fresh = await getSubscription(id);
      if (!fresh) return { pushed: 0, error: "Abonnement introuvable." };
      return await refreshOne(fresh, await getSettings());
    } finally {
      stop();
    }
  });
}

export async function refreshOne(
  sub: Subscription,
  settings: Settings,
  pusher: Pusher = push,
): Promise<{ pushed: number; error: string | null }> {
  const now = new Date().toISOString();
  let delta: Delta;
  try {
    delta = await computeDelta(sub, settings);
  } catch (e) {
    const error = msg(e);
    await updateSubscription(sub.id, { lastCheckedAt: now, lastError: error });
    return { pushed: 0, error };
  }

  let failed: number[] = [];
  let error: string | null = null;
  if (delta.items.length > 0) {
    try {
      const r = await pusher(sub, delta.items.map((i) => i.source), settings);
      failed = r.failed;
      if (r.errors.length) error = `${delta.items.length - failed.length}/${delta.items.length} ajoutées. ${r.errors.join(" | ")}`;
    } catch (e) {
      failed = delta.items.map((_, i) => i);
      error = msg(e);
    }
  }

  const okKeys = delta.items.filter((_, i) => !failed.includes(i)).map((i) => i.key);
  const seen = dedupe([...sub.seenItemIds, ...delta.skippedKeys, ...okKeys]).slice(-MAX_SEEN);
  await updateSubscription(sub.id, {
    lastCheckedAt: now,
    // Échec partiel : on conserve l'ancienne empreinte pour retenter au prochain passage.
    lastFingerprint: failed.length === 0 ? delta.fingerprint : sub.lastFingerprint,
    seenItemIds: seen,
    lastError: error,
  });
  return { pushed: okKeys.length, error };
}

export async function computeDelta(sub: Subscription, settings: Settings): Promise<Delta> {
  const seen = new Set(sub.seenItemIds);
  switch (sub.kind) {
    case "url": {
      if (isYouTube(sub.ref) || sub.refreshMinutes <= 0) {
        // Vidéo (contenu figé) ou ajout ponctuel : un seul push, pas de fetch (pas de permission hôte requise).
        const items = sub.lastFingerprint ? [] : [{ source: { type: "url", title: sub.title, url: sub.ref } as SourcePayload, key: sub.ref }];
        return { items, fingerprint: "once", skippedKeys: [] };
      }
      const text = htmlToText(await fetchText(sub.ref));
      const fp = await sha256(text);
      // Déjà ajouté en « ajout unique » puis passé en suivi : on initialise l'empreinte sans re-pousser.
      if (sub.lastFingerprint === "once") return { items: [], fingerprint: fp, skippedKeys: [] };
      const changed = fp !== sub.lastFingerprint;
      return {
        items: changed ? [{ source: { type: "url", title: sub.title, url: sub.ref }, key: `${sub.ref}#${fp.slice(0, 12)}` }] : [],
        fingerprint: fp,
        skippedKeys: [],
      };
    }
    case "feed": {
      const feed = parseFeed(await fetchText(sub.ref));
      const fresh = feed.items.filter((i) => !seen.has(i.id));
      // « Premier passage » = flux jamais lu avec succès (et non « jamais vérifié ») : un premier essai
      // en échec (permission manquante…) ne doit pas faire importer tout l'historique ensuite.
      const firstRun = sub.lastFingerprint === null;
      const batch = fresh.slice(0, MAX_ITEMS_PER_RUN);
      return {
        items: batch.map((i) => ({ source: { type: "url", title: i.title, url: i.url }, key: i.id })),
        fingerprint: "parsed",
        // 1er passage : l'historique au-delà des N derniers est ignoré (pas d'inondation).
        // Ensuite : le surplus reste « non vu » et part au passage suivant.
        skippedKeys: firstRun ? fresh.slice(MAX_ITEMS_PER_RUN).map((i) => i.id) : [],
      };
    }
    case "notion_page": {
      const notion = notionFor(sub, settings);
      const page = await notion.getPage(sub.ref);
      if (page.lastEditedTime === sub.lastFingerprint) return { items: [], fingerprint: sub.lastFingerprint, skippedKeys: [] };
      const md = await notion.pageMarkdown(sub.ref);
      return {
        items: [
          {
            source: { type: "text", title: `[Notion] ${page.title} — maj ${fmt(page.lastEditedTime)}`, text: clamp(md, MAX_TEXT), url: page.url },
            key: `${page.id}@${page.lastEditedTime}`,
          },
        ],
        fingerprint: page.lastEditedTime,
        skippedKeys: [],
      };
    }
    case "notion_database": {
      // Curseur = last_edited_time de la plus ancienne page NON encore poussée (tri ascendant).
      // Il n'avance que sur les pages traitées : ni trou en cas d'édition massive, ni perte en cas d'échec
      // (refreshOne conserve l'ancien curseur si un push échoue ; les clés vues évitent les doublons).
      const notion = notionFor(sub, settings);
      const since = sub.lastFingerprint ? new Date(new Date(sub.lastFingerprint).getTime() - 60_000) : undefined;
      const pages = await notion.queryDatabase(sub.ref, since, 200, true);
      const pending = pages.filter((p) => !seen.has(`${p.id}@${p.lastEditedTime}`));
      const batch = pending.slice(0, MAX_ITEMS_PER_RUN);
      const items: DeltaItem[] = [];
      for (const p of batch) {
        items.push({
          source: { type: "text", title: `[Notion] ${p.title} — maj ${fmt(p.lastEditedTime)}`, text: clamp(await notion.pageMarkdown(p.id), MAX_TEXT), url: p.url },
          key: `${p.id}@${p.lastEditedTime}`,
        });
      }
      const next = pending[MAX_ITEMS_PER_RUN];
      const newest = pages.at(-1)?.lastEditedTime ?? sub.lastFingerprint;
      return { items, fingerprint: next ? next.lastEditedTime : newest, skippedKeys: [] };
    }
  }
}

async function push(sub: Subscription, sources: SourcePayload[], settings: Settings): Promise<{ failed: number[]; errors: string[] }> {
  const t = sub.target;
  if (t.kind === "notebooklm") {
    const r = await addSources(t.notebookId, sources);
    return { failed: r.failed, errors: r.errors };
  }
  const notion = new NotionClient(settings.notion[t.workspace]);
  if (!notion.configured) throw new Error(`Token Notion manquant (${settings.notion[t.workspace].label}).`);
  const failed: number[] = [];
  const errors: string[] = [];
  for (const [i, s] of sources.entries()) {
    try {
      let text = s.text;
      if (!text && s.url && !isYouTube(s.url)) {
        text = await fetchText(s.url)
          .then((h) => clamp(htmlToText(h), 20_000))
          .catch(() => undefined); // contenu optionnel : l'entrée garde au moins l'URL
      }
      await notion.createDatabaseEntry(t.databaseId, { title: s.title, url: s.url, text });
    } catch (e) {
      failed.push(i);
      errors.push(`${s.title}: ${msg(e)}`);
    }
  }
  return { failed, errors };
}

async function fetchText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "omit", redirect: "follow", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error(`Accès refusé ou réseau KO pour ${new URL(url).host} (permission du site accordée ?)`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.text();
}

function notionFor(sub: Subscription, settings: Settings): NotionClient {
  const ws = settings.notion[sub.workspace ?? "personal"];
  const client = new NotionClient(ws);
  if (!client.configured) throw new Error(`Token Notion manquant (${ws.label}).`);
  return client;
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}
