import { E2E_BASE_URL } from "../shared/endpoints";
import type { BriefProfile, Settings } from "../shared/types";
import { parseManifest, type InboxManifest } from "./localInbox";
import { NotionClient } from "./notion";

/**
 * Mode « Routine Claude (API) ».
 *
 * 1. Notebooker déclenche une routine Claude Code par son endpoint officiel
 *    POST https://api.anthropic.com/v1/claude_code/routines/{trig_…}/fire
 *    (jeton propre à la routine, « sk-ant-oat01-… », qui ne donne AUCUN accès en lecture).
 * 2. L'API ne renvoie que l'id / l'URL de session (pas le résultat). La routine s'exécute dans le
 *    cloud et dépose son manifest (format notebooker-brief v1) dans une page Notion de dépôt.
 * 3. Notebooker interroge cette page jusqu'à trouver le manifest portant son `requestId`.
 */

const FIRE_PATH = /^\/v1\/claude_code\/routines\/trig_[A-Za-z0-9_-]+\/fire$/;

/**
 * Le jeton ne doit partir que vers l'endpoint officiel d'Anthropic (ou le mock en build E2E) :
 * une URL mal collée ne doit jamais exfiltrer le jeton vers un autre hôte.
 */
export function validateFireUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("URL d'API de la routine invalide (copie l'URL affichée par Claude Code lors de l'ajout du déclencheur API).");
  }
  const official = u.protocol === "https:" && u.hostname === "api.anthropic.com";
  const e2e = !!E2E_BASE_URL && u.origin === new URL(E2E_BASE_URL).origin;
  if ((!official && !e2e) || !FIRE_PATH.test(u.pathname) || u.search || u.hash) {
    throw new Error("URL d'API refusée : attendu https://api.anthropic.com/v1/claude_code/routines/trig_…/fire");
  }
  return u.toString();
}

export function validateRoutineToken(token: string): string {
  const t = token.trim();
  if (!/^sk-ant-oat01-[A-Za-z0-9_-]{10,}$/.test(t)) throw new Error("Jeton de routine invalide (attendu : sk-ant-oat01-…, généré avec le déclencheur API de la routine).");
  return t;
}

/** Contexte transmis à la routine dans le champ `text` (≤ 65 536 caractères). */
export function fireText(profile: BriefProfile, requestId: string, notionPage: string, now = new Date()): string {
  return [
    `Déclenchement Notebooker — profil « ${profile.name} ».`,
    `requestId: ${requestId}`,
    `Date : ${now.toISOString()}.`,
    `Dépose le manifest dans la page Notion : ${notionPage}`,
    `Recopie exactement le requestId ci-dessus dans le champ "requestId" du manifest.`,
  ].join("\n");
}

export interface FireResult {
  sessionId: string;
  sessionUrl: string;
}

export async function fireRoutine(profile: BriefProfile, requestId: string, fetchImpl: typeof fetch = fetch): Promise<FireResult> {
  const url = validateFireUrl(profile.routine.fireUrl);
  const token = validateRoutineToken(profile.routine.token);
  if (!profile.routine.notionPage.trim()) throw new Error("Page Notion de dépôt non renseignée.");
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2026-10-21", "Content-Type": "application/json" },
      body: JSON.stringify({ text: fireText(profile, requestId, profile.routine.notionPage) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Déclenchement de la routine impossible (réseau).");
  }
  const body = (await res.json().catch(() => ({}))) as { type?: string; claude_code_session_id?: string; claude_code_session_url?: string; error?: { type?: string; message?: string } };
  if (!res.ok) {
    const map: Record<number, string> = {
      400: "requête refusée (routine en pause ?)",
      401: "jeton refusé — régénère-le dans la routine et colle le nouveau",
      403: "compte sans accès aux routines Claude Code",
      404: "routine introuvable — vérifie l'URL",
      429: `limite horaire de déclenchements atteinte${res.headers.get("Retry-After") ? ` (réessaie dans ${res.headers.get("Retry-After")} s)` : ""}`,
    };
    throw new Error(`Routine : ${map[res.status] ?? `erreur ${res.status}`}${body.error?.message ? ` — ${body.error.message.slice(0, 160)}` : ""}`);
  }
  if (body.type !== "routine_fire" || !body.claude_code_session_id) throw new Error("Réponse inattendue de l'API des routines.");
  return { sessionId: body.claude_code_session_id, sessionUrl: body.claude_code_session_url ?? "" };
}

/** Lit le manifest déposé dans la page Notion : premier bloc de code qui parse comme notebooker-brief. */
export async function readRoutineManifest(settings: Settings, profile: BriefProfile): Promise<InboxManifest | null> {
  const ws = profile.routine.workspace;
  const notion = new NotionClient(settings.notion[ws], ws);
  if (!notion.configured) throw new Error(`Notion non connecté (${settings.notion[ws].label}) : la page de dépôt est illisible.`);
  const blocks = await notion.codeBlocks(profile.routine.notionPage);
  let lastError: string | null = null;
  for (const b of blocks) {
    if (!/"notebooker-brief"/.test(b.text)) continue;
    try {
      return parseManifest(b.text);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  if (lastError) throw new Error(`Manifest présent mais invalide : ${lastError}`);
  return null;
}

/** Le manifest correspond-il à NOTRE déclenchement ? (requestId, à défaut fraîcheur). */
export function matchesRequest(m: InboxManifest, requestId: string, firedAt: number): boolean {
  if (m.requestId) return m.requestId === requestId;
  return Date.parse(m.generatedAt) >= firedAt - 60_000;
}
