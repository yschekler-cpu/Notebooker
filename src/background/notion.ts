import { NOTION_API } from "../shared/endpoints";
import type { NotionWorkspaceConfig, NotionWorkspaceKey } from "../shared/types";
import { refreshNotionAccess } from "./notionAuth";

/**
 * Client Notion minimal (API REST publique) — jeton d'API (connexion interne) ou OAuth utilisateur.
 * Une intégration par workspace (perso / entreprise) — l'intégration n'accède qu'aux pages
 * explicitement partagées avec elle : c'est le premier niveau de contrôle d'accès.
 */

const NOTION_VERSION = "2022-06-28";
const BASE = NOTION_API;

type Json = Record<string, unknown>;

export interface NotionPageLite {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string;
}

export class NotionClient {
  private refreshed = false;

  /**
   * @param ws  configuration du workspace
   * @param key clé du workspace — requise pour renouveler et persister un jeton OAuth expiré
   */
  constructor(
    private readonly ws: NotionWorkspaceConfig,
    private readonly key?: NotionWorkspaceKey,
  ) {}

  /** Jeton effectif selon le mode : connexion interne (jeton d'API) ou OAuth utilisateur. */
  private get token(): string {
    return (this.ws.authMode === "oauth" ? this.ws.oauth?.accessToken : this.ws.token)?.trim() ?? "";
  }

  get configured(): boolean {
    return this.token.length > 0;
  }

  private async call<T = Json>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      signal: AbortSignal.timeout(30_000),
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get("Retry-After") ?? "1") * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.call<T>(path, init, attempt + 1);
    }
    // OAuth : jeton expiré → un seul renouvellement puis nouvel essai
    if (res.status === 401 && this.ws.authMode === "oauth" && this.key && !this.refreshed) {
      this.refreshed = true;
      this.ws.oauth = { ...this.ws.oauth, accessToken: await refreshNotionAccess(this.key) };
      return this.call<T>(path, init, attempt);
    }
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error(this.ws.authMode === "oauth" ? "Notion 401 : session expirée — reconnecte-toi (Réglages › Notion)." : "Notion 401 : jeton d'API invalide ou révoqué.");
      }
      throw new Error(`Notion ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async me(): Promise<string> {
    const r = await this.call<{ name?: string; bot?: { workspace_name?: string } }>("/users/me");
    return r.bot?.workspace_name ?? r.name ?? "OK";
  }

  /** Pages modifiées depuis `since`, triées de la plus récente à la plus ancienne. */
  async searchEditedSince(since: Date, limit = 30): Promise<NotionPageLite[]> {
    const out: NotionPageLite[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.call<{ results: Json[]; has_more: boolean; next_cursor: string | null }>("/search", {
        method: "POST",
        body: JSON.stringify({
          filter: { property: "object", value: "page" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          page_size: 50,
          start_cursor: cursor,
        }),
      });
      for (const p of r.results) {
        const lite = toLite(p);
        if (new Date(lite.lastEditedTime) < since) return out; // tri descendant → on peut s'arrêter
        out.push(lite);
        if (out.length >= limit) return out;
      }
      cursor = r.has_more ? (r.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return out;
  }

  /**
   * Pages d'une base, filtrées sur `last_edited_time >= editedSince`, paginées jusqu'à `limit`.
   * `ascending` = du plus ancien au plus récent (curseur de synchro sans trou).
   */
  async queryDatabase(databaseId: string, editedSince?: Date, limit = 50, ascending = false): Promise<NotionPageLite[]> {
    const out: NotionPageLite[] = [];
    let cursor: string | undefined;
    do {
      const body: Json = {
        page_size: Math.min(limit - out.length, 100),
        sorts: [{ timestamp: "last_edited_time", direction: ascending ? "ascending" : "descending" }],
      };
      if (cursor) body.start_cursor = cursor;
      if (editedSince) {
        body.filter = { timestamp: "last_edited_time", last_edited_time: { on_or_after: editedSince.toISOString() } };
      }
      const r = await this.call<{ results: Json[]; has_more: boolean; next_cursor: string | null }>(`/databases/${clean(databaseId)}/query`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      out.push(...r.results.map(toLite));
      cursor = r.has_more ? (r.next_cursor ?? undefined) : undefined;
    } while (cursor && out.length < limit);
    return out;
  }

  async getPage(pageId: string): Promise<NotionPageLite> {
    return toLite(await this.call(`/pages/${clean(pageId)}`));
  }

  /** Blocs de code de premier niveau d'une page (texte brut, langage). */
  async codeBlocks(pageId: string): Promise<{ language: string; text: string }[]> {
    const out: { language: string; text: string }[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ page_size: "100" });
      if (cursor) qs.set("start_cursor", cursor);
      const r = await this.call<{ results: Json[]; has_more: boolean; next_cursor: string | null }>(`/blocks/${clean(pageId)}/children?${qs}`);
      for (const b of r.results) {
        if (b.type !== "code") continue;
        const code = b.code as { language?: string; rich_text?: { plain_text?: string }[] };
        out.push({ language: String(code.language ?? ""), text: (code.rich_text ?? []).map((t) => t.plain_text ?? "").join("") });
      }
      cursor = r.has_more ? (r.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return out;
  }

  /** Contenu d'une page en Markdown (récursif, profondeur bornée). */
  async pageMarkdown(pageId: string, maxDepth = 3): Promise<string> {
    return (await this.blocksToMarkdown(clean(pageId), 0, maxDepth)).trim();
  }

  private async blocksToMarkdown(blockId: string, depth: number, maxDepth: number): Promise<string> {
    const lines: string[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({ page_size: "100" });
      if (cursor) qs.set("start_cursor", cursor);
      const r = await this.call<{ results: Json[]; has_more: boolean; next_cursor: string | null }>(
        `/blocks/${blockId}/children?${qs}`,
      );
      for (const b of r.results) {
        lines.push(blockToMarkdown(b, depth));
        if (b.has_children && depth < maxDepth && b.type !== "child_page" && b.type !== "child_database") {
          lines.push(await this.blocksToMarkdown(String(b.id), depth + 1, maxDepth));
        }
      }
      cursor = r.has_more ? (r.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return lines.filter(Boolean).join("\n");
  }

  /** Schéma des propriétés d'une base (nom → type + options select/status). */
  async databaseSchema(databaseId: string): Promise<DbSchema> {
    const db = await this.call<{ title?: { plain_text: string }[]; properties: Record<string, RawProp> }>(`/databases/${clean(databaseId)}`);
    return {
      title: (db.title ?? []).map((t) => t.plain_text).join("") || "(base sans titre)",
      properties: Object.fromEntries(
        Object.entries(db.properties).map(([name, p]) => [
          name,
          { type: p.type, options: (p.select?.options ?? p.status?.options ?? p.multi_select?.options ?? []).map((o) => o.name) },
        ]),
      ),
    };
  }

  async createPage(databaseId: string, properties: Json, children: Json[]): Promise<{ id: string; url: string }> {
    const r = await this.call<{ id: string; url: string }>("/pages", {
      method: "POST",
      body: JSON.stringify({ parent: { database_id: clean(databaseId) }, properties, children: children.slice(0, 90) }),
    });
    return { id: r.id, url: r.url };
  }

  /** Cible « base Notion » : crée une entrée avec titre + URL + contenu. */
  async createDatabaseEntry(databaseId: string, entry: { title: string; url?: string; text?: string }): Promise<string> {
    const db = await this.call<{ properties: Record<string, { type: string }> }>(`/databases/${clean(databaseId)}`);
    const props = Object.entries(db.properties);
    const titleProp = props.find(([, v]) => v.type === "title")?.[0] ?? "Name";
    const urlProp = props.find(([, v]) => v.type === "url")?.[0];
    const properties: Json = { [titleProp]: { title: [{ text: { content: entry.title.slice(0, 2000) } }] } };
    if (urlProp && entry.url) properties[urlProp] = { url: entry.url };

    const children = (entry.text ?? "")
      .split(/\n{2,}/)
      .filter(Boolean)
      .slice(0, 90) // limite API : 100 blocs par requête
      .map((para) => ({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: para.slice(0, 2000) } }] },
      }));
    if (entry.url && !urlProp) {
      children.unshift({ object: "block", type: "bookmark", bookmark: { url: entry.url } } as never);
    }

    const r = await this.call<{ id: string }>("/pages", {
      method: "POST",
      body: JSON.stringify({ parent: { database_id: clean(databaseId) }, properties, children }),
    });
    return r.id;
  }
}

interface RawProp {
  type: string;
  select?: { options?: { name: string }[] };
  status?: { options?: { name: string }[] };
  multi_select?: { options?: { name: string }[] };
}

export interface DbSchema {
  title: string;
  properties: Record<string, { type: string; options: string[] }>;
}

export function clean(id: string): string {
  // Accepte une URL Notion ou un ID avec/sans tirets
  const m = /([0-9a-f]{32})(?:\?|$)/i.exec(id.replace(/-/g, ""));
  return m?.[1] ?? id;
}

function toLite(p: Json): NotionPageLite {
  const props = (p.properties ?? {}) as Record<string, { type: string; title?: { plain_text: string }[] }>;
  const titleProp = Object.values(props).find((v) => v.type === "title");
  const title = titleProp?.title?.map((t) => t.plain_text).join("") || "(Sans titre)";
  return { id: String(p.id), title, url: String(p.url ?? ""), lastEditedTime: String(p.last_edited_time ?? "") };
}

function rich(rt: unknown): string {
  if (!Array.isArray(rt)) return "";
  return rt
    .map((t: { plain_text?: string; href?: string | null; annotations?: { bold?: boolean; code?: boolean } }) => {
      let s = t.plain_text ?? "";
      if (t.annotations?.code) s = `\`${s}\``;
      if (t.annotations?.bold) s = `**${s}**`;
      if (t.href) s = `[${s}](${t.href})`;
      return s;
    })
    .join("");
}

export function blockToMarkdown(b: Json, depth = 0): string {
  const type = String(b.type);
  const data = (b[type] ?? {}) as Json;
  const indent = "  ".repeat(depth);
  const text = rich(data.rich_text);
  switch (type) {
    case "heading_1":
      return `\n# ${text}`;
    case "heading_2":
      return `\n## ${text}`;
    case "heading_3":
      return `\n### ${text}`;
    case "paragraph":
      return text ? `${indent}${text}` : "";
    case "bulleted_list_item":
      return `${indent}- ${text}`;
    case "numbered_list_item":
      return `${indent}1. ${text}`;
    case "to_do":
      return `${indent}- [${data.checked ? "x" : " "}] ${text}`;
    case "toggle":
      return `${indent}▸ ${text}`;
    case "quote":
      return `${indent}> ${text}`;
    case "callout":
      return `${indent}> 💡 ${text}`;
    case "code":
      return `\`\`\`${String(data.language ?? "")}\n${text}\n\`\`\``;
    case "divider":
      return "---";
    case "child_page":
      return `${indent}📄 Sous-page : ${String(data.title ?? "")}`;
    case "child_database":
      return `${indent}🗂️ Base : ${String(data.title ?? "")}`;
    case "bookmark":
    case "embed":
    case "link_preview":
      return `${indent}🔗 ${String(data.url ?? "")}`;
    case "table_row":
      return `${indent}| ${(data.cells as unknown[] | undefined)?.map(rich).join(" | ") ?? ""} |`;
    default:
      return text ? `${indent}${text}` : "";
  }
}
