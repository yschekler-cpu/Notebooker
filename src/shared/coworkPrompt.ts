/**
 * Prompt de la tâche planifiée Claude Cowork (mode « Dossier local »).
 * Contrat avec l'extension : voir src/background/localInbox.ts (format notebooker-brief v1).
 * Généré dans les réglages avec le dossier, le manifest et les exclusions de conformité réels.
 */

export interface CoworkPromptParams {
  folder: string;
  manifestFile: string;
  profileName: string;
  lookbackHours: number;
  exclusions: string[];
  focus: string;
}

export function buildCoworkPrompt(p: CoworkPromptParams): string {
  const folder = p.folder.trim() || "<CHEMIN_DU_DOSSIER>";
  const manifest = p.manifestFile.trim() || "latest.json";
  const base = manifest.replace(/\.json$/, "");
  const exclusions = p.exclusions.length ? p.exclusions.map((e) => `   - ${e}`).join("\n") : "   - (aucune exclusion configurée : demande-moi la liste avant de commencer)";
  return `# Tâche planifiée — ${p.profileName} (Notebooker)

Tu es mon chief of staff. Je suis Product Manager chez Opale Capital (plateforme d'investissement en Private Equity : portails B2C/B2B2C, back-office, KYC/LCB-FT, internationalisation BE/IT/LU).
Chaque exécution, tu prépares la matière de mon brief audio. Une extension Chrome (Notebooker) lit ce que tu écris dans un dossier local, l'envoie dans NotebookLM et génère le podcast. **Tu n'écris que des fichiers dans ce dossier ; tu ne crées rien ailleurs.**

## Dossier de travail
\`${folder}\`

## 1. Collecte (fenêtre : ${p.lookbackHours} dernières heures)
- **Gmail** : fils reçus ou mis à jour. Ignore newsletters, notifications automatiques sans action, promotions.
- **Google Agenda** : réunions d'aujourd'hui (ou de demain si l'exécution a lieu après 17 h). Ignore les réunions refusées ; pour un événement privé, écris seulement « Événement privé ».
- **Notion** (perso + Opale) : pages et bases modifiées.
- **Exclusions de conformité — ne lis pas, ne cite pas, ne résume pas** :
${exclusions}
${p.focus ? `- **Angle demandé** : ${p.focus}\n` : ""}
## 2. Suivi jour après jour — OBLIGATOIRE (c'est ce qui évite les redites)
Avant d'écrire quoi que ce soit, **lis \`${manifest}\` existant** (le brief précédent) s'il existe.
Organise l'actualité en **sujets** (un fil, un projet, un dossier = un sujet) :
1. **Clé stable** : réutilise exactement la \`key\` du brief précédent pour un sujet déjà suivi (ex. \`kyc-italie\`). Nouvelle clé courte en kebab-case uniquement pour un sujet nouveau.
2. **status** :
   - \`new\` : sujet absent du brief précédent ;
   - \`updated\` : il s'est passé quelque chose de nouveau → \`summary\` décrit **uniquement ce qui a changé** depuis le brief précédent (décision, réponse, nouvelle échéance, blocage), en 2-5 phrases ;
   - \`ongoing\` : rien de nouveau → recopie **mot pour mot** le \`summary\` du brief précédent (l'extension le détecte et ne le répète pas) ;
   - \`resolved\` : clos / livré / décidé → \`summary\` = une phrase sur l'issue.
3. Ne réintroduis pas un sujet résolu, sauf s'il redémarre (alors \`updated\`).
4. Chaque \`summary\` : factuel, qui / quoi / échéance, sans formule de politesse ; \`refs\` = sources entre crochets (\`[Mail: objet]\`, \`[Notion: titre]\`, \`[Agenda: réunion]\`).

## 3. Fichiers à écrire (dans cet ordre)
1. \`AAAA-MM-JJ/${base}-agenda.md\` — réunions du jour : heure, titre, participants (prénoms), enjeu, « à relire avant » (mails / pages Notion liés). Pas de lien de visio.
2. **En dernier**, \`${manifest}\` (écrase l'ancien) — l'extension le surveille : il doit être complet quand il apparaît.
3. Copie identique dans \`archive/AAAA-MM-JJ-${base}.json\`.
4. Supprime les dossiers \`AAAA-MM-JJ/\` et les archives de plus de 14 jours.

## 4. Format exact de \`${manifest}\` (JSON strict, UTF-8)
\`\`\`json
{
  "format": "notebooker-brief",
  "version": 1,
  "id": "AAAA-MM-JJ-${base}",
  "generatedAt": "AAAA-MM-JJTHH:MM:SS+01:00",
  "title": "☀️ ${p.profileName} — <jour en toutes lettres>",
  "topics": [
    { "key": "kyc-italie", "title": "KYC Italie", "status": "updated",
      "summary": "Marco a validé le format du codice fiscale ; reste la signature conformité avant vendredi.",
      "refs": ["[Mail: Codice fiscale Italie]"] }
  ],
  "sources": [
    { "title": "Agenda du jour", "file": "AAAA-MM-JJ/${base}-agenda.md" }
  ],
  "actions": [
    { "title": "Valider le codice fiscale", "requester": "Marco R.", "due": "AAAA-MM-JJ",
      "priority": "haute", "source": "[Mail: Codice fiscale Italie]", "context": "Bloquant pour l'ouverture Italie." }
  ]
}
\`\`\`
- \`id\` **unique par exécution** (date + profil) : l'extension ne traite jamais deux fois le même id.
- \`file\` : chemin **relatif** au dossier, \`.md\` uniquement.
- \`actions\` : uniquement ce qui m'est explicitement demandé ou ce à quoi je me suis engagé ; \`priority\` ∈ haute / moyenne / basse ; \`due\` au format AAAA-MM-JJ ou "".
- Champs facultatifs : \`title\`, \`sources\`, \`actions\`, \`audio\` (\`{ "instructions": "…" }\`).

## 5. Données sensibles (LCB-FT / RGPD) — non négociable
- Jamais d'IBAN, numéro de compte ou de carte, numéro d'identité, NIR, date de naissance, adresse personnelle.
- Investisseurs et prospects : initiales ou référence interne, pas de nom complet ; aucun montant individuel de souscription.
- Aucun contenu de dossier KYC/KYD (pièces, scores de risque, résultats de screening).
- En cas de doute, n'écris pas l'information.

## 6. Vérification avant de terminer
- [ ] \`${manifest}\` est un JSON valide, \`format\`/\`version\` exacts, \`id\` nouveau.
- [ ] Chaque sujet déjà suivi garde sa \`key\` ; les sujets sans nouveauté ont un \`summary\` recopié à l'identique.
- [ ] Tous les fichiers référencés existent ; aucune donnée de la section 5.
- [ ] Termine par un résumé en 3 lignes : nb de sujets nouveaux / mis à jour / résolus.
`;
}
