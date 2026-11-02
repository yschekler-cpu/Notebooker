import { isDue } from "../shared/schedule";
import { getSettings, getSubscriptions, updateSubscription } from "../shared/storage";
import type { Settings, SourcePayload, Subscription } from "../shared/types";
import { addSources } from "./notebooklm";
import { NotionClient } from "./notion";
import { parseFeed } from "./rss";
import { clamp, htmlToText, isYouTube, sha256 } from "./text";

const MAX_SEEN = 500;
const MAX_ITEMS_PER_RUN = 10;
const MAX_TEXT = 200_000;

interface Delta {
  sources: SourcePayload[];
  fingerprint: string | null;
  seen: string[];
}

export async function refreshDueSubscriptions(force = false): Promise<{ checked: number; pushed: number; errors: number }> {
  const [subs, settings] = await Promise.all([getSubscriptions(), getSettings()]);
  const due = subs.filter((s) => s.enabled && (force || isDue(s.lastCheckedAt, s.refreshMinutes)));
  let pushed = 0;
  let errors = 0;
  for (const sub of due) {
    try {
      pushed += await refreshOne(sub, settings);
    } catch (e) {
      errors++;
      await updateSubscription(sub.id, {
        lastCheckedAt: new Date().toISOString(),
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { checked: due.length, pushed, errors };
}

export async function refreshOne(sub: Subscription, settings: Settings): Promise<number> {
  const delta = await computeDelta(sub, settings);
  if (delta.sources.length > 0) await push(sub, delta.sources, settings);
  await updateSubscription(sub.id, {
    lastCheckedAt: new Date().toISOString(),
    lastFingerprint: delta.fingerprint,
    seenItemIds: delta.seen.slice(-MAX_SEEN),
    lastError: null,
  });
  return delta.sources.length;
}

async function computeDelta(sub: Subscription, settings: Settings): Promise<Delta> {
  const seen = [...sub.seenItemIds];
  switch (sub.kind) {
    case "url": {
      if (isYouTube(sub.ref) || sub.refreshMinutes <= 0) {
        // Vidéo (contenu figé) ou ajout ponctuel : un seul push, pas de fetch (pas de permission hôte requise).
        return { sources: sub.lastFingerprint ? [] : [{ type: "url", title: sub.title, url: sub.ref }], fingerprint: "once", seen };
      }
      const res = await fetch(sub.ref, { credentials: "omit" });
      if (!res.ok) throw new Error(`HTTP ${res.status} sur ${sub.ref}`);
      const text = htmlToText(await res.text());
      const fp = await sha256(text);
      const changed = fp !== sub.lastFingerprint;
      return { sources: changed ? [{ type: "url", title: sub.title, url: sub.ref }] : [], fingerprint: fp, seen };
    }
    case "feed": {
      const res = await fetch(sub.ref, { credentials: "omit" });
      if (!res.ok) throw new Error(`HTTP ${res.status} sur le flux`);
      const feed = parseFeed(await res.text());
      const fresh = feed.items.filter((i) => !seen.includes(i.id));
      // Premier passage : on n'importe que les N derniers items pour ne pas inonder le notebook.
      const batch = fresh.slice(0, MAX_ITEMS_PER_RUN);
      seen.push(...fresh.map((i) => i.id));
      return { sources: batch.map((i) => ({ type: "url", title: i.title, url: i.url })), fingerprint: null, seen };
    }
    case "notion_page": {
      const notion = notionFor(sub, settings);
      const page = await notion.getPage(sub.ref);
      if (page.lastEditedTime === sub.lastFingerprint) return { sources: [], fingerprint: sub.lastFingerprint, seen };
      const md = await notion.pageMarkdown(sub.ref);
      return {
        sources: [{ type: "text", title: `[Notion] ${page.title} — maj ${fmt(page.lastEditedTime)}`, text: clamp(md, MAX_TEXT), url: page.url }],
        fingerprint: page.lastEditedTime,
        seen,
      };
    }
    case "notion_database": {
      const notion = notionFor(sub, settings);
      const since = sub.lastCheckedAt ? new Date(sub.lastCheckedAt) : undefined;
      const pages = (await notion.queryDatabase(sub.ref, since)).slice(0, MAX_ITEMS_PER_RUN);
      const sources: SourcePayload[] = [];
      for (const p of pages) {
        const key = `${p.id}@${p.lastEditedTime}`;
        if (seen.includes(key)) continue;
        seen.push(key);
        sources.push({ type: "text", title: `[Notion] ${p.title} — maj ${fmt(p.lastEditedTime)}`, text: clamp(await notion.pageMarkdown(p.id), MAX_TEXT), url: p.url });
      }
      return { sources, fingerprint: null, seen };
    }
  }
}

async function push(sub: Subscription, sources: SourcePayload[], settings: Settings): Promise<void> {
  const t = sub.target;
  if (t.kind === "notebooklm") {
    const r = await addSources(t.notebookId, sources);
    if (r.errors.length) throw new Error(`${r.added}/${sources.length} ajoutées. ${r.errors.join(" | ")}`);
    return;
  }
  const notion = new NotionClient(settings.notion[t.workspace]);
  for (const s of sources) {
    let text = s.text;
    if (!text && s.url && !isYouTube(s.url)) {
      text = await fetch(s.url, { credentials: "omit" })
        .then((r) => r.text())
        .then((h) => clamp(htmlToText(h), 20_000))
        .catch(() => undefined);
    }
    await notion.createDatabaseEntry(t.databaseId, { title: s.title, url: s.url, text });
  }
}

function notionFor(sub: Subscription, settings: Settings): NotionClient {
  const ws = settings.notion[sub.workspace ?? "personal"];
  const client = new NotionClient(ws);
  if (!client.configured) throw new Error(`Token Notion manquant (${ws.label}).`);
  return client;
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}
