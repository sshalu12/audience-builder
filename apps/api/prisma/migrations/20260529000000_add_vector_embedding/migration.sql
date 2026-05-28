-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to TaxonomySignal
ALTER TABLE "TaxonomySignal" ADD COLUMN IF NOT EXISTS "embedding" vector(384);

-- HNSW index for fast approximate cosine-similarity nearest-neighbour search.
-- m=16 and ef_construction=64 are the pgvector defaults; tune up for better
-- recall at the cost of larger index size / slower build time.
CREATE INDEX IF NOT EXISTS "TaxonomySignal_embedding_hnsw_idx"
  ON "TaxonomySignal"
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
