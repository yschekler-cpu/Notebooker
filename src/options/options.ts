import { classify } from "../background/classify";
import type { NotebookSummary } from "../shared/messages";
import { exportOrganization, importOrganization } from "../shared/org";
import { PROFILE_TEMPLATES, normalizeProfile } from "../shared/profiles";
import { DAY_LABELS } from "../shared/schedule";
import { getActions, getBriefingRuns, getFolders, getNotebookMetas, getSettings, getSubscriptions, saveSettings, uid } from "../shared/storage";
import type { ActionPriority, AudioFormat, AudioLength, BriefProfile, Settings, Subscription, SubscriptionKind, Target } from "../shared/types";

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;
const lines = (id: string) => $<HTMLTextAreaElement>(id).value.split("\n").map((l) => l.trim()).filter(Boolean);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const say = (t: string, cls = "") => {
  const m = $("msg");
  m.textContent = t;
  m.className = `toast ${cls}`;
  // Le toast disparaît seul, sauf pendant une opération en cours (« … ») ou sur une erreur.
  clearTimeout(toastTimer);
  if (!/…$/.test(t) && cls !== "error") toastTimer = setTimeout(() => (m.textContent = ""), 6000);
};

async function send<T>(msg: unknown): Promise<T> {
  const r = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: T; error?: string };
  if (!r?.ok) throw new Error(r?.error ?? "Erreur inconnue");
  return r.data as T;
}

// ─── Réglages globaux ─────────────────────────────────────────────────────────

function fill(s: Settings): void {
  $<HTMLTextAreaElement>("x_exclusions").value = s.compliance.gmailExclusions.join("\n");
  $<HTMLTextAreaElement>("k_ids").value = s.calendar.calendarIds.join("\n");
  $("k_private").checked = s.calendar.hidePrivateEvents;
  $("k_declined").checked = s.calendar.skipDeclined;
  $<HTMLSelectElement>("bl_ws").value = s.backlog.workspace;
  $("bl_db").value = s.backlog.databaseId;
  $("bl_status").value = s.backlog.defaultStatus;

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
    ...prev,
    profiles: prev.profiles.map((p) => (p.id === currentProfileId ? readProfile(p) : p)),
    compliance: { gmailExclusions: lines("x_exclusions") },
    calendar: { calendarIds: lines("k_ids").length ? lines("k_ids") : ["primary"], hidePrivateEvents: $("k_private").checked, skipDeclined: $("k_declined").checked },
    backlog: { workspace: $<HTMLSelectElement>("bl_ws").value as "personal" | "company", databaseId: $("bl_db").value.trim(), defaultStatus: $("bl_status").value.trim() },
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

// ─── Profils ──────────────────────────────────────────────────────────────────

let currentProfileId = "";
let nextRuns: Record<string, number | null> = {};

function fillProfile(p: BriefProfile): void {
  currentProfileId = p.id;
  $("p_name").value = p.name;
  $("p_enabled").checked = p.enabled;
  $("p_time").value = p.schedule.time;
  $("p_lookback").value = String(p.lookbackHours);
  $("p_retention").value = String(p.retentionDays);
  $("p_days").innerHTML = [1, 2, 3, 4, 5, 6, 0]
    .map((d) => `<label><input type="checkbox" data-day="${d}" ${p.schedule.days.includes(d) ? "checked" : ""}/> ${DAY_LABELS[d]}</label>`)
    .join("");
  $("p_src_gmail").checked = p.sources.gmail;
  $("p_src_calendar").checked = p.sources.calendar;
  $("p_src_np").checked = p.sources.notionPersonal;
  $("p_src_nc").checked = p.sources.notionCompany;
  $("p_query").value = p.gmailQuery;
  $("p_max").value = String(p.gmailMaxMessages);
  $("p_title").value = p.notebookTitleTemplate;
  $<HTMLSelectElement>("p_format").value = p.audio.format;
  $<HTMLSelectElement>("p_length").value = p.audio.length;
  $<HTMLSelectElement>("p_lang").value = p.audio.language;
  $<HTMLTextAreaElement>("p_audio").value = p.audio.instructions;
  $<HTMLTextAreaElement>("p_focus").value = p.synthesisFocus;
  $("p_memory").checked = p.memory;
  $("p_actions").checked = p.extractActions;
  const next = nextRuns[p.id];
  $("p_next").textContent = !p.enabled ? "Profil inactif." : next ? `Prochain passage : ${new Date(next).toLocaleString("fr-FR")}` : "Enregistre pour planifier.";
}

function readProfile(prev: BriefProfile): BriefProfile {
  return normalizeProfile({
    ...prev,
    name: $("p_name").value.trim() || prev.name,
    enabled: $("p_enabled").checked,
    schedule: {
      time: $("p_time").value || prev.schedule.time,
      days: Array.from(document.querySelectorAll<HTMLInputElement>("#p_days input:checked")).map((i) => Number(i.dataset.day)),
    },
    lookbackHours: Math.min(336, Math.max(1, Number($("p_lookback").value) || 24)),
    retentionDays: Math.max(0, Number($("p_retention").value) || 0),
    sources: { gmail: $("p_src_gmail").checked, calendar: $("p_src_calendar").checked, notionPersonal: $("p_src_np").checked, notionCompany: $("p_src_nc").checked },
    gmailQuery: $("p_query").value,
    gmailMaxMessages: Math.min(200, Math.max(1, Number($("p_max").value) || 40)),
    notebookTitleTemplate: $("p_title").value || prev.notebookTitleTemplate,
    audio: {
      format: $<HTMLSelectElement>("p_format").value as AudioFormat,
      length: $<HTMLSelectElement>("p_length").value as AudioLength,
      language: $<HTMLSelectElement>("p_lang").value,
      instructions: $<HTMLTextAreaElement>("p_audio").value,
    },
    synthesisFocus: $<HTMLTextAreaElement>("p_focus").value.trim(),
    memory: $("p_memory").checked,
    extractActions: $("p_actions").checked,
  });
}

function renderProfileSelect(s: Settings): void {
  $<HTMLSelectElement>("p_select").innerHTML = s.profiles
    .map((p) => `<option value="${esc(p.id)}" ${p.id === currentProfileId ? "selected" : ""}>${p.enabled ? "●" : "○"} ${esc(p.name)}</option>`)
    .join("");
}

// ─── Actions à valider ────────────────────────────────────────────────────────

const PRIO_LABEL: Record<ActionPriority, string> = { haute: "🔴 Haute", moyenne: "🟠 Moyenne", basse: "🟢 Basse" };

async function renderActions(): Promise<void> {
  const all = await getActions();
  const pending = all.filter((a) => a.status === "pending" || a.status === "error");
  $("actionsCount").textContent = pending.length ? String(pending.length) : "";
  $("actionsList").innerHTML = pending.length
    ? pending
        .map(
          (a) => `<div class="action ${a.status}" data-id="${esc(a.id)}">
        <input type="checkbox" class="sel" checked aria-label="Sélectionner" />
        <div class="fields">
          <input type="text" class="a-title" value="${esc(a.title)}" aria-label="Titre" />
          <input type="date" class="a-due" value="${esc(a.due)}" aria-label="Échéance" />
          <select class="a-prio" aria-label="Priorité">${(["haute", "moyenne", "basse"] as const).map((p) => `<option value="${p}" ${p === a.priority ? "selected" : ""}>${PRIO_LABEL[p]}</option>`).join("")}</select>
        </div>
        <div class="meta">${esc(a.source)}${a.requester ? ` · demandé par ${esc(a.requester)}` : ""} — ${esc(a.context)}${a.error ? `<br/>❌ ${esc(a.error)}` : ""}</div>
      </div>`,
        )
        .join("")
    : `<p class="hint">Aucune action en attente. Active « Extraire les actions » sur un profil (Claude requis).</p>`;
  const done = all.filter((a) => a.status === "sent" || a.status === "dismissed").slice(0, 20);
  $("actionsHistory").innerHTML = done.length
    ? `<ul>${done
        .map((a) => `<li>${a.status === "sent" ? "📋" : "🗑️"} ${esc(a.title)}${a.notionPageId ? ` — <a href="https://www.notion.so/${esc(a.notionPageId.replace(/-/g, ""))}" target="_blank" rel="noopener">ouvrir</a>` : ""}</li>`)
        .join("")}</ul>`
    : `<p class="hint">Rien pour l'instant.</p>`;
}

function selectedActions(): { ids: string[]; edits: Record<string, { title: string; due: string; priority: ActionPriority }> } {
  const ids: string[] = [];
  const edits: Record<string, { title: string; due: string; priority: ActionPriority }> = {};
  document.querySelectorAll<HTMLElement>("#actionsList .action").forEach((row) => {
    if (!row.querySelector<HTMLInputElement>(".sel")!.checked) return;
    const id = row.dataset.id!;
    ids.push(id);
    edits[id] = {
      title: row.querySelector<HTMLInputElement>(".a-title")!.value,
      due: row.querySelector<HTMLInputElement>(".a-due")!.value,
      priority: row.querySelector<HTMLSelectElement>(".a-prio")!.value as ActionPriority,
    };
  });
  return { ids, edits };
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
        ${new Date(r.startedAt).toLocaleString("fr-FR")} — ${esc(r.profileName ?? "Brief")} — ${r.status} — ${r.sourcesCount} sources</summary>
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

/** Pastille de navigation active = section la plus visible sous la barre d'application. */
function trackActiveSection(): void {
  const links = new Map(Array.from(document.querySelectorAll<HTMLAnchorElement>(".nav a")).map((a) => [a.hash.slice(1), a]));
  const visible = new Map<string, number>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) visible.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
      const best = [...visible.entries()].sort((a, b) => b[1] - a[1])[0];
      links.forEach((a, id) => a.classList.toggle("active", !!best && best[1] > 0 && id === best[0]));
      const active = best && links.get(best[0]);
      // Défilement horizontal de la barre uniquement (jamais de saut vertical de la page)
      if (active?.parentElement) active.parentElement.scrollTo({ left: active.offsetLeft - 24, behavior: "smooth" });
    },
    { rootMargin: "-120px 0px -40% 0px", threshold: [0, 0.15, 0.4, 0.7] },
  );
  document.querySelectorAll("main section.card[id]").forEach((sec) => io.observe(sec));
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function init(): Promise<void> {
  let settings = await getSettings();
  currentProfileId = settings.profiles[0]!.id;
  fill(settings);
  renderProfileSelect(settings);
  fillProfile(settings.profiles[0]!);
  try {
    nextRuns = await send<Record<string, number | null>>({ type: "rescheduleBriefing" });
    fillProfile(settings.profiles.find((p) => p.id === currentProfileId)!);
  } catch {
    /* SW pas encore prêt : affiché au prochain enregistrement */
  }

  // Garde anti-écrasement : un onglet d'options resté ouvert ne doit jamais réécrire des réglages
  // modifiés ailleurs (autre onglet, migration). Formulaire intact → rechargé ; modifié → avertissement.
  let dirty = false;
  let selfWrite = false;
  document.querySelector("main")!.addEventListener("input", (e) => {
    if (!(e.target as HTMLElement).closest("#actions, #subs, details")) dirty = true;
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local" || !c.settings || selfWrite) return;
    if (!dirty) {
      void getSettings().then((fresh) => {
        settings = fresh;
        if (!settings.profiles.some((p) => p.id === currentProfileId)) currentProfileId = settings.profiles[0]!.id;
        fill(settings);
        renderProfileSelect(settings);
        fillProfile(settings.profiles.find((p) => p.id === currentProfileId)!);
      });
    } else {
      say("⚠️ Réglages modifiés dans un autre onglet : « Enregistrer » écrasera ces changements. Recharge la page pour les récupérer.", "warn");
    }
  });

  const persist = async (): Promise<Settings> => {
    settings = read(settings);
    selfWrite = true;
    try {
      await saveSettings(settings);
    } finally {
      // l'événement onChanged de notre propre écriture est asynchrone
      setTimeout(() => (selfWrite = false), 300);
    }
    dirty = false;
    nextRuns = await send<Record<string, number | null>>({ type: "rescheduleBriefing" });
    renderProfileSelect(settings);
    fillProfile(settings.profiles.find((p) => p.id === currentProfileId)!);
    return settings;
  };

  $("save").onclick = async () => {
    try {
      await persist();
      const active = settings.profiles.filter((p) => p.enabled && nextRuns[p.id]);
      say(active.length ? `Enregistré. ${active.map((p) => `${p.name} : ${new Date(nextRuns[p.id]!).toLocaleString("fr-FR")}`).join(" · ")}` : "Enregistré (aucun profil actif).", "ok");
      void renderSubs();
    } catch (e) {
      say(String(e instanceof Error ? e.message : e), "error");
    }
  };

  // Changement de profil : les modifications du profil courant sont conservées en mémoire (enregistrées avec « Enregistrer »).
  $<HTMLSelectElement>("p_select").onchange = () => {
    settings = read(settings);
    const p = settings.profiles.find((x) => x.id === $<HTMLSelectElement>("p_select").value);
    if (p) fillProfile(p);
    renderProfileSelect(settings);
  };
  const addProfile = (p: BriefProfile) => {
    settings = read(settings);
    settings.profiles.push(p);
    currentProfileId = p.id;
    renderProfileSelect(settings);
    fillProfile(p);
    say(`Profil « ${p.name} » créé — pense à enregistrer.`);
  };
  $("p_new").onclick = () => {
    const tpl = PROFILE_TEMPLATES[$<HTMLSelectElement>("p_template").value] ?? PROFILE_TEMPLATES.daily!;
    addProfile(normalizeProfile({ ...tpl(), id: uid() }));
  };
  $("p_dup").onclick = () => {
    const cur = readProfile(settings.profiles.find((x) => x.id === currentProfileId)!);
    addProfile(normalizeProfile({ ...structuredClone(cur), id: uid(), name: `${cur.name} (copie)`, enabled: false }));
  };
  $("p_del").onclick = () => {
    if (settings.profiles.length <= 1) return say("Il faut au moins un profil.", "error");
    const cur = settings.profiles.find((x) => x.id === currentProfileId)!;
    if (!confirm(`Supprimer le profil « ${cur.name} » ? (les notebooks déjà créés ne sont pas supprimés)`)) return;
    settings.profiles = settings.profiles.filter((x) => x.id !== cur.id);
    currentProfileId = settings.profiles[0]!.id;
    renderProfileSelect(settings);
    fillProfile(settings.profiles[0]!);
    say("Profil supprimé — pense à enregistrer.");
  };
  $("p_run").onclick = async () => {
    try {
      await persist();
    } catch (e) {
      return say(String(e instanceof Error ? e.message : e), "error");
    }
    const name = settings.profiles.find((x) => x.id === currentProfileId)?.name;
    say(`« ${name} » lancé… suivi dans l'historique ci-dessous.`);
    void send<{ skipped?: string }>({ type: "runBriefingNow", profileId: currentProfileId })
      .then((r) => r?.skipped && say(r.skipped, "warn"))
      .catch((e: unknown) => say(String(e instanceof Error ? e.message : e), "error"))
      .finally(() => void renderRuns());
  };

  $("actionsPush").onclick = async () => {
    const { ids, edits } = selectedActions();
    if (!ids.length) return say("Aucune action sélectionnée.", "warn");
    try {
      await persist();
      say("Envoi au backlog…");
      const r = await send<{ sent: number; errors: string[] }>({ type: "actionsOp", op: "push", ids, edits });
      say(r.errors.length ? `${r.sent} envoyée(s), ${r.errors.length} en erreur : ${r.errors[0]}` : `✅ ${r.sent} action(s) envoyée(s) au backlog.`, r.errors.length ? "error" : "ok");
    } catch (e) {
      say(`❌ ${e instanceof Error ? e.message : String(e)}`, "error");
    }
    void renderActions();
  };
  $("actionsDismiss").onclick = async () => {
    const { ids } = selectedActions();
    if (!ids.length) return say("Aucune action sélectionnée.", "warn");
    await send({ type: "actionsOp", op: "dismiss", ids });
    say(`${ids.length} action(s) ignorée(s).`);
    void renderActions();
  };

  document.querySelectorAll<HTMLButtonElement>("[data-test]").forEach((b) => {
    b.onclick = async () => {
      if (dirty) {
        try {
          await persist(); // le test porte sur ce qui est affiché
        } catch {
          /* le test ci-dessous remontera l'erreur utile */
        }
      }
      const t = b.dataset.test!;
      const msg =
        t === "notion-personal" ? { type: "testNotion", workspace: "personal" }
        : t === "notion-company" ? { type: "testNotion", workspace: "company" }
        : t === "gmail" ? { type: "testGmail" }
        : t === "calendar" ? { type: "testCalendar" }
        : t === "backlog" ? { type: "inspectBacklog" }
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
    if (c.actionItems) void renderActions();
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

  await Promise.all([renderSubs(), renderRuns(), renderOrgStats(), renderActions()]);
  if (location.hash === "#actions") $("actions").scrollIntoView();
  trackActiveSection();
}

void init();
