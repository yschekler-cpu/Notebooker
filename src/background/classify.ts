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
