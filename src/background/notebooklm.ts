import type { DriverCommand, DriverResponse, NotebookSummary } from "../shared/messages";
import { getSettings } from "../shared/storage";
import type { SourcePayload } from "../shared/types";

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
    ? `https://notebooklm.google.com/u/${s.notebooklm.accountIndex}/`
    : "https://notebooklm.google.com/";
}

export async function notebookUrl(notebookId: string): Promise<string> {
  return `${await baseUrl()}notebook/${notebookId}`;
}

/** Garde le service worker éveillé pendant les jobs longs (appel d'API extension < 30 s). */
function keepAlive(): () => void {
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
    await session.waitReady();
    return session;
  }

  private async waitReady(timeoutMs = 45_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const r = await this.send<{ url: string }>({ cmd: "ping" });
        if (r.url.includes("accounts.google.com")) throw new Error("Non connecté à NotebookLM (login Google requis).");
        await new Promise((res) => setTimeout(res, 1500)); // laisse l'app Angular s'hydrater
        return;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Non connecté")) throw e;
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
    throw new Error("NotebookLM ne répond pas (content script non chargé).");
  }

  async send<T>(command: DriverCommand): Promise<T> {
    const r = (await chrome.tabs.sendMessage(this.tabId, { __driver: command })) as DriverResponse<T> | undefined;
    if (!r) throw new Error("Pas de réponse du content script.");
    if (!r.ok) throw new Error(`NotebookLM/${command.cmd}: ${r.error}`);
    return r.data;
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
  errors: string[];
}

export function addSources(notebookId: string, sources: SourcePayload[]): Promise<PushResult> {
  return enqueue(async () => {
    const stop = keepAlive();
    const s = await NotebookSession.open(`notebook/${notebookId}`);
    const res: PushResult = { added: 0, errors: [] };
    try {
      for (const src of sources) {
        try {
          await s.send({ cmd: "addSource", source: src });
          res.added++;
        } catch (e) {
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

/** Crée un notebook, y ajoute les sources et lance l'Audio Overview. */
export function createNotebookWithAudio(
  title: string,
  sources: SourcePayload[],
  audioInstructions: string,
  log: (m: string, level?: "info" | "warn" | "error") => void,
): Promise<{ notebookId: string; added: number }> {
  return enqueue(async () => {
    const stop = keepAlive();
    const s = await NotebookSession.open();
    try {
      const { notebookId } = await s.send<{ notebookId: string }>({ cmd: "createNotebook", title });
      log(`Notebook créé : ${notebookId}`);
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
      if (added > 0) {
        await s.send({ cmd: "generateAudio", instructions: audioInstructions });
        log("Génération de l'Audio Overview lancée");
      }
      return { notebookId, added };
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
