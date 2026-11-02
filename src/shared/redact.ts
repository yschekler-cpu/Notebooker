/**
 * Masquage PII appliqué AVANT tout envoi à un LLM tiers (API Claude).
 * Objectif : minimisation des données (RGPD art. 5.1.c) et réduction du risque LCB-FT
 * (IBAN, identités, montants de souscription). Le texte envoyé à NotebookLM n'est
 * masqué que si l'option est active — NotebookLM reste dans le périmètre Google Workspace.
 */

export interface RedactOptions {
  amounts?: boolean;
}

interface Rule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const RULES: Rule[] = [
  { name: "email", pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, replacement: "[EMAIL]" },
  // IBAN (FR76…, BE…, LU…, IT…) avec ou sans espaces
  {
    name: "iban",
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g,
    replacement: "[IBAN]",
  },
  // Carte bancaire (13-19 chiffres, séparateurs espace/tiret)
  { name: "card", pattern: /\b(?:\d[ -]?){12,18}\d\b/g, replacement: "[CARTE]" },
  // Téléphones FR/BE/LU/IT internationaux et nationaux
  {
    name: "phone",
    pattern: /(?:\+|00)(?:33|32|352|39)[\s.-]?(?:\(0\))?[\s.-]?\d(?:[\s.-]?\d{1,3}){3,5}|\b0[1-9](?:[\s.-]?\d{2}){4}\b/g,
    replacement: "[TEL]",
  },
  // NIR (sécurité sociale FR)
  { name: "nir", pattern: /\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2])\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}\b/g, replacement: "[NIR]" },
];

const AMOUNT_RULE: Rule = {
  name: "amount",
  pattern: /(?:€|\bEUR)\s?\d(?:[\d.,]|\s(?=\d))*(?:\s?(?:k|K|M|Md)\b)?|\b\d(?:[\d.,]|\s(?=\d))*\s?(?:k|K|M|Md)?\s?(?:€|EUR\b|euros?\b)/g,
  replacement: "[MONTANT]",
};

export function redact(text: string, opts: RedactOptions = {}): string {
  let out = text;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replacement);
  if (opts.amounts) out = out.replace(AMOUNT_RULE.pattern, AMOUNT_RULE.replacement);
  return out;
}
