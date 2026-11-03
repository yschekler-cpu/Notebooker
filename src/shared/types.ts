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

export interface NotionOAuthState {
  /** Fournis par l'utilisateur (connexion OAuth créée dans Notion). Jamais embarqués dans le code. */
  clientId: string;
  clientSecret: string;
  /** Renseignés par le flux OAuth. */
  accessToken: string;
  refreshToken: string;
  workspaceName: string;
  workspaceId: string;
  botId: string;
  connectedAt: string | null;
}

export interface NotionWorkspaceConfig {
  label: string;
  /** « token » = jeton d'API (connexion interne) ; « oauth » = connexion OAuth au niveau utilisateur. */
  authMode: "token" | "oauth";
  token: string;
  oauth: NotionOAuthState;
  /** Bases/pages à scanner pour le brief (vide = recherche globale des pages modifiées). */
  briefingRootIds: string[];
}

export type ClaudeAuthMode = "api_key" | "oauth_token";

// ─── Brief : profils ──────────────────────────────────────────────────────────

/** Formats proposés par NotebookLM dans « Personnaliser » l'Audio Overview. */
export type AudioFormat = "deep_dive" | "brief" | "critique" | "debate";
export type AudioLength = "short" | "default" | "long";

export interface AudioOptions {
  format: AudioFormat;
  length: AudioLength;
  /** Langue de sortie souhaitée (code BCP-47, ex. « fr », « en », « it »). */
  language: string;
  /** Consignes libres (focus des animateurs). */
  instructions: string;
}

export type CollectionMode = "connectors" | "localFolder";

export interface BriefProfile {
  id: string;
  name: string;
  enabled: boolean;
  /**
   * « connectors » : l'extension collecte elle-même (Gmail, Agenda, Notion, Claude).
   * « localFolder » : un agent externe (Claude Cowork planifié) écrit les fichiers ; l'extension
   * lit le dossier, calcule le diff jour après jour et génère le podcast. Aucun connecteur requis.
   */
  mode: CollectionMode;
  localFolder: {
    /** Manifest du profil dans le dossier (ex. latest.json, conformite.json). */
    manifestFile: string;
    /** Déclenche le brief dès qu'un nouveau manifest est déposé (en plus / à la place de l'heure fixe). */
    watch: boolean;
  };
  schedule: {
    /** Heure locale HH:MM. */
    time: string;
    /** Jours d'exécution (0 = dimanche … 6 = samedi). */
    days: number[];
  };
  lookbackHours: number;
  sources: {
    gmail: boolean;
    calendar: boolean;
    notionPersonal: boolean;
    notionCompany: boolean;
  };
  gmailQuery: string;
  gmailMaxMessages: number;
  notebookTitleTemplate: string;
  audio: AudioOptions;
  /** Consignes additionnelles pour la synthèse Claude (ex. « angle Comex : risques, KPI, décisions »). */
  synthesisFocus: string;
  /** Étiquette les sujets nouveau / toujours actif / calmé par rapport aux briefs précédents. */
  memory: boolean;
  /** Extrait les actions qui te sont adressées → file de validation → backlog Notion (requiert Claude). */
  extractActions: boolean;
  /** Supprime les notebooks de ce profil après N jours (0 = conserver). */
  retentionDays: number;
}

export interface Settings {
  profiles: BriefProfile[];
  /** Dossier local alimenté par Claude Cowork (mode « localFolder »). */
  localInbox: {
    /** Chemin absolu (ex. /Users/prenom/Notebooker ou C:\\Users\\prenom\\Notebooker). */
    path: string;
    /** Fréquence de surveillance du dossier (minutes). */
    pollMinutes: number;
  };
  /** Règles de conformité communes à TOUS les profils (non contournables profil par profil). */
  compliance: {
    /** Expéditeurs / domaines / labels exclus (ex. notifications@dotfile.com, label:kyc). */
    gmailExclusions: string[];
  };
  calendar: {
    /** IDs d'agendas lus (« primary » = agenda principal). */
    calendarIds: string[];
    /** Événements privés : seul « Événement privé » est conservé (ni titre, ni description, ni participants). */
    hidePrivateEvents: boolean;
    /** Ignore les événements refusés. */
    skipDeclined: boolean;
  };
  backlog: {
    workspace: NotionWorkspaceKey;
    /** Base Notion du backlog (ID ou URL). Vide = fonctionnalité désactivée. */
    databaseId: string;
    /** Valeur posée sur la propriété statut/select de type « Statut » (ex. « À trier »). Vide = aucune. */
    defaultStatus: string;
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
  profileId: string;
  profileName: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "partial" | "error";
  notebookId: string | null;
  sourcesCount: number;
  steps: { at: string; message: string; level: "info" | "warn" | "error" }[];
}

// ─── Actions extraites ────────────────────────────────────────────────────────

export type ActionPriority = "haute" | "moyenne" | "basse";

export interface ActionItem {
  id: string;
  /** Clé de dédoublonnage (titre normalisé). */
  key: string;
  profileId: string;
  runId: string;
  createdAt: string;
  title: string;
  requester: string;
  /** Échéance AAAA-MM-JJ ou "" si inconnue. */
  due: string;
  priority: ActionPriority;
  /** Référence de la source ([Mail: objet] / [Notion: titre]). */
  source: string;
  context: string;
  status: "pending" | "sent" | "dismissed" | "error";
  notionPageId?: string;
  error?: string;
}

// ─── Mémoire du brief ─────────────────────────────────────────────────────────

export interface MemoryTopic {
  key: string;
  title: string;
  kind: "mail" | "notion" | "event";
  firstSeen: string;
  lastSeen: string;
  /** Nombre de briefs (jours distincts) où le sujet était actif. */
  activeDays: number;
  /** Empreinte du dernier contenu (mode dossier local) : détecte « inchangé » vs « mis à jour ». */
  fingerprint?: string;
  /** Dernier jour où le contenu a réellement changé. */
  lastChanged?: string;
  resolved?: boolean;
}

export interface BriefMemory {
  /** Date locale AAAA-MM-JJ du dernier brief pris en compte. */
  lastBriefDate: string | null;
  /** Jour de brief précédent (distinct de lastBriefDate) : référence pour « calmé » en cas de re-run le même jour. */
  previousBriefDate: string | null;
  topics: Record<string, MemoryTopic>;
}

/** Contenu normalisé prêt à être poussé comme source. */
export interface SourcePayload {
  type: "url" | "text";
  title: string;
  url?: string;
  text?: string;
}
