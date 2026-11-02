/**
 * Parseur RSS 2.0 / Atom minimal. Le service worker MV3 n'a pas de DOMParser,
 * d'où un parsing par regex suffisant pour les flux standards (blogs, YouTube feeds/videos.xml).
 */

export interface FeedItem {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
}

export function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  const isAtom = /<feed[\s>]/i.test(xml);
  const blocks = matchAll(xml, isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi);
  const channelTitle = decode(tag(xml.replace(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi, ""), "title") ?? "");

  const items = blocks
    .map((b): FeedItem | null => {
      const title = decode(tag(b, "title") ?? "(sans titre)");
      let url: string | null;
      if (isAtom) {
        url =
          attr(b, /<link[^>]*rel=["']alternate["'][^>]*>/i, "href") ??
          attr(b, /<link[^>]*>/i, "href");
      } else {
        url = tag(b, "link");
      }
      const ytId = tag(b, "yt:videoId");
      if (ytId) url = `https://www.youtube.com/watch?v=${ytId}`;
      if (!url) return null;
      url = decode(url).trim();
      const id = decode(tag(b, isAtom ? "id" : "guid") ?? url).trim();
      const publishedAt = tag(b, isAtom ? "published" : "pubDate") ?? tag(b, "updated");
      return { id, title: title.trim(), url, publishedAt: publishedAt ? safeIso(publishedAt) : null };
    })
    .filter((x): x is FeedItem => x !== null);

  return { title: channelTitle.trim(), items };
}

/** Convertit une URL de chaîne YouTube connue en URL de flux si possible. */
export function youtubeFeedUrl(input: string): string | null {
  const channel = /youtube\.com\/channel\/(UC[\w-]{22})/.exec(input);
  if (channel) return `https://www.youtube.com/feeds/videos.xml?channel_id=${channel[1]}`;
  const playlist = /[?&]list=([\w-]+)/.exec(input);
  if (playlist && /youtube\.com/.test(input)) return `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlist[1]}`;
  return null;
}

function matchAll(s: string, re: RegExp): string[] {
  return Array.from(s.matchAll(re), (m) => m[0]);
}

function tag(s: string, name: string): string | null {
  const escaped = name.replace(":", "\\:");
  const m = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, "i").exec(s);
  if (!m || m[1] === undefined) return null;
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
}

function attr(s: string, tagRe: RegExp, name: string): string | null {
  const t = tagRe.exec(s)?.[0];
  if (!t) return null;
  return new RegExp(`${name}=["']([^"']+)["']`, "i").exec(t)?.[1] ?? null;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function safeIso(d: string): string | null {
  const t = Date.parse(d.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
