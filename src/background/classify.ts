import type { SubscriptionKind } from "../shared/types";
import { youtubeFeedUrl } from "./rss";

/** Détermine le type d'abonnement à partir d'une URL collée ou de la page courante. */
export function classify(url: string): { kind: SubscriptionKind; ref: string } {
  const yt = youtubeFeedUrl(url);
  if (yt && !/watch\?v=/.test(url)) return { kind: "feed", ref: yt };
  if (/\.(rss|xml)(\?|$)|\/feed\/?$|\/rss\/?$|\/atom(\.xml)?\/?$/i.test(url)) return { kind: "feed", ref: url };
  if (/^https:\/\/([\w-]+\.)?notion\.(so|site)\//.test(url)) return { kind: "notion_page", ref: url };
  return { kind: "url", ref: url };
}

/** Origine à autoriser, ou null si aucune lecture directe n'est nécessaire (YouTube vidéo, Notion via API, ajout unique). */
export function requiredOrigin(url: string, refreshMinutes: number): string | null {
  if (!/^https?:/.test(url)) return null;
  const { kind, ref } = classify(url);
  if (kind === "feed") return `${new URL(ref).origin}/*`;
  if (kind === "url" && refreshMinutes > 0 && !/youtube\.com\/watch|youtu\.be\//.test(url)) return `${new URL(url).origin}/*`;
  return null;
}
