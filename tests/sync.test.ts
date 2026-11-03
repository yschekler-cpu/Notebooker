import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chrome-mock";
import { DEFAULT_SETTINGS, getSubscriptions, saveSubscriptions } from "../src/shared/storage";
import type { Subscription } from "../src/shared/types";
import { MAX_ITEMS_PER_RUN, refreshOne, type Pusher } from "../src/background/sync";

const target = { kind: "notebooklm" as const, notebookId: "nb", label: "NB" };

function sub(p: Partial<Subscription>): Subscription {
  return { id: "s1", kind: "url", ref: "https://ex.com/a", title: "A", target, refreshMinutes: 60, lastCheckedAt: null, lastFingerprint: null, seenItemIds: [], enabled: true, lastError: null, ...p };
}

function rss(n: number): string {
  return `<rss><channel>${Array.from({ length: n }, (_, i) => `<item><title>T${i}</title><link>https://ex.com/${i}</link><guid>g${i}</guid></item>`).join("")}</channel></rss>`;
}

beforeEach(() => {
  installChromeMock();
  vi.restoreAllMocks();
});

async function stored(): Promise<Subscription> {
  return (await getSubscriptions())[0]!;
}

describe("refreshOne", () => {
  it("échec partiel d'un flux : seuls les items poussés sont marqués vus (pas de doublon, pas de perte)", async () => {
    const s = sub({ kind: "feed", ref: "https://ex.com/rss", seenItemIds: ["old"], lastCheckedAt: "2026-11-01T00:00:00Z", lastFingerprint: "parsed" });
    await saveSubscriptions([s]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(rss(3))));
    const pusher: Pusher = vi.fn(async () => ({ failed: [1], errors: ["T1: timeout"] }));

    const r = await refreshOne(s, DEFAULT_SETTINGS, pusher);
    expect(r.pushed).toBe(2);
    expect(r.error).toMatch(/2\/3 ajoutées/);
    const after = await stored();
    expect(after.seenItemIds.sort()).toEqual(["g0", "g2", "old"]);

    // Passage suivant : seul l'item en échec est retenté
    const pusher2: Pusher = vi.fn(async () => ({ failed: [], errors: [] }));
    await refreshOne(after, DEFAULT_SETTINGS, pusher2);
    expect(vi.mocked(pusher2).mock.calls[0]![1].map((x) => x.title)).toEqual(["T1"]);
    expect((await stored()).lastError).toBeNull();
  });

  it("premier passage d'un flux : N derniers poussés, historique ignoré ; ensuite le surplus est conservé", async () => {
    const s = sub({ kind: "feed", ref: "https://ex.com/rss" });
    await saveSubscriptions([s]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(rss(MAX_ITEMS_PER_RUN + 5))));
    const pusher: Pusher = vi.fn(async () => ({ failed: [], errors: [] }));
    const r = await refreshOne(s, DEFAULT_SETTINGS, pusher);
    expect(r.pushed).toBe(MAX_ITEMS_PER_RUN);
    expect((await stored()).seenItemIds).toHaveLength(MAX_ITEMS_PER_RUN + 5);
  });

  it("passages suivants : plus de N nouveaux items → le surplus part au passage d'après", async () => {
    const s = sub({ kind: "feed", ref: "https://ex.com/rss", seenItemIds: ["x"], lastCheckedAt: "2026-11-01T00:00:00Z", lastFingerprint: "parsed" });
    await saveSubscriptions([s]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(rss(MAX_ITEMS_PER_RUN + 3))));
    const pusher: Pusher = vi.fn(async () => ({ failed: [], errors: [] }));
    await refreshOne(s, DEFAULT_SETTINGS, pusher);
    await refreshOne(await stored(), DEFAULT_SETTINGS, pusher);
    expect(vi.mocked(pusher).mock.calls[1]![1]).toHaveLength(3);
  });

  it("URL suivie : empreinte conservée si le push échoue → retentée", async () => {
    const s = sub({ lastFingerprint: "ancienne" });
    await saveSubscriptions([s]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>nouveau contenu</p>")));
    await refreshOne(s, DEFAULT_SETTINGS, async () => {
      throw new Error("NotebookLM KO");
    });
    const after = await stored();
    expect(after.lastFingerprint).toBe("ancienne");
    expect(after.lastError).toBe("NotebookLM KO");

    await refreshOne(after, DEFAULT_SETTINGS, async () => ({ failed: [], errors: [] }));
    expect((await stored()).lastFingerprint).not.toBe("ancienne");
    // Contenu inchangé → pas de nouveau push
    const pusher: Pusher = vi.fn(async () => ({ failed: [], errors: [] }));
    await refreshOne(await stored(), DEFAULT_SETTINGS, pusher);
    expect(pusher).not.toHaveBeenCalled();
  });

  it("ajout unique : aucun fetch (pas de permission hôte requise), un seul push", async () => {
    const s = sub({ refreshMinutes: 0 });
    await saveSubscriptions([s]);
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const pusher: Pusher = vi.fn(async () => ({ failed: [], errors: [] }));
    await refreshOne(s, DEFAULT_SETTINGS, pusher);
    await refreshOne(await stored(), DEFAULT_SETTINGS, pusher);
    expect(f).not.toHaveBeenCalled();
    expect(pusher).toHaveBeenCalledTimes(1);
  });

  it("erreur de lecture : message explicite, abonnement daté", async () => {
    const s = sub({});
    await saveSubscriptions([s]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const r = await refreshOne(s, DEFAULT_SETTINGS, async () => ({ failed: [], errors: [] }));
    expect(r.error).toMatch(/permission du site/);
    expect((await stored()).lastCheckedAt).not.toBeNull();
  });

  it("Notion sans token : erreur claire", async () => {
    const s = sub({ kind: "notion_page", ref: "0123456789abcdef0123456789abcdef", workspace: "company" });
    await saveSubscriptions([s]);
    const r = await refreshOne(s, DEFAULT_SETTINGS, async () => ({ failed: [], errors: [] }));
    expect(r.error).toMatch(/Token Notion manquant/);
  });

  it("flux dont le 1er essai a échoué : le passage suivant reste un « premier passage » (pas d'inondation)", async () => {
    const s = sub({ kind: "feed", ref: "https://ex.com/rss" });
    await saveSubscriptions([s]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await refreshOne(s, DEFAULT_SETTINGS, async () => ({ failed: [], errors: [] }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(rss(30))));
    const pusher: Pusher = vi.fn(async () => ({ failed: [], errors: [] }));
    await refreshOne(await stored(), DEFAULT_SETTINGS, pusher);
    await refreshOne(await stored(), DEFAULT_SETTINGS, pusher);
    expect(vi.mocked(pusher).mock.calls).toHaveLength(1);
    expect(vi.mocked(pusher).mock.calls[0]![1]).toHaveLength(MAX_ITEMS_PER_RUN);
  });

  it("« ajout unique » puis passage en suivi : empreinte initialisée sans re-push", async () => {
    const s = sub({ refreshMinutes: 1440, lastFingerprint: "once" });
    await saveSubscriptions([s]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>v1</p>")));
    const pusher: Pusher = vi.fn(async () => ({ failed: [], errors: [] }));
    await refreshOne(s, DEFAULT_SETTINGS, pusher);
    expect(pusher).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<p>v2</p>")));
    await refreshOne(await stored(), DEFAULT_SETTINGS, pusher);
    expect(pusher).toHaveBeenCalledTimes(1);
  });
});

describe("notion_database : curseur sans trou", () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.notion.company.token = "secret";
  const pages = Array.from({ length: 25 }, (_, i) => ({
    object: "page", id: `p${i}`, url: `https://notion.so/p${i}`,
    last_edited_time: new Date(Date.UTC(2026, 10, 2, 8, i)).toISOString(),
    properties: { Name: { type: "title", title: [{ plain_text: `Page ${i}` }] } },
  }));

  function notionFetch() {
    return vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.includes("/children")) return Response.json({ results: [], has_more: false, next_cursor: null });
      const body = JSON.parse(String(init?.body ?? "{}"));
      const since = body.filter?.last_edited_time?.on_or_after;
      const list = pages.filter((p) => !since || p.last_edited_time >= since);
      const start = Number(body.start_cursor ?? 0);
      const slice = list.slice(start, start + body.page_size);
      const more = start + body.page_size < list.length;
      return Response.json({ results: slice, has_more: more, next_cursor: more ? String(start + body.page_size) : null });
    });
  }

  it("édition massive (25 pages) → 10 + 10 + 5 sur 3 passages, aucune perdue ni dupliquée", async () => {
    const s = sub({ kind: "notion_database", ref: "0123456789abcdef0123456789abcdef", workspace: "company", target: { kind: "notebooklm", notebookId: "nb", label: "NB" } });
    await saveSubscriptions([s]);
    vi.stubGlobal("fetch", notionFetch());
    const pushed: string[] = [];
    const pusher: Pusher = async (_s, sources) => {
      pushed.push(...sources.map((x) => x.title.split(" — ")[0]!));
      return { failed: [], errors: [] };
    };
    for (let i = 0; i < 4; i++) await refreshOne(await stored(), settings, pusher);
    expect(pushed).toHaveLength(25);
    expect(new Set(pushed).size).toBe(25);
  });

  it("échec de push → page retentée au passage suivant", async () => {
    const s = sub({ kind: "notion_database", ref: "0123456789abcdef0123456789abcdef", workspace: "company" });
    await saveSubscriptions([s]);
    vi.stubGlobal("fetch", notionFetch());
    let calls = 0;
    const seen: string[] = [];
    const pusher: Pusher = async (_s, sources) => {
      calls++;
      seen.push(...sources.map((x) => x.title.split(" — ")[0]!));
      return calls === 1 ? { failed: [0], errors: ["KO"] } : { failed: [], errors: [] };
    };
    for (let i = 0; i < 4; i++) await refreshOne(await stored(), settings, pusher);
    expect(seen.filter((t) => t === "[Notion] Page 0")).toHaveLength(2); // 1 échec + 1 retry
    expect(new Set(seen).size).toBe(25);
  });
});
