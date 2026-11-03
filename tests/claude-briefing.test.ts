import { describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chrome-mock";
import { synthesizeBriefing, testClaude } from "../src/background/claude";
import { buildSources, type NotionDigestItem } from "../src/background/briefing";
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
    expect(await synthesizeBriefing(cfg(), "corpus", f)).toBe("## Brief");
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
    await expect(synthesizeBriefing(cfg(), "x", f)).rejects.toThrow(/refusal/);
  });

  it("identifiants manquants → erreur avant tout appel réseau", async () => {
    await expect(testClaude(cfg({ apiKey: "" }))).rejects.toThrow(/Clé API Claude manquante/);
    await expect(testClaude(cfg({ authMode: "oauth_token", oauthToken: "" }))).rejects.toThrow(/Jeton OAuth/);
  });
});

describe("buildSources", () => {
  const mails = [{ id: "1", threadId: "t", from: "Paul <paul@opale.fr>", subject: "Appel de fonds", date: "2026-11-02T07:00:00Z", snippet: "", body: "IBAN FR76 3000 6000 0112 3456 7890 189 à vérifier", labels: [] }];
  const notion: NotionDigestItem[] = [{ id: "p", title: "Roadmap", url: "https://notion.so/p", lastEditedTime: "2026-11-02T06:00:00Z", workspace: "company", markdown: "- Sprint 12" }];

  it("sans Claude : sources brutes regroupées, PII masquée", async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    const out = await buildSources(s, mails, notion, () => undefined);
    expect(out.map((x) => x.title.split(" — ")[0])).toEqual(["Emails", "Notion entreprise"]);
    expect(out[0]!.text).toContain("[IBAN]");
    expect(out[0]!.text).toContain("[EMAIL]");
    expect(out[0]!.text).not.toContain("FR76");
  });

  it("masquage désactivé : contenu intact", async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.claude.redactPII = false;
    const out = await buildSources(s, mails, [], () => undefined);
    expect(out[0]!.text).toContain("FR76");
  });

  it("Claude en échec : warning loggué, sources brutes quand même produites", async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.claude.enabled = true; // pas de clé → échec immédiat
    const log = vi.fn();
    const out = await buildSources(s, mails, notion, log);
    expect(out).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Synthèse Claude ignorée/), "warn");
  });
});
