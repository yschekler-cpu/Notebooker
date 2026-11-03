/**
 * Couche d'accès au DOM NotebookLM.
 *
 * NotebookLM (grand public / Workspace) n'expose aucune API : l'extension pilote l'UI.
 * Toute la fragilité est concentrée ICI — si Google modifie l'interface, on ne corrige
 * que les libellés / sélecteurs ci-dessous. Les libellés sont matchés en FR et EN,
 * sur aria-label puis sur le texte visible, insensible à la casse et aux accents.
 */

export const LABELS = {
  createNotebook: ["create new notebook", "new notebook", "create new", "créer un notebook", "nouveau notebook", "créer"],
  addSource: ["add source", "add sources", "ajouter une source", "ajouter des sources", "ajouter"],
  chipWebsite: ["website", "site web", "lien vers un site", "site", "lien", "link"],
  chipYouTube: ["youtube"],
  chipText: ["copied text", "paste text", "texte copié", "coller du texte", "texte"],
  insert: ["insert", "insérer", "add", "ajouter"],
  audioCustomize: ["customize", "personnaliser"],
  audioGenerate: ["generate", "générer"],
  audioOverview: ["audio overview", "résumé audio", "aperçu audio"],
  audioPlay: ["play", "lire", "lecture", "lire l'audio", "play audio", "charger l'audio", "load audio"],
  audioGenerating: ["generating", "génération en cours", "generation en cours", "génération"],
  audioFormat: {
    deep_dive: ["deep dive", "analyse approfondie", "approfondi", "en profondeur"],
    brief: ["briefing", "brief", "bref", "résumé", "resume", "synthèse"],
    critique: ["critique", "critic", "avis critique"],
    debate: ["debate", "débat", "debat"],
  },
  audioLength: {
    short: ["shorter", "plus court", "court", "short"],
    default: ["default", "par défaut", "standard", "normal"],
    long: ["longer", "plus long", "long"],
  },
  languageControl: ["language", "langue", "output language", "langue de sortie", "choose language", "choisir la langue"],
  moreMenu: ["more options", "more actions", "plus d'options", "plus d'actions", "project actions", "more", "plus", "options"],
  delete: ["delete", "supprimer"],
  confirm: ["delete", "supprimer", "confirm", "confirmer", "ok"],
};

export const SELECTORS = {
  notebookLink: 'a[href*="/notebook/"]',
  /** Conteneur « carte » d'un notebook sur la page d'accueil (du plus spécifique au plus générique). */
  notebookCard: ["project-button", "mat-card", "[role='listitem']", "li", "tr"],
  dialog: "[role='dialog'], mat-dialog-container, .cdk-overlay-pane",
  titleInput: "input.title-input, input[aria-label*='title' i], input[aria-label*='titre' i]",
  /**
   * UI « luminous » (Gemini Notebook, notebook.google.com, 2026) : tuiles Studio et bibliothèque d'artefacts.
   * Plus de carte « Audio Overview » avec boutons Personnaliser/Générer : une tuile cliquable
   * « Résumé audio » (icône `audio_spark`) et une liste d'artefacts générés.
   */
  studioTile: "basic-create-artifact-button [role='button'], .create-artifact-button-container",
  studioTileCreating: "create-artifact-button-creating",
  studioTileDisabled: "disabled-tile",
  studioTileOptions: ".option-icon",
  artifactItem: "artifact-library-item",
  artifactButton: "button.artifact-stretched-button",
  artifactGenerating: "[class*='shimmer'], .rotate, .stop-generation-button, .artifact-library-shimmer",
  artifactFailed: ".artifact-item-button-failed, .artifact-item-button-cancelled, .artifact-failed",
  audioPlayer: "audio-player, audio, [class*='audio-player']",
  /** Ligature d'icône identifiant le résumé audio (tuile + artefact). */
  audioIcon: "audio_spark",
};

/** UUID strict (évite de capturer le « - » de `project-<uuid>`). */
export const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_RE = /\/notebook\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function notebookIdFromUrl(url: string = location.href): string | null {
  return UUID_RE.exec(url)?.[1] ?? null;
}

export function norm(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isVisible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect?.();
  if (!r || r.width === 0 || r.height === 0) return false;
  const st = getComputedStyle(el as HTMLElement);
  return st.visibility !== "hidden" && st.display !== "none";
}

const ICON_SELECTOR = "mat-icon, .material-icons, .material-symbols-outlined, .material-symbols-rounded, .google-symbols, [aria-hidden='true']";

/**
 * Texte visible d'un élément SANS les ligatures d'icônes Material
 * (`<mat-icon>add</mat-icon>Ajouter` → « Ajouter », pas « addAjouter »).
 */
export function labelText(el: Element): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += ` ${n.textContent ?? ""}`;
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const e = n as Element;
    if (e !== el && e.matches(ICON_SELECTOR)) return;
    e.childNodes.forEach(walk);
  };
  walk(el);
  return norm(out);
}

/**
 * Trouve un élément cliquable dont l'aria-label ou le texte correspond à un des libellés.
 * Score = niveau de correspondance (exacte > préfixe > inclusion) puis ordre du libellé :
 * les libellés en tête de liste (spécifiques) priment sur les génériques en fin de liste.
 */
export function findClickable(
  labels: string[],
  root: ParentNode = document,
  opts: { exclude?: (el: HTMLElement) => boolean; exactOnly?: boolean } = {},
): HTMLElement | null {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>("button, [role='button'], [role='tab'], [role='menuitem'], [role='option'], [role='radio'], mat-radio-button, a, mat-chip, mat-chip-option, label"),
  ).filter((el) => isVisible(el) && !(el as HTMLButtonElement).disabled && !el.closest(".notebooker-badge") && !opts.exclude?.(el));
  const wanted = labels.map(norm);
  const score = (el: HTMLElement): number => {
    const texts = [el.getAttribute("aria-label"), labelText(el)].map(norm).filter(Boolean);
    let best = 0;
    for (const t of texts) {
      wanted.forEach((w, i) => {
        const rank = wanted.length - i; // priorité au plus spécifique
        if (t === w) best = Math.max(best, 300 + rank);
        else if (opts.exactOnly) return;
        else if (t.startsWith(`${w} `) || t.startsWith(w + ":")) best = Math.max(best, 200 + rank);
        else if (t.includes(w) && t.length < w.length + 25) best = Math.max(best, 100 + rank);
      });
    }
    return best;
  };
  let winner: HTMLElement | null = null;
  let winnerScore = 0;
  for (const c of candidates) {
    const s = score(c);
    if (s > winnerScore) {
      winner = c;
      winnerScore = s;
    }
  }
  return winner;
}

export function topDialog(): HTMLElement | null {
  const ds = Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.dialog)).filter(isVisible);
  return ds.at(-1) ?? null;
}

export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 15_000, stepMs = 250): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("Timeout UI NotebookLM (sélecteur introuvable — voir src/content/notebooklm/dom.ts)");
    await sleep(stepMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Élément situé dans une carte de notebook (à exclure des actions globales comme « Créer »). */
export function isInsideNotebookCard(el: Element): boolean {
  if (el.closest(SELECTORS.notebookLink) || el.matches(SELECTORS.notebookLink)) return true;
  const card = el.closest(SELECTORS.notebookCard.slice(0, 2).join(","));
  return !!card && UUID_ANY.test(card.outerHTML.slice(0, 4000));
}

export async function click(
  labels: string[],
  root?: ParentNode,
  timeoutMs?: number,
  opts?: Parameters<typeof findClickable>[2],
): Promise<HTMLElement> {
  const el = await waitFor(() => findClickable(labels, root, opts), timeoutMs);
  el.scrollIntoView({ block: "center" });
  el.click();
  await sleep(400);
  return el;
}

/** Remplit un input/textarea géré par Angular (setter natif + événements). */
export function fill(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function visibleTextField(root: ParentNode = document): HTMLInputElement | HTMLTextAreaElement | null {
  const fields = Array.from(
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input[type='text'], input[type='url'], input:not([type])"),
  ).filter(isVisible);
  return fields[0] ?? null;
}

export function cardFor(link: Element): HTMLElement {
  for (const sel of SELECTORS.notebookCard) {
    const c = link.closest<HTMLElement>(sel);
    if (c) return c;
  }
  return link as HTMLElement;
}

/** Notebooks visibles sur la page d'accueil (ID extrait du href ou de n'importe quel attribut). */
export function scanNotebooks(): { id: string; title: string; card: HTMLElement }[] {
  const seen = new Map<string, { id: string; title: string; card: HTMLElement }>();
  const push = (el: Element, raw: string) => {
    const id = notebookIdFromUrl(raw);
    if (!id || seen.has(id)) return;
    const card = cardFor(el);
    const title =
      card.querySelector<HTMLElement>("[class*='title'], h2, h3")?.textContent?.trim() ||
      el.getAttribute("aria-label") ||
      card.textContent?.trim().split("\n")[0] ||
      "(Sans titre)";
    seen.set(id, { id, title: title.slice(0, 200), card });
  };
  document.querySelectorAll(SELECTORS.notebookLink).forEach((a) => push(a, (a as HTMLAnchorElement).href));
  if (seen.size === 0) {
    // Fallback : cartes non-anchor portant l'ID dans un attribut
    document.querySelectorAll("[id], [data-id], [data-project-id], [aria-describedby]").forEach((el) => {
      for (const at of Array.from(el.attributes)) if (UUID_ANY.test(at.value)) push(el, `/notebook/${UUID_ANY.exec(at.value)![0]}`);
    });
  }
  return Array.from(seen.values());
}
