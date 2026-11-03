import { CALENDAR_API } from "../shared/endpoints";
import type { Settings } from "../shared/types";
import type { MailDigestItem } from "./gmail";
import { getGoogleToken, googleGet } from "./google";
import { clamp, htmlToText } from "./text";

/**
 * Google Agenda (scope calendar.readonly) : réunions de la journée + fiche de préparation
 * par réunion (emails et pages Notion liés). Aucun accès en écriture.
 */

export interface CalendarAttendee {
  name: string;
  email: string;
  self: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  attendees: CalendarAttendee[];
  description: string;
  isPrivate: boolean;
}

interface RawEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  visibility?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; responseStatus?: string; resource?: boolean }[];
}

/** Fenêtre lue : de maintenant à la fin de journée ; un brief du soir (≥ 17 h) couvre le lendemain. */
export function calendarWindow(now: Date = new Date()): { from: Date; to: Date } {
  if (now.getHours() >= 17) {
    const from = new Date(now);
    from.setDate(from.getDate() + 1);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setHours(23, 59, 59, 999);
    return { from, to };
  }
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);
  return { from: now, to };
}

const MEETING_LINK = /https?:\/\/\S*(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com)\S*/gi;

/** Normalise un événement brut ; null si à ignorer (annulé, refusé). */
export function normalizeEvent(raw: RawEvent, calendarId: string, cfg: Settings["calendar"]): CalendarEvent | null {
  if (raw.status === "cancelled") return null;
  const me = raw.attendees?.find((a) => a.self);
  if (cfg.skipDeclined && me?.responseStatus === "declined") return null;
  const allDay = !raw.start?.dateTime;
  const start = raw.start?.dateTime ?? (raw.start?.date ? `${raw.start.date}T00:00:00` : "");
  const end = raw.end?.dateTime ?? (raw.end?.date ? `${raw.end.date}T00:00:00` : start);
  const isPrivate = raw.visibility === "private" || raw.visibility === "confidential";
  if (isPrivate && cfg.hidePrivateEvents) {
    return { id: raw.id, calendarId, title: "Événement privé", start, end, allDay, attendees: [], description: "", isPrivate };
  }
  return {
    id: raw.id,
    calendarId,
    title: (raw.summary ?? "(sans titre)").trim(),
    start,
    end,
    allDay,
    attendees: (raw.attendees ?? [])
      .filter((a) => !a.resource && a.email)
      .map((a) => ({ name: a.displayName?.trim() || a.email!.split("@")[0]!, email: a.email!.toLowerCase(), self: !!a.self })),
    // Liens de visio retirés : ce sont des accès, pas du contenu utile au brief.
    description: clamp(htmlToText(raw.description ?? "").replace(MEETING_LINK, "[lien visio]"), 600),
    isPrivate,
  };
}

export async function fetchEvents(cfg: Settings["calendar"], window: { from: Date; to: Date }, interactive: boolean): Promise<CalendarEvent[]> {
  const token = await getGoogleToken(interactive);
  const out: CalendarEvent[] = [];
  for (const calendarId of cfg.calendarIds.length ? cfg.calendarIds : ["primary"]) {
    const qs = new URLSearchParams({
      timeMin: window.from.toISOString(),
      timeMax: window.to.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
    });
    const r = await googleGet<{ items?: RawEvent[] }>(token, `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${qs}`, "Agenda");
    for (const raw of r.items ?? []) {
      const ev = normalizeEvent(raw, calendarId, cfg);
      if (ev) out.push(ev);
    }
  }
  // Dédoublonnage (même réunion visible dans plusieurs agendas) + tri chronologique
  const seen = new Set<string>();
  return out
    .filter((e) => {
      const k = `${e.title}|${e.start}`;
      return !seen.has(k) && seen.add(k);
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

// ─── Préparation des réunions ─────────────────────────────────────────────────

const STOPWORDS = new Set(
  "reunion point meeting call weekly daily sync hebdo mensuel mensuelle revue suivi avec pour dans entre equipe team update stand standup comite comité kick kickoff atelier workshop sujet sujets ordre jour projet project".split(" "),
);

export function keywords(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

function senderEmail(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
}

export interface PrepItem {
  kind: "mail" | "notion";
  title: string;
  detail: string;
}

/**
 * Éléments à relire avant une réunion. Score : participant expéditeur du mail (+2),
 * mot-clé distinctif commun au titre (+1 chacun). Seuil 2 → évite le bruit des mots courants.
 */
export function relatedItems(
  ev: CalendarEvent,
  mails: Pick<MailDigestItem, "subject" | "from">[],
  pages: { title: string }[],
): PrepItem[] {
  if (ev.isPrivate && ev.attendees.length === 0 && ev.title === "Événement privé") return [];
  const kw = keywords(ev.title);
  const attendees = new Set(ev.attendees.filter((a) => !a.self).map((a) => a.email));
  const mailHits = mails
    .map((m) => ({ m, score: (attendees.has(senderEmail(m.from)) ? 2 : 0) + overlap(kw, keywords(m.subject)) }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ m }): PrepItem => ({ kind: "mail", title: m.subject, detail: m.from }));
  const pageHits = pages
    .map((p) => ({ p, score: overlap(kw, keywords(p.title)) * 2 }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ p }): PrepItem => ({ kind: "notion", title: p.title, detail: "" }));
  return [...mailHits, ...pageHits];
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Source « Agenda » en Markdown (le masquage PII est appliqué ensuite, comme pour les autres sources). */
export function agendaToMarkdown(events: CalendarEvent[], mails: Pick<MailDigestItem, "subject" | "from">[], pages: { title: string }[]): string {
  if (events.length === 0) return "";
  return events
    .map((ev) => {
      const when = ev.allDay ? "Toute la journée" : `${hhmm(ev.start)}–${hhmm(ev.end)}`;
      const others = ev.attendees.filter((a) => !a.self);
      const people = others.length ? `Participants : ${others.slice(0, 8).map((a) => a.name).join(", ")}${others.length > 8 ? ` (+${others.length - 8})` : ""}` : "";
      const prep = relatedItems(ev, mails, pages);
      const prepMd = prep.length
        ? `À relire avant :\n${prep.map((p) => `- [${p.kind === "mail" ? "Mail" : "Notion"}] ${p.title}${p.detail ? ` — ${p.detail}` : ""}`).join("\n")}`
        : "";
      return [`### ${when} · ${ev.title}`, people, ev.description ? `Ordre du jour : ${ev.description}` : "", prepMd].filter(Boolean).join("\n");
    })
    .join("\n\n");
}
