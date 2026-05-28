# Chat-Based Audience Builder

A TypeScript full-stack app for building advertising audiences through chat. Media planners describe who they want to reach in plain English; the backend interprets the request, searches the taxonomy, recommends signals, and estimates audience size.

## Demo Credentials

After seeding:

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@example.com` | `password123` |
| Planner | `planner@example.com` | `password123` |

---

## Local Setup

### Prerequisites

- Node.js 20+ (22 recommended)
- Docker (for Postgres with pgvector)

### 1. Install dependencies

```bash
npm install
```

### 2. Start Postgres

Use the `pgvector/pgvector:pg16` image — the standard `postgres:16-alpine` image does **not** include pgvector and migrations will fail.

```bash
docker compose up -d
```

### 3. Configure environment

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

**API (`apps/api/.env`):**

```env
DATABASE_URL="postgresql://audience_builder:audience_builder@localhost:5432/audience_builder?schema=public"
JWT_SECRET="replace-with-a-long-random-secret"
PORT=4000
CORS_ORIGIN="http://localhost:5173"
GROQ_API_KEY=""
GROQ_MODEL="llama-3.1-8b-instant"
```

**Web (`apps/web/.env`):**

```env
VITE_API_BASE_URL="http://localhost:4000/api"
```

`GROQ_API_KEY` is optional. Without it, the app uses a deterministic local fallback agent. Get a key at https://console.groq.com/keys.

### 4. Run migrations

Creates tables, enables the `vector` extension, adds `embedding vector(384)` to `TaxonomySignal`, and builds the HNSW index.

```bash
npm run prisma:migrate
```

### 5. Seed database

```bash
npm run seed
```

This will:

1. Create demo users (admin + planner)
2. Import four CSV files from `apps/api/data/` (~3,200 taxonomy signals)
3. Generate 384-dim embeddings for every signal (first run downloads ~23 MB ONNX model to `.cache/transformers/`; ~20–25 seconds)

To backfill embeddings only (without re-importing CSVs):

```bash
npm run embed
```

### 6. Run the app

```bash
npm run dev
```

| Service | URL |
| --- | --- |
| Frontend | http://localhost:5173 |
| API health | http://localhost:4000/health |

---

## Design Decisions

### Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | React 19 + Vite 6 + React Router 7 | SPA for a chat UI; no SSR needed (auth-gated, no SEO) |
| Backend | Node.js 20 + Express 4 + TypeScript | Small REST surface; low framework overhead |
| Database | PostgreSQL 16 + pgvector + Prisma 6 | Relational persistence, JSONB for plan blobs, native ILIKE fallback, vector search in one store |
| Auth | JWT + bcrypt | Stateless tokens; two roles (`ADMIN`, `PLANNER`) |
| LLM | Groq (`llama-3.1-8b-instant`) | Fast, free tier, OpenAI-compatible API (swappable via env vars) |
| Embeddings | `all-MiniLM-L6-v2` (384-dim, in-process ONNX) | No API cost; sufficient for ~3k taxonomy rows at this scale |

### Why Postgres (not Redis or MySQL)

- **Redis** — good for caching, not a durable relational store. Conversations must be resumable; admins must inspect all plans.
- **MySQL** — lacks mature pgvector support and JSONB indexing used here.
- **Postgres** — handles both relational data and semantic search in one database.

### LLM is not the source of truth

The LLM interprets planner intent and selects from backend-provided candidates only. It never invents signal IDs.

**Up to 3 LLM calls per planner message:**

1. **Agent decision** — route to one action (`BUILD`, `REFINE`, `REMOVE`, `APPROVE`, `ESTIMATE`, etc.)
2. **Intent extraction** — structured `AudienceIntent` + `searchKeywords` for taxonomy lookup
3. **Signal selection** — pick signals from ranked candidates; every ID validated server-side against the candidate list

All LLM JSON is validated with **Zod**. On failure, the app falls back to deterministic keyword/vector ranking.

### Semantic taxonomy search (pgvector + ILIKE fallback)

| Stage | Strategy | When used |
| --- | --- | --- |
| Primary | pgvector cosine similarity (HNSW index, threshold 0.25) | Default — finds semantic matches ("weekend hikers" → `Backpacking/Hiking`) |
| Fallback | ILIKE across 9 text columns | Vector unavailable, embeddings not backfilled, or < 10 vector results |

Embeddings are pre-computed at seed time; queries are embedded in-process at search time. Vector results are re-ranked: `score = cosine_similarity × 10 + keyword_bonus`.

### Data model choices

- **Selected signals stored as JSONB** on `AudiencePlan` — one-row reads, no joins. Point-in-time snapshot; taxonomy renames don't propagate (acceptable for approved plans).
- **Conversations are resumable** — full message history persisted; planner can return later.
- **Role enforcement in API middleware** — not frontend-only.

### Privacy guardrails

Requests involving religion, ethnicity, race, health conditions, sexual orientation, disability, or political affiliation are flagged and blocked before LLM processing. Sensitive taxonomy signals are filtered from search results.

---

## Audience Size Estimation

No real reach/count data is provided, so the estimator is a **deterministic mock model** with documented assumptions. In production this would be replaced by a real measurement API.

### Core assumptions

| Assumption | Value |
| --- | --- |
| Base reachable population | 250,000,000 adults/devices |
| Full adult age span | 78 years |
| Age narrowing | Linear: `(max - min + 1) / 78`, clamped 8%–95% |
| Within same source | Probabilistic **OR** (alternative ways to match) |
| Across sources | Probabilistic **AND** (must match all constraint types) |
| Cross-source correlation lift | +15% per extra source, capped at 1.6× |
| Intersection ceiling | Cannot exceed smallest group's probability |
| Reach floor | 0.01% of age-adjusted base (~25k on default population) |
| Estimate format | Min–max range with ±15%–45% uncertainty band |
| Confidence score | 40%–90%; based on signal count, source diversity, match quality — **independent of reach** |

### Per-signal prevalence (derived from taxonomy CSVs)

| Source | Rule | Example |
| --- | --- | --- |
| `LOCATION` | Top-level → 12%; sub-category → 4% | "Retail" vs "Coffee Shops" |
| `TRANSACTION` | Depth 1→20%, 2→10%, 3→5%, 4→3% | Deeper hierarchy = narrower audience |
| `CONSUMER_GRAPH_FIELD` | `BOOL` → 20%; `INT` → 80%; `ALPHA` with N values → 1/N | Binary trait vs broad numeric field |
| `CONSUMER_GRAPH_VALUE` | 1 / parent field cardinality | Gender (2 values) → ~50%; Language (78 values) → ~1.3% |

### Estimation formula (summary)

```
effectiveBase = 250M × ageFraction
groupProbability = OR(prevalences within each source group)
audienceProbability = min(AND(groupProbabilities) × correlationLift, minGroupProbability)
reach = max(effectiveBase × audienceProbability, effectiveBase × 0.0001)
estimatedMin/Max = reach × (1 ± uncertainty)
```

**Properties:**

- Adding signals across sources **narrows** the audience (AND logic)
- Result is order-independent
- Confidence measures evidence quality, not reach magnitude

---

## Project Structure

```txt
audience-builder/
  apps/
    api/          ← Express API, Prisma, services, seed scripts
    web/          ← React SPA (chat, signal panel, admin)
  docker-compose.yml   ← pgvector/pgvector:pg16
  .cache/transformers/ ← ONNX model cache (git-ignored)
```

---

## API Endpoints (quick reference)

```txt
POST   /api/auth/login | /register
GET    /api/auth/me
GET    /api/conversations
POST   /api/conversations
GET    /api/conversations/:id
POST   /api/conversations/:id/messages
POST   /api/conversations/:id/estimate
POST   /api/conversations/:id/approve
POST   /api/conversations/:id/signals/remove
GET    /api/admin/users | /conversations | /taxonomy
```

---

## Known Tradeoffs

- Sample taxonomy CSVs are small; replace with full exports for production use
- HNSW index is approximate (~99% recall, not 100%); keyword bonus protects exact matches
- Embeddings run in-process (~150 MB); extract to a sidecar at higher traffic
- Estimate is mock sizing — no real count data in the brief
- LLM calls are synchronous (3–6s per message); streaming/background jobs would improve UX at scale
