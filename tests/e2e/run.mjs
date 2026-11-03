/**
 * Tests E2E : extension chargée dans Chromium + faux NotebookLM (tests/e2e/mock-notebooklm.html)
 * + API Notion / Anthropic interceptées. Lancer : `npm run build && npm run e2e`.
 * Prérequis local : `npx playwright install chromium` (Playwright non listé en dépendance).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "../../dist-e2e");
const MOCK = readFileSync(path.join(here, "mock-notebooklm.html"), "utf8");
const E2E_BASE = "http://127.0.0.1:47123";
const NLM = E2E_BASE;

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    let timer;
    await Promise.race([fn(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("scénario > 90 s")), 90_000)))]).finally(() => clearTimeout(timer));
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log(`  ✗ ${name}\n    ${String(e?.stack ?? e).split("\n").slice(0, 6).join("\n    ")}`);
  }
}

// ─── Mocks API ────────────────────────────────────────────────────────────────

const NOTION_PAGE = "0123456789abcdef0123456789abcdef";
const notionCalls = [];
const claudeCalls = [];

function notionPage(id, title, edited) {
  return { object: "page", id, url: `https://www.notion.so/${id}`, last_edited_time: edited, properties: { Name: { type: "title", title: [{ plain_text: title }] } } };
}

function sse(text) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return (
    ev("message_start", { message: { id: "msg_mock", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
    ev("content_block_stop", { index: 0 }) +
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }) +
    ev("message_stop", {})
  );
}

/** Serveur de mock unique (le build E2E route NotebookLM, Notion, Anthropic et Gmail vers lui). */
function startMockServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, E2E_BASE);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const json = (o, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };

    if (url.pathname === "/feed.xml") {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      return res.end(`<rss><channel><title>Veille</title>
        <item><title>Article A</title><link>https://example.com/a</link><guid>a</guid></item>
        <item><title>Article B</title><link>https://example.com/b</link><guid>b</guid></item></channel></rss>`);
    }

    if (url.pathname.startsWith("/notion/v1/")) {
      const path = url.pathname.slice("/notion".length);
      notionCalls.push({ method: req.method, path, headers: req.headers });
      if (req.headers.authorization !== "Bearer secret_mock") return json({ object: "error", status: 401, code: "unauthorized" }, 401);
      const now = new Date().toISOString();
      if (path === "/v1/users/me") return json({ bot: { workspace_name: "Opale (mock)" } });
      if (path === "/v1/search") return json({ results: [notionPage(NOTION_PAGE, "Spec KYC Italie", now)], has_more: false, next_cursor: null });
      if (path.startsWith("/v1/pages/")) return json(notionPage(NOTION_PAGE, "Spec KYC Italie", now));
      if (path.includes("/children"))
        return json({
          results: [
            { id: "b1", type: "heading_2", has_children: false, heading_2: { rich_text: [{ plain_text: "Décision" }] } },
            { id: "b2", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "Valider le codice fiscale avant J+2. Contact: marco.rossi@example.it" }] } },
          ],
          has_more: false,
          next_cursor: null,
        });
      return json({}, 404);
    }

    if (url.pathname.startsWith("/anthropic/")) {
      const body = JSON.parse(raw || "{}");
      claudeCalls.push({ url: url.href, headers: req.headers, body });
      const text = "## À traiter aujourd'hui\n- Valider le codice fiscale [Notion: Spec KYC Italie]";
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(sse(text));
      }
      return json({ id: "msg_mock", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    }

    if (url.pathname.startsWith("/gmail/")) return json({ error: "not configured" }, 401);

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(MOCK);
  });
  return new Promise((resolve) => server.listen(47123, "127.0.0.1", () => resolve(server)));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("mockNlm") || "{}"));
const waitFor = async (fn, ms = 20_000, step = 250) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout waitFor");
    await new Promise((r) => setTimeout(r, step));
  }
};

// ─── Scénarios ────────────────────────────────────────────────────────────────

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
});
const errors = [];
let server;
try {
  server = await startMockServer();
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const extId = sw.url().split("/")[2];
  const options = await ctx.newPage();
  options.on("pageerror", (e) => errors.push(`options: ${e.message}`));
  await options.goto(`chrome-extension://${extId}/options.html`);
  const send = (msg) => options.evaluate((m) => chrome.runtime.sendMessage(m), msg);

  const home = await ctx.newPage();
  home.on("pageerror", (e) => errors.push(`home: ${e.message}`));
  console.log("E2E Notebooker");

  await test("organiseur : panneau injecté + notebooks détectés sans <a href> (cartes project-button)", async () => {
    await home.goto(`${NLM}/`);
    await home.waitForSelector("#notebooker-organizer", { state: "attached" });
    await waitFor(async () => (await home.locator(".notebooker-badge").count()) === 4);
    const known = await waitFor(async () => (await sw.evaluate(() => chrome.storage.local.get("knownNotebooks"))).knownNotebooks?.length === 4 && (await sw.evaluate(() => chrome.storage.local.get("knownNotebooks"))));
    assert.deepEqual(known.knownNotebooks.map((n) => n.title).sort(), ["Créer une holding", "KYC Belgique", "Roadmap Q1", "Veille ELTIF"]);
  });

  await test("organiseur : création de dossier via popover + classement + filtre", async () => {
    const panel = home.locator("#notebooker-organizer");
    await panel.locator("button.add").click();
    await panel.locator(".pop input[name=name]").fill("Conformité");
    await panel.locator(".pop button.primary").click();
    await waitFor(() => panel.locator("li", { hasText: "Conformité" }).count());
    // Menu « ⋯ » de la carte KYC Belgique → dossier Conformité
    const card = home.locator("project-button", { hasText: "KYC Belgique" });
    await card.locator(".notebooker-badge button", { hasText: "⋯" }).click();
    await panel.locator(".pop [data-folder]", { hasText: "Conformité" }).click();
    await waitFor(() => card.locator(".notebooker-badge button", { hasText: "Conformité" }).count());
    assert.equal(home.url(), `${NLM}/`, "le clic sur le badge ne doit pas ouvrir le notebook");
    await panel.locator("li", { hasText: "Conformité" }).click();
    await waitFor(async () => (await home.locator("project-button:visible").count()) === 1);
    await panel.locator("li", { hasText: "Tous" }).click();
    await waitFor(async () => (await home.locator("project-button:visible").count()) === 4);
  });

  await test("organiseur : tags + épingle + recherche (focus conservé malgré les mutations DOM)", async () => {
    const panel = home.locator("#notebooker-organizer");
    const card = home.locator("project-button", { hasText: "Veille ELTIF" });
    await card.locator(".notebooker-badge button", { hasText: "⋯" }).click();
    await panel.locator(".pop form[data-tags] input").fill("#veille, réglementaire,veille");
    await panel.locator(".pop form[data-tags] input").press("Enter");
    await waitFor(() => panel.locator("button.tag", { hasText: "#réglementaire" }).count());
    const meta = await sw.evaluate(() => chrome.storage.sync.get("nb:99999999-8888-7777-6666-555555555555"));
    assert.deepEqual(meta["nb:99999999-8888-7777-6666-555555555555"].tags, ["veille", "réglementaire"], "tags dédoublonnés, # retiré");

    await card.locator(".notebooker-badge button", { hasText: "⋯" }).click();
    await panel.locator(".pop [data-pin]").click();
    await waitFor(async () => (await card.evaluate((e) => e.style.order)) === "-1");

    const search = panel.locator("input.search");
    await search.click();
    await search.pressSequentially("road", { delay: 30 });
    // Mutation DOM côté NotebookLM pendant la saisie : ne doit pas recréer le champ
    await home.evaluate(() => document.body.appendChild(document.createElement("div")));
    await new Promise((r) => setTimeout(r, 600));
    await search.pressSequentially("map", { delay: 30 });
    assert.equal(await search.inputValue(), "roadmap");
    assert.equal(await home.evaluate(() => document.getElementById("notebooker-organizer").shadowRoot.activeElement?.className), "search");
    await waitFor(async () => (await home.locator("project-button:visible").count()) === 1);
    await search.fill("");
    await search.dispatchEvent("input");
    await waitFor(async () => (await home.locator("project-button:visible").count()) === 4);
  });

  await test("organiseur : glisser-déposer d'une carte vers un dossier", async () => {
    const panel = home.locator("#notebooker-organizer");
    await home.locator("project-button", { hasText: "Roadmap Q1" }).dragTo(panel.locator("li", { hasText: "Conformité" }));
    await waitFor(async () => {
      const m = await sw.evaluate(() => chrome.storage.sync.get("nb:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
      return m["nb:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]?.folderId;
    });
  });

  await test("driver : ajout d'une URL et d'une vidéo YouTube à un notebook existant", async () => {
    const target = { kind: "notebooklm", notebookId: "11111111-2222-3333-4444-555555555555", label: "KYC Belgique" };
    await send({ type: "addCurrentPage", url: "https://www.cssf.lu/fr/circulaire-12-02/", title: "CSSF 12/02", target, refreshMinutes: 0 });
    await send({ type: "addCurrentPage", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Vidéo", target, refreshMinutes: 0 });
    await waitFor(async () => {
      await home.reload();
      const nb = (await mockState(home)).notebooks.find((n) => n.id === target.notebookId);
      return nb.sources.length === 2 ? nb : null;
    }, 40_000, 1000).then((nb) => {
      assert.deepEqual(nb.sources.map((s) => s.kind), ["web", "yt"], "YouTube doit passer par la puce YouTube");
    });
    // L'état de l'abonnement est écrit après la fermeture de l'onglet d'automatisation
    const subs = await waitFor(async () => {
      const list = (await sw.evaluate(() => chrome.storage.local.get("subscriptions"))).subscriptions;
      return list.length === 2 && list.every((x) => x.lastCheckedAt) ? list : null;
    }, 15_000);
    assert.equal(subs.length, 2);
    assert.ok(
      subs.every((s) => s.lastError === null && s.lastFingerprint === "once"),
      JSON.stringify(subs.map(({ ref, lastError, lastFingerprint, refreshMinutes }) => ({ ref, lastError, lastFingerprint, refreshMinutes }))),
    );
  });

  await test("sync : ré-ajout de la même URL → pas de doublon (abonnement réutilisé)", async () => {
    const target = { kind: "notebooklm", notebookId: "11111111-2222-3333-4444-555555555555", label: "KYC Belgique" };
    await send({ type: "addCurrentPage", url: "https://www.cssf.lu/fr/circulaire-12-02/", title: "CSSF 12/02", target, refreshMinutes: 0 });
    await new Promise((r) => setTimeout(r, 1500));
    const subs = (await sw.evaluate(() => chrome.storage.local.get("subscriptions"))).subscriptions;
    assert.equal(subs.length, 2);
    const nb = (await mockState(home)).notebooks.find((n) => n.id === target.notebookId);
    assert.equal(nb.sources.length, 2);
  });

  await test("sync : flux RSS → nouveaux items poussés une seule fois", async () => {
    const target = { kind: "notebooklm", notebookId: "99999999-8888-7777-6666-555555555555", label: "Veille ELTIF" };
    await sw.evaluate(async (t) => {
      const { subscriptions = [] } = await chrome.storage.local.get("subscriptions");
      subscriptions.push({ id: "feed1", kind: "feed", ref: "http://127.0.0.1:47123/feed.xml", title: "Veille", target: t, refreshMinutes: 60, lastCheckedAt: null, lastFingerprint: null, seenItemIds: [], enabled: true, lastError: null });
      await chrome.storage.local.set({ subscriptions });
    }, target);
    const r1 = await send({ type: "refreshSubscriptionsNow" });
    assert.ok(r1.ok, r1.error);
    const r2 = await send({ type: "refreshSubscriptionsNow" });
    assert.ok(r2.ok, r2.error);
    const nb = (await mockState(home)).notebooks.find((n) => n.id === target.notebookId);
    assert.deepEqual(nb.sources.map((s) => s.value), ["https://example.com/a", "https://example.com/b"]);
    const feed = (await sw.evaluate(() => chrome.storage.local.get("subscriptions"))).subscriptions.find((s) => s.id === "feed1");
    assert.deepEqual(feed.seenItemIds.sort(), ["a", "b"]);
  });

  await test("brief : Notion (masquage PII) + synthèse Claude (OAuth) → notebook + sources + Audio Overview", async () => {
    await sw.evaluate(async () => {
      const { settings = {} } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({
        settings: {
          ...settings,
          briefing: { ...(settings.briefing ?? {}), enabled: false, retentionDays: 0 },
          notion: { personal: { label: "Notion perso", token: "", briefingRootIds: [] }, company: { label: "Notion entreprise", token: "secret_mock", briefingRootIds: [] } },
          claude: { enabled: true, authMode: "oauth_token", oauthToken: "oat_mock", apiKey: "", model: "claude-opus-5-5", redactPII: true, redactAmounts: false },
        },
      });
    });
    const beforeState = await mockState(home);
    const before = beforeState.notebooks.length;
    const r = await send({ type: "runBriefingNow" });
    assert.ok(r.ok, r.error);
    const run = r.data;
    assert.equal(run.status, "partial", `Gmail non configuré en test → partial attendu. Steps: ${JSON.stringify(run.steps)}`);
    assert.ok(run.steps.some((x) => /Gmail non configuré/.test(x.message)), "cause Gmail explicite dans l'historique");
    assert.equal(run.sourcesCount, 2);

    const st = await mockState(home);
    assert.equal(st.notebooks.length, before + 1);
    const nb = st.notebooks.find((n) => n.id === run.notebookId);
    assert.match(nb.title, /^☀️ Brief du /);
    // Le piège « Créer une holding » ne doit pas avoir été ouvert / renommé / rempli
    const trap = st.notebooks.find((n) => n.id === "cccccccc-0000-4000-8000-000000000000");
    assert.equal(trap.title, "Créer une holding");
    assert.equal(trap.sources.length, 0);
    const tracked = (await sw.evaluate(() => chrome.storage.local.get("briefNotebooks"))).briefNotebooks;
    assert.deepEqual(tracked.map((x) => x.id), [run.notebookId], "seul le notebook créé est tracé pour la rétention");
    const tabs = await sw.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/notebook/*" }));
    assert.equal(tabs.length, 0, "onglet d'automatisation refermé");
    assert.deepEqual(nb.sources.map((s) => s.kind), ["text", "text"]);
    assert.match(nb.sources[0].title, /^Brief synthétisé/);
    assert.match(nb.sources[1].value, /Valider le codice fiscale/);
    assert.ok(!nb.sources[1].value.includes("marco.rossi@example.it"), "email masqué dans la source NotebookLM");
    assert.ok(nb.audio, "Audio Overview lancé");
    assert.match(nb.audio.instructions, /Podcast en français/);

    // Requête Claude réellement émise par le SDK dans le service worker
    assert.equal(claudeCalls.length, 1);
    const c = claudeCalls[0];
    assert.equal(c.headers.authorization, "Bearer oat_mock");
    assert.equal(c.headers["x-api-key"], undefined);
    assert.match(c.headers["anthropic-beta"], /oauth-2025-04-20/);
    assert.match(c.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
    assert.equal(c.headers["anthropic-dangerous-direct-browser-access"], "true");
    assert.equal(c.body.model, "claude-opus-5-5");
    assert.equal(c.body.fallbacks, "default");
    assert.equal(c.body.stream, true);
    const sent = JSON.stringify(c.body.messages);
    assert.ok(!sent.includes("marco.rossi@example.it") && sent.includes("[EMAIL]"), "PII masquée avant envoi à Claude");
    assert.ok(notionCalls.every((n) => n.headers.authorization === "Bearer secret_mock" && n.headers["notion-version"] === "2022-06-28"));
  });

  await test("brief : verrou → un second lancement concurrent est ignoré", async () => {
    await sw.evaluate(() => chrome.storage.local.set({ briefingLock: Date.now() }));
    const r = await send({ type: "runBriefingNow" });
    assert.ok(r.ok);
    assert.match(r.data.skipped, /déjà en cours/);
    await sw.evaluate(() => chrome.storage.local.remove("briefingLock"));
  });

  await test("driver : statut audio generating → ready", async () => {
    const st = await mockState(home);
    const id = st.notebooks[0].id;
    await home.goto(`${NLM}/notebook/${id}`);
    const status = (cmd) =>
      sw.evaluate(async (c) => {
        const [t] = await chrome.tabs.query({ url: "http://127.0.0.1/notebook/*" });
        return chrome.tabs.sendMessage(t.id, { __driver: c });
      }, cmd);
    let last;
    await waitFor(async () => (last = await status({ cmd: "audioStatus" }))?.data === "ready", 10_000, 500).catch(async (e) => {
      throw new Error(`${e.message} — dernier statut : ${JSON.stringify(last)} ; audio mock : ${JSON.stringify((await mockState(home)).notebooks.find((n) => n.id === id)?.audio)} ; html : ${(await home.locator(".audio-card").innerHTML().catch(() => "?")).slice(0, 300)}`);
    });
  });

  await test("driver : suppression d'un notebook (menu ⋮ → Delete → confirmation)", async () => {
    await home.goto(`${NLM}/`);
    await home.waitForSelector("project-button");
    const st = await mockState(home);
    const victim = st.notebooks.find((n) => n.title.startsWith("☀️"));
    const r = await sw.evaluate(async (id) => {
      const [t] = await chrome.tabs.query({ url: "http://127.0.0.1/" });
      return chrome.tabs.sendMessage(t.id, { __driver: { cmd: "deleteNotebook", notebookId: id } });
    }, victim.id);
    assert.ok(r.ok, r.error);
    const after = await mockState(home);
    assert.ok(!after.notebooks.some((n) => n.id === victim.id));
    assert.equal(after.notebooks.length, st.notebooks.length - 1, "un seul notebook supprimé");
  });

  await test("options : tests de connexion Notion / Claude + enregistrement planifie le brief", async () => {
    await options.reload();
    await options.click("[data-test=notion-company]");
    await waitFor(async () => /Opale \(mock\)/.test(await options.textContent("#msg")));
    await options.click("[data-test=claude]");
    await waitFor(async () => /✅|❌/.test(await options.textContent("#msg")));
    assert.match(await options.textContent("#msg"), /✅/);
    await options.check("#b_enabled");
    await options.click("#save");
    await waitFor(async () => /Prochain brief/.test(await options.textContent("#msg")));
    const alarm = await sw.evaluate(() => chrome.alarms.get("briefing"));
    assert.ok(alarm && alarm.scheduledTime > Date.now());
  });

  await test("sécurité : depuis le monde isolé du content script, ni brief ni lecture des tokens", async () => {
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    const contexts = [];
    cdp.on("Runtime.executionContextCreated", (e) => contexts.push(e.context));
    await cdp.send("Runtime.enable");
    await page.goto(`${NLM}/`);
    await page.waitForSelector("project-button");
    const isolated = await waitFor(() => contexts.find((c) => c.auxData?.type === "isolated" && c.origin?.startsWith("chrome-extension://")) ?? contexts.find((c) => /Notebooker/.test(c.name)), 10_000);
    const evalIn = async (expression) =>
      (await cdp.send("Runtime.evaluate", { expression, contextId: isolated.id, awaitPromise: true, returnByValue: true })).result.value;

    const runsBefore = ((await sw.evaluate(() => chrome.storage.local.get("briefingRuns"))).briefingRuns ?? []).length;
    const brief = await evalIn(`chrome.runtime.sendMessage({ type: "runBriefingNow" })`);
    assert.deepEqual(brief, { ok: false, error: "forbidden" });
    const settings = await evalIn(`chrome.storage.local.get("settings").then((x) => JSON.stringify(x)).catch((e) => "DENIED: " + e.message)`);
    assert.match(String(settings), /DENIED/, `storage.local lisible depuis le content script : ${String(settings).slice(0, 80)}`);
    // Contrôle positif : le seul message autorisé passe, et storage.sync (organisation) reste lisible
    const seen = await evalIn(`chrome.runtime.sendMessage({ type: "notebooksSeen", notebooks: [] }).then((r) => r.ok)`);
    assert.equal(seen, true);
    assert.equal(await evalIn(`chrome.storage.sync.get("folders").then(() => "ok")`), "ok");
    const runsAfter = ((await sw.evaluate(() => chrome.storage.local.get("briefingRuns"))).briefingRuns ?? []).length;
    assert.equal(runsAfter, runsBefore, "aucun brief déclenché");
    await page.close();
  });

  await test("aucune erreur JS dans les pages", async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await ctx.close();
  server?.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scénarios OK`);
process.exit(failed ? 1 : 0);
