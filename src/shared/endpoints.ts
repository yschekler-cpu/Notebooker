/**
 * Origines des services tiers. En production : valeurs officielles.
 * Le build E2E (`node build.mjs --e2e`) injecte `__E2E_BASE__` pour tout router vers
 * un serveur de mock local — aucun autre code ne diffère entre les deux builds.
 */
declare const __E2E_BASE__: string;
const E2E: string = typeof __E2E_BASE__ === "string" ? __E2E_BASE__ : "";

export const NOTEBOOKLM_ORIGIN = E2E || "https://notebooklm.google.com";
export const NOTION_API = E2E ? `${E2E}/notion/v1` : "https://api.notion.com/v1";
/** undefined = valeur par défaut du SDK Anthropic. */
export const ANTHROPIC_BASE_URL: string | undefined = E2E ? `${E2E}/anthropic` : undefined;
export const GMAIL_API = E2E ? `${E2E}/gmail/v1/users/me` : "https://gmail.googleapis.com/gmail/v1/users/me";
export const CALENDAR_API = E2E ? `${E2E}/calendar/v3` : "https://www.googleapis.com/calendar/v3";
/** Build E2E uniquement : pas de consentement Google possible en test → jeton factice accepté par le mock. */
export const E2E_GOOGLE_TOKEN: string | null = E2E ? "e2e-google-token" : null;
/** Page d'autorisation Notion (OAuth). */
export const NOTION_OAUTH_AUTHORIZE = E2E ? `${E2E}/notion/v1/oauth/authorize` : "https://api.notion.com/v1/oauth/authorize";
