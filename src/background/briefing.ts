import { redact } from "../shared/redact";
import { formatDateFR } from "../shared/schedule";
import { getBriefingRuns, getSettings, saveBriefingRun, uid } from "../shared/storage";
import type { BriefingRun, NotionWorkspaceKey, Settings, SourcePayload } from "../shared/types";
import { synthesizeBriefing } from "./claude";
import { buildGmailQuery, fetchRecentMails, type MailDigestItem } from "./gmail";
import { createNotebookWithAudio, deleteNotebook, keepAlive, notebookUrl } from "./notebooklm";
import { NotionClient, type NotionPageLite } from "./notion";
import { clamp } from "./text";

/**
 * Pipeline du brief matinal :
 *   collecte (Gmail + Notion perso + Notion entreprise)
 *   → masquage PII
 *   → [option] synthèse Claude
 *   → création notebook NotebookLM + sources + Audio Overview
 *   → suivi de génération + notification
 */

export interface NotionDigestItem extends NotionPageLite {
  workspace: NotionWorkspaceKey;
  markdown: string;
}

const MAX_SOURCE_CHARS = 180_000;
/** Plafond du corpus envoyé à Claude (~100k tokens) : borne le coût et la latence. */
const MAX_CLAUDE_CORPUS_CHARS = 400_000;
const LOCK_KEY = "briefingLock";
const LOCK_TTL_MS = 25 * 60_000;

/**
 * Verrou persistant (storage) : alarme, rattrapage au démarrage et bouton manuel ne doivent
 * jamais produire deux notebooks le même matin. TTL pour survivre à un SW tué en plein run.
 */
async function acquireLock(): Promise<boolean> {
  const { [LOCK_KEY]: lock } = (await chrome.storage.local.get(LOCK_KEY)) as { [LOCK_KEY]?: number };
  if (lock && Date.now() - lock < LOCK_TTL_MS) return false;
  await chrome.storage.local.set({ [LOCK_KEY]: Date.now() });
  return true;
}

async function releaseLock(): Promise<void> {
  await chrome.storage.local.remove(LOCK_KEY);
}

/** Runs restés « running » après un arrêt brutal du service worker → marqués en erreur. */
async function closeStaleRuns(): Promise<void> {
  for (const r of await getBriefingRuns()) {
    if (r.status === "running" && Date.now() - new Date(r.startedAt).getTime() > LOCK_TTL_MS) {
      await saveBriefingRun({ ...r, status: "error", finishedAt: new Date().toISOString(), steps: [...r.steps, { at: new Date().toISOString(), message: "Interrompu (service worker arrêté)", level: "error" }] });
    }
  }
}

let inflight: Promise<BriefingRun | { skipped: string }> | null = null;

/**
 * Point d'entrée unique. Deux protections complémentaires :
 * - `inflight` (mémoire) : synchrone, couvre le double-clic (le get/set du storage n'est pas atomique) ;
 * - verrou storage : couvre un SW redémarré pendant un run.
 */
export function runBriefing(opts: { interactive: boolean }): Promise<BriefingRun | { skipped: string }> {
  if (inflight) return Promise.resolve({ skipped: "Un brief est déjà en cours." });
  inflight = (async () => {
    await closeStaleRuns();
    if (!(await acquireLock())) return { skipped: "Un brief est déjà en cours." };
    const stop = keepAlive();
    try {
      return await doRunBriefing(opts);
    } finally {
      stop();
      await releaseLock();
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doRunBriefing(opts: { interactive: boolean }): Promise<BriefingRun> {
  const settings = await getSettings();
  const run: BriefingRun = {
    id: uid(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    notebookId: null,
    sourcesCount: 0,
    steps: [],
  };
  const log = (message: string, level: "info" | "warn" | "error" = "info") => {
    run.steps.push({ at: new Date().toISOString(), message, level });
    void saveBriefingRun(run);
  };
  let degraded = false;

  try {
    const since = new Date(Date.now() - settings.briefing.lookbackHours * 3600_000);

    // 1) Collecte
    const mails = await fetchRecentMails({
      query: buildGmailQuery(settings.briefing.gmailQuery, settings.briefing.lookbackHours, settings.briefing.gmailExclusions),
      max: settings.briefing.gmailMaxMessages,
      since,
      interactive: opts.interactive,
    }).catch((e: unknown) => {
      degraded = true;
      log(`Gmail indisponible : ${msg(e)}`, "warn");
      return [] as MailDigestItem[];
    });
    log(`${mails.length} emails collectés`);

    const notionItems: NotionDigestItem[] = [];
    for (const key of ["personal", "company"] as const) {
      const ws = settings.notion[key];
      const client = new NotionClient(ws);
      if (!client.configured) continue;
      try {
        const pages = await collectNotion(client, ws.briefingRootIds, since);
        for (const p of pages) notionItems.push({ ...p, workspace: key, markdown: clamp(await client.pageMarkdown(p.id, 2), 15_000) });
        log(`${pages.length} pages Notion (${ws.label})`);
      } catch (e) {
        degraded = true;
        log(`Notion ${ws.label} indisponible : ${msg(e)}`, "warn");
      }
    }

    if (mails.length === 0 && notionItems.length === 0) {
      log("Aucun contenu nouveau — pas de notebook créé.", "warn");
      return finish(run, "partial");
    }

    // 2) Masquage + construction des sources
    const sources = await buildSources(settings, mails, notionItems, log).catch((e: unknown) => {
      throw new Error(`Construction des sources : ${msg(e)}`);
    });

    // 3) NotebookLM
    const title = settings.briefing.notebookTitleTemplate.replace("{date}", formatDateFR());
    const { notebookId, added, audioStarted } = await createNotebookWithAudio(title, sources, settings.briefing.audioInstructions, log, async (id) => {
      // Tracé dès la création : rétention + anti-doublon même si la suite échoue.
      run.notebookId = id;
      await saveBriefingRun(run);
      await trackBriefNotebook(id);
    });
    run.notebookId = notebookId;
    run.sourcesCount = added;
    if (added < sources.length) degraded = true;

    if (audioStarted) await chrome.alarms.create(`audio:${notebookId}`, { delayInMinutes: 4, periodInMinutes: 3 });
    else {
      degraded = true;
      notify("Brief du matin prêt (sans audio)", "Le notebook est créé ; lance l'Audio Overview manuellement.", await notebookUrl(notebookId));
    }
    await applyRetention(settings, log);

    return finish(run, degraded ? "partial" : "success");
  } catch (e) {
    log(msg(e), "error");
    notify("Brief du matin : échec", msg(e));
    return finish(run, "error");
  }
}

async function collectNotion(client: NotionClient, rootIds: string[], since: Date): Promise<NotionPageLite[]> {
  if (rootIds.length === 0) return client.searchEditedSince(since, 25);
  const out: NotionPageLite[] = [];
  for (const id of rootIds) {
    try {
      out.push(...(await client.queryDatabase(id, since, 25)));
    } catch {
      // Pas une base → page simple
      const p = await client.getPage(id);
      if (new Date(p.lastEditedTime) >= since) out.push(p);
    }
  }
  return out;
}

export function mailsToMarkdown(mails: MailDigestItem[]): string {
  return mails
    .map((m) => `### ${m.subject}\nDe : ${m.from} — ${new Date(m.date).toLocaleString("fr-FR")}\n\n${m.body || m.snippet}`)
    .join("\n\n---\n\n");
}

export function notionToMarkdown(items: NotionDigestItem[]): string {
  return items
    .map((p) => `### ${p.title}\nModifiée le ${new Date(p.lastEditedTime).toLocaleString("fr-FR")} — ${p.url}\n\n${p.markdown}`)
    .join("\n\n---\n\n");
}

export async function buildSources(
  settings: Settings,
  mails: MailDigestItem[],
  notion: NotionDigestItem[],
  log: (m: string, level?: "info" | "warn" | "error") => void,
): Promise<SourcePayload[]> {
  const mask = (t: string) => (settings.claude.redactPII ? redact(t, { amounts: settings.claude.redactAmounts }) : t);
  const date = formatDateFR();
  const sources: SourcePayload[] = [];

  const mailsMd = mask(mailsToMarkdown(mails));
  const byWs = (k: NotionWorkspaceKey) => mask(notionToMarkdown(notion.filter((n) => n.workspace === k)));

  if (settings.claude.enabled) {
    try {
      const corpus = clamp(`# Corpus du ${date}\n\n## EMAILS\n\n${mailsMd}\n\n## NOTION ${settings.notion.personal.label.toUpperCase()}\n\n${byWs("personal")}\n\n## NOTION ${settings.notion.company.label.toUpperCase()}\n\n${byWs("company")}`, MAX_CLAUDE_CORPUS_CHARS);
      const brief = await synthesizeBriefing(settings.claude, corpus);
      sources.push({ type: "text", title: `Brief synthétisé — ${date}`, text: brief });
      log("Synthèse Claude générée");
    } catch (e) {
      log(`Synthèse Claude ignorée : ${msg(e)}`, "warn");
    }
  }

  // Sources brutes regroupées (limite de sources par notebook + meilleure cohérence de l'Audio Overview)
  if (mails.length) sources.push({ type: "text", title: `Emails — ${date}`, text: clamp(mailsMd, MAX_SOURCE_CHARS) });
  for (const k of ["personal", "company"] as const) {
    const md = byWs(k);
    if (md) sources.push({ type: "text", title: `${settings.notion[k].label} — ${date}`, text: clamp(md, MAX_SOURCE_CHARS) });
  }
  return sources;
}

// ─── Suivi de génération audio ────────────────────────────────────────────────

const AUDIO_MAX_CHECKS = 12;

export async function onAudioAlarm(notebookId: string, check: (id: string) => Promise<string>, url: string): Promise<void> {
  const key = `audioChecks:${notebookId}`;
  const n = (((await chrome.storage.local.get(key))[key] as number | undefined) ?? 0) + 1;
  await chrome.storage.local.set({ [key]: n });
  let status = "none";
  try {
    status = await check(notebookId);
  } catch {
    /* tab KO → on retentera */
  }
  if (status === "ready") {
    await chrome.alarms.clear(`audio:${notebookId}`);
    await chrome.storage.local.remove(key);
    notify("🎧 Ton podcast du matin est prêt", "Clique pour l'écouter dans NotebookLM.", url);
  } else if (n >= AUDIO_MAX_CHECKS) {
    await chrome.alarms.clear(`audio:${notebookId}`);
    await chrome.storage.local.remove(key);
    notify("Brief du matin", "Le notebook est prêt ; l'audio n'a pas été confirmé — vérifie dans NotebookLM.", url);
  }
}

// ─── Rétention ────────────────────────────────────────────────────────────────

async function trackBriefNotebook(id: string): Promise<void> {
  const { briefNotebooks = [] } = (await chrome.storage.local.get("briefNotebooks")) as {
    briefNotebooks?: { id: string; createdAt: string }[];
  };
  briefNotebooks.push({ id, createdAt: new Date().toISOString() });
  await chrome.storage.local.set({ briefNotebooks });
}

/** Ne supprime QUE des notebooks créés par l'extension pour le brief. */
async function applyRetention(settings: Settings, log: (m: string, l?: "info" | "warn" | "error") => void): Promise<void> {
  if (settings.briefing.retentionDays <= 0) return;
  const { briefNotebooks = [] } = (await chrome.storage.local.get("briefNotebooks")) as {
    briefNotebooks?: { id: string; createdAt: string }[];
  };
  const limit = Date.now() - settings.briefing.retentionDays * 86_400_000;
  const keep: typeof briefNotebooks = [];
  for (const nb of briefNotebooks) {
    if (new Date(nb.createdAt).getTime() >= limit) {
      keep.push(nb);
      continue;
    }
    try {
      await deleteNotebook(nb.id);
      log(`Ancien brief supprimé (${nb.id})`);
    } catch (e) {
      log(`Suppression ancien brief impossible (${nb.id}) : ${msg(e)}`, "warn");
      keep.push(nb);
    }
  }
  await chrome.storage.local.set({ briefNotebooks: keep });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function finish(run: BriefingRun, status: BriefingRun["status"]): Promise<BriefingRun> {
  run.status = status;
  run.finishedAt = new Date().toISOString();
  await saveBriefingRun(run);
  return run;
}

export async function lastSuccessfulRun(): Promise<Date | null> {
  // Un run en erreur qui a quand même créé un notebook compte : pas de second brief le même matin.
  const r = (await getBriefingRuns()).find((x) => x.status === "success" || x.status === "partial" || x.notebookId !== null);
  return r ? new Date(r.startedAt) : null;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function notify(title: string, message: string, url?: string): void {
  const id = url ? `open:${url}` : `n:${Date.now()}`;
  chrome.notifications.create(id, { type: "basic", iconUrl: "icon128.png", title, message, priority: 1 });
}
