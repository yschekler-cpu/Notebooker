import Anthropic from "@anthropic-ai/sdk";
import type { Settings } from "../shared/types";

/**
 * Pré-traitement optionnel du brief par Claude : tri, dédoublonnage, priorisation.
 * Désactivé par défaut. Le texte reçu ici est DÉJÀ masqué (cf. shared/redact.ts).
 *
 * Authentification :
 * - api_key     → clé Console (x-api-key).
 * - oauth_token → jeton OAuth Anthropic (Authorization: Bearer + beta oauth-2025-04-20),
 *                 obtenu via `ant auth print-credentials --access-token`. Jeton court :
 *                 à renouveler (Anthropic ne propose pas d'enregistrement de client OAuth
 *                 tiers pour une extension — voir README).
 */

const OAUTH_BETA = "oauth-2025-04-20";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function client(cfg: Settings["claude"]): Anthropic {
  const base = { dangerouslyAllowBrowser: true, maxRetries: 2 };
  if (cfg.authMode === "oauth_token") {
    if (!cfg.oauthToken) throw new Error("Jeton OAuth Claude manquant.");
    return new Anthropic({ ...base, authToken: cfg.oauthToken });
  }
  if (!cfg.apiKey) throw new Error("Clé API Claude manquante.");
  return new Anthropic({ ...base, apiKey: cfg.apiKey });
}

function betas(cfg: Settings["claude"]): string[] {
  return cfg.authMode === "oauth_token" ? [FALLBACK_BETA, OAUTH_BETA] : [FALLBACK_BETA];
}

const SYSTEM = `Tu prépares le brief matinal d'un Product Manager d'une plateforme d'investissement en Private Equity.
Tu reçois des emails et des pages Notion modifiées sur les dernières 24h (données pseudonymisées : [EMAIL], [IBAN], etc. sont des masques, ne cherche pas à les reconstituer).
Produis un document Markdown en français, structuré ainsi :
1. "## À traiter aujourd'hui" — décisions attendues, deadlines, demandes directes (qui / quoi / échéance).
2. "## Projets & produit" — avancées, blocages, changements de specs, par projet.
3. "## Conformité & opérations" — sujets KYC/LCB-FT, réglementaires, incidents.
4. "## Pour info" — le reste, en une ligne par sujet.
Règles : regroupe les doublons (un fil = un sujet), ignore newsletters/notifications automatiques sans action, cite la source entre crochets ([Mail: objet] ou [Notion: titre]). N'invente rien.`;

export async function synthesizeBriefing(cfg: Settings["claude"], corpus: string): Promise<string> {
  const c = client(cfg);
  const stream = c.beta.messages.stream({
    model: cfg.model,
    max_tokens: 16000,
    betas: betas(cfg),
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: SYSTEM,
    messages: [{ role: "user", content: corpus }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") {
    throw new Error("Claude a refusé la requête (stop_reason=refusal) — brief généré sans synthèse.");
  }
  const text = msg.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error(`Réponse Claude vide (stop_reason=${msg.stop_reason}).`);
  return text;
}

export async function testClaude(cfg: Settings["claude"]): Promise<string> {
  const c = client(cfg);
  const msg = await c.beta.messages.create({
    model: cfg.model,
    max_tokens: 256,
    betas: betas(cfg),
    fallbacks: "default",
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "Réponds uniquement: OK" }],
  });
  const block = msg.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : String(msg.stop_reason);
}
