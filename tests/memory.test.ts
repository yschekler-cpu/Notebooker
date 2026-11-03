import { describe, expect, it } from "vitest";
import { MEMORY_RETENTION_DAYS, memoryToMarkdown, topicTitle, updateMemory, type Observation } from "../src/background/memory";
import type { BriefMemory } from "../src/shared/types";

const empty: BriefMemory = { lastBriefDate: null, previousBriefDate: null, topics: {} };
const mail = (key: string, title = key): Observation => ({ key, title, kind: "mail" });

describe("mémoire du brief", () => {
  it("J1 tout est nouveau ; J2 : actif / nouveau / calmé", () => {
    const d1 = updateMemory(empty, [mail("a"), mail("b")], "2026-11-02");
    expect(d1.diff.fresh.map((t) => t.key)).toEqual(["a", "b"]);
    const d2 = updateMemory(d1.memory, [mail("a"), mail("c")], "2026-11-03");
    expect(d2.diff.fresh.map((t) => t.key)).toEqual(["c"]);
    expect(d2.diff.ongoing.map((t) => [t.key, t.activeDays])).toEqual([["a", 2]]);
    expect(d2.diff.calmed.map((t) => t.key)).toEqual(["b"]);
  });

  it("re-run le même jour : pas de double comptage, « calmé » reste calculé vs la veille", () => {
    const d1 = updateMemory(empty, [mail("a"), mail("b")], "2026-11-02");
    const d2 = updateMemory(d1.memory, [mail("a")], "2026-11-03");
    const d2bis = updateMemory(d2.memory, [mail("a")], "2026-11-03");
    expect(d2bis.memory.topics.a!.activeDays).toBe(2);
    expect(d2bis.diff.ongoing.map((t) => t.key)).toEqual(["a"]);
    expect(d2bis.diff.calmed.map((t) => t.key)).toEqual(["b"]);
  });

  it("week-end sauté : la référence est le dernier brief, pas « hier »", () => {
    const fri = updateMemory(empty, [mail("x")], "2026-11-06");
    const mon = updateMemory(fri.memory, [], "2026-11-09");
    expect(mon.diff.calmed.map((t) => t.key)).toEqual(["x"]);
  });

  it(`purge au-delà de ${MEMORY_RETENTION_DAYS} jours`, () => {
    const d1 = updateMemory(empty, [mail("old")], "2026-10-01");
    const d2 = updateMemory(d1.memory, [mail("new")], "2026-11-03");
    expect(Object.keys(d2.memory.topics)).toEqual(["new"]);
  });

  it("titres de fil normalisés et rendu Markdown", () => {
    expect(topicTitle("RE: TR: Fwd: Appel de fonds Q4")).toBe("Appel de fonds Q4");
    const d1 = updateMemory(empty, [mail("a", "Spec KYC")], "2026-11-02");
    const d2 = updateMemory(d1.memory, [mail("a", "Spec KYC"), mail("n", "Nouveau")], "2026-11-03");
    const md = memoryToMarkdown(d2.diff);
    expect(md).toContain("🆕 Nouveaux sujets (1)");
    expect(md).toContain("[Mail] Spec KYC — actif 2 jours");
  });
});
