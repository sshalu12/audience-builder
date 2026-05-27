import type { TaxonomySignal } from "@prisma/client";
import { prisma } from "../db.js";
import type { AudienceIntent } from "./schemas.js";
import { isSensitiveText, normalizeForSearch } from "./privacy.service.js";

export type RankedTaxonomySignal = TaxonomySignal & {
  score: number;
};

const synonymMap: Record<string, string[]> = {
  fitness: ["fitness", "gym", "exercise", "running", "hiking", "athletic", "sports"],
  gym: ["gym", "fitness", "exercise", "health club"],
  premium: ["premium", "luxury", "affluent", "upscale", "high income"],
  luxury: ["luxury", "premium", "upscale", "affluent"],
  parents: ["parents", "parenting", "family", "kids", "children", "moms", "dads"],
  moms: ["moms", "parents", "family", "kids"],
  dads: ["dads", "parents", "family", "kids"],
  auto: ["auto", "automotive", "cars", "vehicle", "dealership", "suv"],
  suv: ["suv", "cars", "automotive", "vehicle"],
  travel: ["travel", "airport", "hotel", "lodging", "tourism"],
  coffee: ["coffee", "cafe", "cafes", "restaurant", "dining"],
  grocery: ["grocery", "supermarket", "organic", "food"],
  organic: ["organic", "grocery", "supermarket", "natural"],
  home: ["home", "furniture", "home improvement", "real estate", "moving"],
};

export function cleanDisplayText(value: string | null | undefined) {
  return (value ?? "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function keywordsFromIntent(intent: AudienceIntent, message?: string) {
  const keywords = [
    ...(message ? message.split(/[,.;]/) : []),
    ...intent.demographics,
    ...intent.interests,
    ...intent.behaviors,
    ...intent.locations,
    ...intent.transactions,
  ]
    .flatMap((item) => item.split(/\band\b|\bor\b|\s*[,+/]\s*/i))
    .map((item) => cleanDisplayText(item))
    .filter((item) => item.length > 1);

  const expanded = new Set<string>();

  for (const keyword of keywords) {
    const normalized = normalizeForSearch(keyword);
    expanded.add(normalized);

    for (const [term, synonyms] of Object.entries(synonymMap)) {
      if (normalized.includes(term)) {
        synonyms.forEach((synonym) => expanded.add(synonym));
      }
    }
  }

  if (intent.ageRange?.min || intent.ageRange?.max) {
    expanded.add("age");
  }

  return [...expanded].filter((keyword) => keyword.length > 1).slice(0, 30);
}

function scoreSignal(signal: TaxonomySignal, keywords: string[]) {
  const haystack = normalizeForSearch(
    [
      signal.name,
      signal.description,
      signal.path,
      signal.level1,
      signal.level2,
      signal.level3,
      signal.level4,
      signal.fieldName,
      signal.fieldValue,
    ]
      .filter(Boolean)
      .join(" ")
  );

  let score = 0;

  for (const keyword of keywords) {
    const normalizedKeyword = normalizeForSearch(keyword);
    if (!normalizedKeyword) continue;

    if (haystack === normalizedKeyword) score += 8;
    if (haystack.includes(normalizedKeyword)) score += 4;

    for (const token of normalizedKeyword.split(" ")) {
      if (token.length > 2 && haystack.includes(token)) score += 1;
    }
  }

  if (signal.source === "LOCATION") score += 0.5;
  if (signal.source === "TRANSACTION") score += 0.7;
  if (signal.source === "CONSUMER_GRAPH_FIELD") score += 0.4;
  if (signal.source === "CONSUMER_GRAPH_VALUE") score += 0.2;

  return score;
}

export async function searchTaxonomyByKeywords(keywords: string[], limit = 60) {
  const uniqueKeywords = [...new Set(keywords.map(normalizeForSearch))]
    .filter(Boolean)
    .slice(0, 20);

  if (uniqueKeywords.length === 0) {
    return [];
  }

  const where = {
    OR: uniqueKeywords.flatMap((keyword) => [
      { name: { contains: keyword, mode: "insensitive" as const } },
      { description: { contains: keyword, mode: "insensitive" as const } },
      { path: { contains: keyword, mode: "insensitive" as const } },
      { level1: { contains: keyword, mode: "insensitive" as const } },
      { level2: { contains: keyword, mode: "insensitive" as const } },
      { level3: { contains: keyword, mode: "insensitive" as const } },
      { level4: { contains: keyword, mode: "insensitive" as const } },
      { fieldName: { contains: keyword, mode: "insensitive" as const } },
      { fieldValue: { contains: keyword, mode: "insensitive" as const } },
    ]),
  };

  const rows = await prisma.taxonomySignal.findMany({
    where: where as any,
    take: 300,
  });

  return (rows as TaxonomySignal[])
    .filter((row: TaxonomySignal) => !isSensitiveText([row.name, row.description, row.path].filter(Boolean).join(" ")))
    .map((row: TaxonomySignal) => ({ ...row, score: scoreSignal(row, uniqueKeywords) }))
    .filter((row: RankedTaxonomySignal) => row.score > 0)
    .sort((a: RankedTaxonomySignal, b: RankedTaxonomySignal) => b.score - a.score)
    .slice(0, limit);
}

export async function searchTaxonomyFreeText(query: string, limit = 50) {
  const keywords = query
    .split(/\s+|,|\//)
    .map((value) => value.trim())
    .filter((value) => value.length > 1);

  return searchTaxonomyByKeywords(keywords, limit);
}
