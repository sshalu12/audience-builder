# Architecture Decisions

This document captures the data-layer and runtime-stack decisions for the
audience builder, and why they are unlikely to change soon.

## Stack at a glance

| Layer | Technology | Why |
| --- | --- | --- |
| API | Node.js 20+, Express 4, TypeScript | Standard, low-friction REST surface for a small product |
| ORM | Prisma 6 | Strong typing against the schema, easy migrations |
| Primary store | **PostgreSQL 16** | Relational data, JSONB for plan/intent blobs, native ILIKE for keyword search |
| Auth | JWT (`jsonwebtoken`) + bcrypt password hashes | Stateless tokens, two roles (`ADMIN`, `PLANNER`) |
| LLM | Groq (`llama-3.1-8b-instant`) via its OpenAI-compatible endpoint | Hosted model with a free tier; can be swapped for OpenAI/Anthropic/Gemini/Ollama with a different `baseURL` and model |
| Frontend | React 19 + Vite 6 + React Router 7 | Familiar SPA stack |

## Why Postgres (and why not Redis or MySQL)

The product brief mandates persistence: conversations must be resumable, and
admins must be able to inspect every user's plans. The data is naturally
relational, with two important access patterns:

1. **Per-user navigation.** `User → Conversation → Message + AudiencePlan (1:1)`.
   Page loads do small joins and filter by `userId`.
2. **Taxonomy lookup.** `TaxonomySignal` is a flat lookup table searched by
   multi-column case-insensitive `contains` in
   `apps/api/src/services/taxonomy.service.ts`
   (`searchTaxonomyByKeywords`). Postgres serves this directly using `ILIKE`
   over `name`, `description`, `path`, `level1`-`level4`, `fieldName`, and
   `fieldValue`.

### Redis is not a replacement

Redis is an in-memory key/value store optimized for caches, queues, and
ephemeral counters. It is not a relational engine: it has no joins, no
secondary indexes over columns we don't pre-compute, no case-insensitive
contains-search, no role-scoped queries, and no transactional guarantees we
need for "approve audience" flows. Using Redis as the primary store would
require us to:

- Hand-roll secondary indexes for `userId`, `conversationId`, and taxonomy
  search terms.
- Re-implement filtering, pagination, and admin queries on top of `SCAN`
  patterns that don't scale.
- Manage durability and snapshotting separately, since RDB/AOF guarantees are
  weaker than Postgres' WAL.
- Hold an embedded copy of the taxonomy in memory on every instance.

For this product, Redis as a primary store is the wrong tool.

### MySQL would work but offers nothing here

MySQL handles the same relational workload, but:

- Postgres' JSONB fits the `selectedSignals`, `intent`, `estimate`, and
  `Message.metadata` blobs better than MySQL's JSON type (richer index
  support, faster path queries, GIN indexes).
- Postgres' full-text search and trigram extensions (if we ever outgrow
  ILIKE) are stronger than MySQL's defaults.
- Prisma support is comparable on both.

There is no concrete pull toward MySQL, so we stay on Postgres.

## Where Redis could legitimately appear later

As an **additive cache**, not a replacement, if a measured latency problem
appears:

1. **Taxonomy search cache.** `searchTaxonomyByKeywords` is the hottest read
   path. A 60-300 s Redis cache keyed by normalized keyword set would cut
   repeat-query latency. The Prisma layer would remain authoritative.
2. **Per-user rate limiting.** Token-bucket counters on the `/api/conversations/:id/messages`
   endpoint to protect the LLM cost surface.
3. **LLM response cache.** Optional caching of `generateJson` calls
   keyed by the message hash, for deterministic replays during demos.

None of these are part of the current scope. They become worthwhile only
when there is a measurable bottleneck.

## Data model summary

```text
User (id, email, passwordHash, role)
  └── Conversation (id, userId, title, status)
        ├── Message[] (role, content, metadata: JSON)
        └── AudiencePlan (1:1) (
              brief,
              audienceName,
              summary,
              intent: JSON,
              selectedSignals: JSON,
              estimatedMin, estimatedMax, confidence,
              estimate: JSON,
              status
            )

TaxonomySignal (flat lookup, seeded from the 4 CSVs)
  source: LOCATION | TRANSACTION | CONSUMER_GRAPH_FIELD | CONSUMER_GRAPH_VALUE
  level1..level4, fieldName, fieldValue, name, description, path, raw: JSON
```

Selected signals are denormalized JSON on `AudiencePlan` rather than join
rows to `TaxonomySignal`. That keeps reads cheap (one row to render the panel)
at the cost of point-in-time copies. If we ever need taxonomy renames to
propagate into existing plans, we can switch to a join table without changing
the API.

## Estimation model

The estimator in `apps/api/src/services/estimate.service.ts` treats selected
signals as a probabilistic intersection (AND) with within-source OR. See the
"Audience Size Estimation" section of `README.md` for the formula and
properties.

The estimator is intentionally a mock: no real reach/count data is provided
in the brief. In production it would be replaced with a real measurement API.
