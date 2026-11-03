import { describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chrome-mock";
import { ACTIONS_SCHEMA, analyzeCorpus, parseActions, testClaude } from "../src/background/claude";
import { buildSources, type BriefData, type NotionDigestItem } from "../src/background/briefing";
import { defaultProfile } from "../src/shared/profiles";
import { DEFAULT_SETTINGS } from "../src/shared/storage";
import type { Settings } from "../src/shared/types";

installChromeMock();

const cfg = (p: Partial<Settings["claude"]> = {}): Settings["claude"] => ({ ...DEFAULT_SETTINGS.claude, enabled: true, apiKey: "sk-test", ...p });

function messageJson(text: string, stop = "end_turn") {
  return { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
}

function sse(text: string, stop = "end_turn"): string {
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  return (
    ev("message_start", { message: { ...messageJson(""), content: [], stop_reason: null } }) +
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
    ev("content_block_stop", { index: 0 }) +
    ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } }) +
    ev("message_stop", {})
  );
}

type Captured = { headers: Headers; body: Record<string, unknown> };
function fakeFetch(responses: Array<(c: Captured) => Response>) {
  const calls: Captured[] = [];
  const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const c = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    calls.push(c);
    return responses[Math.min(calls.length - 1, responses.length - 1)]!(c);
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe("client Claude", () => {
  it("clé API : Authorization Bearer (SDK 1.x), modèle, fallbacks, thinking adaptatif, streaming", async () => {
    const { f, calls } = fakeFetch([() => new Response(sse("## Brief"), { headers: { "content-type": "text/event-stream" } })]);
    expect((await analyzeCorpus(cfg(), { corpus: "corpus", today: "2026-11-03", synthesis: { focus: "", memoryContext: "" } }, f)).brief).toBe("## Brief");
    const c = calls[0]!;
    expect(c.headers.get("authorization")).toBe("Bearer sk-test");
    expect(c.headers.get("anthropic-beta")).not.toContain("oauth");
    expect(c.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(c.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", stream: true, thinking: { type: "adaptive" } });
  });

  it("jeton OAuth : Bearer + beta oauth, pas de x-api-key", async () => {
    const { f, calls } = fakeFetch([() => Response.json(messageJson("OK"))]);
    expect(await testClaude(cfg({ authMode: "oauth_token", oauthToken: "oat" }), f)).toMatch(/^OK/);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer oat");
    expect(calls[0]!.headers.get("x-api-key")).toBeNull();
    expect(calls[0]!.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
  });

  it("400 sur fallbacks → retry sans fallbacks ni beta associée", async () => {
    const { f, calls } = fakeFetch([
      () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "fallbacks: not supported" } }, { status: 400 }),
      () => Response.json(messageJson("OK")),
    ]);
    await testClaude(cfg(), f);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.fallbacks).toBeUndefined();
    expect(calls[1]!.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
  });

  it("refus → erreur explicite (le brief continue sans synthèse)", async () => {
    const { f } = fakeFetch([() => new Response(sse("", "refusal"), { headers: { "content-type": "text/event-stream" } })]);
    const r = await analyzeCorpus(cfg(), { corpus: "x", today: "2026-11-03", synthesis: { focus: "", memoryContext: "" } }, f);
    expect(r.brief).toBeUndefined();
    expect(r.errors[0]).toMatch(/refusal/);
  });

  it("identifiants manquants → erreur avant tout appel réseau", async () => {
    await expect(testClaude(cfg({ apiKey: "" }))).rejects.toThrow(/Clé API Claude manquante/);
    await expect(testClaude(cfg({ authMode: "oauth_token", oauthToken: "" }))).rejects.toThrow(/Jeton OAuth/);
  });
});

const SSE = { headers: { "content-type": "text/event-stream" } };

describe("analyse du corpus : synthèse + actions avec cache", () => {
  const actionsJson = JSON.stringify({
    actions: [
      { title: "Valider la spec KYC Italie", requester: "Marco", due: "2026-11-05", priority: "haute", source: "[Mail: Spec KYC]", context: "Bloquant pour le sprint." },
      { title: "x", requester: "", due: "", priority: "basse", source: "", context: "" },
      { title: "Relire le DDQ", requester: "", due: "demain", priority: "urgentissime", source: "[Notion: DDQ]", context: "" },
    ],
  });

  it("corpus en premier bloc avec cache_control, puis tâche ; extraction en json_schema", async () => {
    const { f, calls } = fakeFetch([() => new Response(sse("## Brief"), SSE), () => new Response(sse(actionsJson), SSE)]);
    const r = await analyzeCorpus(cfg(), { corpus: "CORPUS", today: "2026-11-03", synthesis: { focus: "Angle Comex", memoryContext: "- [Mail] X" }, actions: true }, f);
    expect(r.errors).toEqual([]);
    expect(r.brief).toBe("## Brief");
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const content = (c.body.messages as { content: { text: string; cache_control?: unknown }[] }[])[0]!.content;
      expect(content[0]).toMatchObject({ text: "CORPUS", cache_control: { type: "ephemeral" } });
      expect(c.body.system).toBe(calls[0]!.body.system); // préfixe identique → cache réutilisé
    }
    const synthTask = (calls[0]!.body.messages as { content: { text: string }[] }[])[0]!.content[1]!.text;
    expect(synthTask).toContain("ANGLE DEMANDÉ : Angle Comex");
    expect(synthTask).toContain("- [Mail] X");
    expect(calls[1]!.body.output_config).toEqual({ effort: "medium", format: { type: "json_schema", schema: ACTIONS_SCHEMA } });
    // Validation défensive : titre trop court écarté, échéance non ISO vidée, priorité hors enum ramenée à « moyenne »
    expect(r.actions).toEqual([
      { title: "Valider la spec KYC Italie", requester: "Marco", due: "2026-11-05", priority: "haute", source: "[Mail: Spec KYC]", context: "Bloquant pour le sprint." },
      { title: "Relire le DDQ", requester: "", due: "", priority: "moyenne", source: "[Notion: DDQ]", context: "" },
    ]);
  });

  it("échec de la synthèse n'empêche pas l'extraction", async () => {
    // Routage par type de requête (et non par ordre) : le SDK retente les 5xx.
    const f = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { output_config?: { format?: unknown } };
      return body.output_config?.format
        ? new Response(sse(actionsJson), SSE)
        : Response.json({ type: "error", error: { type: "invalid_request_error", message: "corpus refusé" } }, { status: 400 });
    }) as typeof fetch;
    const r = await analyzeCorpus(cfg(), { corpus: "C", today: "2026-11-03", synthesis: { focus: "", memoryContext: "" }, actions: true }, f);
    expect(r.brief).toBeUndefined();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^Synthèse/);
    expect(r.actions).toHaveLength(2);
  });

  it("parseActions rejette un JSON invalide", () => {
    expect(() => parseActions("{pas du json")).toThrow(/JSON invalide/);
    expect(() => parseActions("{}")).toThrow(/tableau/);
  });
});

describe("buildSources", () => {
  const mails = [{ id: "1", threadId: "t", from: "Paul <paul@opale.fr>", subject: "Appel de fonds", date: "2026-11-02T07:00:00Z", snippet: "", body: "IBAN FR76 3000 6000 0112 3456 7890 189 à vérifier", labels: [] }];
  const notion: NotionDigestItem[] = [{ id: "p", title: "Roadmap", url: "https://notion.so/p", lastEditedTime: "2026-11-02T06:00:00Z", workspace: "company", markdown: "- Sprint 12" }];
  const data = (p: Partial<BriefData> = {}): BriefData => ({ mails, events: [], notion, ...p });
  const profile = defaultProfile();

  it("sans Claude : sources brutes regroupées, PII masquée", async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    const { sources: out, actions } = await buildSources(s, profile, data(), null, () => undefined);
    expect(out.map((x) => x.title.split(" — ")[0])).toEqual(["Emails", "Notion entreprise"]);
    expect(out[0]!.text).toContain("[IBAN]");
    expect(out[0]!.text).toContain("[EMAIL]");
    expect(out[0]!.text).not.toContain("FR76");
    expect(actions).toEqual([]);
  });

  it("masquage désactivé : contenu intact", async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.claude.redactPII = false;
    const { sources: out } = await buildSources(s, profile, data({ notion: [] }), null, () => undefined);
    expect(out[0]!.text).toContain("FR76");
  });

  it("Claude mal configuré : warning loggué, sources brutes quand même produites", async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.claude.enabled = true; // pas de clé → échec immédiat, sans exception
    const log = vi.fn();
    const { sources: out } = await buildSources(s, profile, data(), null, log);
    expect(out).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Clé API Claude manquante/), "warn");
  });

  it("agenda + mémoire : sources dédiées, dans l'ordre Agenda → Suivi → Emails → Notion", async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    const events = [{ id: "e", calendarId: "primary", title: "Comité Appel de fonds", start: "2026-11-03T09:00:00", end: "2026-11-03T10:00:00", allDay: false, attendees: [{ name: "Paul", email: "paul@opale.fr", self: false }], description: "", isPrivate: false }];
    const diff = { fresh: [{ key: "mail:t", title: "Appel de fonds", kind: "mail" as const, firstSeen: "2026-11-03", lastSeen: "2026-11-03", activeDays: 1 }], ongoing: [], calmed: [] };
    const { sources: out } = await buildSources(s, profile, data({ events }), diff, () => undefined);
    expect(out.map((x) => x.title.split(" — ")[0])).toEqual(["Agenda du jour", "Suivi depuis le dernier brief", "Emails", "Notion entreprise"]);
    expect(out[0]!.text).toContain("09:00–10:00 · Comité Appel de fonds");
    expect(out[0]!.text).toContain("[Mail] Appel de fonds");
  });

  it("extraction d'actions demandée sans Claude : avertissement explicite", async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    const log = vi.fn();
    await buildSources(s, { ...profile, extractActions: true }, data(), null, log);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Extraction d'actions ignorée/), "warn");
  });
});
