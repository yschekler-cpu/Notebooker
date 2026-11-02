import { getFolders, getNotebookMetas, saveFolders, uid, upsertNotebookMeta } from "../../shared/storage";
import type { Folder, NotebookMeta } from "../../shared/types";
import { notebookIdFromUrl, norm, scanNotebooks } from "./dom";

/**
 * Organiseur injecté sur la page d'accueil NotebookLM :
 * dossiers, tags, épingles, recherche — 100 % client (chrome.storage.sync), rien n'est
 * écrit côté Google. Le filtrage masque/affiche les cartes existantes.
 */

type Filter = { kind: "all" } | { kind: "pinned" } | { kind: "unfiled" } | { kind: "folder"; id: string };

const COLORS = ["#4f46e5", "#0891b2", "#16a34a", "#ca8a04", "#dc2626", "#9333ea", "#64748b"];

let host: HTMLElement | null = null;
let root: ShadowRoot;
let filter: Filter = { kind: "all" };
let tagFilter: string | null = null;
let query = "";
let folders: Folder[] = [];
let metas: Record<string, NotebookMeta> = {};
let collapsed = (() => {
  try {
    return localStorage.getItem("notebooker:collapsed") === "1";
  } catch {
    return false;
  }
})();

export function startOrganizer(): void {
  const tick = debounce(() => void render(), 400);
  new MutationObserver(tick).observe(document.body, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener((_c, area) => area === "sync" && tick());
  void render();
}

async function render(): Promise<void> {
  const onHome = !notebookIdFromUrl();
  if (!onHome) {
    host?.remove();
    host = null;
    return;
  }
  [folders, metas] = await Promise.all([getFolders(), getNotebookMetas()]);
  const notebooks = scanNotebooks();
  if (notebooks.length === 0) return;

  // Informe le SW des notebooks visibles (liste de cibles pour le popup / menu contextuel)
  void chrome.runtime.sendMessage({ type: "notebooksSeen", notebooks: notebooks.map(({ id, title }) => ({ id, title })) });

  ensurePanel();
  renderPanel(notebooks.length);
  for (const nb of notebooks) {
    const meta = metas[nb.id];
    nb.card.style.display = matches(nb.id, nb.title, meta) ? "" : "none";
    decorateCard(nb.card, nb.id, nb.title, meta);
  }
}

function matches(id: string, title: string, meta?: NotebookMeta): boolean {
  if (query && !norm(title).includes(norm(query)) && !(meta?.tags ?? []).some((t) => norm(t).includes(norm(query)))) return false;
  if (tagFilter && !(meta?.tags ?? []).includes(tagFilter)) return false;
  switch (filter.kind) {
    case "all":
      return true;
    case "pinned":
      return !!meta?.pinned;
    case "unfiled":
      return !meta?.folderId;
    case "folder":
      return meta?.folderId === filter.id;
  }
  void id;
}

function ensurePanel(): void {
  if (host && document.body.contains(host)) return;
  host = document.createElement("div");
  host.id = "notebooker-organizer";
  root = host.attachShadow({ mode: "open" });
  document.body.appendChild(host);
}

function renderPanel(total: number): void {
  const counts = (pred: (m?: NotebookMeta) => boolean) =>
    scanNotebooks().filter((n) => pred(metas[n.id])).length;
  const allTags = Array.from(new Set(Object.values(metas).flatMap((m) => m.tags))).sort();
  const item = (f: Filter, label: string, n: number, color?: string) => {
    const active = JSON.stringify(f) === JSON.stringify(filter);
    return `<li class="${active ? "active" : ""}" data-filter='${JSON.stringify(f)}'>
      ${color ? `<span class="dot" style="background:${color}"></span>` : ""}<span class="lbl">${esc(label)}</span><span class="n">${n}</span>
      ${f.kind === "folder" ? `<button class="del" data-del="${f.id}" title="Supprimer le dossier">×</button>` : ""}
    </li>`;
  };
  root.innerHTML = `<style>${CSS}</style>
  <aside class="${collapsed ? "collapsed" : ""}">
    <header title="Replier / déplier">📚 Notebooker <span class="chev">${collapsed ? "▸" : "▾"}</span></header>
    <input class="search" placeholder="Rechercher titre / tag…" value="${esc(query)}"/>
    <ul>
      ${item({ kind: "all" }, "Tous", total)}
      ${item({ kind: "pinned" }, "★ Épinglés", counts((m) => !!m?.pinned))}
      ${item({ kind: "unfiled" }, "Non classés", counts((m) => !m?.folderId))}
    </ul>
    <h4>Dossiers</h4>
    <ul>${folders.map((f) => item({ kind: "folder", id: f.id }, f.name, counts((m) => m?.folderId === f.id), f.color)).join("")}</ul>
    <button class="add">+ Nouveau dossier</button>
    ${allTags.length ? `<h4>Tags</h4><div class="tags">${allTags.map((t) => `<span class="tag ${t === tagFilter ? "on" : ""}" data-tag="${esc(t)}">#${esc(t)}</span>`).join("")}</div>` : ""}
  </aside>`;

  root.querySelector<HTMLElement>("header")!.onclick = () => {
    collapsed = !collapsed;
    try {
      localStorage.setItem("notebooker:collapsed", collapsed ? "1" : "0");
    } catch {
      /* stockage indisponible : préférence non persistée */
    }
    void render();
  };
  const search = root.querySelector<HTMLInputElement>(".search")!;
  search.oninput = debounce(() => {
    query = search.value;
    void render().then(() => root.querySelector<HTMLInputElement>(".search")?.focus());
  }, 250);
  root.querySelectorAll<HTMLElement>("li[data-filter]").forEach((li) => {
    li.onclick = () => {
      filter = JSON.parse(li.dataset.filter!) as Filter;
      void render();
    };
  });
  root.querySelectorAll<HTMLElement>("[data-del]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm("Supprimer ce dossier ? Les notebooks redeviennent « non classés ».")) return;
      await saveFolders(folders.filter((f) => f.id !== b.dataset.del));
      for (const m of Object.values(metas)) if (m.folderId === b.dataset.del) await upsertNotebookMeta(m.notebookId, { folderId: null });
      filter = { kind: "all" };
    };
  });
  root.querySelectorAll<HTMLElement>("[data-tag]").forEach((t) => {
    t.onclick = () => {
      tagFilter = tagFilter === t.dataset.tag ? null : (t.dataset.tag ?? null);
      void render();
    };
  });
  root.querySelector<HTMLButtonElement>(".add")!.onclick = async () => {
    const name = prompt("Nom du dossier ?")?.trim();
    if (!name) return;
    await saveFolders([...folders, { id: uid(), name, color: COLORS[folders.length % COLORS.length]!, order: folders.length }]);
  };
}

function decorateCard(card: HTMLElement, id: string, title: string, meta?: NotebookMeta): void {
  let badge = card.querySelector<HTMLElement>(":scope > .notebooker-badge");
  if (!badge) {
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    badge = document.createElement("div");
    badge.className = "notebooker-badge";
    Object.assign(badge.style, {
      position: "absolute", top: "6px", right: "6px", zIndex: "5", display: "flex", gap: "4px",
      font: "12px system-ui, sans-serif",
    } satisfies Partial<CSSStyleDeclaration>);
    card.appendChild(badge);
  }
  const folder = folders.find((f) => f.id === meta?.folderId);
  const sig = JSON.stringify([folder?.id, folder?.name, meta?.pinned, meta?.tags]);
  if (badge.dataset.sig === sig) return;
  badge.dataset.sig = sig;
  badge.innerHTML = "";
  const btn = (txt: string, tip: string, onClick: () => void, bg = "rgba(255,255,255,.92)") => {
    const b = document.createElement("button");
    b.textContent = txt;
    b.title = tip;
    Object.assign(b.style, { border: "1px solid #d4d4d8", borderRadius: "10px", padding: "1px 7px", background: bg, cursor: "pointer", color: "#18181b" });
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    };
    badge!.appendChild(b);
  };
  btn(meta?.pinned ? "★" : "☆", "Épingler", () => void upsertNotebookMeta(id, { title, pinned: !meta?.pinned }));
  btn(folder ? `📁 ${folder.name}` : "📁", "Classer dans un dossier", () => void chooseFolder(id, title));
  btn(meta?.tags.length ? `#${meta.tags.join(" #")}` : "#", "Tags (séparés par des virgules)", () => {
    const v = prompt("Tags (séparés par des virgules)", (meta?.tags ?? []).join(", "));
    if (v === null) return;
    const tags = v.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
    void upsertNotebookMeta(id, { title, tags });
  });
}

async function chooseFolder(id: string, title: string): Promise<void> {
  const list = folders.map((f, i) => `${i + 1}. ${f.name}`).join("\n");
  const v = prompt(`Dossier pour « ${title} » :\n0. Aucun\n${list}\n\nOu tape un nouveau nom :`, "");
  if (v === null) return;
  const n = Number(v);
  if (v.trim() === "0") return void upsertNotebookMeta(id, { title, folderId: null });
  if (Number.isInteger(n) && n >= 1 && n <= folders.length) return void upsertNotebookMeta(id, { title, folderId: folders[n - 1]!.id });
  const name = v.trim();
  if (!name) return;
  const f: Folder = { id: uid(), name, color: COLORS[folders.length % COLORS.length]!, order: folders.length };
  await saveFolders([...folders, f]);
  await upsertNotebookMeta(id, { title, folderId: f.id });
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
aside{position:fixed;left:12px;top:84px;width:220px;max-height:calc(100vh - 110px);overflow:auto;z-index:2147483000;
  background:#fff;color:#18181b;border:1px solid #e4e4e7;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.08);
  font:13px/1.4 system-ui,-apple-system,sans-serif;padding:10px}
@media (prefers-color-scheme:dark){aside{background:#1f1f23;color:#f4f4f5;border-color:#3f3f46}.search{background:#27272a!important;color:#f4f4f5!important;border-color:#3f3f46!important}li:hover,li.active{background:#2e2e33!important}}
header{font-weight:600;margin-bottom:8px;cursor:pointer;display:flex;justify-content:space-between}
aside.collapsed{width:auto;padding:6px 10px}aside.collapsed header{margin:0}aside.collapsed>*:not(header){display:none}
.search{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #e4e4e7;border-radius:8px;margin-bottom:8px;background:#fafafa;color:#18181b}
ul{list-style:none;margin:0;padding:0}
li{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:8px;cursor:pointer}
li:hover,li.active{background:#f4f4f5}
li.active .lbl{font-weight:600}
.lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.n{opacity:.55;font-size:12px}
.dot{width:8px;height:8px;border-radius:50%}
.del{border:none;background:none;cursor:pointer;opacity:0;color:inherit}
li:hover .del{opacity:.6}
h4{margin:12px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.6}
.add{margin-top:6px;width:100%;padding:6px;border:1px dashed #a1a1aa;border-radius:8px;background:none;cursor:pointer;color:inherit}
.tags{display:flex;flex-wrap:wrap;gap:4px}
.tag{padding:2px 8px;border-radius:10px;background:#eef2ff;color:#3730a3;cursor:pointer;font-size:12px}
.tag.on{background:#4f46e5;color:#fff}
`;
