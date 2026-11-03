# 📚 Notebooker

Extension Chrome (Manifest V3) pour NotebookLM :

| Feature | Ce que ça fait |
|---|---|
| **Organiseur** | Dossiers, tags, épingles et recherche sur la page d'accueil NotebookLM. Stocké en `chrome.storage.sync` (rien n'est écrit chez Google). |
| **Sources auto-synchronisées** | Ajout d'une page web, vidéo YouTube, flux RSS, chaîne YouTube, page ou base Notion vers un **notebook NotebookLM** ou une **base Notion**, avec une fréquence de rafraîchissement (unique / 1 h / 6 h / quotidien / hebdo). |
| **Briefs podcast (profils)** | Plusieurs profils planifiés (jours + heure) : brief du matin, récap conformité du vendredi, digest Comex… Chacun choisit ses sources (Gmail, **Agenda**, Notion perso/entreprise), son angle de synthèse et son **format audio** (format, durée, langue, consignes). Résultat : un notebook « ☀️ Brief du … » + **Audio Overview** + notification. |
| **Préparation des réunions** | Réunions du jour (Google Agenda, lecture seule) avec, pour chacune, les emails et pages Notion à relire (participants + mots-clés). |
| **Mémoire du brief** | Chaque sujet (fil Gmail, page Notion) est étiqueté 🆕 nouveau / 🔁 toujours actif depuis N jours / 💤 calmé, par rapport au brief précédent. |
| **Actions → backlog Notion** | Claude extrait les actions qui te sont adressées ; elles attendent ta **validation** (titre, échéance, priorité modifiables) avant création dans ta base backlog, avec mapping automatique des propriétés. |

---

## Interface

Style **Liquid Glass** (Apple) sur les trois surfaces — réglages, popup, organiseur injecté dans NotebookLM : matériau translucide (flou + saturation) sur fond vivant, reflet spéculaire, icônes façon Réglages iOS, interrupteurs, boutons pilule, barre collante avec navigation par section, toast flottant. Thèmes clair/sombre automatiques ; repli en surfaces pleines si la transparence est réduite (`prefers-reduced-transparency`) ou non supportée ; animations coupées avec `prefers-reduced-motion`. Design system unique : `src/options/options.css` (réglages + popup) et CSS Shadow DOM de `organizer.ts`.

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
npm run typecheck
npm test             # tests unitaires (vitest)
npm run e2e          # build E2E (dist-e2e/) + tests : extension réelle dans Chromium, faux NotebookLM, mocks Google/Notion/Anthropic
```

Les tests E2E nécessitent Playwright (`npx playwright install chromium` en local). Ils chargent l'extension dans Chromium, servent un **faux NotebookLM** (`tests/e2e/mock-notebooklm.html` : icônes Material dans les boutons, cartes sans lien, overlays CDK, boutons désactivés, libellés leurres) et interceptent les API Notion et Anthropic pour vérifier les requêtes réellement émises.

Chrome → `chrome://extensions` → **Mode développeur** → **Charger l'extension non empaquetée** → dossier `dist/`.

### ID de l'extension

Le manifest contient une clé publique (`key`) qui **fige l'ID de l'extension** : `pkhpbkhohjogegmldhbkmciebihllfpi`, identique sur tous les postes en chargement non empaqueté. C'est cet ID qu'il faut déclarer dans le client OAuth Google. (Une publication Chrome Web Store attribuera son propre ID : remplacer alors `key` par celle de l'élément publié.)

### Configuration

| Étape | Où | Détail |
|---|---|---|
| 1. NotebookLM | Navigateur | Être connecté à notebooklm.google.com avec le compte voulu. Si plusieurs comptes Google : régler l'**index de compte** (`/u/N/`) dans les options. Ouvrir NotebookLM une fois → les notebooks sont listés comme cibles. |
| 2. Gmail + Agenda | Google Cloud Console | Créer un **OAuth client ID** de type *Chrome Extension* avec l'ID de l'extension (visible dans `chrome://extensions`), activer la **Gmail API** et la **Google Calendar API**, puis remplacer `oauth2.client_id` dans `static/manifest.json`. Scopes : `gmail.readonly` + `calendar.readonly` (un seul consentement). Pour figer l'ID de l'extension entre postes, ajouter une clé `key` au manifest. |
| 3. Notion | Réglages › Notion | **Deux modes par workspace.** *Jeton d'API* : créer une connexion interne (Outils pour les développeur·euses › Connexions), la partager uniquement avec les pages utiles, coller le jeton. *OAuth* (si les connexions internes ne sont pas autorisées dans l'espace) : créer une connexion **OAuth** avec l'URI de redirection `https://pkhpbkhohjogegmldhbkmciebihllfpi.chromiumapp.org/notion` (affichée et copiable dans les réglages), coller *Client ID* + *secret client*, puis **Se connecter avec Notion** et choisir les pages partagées. |
| 4. Claude (optionnel) | Options | Mode **Jeton OAuth** : `ant auth login` puis `ant auth print-credentials --access-token`. Mode **Clé API** : clé Console. Modèle par défaut `claude-opus-5-5`, fallbacks serveur activés (désactivés automatiquement si l'API les refuse). Corpus plafonné à ~100k tokens. |
| 5. Profils de brief | Options › Profils | Partir d'un modèle (brief du matin, récap conformité, digest Comex), régler jours/heure, sources, format audio, angle de synthèse, mémoire, extraction d'actions. **Enregistrer** → la prochaine exécution de chaque profil s'affiche. |
| 6. Conformité | Options › Conformité | **Exclusions Gmail communes à tous les profils** (non contournables par profil). |
| 7. Backlog (optionnel) | Options › Backlog Notion | ID/URL de la base + statut d'import. **Vérifier la base** affiche le mapping détecté (titre, échéance, priorité, statut, source). L'intégration Notion doit avoir accès à la base. |

---

## Utilisation

| Action | Comment |
|---|---|
| Classer un notebook | Page d'accueil NotebookLM → bouton **⋯** sur chaque carte (dossier, tags, épingle) ou **glisser-déposer** la carte sur un dossier du panneau. Panneau repliable en bas à gauche : filtres, recherche titre/tag, renommage/couleur des dossiers. Les épinglés remontent en tête. |
| Sauvegarder l'organisation | Options → *Organisation* → Exporter / Importer (JSON, sans token ni contenu). |
| Ajouter la page courante | Popup → cible + fréquence → **Ajouter cette page**. Ou clic droit → *Notebooker : ajouter à…* |
| Suivre un flux / une chaîne YouTube | Options → *Ajouter un abonnement* (URL de chaîne `youtube.com/channel/UC…`, playlist, `…/feed`, page ou base Notion). |
| Brief manuel | Popup → choisir le profil → **☀️ Brief maintenant** (premier lancement : consentement Google interactif). Ou Options › Profils › **Lancer ce profil maintenant**. |
| Valider les actions | Notification « N actions à valider » → Options › **Actions à valider** : corriger, cocher, **Envoyer au backlog** ou **Ignorer**. Une action déjà traitée n'est pas re-proposée pendant 14 jours. |
| Diagnostiquer | Options → **Historique des briefs** (log horodaté par étape) + colonne erreur des abonnements. |

### Comportement de rafraîchissement

| Type | Détection de changement | Action |
|---|---|---|
| `url` (article) | SHA-256 du texte extrait | Ré-ajout de l'URL si changement |
| `url` (YouTube) / ajout unique | — | Un seul ajout |
| `feed` (RSS/Atom, YouTube) | GUID d'item déjà vu | Ajout des nouveaux items (max 10/passage ; le surplus part au passage suivant ; au 1er abonnement, seuls les 10 derniers sont importés) |
| `notion_page` | `last_edited_time` | Nouvelle source texte datée |
| `notion_database` | `last_edited_time` ≥ dernier check | Une source texte par page modifiée |

**Fiabilité** : en cas d'échec partiel (ex. 2 sources sur 3 ajoutées), seules les sources réellement ajoutées sont marquées comme traitées → aucune perte, aucun doublon au passage suivant. Ré-ajouter une URL déjà suivie vers la même cible met à jour l'abonnement au lieu d'en créer un second. Synchro et brief sont protégés contre les exécutions concurrentes (verrou persistant).

---

### Mise à jour depuis la v0.1

Les réglages existants sont migrés automatiquement au premier chargement : l'ancien brief devient le profil « Brief du matin » (heure, jours, fenêtre, consignes audio, rétention conservés) et ses exclusions Gmail deviennent les **exclusions de conformité** communes. Après la mise à jour, Chrome redemande le consentement Google pour ajouter le scope Agenda.

## Mode « Dossier local » (Claude Cowork)

Alternative sans aucun connecteur côté extension : **Claude Cowork** (tâche planifiée) agrège Gmail, Agenda et Notion et écrit le brief dans un dossier du poste ; **l'extension lit ce dossier, calcule le diff et génère le podcast** dans NotebookLM.

```
Claude Cowork (7 h 00, planifié)          Notebooker (surveillance toutes les 10 min)
  Gmail · Agenda · Notion                    lit latest.json (nouvel id ?)
  relit le brief précédent (clés stables)    diff vs mémoire : 🆕 / 🔄 / ⏸️ / ✅ / 💤
  écrit AAAA-MM-JJ/agenda.md                 → notebook + sources + Audio Overview
  écrit latest.json (en dernier)             → notification · « Dernier podcast » dans la popup
```

| Élément | Détail |
|---|---|
| Contrat | `latest.json` au format `notebooker-brief` v1 : `id` unique, `generatedAt`, `topics[]` (clé stable, statut, résumé), `sources[]` (fichiers `.md` relatifs), `actions[]` optionnelles. Spécification : `src/background/localInbox.ts`. |
| Prompt Cowork | Réglages › Dossier local › **Copier le prompt Cowork** (personnalisé : dossier, manifest, exclusions de conformité). Version générique : [`docs/COWORK-PROMPT.md`](docs/COWORK-PROMPT.md). |
| Anti-redite (diff) | Double sécurité : Cowork écrit uniquement ce qui a changé par sujet ; l'extension compare l'empreinte de chaque sujet aux jours précédents. Nouveaux et modifiés → développés ; inchangés → une ligne ; résolus → annoncés une fois ; rien de nouveau → **pas de podcast**. Consigne audio « point d'avancement, pas un récapitulatif ». |
| Déclenchement | Dès qu'un nouveau dépôt apparaît (surveillance), l'heure du profil servant de filet de sécurité. Un même `id` n'est jamais traité deux fois automatiquement ; un dépôt plus ancien que la fenêtre du profil est ignoré (alerte). |
| Structure du brief | Chaque sujet a une **rubrique** : 🌐 vue 360 Opale (autres pôles, CR de réunions) → 📅 journée (agenda) → ✅ mes tâches & demandes (Tech tasks, Requests for change, mails) → 🚀 avancement produit & tech (Tech Projects, Daily Tech, PR GitHub) → ⚠️ points d'attention (météo, dérive, blocages, MEP proches). Le podcast suit cet ordre. |
| Rappels d'échéance | Une tâche inchangée mais **due aujourd'hui ou en retard** est rappelée en une ligne (sans redite du contenu) et suffit à déclencher un brief. |
| Contexte Notion | Le prompt connaît la structure réelle des bases Opale (Tech tasks, Tech Projects, Requests for change, Daily Tech, Tech Sprints, CR Réunions) — modifiable dans Réglages › Dossier local › Paramètres du prompt, avec les dépôts GitHub optionnels. |
| Dernier podcast | Popup › **Dernier podcast** : titre, statut (en génération / prêt), bouton ▶ qui ouvre le notebook et lance la lecture. |

**Mise en place** : (1) `chrome://extensions` › Notebooker › Détails › activer **« Autoriser l'accès aux URL de fichier »** ; (2) créer le dossier, lui donner accès dans Claude Cowork et créer une tâche planifiée avec le prompt copié ; (3) dans Notebooker, renseigner le chemin complet du dossier, créer un profil depuis le modèle **« Brief Cowork (dossier local) »**, l'activer.

**Conformité** : les fichiers du brief sont stockés en clair sur le poste — disque chiffré obligatoire (FileVault / BitLocker), dossier hors synchronisation cloud personnelle ; le prompt impose la pseudonymisation des investisseurs, l'absence d'IBAN / données KYC et la purge à 14 jours. L'extension ne lit que des `.md` / `.txt` à l'intérieur du dossier (chemins relatifs, pas de `..`).

## Mode « Routine Claude (API) »

Variante cloud du mode Cowork : Notebooker **déclenche lui-même** une routine Claude Code par son API officielle, attend son résultat, puis génère le podcast.

```
Notebooker (heure du profil ou « Lancer »)
  POST https://api.anthropic.com/v1/claude_code/routines/trig_…/fire   (jeton de la routine, text = requestId)
     → réponse immédiate : id + URL de session (pas le résultat)
Routine Claude Code (cloud) : Gmail · Agenda · Notion · GitHub
     → dépose le manifest (bloc de code JSON, requestId recopié) dans une page Notion de dépôt
Notebooker interroge la page toutes les 30 s (alarmes, résiste à l'arrêt du service worker)
     → manifest avec SON requestId → diff → notebook + podcast (même traitement que le dossier local)
```

| Point | Détail |
|---|---|
| Pourquoi une page Notion | L'API des routines ne renvoie que l'id de session et son jeton n'a aucun accès en lecture ; la routine tourne dans le cloud et ne peut pas écrire sur le poste. La page Notion de dépôt reste dans l'espace Opale, déjà lisible par Notebooker (jeton d'API ou OAuth). |
| Sécurité du jeton | Jeton propre à la routine (`sk-ant-oat01-…`, déclenchement uniquement), stocké localement ; **envoyé uniquement à `api.anthropic.com`** (URL validée : schéma, hôte et chemin `…/routines/trig_…/fire`). |
| Fiabilité | Un ancien brief resté dans la page est ignoré (corrélation par `requestId`) ; un seul déclenchement en attente par profil (pas de session en double) ; délai maximal configurable → alerte avec le lien de la session. Limites Anthropic : 30 déclenchements / h par routine. |
| Mise en place | Page Notion vide dédiée (connectée à Notebooker et accessible à la routine) → Réglages › Profils › modèle « Brief routine Claude (API) » → **Copier le prompt de la routine** → créer la routine dans Claude Code avec ce prompt, ajouter un déclencheur **API**, générer le jeton → coller URL + jeton dans le profil. |

## Pipeline d'un profil de brief

| Étape | Détail | En cas d'échec |
|---|---|---|
| 1. Collecte | Gmail (requête du profil + exclusions de conformité), Agenda (de maintenant à la fin de journée ; brief ≥ 17 h → lendemain), Notion perso/entreprise | Source ignorée, run « partial », cause dans l'historique |
| 2. Mémoire | Sujets observés comparés au dernier brief du profil (re-run le même jour sans double comptage, purge à 14 j) | — |
| 3. Masquage | PII masquées avant NotebookLM et Claude | — |
| 4. Claude (option) | Synthèse + extraction d'actions sur **le même corpus mis en cache** (la 2ᵉ requête relit le cache, ≈ 5 % du prix d'entrée) ; extraction en JSON Schema validé | Chaque tâche est indépendante ; le brief continue sans |
| 5. Actions | File « à valider » — **aucune écriture Notion sans validation** | — |
| 6. NotebookLM | Notebook + sources (Synthèse, Agenda, Suivi, Emails, Notion) + Audio Overview au format du profil | Réglage audio introuvable → signalé, génération quand même |
| 7. Rétention | Suppression des notebooks **de ce profil** au-delà de N jours | Conservé + warning |

## Conformité & sécurité des données

| Sujet | Mesure |
|---|---|
| **Moindre privilège** | Pas de permission `tabs` ni `scripting` (aucun accès à l'historique de navigation) ; Gmail `readonly` ; intégrations Notion limitées aux pages partagées ; permissions d'hôte optionnelles demandées site par site, au moment de l'abonnement. |
| **Secrets** | Tokens Notion / Claude en `chrome.storage.local` (jamais synchronisés). Organisation (dossiers/tags) seule en `storage.sync`. |
| **Minimisation (RGPD)** | Masquage avant envoi : emails, IBAN (FR/BE/LU/IT…), cartes, téléphones FR/BE/LU/IT, NIR ; montants en option. Historique Gmail cité supprimé. |
| **LCB-FT / KYC** | Exclusions Gmail par expéditeur/domaine/label (ex. `notifications@dotfile.com`, `label:kyc`) pour ne jamais faire transiter de dossiers KYC/KYD dans un notebook ou un LLM. |
| **Périmètre NotebookLM** | ⚠️ Utiliser le **compte Google Workspace Opale**, pas un compte perso : le contenu des emails pro ne doit pas quitter le tenant de l'entreprise. À valider avec le RSSI / DPO. |
| **LLM tiers** | Claude OFF par défaut ; en ON, à inscrire au registre des traitements (sous-traitant, finalité, durée). |
| **Rétention** | Suppression automatique des notebooks de brief après N jours (uniquement ceux créés par l'extension). |
| **Notion OAuth** | Client ID / secret saisis par l'utilisateur et stockés localement (jamais embarqués dans le code) ; `state` vérifié au retour (anti-CSRF) ; renouvellement automatique et dédoublonné du jeton ; **Déconnecter** révoque le jeton côté Notion. L'accès est limité aux pages choisies lors de l'autorisation. |
| **Agenda** | Lecture seule. Événements privés réduits à « Événement privé » (option par défaut). Liens de visio retirés. Réunions refusées ignorées. |
| **Actions** | Validation humaine obligatoire avant toute écriture dans le backlog ; options de select/statut jamais inventées. |
| **Mémoire** | Titres de sujets (masqués si le masquage est actif) conservés localement 14 jours, en `storage.local` (inaccessible aux pages web). |
| **Profil Comex** | Modèle sans Gmail et avec consigne « pas de donnée nominative » — à valider avec la Conformité avant diffusion. |
| **Onglet d'options obsolète** | Un onglet resté ouvert ne réécrit jamais silencieusement des réglages modifiés ailleurs (rechargement auto ou avertissement). |
| **Isolation des secrets** | `storage.local` (tokens) en accès `TRUSTED_CONTEXTS` : illisible depuis le content script injecté dans NotebookLM. Le routeur de messages n'accepte d'une page web que la liste des notebooks visibles (payload validé). |
| **Création de notebook** | Le driver refuse tout ID de notebook déjà existant après le clic « Créer » (protection contre l'ouverture accidentelle d'un notebook existant, qui serait sinon rempli puis supprimé par la rétention). |
| **Suppression de données** | L'extension ne supprime **jamais** un notebook qu'elle n'a pas créé ; avant suppression, la carte ciblée doit référencer un seul notebook et la boîte de confirmation doit correspondre, sinon abandon. |

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
- [x] Google Agenda (réunions du jour + préparation) dans le brief
- [x] Profils de brief (planning, sources, angle, format audio) · mémoire · actions → backlog Notion
- [ ] « Google Doc vivant » par abonnement (une source unique synchronisée nativement par NotebookLM)
- [ ] Auto-test quotidien du driver · pré-contrôle des quotas NotebookLM
- [x] Mode « Dossier local » alimenté par Claude Cowork, diff quotidien, lecture du dernier podcast
- [x] Mode « Routine Claude (API) » : déclenchement par l'API officielle, dépôt dans une page Notion, attente robuste
- [ ] Slack dans le brief
- [x] Drag & drop des cartes vers les dossiers
- [x] Export / import de l'organisation (JSON)

## Structure

```
static/                 manifest.json, icônes
src/shared/             types, storage, redact (PII), schedule, messages
src/background/         service worker : index, sync, briefing, gmail, notion, claude, notebooklm, rss, text, classify
src/content/notebooklm/ driver UI, sélecteurs, organiseur
src/popup/ src/options/ UI
tests/                  vitest (unitaires) · tests/e2e/ (Playwright + faux NotebookLM)
```
