const sensitiveTerms = [
  "religion",
  "religious",
  "ethnic",
  "ethnicity",
  "race",
  "racial",
  "hispanic",
  "political",
  "voter",
  "party affiliation",
  "sexual orientation",
  "medical condition",
  "patient",
  "disease",
  "disability",
  "disabled",
];

export function normalizeForSearch(value: string) {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function isSensitiveText(value: string) {
  const normalized = normalizeForSearch(value);
  return sensitiveTerms.some((term) => normalized.includes(term));
}

export function sensitiveRequestMessage() {
  return [
    "I can help build this audience using privacy-safe behavioral, location, purchase, and broad demographic signals.",
    "I cannot recommend targeting based on sensitive traits such as religion, ethnicity, race, medical condition, sexual orientation, or political affiliation.",
    "Try reframing the audience around non-sensitive behaviors, such as relevant store visits, product purchases, interests, or geography.",
  ].join(" ");
}
