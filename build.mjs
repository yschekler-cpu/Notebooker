import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });
cpSync("src/popup/popup.html", "dist/popup.html");
cpSync("src/options/options.html", "dist/options.html");
cpSync("src/options/options.css", "dist/options.css");

const common = {
  bundle: true,
  target: "chrome120",
  outdir: "dist",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
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
