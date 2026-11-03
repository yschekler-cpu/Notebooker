import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_BASE_URL } from "../shared/endpoints";
import type { Settings } from "../shared/types";

/**
 * Pré-traitement optionnel du brief par Claude : tri, dédoublonnage, priorisation.
 * Désactivé par défaut. Le texte reçu ici est DÉJÀ masqué (cf. shared/redact.ts).
 *
 * Authentification :
 * - api_key     → clé Console (envoyée par le SDK 1.x en Authorization: Bearer).
 * - oauth_token → jeton OAuth Anthropic (Authorization: Bearer + beta oauth-2025-04-20),
 *                 obtenu via `ant auth print-credentials --access-token`. Jeton court :
 *                 à renouveler (Anthropic ne propose pas d'enregistrement de client OAuth
 *                 tiers pour une extension — voir README).
 */

const OAUTH_BETA = "oauth-2025-04-20";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** `fetchImpl` injectable pour les tests ; en extension, le fetch natif du service worker. */
export function client(cfg: Settings["claude"], fetchImpl?: typeof fetch): Anthropic {
  const base = {
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
    ...(ANTHROPIC_BASE_URL ? { baseURL: ANTHROPIC_BASE_URL } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
  if (cfg.authMode === "oauth_token") {
    if (!cfg.oauthToken) throw new Error("Jeton OAuth Claude manquant.");
    return new Anthropic({ ...base, authToken: cfg.oauthToken });
  }
  if (!cfg.apiKey) throw new Error("Clé API Claude manquante.");
  return new Anthropic({ ...base, apiKey: cfg.apiKey });
}

function betas(cfg: Settings["claude"], withFallback: boolean): string[] {
  const list = withFallback ? [FALLBACK_BETA] : [];
  if (cfg.authMode === "oauth_token") list.push(OAUTH_BETA);
  return list;
}

/** Les fallbacks serveur sont un plus, pas un prérequis : si l'API les rejette (400), on retente sans. */
async function withFallbackRetry<T>(run: (withFallback: boolean) => Promise<T>): Promise<T> {
  try {
    return await run(true);
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) return run(false);
    throw e;
  }
}

/**
 * Prompt système COMMUN aux deux tâches (synthèse, extraction d'actions) : il fait partie du
 * préfixe mis en cache avec le corpus. Les consignes propres à chaque tâche viennent APRÈS le
 * corpus, donc la seconde requête relit le cache au lieu de repayer le corpus.
 */
const SYSTEM = `Tu assistes un Product Manager d'une plateforme d'investissement en Private Equity (Opale Capital).
Tu reçois un corpus d'emails, de réunions d'agenda et de pages Notion récents. Les données sont pseudonymisées : [EMAIL], [IBAN], [TEL], [MONTANT]… sont des masques, ne cherche jamais à les reconstituer.
N'invente rien : chaque affirmation doit être traçable dans le corpus.`;

const SYNTHESIS_TASK = `TÂCHE : produis le brief en Markdown, en français, structuré ainsi :
1. "## À traiter aujourd'hui" — décisions attendues, deadlines, demandes directes (qui / quoi / échéance).
2. "## Réunions du jour" — pour chaque réunion : enjeu et points à préparer (si un agenda est fourni).
3. "## Projets & produit" — avancées, blocages, changements de specs, par projet.
4. "## Conformité & opérations" — sujets KYC/LCB-FT, réglementaires, incidents.
5. "## Pour info" — le reste, une ligne par sujet.
Règles : regroupe les doublons (un fil = un sujet), ignore newsletters et notifications automatiques sans action, cite la source entre crochets ([Mail: objet], [Notion: titre], [Agenda: réunion]).`;

const ACTIONS_TASK = `TÂCHE : extrais UNIQUEMENT les actions explicitement demandées au destinataire du corpus (le PM) ou qu'il s'est engagé à faire.
Exclus : actions d'autres personnes, notifications automatiques, newsletters, simples informations.
Pour chaque action : un titre impératif court (≤ 90 caractères, ex. « Valider la spec KYC Italie »), le demandeur (nom ou masque, "" si inconnu),
l'échéance au format AAAA-MM-JJ si elle est explicite ou déductible sans ambiguïté (sinon ""), une priorité (haute = échéance ≤ 48 h ou bloquant ; basse = sans urgence),
la source entre crochets et une phrase de contexte. Si aucune action : liste vide.`;

export const ACTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "requester", "due", "priority", "source", "context"],
        properties: {
          title: { type: "string" },
          requester: { type: "string" },
          due: { type: "string" },
          priority: { type: "string", enum: ["haute", "moyenne", "basse"] },
          source: { type: "string" },
          context: { type: "string" },
        },
      },
    },
  },
} as const;

export interface ExtractedAction {
  title: string;
  requester: string;
  due: string;
  priority: "haute" | "moyenne" | "basse";
  source: string;
  context: string;
}

/** Validation défensive de la sortie structurée (troncature, valeurs hors schéma). */
export function parseActions(json: string): ExtractedAction[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("Sortie d'extraction d'actions illisible (JSON invalide).");
  }
  const list = (data as { actions?: unknown }).actions;
  if (!Array.isArray(list)) throw new Error("Sortie d'extraction d'actions sans tableau « actions ».");
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  return list
    .map((a: Record<string, unknown>) => ({
      title: str(a.title, 120),
      requester: str(a.requester, 80),
      due: /^\d{4}-\d{2}-\d{2}$/.test(str(a.due, 10)) ? str(a.due, 10) : "",
      priority: (["haute", "moyenne", "basse"].includes(a.priority as string) ? a.priority : "moyenne") as ExtractedAction["priority"],
      source: str(a.source, 200),
      context: str(a.context, 500),
    }))
    .filter((a) => a.title.length >= 3)
    .slice(0, 30);
}

export interface AnalysisRequest {
  corpus: string;
  synthesis?: { focus: string; memoryContext: string };
  actions?: boolean;
  /** Date du jour (pour résoudre « demain », « vendredi »…). */
  today: string;
}

export interface AnalysisResult {
  brief?: string;
  actions?: ExtractedAction[];
  errors: string[];
}

function messagesFor(corpus: string, task: string) {
  return [
    {
      role: "user" as const,
      content: [
        // Point de cache : tout ce qui précède (system + corpus) est réutilisé par la tâche suivante.
        { type: "text" as const, text: corpus, cache_control: { type: "ephemeral" as const } },
        { type: "text" as const, text: task },
      ],
    },
  ];
}

/**
 * Synthèse puis extraction d'actions sur le même corpus (préfixe en cache).
 * Les deux tâches sont indépendantes : l'échec de l'une n'annule pas l'autre.
 */
export async function analyzeCorpus(cfg: Settings["claude"], req: AnalysisRequest, fetchImpl?: typeof fetch): Promise<AnalysisResult> {
  const result: AnalysisResult = { errors: [] };
  let c: Anthropic;
  try {
    c = client(cfg, fetchImpl);
  } catch (e) {
    // Mauvaise configuration (clé/jeton manquant) : le brief continue sans Claude.
    result.errors.push(`Configuration : ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }
  const dateLine = `Date du jour : ${req.today}.`;

  if (req.synthesis) {
    try {
      const task = [SYNTHESIS_TASK, dateLine, req.synthesis.focus && `ANGLE DEMANDÉ : ${req.synthesis.focus}`, req.synthesis.memoryContext && `SUIVI DEPUIS LE DERNIER BRIEF (à refléter : signale « nouveau » / « toujours ouvert depuis N jours ») :\n${req.synthesis.memoryContext}`]
        .filter(Boolean)
        .join("\n\n");
      const msg = await withFallbackRetry((withFallback) =>
        c.beta.messages
          .stream({
            model: cfg.model,
            max_tokens: 16000,
            betas: betas(cfg, withFallback),
            ...(withFallback ? { fallbacks: "default" as const } : {}),
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
            system: SYSTEM,
            messages: messagesFor(req.corpus, task),
          })
          .finalMessage(),
      );
      if (msg.stop_reason === "refusal") throw new Error("Claude a refusé la synthèse (stop_reason=refusal).");
      const text = textOf(msg.content);
      if (!text) throw new Error(`Synthèse vide (stop_reason=${msg.stop_reason}).`);
      result.brief = msg.stop_reason === "max_tokens" ? `${text}\n\n[… synthèse tronquée]` : text;
    } catch (e) {
      result.errors.push(`Synthèse : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (req.actions) {
    try {
      const msg = await withFallbackRetry((withFallback) =>
        c.beta.messages
          .stream({
            model: cfg.model,
            max_tokens: 8000,
            betas: betas(cfg, withFallback),
            ...(withFallback ? { fallbacks: "default" as const } : {}),
            thinking: { type: "adaptive" },
            output_config: { effort: "medium", format: { type: "json_schema", schema: ACTIONS_SCHEMA as unknown as Record<string, unknown> } },
            system: SYSTEM,
            messages: messagesFor(req.corpus, `${ACTIONS_TASK}\n\n${dateLine}`),
          })
          .finalMessage(),
      );
      if (msg.stop_reason === "refusal") throw new Error("Claude a refusé l'extraction (stop_reason=refusal).");
      if (msg.stop_reason === "max_tokens") throw new Error("Extraction tronquée (max_tokens) — aucune action importée.");
      result.actions = parseActions(textOf(msg.content));
    } catch (e) {
      result.errors.push(`Actions : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

function textOf(content: { type: string }[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export async function testClaude(cfg: Settings["claude"], fetchImpl?: typeof fetch): Promise<string> {
  const c = client(cfg, fetchImpl);
  const msg = await withFallbackRetry((withFallback) =>
    c.beta.messages.create({
      model: cfg.model,
      max_tokens: 2048, // la réflexion (toujours active sur ce modèle) consomme une partie du budget
      betas: betas(cfg, withFallback),
      ...(withFallback ? { fallbacks: "default" as const } : {}),
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Réponds uniquement: OK" }],
    }),
  );
  const block = msg.content.find((b) => b.type === "text");
  return block && block.type === "text" ? `${block.text.trim()} (${msg.model})` : `stop_reason=${msg.stop_reason}`;
}
