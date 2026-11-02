// ─── Organisation des notebooks ────────────────────────────────────────────────

export interface Folder {
  id: string;
  name: string;
  color: string;
  order: number;
}

/** Métadonnées locales associées à un notebook NotebookLM (identifié par l'UUID de son URL). */
export interface NotebookMeta {
  notebookId: string;
  title: string;
  folderId: string | null;
  tags: string[];
  pinned: boolean;
  lastSeenAt: string;
}

// ─── Cibles & abonnements de sources ──────────────────────────────────────────

export type Target =
  | { kind: "notebooklm"; notebookId: string; label: string }
  | { kind: "notion_database"; databaseId: string; workspace: NotionWorkspaceKey; label: string };

export type SubscriptionKind =
  /** URL unique (article, vidéo YouTube) — ajoutée une fois, ré-ajoutée si le contenu change. */
  | "url"
  /** Flux RSS/Atom (blogs, chaînes YouTube via feeds/videos.xml) — chaque nouvel item est ajouté. */
  | "feed"
  /** Page Notion — re-synchronisée quand last_edited_time change. */
  | "notion_page"
  /** Base Notion — chaque page nouvelle/modifiée est poussée. */
  | "notion_database";

export interface Subscription {
  id: string;
  kind: SubscriptionKind;
  /** URL, URL de flux ou ID Notion selon `kind`. */
  ref: string;
  title: string;
  workspace?: NotionWorkspaceKey;
  target: Target;
  /** Fréquence de rafraîchissement en minutes (0 = ajout unique). */
  refreshMinutes: number;
  lastCheckedAt: string | null;
  /** Empreinte du dernier contenu poussé (hash, last_edited_time…) pour la détection de changement. */
  lastFingerprint: string | null;
  /** Items déjà poussés (flux / bases) — bornés pour limiter l'usage du storage. */
  seenItemIds: string[];
  enabled: boolean;
  lastError: string | null;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export type NotionWorkspaceKey = "personal" | "company";

export interface NotionWorkspaceConfig {
  label: string;
  token: string;
  /** Bases/pages à scanner pour le brief (vide = recherche globale des pages modifiées). */
  briefingRootIds: string[];
}

export type ClaudeAuthMode = "api_key" | "oauth_token";

export interface Settings {
  briefing: {
    enabled: boolean;
    /** Heure locale HH:MM. */
    time: string;
    weekdaysOnly: boolean;
    lookbackHours: number;
    gmailQuery: string;
    gmailMaxMessages: number;
    /** Expéditeurs / domaines / labels exclus (ex. dotfile.com, label:kyc). */
    gmailExclusions: string[];
    notebookTitleTemplate: string;
    audioInstructions: string;
    /** Supprime le notebook de brief de J-N (0 = conserver). */
    retentionDays: number;
  };
  notion: Record<NotionWorkspaceKey, NotionWorkspaceConfig>;
  claude: {
    enabled: boolean;
    authMode: ClaudeAuthMode;
    apiKey: string;
    oauthToken: string;
    model: string;
    /** Masquage PII avant envoi (emails, IBAN, téléphones, montants…). */
    redactPII: boolean;
    redactAmounts: boolean;
  };
  notebooklm: {
    /** Index de compte Google (/u/N/) si plusieurs comptes sont connectés. */
    accountIndex: number;
    /** Ouvre les onglets d'automatisation en arrière-plan. */
    backgroundTabs: boolean;
  };
}

export interface BriefingRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "partial" | "error";
  notebookId: string | null;
  sourcesCount: number;
  steps: { at: string; message: string; level: "info" | "warn" | "error" }[];
}

/** Contenu normalisé prêt à être poussé comme source. */
export interface SourcePayload {
  type: "url" | "text";
  title: string;
  url?: string;
  text?: string;
}
