import { describe, expect, it } from "vitest";
import { buildGmailQuery, stripQuoted } from "../src/background/gmail";
import { blockToMarkdown, clean } from "../src/background/notion";
import { htmlToText } from "../src/background/text";

const rt = (t: string, extra: object = {}) => [{ plain_text: t, ...extra }];

describe("Notion", () => {
  it("convertit les blocs en Markdown", () => {
    expect(blockToMarkdown({ type: "heading_2", heading_2: { rich_text: rt("Sprint 42") } })).toBe("\n## Sprint 42");
    expect(blockToMarkdown({ type: "to_do", to_do: { rich_text: rt("Valider spec KYC"), checked: true } }, 1)).toBe("  - [x] Valider spec KYC");
    expect(blockToMarkdown({ type: "paragraph", paragraph: { rich_text: rt("doc", { href: "https://x", annotations: { bold: true } }) } })).toBe("[**doc**](https://x)");
  });
  it("extrait l'ID depuis une URL Notion", () => {
    expect(clean("https://www.notion.so/opale/Roadmap-0123456789abcdef0123456789abcdef?pvs=4")).toBe("0123456789abcdef0123456789abcdef");
    expect(clean("01234567-89ab-cdef-0123-456789abcdef")).toBe("0123456789abcdef0123456789abcdef");
  });
});

describe("Gmail", () => {
  it("construit la requête avec exclusions", () => {
    expect(buildGmailQuery("in:inbox", 30, ["noreply@dotfile.com", "label:kyc"])).toBe(
      "in:inbox newer_than:2d -from:noreply@dotfile.com -label:kyc",
    );
  });
  it("retire l'historique cité", () => {
    const body = "Ok pour moi.\n\nLe lun. 2 nov. 2026 à 09:00, Paul <p@x.fr> a écrit :\n> ancien message";
    expect(stripQuoted(body)).toBe("Ok pour moi.");
  });
  it("convertit le HTML en texte", () => {
    expect(htmlToText("<style>x{}</style><p>Bonjour&nbsp;<b>Yann</b></p><ul><li>A</li><li>B</li></ul>")).toBe("Bonjour Yann\n• A\n• B");
  });
});
