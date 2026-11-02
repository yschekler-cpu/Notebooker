import { describe, expect, it } from "vitest";
import { redact } from "../src/shared/redact";

describe("redact", () => {
  it("masque emails, IBAN, téléphones FR/BE/LU", () => {
    const out = redact(
      "Contact jean.dupont@exemple.fr, IBAN FR76 3000 6000 0112 3456 7890 189, tel 06 12 34 56 78 / +32 470 12 34 56 / +352 621 123 456",
    );
    expect(out).not.toMatch(/dupont|FR76|06 12|470|621/);
    expect(out).toContain("[EMAIL]");
    expect(out).toContain("[IBAN]");
    expect(out.match(/\[TEL\]/g)?.length).toBe(3);
  });

  it("masque les montants uniquement si demandé", () => {
    const t = "Souscription de 250 000 € et appel de fonds EUR 1.2M";
    expect(redact(t)).toContain("250 000 €");
    const masked = redact(t, { amounts: true });
    expect(masked).not.toContain("250 000");
    expect(masked).not.toContain("1.2M");
  });

  it("laisse le texte métier intact", () => {
    const t = "Revue KYC du fonds Opale PE II prévue jeudi, TRI cible 15%.";
    expect(redact(t)).toBe(t);
  });
});
