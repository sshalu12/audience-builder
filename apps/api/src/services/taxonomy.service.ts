import type { SignalSource, TaxonomySignal } from "@prisma/client";
import { prisma } from "../db.js";
import type { AudienceIntent } from "./schemas.js";
import { isSensitiveText, normalizeForSearch } from "./privacy.service.js";

export type RankedTaxonomySignal = TaxonomySignal & {
  score: number;
};

// ---------------------------------------------------------------------------
// Synonym expansion (used by ILIKE path and keyword generation)
// ---------------------------------------------------------------------------

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

const stopWords = new Set([
  "the", "and", "for", "with", "from", "that", "this", "those", "these",
  "into", "your", "you", "aged", "age", "audience", "audiences", "signal",
  "signals", "segment", "segments", "target", "targets", "show", "suggest",
  "recommend", "add", "more",
]);

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Replaces underscores with spaces and collapses extra whitespace for UI display. */
export function cleanDisplayText(value: string | null | undefined) {
  return (value ?? "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds the keyword list used for taxonomy search from a structured intent
 * object. Splits all demographic/interest/behavior/location/transaction strings,
 * expands each through the synonymMap, removes stop words, and caps at 30 terms.
 * Used as the fallback when the LLM does not return searchKeywords.
 */
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

// ---------------------------------------------------------------------------
// Scoring (used by ILIKE path and as a re-rank bonus in the vector path)
// ---------------------------------------------------------------------------

/**
 * Scores a taxonomy signal against a list of keywords using exact and partial
 * text matching across all 9 text columns. Scoring rules:
 *   +8 exact full-haystack match, +4 substring match, +1 per token match.
 * A small source-type bonus nudges TRANSACTION (+0.7) and LOCATION (+0.5)
 * above CONSUMER_GRAPH rows as tiebreakers. Used by both the ILIKE path
 * and as the keyword-bonus component in the blended vector re-rank score.
 */
function scoreSignal(signal: TaxonomySignal, keywords: string[]) {
  const haystack = normalizeForSearch(
    [
      signal.name, signal.description, signal.path,
      signal.level1, signal.level2, signal.level3, signal.level4,
      signal.fieldName, signal.fieldValue,
    ]
      .filter(Boolean)
      .join(" "),
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

// ---------------------------------------------------------------------------
// Raw-query result shape for the vector search path
// ---------------------------------------------------------------------------

type VectorRow = {
  id: string;
  source: SignalSource;
  externalId: string | null;
  name: string;
  description: string | null;
  path: string | null;
  level1: string | null;
  level2: string | null;
  level3: string | null;
  level4: string | null;
  fieldName: string | null;
  fieldValue: string | null;
  raw: unknown;
  createdAt: Date;
  similarity: number;
};

// Minimum cosine similarity to include a result from the vector path.
// 0.25 keeps semantically related results while cutting obviously off-topic ones.
const VECTOR_SIMILARITY_THRESHOLD = 0.25;

// If vector search returns at least this many rows, skip the ILIKE fallback.
const VECTOR_MIN_RESULTS = 10;

/**
 * Embeds the query text and runs a cosine-similarity ANN search via pgvector's
 * `<=>` operator. Returns null on any error or when no embeddings exist yet,
 * so the caller can transparently fall back to the ILIKE path.
 */
async function vectorSearch(
  queryText: string,
  limit: number,
): Promise<VectorRow[] | null> {
  try {
    const { embed } = await import("./embedding.service.js");
    const queryEmbedding = await embed(queryText);
    const vectorStr = `[${queryEmbedding.join(",")}]`;

    // CTE lets us reference 'similarity' in the WHERE clause without
    // computing the distance expression twice.
    const rows = (await prisma.$queryRawUnsafe(
      `WITH ranked AS (
         SELECT id, source, "externalId", name, description, path,
                level1, level2, level3, level4, "fieldName", "fieldValue",
                raw, "createdAt",
                1 - (embedding <=> $1::vector) AS similarity
         FROM "TaxonomySignal"
         WHERE embedding IS NOT NULL
       )
       SELECT * FROM ranked
       WHERE similarity > $2
       ORDER BY similarity DESC
       LIMIT $3`,
      vectorStr,
      VECTOR_SIMILARITY_THRESHOLD,
      limit,
    )) as VectorRow[];

    return rows.length > 0 ? rows : null;
  } catch (error) {
    console.warn(
      "[taxonomy] Vector search unavailable, using ILIKE fallback:",
      (error as Error).message,
    );
    return null;
  }
}

/**
 * Case-insensitive keyword search across all 9 text columns of TaxonomySignal.
 * Used when vector search is unavailable or returns fewer than VECTOR_MIN_RESULTS.
 * If the keyword query still returns too few rows, fetches up to 2500 rows
 * as a broad fallback and scores them all with scoreSignal().
 */
async function ilikeFallback(
  uniqueKeywords: string[],
  limit: number,
): Promise<RankedTaxonomySignal[]> {
  const tokenTerms = uniqueKeywords
    .flatMap((keyword) => keyword.split(/\s+/))
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !stopWords.has(token));

  const searchTerms = [...new Set([...uniqueKeywords, ...tokenTerms])].slice(0, 40);

  const where = {
    OR: searchTerms.flatMap((keyword) => [
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    where: where as any,
    take: 600,
  });

  const fallbackRows =
    rows.length >= Math.max(limit, 40)
      ? []
      : await prisma.taxonomySignal.findMany({ take: 2500 });

  const mergedRows = [...rows, ...fallbackRows];
  const byId = new Map<string, TaxonomySignal>();
  for (const row of mergedRows) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }

  return [...byId.values()]
    .filter(
      (row) =>
        !isSensitiveText([row.name, row.description, row.path].filter(Boolean).join(" ")),
    )
    .map((row) => ({ ...row, score: scoreSignal(row, searchTerms) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * EXPORTED — Main taxonomy search entry point.
 * Tries vector search first (semantic, understands meaning with no keyword overlap).
 * If that returns ≥10 results, re-ranks them as: cosine_similarity×10 + keyword_bonus.
 * Falls back to ilikeFallback() when vector search fails or returns too few rows.
 */
export async function searchTaxonomyByKeywords(
  keywords: string[],
  limit = 60,
): Promise<RankedTaxonomySignal[]> {
  const uniqueKeywords = [...new Set(keywords.map(normalizeForSearch))]
    .filter(Boolean)
    .slice(0, 20);

  if (uniqueKeywords.length === 0) {
    return [];
  }

  // Build a single query string for embedding: "fitness gym running hiking"
  const queryText = uniqueKeywords.join(" ");

  // ── Vector path ────────────────────────────────────────────────────────────
  const vectorRows = await vectorSearch(queryText, limit * 2);

  if (vectorRows && vectorRows.length >= VECTOR_MIN_RESULTS) {
    const tokenTerms = uniqueKeywords
      .flatMap((kw) => kw.split(/\s+/))
      .filter((t) => t.length > 2 && !stopWords.has(t));
    const searchTerms = [...new Set([...uniqueKeywords, ...tokenTerms])];

    return vectorRows
      .filter(
        (row) =>
          !isSensitiveText(
            [row.name, row.description, row.path].filter(Boolean).join(" "),
          ),
      )
      .map((row) => ({
        ...(row as unknown as TaxonomySignal),
        // Blend: cosine similarity is the primary signal; keyword bonus
        // ensures exact-name matches still float to the top.
        score: row.similarity * 10 + scoreSignal(row as unknown as TaxonomySignal, searchTerms),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ── ILIKE fallback ─────────────────────────────────────────────────────────
  return ilikeFallback(uniqueKeywords, limit);
}
