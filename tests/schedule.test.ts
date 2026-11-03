import { describe, expect, it } from "vitest";
import { isDue, localDay, nextRun, shouldCatchUp } from "../src/shared/schedule";

const WEEK = [1, 2, 3, 4, 5];
const ALL = [0, 1, 2, 3, 4, 5, 6];

describe("nextRun", () => {
  it("planifie aujourd'hui si l'heure n'est pas passée", () => {
    const from = new Date(2026, 10, 2, 6, 0); // lundi 2 nov 2026 06:00
    const r = nextRun("07:30", WEEK, from)!;
    expect([r.getDate(), r.getHours(), r.getMinutes()]).toEqual([2, 7, 30]);
  });
  it("saute le week-end en mode jours ouvrés", () => {
    const friday = new Date(2026, 10, 6, 9, 0);
    expect(nextRun("07:30", WEEK, friday)!.getDay()).toBe(1);
    expect(nextRun("07:30", ALL, friday)!.getDay()).toBe(6);
  });
  it("profil hebdomadaire (vendredi 16:30) et aucun jour", () => {
    const monday = new Date(2026, 10, 2, 9, 0);
    const r = nextRun("16:30", [5], monday)!;
    expect([r.getDay(), r.getDate(), r.getHours(), r.getMinutes()]).toEqual([5, 6, 16, 30]);
    const fridayEvening = new Date(2026, 10, 6, 17, 0);
    expect(nextRun("16:30", [5], fridayEvening)!.getDate()).toBe(13);
    expect(nextRun("07:30", [], monday)).toBeNull();
  });
  it("rejette une heure invalide", () => {
    expect(() => nextRun("25:00", ALL)).toThrow();
  });
});

describe("shouldCatchUp", () => {
  const now = new Date(2026, 10, 2, 9, 15);
  it("rattrape si aucun run depuis le créneau du jour", () => {
    expect(shouldCatchUp("07:30", WEEK, new Date(2026, 10, 1, 7, 30), now)).toBe(true);
  });
  it("ne rattrape pas si déjà fait", () => {
    expect(shouldCatchUp("07:30", WEEK, new Date(2026, 10, 2, 7, 31), now)).toBe(false);
  });
  it("créneau d'après-midi : fenêtre de 4 h", () => {
    expect(shouldCatchUp("16:30", [5], null, new Date(2026, 10, 6, 18, 0))).toBe(true);
    expect(shouldCatchUp("16:30", [5], null, new Date(2026, 10, 6, 21, 0))).toBe(false);
    expect(shouldCatchUp("16:30", [5], null, new Date(2026, 10, 5, 18, 0))).toBe(false);
  });
  it("localDay", () => expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05"));
  it("ne rattrape pas après midi", () => {
    expect(shouldCatchUp("07:30", WEEK, null, new Date(2026, 10, 2, 13, 0))).toBe(false);
  });
});

describe("isDue", () => {
  const now = new Date("2026-11-02T10:00:00Z");
  it("gère jamais vérifié / unique / périodique", () => {
    expect(isDue(null, 0, now)).toBe(true);
    expect(isDue("2026-11-01T10:00:00Z", 0, now)).toBe(false);
    expect(isDue("2026-11-02T09:00:00Z", 60, now)).toBe(true);
    expect(isDue("2026-11-02T09:30:00Z", 60, now)).toBe(false);
  });
});
