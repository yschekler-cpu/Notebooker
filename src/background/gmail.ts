import { GMAIL_API } from "../shared/endpoints";
import { htmlToText } from "./text";

/**
 * Lecture Gmail via chrome.identity (scope gmail.readonly uniquement — pas d'envoi, pas de modification).
 * Nécessite un OAuth client ID de type « Chrome extension » dans manifest.json.
 */

const BASE = GMAIL_API;

export interface MailDigestItem {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  labels: string[];
}

/** Gmail n'est utilisable que si un vrai OAuth client ID a été renseigné dans le manifest. */
export function gmailConfigured(): boolean {
  const id = chrome.runtime.getManifest().oauth2?.client_id ?? "";
  return /\.apps\.googleusercontent\.com$/.test(id) && !id.startsWith("REPLACE");
}

export async function getGoogleToken(interactive: boolean): Promise<string> {
  if (!gmailConfigured()) {
    throw new Error("Gmail non configuré : renseigner oauth2.client_id dans manifest.json (voir README).");
  }
  // getAuthToken peut ne jamais rendre la main (fenêtre de consentement ignorée, client ID invalide) :
  // borne explicite pour ne pas bloquer le brief.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Autorisation Google sans réponse (délai dépassé).")), interactive ? 120_000 : 20_000);
  });
  try {
    const r = await Promise.race([chrome.identity.getAuthToken({ interactive }), timeout]);
    if (!r?.token) throw new Error("Pas de token Google (autorisation Gmail refusée).");
    return r.token;
  } finally {
    clearTimeout(timer);
  }
}

async function gmail<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token });
    throw new Error("Token Google expiré — relancer (il sera renouvelé).");
  }
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Construit la requête Gmail : base + fenêtre temporelle + exclusions (expéditeurs, domaines, labels). */
export function buildGmailQuery(base: string, lookbackHours: number, exclusions: string[]): string {
  const days = Math.max(1, Math.ceil(lookbackHours / 24));
  return [base.trim(), `newer_than:${days}d`, ...exclusions.map(exclusionTerm).filter(Boolean)].filter(Boolean).join(" ");
}

/**
 * Normalise une exclusion saisie librement en terme Gmail négatif.
 * « from:x@y », « -x@y », « label:KYC conf », « Jean Dupont » → -from:x@y, -from:x@y, -label:"KYC conf", -from:"Jean Dupont".
 * Une exclusion mal formée ne doit JAMAIS devenir un terme positif (qui filtrerait toute la boîte)
 * ni un no-op (qui laisserait passer des mails KYC).
 */
export function exclusionTerm(raw: string): string {
  let e = raw.trim().replace(/^-+/, "").trim();
  if (!e) return "";
  let op = "from";
  const m = /^(from|label|subject|to|cc|list|category):\s*(.*)$/i.exec(e);
  if (m) {
    op = m[1]!.toLowerCase();
    e = m[2]!.trim();
  }
  e = e.replace(/^"(.*)"$/, "$1").replace(/"/g, "");
  if (!e) return "";
  return /[\s()]/.test(e) ? `-${op}:"${e}"` : `-${op}:${e}`;
}

export async function fetchRecentMails(opts: {
  query: string;
  max: number;
  since: Date;
  interactive: boolean;
}): Promise<MailDigestItem[]> {
  const token = await getGoogleToken(opts.interactive);
  const list = await gmail<{ messages?: { id: string; threadId: string }[] }>(
    token,
    `/messages?${new URLSearchParams({ q: opts.query, maxResults: String(opts.max) })}`,
  );
  const ids = list.messages ?? [];
  const out: MailDigestItem[] = [];
  // Parallélisme borné pour respecter les quotas Gmail
  let failed = 0;
  for (let i = 0; i < ids.length; i += 8) {
    // allSettled : un message en 404/429 ne doit pas faire perdre tout Gmail du brief.
    const batch = await Promise.allSettled(ids.slice(i, i + 8).map((m) => gmail<GmailMessage>(token, `/messages/${m.id}?format=full`)));
    for (const r of batch) {
      if (r.status === "rejected") {
        failed++;
        continue;
      }
      const item = toDigest(r.value);
      if (new Date(item.date) >= opts.since) out.push(item);
    }
  }
  if (failed && out.length === 0) throw new Error(`${failed} message(s) Gmail illisible(s).`);
  return out;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  internalDate: string;
  labelIds?: string[];
  payload: GmailPart;
}

function toDigest(m: GmailMessage): MailDigestItem {
  const h = (name: string) => m.payload.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? "";
  return {
    id: m.id,
    threadId: m.threadId,
    from: h("from"),
    subject: h("subject") || "(sans objet)",
    date: new Date(Number(m.internalDate)).toISOString(),
    snippet: m.snippet,
    body: stripQuoted(extractBody(m.payload)).slice(0, 6000),
    labels: m.labelIds ?? [],
  };
}

function extractBody(part: GmailPart): string {
  const plain = findPart(part, "text/plain");
  if (plain?.body?.data) return b64url(plain.body.data);
  const html = findPart(part, "text/html");
  if (html?.body?.data) return htmlToText(b64url(html.body.data));
  return "";
}

function findPart(part: GmailPart, mime: string): GmailPart | undefined {
  if (part.mimeType === mime && part.body?.data) return part;
  for (const p of part.parts ?? []) {
    const f = findPart(p, mime);
    if (f) return f;
  }
  return undefined;
}

function b64url(data: string): string {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Retire l'historique cité (« Le … a écrit : », « On … wrote: ») pour ne garder que le nouveau contenu. */
export function stripQuoted(body: string): string {
  const markers = [/^Le .{5,120} a écrit\s*:/m, /^On .{5,120} wrote:/m, /^-{2,}\s*Original Message/m, /^De\s*:.*\nEnvoyé\s*:/m];
  let cut = body.length;
  for (const re of markers) {
    const m = re.exec(body);
    if (m && m.index < cut) cut = m.index;
  }
  return body
    .slice(0, cut)
    .split("\n")
    .filter((l) => !l.startsWith(">"))
    .join("\n")
    .trim();
}
