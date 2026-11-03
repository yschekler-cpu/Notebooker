import { describe, expect, it } from "vitest";
import { folderToFileUrl, parseManifest, resolveInboxFile, topicKey } from "../src/background/localInbox";
import { diffTopics, fingerprint, followUpToMarkdown, hasNews, newsToMarkdown } from "../src/background/topicDiff";
import type { BriefMemory } from "../src/shared/types";

const empty: BriefMemory = { lastBriefDate: null, previousBriefDate: null, topics: {} };
const T = (key: string, summary: string, status: "new" | "updated" | "ongoing" | "resolved" = "updated") => ({ key, title: key.toUpperCase(), status, summary, refs: [] });

describe("dossier local : chemins", () => {
  it("macOS / Linux / Windows → file:// encodé", () => {
    expect(folderToFileUrl("/Users/yann/Mon Drive/Notebooker/")).toBe("file:///Users/yann/Mon%20Drive/Notebooker/");
    expect(folderToFileUrl("C:\\Users\\yann\\Notebooker")).toBe("file:///C:/Users/yann/Notebooker/");
    expect(() => folderToFileUrl("~/Notebooker")).toThrow(/chemin complet/);
    expect(() => folderToFileUrl("Notebooker")).toThrow(/absolu/);
  });
  it("fichiers du manifest : relatifs uniquement, .md/.txt, pas de sortie du dossier", () => {
    const base = "file:///Users/yann/Notebooker/";
    expect(resolveInboxFile(base, "2026-11-03/agenda du jour.md")).toBe("file:///Users/yann/Notebooker/2026-11-03/agenda%20du%20jour.md");
    for (const bad of ["../secret.md", "/etc/passwd.md", "file:///x.md", "a/../../b.md", "script.js"]) expect(() => resolveInboxFile(base, bad)).toThrow();
  });
});

describe("dossier local : manifest", () => {
  const ok = { format: "notebooker-brief", version: 1, id: "2026-11-03-daily", generatedAt: "2026-11-03T06:55:00+01:00" };
  it("valide, normalise les clés, écarte doublons et entrées invalides", () => {
    const m = parseManifest(JSON.stringify({
      ...ok,
      topics: [{ key: "KYC Italie", title: "KYC Italie", status: "weird", summary: "x" }, { key: "kyc-italie", title: "doublon" }, { title: "" }],
      sources: [{ title: "Agenda", file: "2026-11-03/agenda.md" }, { title: "vide" }],
      audio: { format: "brief", language: "it", length: "xxl" },
      actions: [{ title: "Valider la spec", requester: "", due: "2026-11-05", priority: "haute", source: "[Mail: x]", context: "" }],
    }));
    expect(m.topics.map((t) => [t.key, t.status])).toEqual([["kyc-italie", "updated"]]);
    expect(m.sources).toEqual([{ title: "Agenda", file: "2026-11-03/agenda.md" }]);
    expect(m.audio).toEqual({ format: "brief", language: "it" });
    expect(m.actions).toHaveLength(1);
  });
  it("rejette format inconnu, id ou date manquants, manifest vide", () => {
    expect(() => parseManifest("{")).toThrow(/JSON/);
    expect(() => parseManifest(JSON.stringify({ ...ok, format: "x" }))).toThrow(/non reconnu/);
    expect(() => parseManifest(JSON.stringify({ ...ok, id: "" , topics: [T("a", "b")] }))).toThrow(/id/);
    expect(() => parseManifest(JSON.stringify({ ...ok, generatedAt: "hier", topics: [T("a", "b")] }))).toThrow(/ISO/);
    expect(() => parseManifest(JSON.stringify(ok))).toThrow(/vide/);
    expect(topicKey("", "Appel de fonds — Q4")).toBe("appel-de-fonds-q4");
  });
});

describe("diff quotidien des sujets", () => {
  it("J1 nouveau ; J2 identique → « sans nouveauté » (pas de redite) ; J3 modifié → « a changé »", () => {
    const d1 = diffTopics(empty, [T("kyc", "Codice fiscale à valider"), T("eltif", "Note AMF reçue")], "2026-11-02");
    expect(d1.diff.fresh.map((x) => x.topic.key)).toEqual(["kyc", "eltif"]);
    // Cowork répète le même texte (casse / ponctuation différentes) : détecté comme inchangé
    const d2 = diffTopics(d1.memory, [T("kyc", "codice fiscale à valider !"), T("eltif", "Note AMF reçue")], "2026-11-03");
    expect(d2.diff.unchanged.map((x) => x.topic.key)).toEqual(["kyc", "eltif"]);
    expect(hasNews(d2.diff)).toBe(false);
    const d3 = diffTopics(d2.memory, [T("kyc", "Codice fiscale validé par Marco, reste la signature"), T("eltif", "Note AMF reçue")], "2026-11-04");
    expect(d3.diff.changed.map((x) => [x.topic.key, x.memory.activeDays])).toEqual([["kyc", 3]]);
    expect(d3.diff.unchanged.map((x) => x.topic.key)).toEqual(["eltif"]);
    const news = newsToMarkdown(d3.diff);
    expect(news).toContain("## 🔄 Ce qui a changé");
    expect(news).toContain("KYC — suivi depuis le 2 novembre (3 jours)");
    expect(news).not.toContain("Note AMF");
    expect(followUpToMarkdown(d3.diff)).toContain("ELTIF — ouvert depuis le 2 novembre, dernier changement le 2 novembre");
  });

  it("résolu annoncé une seule fois ; sujet disparu signalé ; re-run le même jour stable", () => {
    const d1 = diffTopics(empty, [T("a", "x"), T("b", "y")], "2026-11-02");
    const d2 = diffTopics(d1.memory, [T("a", "Signé", "resolved")], "2026-11-03");
    expect(d2.diff.resolved.map((x) => x.topic.key)).toEqual(["a"]);
    expect(d2.diff.dropped.map((t) => t.key)).toEqual(["topic:b"]);
    const d2bis = diffTopics(d2.memory, [T("a", "Signé", "resolved")], "2026-11-03");
    expect(d2bis.diff.resolved).toHaveLength(0);
    expect(d2bis.memory.topics["topic:a"]!.activeDays).toBe(2);
    const d3 = diffTopics(d2.memory, [T("a", "Signé", "resolved")], "2026-11-04");
    expect(d3.diff.resolved).toHaveLength(0);
    expect(hasNews(d3.diff)).toBe(false);
  });

  it("empreinte insensible à la mise en forme, sensible au fond", () => {
    expect(fingerprint("Valider le  KYC, demain.")).toBe(fingerprint("valider le kyc demain"));
    expect(fingerprint("Valider le KYC demain")).not.toBe(fingerprint("KYC validé"));
  });
});
