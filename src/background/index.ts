import type { BackgroundRequest, NotebookSummary } from "../shared/messages";
import { nextDailyRun, shouldCatchUp } from "../shared/schedule";
import { getSettings, getSubscriptions, saveSubscriptions, uid } from "../shared/storage";
import type { Subscription, Target } from "../shared/types";
import { lastSuccessfulRun, notify, onAudioAlarm, runBriefing } from "./briefing";
import { testClaude } from "./claude";
import { fetchRecentMails } from "./gmail";
import { audioStatus, listNotebooks, notebookUrl } from "./notebooklm";
import { NotionClient } from "./notion";
import { classify } from "./classify";
import { refreshDueSubscriptions, refreshOne } from "./sync";

const ALARM_BRIEFING = "briefing";
const ALARM_SYNC = "sync";
const SYNC_PERIOD_MIN = 15;

// ─── Cycle de vie ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => void bootstrap());
chrome.runtime.onStartup.addListener(() => void bootstrap(true));

async function bootstrap(checkCatchUp = false): Promise<void> {
  await chrome.alarms.create(ALARM_SYNC, { periodInMinutes: SYNC_PERIOD_MIN, delayInMinutes: 1 });
  await scheduleBriefing();
  await rebuildContextMenus();
  if (checkCatchUp) {
    const s = await getSettings();
    if (s.briefing.enabled && shouldCatchUp(s.briefing.time, s.briefing.weekdaysOnly, await lastSuccessfulRun())) {
      void runBriefing({ interactive: false });
    }
  }
}

async function scheduleBriefing(): Promise<void> {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM_BRIEFING);
  if (!s.briefing.enabled) return;
  // Alarme one-shot recalculée à chaque run : gère jours ouvrés et changements d'heure (DST).
  await chrome.alarms.create(ALARM_BRIEFING, { when: nextDailyRun(s.briefing.time, s.briefing.weekdaysOnly).getTime() });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_BRIEFING) {
    void runBriefing({ interactive: false }).finally(() => void scheduleBriefing());
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

async function rebuildContextMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  const contexts = ["page", "link", "video"] as [`${chrome.contextMenus.ContextType}`, ...`${chrome.contextMenus.ContextType}`[]];
  chrome.contextMenus.create({ id: "root", title: "Notebooker : ajouter à…", contexts });
  const nbs = (await knownNotebooks()).slice(0, 20);
  if (nbs.length === 0) {
    chrome.contextMenus.create({ id: "hint", parentId: "root", title: "Ouvre NotebookLM une fois pour lister tes notebooks", contexts, enabled: false });
  }
  for (const nb of nbs) chrome.contextMenus.create({ id: `nb:${nb.id}`, parentId: "root", title: `📓 ${nb.title}`.slice(0, 60), contexts });
  const s = await getSettings();
  for (const k of ["personal", "company"] as const) {
    for (const db of s.notion[k].briefingRootIds.slice(0, 5)) {
      chrome.contextMenus.create({ id: `notion:${k}:${db}`, parentId: "root", title: `🗂️ ${s.notion[k].label} · ${db.slice(0, 8)}…`, contexts });
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl ?? info.srcUrl ?? info.pageUrl ?? tab?.url;
  const title = (info.linkUrl ? info.selectionText : tab?.title) ?? url ?? "Source";
  if (!url) return;
  const id = String(info.menuItemId);
  let target: Target | null = null;
  if (id.startsWith("nb:")) {
    void knownNotebooks().then(async (nbs) => {
      const nb = nbs.find((n) => n.id === id.slice(3));
      target = { kind: "notebooklm", notebookId: id.slice(3), label: nb?.title ?? id.slice(3) };
      await addFromUrl(url, title, target, 0);
    });
  } else if (id.startsWith("notion:")) {
    const [, ws, db] = id.split(":") as [string, "personal" | "company", string];
    target = { kind: "notion_database", databaseId: db, workspace: ws, label: db };
    void addFromUrl(url, title, target, 0);
  }
});

// ─── Ajout de sources ─────────────────────────────────────────────────────────

async function addFromUrl(url: string, title: string, target: Target, refreshMinutes: number, workspace?: "personal" | "company"): Promise<void> {
  const { kind, ref } = classify(url);
  const sub: Subscription = {
    id: uid(),
    kind,
    ref,
    title,
    workspace: kind === "notion_page" ? (workspace ?? "company") : undefined,
    target,
    refreshMinutes: kind === "feed" && refreshMinutes <= 0 ? 360 : refreshMinutes,
    lastCheckedAt: null,
    lastFingerprint: null,
    seenItemIds: [],
    enabled: true,
    lastError: null,
  };
  await saveSubscriptions([...(await getSubscriptions()), sub]);
  try {
    const n = await refreshOne(sub, await getSettings());
    notify("Notebooker", `${n} source(s) ajoutée(s) à « ${target.label} »${sub.refreshMinutes > 0 ? ` — suivi toutes les ${sub.refreshMinutes} min` : ""}.`);
  } catch (e) {
    notify("Notebooker : échec d'ajout", e instanceof Error ? e.message : String(e));
  }
}

// ─── Routeur de messages (popup / options / content) ──────────────────────────

chrome.runtime.onMessage.addListener((req: BackgroundRequest, _sender, sendResponse) => {
  if (!req || !("type" in req)) return false;
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
    case "runBriefingNow":
      return runBriefing({ interactive: true });
    case "refreshSubscriptionsNow":
      return refreshDueSubscriptions(true);
    case "listNotebooks": {
      const list = await listNotebooks();
      await chrome.storage.local.set({ knownNotebooks: list });
      await rebuildContextMenus();
      return list;
    }
    case "notebooksSeen": {
      const prev = await knownNotebooks();
      const changed = JSON.stringify(prev) !== JSON.stringify(req.notebooks);
      if (changed) {
        await chrome.storage.local.set({ knownNotebooks: req.notebooks });
        await rebuildContextMenus();
      }
      return changed;
    }
    case "rescheduleBriefing":
      await scheduleBriefing();
      await rebuildContextMenus();
      return (await chrome.alarms.get(ALARM_BRIEFING))?.scheduledTime ?? null;
    case "testNotion":
      return new NotionClient((await getSettings()).notion[req.workspace]).me();
    case "testGmail": {
      const mails = await fetchRecentMails({ query: "newer_than:1d", max: 3, since: new Date(Date.now() - 86_400_000), interactive: true });
      return `${mails.length} email(s) lisible(s)`;
    }
    case "testClaude":
      return testClaude((await getSettings()).claude);
  }
}
