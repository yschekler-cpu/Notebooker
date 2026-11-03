import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chrome-mock";
import { actionKey, buildProperties, detectMapping, enqueueActions, pushActions } from "../src/background/actions";
import { DEFAULT_SETTINGS, getActions, saveSettings } from "../src/shared/storage";

const A = { title: "Valider la spec KYC Italie", requester: "Marco", due: "2026-11-05", priority: "haute" as const, source: "[Mail: Spec KYC]", context: "Bloquant." };

const SCHEMA = {
  title: "Backlog produit",
  properties: {
    Nom: { type: "title", options: [] },
    Échéance: { type: "date", options: [] },
    Priorité: { type: "select", options: ["P1 - Haute", "P2 - Moyenne", "P3 - Basse"] },
    Statut: { type: "status", options: ["À trier", "En cours", "Fait"] },
    Source: { type: "rich_text", options: [] },
    Sprint: { type: "select", options: ["S12"] },
  },
};

beforeEach(() => void installChromeMock());

describe("actions → backlog Notion", () => {
  it("dédoublonnage sur titre normalisé (casse, accents, masques)", async () => {
    expect(actionKey("Valider la SPÉC [EMAIL] KYC — Italie !")).toBe(actionKey("valider la spec kyc italie"));
    const first = await enqueueActions([A, { ...A, title: "valider la spec KYC italie" }], "daily", "r1");
    expect(first).toHaveLength(1);
    const again = await enqueueActions([A], "daily", "r2");
    expect(again).toHaveLength(0);
    expect((await getActions())[0]!.status).toBe("pending");
  });

  it("mapping auto des propriétés + options existantes uniquement", () => {
    const m = detectMapping(SCHEMA);
    expect(m).toMatchObject({ title: "Nom", due: "Échéance", source: "Source" });
    expect(m.priority?.name).toBe("Priorité");
    expect(m.status?.name).toBe("Statut");
    const props = buildProperties(m, A, "à trier");
    expect(props).toEqual({
      Nom: { title: [{ text: { content: A.title } }] },
      Échéance: { date: { start: "2026-11-05" } },
      Priorité: { select: { name: "P1 - Haute" } },
      Statut: { status: { name: "À trier" } },
      Source: { rich_text: [{ text: { content: "[Mail: Spec KYC]" } }] },
    });
    // Statut inexistant → propriété omise (jamais d'option inventée)
    expect(buildProperties(m, A, "Backlog")).not.toHaveProperty("Statut");
    expect(() => detectMapping({ title: "x", properties: { A: { type: "rich_text", options: [] } } })).toThrow(/titre/);
  });

  it("push : corrections appliquées, statut « sent », erreurs isolées par action", async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.notion.company.token = "secret";
    s.backlog = { workspace: "company", databaseId: "0123456789abcdef0123456789abcdef", defaultStatus: "À trier" };
    await saveSettings(s);
    const [ok] = await enqueueActions([A], "daily", "r1");
    const [ko] = await enqueueActions([{ ...A, title: "Action qui échoue" }], "daily", "r1");
    const created: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== "POST") {
        return Response.json({ title: [{ plain_text: SCHEMA.title }], properties: {
          Nom: { type: "title" }, Échéance: { type: "date" },
          Priorité: { type: "select", select: { options: SCHEMA.properties.Priorité.options.map((name) => ({ name })) } },
          Statut: { type: "status", status: { options: SCHEMA.properties.Statut.options.map((name) => ({ name })) } },
          Source: { type: "rich_text" },
        } });
      }
      const body = JSON.parse(String(init.body));
      if (JSON.stringify(body).includes("Action qui échoue")) return Response.json({ message: "validation_error" }, { status: 400 });
      created.push(body);
      return Response.json({ id: "page-1", url: "https://notion.so/page-1" });
    }));
    const r = await pushActions([ok!.id, ko!.id], { [ok!.id]: { title: "Valider la spec KYC IT (v2)", due: "2026-11-06", priority: "moyenne" } });
    expect(r.sent).toBe(1);
    expect(r.errors[0]).toMatch(/Action qui échoue/);
    const props = (created[0] as { properties: Record<string, { title?: { text: { content: string } }[]; date?: { start: string }; select?: { name: string } }> }).properties;
    expect(props.Nom!.title![0]!.text.content).toBe("Valider la spec KYC IT (v2)");
    expect(props.Échéance!.date!.start).toBe("2026-11-06");
    expect(props.Priorité!.select!.name).toBe("P2 - Moyenne");
    const items = await getActions();
    expect(items.find((i) => i.id === ok!.id)).toMatchObject({ status: "sent", notionPageId: "page-1" });
    expect(items.find((i) => i.id === ko!.id)?.status).toBe("error");
  });

  it("aucune base configurée : refus explicite, rien n'est envoyé", async () => {
    await saveSettings(structuredClone(DEFAULT_SETTINGS));
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(pushActions(["x"])).rejects.toThrow(/Aucune base backlog/);
    expect(f).not.toHaveBeenCalled();
  });
});
