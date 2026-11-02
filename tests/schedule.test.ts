import { describe, expect, it } from "vitest";
import { isDue, nextDailyRun, shouldCatchUp } from "../src/shared/schedule";

describe("nextDailyRun", () => {
  it("planifie aujourd'hui si l'heure n'est pas passée", () => {
    const from = new Date(2026, 10, 2, 6, 0); // lundi 2 nov 2026 06:00
    const r = nextDailyRun("07:30", true, from);
    expect([r.getDate(), r.getHours(), r.getMinutes()]).toEqual([2, 7, 30]);
  });
  it("saute le week-end en mode jours ouvrés", () => {
    const friday = new Date(2026, 10, 6, 9, 0);
    expect(nextDailyRun("07:30", true, friday).getDay()).toBe(1);
    expect(nextDailyRun("07:30", false, friday).getDay()).toBe(6);
  });
  it("rejette une heure invalide", () => {
    expect(() => nextDailyRun("25:00", false)).toThrow();
  });
});

describe("shouldCatchUp", () => {
  const now = new Date(2026, 10, 2, 9, 15);
  it("rattrape si aucun run depuis le créneau du jour", () => {
    expect(shouldCatchUp("07:30", true, new Date(2026, 10, 1, 7, 30), now)).toBe(true);
  });
  it("ne rattrape pas si déjà fait", () => {
    expect(shouldCatchUp("07:30", true, new Date(2026, 10, 2, 7, 31), now)).toBe(false);
  });
  it("ne rattrape pas après midi", () => {
    expect(shouldCatchUp("07:30", true, null, new Date(2026, 10, 2, 13, 0))).toBe(false);
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
