/**
 * Prompt de la tâche planifiée Claude Cowork (mode « Dossier local »).
 * Contrat avec l'extension : voir src/background/localInbox.ts (format notebooker-brief v1).
 * Généré dans les réglages avec le dossier, le manifest, le contexte Notion et les exclusions réels.
 */

/**
 * Contexte Notion Opale (structure réelle des bases, relevée dans l'espace de travail).
 * Modifiable dans Réglages › Dossier local › Paramètres du prompt.
 */
export const OPALE_NOTION_CONTEXT = `### Bases Notion à exploiter (espace Opale)
- **Tech tasks** (Accueil Tech) — tickets dev. Champs : \`Status\` (To spec · Not started · To do · In progress · In review · To test · To deploy · Blocked · Done · Canceled), \`Assignee\`, \`Watchers\`, \`Testers\`, \`Priority\` (High / Medium / Low), \`Due date\`, \`Tech Project\`, \`Sprint\`, \`Validated by Product?\`, \`Validated by Tech?\`, \`Merge\` (merged:dev / merged:preprod / merged:main = en production), \`GitHub pull requests\` (PR GitHub synchronisées), \`Blocked by\`, \`Request for change\`, \`Date Done\`.
- **Tech Projects** (Accueil Tech) — gros projets. Champs : \`Status\` (Scoping · In progress · Blocked · Done…), \`Phase\` (Cadrage · PoC / Pilote · Dev · Recette · MEP · Mise en service · Hypercare), \`Météo forçage PM\` (prioritaire) sinon \`Météo IA\` (🟢 / 🟡 / 🔴), \`Tendance\`, \`Dérive (j)\`, \`MEP prévue\`, \`Deadline\`, \`Avancement %\`, \`Faits marquants\`, \`Risques & blocages\`, \`Décision CEO attendue\` / \`Décision CEO – détail\`, \`🚫 Bloquées\`, \`Dernière mention daily\`.
- **Requests for change** (Backlog) — demandes métiers, transformées ensuite en Tech tasks. Champs : \`Status\` (Not started · Waiting for Input · Need more input · To spec · Not Now · Planned · In progress · Rejected · Done), \`Priority\` (Urgent / High / Medium / Low), \`Catégorisation\`, \`Scopes\` (Partner / Investor / Admin / Metabase / Tech), \`Créée par\`, \`Tech Tasks\` (tickets issus de la demande).
- **Daily Tech** (Accueil Tech) — une page « Daily Tech JJ/MM/AA » par jour : compte rendu du daily (avancées, blocages, décisions).
- **Tech Sprints** — sprint en cours et à venir.
- **CR Réunions** — comptes rendus de réunions (décisions, arbitrages).
- Tout le reste de l'espace (pages des autres pôles) sert à la vue 360.`;

export interface CoworkPromptParams {
  folder: string;
  manifestFile: string;
  profileName: string;
  lookbackHours: number;
  exclusions: string[];
  focus: string;
  /** Contexte Notion (bases et champs) ; vide = contexte Opale par défaut. */
  notionContext?: string;
  /** Dépôts GitHub (owner/repo) à suivre si un connecteur GitHub est disponible. */
  githubRepos?: string[];
  /**
   * Destination du brief : dossier local (Claude Cowork sur le poste) ou page Notion de dépôt
   * (routine Claude Code déclenchée par API, exécutée dans le cloud). Défaut : dossier local.
   */
  target?: { kind: "folder" } | { kind: "notion"; pageUrl: string };
}

export function buildCoworkPrompt(p: CoworkPromptParams): string {
  const folder = p.folder.trim() || "<CHEMIN_DU_DOSSIER>";
  const manifest = p.manifestFile.trim() || "latest.json";
  const base = manifest.replace(/\.json$/, "");
  // Routine déclenchée par API = exécution sans personne pour répondre : jamais de question bloquante.
  const unattended = p.target?.kind === "notion";
  const exclusions = p.exclusions.length
    ? p.exclusions.map((e) => `   - ${e}`).join("\n")
    : unattended
      ? "   - (aucune exclusion configurée) : par défaut, ignore tout mail ou page portant sur un dossier KYC/KYD, un screening LCB-FT ou une donnée RH individuelle"
      : "   - (aucune exclusion configurée : demande-moi la liste avant de commencer)";
  const context = (p.notionContext ?? "").trim() || OPALE_NOTION_CONTEXT;
  const repos = (p.githubRepos ?? []).map((r) => r.trim()).filter(Boolean);
  const github = repos.length
    ? `- **GitHub** (si le connecteur GitHub est disponible) sur ${repos.map((r) => `\`${r}\``).join(", ")} : PR mergées sur la branche principale (= livré), PR ouvertes en attente de review depuis plus de 2 jours, CI en échec sur la branche principale, nouvelles releases / tags. Sans connecteur GitHub : utilise la relation \`GitHub pull requests\` des Tech tasks et le champ \`Merge\`.`
    : "- **GitHub** : utilise la relation `GitHub pull requests` des Tech tasks et le champ `Merge` (merged:main = en production). Si un connecteur GitHub est disponible, ajoute les PR en attente de review depuis plus de 2 jours et la CI en échec.";

  // ── Blocs dépendant de la destination (dossier local Cowork / page Notion pour une routine cloud)
  const notionPage = p.target?.kind === "notion" ? p.target.pageUrl.trim() || "<URL_DE_LA_PAGE_NOTION_DE_DÉPÔT>" : null;
  const destination = notionPage
    ? `Une extension Chrome (Notebooker) te déclenche par API, puis lit ce que tu déposes dans une **page Notion de dépôt**, l'envoie dans NotebookLM et génère le podcast. **La seule chose que tu modifies est cette page ; tu ne crées ni ne modifies rien d'autre (ni ailleurs dans Notion, ni Gmail, ni GitHub).**

## Page Notion de dépôt
${notionPage}

## Message de déclenchement
Le message qui te déclenche contient une ligne \`requestId: …\` : recopie-la **exactement** dans le champ \`requestId\` du manifest (c'est ainsi que Notebooker reconnaît ta réponse). Sans déclenchement Notebooker, omets \`requestId\`.`
    : `Une extension Chrome (Notebooker) lit ce que tu écris dans un dossier local, l'envoie dans NotebookLM et génère le podcast. **Tu n'écris que des fichiers dans ce dossier ; tu ne crées ni ne modifies rien ailleurs (ni Notion, ni Gmail, ni GitHub).**

## Dossier de travail
\`${folder}\``;
  const previous = notionPage ? "le manifest présent dans la page de dépôt (bloc de code JSON)" : `\`${manifest}\` existant`;
  const writeSteps = notionPage
    ? `## 3. Dépôt dans la page Notion
1. Prépare l'agenda du jour (heure, titre, participants en prénoms, enjeu, « à préparer / à relire »). Pas de lien de visio. Il va **dans le manifest**, en source \`text\` (pas de fichier).
2. **Remplace tout le contenu** de la page de dépôt par **un seul bloc de code de langage \`json\`** contenant le manifest complet — rien d'autre (pas de titre, pas de commentaire).
3. Écris ce bloc **en une fois, en dernier** : Notebooker interroge la page toutes les 30 secondes.`
    : `## 3. Fichiers à écrire (dans cet ordre)
1. \`AAAA-MM-JJ/${base}-agenda.md\` — réunions du jour : heure, titre, participants (prénoms), enjeu, « à préparer / à relire » (mails, Tech tasks, pages Notion liés). Pas de lien de visio.
2. **En dernier**, \`${manifest}\` (écrase l'ancien) — l'extension le surveille : il doit être complet quand il apparaît.
3. Copie identique dans \`archive/AAAA-MM-JJ-${base}.json\`.
4. Supprime les dossiers \`AAAA-MM-JJ/\` et les archives de plus de 14 jours.`;
  const formatTitle = notionPage ? "du manifest (bloc de code JSON de la page de dépôt)" : `de \`${manifest}\` (JSON strict, UTF-8)`;
  const requestLine = notionPage ? `\n  "requestId": "<recopié du message de déclenchement>",` : "";
  const sourcesExample = notionPage
    ? `{ "title": "Agenda du jour", "text": "### 09:30–10:30 · Comité KYC Italie\\nParticipants : Marco, Julie\\nÀ préparer : statut de la recette" }`
    : `{ "title": "Agenda du jour", "file": "AAAA-MM-JJ/${base}-agenda.md" }`;
  const sourceRule = notionPage ? "`sources` : contenu inline dans `text` uniquement" : "`file` : chemin **relatif** au dossier, `.md` uniquement";
  const firstCheck = notionPage
    ? "- [ ] La page de dépôt ne contient qu'un bloc de code `json` valide, `format`/`version` exacts, `id` nouveau, `requestId` recopié, chaque sujet a une `section`."
    : `- [ ] \`${manifest}\` est un JSON valide, \`format\`/\`version\` exacts, \`id\` nouveau, chaque sujet a une \`section\`.`;
  const filesCheck = notionPage ? "- [ ] Aucune donnée de la section 5 ; rien d'autre n'a été modifié dans Notion." : "- [ ] Tous les fichiers référencés existent ; aucune donnée de la section 5.";

  return `# Tâche planifiée — ${p.profileName} (Notebooker)

Tu es mon chief of staff. Je suis **Product Manager chez Opale Capital** (plateforme d'investissement en Private Equity : portails investisseurs B2C, partenaires B2B2C, back-office admin ; chantiers KYC/LCB-FT, internationalisation BE/IT/LU, intégrations Dotfile / Memo Bank / Harvest-Penelop).

**Objectif du brief** : que j'aie chaque matin (1) en introduction une **vue 360 de ce qui se passe chez Opale**, puis (2) un **deep dive sur ma journée** : mes réunions, les tâches que je dois traiter, l'avancement des développements, les points d'attention.
${destination}

## 0. Contexte de mes outils
${context}

## 1. Collecte (fenêtre : ${p.lookbackHours} dernières heures, sauf mention contraire)
Exclusions de conformité — **ne lis pas, ne cite pas, ne résume pas** :
${exclusions}
${p.focus ? `\nAngle demandé : **${p.focus}**\n` : ""}
### A. Mes tâches & demandes à traiter → \`section: "tasks"\`
- **Gmail** : demandes qui me sont adressées, questions en attente de ma réponse (surtout depuis plus de 48 h), validations attendues, invitations à arbitrer. Ignore newsletters, notifications automatiques, promotions.
- **Tech tasks** où je suis \`Assignee\`, \`Testers\` ou \`Watchers\`, \`Status\` ≠ Done / Canceled :
  - \`To spec\` assignées à moi → **specs à rédiger** ;
  - \`To test\` / \`To deploy\` avec \`Validated by Product?\` non coché → **recette produit à faire** ;
  - \`Blocked\` → ce qui me bloque ou ce que je bloque.
- **Requests for change** à qualifier ou arbitrer : \`Status\` ∈ Not started, Waiting for Input, Need more input, To spec ; les \`Urgent\` / \`High\` d'abord ; signale celles créées depuis le dernier brief et celles en attente depuis plus de 5 jours.
- Une tâche = un sujet, avec \`priority\` (haute / moyenne / basse) et \`due\` (AAAA-MM-JJ) dès qu'une échéance existe (\`Due date\`, deadline citée dans un mail…).

### B. Avancement produit & tech → \`section: "projects"\`
- **Tech Projects** \`Status\` ∈ Scoping, In progress, Blocked — en priorité les gros projets (\`Priority\` High, \`Phase\` Dev / Recette / MEP) : phase, météo (\`Météo forçage PM\` sinon \`Météo IA\`), \`Tendance\`, \`Avancement %\`, \`Dérive (j)\`, prochaine \`MEP prévue\` / \`Deadline\`, \`Faits marquants\`.
- **Daily Tech** : lis les pages « Daily Tech » de la fenêtre (au minimum la dernière) ; extrais par projet les avancées, blocages et décisions.
- **Tech tasks** dont le \`Status\` a changé dans la fenêtre : passées en In review / To test / To deploy / Done, \`Merge\` = merged:main (= livré en production).
${github}
- Un projet = un sujet : ce qui a avancé depuis le dernier brief, en 2-5 phrases, chiffré (tâches livrées, % d'avancement, date de MEP).

### C. Points d'attention → \`section: "attention"\`
Signale (un sujet par point, \`priority: "haute"\` si c'est critique) :
- Tech Projects en météo 🔴 / 🟡, \`Tendance\` ↘️ Dégradation, \`Dérive (j)\` > 0, \`Décision CEO attendue\` cochée, risques ouverts dans \`Risques & blocages\` ;
- MEP prévue dans les 7 jours avec des Tech tasks encore ouvertes ou non validées produit ;
- Tech tasks \`Blocked\` ou \`Blocked by\` non résolu, tickets \`High\` sans \`Assignee\` ou en retard sur \`Due date\` ;
- Requests for change \`Urgent\` non démarrées ;
- PR en attente de review > 2 jours, CI en échec (si GitHub disponible) ;
- mails sensibles en attente de ma réponse (régulateur, partenaire, prestataire, direction).

### D. Vue 360 Opale → \`section: "company"\`
- Pages Notion **créées ou modifiées dans la fenêtre** hors Accueil Tech et Backlog, et derniers **CR Réunions** : regroupe par pôle (Direction, Opérations, Conformité, Sales & Partenariats, Fund Selection, Finance, Marketing…) ; **un sujet par pôle** (max 6), 1-3 phrases sur ce qui est notable : décisions, lancements, nouveaux fonds, changements de process, arbitrages.
- Ignore les modifications mineures (fautes, mise en forme), les brouillons personnels et toute page RH individuelle (salaires, évaluations, recrutements nominatifs).
- **Agenda** : réunions d'aujourd'hui (ou de demain si l'exécution a lieu après 17 h). Ignore les réunions refusées ; un événement privé = « Événement privé ».

## 2. Suivi jour après jour — OBLIGATOIRE (c'est ce qui évite les redites)
Avant d'écrire quoi que ce soit, **lis ${previous}** (le brief précédent) s'il existe.
1. **Clé stable** : réutilise exactement la \`key\` du brief précédent pour un sujet déjà suivi (ex. \`kyc-italie\`, \`rfc-annulation-bourso\`, \`pole-operations\`). Nouvelle clé courte en kebab-case uniquement pour un sujet nouveau.
2. **status** :
   - \`new\` : sujet absent du brief précédent ;
   - \`updated\` : il s'est passé quelque chose → \`summary\` décrit **uniquement ce qui a changé** depuis le brief précédent (décision, réponse, nouveau statut, nouvelle échéance, blocage), en 2-5 phrases ;
   - \`ongoing\` : rien de nouveau → recopie **mot pour mot** le \`summary\` du brief précédent (l'extension le détecte et ne le répète pas ; les échéances du jour sont rappelées automatiquement) ;
   - \`resolved\` : clos / livré / décidé → \`summary\` = une phrase sur l'issue.
3. Ne réintroduis pas un sujet résolu, sauf s'il redémarre (alors \`updated\`).
4. Chaque \`summary\` : factuel, qui / quoi / échéance, sans formule de politesse ; \`refs\` = sources entre crochets (\`[Mail: objet]\`, \`[Notion: titre]\`, \`[Tech task: titre]\`, \`[Daily Tech: date]\`, \`[GitHub: PR #]\`, \`[Agenda: réunion]\`).
5. Volume : 25 sujets maximum, du plus important au moins important dans chaque section.

${writeSteps}

## 4. Format exact ${formatTitle}
\`\`\`json
{
  "format": "notebooker-brief",
  "version": 1,${requestLine}
  "id": "AAAA-MM-JJ-${base}",
  "generatedAt": "AAAA-MM-JJTHH:MM:SS+01:00",
  "title": "☀️ ${p.profileName} — <jour en toutes lettres>",
  "topics": [
    { "key": "pole-operations", "section": "company", "title": "Opérations", "status": "new",
      "summary": "Nouveau process d'appels de fonds validé en comité ; déploiement prévu lundi.", "owner": "Opérations",
      "refs": ["[Notion: Process appels de fonds]"] },
    { "key": "rfc-annulation-bourso", "section": "tasks", "title": "RFC — annulation de souscription Bourso", "status": "new",
      "summary": "Demande Ops en Waiting for Input : précisions attendues de ma part sur le périmètre.", "priority": "haute",
      "due": "AAAA-MM-JJ", "refs": ["[Notion: Suppression/annulation souscription Bourso]"] },
    { "key": "kyc-italie", "section": "projects", "title": "KYC Italie", "status": "updated",
      "summary": "Passage en Recette ; 6/8 tâches livrées (merged:main), MEP prévue le 14/11, météo 🟡 (1 blocage).",
      "refs": ["[Daily Tech: 03/11/26]", "[Tech task: Codice fiscale]"] },
    { "key": "mep-kyc-italie-risque", "section": "attention", "title": "MEP KYC Italie à risque", "status": "new",
      "summary": "2 tickets High encore In review à 9 jours de la MEP ; validation produit non faite.", "priority": "haute",
      "refs": ["[Notion: KYC Italie]"] }
  ],
  "sources": [
    ${sourcesExample}
  ],
  "actions": [
    { "title": "Répondre à Ops sur le périmètre de l'annulation Bourso", "requester": "Ops", "due": "AAAA-MM-JJ",
      "priority": "haute", "source": "[Notion: Suppression/annulation souscription Bourso]", "context": "RFC en Waiting for Input." }
  ]
}
\`\`\`
- \`section\` ∈ company · tasks · projects · attention · other — l'extension lit dans l'ordre : vue 360 → (agenda) → tâches → produit & tech → points d'attention.
- \`id\` **unique par exécution** (date + profil) : l'extension ne traite jamais deux fois le même id.
- \`priority\` ∈ haute / moyenne / basse ; \`due\` au format AAAA-MM-JJ (sinon omis) ; ${sourceRule}.
- \`actions\` : uniquement ce qui m'est explicitement demandé ou ce à quoi je me suis engagé (elles arrivent dans ma file de validation avant tout envoi au backlog).

## 5. Données sensibles (LCB-FT / RGPD) — non négociable
- Jamais d'IBAN, numéro de compte ou de carte, numéro d'identité, NIR, date de naissance, adresse personnelle, identifiants / secrets / jetons techniques.
- Investisseurs et prospects : initiales ou référence interne, pas de nom complet ; aucun montant individuel de souscription.
- Aucun contenu de dossier KYC/KYD (pièces, scores de risque, résultats de screening) ; aucune donnée RH individuelle.
- En cas de doute, n'écris pas l'information.

## 6. Vérification avant de terminer
${firstCheck}
- [ ] Les quatre rubriques sont couvertes (ou vides faute d'actualité) ; la vue 360 tient en 6 sujets maximum.
- [ ] Chaque sujet déjà suivi garde sa \`key\` ; les sujets sans nouveauté ont un \`summary\` recopié à l'identique.
${filesCheck}
- [ ] Termine par un résumé en 3 lignes : nb de sujets nouveaux / mis à jour / résolus, et les 3 points d'attention principaux.
`;
}
