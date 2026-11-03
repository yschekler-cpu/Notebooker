import type { DriverCommand, DriverResponse } from "../../shared/messages";
import type { SourcePayload } from "../../shared/types";
import {
  LABELS,
  SELECTORS,
  click,
  fill,
  findClickable,
  isInsideNotebookCard,
  labelText,
  norm,
  notebookIdFromUrl,
  scanNotebooks,
  sleep,
  topDialog,
  visibleTextField,
  waitFor,
} from "./dom";

/** Exécute une commande du service worker sur l'UI NotebookLM. */
export async function handleCommand(c: DriverCommand): Promise<DriverResponse> {
  try {
    switch (c.cmd) {
      case "ping":
        return ok({ url: location.href, notebookId: notebookIdFromUrl() });
      case "listNotebooks":
        await waitFor(() => scanNotebooks().length > 0 || document.readyState === "complete", 10_000).catch(() => null);
        return ok(scanNotebooks().map(({ id, title }) => ({ id, title })));
      case "createNotebook":
        return ok(await createNotebook(c.title, c.knownIds));
      case "renameNotebook":
        await renameNotebook(c.title);
        return ok(true);
      case "addSource":
        await addSource(c.source);
        return ok(true);
      case "generateAudio":
        await generateAudio(c.instructions);
        return ok(true);
      case "audioStatus":
        return ok(audioStatus());
      case "deleteNotebook":
        await deleteNotebook(c.notebookId);
        return ok(true);
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function ok<T>(data: T): DriverResponse<T> {
  return { ok: true, data };
}

async function createNotebook(title: string, knownIds: string[]): Promise<{ notebookId: string }> {
  if (notebookIdFromUrl()) throw new Error("createNotebook doit partir de la page d'accueil.");
  // Garde-fou : un clic sur une carte existante (« Créer une holding »…) ouvrirait un notebook
  // existant, qui serait ensuite renommé, rempli puis supprimé par la rétention.
  const before = new Set([...knownIds, ...scanNotebooks().map((n) => n.id)].map((x) => x.toLowerCase()));
  await click(LABELS.createNotebook, document, 15_000, { exclude: isInsideNotebookCard });
  const id = await waitFor(() => notebookIdFromUrl(), 30_000);
  if (before.has(id.toLowerCase())) {
    history.back();
    throw new Error("Le clic a ouvert un notebook existant au lieu d'en créer un — abandon (sélecteur « Créer » à corriger dans dom.ts).");
  }
  // Un nouveau notebook ouvre automatiquement la modale « Ajouter des sources » :
  // on la laisse ouverte, addSource la réutilise pour la première source.
  await sleep(1500);
  await renameNotebook(title).catch(() => undefined); // non bloquant : le brief reste utilisable sans titre
  return { notebookId: id };
}

async function renameNotebook(title: string): Promise<void> {
  const input = await waitFor(() => document.querySelector<HTMLInputElement>(SELECTORS.titleInput), 8000);
  input.focus();
  fill(input, title);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  input.blur();
  await sleep(500);
}

async function openAddSourceDialog(): Promise<HTMLElement> {
  const existing = topDialog();
  if (existing && findClickable([...LABELS.chipWebsite, ...LABELS.chipText], existing)) return existing;
  await click(LABELS.addSource);
  return waitFor(() => topDialog(), 10_000);
}

async function addSource(src: SourcePayload): Promise<void> {
  const dlg = await openAddSourceDialog();
  const isYT = src.type === "url" && /youtube\.com|youtu\.be/.test(src.url ?? "");
  const chip = src.type === "text" ? LABELS.chipText : isYT ? LABELS.chipYouTube : LABELS.chipWebsite;
  await click(chip, dlg);

  const field = await waitFor(() => visibleTextField(topDialog() ?? dlg), 10_000);
  const value = src.type === "text" ? `# ${src.title}\n\n${src.text ?? ""}` : (src.url ?? "");
  field.focus();
  fill(field, value);
  await sleep(300);

  const container = topDialog() ?? dlg;
  const insert = await waitFor(() => {
    const b = findClickable(LABELS.insert, container) as HTMLButtonElement | null;
    return b && !b.disabled && b.getAttribute("aria-disabled") !== "true" ? b : null;
  }, 10_000);
  insert.click();

  // Attente de fermeture de la modale (= source acceptée). Les URLs inaccessibles restent en erreur.
  await waitFor(() => !document.body.contains(container) || !topDialog(), 60_000);
  await sleep(1000);
}

/**
 * Conteneur de la carte « Audio Overview » du panneau Studio : plus petit ancêtre du titre
 * qui contient un bouton d'action. Évite de cliquer « Personnaliser » d'une autre tuile (vidéo, rapport…).
 */
function audioCard(): HTMLElement | null {
  const wanted = LABELS.audioOverview.map(norm);
  const heads = Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,span,div,p,[role='heading']")).filter((e) => {
    const t = labelText(e);
    return t.length < 60 && wanted.some((w) => t === w || t.startsWith(`${w} `));
  });
  for (const h of heads) {
    let el: HTMLElement | null = h;
    for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
      if (findClickable([...LABELS.audioCustomize, ...LABELS.audioGenerate, ...LABELS.audioPlay], el) || el.querySelector("audio")) return el;
      // État « génération en cours » : la carte n'a plus aucun bouton, seulement un texte d'attente.
      if (isGeneratingText(labelText(el))) return el;
      if (el.textContent && el.textContent.length > 3000) break; // remonté trop haut
    }
  }
  return null;
}

async function generateAudio(instructions: string): Promise<void> {
  const card = await waitFor(() => audioCard(), 20_000).catch(() => {
    throw new Error("Carte « Audio Overview » introuvable dans le panneau Studio.");
  });
  // 1) « Personnaliser » → consignes → « Générer »
  const customize = findClickable(LABELS.audioCustomize, card);
  if (customize) {
    customize.click();
    const dlg = await waitFor(() => topDialog(), 8000);
    const field = visibleTextField(dlg);
    if (field && instructions) fill(field, instructions);
    await click(LABELS.audioGenerate, dlg);
    return;
  }
  // 2) Fallback : « Générer » direct (sans consignes)
  await click(LABELS.audioGenerate, card);
}

export function audioStatus(): "ready" | "generating" | "none" {
  const card = audioCard();
  if (!card) return "none";
  if (card.querySelector("audio, audio-player, [class*='audio-player']")) return "ready";
  // Correspondances strictes, limitées à la carte audio (pas de « download » ≈ « load », pas de « en cours » d'un mail)
  if (findClickable(LABELS.audioPlay, card, { exactOnly: true })) return "ready";
  if (isGeneratingText(labelText(card))) return "generating";
  return "none";
}

function isGeneratingText(t: string): boolean {
  return LABELS.audioGenerating.some((l) => new RegExp(`(^|\\W)${norm(l)}(\\W|$)`).test(t));
}

async function deleteNotebook(notebookId: string): Promise<void> {
  const entry = scanNotebooks().find((n) => n.id === notebookId);
  if (!entry) throw new Error("Notebook introuvable sur la page d'accueil.");
  // Garde-fou : la carte ciblée doit référencer UN SEUL notebook, sinon on risque de supprimer le mauvais.
  const idsInCard = new Set(Array.from(entry.card.outerHTML.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi), (m) => m[0].toLowerCase()));
  if (idsInCard.size !== 1 || !idsInCard.has(notebookId.toLowerCase())) {
    throw new Error("Carte ambiguë — suppression annulée par sécurité.");
  }
  await click(LABELS.moreMenu, entry.card, 5000);
  await click(LABELS.delete, document, 5000);
  const dlg = await waitFor(() => topDialog(), 5000);
  if (!norm(dlg.innerText).includes(norm(entry.title).slice(0, 20)) && !findClickable(LABELS.confirm, dlg)) {
    throw new Error("Boîte de confirmation inattendue — suppression annulée.");
  }
  await click(LABELS.confirm, dlg, 5000);
}
