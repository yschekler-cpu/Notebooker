/**
 * Tests E2E : extension chargée dans Chromium + faux NotebookLM (tests/e2e/mock-notebooklm.html)
 * + API Notion / Anthropic interceptées. Lancer : `npm run build && npm run e2e`.
 * Prérequis local : `npx playwright install chromium` (Playwright non listé en dépendance).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
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
const googleCalls = [];
const oauthCalls = [];
const backlogPages = [];
const BACKLOG_DB = "fedcba9876543210fedcba9876543210";
const MAILS = [
  { id: "m1", threadId: "t-kyc", from: "Marco Rossi <marco.rossi@example.it>", subject: "RE: Codice fiscale Italie", body: "Peux-tu valider le codice fiscale avant J+2 ? IBAN IT60 X054 2811 1010 0000 0123 456" },
  { id: "m2", threadId: "t-news", from: "newsletter@fintech.example", subject: "Weekly fintech", body: "Les news de la semaine." },
];

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
      // OAuth Notion : page d'autorisation (redirige vers l'extension) + échange / révocation de jeton
      if (path === "/v1/oauth/authorize") {
        const redirect = url.searchParams.get("redirect_uri");
        oauthCalls.push({ step: "authorize", params: Object.fromEntries(url.searchParams) });
        res.writeHead(302, { location: `${redirect}?code=code_mock&state=${encodeURIComponent(url.searchParams.get("state"))}` });
        return res.end();
      }
      if (path === "/v1/oauth/token" || path === "/v1/oauth/revoke") {
        oauthCalls.push({ step: path.endsWith("token") ? "token" : "revoke", auth: req.headers.authorization, body: JSON.parse(raw || "{}"), version: req.headers["notion-version"] });
        if (req.headers.authorization !== `Basic ${Buffer.from("cid_mock:secret_client_mock").toString("base64")}`) return json({ error: "invalid_client" }, 401);
        return path.endsWith("token")
          ? json({ access_token: "oauth_at_mock", refresh_token: "oauth_rt_mock", bot_id: "bot", workspace_id: "w", workspace_name: "Opale OAuth" })
          : json({ request_id: "r" });
      }
      if (req.headers.authorization !== "Bearer secret_mock" && req.headers.authorization !== "Bearer oauth_at_mock") return json({ object: "error", status: 401, code: "unauthorized" }, 401);
      const now = new Date().toISOString();
      if (path === "/v1/users/me") return json({ bot: { workspace_name: "Opale (mock)" } });
      if (path === "/v1/search") return json({ results: [notionPage(NOTION_PAGE, "Spec KYC Italie", now)], has_more: false, next_cursor: null });
      if (path.startsWith("/v1/pages/")) return json(notionPage(NOTION_PAGE, "Spec KYC Italie", now));
      if (path === `/v1/databases/${BACKLOG_DB}` && req.method === "GET")
        return json({
          title: [{ plain_text: "Backlog produit" }],
          properties: {
            Nom: { type: "title" },
            Échéance: { type: "date" },
            Priorité: { type: "select", select: { options: [{ name: "P1 - Haute" }, { name: "P2 - Moyenne" }, { name: "P3 - Basse" }] } },
            Statut: { type: "status", status: { options: [{ name: "À trier" }, { name: "En cours" }] } },
          },
        });
      if (path === "/v1/pages" && req.method === "POST") {
        const body = JSON.parse(raw || "{}");
        backlogPages.push(body);
        return json({ id: `page-${backlogPages.length}`, url: `https://www.notion.so/page-${backlogPages.length}` });
      }
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
      const isActions = !!body.output_config?.format;
      const text = isActions
        ? JSON.stringify({ actions: [{ title: "Valider le codice fiscale avant J+2", requester: "Marco Rossi", due: "2026-11-05", priority: "haute", source: "[Mail: Codice fiscale]", context: "Bloquant pour l'ouverture Italie." }] })
        : "## À traiter aujourd'hui\n- Valider le codice fiscale [Notion: Spec KYC Italie]";
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(sse(text));
      }
      return json({ id: "msg_mock", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    }

    if (url.pathname.startsWith("/gmail/")) {
      googleCalls.push({ path: url.pathname, query: url.searchParams.get("q"), auth: req.headers.authorization });
      if (url.pathname.endsWith("/messages")) return json({ messages: MAILS.map((m) => ({ id: m.id, threadId: m.threadId })) });
      const m = MAILS.find((x) => url.pathname.endsWith(`/messages/${x.id}`));
      if (!m) return json({}, 404);
      return json({
        id: m.id, threadId: m.threadId, snippet: m.body.slice(0, 80), internalDate: String(Date.now() - 3600_000), labelIds: ["INBOX"],
        payload: { mimeType: "text/plain", headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }], body: { data: Buffer.from(m.body).toString("base64url") } },
      });
    }

    if (url.pathname.startsWith("/calendar/v3/")) {
      googleCalls.push({ path: url.pathname, auth: req.headers.authorization });
      const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
      return json({
        items: [
          { id: "ev1", summary: "Comité KYC Italie", description: "Ordre du jour : codice fiscale. Lien : https://meet.google.com/abc-defg-hij", start: { dateTime: at(23) }, end: { dateTime: at(23) },
            attendees: [{ email: "moi@opale.fr", self: true, responseStatus: "accepted" }, { email: "marco.rossi@example.it", displayName: "Marco Rossi" }] },
          { id: "ev2", summary: "Dentiste", visibility: "private", start: { dateTime: at(23) }, end: { dateTime: at(23) } },
          { id: "ev3", summary: "Réunion refusée", start: { dateTime: at(23) }, end: { dateTime: at(23) }, attendees: [{ email: "moi@opale.fr", self: true, responseStatus: "declined" }] },
        ],
      });
    }

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

/** Attend un message dans le bandeau des options ; en cas d'échec, affiche le message réel. */
async function waitMsg(page, re, ms = 20_000) {
  try {
    await waitFor(async () => re.test((await page.textContent("#msg")) ?? ""), ms);
  } catch {
    throw new Error(`message attendu ${re} — reçu : « ${await page.textContent("#msg")} »`);
  }
}

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
  const send = async (msg) => {
    if (!options.url().startsWith("chrome-extension://")) await options.goto(`chrome-extension://${extId}/options.html`);
    return options.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  };
  // La page options peut être rechargée par les scénarios : `send` passe toujours par une page d'extension vivante.

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

  await test("brief complet : Gmail + Agenda + Notion + mémoire + Claude (synthèse + actions) → notebook, audio paramétré", async () => {
    await sw.evaluate(async ({ db }) => {
      const { settings = {} } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({
        settings: {
          ...settings,
          profiles: [{
            id: "daily", name: "Brief du matin", enabled: false, schedule: { time: "07:30", days: [1, 2, 3, 4, 5] }, lookbackHours: 24,
            sources: { gmail: true, calendar: true, notionPersonal: false, notionCompany: true },
            gmailQuery: "in:inbox", gmailMaxMessages: 10, notebookTitleTemplate: "☀️ Brief du {date}",
            audio: { format: "brief", length: "short", language: "fr", instructions: "Cinq minutes, sujets urgents d'abord." },
            synthesisFocus: "", memory: true, extractActions: true, retentionDays: 0,
          }],
          compliance: { gmailExclusions: ["newsletter@fintech.example", "label:kyc"] },
          calendar: { calendarIds: ["primary"], hidePrivateEvents: true, skipDeclined: true },
          backlog: { workspace: "company", databaseId: db, defaultStatus: "À trier" },
          notion: { personal: { label: "Notion perso", token: "", briefingRootIds: [] }, company: { label: "Notion entreprise", token: "secret_mock", briefingRootIds: [] } },
          claude: { enabled: true, authMode: "oauth_token", oauthToken: "oat_mock", apiKey: "", model: "claude-opus-5-5", redactPII: true, redactAmounts: false },
        },
      });
    }, { db: BACKLOG_DB });
    const before = (await mockState(home)).notebooks.length;
    const r = await send({ type: "runBriefingNow", profileId: "daily" });
    assert.ok(r.ok, r.error);
    const run = r.data;
    assert.equal(run.status, "success", `Steps: ${JSON.stringify(run.steps.map((x) => x.message))}`);
    assert.equal(run.profileName, "Brief du matin");
    assert.equal(run.sourcesCount, 5);

    const st = await mockState(home);
    assert.equal(st.notebooks.length, before + 1);
    const nb = st.notebooks.find((n) => n.id === run.notebookId);
    assert.match(nb.title, /^☀️ Brief du /);
    assert.deepEqual(nb.sources.map((x) => x.title.split(" — ")[0]), ["Brief synthétisé", "Agenda du jour", "Suivi depuis le dernier brief", "Emails", "Notion entreprise"]);
    const [, agenda, suivi, mails, notionSrc] = nb.sources.map((x) => x.value);

    // Agenda : réunion + préparation ; privé anonymisé ; refusée ignorée ; lien visio retiré
    assert.match(agenda, /Comité KYC Italie/);
    assert.match(agenda, /À relire avant :\n- \[Mail\] RE: Codice fiscale Italie/);
    assert.match(agenda, /\[Notion\] Spec KYC Italie/);
    assert.match(agenda, /Événement privé/);
    assert.ok(!/Dentiste|Réunion refusée|meet\.google\.com/.test(agenda), agenda);
    // Mémoire : J1 → tout est nouveau
    assert.match(suivi, /Nouveaux sujets \(3\)/);
    // Masquage avant NotebookLM
    assert.ok(!/IT60|marco\.rossi@example\.it/.test(mails + agenda + notionSrc), "IBAN / emails masqués");
    assert.match(mails, /\[IBAN\]/);
    // Exclusions de conformité injectées dans la requête Gmail
    const q = googleCalls.find((g) => g.path.endsWith("/messages"))?.query ?? "";
    assert.match(q, /-from:newsletter@fintech\.example/);
    assert.match(q, /-label:kyc/);
    // Audio paramétré via la modale « Personnaliser »
    assert.equal(nb.audio.format, "brief");
    assert.equal(nb.audio.length, "short");
    assert.equal(nb.audio.language, "fr");
    assert.match(nb.audio.instructions, /Cinq minutes/);
    assert.ok(!run.steps.some((x) => /Réglages audio non appliqués/.test(x.message)), "tous les réglages audio appliqués");

    // Claude : 2 requêtes (synthèse + extraction), même préfixe en cache, extraction en json_schema
    assert.equal(claudeCalls.length, 2);
    for (const c of claudeCalls) {
      assert.equal(c.headers.authorization, "Bearer oat_mock");
      assert.match(c.headers["anthropic-beta"], /oauth-2025-04-20/);
      assert.equal(c.body.fallbacks, "default");
      const first = c.body.messages[0].content[0];
      assert.deepEqual(first.cache_control, { type: "ephemeral" });
      assert.match(first.text, /## AGENDA/);
      assert.ok(!first.text.includes("marco.rossi@example.it") && first.text.includes("[EMAIL]"), "PII masquée avant envoi à Claude");
    }
    assert.equal(claudeCalls[0].body.messages[0].content[0].text, claudeCalls[1].body.messages[0].content[0].text);
    assert.equal(claudeCalls[1].body.output_config.format.type, "json_schema");

    // Action en file de validation, rien n'est parti dans Notion
    const { actionItems } = await sw.evaluate(() => chrome.storage.local.get("actionItems"));
    assert.equal(actionItems.length, 1);
    assert.equal(actionItems[0].status, "pending");
    assert.equal(backlogPages.length, 0, "aucune écriture backlog sans validation");

    const trap = st.notebooks.find((n) => n.id === "cccccccc-0000-4000-8000-000000000000");
    assert.equal(trap.title, "Créer une holding");
    assert.equal(trap.sources.length, 0);
    const tabs = await sw.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/notebook/*" }));
    assert.equal(tabs.length, 0, "onglet d'automatisation refermé");
  });

  await test("actions : validation dans les options (titre/échéance corrigés) → page créée dans le backlog avec mapping auto", async () => {
    await options.goto("about:blank");
    await options.goto(`chrome-extension://${extId}/options.html#actions`);
    const row = options.locator("#actionsList .action");
    await row.first().waitFor();
    assert.equal(await row.count(), 1);
    assert.equal(await options.textContent("#actionsCount"), "1");
    await row.locator(".a-title").fill("Valider le codice fiscale (Italie)");
    await row.locator(".a-due").fill("2026-11-06");
    await options.click("[data-test=backlog]");
    await waitMsg(options, /Backlog produit/);
    assert.match(await options.textContent("#msg"), /échéance → « Échéance »/);
    await options.click("#actionsPush");
    await waitMsg(options, /envoyée\(s\) au backlog/, 15_000);
    assert.equal(backlogPages.length, 1);
    const p = backlogPages[0];
    assert.equal(p.parent.database_id, BACKLOG_DB);
    assert.equal(p.properties.Nom.title[0].text.content, "Valider le codice fiscale (Italie)");
    assert.equal(p.properties.Échéance.date.start, "2026-11-06");
    assert.equal(p.properties.Priorité.select.name, "P1 - Haute");
    assert.equal(p.properties.Statut.status.name, "À trier");
    await waitFor(async () => (await options.locator("#actionsList .action").count()) === 0);
  });

  await test("mémoire J+1 : sujets « toujours actifs » ; action déjà traitée non re-proposée", async () => {
    // Simule le passage d'un jour : la mémoire et l'historique d'actions datent d'hier.
    await sw.evaluate(async () => {
      const key = "briefMemory:daily";
      const m = (await chrome.storage.local.get(key))[key];
      const y = new Date(Date.now() - 86_400_000);
      const day = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
      for (const t of Object.values(m.topics)) { t.firstSeen = day; t.lastSeen = day; }
      m.lastBriefDate = day;
      await chrome.storage.local.set({ [key]: m });
    });
    claudeCalls.length = 0;
    const r = await send({ type: "runBriefingNow", profileId: "daily" });
    assert.ok(r.ok, r.error);
    const nb = (await mockState(home)).notebooks.find((n) => n.id === r.data.notebookId);
    const suivi = nb.sources.find((x) => x.title.startsWith("Suivi")).value;
    assert.match(suivi, /Toujours actifs \(3\)/, suivi);
    assert.match(suivi, /actif 2 jours/);
    // Le contexte mémoire est transmis à la synthèse Claude
    assert.match(claudeCalls[0].body.messages[0].content[1].text, /SUIVI DEPUIS LE DERNIER BRIEF/);
    const { actionItems } = await sw.evaluate(() => chrome.storage.local.get("actionItems"));
    assert.equal(actionItems.filter((a) => a.status === "pending").length, 0, "action déjà envoyée → pas de doublon");
  });

  await test("profils : création « Digest Comex » depuis l'UI, planification, exécution dédiée", async () => {
    await options.goto("about:blank");
    await options.goto(`chrome-extension://${extId}/options.html`);
    await options.selectOption("#p_template", "comex");
    await options.click("#p_new");
    assert.equal(await options.inputValue("#p_name"), "Digest Comex (lundi)");
    assert.equal(await options.isChecked("#p_src_gmail"), false);
    await options.check("#p_enabled");
    await options.click("#save");
    await waitMsg(options, /Digest Comex \(lundi\) :/);
    const alarms = (await sw.evaluate(() => chrome.alarms.getAll())).map((a) => a.name);
    const settings = (await sw.evaluate(() => chrome.storage.local.get("settings"))).settings;
    const comex = settings.profiles.find((p) => p.name.startsWith("Digest Comex"));
    assert.ok(alarms.includes(`briefing:${comex.id}`), `alarme dédiée : ${alarms}`);
    assert.ok(!alarms.includes("briefing:daily"), "profil inactif → pas d'alarme");
    const next = new Date((await sw.evaluate((n) => chrome.alarms.get(n), `briefing:${comex.id}`)).scheduledTime);
    assert.equal(next.getDay(), 1, "planifié un lundi");

    googleCalls.length = 0;
    const r = await send({ type: "runBriefingNow", profileId: comex.id });
    assert.ok(r.ok, r.error);
    assert.equal(r.data.profileName, "Digest Comex (lundi)");
    const nb = (await mockState(home)).notebooks.find((n) => n.id === r.data.notebookId);
    assert.ok(nb, `notebook Comex absent : ${JSON.stringify(r.data).slice(0, 600)}`);
    assert.match(nb.title, /^📊 Digest Comex/);
    assert.equal(googleCalls.length, 0, "profil Comex : ni Gmail ni Agenda");
    assert.equal(nb.audio.format, "brief");
  });

  await test("brief : verrou → un second lancement concurrent est ignoré", async () => {
    await sw.evaluate(() => chrome.storage.local.set({ "briefingLock:daily": Date.now() }));
    const r = await send({ type: "runBriefingNow", profileId: "daily" });
    assert.ok(r.ok);
    assert.match(r.data.skipped, /déjà en cours/);
    await sw.evaluate(() => chrome.storage.local.remove("briefingLock:daily"));
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
    await waitMsg(options, /Opale \(mock\)/);
    await options.click("[data-test=claude]");
    await waitMsg(options, /✅|❌/);
    assert.match(await options.textContent("#msg"), /✅/);
    await options.click("[data-test=calendar]");
    await waitMsg(options, /réunion\(s\) lisible/);
    assert.match(await options.textContent("#msg"), /2 réunion/, "privé conservé (anonymisé), refusé ignoré");
    await options.selectOption("#p_select", "daily");
    await options.check("#p_enabled");
    await options.click("#save");
    await waitMsg(options, /Brief du matin :/);
    const alarm = await sw.evaluate(() => chrome.alarms.get("briefing:daily"));
    assert.ok(alarm && alarm.scheduledTime > Date.now());
    assert.match(await options.textContent("#p_next"), /Prochain passage/);
  });

  await test("options : un onglet resté ouvert ne réécrit pas des réglages modifiés ailleurs", async () => {
    await options.goto("about:blank");
    await options.goto(`chrome-extension://${extId}/options.html`);
    await options.waitForSelector("#bl_db");
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      settings.backlog.defaultStatus = "En cours";
      await chrome.storage.local.set({ settings });
    });
    await waitFor(async () => (await options.inputValue("#bl_status")) === "En cours", 5000);
    // Formulaire modifié localement puis changement externe → avertissement, pas d'écrasement silencieux
    await options.fill("#p_name", "Brief du matin (édité)");
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      settings.backlog.defaultStatus = "À trier";
      await chrome.storage.local.set({ settings });
    });
    await waitMsg(options, /modifiés dans un autre onglet/, 5000);
    assert.equal(await options.inputValue("#p_name"), "Brief du matin (édité)", "saisie locale conservée");
  });

  await test("Notion OAuth : connexion via launchWebAuthFlow, appels API avec le jeton OAuth, déconnexion + révocation", async () => {
    await options.goto("about:blank");
    await options.goto(`chrome-extension://${extId}/options.html`);
    await options.waitForSelector("#n_c_mode");
    const redirect = await options.textContent("#n_redirect");
    assert.equal(redirect, `https://${extId}.chromiumapp.org/notion`);
    await options.selectOption("#n_c_mode", "oauth");
    assert.equal(await options.isVisible("#n_c_cid"), true);
    assert.equal(await options.isVisible("#n_c_token"), false);
    await options.fill("#n_c_cid", "cid_mock");
    await options.fill("#n_c_secret", "secret_client_mock");
    await options.click('[data-oauth="connect"][data-ws="company"]');
    await waitMsg(options, /Connecté à « Opale OAuth »/, 30_000);
    const authorize = oauthCalls.find((c) => c.step === "authorize").params;
    assert.deepEqual([authorize.client_id, authorize.response_type, authorize.owner, authorize.redirect_uri], ["cid_mock", "code", "user", redirect]);
    const token = oauthCalls.find((c) => c.step === "token");
    assert.deepEqual(token.body, { grant_type: "authorization_code", code: "code_mock", redirect_uri: redirect });
    assert.match(await options.textContent("#n_c_status"), /Connecté à « Opale OAuth »/);
    const stored = (await sw.evaluate(() => chrome.storage.local.get("settings"))).settings.notion.company;
    assert.equal(stored.authMode, "oauth");
    assert.equal(stored.oauth.accessToken, "oauth_at_mock");

    notionCalls.length = 0;
    await options.click("[data-test=notion-company]");
    await waitMsg(options, /Opale \(mock\)/);
    assert.equal(notionCalls.at(-1).headers.authorization, "Bearer oauth_at_mock", "API appelée avec le jeton OAuth");

    options.once("dialog", (d) => d.accept());
    await options.click('[data-oauth="disconnect"][data-ws="company"]');
    await waitMsg(options, /Déconnecté \(jeton révoqué/);
    const revoke = oauthCalls.find((c) => c.step === "revoke");
    assert.deepEqual(revoke.body, { token: "oauth_at_mock" });
    assert.equal(revoke.version, "2026-03-11");
    assert.match(await options.textContent("#n_c_status"), /Non connecté/);
    const after = (await sw.evaluate(() => chrome.storage.local.get("settings"))).settings.notion.company.oauth;
    assert.equal(after.accessToken, "");
    assert.equal(after.clientId, "cid_mock", "Client ID conservé pour une reconnexion");

    // Retour au mode jeton pour les scénarios suivants
    await options.selectOption("#n_c_mode", "token");
    await options.click("#save");
    await waitMsg(options, /Enregistré/);
  });

  await test("dossier local (Cowork) : J1 nouveau → J2 diff (pas de redite) → J3 rien de nouveau = pas de podcast ; dernier podcast dans la popup", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "notebooker inbox "));
    const day = (offset) => { const d = new Date(Date.now() + offset * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const writeBrief = (id, topics, withAgenda) => {
      const folder = path.join(dir, id);
      mkdirSync(folder, { recursive: true });
      if (withAgenda) writeFileSync(path.join(folder, "agenda.md"), "### 10:00–11:00 · Comité KYC Italie\nParticipants : Marco\nÀ relire : spec KYC");
      writeFileSync(path.join(dir, "latest.json"), JSON.stringify({
        format: "notebooker-brief", version: 1, id, generatedAt: new Date().toISOString(), title: `☀️ Brief Cowork ${id}`,
        topics, sources: withAgenda ? [{ title: "Agenda du jour", file: `${id}/agenda.md` }] : [],
        actions: [{ title: "Signer la note de conformité Italie", requester: "Conformité", due: "", priority: "moyenne", source: "[Mail: Note Italie]", context: "" }],
      }));
    };
    writeBrief("j1", [
      { key: "kyc-italie", title: "KYC Italie", status: "new", summary: "Le format du codice fiscale est en attente de validation par Marco.", refs: ["[Mail: Codice fiscale]"] },
      { key: "eltif", title: "ELTIF 2", status: "new", summary: "Note AMF reçue, analyse juridique en cours.", refs: [] },
    ], true);

    await options.goto("about:blank");
    await options.goto(`chrome-extension://${extId}/options.html`);
    await options.fill("#li_path", dir);
    await options.selectOption("#p_template", "cowork");
    await options.click("#p_new");
    assert.equal(await options.inputValue("#p_mode"), "localFolder");
    assert.equal(await options.isVisible("#p_src_gmail"), false, "sources connecteurs masquées en mode dossier local");
    await options.check("#p_enabled");
    await options.click("#save");
    await waitMsg(options, /Brief Cowork \(dossier local\) :/);
    assert.match(await options.textContent("#li_access"), /autorisé/);
    await options.click("[data-test=inbox]");
    await waitMsg(options, /Dépôt « j1 ».*2 sujet\(s\), 1 fichier\(s\), 1 action\(s\) — prêt à traiter/);
    const alarms = (await sw.evaluate(() => chrome.alarms.getAll())).map((a) => a.name);
    assert.ok(alarms.includes("inbox"), "surveillance du dossier planifiée");
    const profileId = (await sw.evaluate(() => chrome.storage.local.get("settings"))).settings.profiles.find((p) => p.mode === "localFolder").id;

    const runFor = async (expectNotebook) => {
      const before = ((await sw.evaluate(() => chrome.storage.local.get("briefingRuns"))).briefingRuns ?? []).filter((r) => r.profileId === profileId).length;
      const res = await send({ type: "checkInboxNow" });
      assert.ok(res.ok, res.error);
      const mine = res.data.find((x) => x.profileId === profileId);
      assert.ok(mine?.started, `surveillance : ${JSON.stringify(res.data)}`);
      return waitFor(async () => {
        const runs = ((await sw.evaluate(() => chrome.storage.local.get("briefingRuns"))).briefingRuns ?? []).filter((r) => r.profileId === profileId);
        const r = runs.length > before ? runs[0] : null;
        return r && r.status !== "running" && (!expectNotebook || r.notebookId) ? r : null;
      }, 60_000, 500);
    };

    // ── J1 : tout est nouveau
    const r1 = await runFor(true);
    assert.equal(r1.status, "success", JSON.stringify(r1.steps.map((x) => x.message)));
    let nb = (await mockState(home)).notebooks.find((n) => n.id === r1.notebookId);
    assert.equal(nb.title, "☀️ Brief Cowork j1");
    assert.deepEqual(nb.sources.map((x) => x.title.split(" — ")[0]), ["Nouveautés & mises à jour", "Agenda du jour"]);
    assert.match(nb.sources[0].value, /## 🆕 Nouveaux sujets[\s\S]*KYC Italie[\s\S]*ELTIF 2/);
    assert.match(nb.audio.instructions, /pas un récapitulatif/);
    const pending = (await sw.evaluate(() => chrome.storage.local.get("actionItems"))).actionItems.filter((a) => a.status === "pending");
    assert.ok(pending.some((a) => a.title === "Signer la note de conformité Italie"), "action du manifest en file de validation");
    // Même dépôt : jamais retraité automatiquement
    const again = (await send({ type: "checkInboxNow" })).data.find((x) => x.profileId === profileId);
    assert.equal(again.started, false);
    assert.equal(again.reason, "déjà traité");

    // ── J2 : on simule le passage d'un jour (mémoire datée d'hier)
    const shiftMemory = () => sw.evaluate(async ({ pid, y }) => {
      const key = `briefMemory:${pid}`;
      const m = (await chrome.storage.local.get(key))[key];
      for (const t of Object.values(m.topics)) { if (t.firstSeen > y) t.firstSeen = y; t.lastSeen = y; if (t.lastChanged > y) t.lastChanged = y; }
      m.lastBriefDate = y;
      await chrome.storage.local.set({ [key]: m });
    }, { pid: profileId, y: day(-1) });
    await shiftMemory();
    writeBrief("j2", [
      { key: "kyc-italie", title: "KYC Italie", status: "updated", summary: "Marco a validé le format ; reste la signature conformité avant vendredi.", refs: [] },
      // Cowork répète ELTIF à l'identique (casse / ponctuation près) : doit être détecté comme « sans nouveauté »
      { key: "eltif", title: "ELTIF 2", status: "updated", summary: "note AMF reçue — analyse juridique en cours", refs: [] },
      { key: "memo-bank", title: "Memo Bank", status: "new", summary: "Nouveau webhook de virement disponible en sandbox.", refs: [] },
    ], false);
    const r2 = await runFor(true);
    nb = (await mockState(home)).notebooks.find((n) => n.id === r2.notebookId);
    const news = nb.sources.find((x) => x.title.startsWith("Nouveautés")).value;
    const follow = nb.sources.find((x) => x.title.startsWith("Suivi des sujets ouverts")).value;
    assert.match(news, /## 🆕 Nouveaux sujets[\s\S]*Memo Bank/);
    assert.match(news, /## 🔄 Ce qui a changé[\s\S]*KYC Italie — suivi depuis le/);
    assert.ok(!/AMF/.test(news), "sujet inchangé absent des nouveautés (pas de redite)");
    assert.match(follow, /ELTIF 2 — ouvert depuis le/);
    assert.match(r2.steps.map((x) => x.message).join(" | "), /1 nouveau\(x\), 1 modifié\(s\), 1 sans nouveauté/);

    // ── J3 : tout est identique, aucun fichier → pas de podcast (aucune redite)
    await shiftMemory();
    writeBrief("j3", [
      { key: "kyc-italie", title: "KYC Italie", status: "ongoing", summary: "Marco a validé le format ; reste la signature conformité avant vendredi.", refs: [] },
      { key: "eltif", title: "ELTIF 2", status: "ongoing", summary: "Note AMF reçue, analyse juridique en cours.", refs: [] },
      { key: "memo-bank", title: "Memo Bank", status: "ongoing", summary: "Nouveau webhook de virement disponible en sandbox.", refs: [] },
    ], false);
    const notebooksBefore = (await mockState(home)).notebooks.length;
    const r3 = await runFor(false);
    assert.equal(r3.notebookId, null);
    assert.match(r3.steps.map((x) => x.message).join(" | "), /Rien de nouveau depuis le dernier brief/);
    assert.equal((await mockState(home)).notebooks.length, notebooksBefore, "aucun notebook créé");

    // ── Dernier podcast : affiché dans la popup et lisible
    await new Promise((r) => setTimeout(r, 3500)); // le mock rend l'audio prêt après ~3 s
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector("#podcastCard:not([hidden])");
    assert.equal(await popup.textContent("#podcastTitle"), "☀️ Brief Cowork j2");
    const tabsBefore = (await sw.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/notebook/*" }))).length;
    await popup.click("#podcastPlay");
    await waitFor(async () => /Lecture lancée|Notebook ouvert|pas encore prêt/.test(await popup.textContent("#status")), 30_000);
    assert.match(await popup.textContent("#status"), /Lecture lancée/);
    const tabs = await sw.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/notebook/*" }));
    assert.equal(tabs.length, tabsBefore + 1, "onglet du podcast ouvert (et conservé)");
    assert.ok(tabs.some((t) => t.url.includes(r2.notebookId)));
    await popup.close();

    // Page d'options rechargée pour les scénarios suivants (le profil Cowork reste actif : ses dépôts sont déjà traités)
    await options.goto("about:blank");
    await options.goto(`chrome-extension://${extId}/options.html`);
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
