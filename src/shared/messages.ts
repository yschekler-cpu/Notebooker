import type { SourcePayload, Target } from "./types";

/** Commandes envoyées par le service worker au content script NotebookLM (driver UI). */
export type DriverCommand =
  | { cmd: "ping" }
  | { cmd: "listNotebooks" }
  | { cmd: "createNotebook"; title: string; knownIds: string[] }
  | { cmd: "renameNotebook"; title: string }
  | { cmd: "addSource"; source: SourcePayload }
  | { cmd: "generateAudio"; audio: import("./types").AudioOptions }
  | { cmd: "audioStatus" }
  | { cmd: "deleteNotebook"; notebookId: string };

export type DriverResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** Messages popup/options/content → service worker. */
export type BackgroundRequest =
  | { type: "addCurrentPage"; url: string; title: string; target: Target; refreshMinutes: number }
  | { type: "runBriefingNow"; profileId?: string }
  | { type: "refreshSubscriptionsNow" }
  | { type: "listNotebooks" }
  | { type: "notebooksSeen"; notebooks: { id: string; title: string }[] }
  | { type: "rescheduleBriefing" }
  | { type: "testNotion"; workspace: "personal" | "company" }
  | { type: "testGmail" }
  | { type: "testClaude" }
  | { type: "testCalendar" }
  | { type: "inspectBacklog" }
  /** Actions : envoi au backlog (avec corrections éventuelles) ou rejet. */
  | { type: "actionsOp"; op: "push"; ids: string[]; edits?: Record<string, { title?: string; due?: string; priority?: "haute" | "moyenne" | "basse" }> }
  | { type: "actionsOp"; op: "dismiss"; ids: string[] }
  /** Toute écriture d'abonnement depuis l'UI passe par le SW (mutex unique, pas d'écrasement). */
  | { type: "subscriptionOp"; op: "delete" | "toggle"; id: string }
  | { type: "subscriptionOp"; op: "add"; sub: import("./types").Subscription };

export interface NotebookSummary {
  id: string;
  title: string;
}
