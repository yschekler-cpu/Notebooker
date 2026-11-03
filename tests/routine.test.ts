import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chrome-mock";
import { fireRoutine, fireText, matchesRequest, readRoutineManifest, validateFireUrl, validateRoutineToken } from "../src/background/routine";
import { normalizeProfile, PROFILE_TEMPLATES } from "../src/shared/profiles";
import { DEFAULT_SETTINGS } from "../src/shared/storage";
import type { InboxManifest } from "../src/background/localInbox";

const URL_OK = "https://api.anthropic.com/v1/claude_code/routines/trig_01AbC-xyz/fire";
const TOKEN = "sk-ant-oat01-abcdefghijklmnop_QRS";
const profile = () =>
  normalizeProfile({ ...PROFILE_TEMPLATES.routine!(), id: "r", routine: { fireUrl: URL_OK, token: TOKEN, notionPage: "https://www.notion.so/opale/Depot-0123456789abcdef0123456789abcdef", workspace: "company", timeoutMinutes: 15 } });

beforeEach(() => {
  installChromeMock();
  vi.restoreAllMocks();
});

describe("routine Claude : sécurité de l'URL et du jeton", () => {
  it("n'accepte que l'endpoint officiel (le jeton ne part jamais ailleurs)", () => {
    expect(validateFireUrl(URL_OK)).toBe(URL_OK);
    for (const bad of [
      "http://api.anthropic.com/v1/claude_code/routines/trig_1/fire",
      "https://api.anthropic.com.evil.io/v1/claude_code/routines/trig_1/fire",
      "https://evil.io/v1/claude_code/routines/trig_1/fire",
      "https://api.anthropic.com/v1/messages",
      "https://api.anthropic.com/v1/claude_code/routines/trig_1/fire?x=1",
      "pas une url",
    ]) expect(() => validateFireUrl(bad)).toThrow();
  });
  it("jeton au format sk-ant-oat01", () => {
    expect(validateRoutineToken(` ${TOKEN} `)).toBe(TOKEN);
    expect(() => validateRoutineToken("sk-ant-api03-xxxxxxxxxxxxxxxx")).toThrow(/oat01/);
  });
});

describe("routine Claude : déclenchement", () => {
  it("POST conforme : Bearer, anthropic-version, text avec requestId et page de dépôt", async () => {
    const f = vi.fn(async () => Response.json({ type: "routine_fire", claude_code_session_id: "session_1", claude_code_session_url: "https://claude.ai/code/session_1" }));
    const r = await fireRoutine(profile(), "nb-123", f as unknown as typeof fetch);
    expect(r).toEqual({ sessionId: "session_1", sessionUrl: "https://claude.ai/code/session_1" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_OK);
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(h["anthropic-version"]).toBe("2026-10-21");
    const text = JSON.parse(String(init.body)).text as string;
    expect(text).toContain("requestId: nb-123");
    expect(text).toContain("Depot-0123456789abcdef0123456789abcdef");
    expect(text.length).toBeLessThan(65_536);
  });
  it("erreurs explicites (401, 429 + Retry-After, réponse inattendue)", async () => {
    const r401 = vi.fn(async () => Response.json({ type: "error", error: { type: "authentication_error", message: "bad token" } }, { status: 401 }));
    await expect(fireRoutine(profile(), "x", r401 as unknown as typeof fetch)).rejects.toThrow(/jeton refusé/);
    const r429 = vi.fn(async () => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }), { status: 429, headers: { "Retry-After": "120" } }));
    await expect(fireRoutine(profile(), "x", r429 as unknown as typeof fetch)).rejects.toThrow(/limite horaire.*120 s/);
    const odd = vi.fn(async () => Response.json({ ok: true }));
    await expect(fireRoutine(profile(), "x", odd as unknown as typeof fetch)).rejects.toThrow(/inattendue/);
  });
  it("texte de déclenchement borné et lisible", () => {
    expect(fireText(profile(), "nb-9", "https://notion.so/p", new Date("2026-11-03T06:00:00Z"))).toMatch(/^Déclenchement Notebooker — profil « Brief routine Claude \(API\) »\.\nrequestId: nb-9\n/);
  });
});

describe("routine Claude : lecture du dépôt", () => {
  const manifest = (p: Partial<InboxManifest> & Record<string, unknown> = {}) =>
    JSON.stringify({ format: "notebooker-brief", version: 1, id: "2026-11-03-daily", requestId: "nb-1", generatedAt: "2026-11-03T07:00:00Z", topics: [{ key: "a", title: "A", section: "tasks", summary: "x" }], ...p });

  it("trouve le manifest dans un bloc de code de la page Notion", async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.notion.company.token = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      results: [
        { type: "paragraph", paragraph: { rich_text: [{ plain_text: "intro" }] } },
        { type: "code", code: { language: "json", rich_text: [{ plain_text: manifest().slice(0, 40) }, { plain_text: manifest().slice(40) }] } },
      ],
      has_more: false, next_cursor: null,
    })));
    const m = await readRoutineManifest(s, profile());
    expect(m).toMatchObject({ id: "2026-11-03-daily", requestId: "nb-1" });
  });
  it("page vide → null ; manifest invalide → erreur explicite ; Notion non connecté → erreur", async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    await expect(readRoutineManifest(s, profile())).rejects.toThrow(/Notion non connecté/);
    s.notion.company.token = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [], has_more: false, next_cursor: null })));
    expect(await readRoutineManifest(s, profile())).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [{ type: "code", code: { language: "json", rich_text: [{ plain_text: '{"format":"notebooker-brief","version":1}' }] } }], has_more: false, next_cursor: null })));
    await expect(readRoutineManifest(s, profile())).rejects.toThrow(/invalide/);
  });
  it("corrélation : requestId prioritaire, sinon fraîcheur", () => {
    const m = (x: Partial<InboxManifest>) => ({ id: "i", generatedAt: "2026-11-03T07:00:00Z", topics: [], sources: [], actions: [], ...x }) as InboxManifest;
    const fired = Date.parse("2026-11-03T06:50:00Z");
    expect(matchesRequest(m({ requestId: "nb-1" }), "nb-1", fired)).toBe(true);
    expect(matchesRequest(m({ requestId: "nb-0" }), "nb-1", fired)).toBe(false); // ancien brief resté dans la page
    expect(matchesRequest(m({}), "nb-1", fired)).toBe(true);
    expect(matchesRequest(m({ generatedAt: "2026-11-02T07:00:00Z" }), "nb-1", fired)).toBe(false);
  });
});
