import { getFolders, getNotebookMetas, saveFolders, uid, upsertNotebookMeta } from "../../shared/storage";
import type { Folder, NotebookMeta } from "../../shared/types";
import { notebookIdFromUrl, norm, scanNotebooks } from "./dom";

/**
 * Organiseur injecté sur la page d'accueil NotebookLM :
 * dossiers, tags, épingles, recherche, glisser-déposer — 100 % client (chrome.storage.sync),
 * rien n'est écrit côté Google. Le filtrage masque/affiche les cartes existantes ;
 * les épinglés remontent via `order` CSS (pas de déplacement DOM → pas de conflit avec Angular).
 */

type Filter = { kind: "all" } | { kind: "pinned" } | { kind: "unfiled" } | { kind: "folder"; id: string };
type Nb = ReturnType<typeof scanNotebooks>[number];

// Palette système Apple (bleu, indigo, violet, rose, rouge, orange, jaune, vert, sarcelle, gris)
export const COLORS = ["#007aff", "#5856d6", "#af52de", "#ff2d55", "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#30b0c7", "#8e8e93"];
const DRAG_MIME = "application/x-notebooker-id";

let host: HTMLElement | null = null;
let root: ShadowRoot;
let bodyEl: HTMLElement;
let filter: Filter = { kind: "all" };
let tagFilter: string | null = null;
let query = "";
let folders: Folder[] = [];
let metas: Record<string, NotebookMeta> = {};
let notebooks: Nb[] = [];
let panelSig = "";
let seenSig = "";
let collapsed = readPref("collapsed") === "1";

export function startOrganizer(): void {
  const tick = debounce(() => void refresh(), 350);
  new MutationObserver((records) => {
    // Ignore nos propres mutations (badges) pour ne pas boucler.
    if (records.every((r) => (r.target as Element).closest?.(".notebooker-badge"))) return;
    tick();
  }).observe(document.body, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener((_c, area) => area === "sync" && tick());
  window.addEventListener("popstate", tick);
  void refresh();
}

async function refresh(): Promise<void> {
  if (notebookIdFromUrl()) {
    host?.remove();
    host = null;
    panelSig = "";
    return;
  }
  [folders, metas] = await Promise.all([getFolders(), getNotebookMetas()]);
  notebooks = scanNotebooks();
  if (notebooks.length === 0) return;

  const sig = JSON.stringify(notebooks.map(({ id, title }) => [id, title]));
  if (sig !== seenSig) {
    seenSig = sig;
    // Liste de cibles pour le popup / menu contextuel
    void chrome.runtime.sendMessage({ type: "notebooksSeen", notebooks: notebooks.map(({ id, title }) => ({ id, title })) }).catch(() => undefined);
  }

  ensurePanel();
  renderPanel();
  applyToCards();
}

// ─── Filtrage ─────────────────────────────────────────────────────────────────

export function matches(title: string, meta: NotebookMeta | undefined, f: Filter, tag: string | null, q: string): boolean {
  const nq = norm(q);
  if (nq && !norm(title).includes(nq) && !(meta?.tags ?? []).some((t) => norm(t).includes(nq))) return false;
  if (tag && !(meta?.tags ?? []).includes(tag)) return false;
  switch (f.kind) {
    case "all":
      return true;
    case "pinned":
      return !!meta?.pinned;
    case "unfiled":
      return !meta?.folderId || !folders.some((x) => x.id === meta.folderId);
    case "folder":
      return meta?.folderId === f.id;
  }
}

function applyToCards(): void {
  for (const nb of notebooks) {
    const meta = metas[nb.id];
    const visible = matches(nb.title, meta, filter, tagFilter, query);
    nb.card.style.display = visible ? "" : "none";
    nb.card.style.order = meta?.pinned ? "-1" : "";
    decorateCard(nb, meta);
  }
}

// ─── Panneau ──────────────────────────────────────────────────────────────────

function ensurePanel(): void {
  if (host && document.body.contains(host)) return;
  host = document.createElement("div");
  host.id = "notebooker-organizer";
  root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS}</style>
  <aside part="panel">
    <header role="button" tabindex="0" title="Replier / déplier">
      <span class="brand"><span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/></svg></span>Notebooker</span>
      <span class="chev"></span>
    </header>
    <div class="content">
      <input class="search" type="search" placeholder="Rechercher titre / tag…" aria-label="Rechercher un notebook" />
      <div class="body"></div>
    </div>
  </aside>
  <div class="pop" hidden></div>`;
  document.body.appendChild(host);
  panelSig = "";
  bodyEl = root.querySelector<HTMLElement>(".body")!;

  const header = root.querySelector<HTMLElement>("header")!;
  const toggle = () => {
    collapsed = !collapsed;
    writePref("collapsed", collapsed ? "1" : "0");
    panelSig = "";
    renderPanel();
  };
  header.onclick = toggle;
  header.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && toggle();

  // Le champ de recherche n'est jamais recréé → pas de perte de focus pendant la saisie.
  const search = root.querySelector<HTMLInputElement>(".search")!;
  search.value = query;
  search.oninput = debounce(() => {
    query = search.value;
    applyToCards();
  }, 150);

  root.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Escape" && closePop());
  document.addEventListener("click", (e) => {
    if (!e.composedPath().includes(root.querySelector(".pop")!)) closePop();
  });
}

function count(pred: (m?: NotebookMeta) => boolean): number {
  return notebooks.filter((n) => pred(metas[n.id])).length;
}

function renderPanel(): void {
  const allTags = Array.from(new Set(notebooks.flatMap((n) => metas[n.id]?.tags ?? []))).sort((a, b) => a.localeCompare(b, "fr"));
  const folderCounts = folders.map((f) => count((m) => m?.folderId === f.id));
  const sig = JSON.stringify([collapsed, filter, tagFilter, folders, folderCounts, allTags, notebooks.length, count((m) => !!m?.pinned)]);
  if (sig === panelSig) return;
  panelSig = sig;

  const aside = root.querySelector("aside")!;
  aside.classList.toggle("collapsed", collapsed);
  root.querySelector(".chev")!.textContent = collapsed ? "▸" : "▾";

  const li = (f: Filter, label: string, n: number, color?: string) => {
    const active = JSON.stringify(f) === JSON.stringify(filter);
    const isFolder = f.kind === "folder";
    return `<li class="${active ? "active" : ""}${isFolder ? " drop" : ""}" data-filter="${esc(JSON.stringify(f))}" tabindex="0">
      ${color ? `<span class="dot" style="background:${esc(color)}"></span>` : ""}<span class="lbl">${esc(label)}</span><span class="n">${n}</span>
      ${isFolder ? `<button class="act" data-rename="${esc(f.id)}" title="Renommer">✎</button><button class="act" data-del="${esc(f.id)}" title="Supprimer le dossier">×</button>` : ""}
    </li>`;
  };
  bodyEl.innerHTML = `
    <ul>
      ${li({ kind: "all" }, "Tous", notebooks.length)}
      ${li({ kind: "pinned" }, "★ Épinglés", count((m) => !!m?.pinned))}
      ${li({ kind: "unfiled" }, "Non classés", count((m) => !m?.folderId || !folders.some((x) => x.id === m.folderId)))}
    </ul>
    <h4>Dossiers</h4>
    <ul>${folders.map((f, i) => li({ kind: "folder", id: f.id }, f.name, folderCounts[i] ?? 0, f.color)).join("") || `<p class="empty">Glisse une carte ici après avoir créé un dossier.</p>`}</ul>
    <button class="add">+ Nouveau dossier</button>
    ${allTags.length ? `<h4>Tags</h4><div class="tags">${allTags.map((t) => `<button class="tag ${t === tagFilter ? "on" : ""}" data-tag="${esc(t)}">#${esc(t)}</button>`).join("")}</div>` : ""}`;

  bodyEl.querySelectorAll<HTMLElement>("li[data-filter]").forEach((el) => {
    const select = () => {
      filter = JSON.parse(el.dataset.filter!) as Filter;
      panelSig = "";
      renderPanel();
      applyToCards();
    };
    el.onclick = select;
    el.onkeydown = (e) => e.key === "Enter" && select();
    if (el.classList.contains("drop")) {
      const folderId = (JSON.parse(el.dataset.filter!) as { id: string }).id;
      el.ondragover = (e) => {
        e.preventDefault();
        el.classList.add("over");
      };
      el.ondragleave = () => el.classList.remove("over");
      el.ondrop = (e) => {
        e.preventDefault();
        el.classList.remove("over");
        const id = e.dataTransfer?.getData(DRAG_MIME) || notebookIdFromUrl(e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain") || "");
        const nb = notebooks.find((n) => n.id === id);
        if (nb) void upsertNotebookMeta(nb.id, { title: nb.title, folderId });
      };
    }
  });
  bodyEl.querySelectorAll<HTMLElement>("[data-del]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const f = folders.find((x) => x.id === b.dataset.del);
      if (!f || !confirm(`Supprimer le dossier « ${f.name} » ? Ses notebooks redeviennent « non classés » (aucun notebook n'est supprimé).`)) return;
      await saveFolders(folders.filter((x) => x.id !== f.id));
      for (const m of Object.values(metas)) if (m.folderId === f.id) await upsertNotebookMeta(m.notebookId, { folderId: null });
      if (filter.kind === "folder" && filter.id === f.id) filter = { kind: "all" };
    };
  });
  bodyEl.querySelectorAll<HTMLElement>("[data-rename]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const f = folders.find((x) => x.id === b.dataset.rename);
      if (f) openFolderEditor(b, f);
    };
  });
  bodyEl.querySelectorAll<HTMLElement>("[data-tag]").forEach((t) => {
    t.onclick = () => {
      tagFilter = tagFilter === t.dataset.tag ? null : (t.dataset.tag ?? null);
      panelSig = "";
      renderPanel();
      applyToCards();
    };
  });
  bodyEl.querySelector<HTMLButtonElement>(".add")!.onclick = (e) => {
    e.stopPropagation(); // sinon le listener « clic extérieur » du document referme aussitôt le popover
    openFolderEditor(e.currentTarget as HTMLElement);
  };
}

// ─── Popovers ─────────────────────────────────────────────────────────────────

function pop(): HTMLElement {
  return root.querySelector<HTMLElement>(".pop")!;
}

function closePop(): void {
  const p = root ? pop() : null;
  if (p) {
    p.hidden = true;
    p.innerHTML = "";
  }
}

function openPopAt(anchor: Element, html: string): HTMLElement {
  const p = pop();
  p.innerHTML = html;
  p.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = 260;
  const h = p.getBoundingClientRect().height;
  // Sous l'ancre si la place le permet, sinon au-dessus (le panneau est ancré en bas d'écran).
  const below = r.bottom + 6;
  const top = below + h <= window.innerHeight - 8 ? below : Math.max(8, r.top - h - 6);
  p.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
  p.style.top = `${top}px`;
  p.style.maxHeight = `${window.innerHeight - 16}px`;
  p.style.overflow = "auto";
  return p;
}

function openFolderEditor(anchor: Element, folder?: Folder): void {
  const p = openPopAt(
    anchor,
    `<form class="stack">
      <label>${folder ? "Renommer le dossier" : "Nouveau dossier"}</label>
      <input name="name" required maxlength="60" value="${esc(folder?.name ?? "")}" />
      <div class="swatches">${COLORS.map((c, i) => `<label class="sw"><input type="radio" name="color" value="${c}" ${(folder?.color ?? COLORS[folders.length % COLORS.length]) === c || (!folder && i === folders.length % COLORS.length) ? "checked" : ""}/><span style="background:${c}"></span></label>`).join("")}</div>
      <div class="row"><button type="button" class="ghost" data-cancel>Annuler</button><button class="primary">${folder ? "Enregistrer" : "Créer"}</button></div>
    </form>`,
  );
  const form = p.querySelector("form")!;
  const input = form.querySelector<HTMLInputElement>("input[name=name]")!;
  input.focus();
  input.select();
  p.querySelector<HTMLElement>("[data-cancel]")!.onclick = closePop;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    const color = (form.querySelector<HTMLInputElement>("input[name=color]:checked")?.value ?? COLORS[0])!;
    if (!name) return;
    if (folder) await saveFolders(folders.map((f) => (f.id === folder.id ? { ...f, name, color } : f)));
    else await saveFolders([...folders, { id: uid(), name, color, order: folders.length }]);
    closePop();
  };
}

function openNotebookMenu(anchor: Element, nb: Nb): void {
  const meta = metas[nb.id];
  const p = openPopAt(
    anchor,
    `<div class="stack">
      <div class="ttl" title="${esc(nb.title)}">${esc(nb.title)}</div>
      <button class="item" data-pin>${meta?.pinned ? "★ Désépingler" : "☆ Épingler"}</button>
      <label>Dossier</label>
      <div class="list">
        <button class="item ${!meta?.folderId ? "sel" : ""}" data-folder="">— Aucun</button>
        ${folders.map((f) => `<button class="item ${meta?.folderId === f.id ? "sel" : ""}" data-folder="${esc(f.id)}"><span class="dot" style="background:${esc(f.color)}"></span>${esc(f.name)}</button>`).join("")}
      </div>
      <form class="inline" data-newfolder><input placeholder="+ Nouveau dossier" maxlength="60" /></form>
      <label>Tags <span class="hint">(Entrée pour valider, virgules acceptées)</span></label>
      <form data-tags><input value="${esc((meta?.tags ?? []).join(", "))}" placeholder="kyc, roadmap, belgique" /></form>
    </div>`,
  );
  p.querySelector<HTMLElement>("[data-pin]")!.onclick = async () => {
    await upsertNotebookMeta(nb.id, { title: nb.title, pinned: !meta?.pinned });
    closePop();
  };
  p.querySelectorAll<HTMLElement>("[data-folder]").forEach((b) => {
    b.onclick = async () => {
      await upsertNotebookMeta(nb.id, { title: nb.title, folderId: b.dataset.folder || null });
      closePop();
    };
  });
  p.querySelector<HTMLFormElement>("[data-newfolder]")!.onsubmit = async (e) => {
    e.preventDefault();
    const name = (e.currentTarget as HTMLFormElement).querySelector("input")!.value.trim();
    if (!name) return;
    const f: Folder = { id: uid(), name, color: COLORS[folders.length % COLORS.length]!, order: folders.length };
    await saveFolders([...folders, f]);
    await upsertNotebookMeta(nb.id, { title: nb.title, folderId: f.id });
    closePop();
  };
  p.querySelector<HTMLFormElement>("[data-tags]")!.onsubmit = async (e) => {
    e.preventDefault();
    const raw = (e.currentTarget as HTMLFormElement).querySelector("input")!.value;
    await upsertNotebookMeta(nb.id, { title: nb.title, tags: parseTags(raw) });
    closePop();
  };
}

export function parseTags(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,;\n]/)
        .map((t) => t.trim().replace(/^#+/, "").replace(/\s+/g, "-").slice(0, 40))
        .filter(Boolean),
    ),
  ).slice(0, 20);
}

// ─── Décoration des cartes ────────────────────────────────────────────────────

function decorateCard(nb: Nb, meta?: NotebookMeta): void {
  const { card, id } = nb;
  let badge = card.querySelector<HTMLElement>(":scope > .notebooker-badge");
  if (!badge) {
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    badge = document.createElement("div");
    badge.className = "notebooker-badge";
    Object.assign(badge.style, {
      // En bas de carte : le titre (en haut sur NotebookLM) reste lisible.
      position: "absolute", left: "8px", right: "8px", bottom: "8px", zIndex: "5", display: "flex", gap: "4px",
      alignItems: "center", overflow: "hidden", font: "12px/1.6 system-ui, sans-serif", pointerEvents: "auto",
    } satisfies Partial<CSSStyleDeclaration>);
    card.appendChild(badge);
    // Glisser-déposer : même les cartes non-<a> deviennent déplaçables vers un dossier.
    // L'ID est lu au moment de l'événement : Angular peut réutiliser la carte pour un autre notebook.
    if (!card.draggable) card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      const current = card.dataset.notebookerId;
      if (current) e.dataTransfer?.setData(DRAG_MIME, current);
    });
  }
  card.dataset.notebookerId = id;
  const folder = folders.find((f) => f.id === meta?.folderId);
  const sig = JSON.stringify([id, nb.title, folder?.id, folder?.name, folder?.color, meta?.pinned, meta?.tags]);
  if (badge.dataset.sig === sig) return;
  badge.dataset.sig = sig;
  badge.innerHTML = "";

  const chip = (text: string, tip: string, bg?: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = tip;
    // Pastille « verre » : translucide, reflet en bord haut ; teintée par la couleur du dossier.
    Object.assign(b.style, {
      border: bg ? "1px solid rgba(255,255,255,.35)" : "1px solid rgba(0,0,0,.05)", borderRadius: "999px", padding: "1px 9px", cursor: "pointer",
      font: "600 11.5px/1.55 -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif", letterSpacing: "-.01em",
      // Neutre : léger voile gris (un verre blanc sur une carte blanche serait invisible)
      background: bg ? `linear-gradient(180deg, color-mix(in srgb, ${bg} 78%, #fff), ${bg})` : "rgba(118,118,128,.14)",
      color: bg ? "#fff" : "#1d1d1f",
      backdropFilter: "blur(14px) saturate(180%)",
      boxShadow: bg
        ? `0 2px 8px color-mix(in srgb, ${bg} 40%, transparent), inset 0 1px 0 rgba(255,255,255,.45)`
        : "inset 0 1px 0 rgba(255,255,255,.6)",
      transition: "transform .18s cubic-bezier(.2,.8,.2,1)",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "150px", flex: "0 1 auto", minWidth: "0",
    } satisfies Partial<CSSStyleDeclaration>);
    b.onpointerdown = () => (b.style.transform = "scale(.95)");
    b.onpointerup = b.onpointerleave = () => (b.style.transform = "");
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openNotebookMenu(b, nb);
    };
    b.onmousedown = (e) => e.stopPropagation(); // évite l'ouverture du notebook par NotebookLM
    badge!.appendChild(b);
  };
  if (meta?.pinned) {
    chip("★", "Épinglé");
    (badge.lastElementChild as HTMLElement).style.flexShrink = "0";
  }
  if (folder) {
    chip(folder.name, `Dossier : ${folder.name}`, folder.color);
    (badge.lastElementChild as HTMLElement).style.flexShrink = "0"; // le dossier prime sur les tags
  }
  if (meta?.tags.length) chip(meta.tags.map((t) => `#${t}`).join(" "), "Tags");
  chip("⋯", "Organiser (dossier, tags, épingle)");
  const more = badge.lastElementChild as HTMLElement;
  more.style.marginLeft = "auto"; // action toujours visible, alignée à droite
  more.style.flex = "none";
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────

function readPref(k: string): string | null {
  try {
    return localStorage.getItem(`notebooker:${k}`);
  } catch {
    return null;
  }
}

function writePref(k: string, v: string): void {
  try {
    localStorage.setItem(`notebooker:${k}`, v);
  } catch {
    /* stockage indisponible : préférence non persistée */
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

const CSS = `
:host{all:initial}
:host{
  --font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",system-ui,sans-serif;
  --text:#1d1d1f;--text-2:rgba(29,29,31,.62);--text-3:rgba(29,29,31,.42);
  --accent:#007aff;--red:#ff3b30;
  --glass:rgba(255,255,255,.62);--glass-strong:rgba(255,255,255,.8);--border:rgba(255,255,255,.7);
  --specular:rgba(255,255,255,.95);--edge:rgba(0,0,0,.06);--sep:rgba(60,60,67,.12);
  --fill:rgba(120,120,128,.12);--fill-2:rgba(120,120,128,.2);--field:rgba(255,255,255,.55);
  --shadow:0 1px 1px rgba(0,0,0,.04),0 10px 30px rgba(31,38,64,.16),0 30px 60px rgba(31,38,64,.10);
  --blur:blur(28px) saturate(180%);
  --ease:cubic-bezier(.2,.8,.2,1);
}
@media (prefers-color-scheme:dark){:host{
  --text:#f5f5f7;--text-2:rgba(245,245,247,.64);--text-3:rgba(245,245,247,.4);--accent:#0a84ff;--red:#ff453a;
  --glass:rgba(38,40,52,.6);--glass-strong:rgba(44,46,58,.82);--border:rgba(255,255,255,.14);
  --specular:rgba(255,255,255,.26);--edge:rgba(0,0,0,.3);--sep:rgba(255,255,255,.1);
  --fill:rgba(120,120,128,.24);--fill-2:rgba(120,120,128,.34);--field:rgba(255,255,255,.07);
  --shadow:0 1px 1px rgba(0,0,0,.3),0 12px 34px rgba(0,0,0,.45),0 30px 70px rgba(0,0,0,.35);
}}
aside,.pop{
  isolation:isolate;
  font:13px/1.45 var(--font);letter-spacing:-.008em;color:var(--text);-webkit-font-smoothing:antialiased;
  background:var(--glass);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);
  border:1px solid var(--border);
  box-shadow:var(--shadow),inset 0 1px 0 var(--specular),inset 0 -1px 0 var(--edge);
}
aside::before,.pop::before{
  content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:-1;
  background:linear-gradient(180deg,rgba(255,255,255,.4),rgba(255,255,255,0) 40%);mix-blend-mode:soft-light;
}
aside{position:fixed;left:14px;bottom:16px;width:244px;max-height:calc(100vh - 120px);overflow:auto;z-index:2147483000;
  border-radius:24px;padding:12px;scrollbar-width:thin;animation:in .45s var(--ease) both}
@keyframes in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
aside.collapsed{width:auto;padding:7px 10px 7px 8px;border-radius:999px}
aside.collapsed .content{display:none}
header{font-weight:650;font-size:13.5px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px;user-select:none;outline:none;border-radius:999px}
header:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 35%,transparent)}
.brand{display:flex;align-items:center;gap:8px}
.logo{width:24px;height:24px;border-radius:7px;display:grid;place-items:center;color:#fff;
  background:linear-gradient(145deg,#5e9bff,#6a4dff 60%,#b05cf0);box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 3px 8px rgba(88,86,214,.35)}
.logo svg{width:14px;height:14px}
.chev{color:var(--text-3);font-size:11px;padding-right:4px}
.content{margin-top:10px}
.search{width:100%;box-sizing:border-box;padding:8px 11px;border:1px solid var(--sep);border-radius:12px;margin-bottom:8px;
  background:var(--field);color:var(--text);font:inherit;outline:none;transition:box-shadow .2s var(--ease),background .2s var(--ease)}
.search:focus{background:var(--glass-strong);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 22%,transparent)}
ul{list-style:none;margin:0;padding:0}
li{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:11px;cursor:pointer;outline:none;transition:background .18s var(--ease)}
li:hover,li:focus-visible{background:var(--fill)}
li.active{background:var(--accent);color:#fff;box-shadow:0 4px 12px color-mix(in srgb,var(--accent) 35%,transparent)}
li.active .n{color:rgba(255,255,255,.85)}
li.over{background:color-mix(in srgb,var(--accent) 16%,transparent);box-shadow:inset 0 0 0 2px var(--accent)}
li.active .lbl{font-weight:600}
.lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.n{color:var(--text-3);font-size:12px;font-variant-numeric:tabular-nums}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;flex:none;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.15)}
li.active .dot{box-shadow:0 0 0 1.5px #fff}
.act{border:none;background:none;cursor:pointer;opacity:0;color:inherit;padding:0 3px;font:inherit;border-radius:6px}
.act:hover{background:var(--fill-2)}
li:hover .act,li:focus-within .act{opacity:.7}
h4{margin:14px 6px 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)}
.empty{margin:2px 9px;font-size:12px;color:var(--text-3)}
.add{margin-top:6px;width:100%;padding:7px;border:1px dashed var(--fill-2);border-radius:12px;background:none;cursor:pointer;color:var(--accent);font:inherit;font-weight:550;transition:background .18s var(--ease)}
.add:hover{background:var(--fill)}
.tags{display:flex;flex-wrap:wrap;gap:5px;padding:0 4px}
.tag{padding:3px 10px;border-radius:999px;border:none;background:var(--fill);color:var(--text);cursor:pointer;font:500 12px var(--font);transition:all .18s var(--ease)}
.tag:hover{background:var(--fill-2)}
.tag.on{background:var(--accent);color:#fff}
.pop{position:fixed;z-index:2147483001;width:268px;box-sizing:border-box;border-radius:20px;padding:12px;animation:pop .22s var(--ease) both;background:var(--glass-strong)}
@keyframes pop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}
.stack{display:flex;flex-direction:column;gap:6px;position:relative}
.stack label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);margin:6px 4px 0}
.hint{text-transform:none;letter-spacing:0;font-weight:400}
.ttl{font-weight:650;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 4px}
.list{display:flex;flex-direction:column;max-height:190px;overflow:auto;gap:1px}
.item{display:flex;align-items:center;gap:6px;text-align:left;border:none;background:none;padding:7px 9px;border-radius:10px;cursor:pointer;color:inherit;font:inherit;transition:background .15s var(--ease)}
.item:hover{background:var(--fill)}
.item.sel{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);font-weight:600}
.pop input:not([type=radio]){width:100%;box-sizing:border-box;padding:8px 11px;border:1px solid var(--sep);border-radius:11px;background:var(--field);color:var(--text);font:inherit;outline:none}
.pop input:not([type=radio]):focus{box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 22%,transparent)}
.row{display:flex;justify-content:flex-end;gap:6px;margin-top:6px}
.primary{background:linear-gradient(180deg,color-mix(in srgb,var(--accent) 86%,#fff),var(--accent));color:#fff;border:none;border-radius:999px;padding:7px 15px;cursor:pointer;font:600 13px var(--font);box-shadow:0 4px 12px color-mix(in srgb,var(--accent) 35%,transparent),inset 0 1px 0 rgba(255,255,255,.4)}
.ghost{background:var(--fill);border:none;border-radius:999px;padding:7px 15px;cursor:pointer;color:inherit;font:550 13px var(--font)}
.primary:active,.ghost:active{transform:scale(.97)}
.swatches{display:flex;flex-wrap:wrap;gap:7px;padding:2px 4px}
.sw input{display:none}
.sw span{display:block;width:20px;height:20px;border-radius:50%;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.4);transition:transform .15s var(--ease)}
.sw span:hover{transform:scale(1.1)}
.sw input:checked+span{box-shadow:0 0 0 2px var(--glass-strong),0 0 0 4px var(--text)}
@media (prefers-reduced-motion:reduce){aside,.pop{animation:none}*{transition:none!important}}
@media (prefers-reduced-transparency:reduce){aside,.pop{-webkit-backdrop-filter:none;backdrop-filter:none;background:#fff}}
@media (prefers-reduced-transparency:reduce) and (prefers-color-scheme:dark){aside,.pop{background:#1c1c1e}}
`;
