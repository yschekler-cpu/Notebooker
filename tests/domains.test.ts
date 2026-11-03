import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NOTEBOOKLM_HOSTS, NOTEBOOKLM_ORIGIN } from "../src/shared/endpoints";

/** Non-régression : NotebookLM est servi sur notebook.google.com (l'ancien domaine redirige). */
describe("domaines NotebookLM", () => {
  const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8"));

  it("cible principale = notebook.google.com", () => {
    expect(NOTEBOOKLM_ORIGIN).toBe("https://notebook.google.com");
  });

  it("content script et permissions couvrent le domaine actuel ET l'historique", () => {
    for (const host of NOTEBOOKLM_HOSTS) {
      expect(manifest.content_scripts[0].matches).toContain(`https://${host}/*`);
      expect(manifest.host_permissions).toContain(`https://${host}/*`);
    }
  });

  it("aucun code ne code en dur l'ancien domaine (hors liste des domaines reconnus)", () => {
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : files.push(path.join(d, f))));
    walk("src");
    const offenders = files.filter((f) => /\.(ts|html)$/.test(f) && f !== path.join("src", "shared", "endpoints.ts") && readFileSync(f, "utf8").includes("notebooklm.google.com"));
    expect(offenders).toEqual([]);
  });
});
