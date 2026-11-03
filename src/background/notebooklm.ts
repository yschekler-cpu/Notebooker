import type { DriverCommand, DriverResponse, NotebookSummary } from "../shared/messages";
import { NOTEBOOKLM_ORIGIN } from "../shared/endpoints";
import { getSettings } from "../shared/storage";
import type { AudioOptions, SourcePayload } from "../shared/types";

/**
 * Orchestrateur du driver UI : ouvre un onglet NotebookLM, attend le content script,
 * envoie les commandes en séquence, ferme l'onglet. Les jobs sont sérialisés (une seule
 * automatisation à la fois) pour éviter les collisions d'UI.
 */

let queue: Promise<unknown> = Promise.resolve();

export function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

async function baseUrl(): Promise<string> {
  const s = await getSettings();
  return s.notebooklm.accountIndex > 0
    ? `${NOTEBOOKLM_ORIGIN}/u/${s.notebooklm.accountIndex}/`
    : `${NOTEBOOKLM_ORIGIN}/`;
}

export async function notebookUrl(notebookId: string): Promise<string> {
  return `${await baseUrl()}notebook/${notebookId}`;
}

/** Garde le service worker éveillé pendant les jobs longs (appel d'API extension < 30 s). */
export function keepAlive(): () => void {
  const t = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  return () => clearInterval(t);
}

export class NotebookSession {
  private constructor(readonly tabId: number) {}

  static async open(path = ""): Promise<NotebookSession> {
    const s = await getSettings();
    const tab = await chrome.tabs.create({ url: `${await baseUrl()}${path}`, active: !s.notebooklm.backgroundTabs });
    if (tab.id === undefined) throw new Error("Impossible d'ouvrir NotebookLM.");
    const session = new NotebookSession(tab.id);
    try {
      await session.waitReady();
    } catch (e) {
      await session.close(); // pas d'onglet orphelin (ex. session Google expirée → page de login)
      throw e;
    }
    return session;
  }

  async waitReady(timeoutMs = 45_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await this.send<{ url: string }>({ cmd: "ping" });
        await new Promise((res) => setTimeout(res, 1500)); // laisse l'app Angular s'hydrater
        return;
      } catch {
        // Content script pas encore injecté (ou page de login Google, où il ne s'exécute jamais)
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
    throw new Error("NotebookLM ne répond pas — vérifie que tu es connecté à NotebookLM (notebook.google.com) avec le bon compte Google.");
  }

  async send<T>(command: DriverCommand): Promise<T> {
    const r = (await chrome.tabs.sendMessage(this.tabId, { __driver: command })) as DriverResponse<T> | undefined;
    if (!r) throw new Error("Pas de réponse du content script.");
    if (!r.ok) throw new Error(`NotebookLM/${command.cmd}: ${r.error}`);
    return r.data;
  }

  /**
   * Création robuste : si NotebookLM fait une navigation complète (et non pushState),
   * le canal de message est coupé avant la réponse → on relit l'ID depuis l'URL du nouvel onglet.
   */
  async createNotebook(title: string): Promise<string> {
    const known = (await this.send<NotebookSummary[]>({ cmd: "listNotebooks" })).map((n) => n.id.toLowerCase());
    try {
      return (await this.send<{ notebookId: string }>({ cmd: "createNotebook", title, knownIds: known })).notebookId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/port closed|Receiving end|back\/forward cache|message channel/i.test(msg)) throw e;
      await this.waitReady();
      const { notebookId } = await this.send<{ notebookId: string | null }>({ cmd: "ping" });
      if (!notebookId) throw new Error("Création du notebook non confirmée.");
      if (known.includes(notebookId.toLowerCase())) throw new Error("Notebook existant ouvert au lieu d'un nouveau — abandon.");
      await this.send({ cmd: "renameNotebook", title }).catch(() => undefined);
      return notebookId;
    }
  }

  async close(): Promise<void> {
    await chrome.tabs.remove(this.tabId).catch(() => undefined);
  }
}

export function listNotebooks(): Promise<NotebookSummary[]> {
  return enqueue(async () => {
    const stop = keepAlive();
    const s = await NotebookSession.open();
    try {
      return await s.send<NotebookSummary[]>({ cmd: "listNotebooks" });
    } finally {
      stop();
      await s.close();
    }
  });
}

export interface PushResult {
  added: number;
  /** Index (dans `sources`) des sources non ajoutées. */
  failed: number[];
  errors: string[];
}

export function addSources(notebookId: string, sources: SourcePayload[]): Promise<PushResult> {
  return enqueue(async () => {
    const stop = keepAlive();
    const s = await NotebookSession.open(`notebook/${notebookId}`);
    const res: PushResult = { added: 0, failed: [], errors: [] };
    try {
      for (const [i, src] of sources.entries()) {
        try {
          await s.send({ cmd: "addSource", source: src });
          res.added++;
        } catch (e) {
          res.failed.push(i);
          res.errors.push(`${src.title}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return res;
    } finally {
      stop();
      await s.close();
    }
  });
}

/**
 * Crée un notebook, y ajoute les sources et lance l'Audio Overview.
 * `onCreated` est appelé dès la création (traçabilité/rétention même si une étape suivante échoue).
 * Un échec audio est loggué mais ne fait pas échouer le brief : le notebook reste exploitable.
 */
export function createNotebookWithAudio(
  title: string,
  sources: SourcePayload[],
  audio: AudioOptions,
  log: (m: string, level?: "info" | "warn" | "error") => void,
  onCreated: (notebookId: string) => Promise<void> = async () => undefined,
): Promise<{ notebookId: string; added: number; audioStarted: boolean }> {
  return enqueue(async () => {
    const stop = keepAlive();
    const s = await NotebookSession.open();
    try {
      const notebookId = await s.createNotebook(title);
      log(`Notebook créé : ${notebookId}`);
      await onCreated(notebookId);
      let added = 0;
      for (const src of sources) {
        try {
          await s.send({ cmd: "addSource", source: src });
          added++;
        } catch (e) {
          log(`Source ignorée « ${src.title} » : ${e instanceof Error ? e.message : String(e)}`, "warn");
        }
      }
      log(`${added}/${sources.length} sources ajoutées`);
      let audioStarted = false;
      if (added > 0) {
        try {
          const report = await s.send<{ applied: string[]; missing: string[] }>({ cmd: "generateAudio", audio });
          audioStarted = true;
          log(`Génération de l'Audio Overview lancée${report.applied.length ? ` (${report.applied.join(", ")})` : ""}`);
          if (report.missing.length) log(`Réglages audio non appliqués : ${report.missing.join(", ")}`, "warn");
        } catch (e) {
          log(`Audio Overview non lancé : ${e instanceof Error ? e.message : String(e)} — lance-le manuellement dans le notebook.`, "warn");
        }
      }
      return { notebookId, added, audioStarted };
    } finally {
      stop();
      await s.close();
    }
  });
}

export function audioStatus(notebookId: string): Promise<"ready" | "generating" | "none"> {
  return enqueue(async () => {
    const s = await NotebookSession.open(`notebook/${notebookId}`);
    try {
      await new Promise((r) => setTimeout(r, 3000));
      return await s.send<"ready" | "generating" | "none">({ cmd: "audioStatus" });
    } finally {
      await s.close();
    }
  });
}

/**
 * Ouvre le notebook au premier plan (onglet conservé, contrairement aux onglets d'automatisation)
 * et lance la lecture de l'Audio Overview.
 */
export async function playPodcast(notebookId: string): Promise<{ status: "playing" | "opened" | "not_ready"; url: string }> {
  const url = await notebookUrl(notebookId);
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab.id === undefined) return { status: "opened", url };
  const tabId = tab.id;
  const send = (c: DriverCommand) => chrome.tabs.sendMessage(tabId, { __driver: c }) as Promise<DriverResponse<"playing" | "not_ready"> | undefined>;
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try {
      const r = await send({ cmd: "playAudio" });
      if (r?.ok) return { status: r.data, url };
      break;
    } catch {
      await new Promise((res) => setTimeout(res, 1000)); // content script pas encore prêt
    }
  }
  return { status: "opened", url };
}

export function deleteNotebook(notebookId: string): Promise<void> {
  return enqueue(async () => {
    const s = await NotebookSession.open();
    try {
      await s.send({ cmd: "deleteNotebook", notebookId });
    } finally {
      await s.close();
    }
  });
}
