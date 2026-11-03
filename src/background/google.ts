import { E2E_GOOGLE_TOKEN } from "../shared/endpoints";

/**
 * Jeton Google partagé Gmail + Agenda (chrome.identity, scopes en lecture seule déclarés dans
 * manifest.json → un seul écran de consentement). Nécessite un OAuth client ID « Chrome extension ».
 */

export function googleConfigured(): boolean {
  if (E2E_GOOGLE_TOKEN) return true;
  const id = chrome.runtime.getManifest().oauth2?.client_id ?? "";
  return /\.apps\.googleusercontent\.com$/.test(id) && !id.startsWith("REPLACE");
}

export async function getGoogleToken(interactive: boolean): Promise<string> {
  if (E2E_GOOGLE_TOKEN) return E2E_GOOGLE_TOKEN;
  if (!googleConfigured()) {
    throw new Error("Google non configuré : renseigner oauth2.client_id dans manifest.json (voir README).");
  }
  // getAuthToken peut ne jamais rendre la main (fenêtre de consentement ignorée, client ID invalide) :
  // borne explicite pour ne pas bloquer le brief.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Autorisation Google sans réponse (délai dépassé).")), interactive ? 120_000 : 20_000);
  });
  try {
    const r = await Promise.race([chrome.identity.getAuthToken({ interactive }), timeout]);
    if (!r?.token) throw new Error("Pas de token Google (autorisation refusée).");
    return r.token;
  } finally {
    clearTimeout(timer);
  }
}

/** GET JSON sur une API Google ; un 401 invalide le jeton en cache (renouvelé au prochain appel). */
export async function googleGet<T>(token: string, url: string, service: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 401) {
    if (!E2E_GOOGLE_TOKEN) await chrome.identity.removeCachedAuthToken({ token });
    throw new Error(`${service} : jeton Google expiré — relancer (il sera renouvelé).`);
  }
  if (res.status === 403) throw new Error(`${service} : accès refusé (scope non accordé ou API non activée dans Google Cloud).`);
  if (!res.ok) throw new Error(`${service} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}
