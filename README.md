# 📚 Notebooker

Extension Chrome (Manifest V3) pour NotebookLM :

| Feature | Ce que ça fait |
|---|---|
| **Organiseur** | Dossiers, tags, épingles et recherche sur la page d'accueil NotebookLM. Stocké en `chrome.storage.sync` (rien n'est écrit chez Google). |
| **Sources auto-synchronisées** | Ajout d'une page web, vidéo YouTube, flux RSS, chaîne YouTube, page ou base Notion vers un **notebook NotebookLM** ou une **base Notion**, avec une fréquence de rafraîchissement (unique / 1 h / 6 h / quotidien / hebdo). |
| **Brief quotidien (podcast)** | Tous les matins à heure fixe : scan Gmail + Notion perso + Notion entreprise → (option) synthèse Claude → création d'un notebook « ☀️ Brief du … » → lancement de l'**Audio Overview** → notification quand le podcast est prêt. |

---

## Architecture

```
┌──────────── Popup / Options / Menu contextuel ────────────┐
│ ajout page courante · réglages · abonnements · historique │
└───────────────────────────┬───────────────────────────────┘
                            │ chrome.runtime messages
┌───────────────────────────▼─────────────── Service worker ┐
│ alarms : briefing (one-shot recalculé) · sync (15 min)     │
│ ├─ sync.ts      : url / feed / notion_page / notion_db     │
│ ├─ briefing.ts  : collecte → masquage → [Claude] → NLM     │
│ ├─ gmail.ts     : Gmail API (readonly, chrome.identity)    │
│ ├─ notion.ts    : Notion API (token d'intégration)         │
│ ├─ claude.ts    : SDK Anthropic (optionnel)                │
│ └─ notebooklm.ts: orchestrateur du driver UI (file FIFO)   │
└───────────────────────────┬───────────────────────────────┘
                            │ chrome.tabs.sendMessage
┌───────────────────────────▼──── Content script NotebookLM ┐
│ driver.ts : createNotebook · addSource · generateAudio …   │
│ dom.ts    : sélecteurs/libellés FR-EN (seul point fragile) │
│ organizer.ts : panneau dossiers/tags (Shadow DOM)          │
└────────────────────────────────────────────────────────────┘
```

### Choix structurants

| Décision | Raison | Conséquence |
|---|---|---|
| **Pilotage de l'UI NotebookLM** (content script) | Pas d'API publique pour NotebookLM grand public / Workspace. L'API officielle n'existe que pour **NotebookLM Enterprise** (GCP). | Fragile aux changements d'UI Google → tous les sélecteurs sont centralisés dans `src/content/notebooklm/dom.ts`. Migration Enterprise = remplacer `background/notebooklm.ts` par un client REST, le reste ne bouge pas. |
| **Extension seule** (pas de backend) | Zéro infra, aucune donnée sur un serveur tiers. | Chrome doit être ouvert à l'heure du brief. Rattrapage automatique au démarrage de Chrome jusqu'à midi. |
| **Pages Notion poussées en « texte copié »** | NotebookLM ne peut pas lire une page Notion privée par URL. | Contenu extrait via l'API Notion → Markdown → source texte titrée `[Notion] … — maj JJ/MM`. |
| **Sources de brief regroupées** (1 source Emails, 1 par workspace Notion, + synthèse) | Limite du nombre de sources par notebook, meilleure cohérence de l'Audio Overview. | Le notebook reste exploitable en Q&A. |
| **Synthèse Claude optionnelle, OFF par défaut** | Minimisation des transferts de données pro vers un tiers. | Si ON : masquage PII avant envoi, fallback sans synthèse en cas d'échec ou de refus. |

---

## Installation (dev)

```bash
npm install
npm run build        # → dist/
npm test             # tests unitaires (vitest)
npm run typecheck
```

Chrome → `chrome://extensions` → **Mode développeur** → **Charger l'extension non empaquetée** → dossier `dist/`.

### Configuration

| Étape | Où | Détail |
|---|---|---|
| 1. NotebookLM | Navigateur | Être connecté à notebooklm.google.com avec le compte voulu. Si plusieurs comptes Google : régler l'**index de compte** (`/u/N/`) dans les options. Ouvrir NotebookLM une fois → les notebooks sont listés comme cibles. |
| 2. Gmail | Google Cloud Console | Créer un **OAuth client ID** de type *Chrome Extension* avec l'ID de l'extension (visible dans `chrome://extensions`), activer la **Gmail API**, puis remplacer `oauth2.client_id` dans `static/manifest.json`. Scope demandé : `gmail.readonly` uniquement. Pour figer l'ID de l'extension entre postes, ajouter une clé `key` au manifest. |
| 3. Notion | notion.so/profile/integrations | Créer **une intégration interne par workspace** (perso, entreprise). Partager **uniquement** les pages/bases nécessaires avec chaque intégration. Coller les tokens dans les options. |
| 4. Claude (optionnel) | Options | Mode **Jeton OAuth** : `ant auth login` puis `ant auth print-credentials --access-token`. Mode **Clé API** : clé Console. Modèle par défaut `claude-opus-5-5`. |
| 5. Brief | Options | Activer, régler l'heure, la fenêtre, la requête Gmail, les **exclusions** et les consignes de l'Audio Overview. **Enregistrer** → la prochaine exécution s'affiche. |

---

## Utilisation

| Action | Comment |
|---|---|
| Classer un notebook | Page d'accueil NotebookLM → boutons ☆ / 📁 / # sur chaque carte ; panneau gauche pour filtrer (repliable). |
| Ajouter la page courante | Popup → cible + fréquence → **Ajouter cette page**. Ou clic droit → *Notebooker : ajouter à…* |
| Suivre un flux / une chaîne YouTube | Options → *Ajouter un abonnement* (URL de chaîne `youtube.com/channel/UC…`, playlist, `…/feed`, page ou base Notion). |
| Brief manuel | Popup → **☀️ Brief maintenant** (premier lancement : autorisation Gmail interactive). |
| Diagnostiquer | Options → **Historique des briefs** (log horodaté par étape) + colonne erreur des abonnements. |

### Comportement de rafraîchissement

| Type | Détection de changement | Action |
|---|---|---|
| `url` (article) | SHA-256 du texte extrait | Ré-ajout de l'URL si changement |
| `url` (YouTube) / ajout unique | — | Un seul ajout |
| `feed` (RSS/Atom, YouTube) | GUID d'item déjà vu | Ajout des nouveaux items (max 10/passage) |
| `notion_page` | `last_edited_time` | Nouvelle source texte datée |
| `notion_database` | `last_edited_time` ≥ dernier check | Une source texte par page modifiée |

---

## Conformité & sécurité des données

| Sujet | Mesure |
|---|---|
| **Moindre privilège** | Gmail `readonly` ; intégrations Notion limitées aux pages partagées ; permissions d'hôte optionnelles demandées site par site. |
| **Secrets** | Tokens Notion / Claude en `chrome.storage.local` (jamais synchronisés). Organisation (dossiers/tags) seule en `storage.sync`. |
| **Minimisation (RGPD)** | Masquage avant envoi : emails, IBAN (FR/BE/LU/IT…), cartes, téléphones FR/BE/LU/IT, NIR ; montants en option. Historique Gmail cité supprimé. |
| **LCB-FT / KYC** | Exclusions Gmail par expéditeur/domaine/label (ex. `notifications@dotfile.com`, `label:kyc`) pour ne jamais faire transiter de dossiers KYC/KYD dans un notebook ou un LLM. |
| **Périmètre NotebookLM** | ⚠️ Utiliser le **compte Google Workspace Opale**, pas un compte perso : le contenu des emails pro ne doit pas quitter le tenant de l'entreprise. À valider avec le RSSI / DPO. |
| **LLM tiers** | Claude OFF par défaut ; en ON, à inscrire au registre des traitements (sous-traitant, finalité, durée). |
| **Rétention** | Suppression automatique des notebooks de brief après N jours (uniquement ceux créés par l'extension). |
| **Suppression de données** | L'extension ne supprime **jamais** un notebook qu'elle n'a pas créé. |

---

## Limites connues

| Limite | Impact | Piste |
|---|---|---|
| Driver UI dépendant du DOM NotebookLM | Une refonte d'UI Google casse l'ajout de sources / la génération audio | Corriger `dom.ts` (libellés FR/EN centralisés) ; à terme NotebookLM Enterprise API |
| Ré-ajout d'une URL modifiée = nouvelle source (l'ancienne reste) | Doublons dans le notebook | Supprimer l'ancienne source via le driver (v2) |
| Chrome fermé à l'heure du brief | Brief décalé au démarrage (si avant midi) | Backend n8n optionnel |
| Jeton OAuth Claude court, non rafraîchi | Synthèse sautée quand il expire (brief produit quand même) | Clé API, ou proxy interne qui gère le refresh |
| Audio Overview : 1 génération à la fois, quota quotidien NotebookLM | Échec si quota atteint | Log + notification |

## Roadmap

- [ ] Driver **NotebookLM Enterprise** (API Discovery Engine) en alternative au driver UI
- [ ] Suppression de l'ancienne version d'une source lors d'un rafraîchissement
- [ ] Sources Google Calendar (réunions du jour) et Slack dans le brief
- [ ] Drag & drop des cartes vers les dossiers
- [ ] Export / import de l'organisation (JSON)

## Structure

```
static/                 manifest.json, icônes
src/shared/             types, storage, redact (PII), schedule, messages
src/background/         service worker : index, sync, briefing, gmail, notion, claude, notebooklm, rss, text, classify
src/content/notebooklm/ driver UI, sélecteurs, organiseur
src/popup/ src/options/ UI
tests/                  vitest
```
