import { describe, expect, it } from "vitest";
import { classify } from "../src/background/classify";
import { parseFeed, youtubeFeedUrl } from "../src/background/rss";

describe("parseFeed", () => {
  it("parse un flux RSS 2.0 avec CDATA et entités", () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>Blog PE</title>
      <item><title><![CDATA[ELTIF 2.0 & retail]]></title><link>https://ex.com/a?x=1&amp;y=2</link><guid>a1</guid><pubDate>Mon, 02 Nov 2026 08:00:00 GMT</pubDate></item>
      <item><title>Second</title><link>https://ex.com/b</link></item></channel></rss>`;
    const f = parseFeed(xml);
    expect(f.title).toBe("Blog PE");
    expect(f.items).toHaveLength(2);
    expect(f.items[0]).toMatchObject({ id: "a1", title: "ELTIF 2.0 & retail", url: "https://ex.com/a?x=1&y=2" });
    expect(f.items[0]!.publishedAt).toBe("2026-11-02T08:00:00.000Z");
    expect(f.items[1]!.id).toBe("https://ex.com/b");
  });

  it("parse un flux Atom YouTube", () => {
    const xml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Chaîne</title>
      <entry><id>yt:video:abc</id><yt:videoId>abc123</yt:videoId><title>Vidéo 1</title>
      <link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/><published>2026-11-01T10:00:00+00:00</published></entry></feed>`;
    const f = parseFeed(xml);
    expect(f.items[0]).toMatchObject({ id: "yt:video:abc", url: "https://www.youtube.com/watch?v=abc123", title: "Vidéo 1" });
  });
});

describe("youtubeFeedUrl / classify", () => {
  it("convertit chaîne et playlist YouTube en flux", () => {
    expect(youtubeFeedUrl("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv")).toBe(
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv",
    );
    expect(classify("https://www.youtube.com/playlist?list=PL123").kind).toBe("feed");
  });
  it("une vidéo reste une URL, Notion devient notion_page", () => {
    expect(classify("https://www.youtube.com/watch?v=abc&list=PL1").kind).toBe("url");
    expect(classify("https://www.notion.so/opale/Roadmap-0123456789abcdef0123456789abcdef").kind).toBe("notion_page");
    expect(classify("https://blog.example.com/feed").kind).toBe("feed");
    expect(classify("https://www.lesechos.fr/article").kind).toBe("url");
  });
});
