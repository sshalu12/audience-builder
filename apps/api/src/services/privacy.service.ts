// Word-boundary regex patterns that flag a request (or a taxonomy row) as
// touching a sensitive trait. We keep these as patterns rather than substring
// matches so we do not accidentally catch unrelated tokens (e.g. "Martha
// White", "outpatient", "transport").
const sensitivePatterns: RegExp[] = [
  // Religion: generic and specific
  /\breligio(n|us|ns)\b/i,
  /\bfaith[- ]based\b/i,
  /\bchrist(ian|ianity|ians)?\b/i,
  /\bcatholic(s|ism)?\b/i,
  /\bprotestant(s|ism)?\b/i,
  /\bevangelical(s)?\b/i,
  /\borthodox\b/i,
  /\bmormon(s)?\b/i,
  /\blds\b/i,
  /\bmuslim(s)?\b/i,
  /\bislam(ic)?\b/i,
  /\bjew(s|ish)?\b/i,
  /\bjuda(ic|ism)\b/i,
  /\bhindu(s|ism)?\b/i,
  /\bbuddhis(t|ts|m)\b/i,
  /\bsikh(s|ism)?\b/i,
  /\batheist(s)?\b/i,

  // Race / ethnicity
  /\bethnic(ity|ities|al)?\b/i,
  /\brac(e|ial|ist)\b/i,
  /\bhispanic(s)?\b/i,
  /\blatin(o|a|x|os|as)\b/i,
  /\bafrican[- ]american(s)?\b/i,
  /\bcaucasian(s)?\b/i,
  /\bblack (people|men|women|community|americans?)\b/i,
  /\bwhite (people|men|women|community|americans?|nationalists?)\b/i,
  /\basian (people|men|women|community|americans?)\b/i,

  // Sexual orientation / gender identity
  /\bsexual orientation\b/i,
  /\bgay(s)?\b/i,
  /\blesbian(s)?\b/i,
  /\blgbtq?\+?\b/i,
  /\bqueer\b/i,
  /\btransgender\b/i,
  /\bnon[- ]binary\b/i,
  /\bbisexual(s)?\b/i,
  /\bhomosexual(s)?\b/i,

  // Health / medical
  /\bmedical condition(s)?\b/i,
  /\bpatient(s)?\b/i,
  /\bdisease(s|d)?\b/i,
  /\bdiabet(es|ic)\b/i,
  /\bcancer\b/i,
  /\bhiv\b/i,
  /\baids\b/i,
  /\bdepression\b/i,
  /\banxiety\b/i,
  /\bmental (health|illness)\b/i,
  /\bpregnan(t|cy|cies)\b/i,
  /\babortion(s)?\b/i,
  /\bdisabilit(y|ies)\b/i,
  /\bdisabled\b/i,

  // Political affiliation
  /\bpolitic(al|ally|s)\b/i,
  /\bvoter(s)?\b/i,
  /\bparty affiliation\b/i,
  /\brepublican(s)?\b/i,
  /\bdemocrat(s|ic)?\b/i,
  /\bliberal(s)?\b/i,
  /\bconservatives?\b/i,
];

export function normalizeForSearch(value: string) {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function isSensitiveText(value: string) {
  if (!value) return false;
  return sensitivePatterns.some((pattern) => pattern.test(value));
}

export function sensitiveRequestMessage() {
  return [
    "I can help build this audience using privacy-safe behavioral, location, purchase, and broad demographic signals.",
    "I cannot recommend targeting based on sensitive traits such as religion, ethnicity, race, medical condition, sexual orientation, or political affiliation.",
    "Try reframing the audience around non-sensitive behaviors, such as relevant store visits, product purchases, interests, or geography.",
  ].join(" ");
}
