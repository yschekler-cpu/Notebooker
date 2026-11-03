import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chrome-mock";
import { buildAuthorizeUrl, disconnectNotion, exchangeCode, parseRedirect, refreshNotionAccess } from "../src/background/notionAuth";
import { NotionClient } from "../src/background/notion";
import { DEFAULT_SETTINGS, getSettings, resolveSettings, saveSettings } from "../src/shared/storage";

const REDIRECT = "https://pkhpbkhohjogegmldhbkmciebihllfpi.chromiumapp.org/notion";

async function seedOAuth(p: Partial<typeof DEFAULT_SETTINGS.notion.company.oauth> = {}) {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.notion.company = { ...s.notion.company, authMode: "oauth", oauth: { ...s.notion.company.oauth, clientId: "cid", clientSecret: "sec", accessToken: "old-at", refreshToken: "rt-1", ...p } };
  await saveSettings(s);
}

beforeEach(() => {
  installChromeMock();
  vi.restoreAllMocks();
});

describe("Notion OAuth", () => {
  it("URL d'autorisation conforme (response_type=code, owner=user, state)", () => {
    const u = new URL(buildAuthorizeUrl("cid", REDIRECT, "st-1"));
    expect(`${u.origin}${u.pathname}`).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: "cid", response_type: "code", owner: "user", redirect_uri: REDIRECT, state: "st-1" });
  });

  it("retour : code extrait ; state différent ou refus → rejet", () => {
    expect(parseRedirect(`${REDIRECT}?code=abc&state=s`, "s")).toBe("abc");
    expect(() => parseRedirect(`${REDIRECT}?code=abc&state=autre`, "s")).toThrow(/state/);
    expect(() => parseRedirect(`${REDIRECT}?error=access_denied&state=s`, "s")).toThrow(/refusée/);
    expect(() => parseRedirect(`${REDIRECT}?state=s`, "s")).toThrow(/sans code/);
  });

  it("échange du code : Basic client_id:secret, corps authorization_code ; erreurs explicites", async () => {
    const f = vi.fn(async () => Response.json({ access_token: "at", refresh_token: "rt", workspace_name: "Opale", bot_id: "b" }));
    const t = await exchangeCode("cid", "sec", "abc", REDIRECT, f as unknown as typeof fetch);
    expect(t.workspace_name).toBe("Opale");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.notion.com/v1/oauth/token");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("cid:sec")}`);
    expect(JSON.parse(String(init.body))).toEqual({ grant_type: "authorization_code", code: "abc", redirect_uri: REDIRECT });
    const bad = vi.fn(async () => Response.json({ error: "invalid_client" }, { status: 401 }));
    await expect(exchangeCode("cid", "x", "abc", REDIRECT, bad as unknown as typeof fetch)).rejects.toThrow(/Client ID ou secret/);
  });

  it("renouvellement : un seul appel pour des demandes simultanées, nouveaux jetons persistés", async () => {
    await seedOAuth();
    const f = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return Response.json({ access_token: "new-at", refresh_token: "rt-2" });
    });
    const [a, b] = await Promise.all([refreshNotionAccess("company", f as unknown as typeof fetch), refreshNotionAccess("company", f as unknown as typeof fetch)]);
    expect([a, b]).toEqual(["new-at", "new-at"]);
    expect(f).toHaveBeenCalledTimes(1); // un refresh token ne se consomme qu'une fois
    const o = (await getSettings()).notion.company.oauth;
    expect([o.accessToken, o.refreshToken]).toEqual(["new-at", "rt-2"]);
  });

  it("client Notion : 401 → refresh automatique puis nouvel essai avec le nouveau jeton", async () => {
    await seedOAuth();
    const auths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth/token")) return Response.json({ access_token: "fresh-at", refresh_token: "rt-2" });
      const auth = (init?.headers as Record<string, string>).Authorization;
      auths.push(auth ?? "");
      return auth === "Bearer fresh-at" ? Response.json({ bot: { workspace_name: "Opale" } }) : new Response("{}", { status: 401 });
    }));
    const s = await getSettings();
    expect(await new NotionClient(s.notion.company, "company").me()).toBe("Opale");
    expect(auths).toEqual(["Bearer old-at", "Bearer fresh-at"]);
  });

  it("refresh token invalide → message « reconnecte-toi », pas de boucle", async () => {
    await seedOAuth();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls++;
      if (url.endsWith("/oauth/token")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return new Response("{}", { status: 401 });
    }));
    const s = await getSettings();
    await expect(new NotionClient(s.notion.company, "company").me()).rejects.toThrow(/reconnecte-toi/);
    expect(calls).toBe(2);
  });

  it("déconnexion : révocation (Basic + Notion-Version), jetons effacés, Client ID / secret conservés", async () => {
    await seedOAuth({ workspaceName: "Opale" });
    const f = vi.fn(async () => Response.json({ request_id: "r" }));
    expect(await disconnectNotion("company", f as unknown as typeof fetch)).toEqual({ revoked: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.notion.com/v1/oauth/revoke");
    expect((init.headers as Record<string, string>)["Notion-Version"]).toBe("2026-03-11");
    expect(JSON.parse(String(init.body))).toEqual({ token: "old-at" });
    const o = (await getSettings()).notion.company.oauth;
    expect(o).toMatchObject({ clientId: "cid", clientSecret: "sec", accessToken: "", refreshToken: "", workspaceName: "" });
  });

  it("mode jeton d'API inchangé ; anciens réglages (sans authMode) → mode jeton", () => {
    const s = resolveSettings({ notion: { company: { label: "X", token: "secret_abc", briefingRootIds: [] } } });
    expect(s.notion.company.authMode).toBe("token");
    expect(new NotionClient(s.notion.company).configured).toBe(true);
    const o = structuredClone(s.notion.company);
    o.authMode = "oauth";
    expect(new NotionClient(o).configured).toBe(false); // OAuth non connecté
  });
});
