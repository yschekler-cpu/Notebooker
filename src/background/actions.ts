import { getActions, getSettings, mutateActions, uid } from "../shared/storage";
import type { ActionItem, ActionPriority, Settings } from "../shared/types";
import type { ExtractedAction } from "./claude";
import { NotionClient, type DbSchema } from "./notion";

/**
 * Actions extraites du brief → file de validation (options) → backlog Notion.
 * Rien n'est écrit dans Notion sans validation explicite de l'utilisateur.
 */

const DEDUPE_DAYS = 14;

/** Clé de dédoublonnage : titre normalisé (casse, accents, ponctuation, masques). */
export function actionKey(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\[[a-z]+\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Ajoute les nouvelles actions en « pending », sans re-proposer celles déjà vues (quel que soit leur statut). */
export async function enqueueActions(extracted: ExtractedAction[], profileId: string, runId: string, now = new Date()): Promise<ActionItem[]> {
  const added: ActionItem[] = [];
  await mutateActions((items) => {
    const horizon = now.getTime() - DEDUPE_DAYS * 86_400_000;
    const known = new Set(items.filter((i) => new Date(i.createdAt).getTime() >= horizon).map((i) => i.key));
    for (const a of extracted) {
      const key = actionKey(a.title);
      if (!key || known.has(key)) continue;
      known.add(key);
      added.push({ id: uid(), key, profileId, runId, createdAt: now.toISOString(), ...a, status: "pending" });
    }
    return [...added, ...items];
  });
  return added;
}

// ─── Mapping vers la base Notion ──────────────────────────────────────────────

export interface BacklogMapping {
  title: string;
  due?: string;
  priority?: { name: string; type: "select" | "status"; options: string[] };
  status?: { name: string; type: "select" | "status"; options: string[] };
  source?: string;
}

/** Nom sans accents ni casse : « Échéance », « Priorité », « État » doivent matcher comme leurs variantes. */
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const find = (schema: DbSchema, types: string[], re: RegExp): [string, { type: string; options: string[] }] | undefined =>
  Object.entries(schema.properties).find(([name, p]) => types.includes(p.type) && re.test(fold(name)));

/** Détection automatique des propriétés du backlog d'après leurs noms et types (FR/EN). */
export function detectMapping(schema: DbSchema): BacklogMapping {
  const title = Object.entries(schema.properties).find(([, p]) => p.type === "title")?.[0];
  if (!title) throw new Error("La base Notion n'a pas de propriété titre.");
  // Ordre de préférence : une propriété nommée « échéance / due » prime sur une simple « date ».
  const due = (find(schema, ["date"], /echeance|due|deadline|date limite|livraison/) ?? find(schema, ["date"], /date/))?.[0];
  const prio = find(schema, ["select", "status"], /priorit/);
  const status = find(schema, ["status", "select"], /statut|status|etat|stage|colonne/);
  const source = find(schema, ["rich_text", "url"], /source|origine|lien|context/)?.[0];
  return {
    title,
    due,
    priority: prio ? { name: prio[0], type: prio[1].type as "select" | "status", options: prio[1].options } : undefined,
    status: status && status[0] !== prio?.[0] ? { name: status[0], type: status[1].type as "select" | "status", options: status[1].options } : undefined,
    source,
  };
}

const PRIORITY_ALIASES: Record<ActionPriority, RegExp> = {
  haute: /haut|high|urgent|\bp[01]\b|critique|critical|🔴/,
  moyenne: /moyen|medium|normal|\bp2\b|🟠|🟡/,
  basse: /\bbas|low|\bp[34]\b|faible|🟢/,
};

export function pickOption(options: string[], wanted: string | RegExp): string | undefined {
  if (typeof wanted === "string") return options.find((o) => fold(o.trim()) === fold(wanted.trim()));
  return options.find((o) => wanted.test(fold(o)));
}

/** Propriétés Notion de la page à créer. Une valeur sans option correspondante est omise (jamais d'option inventée). */
export function buildProperties(m: BacklogMapping, a: Pick<ActionItem, "title" | "due" | "priority" | "source">, defaultStatus: string): Record<string, unknown> {
  const props: Record<string, unknown> = { [m.title]: { title: [{ text: { content: a.title.slice(0, 2000) } }] } };
  if (m.due && a.due) props[m.due] = { date: { start: a.due } };
  if (m.priority) {
    const opt = pickOption(m.priority.options, PRIORITY_ALIASES[a.priority]);
    if (opt) props[m.priority.name] = { [m.priority.type]: { name: opt } };
  }
  if (m.status && defaultStatus) {
    const opt = pickOption(m.status.options, defaultStatus);
    if (opt) props[m.status.name] = { [m.status.type]: { name: opt } };
  }
  if (m.source && a.source) props[m.source] = { rich_text: [{ text: { content: a.source.slice(0, 2000) } }] };
  return props;
}

function para(text: string) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: text.slice(0, 2000) } }] } };
}

export async function inspectBacklog(settings: Settings): Promise<{ title: string; mapping: BacklogMapping; warnings: string[] }> {
  const { workspace, databaseId, defaultStatus } = settings.backlog;
  if (!databaseId.trim()) throw new Error("Aucune base backlog configurée.");
  const notion = new NotionClient(settings.notion[workspace]);
  if (!notion.configured) throw new Error(`Token Notion manquant (${settings.notion[workspace].label}).`);
  const schema = await notion.databaseSchema(databaseId);
  const mapping = detectMapping(schema);
  const warnings: string[] = [];
  if (!mapping.due) warnings.push("Pas de propriété date détectée : l'échéance sera mise dans le corps de la page.");
  if (!mapping.priority) warnings.push("Pas de propriété « Priorité » détectée.");
  if (defaultStatus && !mapping.status) warnings.push("Statut par défaut défini mais aucune propriété statut détectée.");
  if (defaultStatus && mapping.status && !pickOption(mapping.status.options, defaultStatus)) {
    warnings.push(`Le statut « ${defaultStatus} » n'existe pas dans « ${mapping.status.name} » (${mapping.status.options.join(", ")}).`);
  }
  return { title: schema.title, mapping, warnings };
}

/** Pousse les actions validées (avec éventuelles corrections de titre / échéance / priorité). */
export async function pushActions(
  ids: string[],
  edits: Record<string, Partial<Pick<ActionItem, "title" | "due" | "priority">>> = {},
): Promise<{ sent: number; errors: string[] }> {
  const settings = await getSettings();
  const { mapping } = await inspectBacklog(settings);
  const notion = new NotionClient(settings.notion[settings.backlog.workspace]);
  const pending = (await getActions()).filter((a) => ids.includes(a.id) && (a.status === "pending" || a.status === "error"));
  let sent = 0;
  const errors: string[] = [];
  for (const item of pending) {
    const a = { ...item, ...sanitizeEdit(edits[item.id]) };
    try {
      const page = await notion.createPage(settings.backlog.databaseId, buildProperties(mapping, a, settings.backlog.defaultStatus), [
        para(a.context || "(sans contexte)"),
        para(`Source : ${a.source || "—"}${a.requester ? ` · Demandé par : ${a.requester}` : ""}${!mapping.due && a.due ? ` · Échéance : ${a.due}` : ""}`),
        para(`Créé par Notebooker depuis le brief du ${new Date(a.createdAt).toLocaleDateString("fr-FR")}, après validation.`),
      ]);
      await mutateActions((items) => items.map((x) => (x.id === a.id ? { ...a, status: "sent", notionPageId: page.id, error: undefined } : x)));
      sent++;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      errors.push(`${a.title}: ${error}`);
      await mutateActions((items) => items.map((x) => (x.id === a.id ? { ...x, status: "error", error } : x)));
    }
  }
  return { sent, errors };
}

function sanitizeEdit(e?: Partial<Pick<ActionItem, "title" | "due" | "priority">>): Partial<ActionItem> {
  if (!e) return {};
  const out: Partial<ActionItem> = {};
  if (typeof e.title === "string" && e.title.trim()) out.title = e.title.trim().slice(0, 200);
  if (typeof e.due === "string" && (e.due === "" || /^\d{4}-\d{2}-\d{2}$/.test(e.due))) out.due = e.due;
  if (e.priority === "haute" || e.priority === "moyenne" || e.priority === "basse") out.priority = e.priority;
  return out;
}

export async function dismissActions(ids: string[]): Promise<void> {
  await mutateActions((items) => items.map((x) => (ids.includes(x.id) && x.status !== "sent" ? { ...x, status: "dismissed" } : x)));
}
