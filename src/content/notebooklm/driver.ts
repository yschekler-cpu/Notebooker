import type { DriverCommand, DriverResponse } from "../../shared/messages";
import type { SourcePayload } from "../../shared/types";
import {
  LABELS,
  SELECTORS,
  click,
  fill,
  findClickable,
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
        return ok(await createNotebook(c.title));
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

async function createNotebook(title: string): Promise<{ notebookId: string }> {
  await click(LABELS.createNotebook);
  const id = await waitFor(() => notebookIdFromUrl(), 30_000);
  // Un nouveau notebook ouvre automatiquement la modale « Ajouter des sources » → on la ferme.
  await sleep(1500);
  const dlg = topDialog();
  if (dlg) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(500);
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

async function generateAudio(instructions: string): Promise<void> {
  // 1) Bouton « Personnaliser » de la carte Audio Overview (panneau Studio)
  const customize = findClickable(LABELS.audioCustomize);
  if (customize) {
    customize.click();
    const dlg = await waitFor(() => topDialog(), 8000);
    const field = visibleTextField(dlg);
    if (field && instructions) fill(field, instructions);
    await click(LABELS.audioGenerate, dlg);
    return;
  }
  // 2) Fallback : bouton « Générer » direct (sans consignes)
  await click(LABELS.audioGenerate);
}

function audioStatus(): "ready" | "generating" | "none" {
  if (document.querySelector("audio, audio-player, [class*='audio-player']")) return "ready";
  const text = norm(document.body.innerText);
  if (LABELS.audioGenerating.some((l) => text.includes(norm(l)))) return "generating";
  const studio = LABELS.audioOverview.some((l) => text.includes(norm(l)));
  return studio && findClickable(LABELS.audioPlay) ? "ready" : "none";
}

async function deleteNotebook(notebookId: string): Promise<void> {
  const entry = scanNotebooks().find((n) => n.id === notebookId);
  if (!entry) throw new Error("Notebook introuvable sur la page d'accueil.");
  await click(LABELS.moreMenu, entry.card, 5000);
  await click(LABELS.delete, document, 5000);
  const dlg = await waitFor(() => topDialog(), 5000);
  await click(LABELS.confirm, dlg, 5000);
}
