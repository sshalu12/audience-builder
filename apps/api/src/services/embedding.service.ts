/**
 * Local embedding service using Xenova/all-MiniLM-L6-v2 (384 dimensions).
 *
 * The ONNX model is downloaded once and cached in .cache/transformers at the
 * repo root. Subsequent calls reuse the in-process singleton pipeline.
 *
 * No API key required — inference runs entirely in-process via onnxruntime-node.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prisma } from "../db.js";

// Resolved at module load time so the path is always correct regardless of cwd.
const repoRoot = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../../../",
);

export const EMBEDDING_DIMENSIONS = 384;
const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EMBED_BATCH_SIZE = 32;

// Lazily-resolved pipeline singleton.
// Typed as unknown to avoid a hard import of @xenova/transformers types at the
// module level — the dynamic import below handles it.
let _pipe: unknown = null;

async function getEmbeddingPipeline() {
  if (_pipe) return _pipe as EmbedPipeline;

  const { pipeline, env } = await import("@xenova/transformers");
  env.cacheDir = path.join(repoRoot, ".cache", "transformers");
  env.allowLocalModels = false;

  console.log(`[embedding] Loading ${MODEL_NAME} (first run downloads ~23 MB)…`);
  _pipe = await pipeline("feature-extraction", MODEL_NAME, { quantized: true });
  console.log("[embedding] Model ready.");

  return _pipe as EmbedPipeline;
}

type EmbedPipeline = (
  text: string,
  opts: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

/**
 * Embed a single string and return a float array of length EMBEDDING_DIMENSIONS.
 */
export async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbeddingPipeline();
  const output = await pipe(text.slice(0, 512), {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(output.data);
}

/**
 * Build the text representation used for embedding a TaxonomySignal.
 * Concatenates every meaningful column into a single string so the embedding
 * captures the full semantics of the signal (name + breadcrumb path + description).
 */
export function signalToEmbedText(signal: {
  name: string;
  description?: string | null;
  path?: string | null;
  level1?: string | null;
  level2?: string | null;
  level3?: string | null;
  level4?: string | null;
  fieldName?: string | null;
  fieldValue?: string | null;
}): string {
  return [
    signal.name,
    signal.path,
    signal.description,
    signal.level1,
    signal.level2,
    signal.level3,
    signal.level4,
    signal.fieldName,
    signal.fieldValue,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
}

type SignalRow = {
  id: string;
  name: string;
  description: string | null;
  path: string | null;
  level1: string | null;
  level2: string | null;
  level3: string | null;
  level4: string | null;
  fieldName: string | null;
  fieldValue: string | null;
};

/**
 * Generate and persist embeddings for every TaxonomySignal that currently has
 * embedding = NULL. Safe to call repeatedly — already-embedded rows are skipped.
 *
 * Uses raw SQL updates because Prisma does not expose Unsupported("vector")
 * columns through its ORM layer.
 */
export async function generateEmbeddingsForAllSignals(): Promise<void> {
  const countResult = await prisma.$queryRaw<Array<{ count: string }>>`
    SELECT COUNT(*)::text AS count FROM "TaxonomySignal" WHERE embedding IS NULL
  `;
  const total = parseInt(countResult[0].count, 10);

  if (total === 0) {
    console.log("[embedding] All signals already have embeddings.");
    return;
  }

  console.log(`[embedding] Generating embeddings for ${total} signals…`);

  let offset = 0;

  while (offset < total) {
    const batch = await prisma.$queryRaw<SignalRow[]>`
      SELECT id, name, description, path, level1, level2, level3, level4,
             "fieldName", "fieldValue"
      FROM "TaxonomySignal"
      WHERE embedding IS NULL
      ORDER BY "createdAt" ASC
      LIMIT ${EMBED_BATCH_SIZE}
    `;

    if (batch.length === 0) break;

    for (const signal of batch) {
      const text = signalToEmbedText(signal);
      const vector = await embed(text);
      const vectorLiteral = `[${vector.join(",")}]`;

      await prisma.$executeRaw`
        UPDATE "TaxonomySignal"
        SET embedding = ${vectorLiteral}::vector
        WHERE id = ${signal.id}
      `;
    }

    offset += batch.length;

    const pct = Math.round((Math.min(offset, total) / total) * 100);
    process.stdout.write(`\r[embedding] ${Math.min(offset, total)}/${total} (${pct}%)`);
  }

  process.stdout.write("\n");
  console.log("[embedding] Done.");
}
