import { describe, expect, it } from "vitest";
import { PROFILE_TEMPLATES, migrateRawSettings, normalizeProfile } from "../src/shared/profiles";
import { resolveSettings } from "../src/shared/storage";

describe("profils de brief", () => {
  it("migration v0.1 → v0.2 : briefing → profil « daily », exclusions → conformité globale", () => {
    const legacy = {
      briefing: { enabled: true, time: "08:15", weekdaysOnly: false, lookbackHours: 48, gmailExclusions: ["label:kyc"], audioInstructions: "Focus deals", retentionDays: 3, notebookTitleTemplate: "Brief {date}" },
      claude: { enabled: true },
    };
    const s = resolveSettings(legacy);
    expect(s.profiles).toHaveLength(1);
    const p = s.profiles[0]!;
    expect(p).toMatchObject({ id: "daily", enabled: true, lookbackHours: 48, retentionDays: 3, notebookTitleTemplate: "Brief {date}" });
    expect(p.schedule).toEqual({ time: "08:15", days: [0, 1, 2, 3, 4, 5, 6] });
    expect(p.audio.instructions).toBe("Focus deals");
    expect(s.compliance.gmailExclusions).toEqual(["label:kyc"]);
    expect(s.claude.enabled).toBe(true);
    expect((s as unknown as Record<string, unknown>).briefing).toBeUndefined();
  });

  it("migration idempotente et réglages vierges valides", () => {
    const once = migrateRawSettings({ briefing: { time: "07:00" } });
    expect(migrateRawSettings(once)).toBe(once);
    const fresh = resolveSettings(undefined);
    expect(fresh.profiles[0]!.schedule.days).toEqual([1, 2, 3, 4, 5]);
    expect(fresh.calendar.hidePrivateEvents).toBe(true);
  });

  it("normalisation : valeurs invalides ramenées aux défauts, IDs en double écartés", () => {
    const p = normalizeProfile({ id: "x", schedule: { time: "nope", days: [9, 1, 1, -2] }, audio: { format: "podcast" as never, length: "xl" as never, language: "it", instructions: "" } });
    expect(p.schedule).toEqual({ time: "07:30", days: [1] });
    expect(p.audio).toMatchObject({ format: "deep_dive", length: "default", language: "it" });
    const s = resolveSettings({ profiles: [{ id: "a", name: "A" }, { id: "a", name: "doublon" }, { id: "b" }] });
    expect(s.profiles.map((x) => x.name)).toEqual(["A", "Brief"]);
  });

  it("modèles : conformité le vendredi, Comex sans Gmail ni donnée nominative", () => {
    const c = PROFILE_TEMPLATES.weeklyCompliance!();
    expect(c.schedule.days).toEqual([5]);
    expect(c.lookbackHours).toBe(168);
    const x = PROFILE_TEMPLATES.comex!();
    expect(x.sources.gmail).toBe(false);
    expect(x.synthesisFocus).toMatch(/donnée nominative/);
  });
});
