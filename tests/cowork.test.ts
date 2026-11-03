import { describe, expect, it } from "vitest";
import { OPALE_NOTION_CONTEXT, buildCoworkPrompt } from "../src/shared/coworkPrompt";
import { PROFILE_TEMPLATES, normalizeProfile } from "../src/shared/profiles";

describe("prompt Claude Cowork", () => {
  const prompt = buildCoworkPrompt({ folder: "/Users/yann/Notebooker", manifestFile: "conformite.json", profileName: "Récap conformité", lookbackHours: 168, exclusions: ["label:kyc", "notifications@dotfile.com"], focus: "Angle LCB-FT" });
  it("personnalisé : dossier, manifest, fenêtre, exclusions, angle", () => {
    expect(prompt).toContain("`/Users/yann/Notebooker`");
    expect(prompt).toContain("lis `conformite.json` existant");
    expect(prompt).toContain("168 dernières heures");
    expect(prompt).toContain("   - label:kyc\n   - notifications@dotfile.com");
    expect(prompt).toContain("Angle demandé : **Angle LCB-FT**");
    expect(prompt).toContain('"id": "AAAA-MM-JJ-conformite"');
  });
  it("contient les règles anti-redite et de conformité", () => {
    expect(prompt).toMatch(/recopie \*\*mot pour mot\*\*/);
    expect(prompt).toMatch(/uniquement ce qui a changé/);
    expect(prompt).toMatch(/Jamais d'IBAN/);
    expect(prompt).toMatch(/\*\*En dernier\*\*, `conformite.json`/);
  });
  it("sans exclusions : demande explicite avant de commencer", () => {
    expect(buildCoworkPrompt({ folder: "", manifestFile: "", profileName: "x", lookbackHours: 24, exclusions: [], focus: "" })).toMatch(/demande-moi la liste/);
    // Routine API (exécution sans surveillance) : jamais de question bloquante, exclusions par défaut
    const routine = buildCoworkPrompt({ folder: "", manifestFile: "", profileName: "x", lookbackHours: 24, exclusions: [], focus: "", target: { kind: "notion", pageUrl: "https://notion.so/p" } });
    expect(routine).not.toMatch(/demande-moi/);
    expect(routine).toMatch(/par défaut, ignore tout mail ou page portant sur un dossier KYC\/KYD/);
  });
});

describe("prompt Cowork v2 : vue 360 + deep dive", () => {
  const base = { folder: "/x", manifestFile: "latest.json", profileName: "Brief", lookbackHours: 24, exclusions: ["label:kyc"], focus: "" };
  it("contexte Opale par défaut : bases et champs réels", () => {
    const p = buildCoworkPrompt(base);
    for (const s of ["**Tech tasks**", "`Validated by Product?`", "**Tech Projects**", "`Météo forçage PM`", "**Requests for change**", "Waiting for Input", "**Daily Tech**", "**CR Réunions**"]) expect(p).toContain(s);
    expect(p).toContain(OPALE_NOTION_CONTEXT);
  });
  it("quatre rubriques dans l'ordre et sections du manifest", () => {
    const p = buildCoworkPrompt(base);
    const order = ["### A. Mes tâches", "### B. Avancement produit & tech", "### C. Points d'attention", "### D. Vue 360 Opale"].map((h) => p.indexOf(h));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(p).toMatch(/"section": "company"[\s\S]*"section": "tasks"[\s\S]*"section": "projects"[\s\S]*"section": "attention"/);
    expect(p).toMatch(/Tu n'écris que des fichiers dans ce dossier/);
    expect(p).toMatch(/aucune donnée RH individuelle/);
  });
  it("contexte personnalisé et dépôts GitHub", () => {
    const p = buildCoworkPrompt({ ...base, notionContext: "### Mes bases\n- Jira-like", githubRepos: ["opale/app", "opale/deployer"] });
    expect(p).toContain("### Mes bases");
    expect(p).not.toContain("**Tech Projects** (Accueil Tech)");
    expect(p).toContain("`opale/app`, `opale/deployer`");
    expect(buildCoworkPrompt(base)).toMatch(/relation `GitHub pull requests`/);
  });
});

describe("profil « dossier local »", () => {
  it("modèle Cowork : sans connecteurs, surveillance active, actions importées", () => {
    const p = normalizeProfile({ ...PROFILE_TEMPLATES.cowork!(), id: "c" });
    expect(p.mode).toBe("localFolder");
    expect(p.localFolder).toEqual({ manifestFile: "latest.json", watch: true });
    expect(Object.values(p.sources).every((v) => v === false)).toBe(true);
    expect(p.extractActions).toBe(true);
  });
  it("normalisation : mode inconnu → connecteurs ; manifest invalide → latest.json", () => {
    const p = normalizeProfile({ id: "x", mode: "cloud" as never, localFolder: { manifestFile: "../../etc/passwd", watch: false } });
    expect(p.mode).toBe("connectors");
    expect(p.localFolder).toEqual({ manifestFile: "latest.json", watch: false });
  });
});
