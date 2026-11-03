import { requiredOrigin } from "../background/classify";
import type { NotebookSummary } from "../shared/messages";
import { getBriefingRuns, getSettings } from "../shared/storage";
import type { Target } from "../shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (t: string) => ($("status").textContent = t);

async function send<T>(msg: unknown): Promise<T> {
  const r = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: T; error?: string };
  if (!r?.ok) throw new Error(r?.error ?? "Erreur inconnue");
  return r.data as T;
}

let targets: Target[] = [];

async function loadTargets(): Promise<void> {
  const { knownNotebooks = [] } = (await chrome.storage.local.get("knownNotebooks")) as { knownNotebooks?: NotebookSummary[] };
  const s = await getSettings();
  targets = [
    ...knownNotebooks.map((n): Target => ({ kind: "notebooklm", notebookId: n.id, label: n.title })),
    ...(["personal", "company"] as const).flatMap((k) =>
      s.notion[k].briefingRootIds.map((db): Target => ({ kind: "notion_database", databaseId: db, workspace: k, label: `${s.notion[k].label} · ${db.slice(0, 8)}…` })),
    ),
  ];
  const { lastTargetKey } = (await chrome.storage.local.get("lastTargetKey")) as { lastTargetKey?: string };
  $<HTMLSelectElement>("target").innerHTML = targets.length
    ? targets.map((t, i) => `<option value="${i}" ${targetKey(t) === lastTargetKey ? "selected" : ""}>${t.kind === "notebooklm" ? "📓" : "🗂️"} ${escapeHtml(t.label)}</option>`).join("")
    : `<option disabled selected>Aucune cible — clique « Lister mes notebooks »</option>`;
}

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("page").textContent = tab?.title ?? tab?.url ?? "";
  if (tab?.favIconUrl && /^https:/.test(tab.favIconUrl)) {
    const img = $<HTMLImageElement>("favicon");
    img.src = tab.favIconUrl;
    img.hidden = false;
  }
  await loadTargets();

  const runs = await getBriefingRuns();
  if (runs[0]) status(`Dernier brief : ${new Date(runs[0].startedAt).toLocaleString("fr-FR")} — ${runs[0].status}`);

  $("add").onclick = async () => {
    const idx = Number($<HTMLSelectElement>("target").value);
    const target = targets[idx];
    if (!tab?.url || !target) return status("Choisis une cible.");
    const refreshMinutes = Number($<HTMLSelectElement>("refresh").value);
    // Permission hôte = exactement l'origine que le service worker devra lire (geste utilisateur requis).
    const origin = requiredOrigin(tab.url, refreshMinutes);
    if (origin && !(await chrome.permissions.contains({ origins: [origin] }))) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) return status("Permission refusée : impossible de suivre les mises à jour de ce site.");
    }
    await chrome.storage.local.set({ lastTargetKey: targetKey(target) });
    await send({ type: "addCurrentPage", url: tab.url, title: tab.title ?? tab.url, target, refreshMinutes });
    status("Ajout en cours… (notification à la fin)");
  };

  $("reloadNb").onclick = async () => {
    status("Lecture de NotebookLM…");
    try {
      const list = await send<NotebookSummary[]>({ type: "listNotebooks" });
      await loadTargets();
      status(`${list.length} notebooks trouvés.`);
    } catch (e) {
      status(String(e instanceof Error ? e.message : e));
    }
  };

  const settings = await getSettings();
  $<HTMLSelectElement>("briefProfile").innerHTML = settings.profiles
    .map((p) => `<option value="${escapeHtml(p.id)}">${p.enabled ? "●" : "○"} ${escapeHtml(p.name)}</option>`)
    .join("");
  const { actionItems = [] } = (await chrome.storage.local.get("actionItems")) as { actionItems?: { status: string }[] };
  const pendingActions = actionItems.filter((a) => a.status === "pending").length;
  if (pendingActions) status(`✅ ${pendingActions} action(s) à valider dans les réglages.`);

  $("brief").onclick = async () => {
    status("Brief en cours (2-5 min)… tu peux fermer ce popup, une notification suivra.");
    void send<{ skipped?: string; status?: string }>({ type: "runBriefingNow", profileId: $<HTMLSelectElement>("briefProfile").value })
      .then((r) => status(r.skipped ?? `Brief terminé : ${r.status ?? "?"}`))
      .catch((e: unknown) => status(String(e instanceof Error ? e.message : e)));
  };

  $("sync").onclick = async () => {
    status("Synchronisation…");
    try {
      const r = await send<{ checked: number; pushed: number; errors: number }>({ type: "refreshSubscriptionsNow" });
      status(`${r.checked} abonnements vérifiés, ${r.pushed} sources poussées, ${r.errors} erreurs.`);
    } catch (e) {
      status(String(e instanceof Error ? e.message : e));
    }
  };
}

/** Clé stable d'une cible (l'index change quand l'ordre des notebooks change). */
function targetKey(t: Target): string {
  return t.kind === "notebooklm" ? `nb:${t.notebookId}` : `notion:${t.workspace}:${t.databaseId}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

void init();
