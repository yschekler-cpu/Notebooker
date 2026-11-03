import { NOTION_API, NOTION_OAUTH_AUTHORIZE } from "../shared/endpoints";
import { emptyOAuth, getSettings, mutateSettings } from "../shared/storage";
import type { NotionOAuthState, NotionWorkspaceKey } from "../shared/types";

/**
 * Connexion Notion OAuth 2.0 (au niveau de l'utilisateur), alternative au jeton d'API
 * quand l'espace de travail n'autorise pas les connexions internes.
 *
 * - Flux : chrome.identity.launchWebAuthFlow → page Notion (choix des pages partagées)
 *   → redirection vers https://<id-extension>.chromiumapp.org/notion → échange du code.
 * - Le Client ID et le secret sont saisis par l'utilisateur dans les réglages
 *   (storage.local, inaccessible aux pages web) : aucun secret n'est embarqué dans le code.
 * - Le jeton d'accès est renouvelé automatiquement via le refresh token (sur 401).
 */

export const REDIRECT_PATH = "notion";

/** URI de redirection à déclarer dans la connexion OAuth Notion. */
export function redirectUri(): string {
  return chrome.identity.getRedirectURL(REDIRECT_PATH);
}

export function buildAuthorizeUrl(clientId: string, redirect: string, state: string): string {
  const qs = new URLSearchParams({ client_id: clientId, response_type: "code", owner: "user", redirect_uri: redirect, state });
  return `${NOTION_OAUTH_AUTHORIZE}?${qs}`;
}

/** Extrait le code de l'URL de retour ; refuse un `state` inattendu (protection CSRF) ou un refus utilisateur. */
export function parseRedirect(url: string, expectedState: string): string {
  const u = new URL(url);
  const error = u.searchParams.get("error");
  if (error) throw new Error(error === "access_denied" ? "Autorisation refusée dans Notion." : `Notion a renvoyé une erreur : ${error}`);
  if (u.searchParams.get("state") !== expectedState) throw new Error("Réponse OAuth invalide (state différent) — connexion annulée par sécurité.");
  const code = u.searchParams.get("code");
  if (!code) throw new Error("Réponse OAuth sans code d'autorisation.");
  return code;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string;
}

function basic(clientId: string, secret: string): string {
  return `Basic ${btoa(`${clientId}:${secret}`)}`;
}

async function tokenRequest(clientId: string, secret: string, body: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
  const res = await fetchImpl(`${NOTION_API}/oauth/token`, {
    method: "POST",
    headers: { Authorization: basic(clientId, secret), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* corps non JSON : message générique ci-dessous */
  }
  if (!res.ok) {
    const code = String(data.error ?? res.status);
    if (code === "invalid_client") throw new Error("Client ID ou secret Notion invalide.");
    if (code === "invalid_grant") throw new Error("Autorisation Notion expirée ou révoquée — reconnecte-toi.");
    throw new Error(`Notion OAuth ${res.status} : ${String(data.error_description ?? data.message ?? code).slice(0, 200)}`);
  }
  if (typeof data.access_token !== "string" || !data.access_token) throw new Error("Réponse OAuth Notion sans access_token.");
  return data as unknown as TokenResponse;
}

export function exchangeCode(clientId: string, secret: string, code: string, redirect: string, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  return tokenRequest(clientId, secret, { grant_type: "authorization_code", code, redirect_uri: redirect }, fetchImpl);
}

export function refreshTokens(clientId: string, secret: string, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  return tokenRequest(clientId, secret, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

function applyTokens(prev: NotionOAuthState, t: TokenResponse): NotionOAuthState {
  return {
    ...prev,
    accessToken: t.access_token,
    // Notion renvoie un nouveau refresh token à chaque renouvellement ; on garde l'ancien s'il est absent.
    refreshToken: t.refresh_token || prev.refreshToken,
    botId: t.bot_id ?? prev.botId,
    workspaceId: t.workspace_id ?? prev.workspaceId,
    workspaceName: t.workspace_name ?? prev.workspaceName,
  };
}

/** Lance le flux complet (fenêtre Notion) et enregistre les jetons. */
export async function connectNotion(ws: NotionWorkspaceKey): Promise<{ workspaceName: string }> {
  const { clientId, clientSecret } = (await getSettings()).notion[ws].oauth;
  if (!clientId.trim() || !clientSecret.trim()) throw new Error("Renseigne le Client ID et le secret OAuth Notion, puis enregistre.");
  const state = crypto.randomUUID();
  const redirect = redirectUri();
  const result = await chrome.identity.launchWebAuthFlow({ url: buildAuthorizeUrl(clientId.trim(), redirect, state), interactive: true });
  if (!result) throw new Error("Connexion Notion annulée.");
  const code = parseRedirect(result, state);
  const tokens = await exchangeCode(clientId.trim(), clientSecret.trim(), code, redirect);
  const saved = await mutateSettings((s) => {
    s.notion[ws] = { ...s.notion[ws], authMode: "oauth", oauth: { ...applyTokens(s.notion[ws].oauth, tokens), connectedAt: new Date().toISOString() } };
    return s;
  });
  return { workspaceName: saved.notion[ws].oauth.workspaceName || "espace Notion" };
}

const refreshing = new Map<NotionWorkspaceKey, Promise<string>>();

/**
 * Renouvelle le jeton d'accès. Dédoublonné : plusieurs appels simultanés (synchro + brief)
 * partagent le même renouvellement — un refresh token ne doit être consommé qu'une fois.
 */
export function refreshNotionAccess(ws: NotionWorkspaceKey, fetchImpl: typeof fetch = fetch): Promise<string> {
  const pending = refreshing.get(ws);
  if (pending) return pending;
  const job = (async () => {
    const o = (await getSettings()).notion[ws].oauth;
    if (!o.refreshToken) throw new Error("Session Notion expirée — reconnecte-toi (Réglages › Notion).");
    const tokens = await refreshTokens(o.clientId, o.clientSecret, o.refreshToken, fetchImpl);
    const saved = await mutateSettings((s) => {
      s.notion[ws] = { ...s.notion[ws], oauth: applyTokens(s.notion[ws].oauth, tokens) };
      return s;
    });
    return saved.notion[ws].oauth.accessToken;
  })().finally(() => refreshing.delete(ws));
  refreshing.set(ws, job);
  return job;
}

/** Révoque le jeton côté Notion (best-effort) puis efface les jetons locaux (Client ID / secret conservés). */
export async function disconnectNotion(ws: NotionWorkspaceKey, fetchImpl: typeof fetch = fetch): Promise<{ revoked: boolean }> {
  const o = (await getSettings()).notion[ws].oauth;
  let revoked = false;
  if (o.accessToken && o.clientId && o.clientSecret) {
    try {
      const res = await fetchImpl(`${NOTION_API}/oauth/revoke`, {
        method: "POST",
        headers: { Authorization: basic(o.clientId, o.clientSecret), "Content-Type": "application/json", "Notion-Version": "2026-03-11" },
        body: JSON.stringify({ token: o.accessToken }),
        signal: AbortSignal.timeout(15_000),
      });
      revoked = res.ok;
    } catch {
      /* hors ligne : les jetons locaux sont effacés quand même */
    }
  }
  await mutateSettings((s) => {
    const keep = s.notion[ws].oauth;
    s.notion[ws] = { ...s.notion[ws], oauth: { ...emptyOAuth(), clientId: keep.clientId, clientSecret: keep.clientSecret } };
    return s;
  });
  return { revoked };
}
