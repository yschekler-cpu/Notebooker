import type { BackgroundRequest, NotebookSummary } from "../shared/messages";
import { nextRun, shouldCatchUp } from "../shared/schedule";
import { getSettings, mutateSubscriptions, uid } from "../shared/storage";
import type { Subscription, Target } from "../shared/types";
import { getLastPodcast, getRoutinePending, lastSuccessfulRun, notify, onAudioAlarm, onRoutineAlarm, processedIds, routineAlarm, runBriefing } from "./briefing";
import { readRoutineManifest } from "./routine";
import { fileAccessAllowed, readInbox, readManifest } from "./localInbox";
import { dismissActions, inspectBacklog, pushActions } from "./actions";
import { calendarWindow, fetchEvents } from "./calendar";
import { testClaude } from "./claude";
import { fetchRecentMails } from "./gmail";
import { audioStatus, listNotebooks, notebookUrl, playPodcast } from "./notebooklm";
import { NotionClient, clean } from "./notion";
import { connectNotion, disconnectNotion } from "./notionAuth";
import { classify, requiredOrigin } from "./classify";
import { refreshDueSubscriptions, refreshSubscriptionNow, withSyncLock } from "./sync";

const ALARM_BRIEFING_PREFIX = "briefing:";
const ALARM_SYNC = "sync";
const ALARM_INBOX = "inbox";
const SYNC_PERIOD_MIN = 15;

// ─── Cycle de vie ─────────────────────────────────────────────────────────────

// Secrets (tokens Notion / Claude) en storage.local : invisibles pour les content scripts.
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => undefined);

chrome.runtime.onInstalled.addListener(() => void bootstrap());
chrome.runtime.onStartup.addListener(() => void bootstrap(true));

async function bootstrap(checkCatchUp = false): Promise<void> {
  await chrome.alarms.create(ALARM_SYNC, { periodInMinutes: SYNC_PERIOD_MIN, delayInMinutes: 1 });
  await chrome.alarms.clear("briefing"); // alarme unique de la v0.1
  await scheduleBriefings();
  await rebuildContextMenus();
  // Attentes de routine en cours (alarmes perdues au redémarrage de Chrome) : réarmées
  const st = await getSettings();
  for (const p of st.profiles) {
    if (await getRoutinePending(p.id)) await chrome.alarms.create(routineAlarm(p.id), { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  }
  if (checkCatchUp) {
    const s = await getSettings();
    for (const p of s.profiles) {
      if (p.enabled && shouldCatchUp(p.schedule.time, p.schedule.days, await lastSuccessfulRun(p.id))) {
        void runBriefing(p.id, { interactive: false });
      }
    }
  }
}

/** Une alarme one-shot par profil actif, recalculée à chaque run (jours choisis, changements d'heure). */
/** Surveillance du dossier local : active seulement si un profil actif « dossier local » la demande. */
async function scheduleInboxWatch(): Promise<void> {
  const s = await getSettings();
  const watching = s.profiles.some((p) => p.enabled && p.mode === "localFolder" && p.localFolder.watch);
  await chrome.alarms.clear(ALARM_INBOX);
  if (watching && s.localInbox.path.trim()) {
    await chrome.alarms.create(ALARM_INBOX, { periodInMinutes: Math.max(5, s.localInbox.pollMinutes || 10), delayInMinutes: 1 });
  }
}

/** Lance un brief pour chaque profil surveillé dont le manifest a un nouvel id (et récent). */
async function checkInbox(): Promise<{ profileId: string; id: string; started: boolean; reason?: string }[]> {
  const s = await getSettings();
  const out: { profileId: string; id: string; started: boolean; reason?: string }[] = [];
  for (const p of s.profiles.filter((x) => x.enabled && x.mode === "localFolder" && x.localFolder.watch)) {
    try {
      const m = await readManifest(s, p.localFolder.manifestFile);
      const ageH = (Date.now() - Date.parse(m.generatedAt)) / 3_600_000;
      if ((await processedIds(p.id)).includes(m.id)) out.push({ profileId: p.id, id: m.id, started: false, reason: "déjà traité" });
      else if (ageH > p.lookbackHours) out.push({ profileId: p.id, id: m.id, started: false, reason: "trop ancien" });
      else {
        out.push({ profileId: p.id, id: m.id, started: true });
        void runBriefing(p.id, { interactive: false });
      }
    } catch (e) {
      out.push({ profileId: p.id, id: "", started: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

async function scheduleBriefings(): Promise<Record<string, number | null>> {
  await scheduleInboxWatch();
  const s = await getSettings();
  for (const a of await chrome.alarms.getAll()) if (a.name.startsWith(ALARM_BRIEFING_PREFIX)) await chrome.alarms.clear(a.name);
  const next: Record<string, number | null> = {};
  for (const p of s.profiles) {
    const when = p.enabled ? nextRun(p.schedule.time, p.schedule.days) : null;
    next[p.id] = when?.getTime() ?? null;
    if (when) await chrome.alarms.create(`${ALARM_BRIEFING_PREFIX}${p.id}`, { when: when.getTime() });
  }
  return next;
}

async function scheduleBriefing(profileId: string): Promise<void> {
  const p = (await getSettings()).profiles.find((x) => x.id === profileId);
  await chrome.alarms.clear(`${ALARM_BRIEFING_PREFIX}${profileId}`);
  const when = p?.enabled ? nextRun(p.schedule.time, p.schedule.days) : null;
  if (when) await chrome.alarms.create(`${ALARM_BRIEFING_PREFIX}${profileId}`, { when: when.getTime() });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(ALARM_BRIEFING_PREFIX)) {
    const id = alarm.name.slice(ALARM_BRIEFING_PREFIX.length);
    // Replanifie AVANT d'exécuter : un run bloqué ou un SW tué ne doit pas supprimer le créneau suivant.
    void scheduleBriefing(id).then(() => runBriefing(id, { interactive: false }));
  } else if (alarm.name.startsWith("routine:")) {
    void onRoutineAlarm(alarm.name.slice("routine:".length));
  } else if (alarm.name === ALARM_INBOX) {
    void checkInbox();
  } else if (alarm.name === ALARM_SYNC) {
    void refreshDueSubscriptions();
  } else if (alarm.name.startsWith("audio:")) {
    const id = alarm.name.slice(6);
    void notebookUrl(id).then((url) => onAudioAlarm(id, audioStatus, url));
  }
});

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("open:")) void chrome.tabs.create({ url: id.slice(5) });
  chrome.notifications.clear(id);
});

// ─── Menus contextuels ────────────────────────────────────────────────────────

async function knownNotebooks(): Promise<NotebookSummary[]> {
  const { knownNotebooks: list = [] } = (await chrome.storage.local.get("knownNotebooks")) as { knownNotebooks?: NotebookSummary[] };
  return list;
}

let menuChain: Promise<void> = Promise.resolve();

/** Sérialisé : deux reconstructions concurrentes produiraient des « duplicate id ». */
function rebuildContextMenus(): Promise<void> {
  menuChain = menuChain.then(doRebuildContextMenus, doRebuildContextMenus).catch((e: unknown) => console.warn("contextMenus", e));
  return menuChain;
}

function createMenu(props: chrome.contextMenus.CreateProperties): void {
  chrome.contextMenus.create(props, () => void chrome.runtime.lastError); // lastError consommé : pas de bruit console
}

async function doRebuildContextMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  const contexts = ["page", "link", "video"] as [`${chrome.contextMenus.ContextType}`, ...`${chrome.contextMenus.ContextType}`[]];
  createMenu({ id: "root", title: "Notebooker : ajouter à…", contexts });
  const nbs = (await knownNotebooks()).slice(0, 20);
  if (nbs.length === 0) {
    createMenu({ id: "hint", parentId: "root", title: "Ouvre NotebookLM une fois pour lister tes notebooks", contexts, enabled: false });
  }
  for (const nb of nbs) createMenu({ id: `nb|${nb.id}`, parentId: "root", title: truncate(`📓 ${nb.title}`, 60), contexts });
  const s = await getSettings();
  for (const k of ["personal", "company"] as const) {
    for (const raw of s.notion[k].briefingRootIds.slice(0, 5)) {
      const db = clean(raw);
      createMenu({ id: `notion|${k}|${db}`, parentId: "root", title: `🗂️ ${s.notion[k].label} · ${db.slice(0, 8)}…`, contexts });
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const isHttp = (u?: string) => !!u && /^https?:\/\//.test(u);
  // srcUrl d'une vidéo est souvent un blob: → on retombe sur l'URL de la page.
  const url = [info.linkUrl, info.srcUrl, info.pageUrl, tab?.url].find(isHttp);
  if (!url) return;
  // Clic sur un lien : le titre de l'onglet n'est PAS celui du lien → texte sélectionné ou URL.
  const title = info.linkUrl ? info.selectionText?.trim() || info.linkUrl : (tab?.title ?? url);
  const [kind, a, b] = String(info.menuItemId).split("|");
  if (kind === "nb" && a) {
    void knownNotebooks().then((nbs) => {
      const label = nbs.find((n) => n.id === a)?.title ?? a;
      return addFromUrl(url, title, { kind: "notebooklm", notebookId: a, label }, 0);
    });
  } else if (kind === "notion" && (a === "personal" || a === "company") && b) {
    void getSettings().then((s) =>
      addFromUrl(url, title, { kind: "notion_database", databaseId: b, workspace: a, label: `${s.notion[a].label} · ${b.slice(0, 8)}…` }, 0, a),
    );
  }
});

// ─── Ajout de sources ─────────────────────────────────────────────────────────

function sameTarget(x: Target, y: Target): boolean {
  return x.kind === "notebooklm" && y.kind === "notebooklm"
    ? x.notebookId === y.notebookId
    : x.kind === "notion_database" && y.kind === "notion_database" && x.databaseId === y.databaseId && x.workspace === y.workspace;
}

async function addFromUrl(url: string, title: string, target: Target, refreshMinutes: number, workspace?: "personal" | "company"): Promise<void> {
  const { kind, ref } = classify(url);
  const freq = kind === "feed" && refreshMinutes <= 0 ? 360 : refreshMinutes;

  // Permission hôte requise (flux, page suivie) : sans elle, le premier passage échouerait.
  const origin = requiredOrigin(url, freq);
  if (origin && !(await chrome.permissions.contains({ origins: [origin] }))) {
    const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
    if (!granted) {
      notify("Notebooker : permission requise", `Autorise l'accès à ${new URL(origin.replace("/*", "")).host} via le popup Notebooker pour suivre cette source.`);
      return;
    }
  }

  const outcome = await mutateSubscriptions((subs) => {
    const existing = subs.find((s) => s.ref === ref && sameTarget(s.target, target));
    if (existing) {
      // Déjà suivi vers cette cible : mise à jour de la fréquence au lieu d'un doublon.
      const updated: Subscription = { ...existing, refreshMinutes: freq, enabled: true };
      return { subs: subs.map((s) => (s.id === existing.id ? updated : s)), result: { sub: updated, alreadyPushed: !!existing.lastFingerprint } };
    }
    const sub: Subscription = {
      id: uid(),
      kind,
      ref,
      title,
      workspace: kind === "notion_page" ? (workspace ?? "company") : undefined,
      target,
      refreshMinutes: freq,
      lastCheckedAt: null,
      lastFingerprint: null,
      seenItemIds: [],
      enabled: true,
      lastError: null,
    };
    return { subs: [...subs, sub], result: { sub, alreadyPushed: false } };
  });
  if (!outcome) return;
  const { sub, alreadyPushed } = outcome;
  const follow = sub.refreshMinutes > 0 ? ` — suivi toutes les ${sub.refreshMinutes} min` : "";
  if (alreadyPushed && sub.kind !== "url") {
    notify("Notebooker", `Déjà présent dans « ${target.label} »${follow}.`);
    return;
  }
  const r = await refreshSubscriptionNow(sub.id);
  if (r.error) notify("Notebooker : échec d'ajout", r.error.slice(0, 250));
  else if (alreadyPushed && r.pushed === 0) notify("Notebooker", `Déjà présent dans « ${target.label} »${follow}.`);
  else notify("Notebooker", `${r.pushed} source(s) ajoutée(s) à « ${target.label} »${follow}.`);
}

// ─── Routeur de messages (popup / options / content) ──────────────────────────

chrome.runtime.onMessage.addListener((req: BackgroundRequest, sender, sendResponse) => {
  if (!req || !("type" in req)) return false;
  // Seules les pages de l'extension (popup, options) sont de confiance. Un content script — qui tourne
  // dans une page web — ne peut qu'informer des notebooks visibles : aucune action sensible.
  const trusted = sender.id === chrome.runtime.id && (sender.url ?? "").startsWith(chrome.runtime.getURL(""));
  if (!trusted && req.type !== "notebooksSeen") {
    sendResponse({ ok: false, error: "forbidden" });
    return false;
  }
  handle(req)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true;
});

async function handle(req: BackgroundRequest): Promise<unknown> {
  switch (req.type) {
    case "addCurrentPage": {
      const ws = req.target.kind === "notion_database" ? req.target.workspace : undefined;
      void addFromUrl(req.url, req.title, req.target, req.refreshMinutes, ws);
      return "queued";
    }
    case "runBriefingNow": {
      const s = await getSettings();
      const id = req.profileId ?? s.profiles[0]?.id;
      if (!id) throw new Error("Aucun profil de brief.");
      return runBriefing(id, { interactive: true });
    }
    case "refreshSubscriptionsNow":
      return refreshDueSubscriptions(true);
    case "listNotebooks": {
      const list = await listNotebooks();
      await chrome.storage.local.set({ knownNotebooks: list });
      await rebuildContextMenus();
      return list;
    }
    case "notebooksSeen": {
      // Seul message accepté depuis une page web : payload validé (UUID, titres bornés, liste bornée).
      if (!Array.isArray(req.notebooks)) return false;
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      req.notebooks = req.notebooks
        .filter((n) => n && typeof n.id === "string" && UUID.test(n.id) && typeof n.title === "string")
        .slice(0, 300)
        .map((n) => ({ id: n.id.toLowerCase(), title: n.title.replace(/\s+/g, " ").trim().slice(0, 120) }));
      if (req.notebooks.length === 0) return false; // une page vide ne doit pas effacer la liste connue
      const prev = await knownNotebooks();
      const changed = JSON.stringify(prev) !== JSON.stringify(req.notebooks);
      if (changed) {
        await chrome.storage.local.set({ knownNotebooks: req.notebooks });
        await rebuildContextMenus();
      }
      return changed;
    }
    case "rescheduleBriefing": {
      const next = await scheduleBriefings();
      await rebuildContextMenus();
      return next;
    }
    case "routineCheckNow":
      return onRoutineAlarm(req.profileId);
    case "inspectRoutineInbox": {
      const s = await getSettings();
      const p = s.profiles.find((x) => x.id === req.profileId && x.mode === "routine");
      if (!p) throw new Error("Profil non configuré en mode « Routine Claude ».");
      const m = await readRoutineManifest(s, p);
      if (!m) return "Page de dépôt lisible — aucun manifest déposé pour l'instant.";
      return `Page de dépôt lisible — dernier manifest « ${m.id} » du ${new Date(m.generatedAt).toLocaleString("fr-FR")} (${m.topics.length} sujet(s))${m.requestId ? `, requestId ${m.requestId}` : ""}`;
    }
    case "checkInboxNow":
      return checkInbox();
    case "inspectInbox": {
      const s = await getSettings();
      const p = s.profiles.find((x) => x.id === req.profileId) ?? s.profiles.find((x) => x.mode === "localFolder");
      if (!p) throw new Error("Aucun profil en mode « Dossier local ».");
      const { manifest, files } = await readInbox(s, p.localFolder.manifestFile);
      const done = (await processedIds(p.id)).includes(manifest.id);
      return `Dépôt « ${manifest.id} » du ${new Date(manifest.generatedAt).toLocaleString("fr-FR")} : ${manifest.topics.length} sujet(s), ${files.length} fichier(s)${manifest.actions.length ? `, ${manifest.actions.length} action(s)` : ""}${done ? " — déjà traité" : " — prêt à traiter"}`;
    }
    case "fileAccessStatus":
      return fileAccessAllowed();
    case "getLastPodcast":
      return getLastPodcast();
    case "playLastPodcast": {
      const last = await getLastPodcast();
      if (!last) throw new Error("Aucun podcast généré pour l'instant.");
      return playPodcast(last.notebookId);
    }
    case "notionOAuth":
      return req.op === "connect" ? connectNotion(req.workspace) : disconnectNotion(req.workspace);
    case "testCalendar": {
      const events = await fetchEvents((await getSettings()).calendar, calendarWindow(), true);
      return `${events.length} réunion(s) lisible(s) sur la fenêtre du prochain brief`;
    }
    case "inspectBacklog": {
      const r = await inspectBacklog(await getSettings());
      const m = r.mapping;
      const fields = [`titre → « ${m.title} »`, m.due && `échéance → « ${m.due} »`, m.priority && `priorité → « ${m.priority.name} »`, m.status && `statut → « ${m.status.name} »`, m.source && `source → « ${m.source} »`].filter(Boolean);
      return `Base « ${r.title} » : ${fields.join(", ")}${r.warnings.length ? ` ⚠️ ${r.warnings.join(" ")}` : ""}`;
    }
    case "actionsOp":
      if (req.op === "push") return pushActions(req.ids, req.edits);
      await dismissActions(req.ids);
      return { dismissed: req.ids.length };
    case "testNotion":
      return new NotionClient((await getSettings()).notion[req.workspace], req.workspace).me();
    case "testGmail": {
      const mails = await fetchRecentMails({ query: "newer_than:1d", max: 3, since: new Date(Date.now() - 86_400_000), interactive: true });
      return `${mails.length} email(s) lisible(s)`;
    }
    case "testClaude":
      return testClaude((await getSettings()).claude);
    case "subscriptionOp":
      return withSyncLock(() =>
        mutateSubscriptions((subs) => {
          if (req.op === "add") return subs.some((x) => x.ref === req.sub.ref && sameTarget(x.target, req.sub.target)) ? subs : [...subs, req.sub];
          if (req.op === "delete") return subs.filter((x) => x.id !== req.id);
          return subs.map((x) => (x.id === req.id ? { ...x, enabled: !x.enabled } : x));
        }),
      );
  }
}
