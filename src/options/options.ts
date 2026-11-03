import { classify } from "../background/classify";
import type { NotebookSummary } from "../shared/messages";
import { exportOrganization, importOrganization } from "../shared/org";
import { getBriefingRuns, getFolders, getNotebookMetas, getSettings, getSubscriptions, saveSettings, uid } from "../shared/storage";
import type { Settings, Subscription, SubscriptionKind, Target } from "../shared/types";

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const lines = (id: string) => $<HTMLTextAreaElement>(id).value.split("\n").map((l) => l.trim()).filter(Boolean);
const say = (t: string, cls = "") => {
  const m = $("msg");
  m.textContent = t;
  m.className = `hint ${cls}`;
};

async function send<T>(msg: unknown): Promise<T> {
  const r = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: T; error?: string };
  if (!r?.ok) throw new Error(r?.error ?? "Erreur inconnue");
  return r.data as T;
}

function fill(s: Settings): void {
  $("b_enabled").checked = s.briefing.enabled;
  $("b_time").value = s.briefing.time;
  $("b_lookback").value = String(s.briefing.lookbackHours);
  $("b_retention").value = String(s.briefing.retentionDays);
  $("b_weekdays").checked = s.briefing.weekdaysOnly;
  $("b_title").value = s.briefing.notebookTitleTemplate;
  $<HTMLTextAreaElement>("b_audio").value = s.briefing.audioInstructions;
  $("b_query").value = s.briefing.gmailQuery;
  $("b_max").value = String(s.briefing.gmailMaxMessages);
  $<HTMLTextAreaElement>("b_exclusions").value = s.briefing.gmailExclusions.join("\n");

  $("n_p_label").value = s.notion.personal.label;
  $("n_p_token").value = s.notion.personal.token;
  $<HTMLTextAreaElement>("n_p_roots").value = s.notion.personal.briefingRootIds.join("\n");
  $("n_c_label").value = s.notion.company.label;
  $("n_c_token").value = s.notion.company.token;
  $<HTMLTextAreaElement>("n_c_roots").value = s.notion.company.briefingRootIds.join("\n");

  $("c_enabled").checked = s.claude.enabled;
  $<HTMLSelectElement>("c_mode").value = s.claude.authMode;
  $("c_model").value = s.claude.model;
  $("c_oauth").value = s.claude.oauthToken;
  $("c_key").value = s.claude.apiKey;
  $("c_redact").checked = s.claude.redactPII;
  $("c_amounts").checked = s.claude.redactAmounts;

  $("l_account").value = String(s.notebooklm.accountIndex);
  $("l_bg").checked = s.notebooklm.backgroundTabs;
}

function read(prev: Settings): Settings {
  return {
    briefing: {
      ...prev.briefing,
      enabled: $("b_enabled").checked,
      time: $("b_time").value || "07:30",
      lookbackHours: Number($("b_lookback").value) || 24,
      retentionDays: Number($("b_retention").value) || 0,
      weekdaysOnly: $("b_weekdays").checked,
      notebookTitleTemplate: $("b_title").value,
      audioInstructions: $<HTMLTextAreaElement>("b_audio").value,
      gmailQuery: $("b_query").value,
      gmailMaxMessages: Number($("b_max").value) || 40,
      gmailExclusions: lines("b_exclusions"),
    },
    notion: {
      personal: { label: $("n_p_label").value, token: $("n_p_token").value.trim(), briefingRootIds: lines("n_p_roots") },
      company: { label: $("n_c_label").value, token: $("n_c_token").value.trim(), briefingRootIds: lines("n_c_roots") },
    },
    claude: {
      ...prev.claude,
      enabled: $("c_enabled").checked,
      authMode: $<HTMLSelectElement>("c_mode").value as Settings["claude"]["authMode"],
      model: $("c_model").value.trim() || "claude-opus-5-5",
      oauthToken: $("c_oauth").value.trim(),
      apiKey: $("c_key").value.trim(),
      redactPII: $("c_redact").checked,
      redactAmounts: $("c_amounts").checked,
    },
    notebooklm: { accountIndex: Number($("l_account").value) || 0, backgroundTabs: $("l_bg").checked },
  };
}

async function targets(): Promise<Target[]> {
  const { knownNotebooks = [] } = (await chrome.storage.local.get("knownNotebooks")) as { knownNotebooks?: NotebookSummary[] };
  const s = await getSettings();
  return [
    ...knownNotebooks.map((n): Target => ({ kind: "notebooklm", notebookId: n.id, label: n.title })),
    ...(["personal", "company"] as const).flatMap((k) =>
      s.notion[k].briefingRootIds.map((db): Target => ({ kind: "notion_database", databaseId: db, workspace: k, label: `${s.notion[k].label} · ${db.slice(0, 8)}…` })),
    ),
  ];
}

async function renderSubs(): Promise<void> {
  const subs = await getSubscriptions();
  const tb = $("subs");
  tb.innerHTML = subs.length
    ? subs
        .map(
          (s) => `<tr>
      <td>${esc(s.title)}<div class="hint">${esc(s.ref.slice(0, 80))}</div>${s.lastError ? `<div class="error">${esc(s.lastError.slice(0, 200))}</div>` : ""}</td>
      <td>${s.kind}</td><td>${esc(s.target.label)}</td>
      <td>${s.refreshMinutes > 0 ? `${s.refreshMinutes} min` : "unique"}</td>
      <td>${s.lastCheckedAt ? new Date(s.lastCheckedAt).toLocaleString("fr-FR") : "—"}</td>
      <td><button data-toggle="${s.id}">${s.enabled ? "Pause" : "Reprendre"}</button> <button data-del="${s.id}">Supprimer</button></td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="hint">Aucun abonnement. Ajoute une page via le popup ou le clic droit.</td></tr>`;
  tb.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) => {
    b.onclick = async () => {
      await send({ type: "subscriptionOp", op: "delete", id: b.dataset.del! });
      void renderSubs();
    };
  });
  tb.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((b) => {
    b.onclick = async () => {
      await send({ type: "subscriptionOp", op: "toggle", id: b.dataset.toggle! });
      void renderSubs();
    };
  });

  const ts = await targets();
  $<HTMLSelectElement>("s_target").innerHTML = ts.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join("");
  $("s_add").onclick = async () => {
    const raw = $("s_ref").value.trim();
    const target = ts[Number($<HTMLSelectElement>("s_target").value)];
    if (!raw || !target) return say("URL et cible requises.", "error");
    const chosen = $<HTMLSelectElement>("s_kind").value as SubscriptionKind | "auto";
    const auto = classify(raw);
    const kind = chosen === "auto" ? auto.kind : chosen;
    const ref = chosen === "auto" ? auto.ref : raw;
    if ((kind === "feed" || kind === "url") && /^https?:/.test(ref)) {
      const ok = await chrome.permissions.request({ origins: [new URL(ref).origin + "/*"] });
      if (!ok) return say("Permission d'accès au site refusée.", "error");
    }
    const sub: Subscription = {
      id: uid(), kind, ref, title: raw, target,
      workspace: kind.startsWith("notion") ? ($<HTMLSelectElement>("s_ws").value as "personal" | "company") : undefined,
      refreshMinutes: Math.max(15, Number($("s_freq").value) || 360),
      lastCheckedAt: null, lastFingerprint: null, seenItemIds: [], enabled: true, lastError: null,
    };
    await send({ type: "subscriptionOp", op: "add", sub });
    say("Abonnement ajouté — premier passage à la prochaine synchro (≤ 15 min).", "ok");
    void renderSubs();
  };
}

async function renderRuns(): Promise<void> {
  const runs = await getBriefingRuns();
  $("runs").innerHTML = runs.length
    ? runs
        .slice(0, 10)
        .map(
          (r) => `<details><summary><span class="${r.status === "success" ? "ok" : r.status === "error" ? "error" : "warn"}">●</span>
        ${new Date(r.startedAt).toLocaleString("fr-FR")} — ${r.status} — ${r.sourcesCount} sources</summary>
        <ul>${r.steps.map((s) => `<li class="${s.level}">${new Date(s.at).toLocaleTimeString("fr-FR")} ${esc(s.message)}</li>`).join("")}</ul></details>`,
        )
        .join("")
    : `<p class="hint">Aucun brief exécuté.</p>`;
}

async function renderOrgStats(): Promise<void> {
  const [folders, metas] = await Promise.all([getFolders(), getNotebookMetas()]);
  const list = Object.values(metas);
  $("orgStats").textContent = `${folders.length} dossiers · ${list.filter((m) => m.folderId).length} notebooks classés · ${list.filter((m) => m.pinned).length} épinglés`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function init(): Promise<void> {
  let settings = await getSettings();
  fill(settings);

  $("save").onclick = async () => {
    try {
      settings = read(settings);
      await saveSettings(settings);
      const next = await send<number | null>({ type: "rescheduleBriefing" });
      say(next ? `Enregistré. Prochain brief : ${new Date(next).toLocaleString("fr-FR")}` : "Enregistré.", "ok");
      void renderSubs();
    } catch (e) {
      say(String(e instanceof Error ? e.message : e), "error");
    }
  };

  $("runNow").onclick = () => {
    say("Brief lancé… suivi dans l'historique ci-dessous.");
    void send({ type: "runBriefingNow" }).finally(() => void renderRuns());
  };

  document.querySelectorAll<HTMLButtonElement>("[data-test]").forEach((b) => {
    b.onclick = async () => {
      await saveSettings(read(settings));
      const t = b.dataset.test!;
      const msg =
        t === "notion-personal" ? { type: "testNotion", workspace: "personal" }
        : t === "notion-company" ? { type: "testNotion", workspace: "company" }
        : t === "gmail" ? { type: "testGmail" }
        : { type: "testClaude" };
      say("Test en cours…");
      try {
        say(`✅ ${String(await send(msg))}`, "ok");
      } catch (e) {
        say(`❌ ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    };
  });

  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    if (c.briefingRuns) void renderRuns();
    if (c.subscriptions) void renderSubs();
  });

  $("exportOrg").onclick = async () => {
    const blob = new Blob([JSON.stringify(await exportOrganization(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `notebooker-organisation-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $("importOrgBtn").onclick = () => $("importOrg").click();
  $("importOrg").onchange = async () => {
    const file = $("importOrg").files?.[0];
    if (!file) return;
    try {
      const r = await importOrganization(JSON.parse(await file.text()));
      say(`Import OK : ${r.folders} dossiers, ${r.notebooks} notebooks.`, "ok");
      void renderOrgStats();
    } catch (e) {
      say(`Import refusé : ${e instanceof Error ? e.message : String(e)}`, "error");
    }
    $("importOrg").value = "";
  };

  await Promise.all([renderSubs(), renderRuns(), renderOrgStats()]);
}

void init();
