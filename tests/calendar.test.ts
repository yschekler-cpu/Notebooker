import { describe, expect, it } from "vitest";
import { agendaToMarkdown, calendarWindow, keywords, normalizeEvent, relatedItems, type CalendarEvent } from "../src/background/calendar";

const cfg = { calendarIds: ["primary"], hidePrivateEvents: true, skipDeclined: true };

describe("agenda", () => {
  it("normalise, retire les liens de visio, ignore annulés / refusés", () => {
    const ev = normalizeEvent(
      {
        id: "1",
        summary: "Comité d'investissement Fonds Alpha",
        description: "<p>Ordre du jour : TRI</p>Rejoindre : https://meet.google.com/abc-defg-hij",
        start: { dateTime: "2026-11-03T09:00:00+01:00" },
        end: { dateTime: "2026-11-03T10:00:00+01:00" },
        attendees: [{ email: "Moi@opale.fr", self: true, responseStatus: "accepted" }, { email: "gp@alpha.com", displayName: "GP Alpha" }, { email: "salle@resource.calendar.google.com", resource: true }],
      },
      "primary",
      cfg,
    )!;
    expect(ev.description).toContain("Ordre du jour : TRI");
    expect(ev.description).not.toContain("meet.google.com");
    expect(ev.attendees.map((a) => a.name)).toEqual(["Moi", "GP Alpha"]);
    expect(normalizeEvent({ id: "2", status: "cancelled" }, "primary", cfg)).toBeNull();
    expect(normalizeEvent({ id: "3", attendees: [{ email: "a@b.c", self: true, responseStatus: "declined" }] }, "primary", cfg)).toBeNull();
  });

  it("événement privé : ni titre, ni description, ni participants", () => {
    const ev = normalizeEvent({ id: "p", summary: "RDV médical", description: "x", visibility: "private", start: { date: "2026-11-03" }, attendees: [{ email: "dr@x.fr" }] }, "primary", cfg)!;
    expect(ev).toMatchObject({ title: "Événement privé", description: "", attendees: [], allDay: true });
    const shown = normalizeEvent({ id: "p", summary: "RDV médical", visibility: "private", start: { date: "2026-11-03" } }, "primary", { ...cfg, hidePrivateEvents: false })!;
    expect(shown.title).toBe("RDV médical");
  });

  it("fenêtre : jusqu'à la fin de journée ; brief du soir → lendemain", () => {
    const morning = calendarWindow(new Date(2026, 10, 3, 7, 30));
    expect(morning.to.getDate()).toBe(3);
    const evening = calendarWindow(new Date(2026, 10, 3, 18, 0));
    expect([evening.from.getDate(), evening.from.getHours(), evening.to.getDate()]).toEqual([4, 0, 4]);
  });

  it("préparation : mails des participants et mots-clés distinctifs, sans bruit des mots génériques", () => {
    const ev: CalendarEvent = { id: "e", calendarId: "primary", title: "Point hebdo KYC Italie", start: "2026-11-03T14:00:00", end: "2026-11-03T15:00:00", allDay: false, attendees: [{ name: "Marco", email: "marco@opale.it", self: false }], description: "", isPrivate: false };
    expect([...keywords(ev.title)]).toEqual(["italie"]);
    const mails = [
      { subject: "Codice fiscale à valider", from: "Marco <marco@opale.it>" },
      { subject: "Ouverture Italie : checklist", from: "ops@opale.fr" },
      { subject: "Point hebdo marketing", from: "mkt@opale.fr" },
    ];
    const items = relatedItems(ev, mails, [{ title: "Spec KYC Italie" }, { title: "Roadmap Belgique" }]);
    expect(items.map((i) => i.title)).toEqual(["Codice fiscale à valider", "Spec KYC Italie"]);
    const md = agendaToMarkdown([ev], mails, [{ title: "Spec KYC Italie" }]);
    expect(md).toContain("### 14:00–15:00 · Point hebdo KYC Italie");
    expect(md).toContain("Participants : Marco");
    expect(md).toContain("- [Notion] Spec KYC Italie");
  });
});
