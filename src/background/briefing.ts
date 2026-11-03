import { redact } from "../shared/redact";
import { formatDateFR, localDay } from "../shared/schedule";
import { getBriefingRuns, getMemory, getSettings, saveBriefingRun, saveMemory, uid } from "../shared/storage";
import type { AudioOptions, BriefingRun, BriefProfile, NotionWorkspaceKey, Settings, SourcePayload } from "../shared/types";
import { readInbox } from "./localInbox";
import { NO_REPEAT_INSTRUCTIONS, diffTopics, followUpToMarkdown, hasNews, newsToMarkdown } from "./topicDiff";
import { enqueueActions } from "./actions";
import { agendaToMarkdown, calendarWindow, fetchEvents, type CalendarEvent } from "./calendar";
import { analyzeCorpus, type ExtractedAction } from "./claude";
import { buildGmailQuery, fetchRecentMails, type MailDigestItem } from "./gmail";
import { memoryToMarkdown, topicTitle, updateMemory, type MemoryDiff, type Observation } from "./memory";
import { createNotebookWithAudio, deleteNotebook, keepAlive, notebookUrl } from "./notebooklm";
import { NotionClient, type NotionPageLite } from "./notion";
import { clamp } from "./text";

/**
 * Pipeline d'un profil de brief :
 *   collecte (Gmail · Agenda · Notion perso · Notion entreprise, selon le profil)
 *   → mémoire (nouveau / toujours actif / calmé)
 *   → masquage PII
 *   → [option] Claude : synthèse + extraction d'actions (corpus en cache, une seule facturation pleine)
 *   → actions en file de validation (jamais écrites dans Notion sans validation)
 *   → notebook NotebookLM + sources + Audio Overview (format/durée/langue du profil)
 *   → suivi de génération + notification · rétention par profil
 */

export interface NotionDigestItem extends NotionPageLite {
  workspace: NotionWorkspaceKey;
  markdown: string;
}

const MAX_SOURCE_CHARS = 180_000;
/** Plafond du corpus envoyé à Claude (~100k tokens) : borne le coût et la latence. */
const MAX_CLAUDE_CORPUS_CHARS = 400_000;
const LOCK_TTL_MS = 25 * 60_000;
const lockKey = (profileId: string) => `briefingLock:${profileId}`;

/**
 * Verrou persistant par profil : alarme, rattrapage au démarrage et bouton manuel ne doivent
 * jamais produire deux notebooks pour le même créneau. TTL pour survivre à un SW tué en plein run.
 */
async function acquireLock(profileId: string): Promise<boolean> {
  const key = lockKey(profileId);
  const { [key]: lock } = (await chrome.storage.local.get(key)) as Record<string, number | undefined>;
  if (lock && Date.now() - lock < LOCK_TTL_MS) return false;
  await chrome.storage.local.set({ [key]: Date.now() });
  return true;
}

async function releaseLock(profileId: string): Promise<void> {
  await chrome.storage.local.remove(lockKey(profileId));
}

/** Runs restés « running » après un arrêt brutal du service worker → marqués en erreur. */
async function closeStaleRuns(): Promise<void> {
  for (const r of await getBriefingRuns()) {
    if (r.status === "running" && Date.now() - new Date(r.startedAt).getTime() > LOCK_TTL_MS) {
      await saveBriefingRun({ ...r, status: "error", finishedAt: new Date().toISOString(), steps: [...r.steps, { at: new Date().toISOString(), message: "Interrompu (service worker arrêté)", level: "error" }] });
    }
  }
}

export type BriefOutcome = BriefingRun | { skipped: string };
const inflight = new Map<string, Promise<BriefOutcome>>();

/**
 * Point d'entrée unique, par profil. Deux protections complémentaires :
 * - `inflight` (mémoire) : synchrone, couvre le double-clic (le get/set du storage n'est pas atomique) ;
 * - verrou storage : couvre un SW redémarré pendant un run.
 */
export function runBriefing(profileId: string, opts: { interactive: boolean }): Promise<BriefOutcome> {
  if (inflight.has(profileId)) return Promise.resolve({ skipped: "Un brief de ce profil est déjà en cours." });
  const job = (async (): Promise<BriefOutcome> => {
    const settings = await getSettings();
    const profile = settings.profiles.find((p) => p.id === profileId);
    if (!profile) return { skipped: `Profil introuvable (${profileId}).` };
    await closeStaleRuns();
    if (!(await acquireLock(profileId))) return { skipped: "Un brief de ce profil est déjà en cours." };
    const stop = keepAlive();
    try {
      return await doRunBriefing(settings, profile, opts);
    } finally {
      stop();
      await releaseLock(profileId);
    }
  })().finally(() => inflight.delete(profileId));
  inflight.set(profileId, job);
  return job;
}

export interface BriefData {
  mails: MailDigestItem[];
  events: CalendarEvent[];
  notion: NotionDigestItem[];
}

async function collect(settings: Settings, profile: BriefProfile, interactive: boolean, log: Logger): Promise<{ data: BriefData; degraded: boolean }> {
  const since = new Date(Date.now() - profile.lookbackHours * 3600_000);
  const data: BriefData = { mails: [], events: [], notion: [] };
  let degraded = false;

  if (profile.sources.gmail) {
    try {
      data.mails = await fetchRecentMails({
        // Exclusions de conformité : communes à tous les profils, non désactivables par profil.
        query: buildGmailQuery(profile.gmailQuery, profile.lookbackHours, settings.compliance.gmailExclusions),
        max: profile.gmailMaxMessages,
        since,
        interactive,
      });
      log(`${data.mails.length} emails collectés`);
    } catch (e) {
      degraded = true;
      log(`Gmail indisponible : ${msg(e)}`, "warn");
    }
  }

  if (profile.sources.calendar) {
    try {
      data.events = await fetchEvents(settings.calendar, calendarWindow(), interactive);
      log(`${data.events.length} réunion(s) à l'agenda`);
    } catch (e) {
      degraded = true;
      log(`Agenda indisponible : ${msg(e)}`, "warn");
    }
  }

  const wanted: [NotionWorkspaceKey, boolean][] = [
    ["personal", profile.sources.notionPersonal],
    ["company", profile.sources.notionCompany],
  ];
  for (const [key, on] of wanted) {
    if (!on) continue;
    const ws = settings.notion[key];
    const client = new NotionClient(ws, key);
    if (!client.configured) continue;
    try {
      const pages = await collectNotion(client, ws.briefingRootIds, since);
      for (const p of pages) data.notion.push({ ...p, workspace: key, markdown: clamp(await client.pageMarkdown(p.id, 2), 15_000) });
      log(`${pages.length} pages Notion (${ws.label})`);
    } catch (e) {
      degraded = true;
      log(`Notion ${ws.label} indisponible : ${msg(e)}`, "warn");
    }
  }
  return { data, degraded };
}

type Logger = (m: string, level?: "info" | "warn" | "error") => void;

async function doRunBriefing(settings: Settings, profile: BriefProfile, opts: { interactive: boolean }): Promise<BriefingRun> {
  const run: BriefingRun = {
    id: uid(),
    profileId: profile.id,
    profileName: profile.name,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    notebookId: null,
    sourcesCount: 0,
    steps: [],
  };
  const log: Logger = (message, level = "info") => {
    run.steps.push({ at: new Date().toISOString(), message, level });
    void saveBriefingRun(run);
  };

  if (profile.mode === "localFolder") return runLocalBrief(settings, profile, run, log, opts);

  try {
    // 1) Collecte
    const { data, degraded: collectDegraded } = await collect(settings, profile, opts.interactive, log);
    let degraded = collectDegraded;
    if (data.mails.length === 0 && data.notion.length === 0 && data.events.length === 0) {
      log("Aucun contenu nouveau — pas de notebook créé.", "warn");
      return finish(run, "partial");
    }

    // 2) Mémoire (calculée maintenant, enregistrée seulement si le notebook est créé)
    const today = localDay();
    let pendingMemory: Awaited<ReturnType<typeof getMemory>> | null = null;
    let diff: MemoryDiff | null = null;
    if (profile.memory) {
      const r = updateMemory(await getMemory(profile.id), observe(data, settings), today);
      pendingMemory = r.memory;
      diff = r.diff;
      log(`Suivi : ${diff.fresh.length} nouveau(x), ${diff.ongoing.length} toujours actif(s), ${diff.calmed.length} calmé(s)`);
    }

    // 3) Sources (+ Claude : synthèse et actions)
    const { sources, actions } = await buildSources(settings, profile, data, diff, log);
    if (actions.length) {
      const added = await enqueueActions(actions, profile.id, run.id);
      if (added.length) {
        log(`${added.length} action(s) à valider avant envoi au backlog`);
        notify(`✅ ${added.length} action(s) à valider`, "Ouvre Notebooker › Actions pour les envoyer au backlog Notion.", chrome.runtime.getURL("options.html#actions"));
      }
    }

    // 4) NotebookLM
    const title = profile.notebookTitleTemplate.replace("{date}", formatDateFR());
    const { notebookId, added, audioStarted } = await createNotebookWithAudio(title, sources, profile.audio, log, async (id) => {
      // Tracé dès la création : rétention + anti-doublon même si la suite échoue.
      run.notebookId = id;
      await saveBriefingRun(run);
      await trackBriefNotebook(id, profile.id);
      await setLastPodcast({ notebookId: id, title, profileName: profile.name, createdAt: new Date().toISOString(), status: "generating" });
      if (pendingMemory) await saveMemory(profile.id, pendingMemory);
    });
    run.notebookId = notebookId;
    run.sourcesCount = added;
    if (added < sources.length) degraded = true;

    if (audioStarted) await chrome.alarms.create(`audio:${notebookId}`, { delayInMinutes: 4, periodInMinutes: 3 });
    else {
      degraded = true;
      notify(`${profile.name} prêt (sans audio)`, "Le notebook est créé ; lance l'Audio Overview manuellement.", await notebookUrl(notebookId));
    }
    await applyRetention(profile, log);

    return finish(run, degraded ? "partial" : "success");
  } catch (e) {
    log(msg(e), "error");
    notify(`${profile.name} : échec`, msg(e));
    return finish(run, "error");
  }
}

/** Sujets observés pour la mémoire : fils Gmail et pages Notion (titres masqués si le masquage est actif). */
export function observe(data: BriefData, settings: Settings): Observation[] {
  const mask = (t: string) => (settings.claude.redactPII ? redact(t, { amounts: settings.claude.redactAmounts }) : t);
  return [
    ...data.mails.map((m): Observation => ({ key: `mail:${m.threadId}`, title: mask(topicTitle(m.subject)), kind: "mail" })),
    ...data.notion.map((p): Observation => ({ key: `notion:${p.id}`, title: mask(p.title), kind: "notion" })),
  ];
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
  profile: BriefProfile,
  data: BriefData,
  diff: MemoryDiff | null,
  log: Logger,
  fetchImpl?: typeof fetch,
): Promise<{ sources: SourcePayload[]; actions: ExtractedAction[] }> {
  const mask = (t: string) => (settings.claude.redactPII ? redact(t, { amounts: settings.claude.redactAmounts }) : t);
  const date = formatDateFR();
  const sources: SourcePayload[] = [];
  let actions: ExtractedAction[] = [];

  const mailsMd = mask(mailsToMarkdown(data.mails));
  const agendaMd = mask(agendaToMarkdown(data.events, data.mails, data.notion));
  const memoryMd = diff ? mask(memoryToMarkdown(diff)) : "";
  const byWs = (k: NotionWorkspaceKey) => mask(notionToMarkdown(data.notion.filter((n) => n.workspace === k)));

  const wantsActions = profile.extractActions;
  if (wantsActions && !settings.claude.enabled) log("Extraction d'actions ignorée : la synthèse Claude est désactivée.", "warn");

  if (settings.claude.enabled) {
    const corpus = clamp(
      [
        `# Corpus du ${date}`,
        agendaMd && `## AGENDA\n\n${agendaMd}`,
        mailsMd && `## EMAILS\n\n${mailsMd}`,
        byWs("personal") && `## NOTION ${settings.notion.personal.label.toUpperCase()}\n\n${byWs("personal")}`,
        byWs("company") && `## NOTION ${settings.notion.company.label.toUpperCase()}\n\n${byWs("company")}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      MAX_CLAUDE_CORPUS_CHARS,
    );
    const r = await analyzeCorpus(
      settings.claude,
      { corpus, today: localDay(), synthesis: { focus: profile.synthesisFocus, memoryContext: memoryMd }, actions: wantsActions },
      fetchImpl,
    );
    for (const e of r.errors) log(`Claude — ${e}`, "warn");
    if (r.brief) {
      sources.push({ type: "text", title: `Brief synthétisé — ${date}`, text: r.brief });
      log("Synthèse Claude générée");
    }
    if (r.actions) {
      actions = r.actions;
      log(`${actions.length} action(s) extraite(s)`);
    }
  }

  // Sources regroupées (limite de sources par notebook + meilleure cohérence de l'Audio Overview)
  if (agendaMd) sources.push({ type: "text", title: `Agenda du jour — ${date}`, text: agendaMd });
  if (memoryMd) sources.push({ type: "text", title: `Suivi depuis le dernier brief — ${date}`, text: memoryMd });
  if (data.mails.length) sources.push({ type: "text", title: `Emails — ${date}`, text: clamp(mailsMd, MAX_SOURCE_CHARS) });
  for (const k of ["personal", "company"] as const) {
    const md = byWs(k);
    if (md) sources.push({ type: "text", title: `${settings.notion[k].label} — ${date}`, text: clamp(md, MAX_SOURCE_CHARS) });
  }
  return { sources, actions };
}

// ─── Mode « Dossier local » (fichiers écrits par Claude Cowork) ───────────────

const processedKey = (profileId: string) => `inboxProcessed:${profileId}`;

export async function processedIds(profileId: string): Promise<string[]> {
  const k = processedKey(profileId);
  return ((await chrome.storage.local.get(k))[k] as string[] | undefined) ?? [];
}

async function markProcessed(profileId: string, id: string): Promise<void> {
  const list = (await processedIds(profileId)).filter((x) => x !== id);
  list.push(id);
  await chrome.storage.local.set({ [processedKey(profileId)]: list.slice(-60) });
}

/**
 * Lit le dossier → diff jour après jour → notebook + podcast.
 * Automatique (heure / surveillance) : un même `id` n'est jamais traité deux fois, un dépôt trop
 * ancien est ignoré. Manuel : retraitement autorisé (action explicite), signalé dans l'historique.
 */
async function runLocalBrief(settings: Settings, profile: BriefProfile, run: BriefingRun, log: Logger, opts: { interactive: boolean }): Promise<BriefingRun> {
  try {
    const { manifest, files } = await readInbox(settings, profile.localFolder.manifestFile);
    log(`Dépôt « ${manifest.id} » lu (${manifest.topics.length} sujet(s), ${files.length} fichier(s))`);

    const already = (await processedIds(profile.id)).includes(manifest.id);
    if (already && !opts.interactive) {
      log("Ce dépôt a déjà été traité — en attente du prochain.", "info");
      return finish(run, "partial");
    }
    if (already) log("Dépôt déjà traité : nouvelle génération demandée manuellement.", "warn");
    const ageH = (Date.now() - Date.parse(manifest.generatedAt)) / 3_600_000;
    if (!opts.interactive && ageH > profile.lookbackHours) {
      log(`Dernier dépôt trop ancien (${Math.round(ageH)} h > ${profile.lookbackHours} h) — vérifie la tâche planifiée Cowork.`, "warn");
      notify(`${profile.name} : pas de dépôt récent`, "Le dossier local n'a pas été mis à jour par Claude Cowork.");
      return finish(run, "partial");
    }

    // Diff quotidien : seul ce qui est nouveau ou a changé est développé
    const today = localDay();
    const { diff, memory } = diffTopics(await getMemory(profile.id), manifest.topics, today);
    if (manifest.topics.length) {
      log(`Suivi : ${diff.fresh.length} nouveau(x), ${diff.changed.length} modifié(s), ${diff.unchanged.length} sans nouveauté, ${diff.resolved.length} résolu(s)`);
    }

    const mask = (t: string) => (settings.claude.redactPII ? redact(t, { amounts: settings.claude.redactAmounts }) : t);
    const date = formatDateFR();
    const sources: SourcePayload[] = [];
    const news = newsToMarkdown(diff);
    if (news) sources.push({ type: "text", title: `Nouveautés & mises à jour — ${date}`, text: mask(news) });
    for (const f of files) sources.push({ type: "text", title: `${f.title} — ${date}`, text: mask(f.text) });
    const follow = followUpToMarkdown(diff);
    if (follow) sources.push({ type: "text", title: `Suivi des sujets ouverts — ${date}`, text: mask(follow) });

    if (!hasNews(diff) && files.length === 0) {
      log("Rien de nouveau depuis le dernier brief — pas de podcast généré (aucune redite).", "warn");
      await saveMemory(profile.id, memory);
      await markProcessed(profile.id, manifest.id);
      notify(`${profile.name} : rien de nouveau`, "Aucun sujet nouveau ou modifié depuis le dernier brief.");
      return finish(run, "success");
    }

    if (manifest.actions.length && profile.extractActions) {
      const added = await enqueueActions(manifest.actions, profile.id, run.id);
      if (added.length) {
        log(`${added.length} action(s) à valider avant envoi au backlog`);
        notify(`✅ ${added.length} action(s) à valider`, "Ouvre Notebooker › Actions pour les envoyer au backlog Notion.", chrome.runtime.getURL("options.html#actions"));
      }
    }

    const audio: AudioOptions = { ...profile.audio, ...(manifest.audio ?? {}) };
    audio.instructions = [audio.instructions, NO_REPEAT_INSTRUCTIONS].filter(Boolean).join(" ");
    const title = manifest.title || profile.notebookTitleTemplate.replace("{date}", date);

    const { notebookId, added, audioStarted } = await createNotebookWithAudio(title, sources, audio, log, async (id) => {
      run.notebookId = id;
      await saveBriefingRun(run);
      await trackBriefNotebook(id, profile.id);
      await setLastPodcast({ notebookId: id, title, profileName: profile.name, createdAt: new Date().toISOString(), status: "generating" });
      // Mémoire et anti-doublon enregistrés dès que le notebook existe
      await saveMemory(profile.id, memory);
      await markProcessed(profile.id, manifest.id);
    });
    run.notebookId = notebookId;
    run.sourcesCount = added;
    let degraded = added < sources.length;
    if (audioStarted) await chrome.alarms.create(`audio:${notebookId}`, { delayInMinutes: 4, periodInMinutes: 3 });
    else {
      degraded = true;
      notify(`${profile.name} prêt (sans audio)`, "Le notebook est créé ; lance l'Audio Overview manuellement.", await notebookUrl(notebookId));
    }
    await applyRetention(profile, log);
    return finish(run, degraded ? "partial" : "success");
  } catch (e) {
    log(msg(e), "error");
    if (!opts.interactive) notify(`${profile.name} : échec`, msg(e));
    return finish(run, "error");
  }
}

// ─── Dernier podcast ──────────────────────────────────────────────────────────

export interface LastPodcast {
  notebookId: string;
  title: string;
  profileName: string;
  createdAt: string;
  status: "generating" | "ready" | "unknown";
}

async function setLastPodcast(p: LastPodcast): Promise<void> {
  await chrome.storage.local.set({ lastPodcast: p });
}

async function updateLastPodcast(notebookId: string, status: LastPodcast["status"]): Promise<void> {
  const { lastPodcast } = (await chrome.storage.local.get("lastPodcast")) as { lastPodcast?: LastPodcast };
  if (lastPodcast?.notebookId === notebookId) await setLastPodcast({ ...lastPodcast, status });
}

export async function getLastPodcast(): Promise<LastPodcast | null> {
  const { lastPodcast } = (await chrome.storage.local.get("lastPodcast")) as { lastPodcast?: LastPodcast };
  return lastPodcast ?? null;
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
    await updateLastPodcast(notebookId, "ready");
    notify("🎧 Ton podcast est prêt", "Clique pour l'écouter dans NotebookLM.", url);
  } else if (n >= AUDIO_MAX_CHECKS) {
    await chrome.alarms.clear(`audio:${notebookId}`);
    await chrome.storage.local.remove(key);
    await updateLastPodcast(notebookId, "unknown");
    notify("Notebooker", "Le notebook est prêt ; l'audio n'a pas été confirmé — vérifie dans NotebookLM.", url);
  }
}

// ─── Rétention ────────────────────────────────────────────────────────────────

interface TrackedNotebook {
  id: string;
  createdAt: string;
  /** Absent sur les entrées v0.1 → rattachées au profil « daily ». */
  profileId?: string;
}

async function trackBriefNotebook(id: string, profileId: string): Promise<void> {
  const { briefNotebooks = [] } = (await chrome.storage.local.get("briefNotebooks")) as { briefNotebooks?: TrackedNotebook[] };
  briefNotebooks.push({ id, createdAt: new Date().toISOString(), profileId });
  await chrome.storage.local.set({ briefNotebooks });
}

/** Ne supprime QUE des notebooks créés par l'extension pour CE profil. */
async function applyRetention(profile: BriefProfile, log: Logger): Promise<void> {
  if (profile.retentionDays <= 0) return;
  const { briefNotebooks = [] } = (await chrome.storage.local.get("briefNotebooks")) as { briefNotebooks?: TrackedNotebook[] };
  const limit = Date.now() - profile.retentionDays * 86_400_000;
  const keep: TrackedNotebook[] = [];
  for (const nb of briefNotebooks) {
    const owner = nb.profileId ?? "daily";
    if (owner !== profile.id || new Date(nb.createdAt).getTime() >= limit) {
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
  // Relecture avant écriture : un autre profil a pu tracer un notebook pendant les suppressions.
  const { briefNotebooks: latest = [] } = (await chrome.storage.local.get("briefNotebooks")) as { briefNotebooks?: TrackedNotebook[] };
  const removed = new Set(briefNotebooks.filter((nb) => !keep.includes(nb)).map((nb) => nb.id));
  await chrome.storage.local.set({ briefNotebooks: latest.filter((nb) => !removed.has(nb.id)) });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function finish(run: BriefingRun, status: BriefingRun["status"]): Promise<BriefingRun> {
  run.status = status;
  run.finishedAt = new Date().toISOString();
  await saveBriefingRun(run);
  return run;
}

export async function lastSuccessfulRun(profileId: string): Promise<Date | null> {
  // Un run en erreur qui a quand même créé un notebook compte : pas de second brief sur le même créneau.
  const r = (await getBriefingRuns()).find(
    (x) => (x.profileId ?? "daily") === profileId && (x.status === "success" || x.status === "partial" || x.notebookId !== null),
  );
  return r ? new Date(r.startedAt) : null;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function notify(title: string, message: string, url?: string): void {
  const id = url ? `open:${url}` : `n:${Date.now()}`;
  chrome.notifications.create(id, { type: "basic", iconUrl: "icon128.png", title, message, priority: 1 });
}
