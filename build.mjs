import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * node build.mjs            → dist/      (production)
 * node build.mjs --watch    → dist/      (dev, sourcemaps, rebuild auto)
 * node build.mjs --e2e      → dist-e2e/  (origines NotebookLM / Notion / Anthropic / Gmail → mock local)
 */
const watch = process.argv.includes("--watch");
const e2e = process.argv.includes("--e2e");
export const E2E_BASE = "http://127.0.0.1:47123";
const out = e2e ? "dist-e2e" : "dist";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync("static", out, { recursive: true });
cpSync("src/popup/popup.html", `${out}/popup.html`);
cpSync("src/options/options.html", `${out}/options.html`);
cpSync("src/options/options.css", `${out}/options.css`);

if (e2e) {
  const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8"));
  manifest.name += " (E2E)";
  manifest.host_permissions.push("http://127.0.0.1/*");
  manifest.content_scripts[0].matches = ["http://127.0.0.1/*"];
  writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
}

const common = {
  bundle: true,
  target: "chrome120",
  outdir: out,
  sourcemap: watch || e2e ? "inline" : false,
  minify: !watch && !e2e,
  logLevel: "info",
  // Prod : constante vide → les branches E2E sont éliminées du bundle (dead code), pas seulement inactives.
  define: { __E2E_BASE__: JSON.stringify(e2e ? E2E_BASE : "") },
};

// Service worker = module ESM ; content script / pages = IIFE (les content scripts ne supportent pas ESM).
const contexts = await Promise.all([
  esbuild.context({ ...common, format: "esm", entryPoints: { background: "src/background/index.ts" } }),
  esbuild.context({
    ...common,
    format: "iife",
    entryPoints: {
      "content-notebooklm": "src/content/notebooklm/index.ts",
      popup: "src/popup/popup.ts",
      options: "src/options/options.ts",
    },
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
