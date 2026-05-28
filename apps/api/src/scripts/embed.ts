/**
 * Standalone embedding backfill script.
 *
 * Run after a schema migration or when new taxonomy signals have been added
 * without embeddings. Skips rows that already have a non-NULL embedding.
 *
 *   npm run embed          # via package.json script
 *   tsx src/scripts/embed.ts
 */
import { generateEmbeddingsForAllSignals } from "../services/embedding.service.js";
import { prisma } from "../db.js";

async function main() {
  await generateEmbeddingsForAllSignals();
}

main()
  .catch((error) => {
    console.error("[embed] Fatal error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
