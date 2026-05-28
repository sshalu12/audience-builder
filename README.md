# Chat-Based Audience Builder

A TypeScript full-stack take-home project for building advertising audiences through chat.

Media planners describe who they want to reach in plain English. The app interprets the request, searches the provided targeting taxonomy, recommends structured targeting signals, lets the planner refine or approve the plan, and then estimates reachable audience size.

## Demo Credentials

After seeding the database:

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@example.com` | `password123` |
| Planner | `planner@example.com` | `password123` |

## What This Implements

- React + TypeScript frontend
- Node.js + Express + TypeScript backend
- PostgreSQL + Prisma persistence
- JWT authentication
- Admin and planner roles
- Persisted conversations and messages
- Taxonomy import from CSV files
- Optional Google Sheets CSV download script
- LLM-based intent extraction and signal selection when `GROQ_API_KEY` is provided (Groq, via its OpenAI-compatible endpoint)
- Deterministic local fallback agent when no LLM key is configured or Groq returns invalid JSON
- Taxonomy-grounded signal recommendations
- Editable selected signals
- Deterministic mock audience estimation with documented assumptions
- Admin dashboard for users, conversations, and taxonomy preview

## Architecture

For the full data-layer rationale (why Postgres + Prisma, why Redis is not a primary-store replacement, where a cache could be added later) see [ARCHITECTURE.md](./ARCHITECTURE.md).

```txt
React/Vite Web App
        |
        | HTTP + JWT
        v
Node/Express API
        |
        | Prisma
        v
PostgreSQL
        |
        +-- TaxonomySignal table
        +-- Conversation / Message / AudiencePlan tables
        +-- User / Role tables

LLM flow:
User message
  -> extract structured audience intent
  -> search taxonomy tables
  -> send candidate taxonomy signals to LLM
  -> validate structured JSON
  -> save draft audience plan
  -> estimate when approved
```

The LLM is intentionally **not** the source of truth for targeting signals. It interprets planner intent and chooses from backend-provided taxonomy candidates only.

## Project Structure

```txt
audience-builder/
  apps/
    api/
      prisma/schema.prisma
      data/*.csv
      src/
        routes/
        services/
        middleware/
        scripts/
    web/
      src/
        pages/
        components/
        context/
        api/
  docker-compose.yml
  package.json
  README.md
```

## Local Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start Postgres

```bash
docker compose up -d
```

### 3. Configure environment variables

Create an API env file:

```bash
cp apps/api/.env.example apps/api/.env
```

Create a web env file:

```bash
cp apps/web/.env.example apps/web/.env
```

Default local API settings:

```env
DATABASE_URL="postgresql://audience_builder:audience_builder@localhost:5432/audience_builder?schema=public"
JWT_SECRET="replace-with-a-long-random-secret"
PORT=4000
CORS_ORIGIN="http://localhost:5173"
GROQ_API_KEY=""
GROQ_MODEL="llama-3.1-8b-instant"
```

`GROQ_API_KEY` is optional. If it is blank, the app still works using a deterministic local fallback agent. Get a key at <https://console.groq.com/keys>. The LLM client targets Groq's OpenAI-compatible endpoint (`https://api.groq.com/openai/v1`).

### 4. Run Prisma migration

```bash
npm run prisma:migrate
```

### 5. Seed demo users and taxonomy data

```bash
npm run seed
```

The seed script imports the CSV files in `apps/api/data` and creates the demo users.

### 6. Run the app

```bash
npm run dev
```

Open:

```txt
http://localhost:5173
```

API health check:

```txt
http://localhost:4000/health
```

## Taxonomy Data

The exercise provides four Google Sheets tabs:

| Sheet | Meaning |
| --- | --- |
| `location_taxonomy` | Location visit categories: where people physically go |
| `transaction_taxonomy` | Purchase categories: what people buy |
| `cg_data_dictionary` | Consumer graph fields: who people are |
| `cg_field_values` | Lookup values for coded consumer graph fields |

This project includes sample CSVs based on the provided screenshots so the app runs immediately. For the full dataset, export or download the four sheets as CSV and replace these files:

```txt
apps/api/data/location_taxonomy.csv
apps/api/data/transaction_taxonomy.csv
apps/api/data/cg_data_dictionary.csv
apps/api/data/cg_field_values.csv
```

Then run:

```bash
npm run seed
```

### Optional Google Sheets Download

If the Google Sheet is accessible by link, set:

```env
GOOGLE_SHEET_ID="your-google-sheet-id"
```

Then run:

```bash
npm run fetch:taxonomy
npm run seed
```

The download script uses the public CSV export endpoint for these sheet names:

```txt
location_taxonomy
transaction_taxonomy
cg_data_dictionary
cg_field_values
```

## Conversation Flow

Example planner request:

```txt
fitness enthusiasts aged 25-44 with premium shopping habits
```

The backend flow is:

1. Save the user message.
2. Extract structured intent:
   - age range
   - demographics
   - interests
   - behaviors
   - locations
   - transaction categories
   - exclusions
3. Search the normalized taxonomy table.
4. Ask the LLM to choose from only those taxonomy candidates, or use the deterministic fallback if no API key is set.
5. Save the recommended draft audience plan.
6. Let the planner remove signals, add signals from taxonomy search, ask for changes, estimate, or approve.
7. On approval, save the estimate and mark the conversation approved.

## LLM Design

There are two LLM steps in `apps/api/src/services/audienceAgent.service.ts`:

### 1. Intent Extraction

The assistant converts the raw message into a structured object:

```ts
type AudienceIntent = {
  ageRange: { min: number | null; max: number | null } | null;
  demographics: string[];
  interests: string[];
  behaviors: string[];
  locations: string[];
  transactions: string[];
  exclusions: string[];
  sensitiveRequest: boolean;
  safeAlternative: string | null;
  clarificationNeeded: boolean;
  clarificationQuestion: string | null;
};
```

### 2. Signal Recommendation

The backend searches `TaxonomySignal` first, then passes candidates to the LLM. The LLM must return selected signals using only candidate IDs.

LLM responses are validated with Zod before being used. If the response is invalid or the API fails, the app falls back to deterministic ranking.

## Privacy and Safety Guardrails

The app avoids recommending sensitive targeting signals. Requests involving traits such as religion, ethnicity, race, medical condition, sexual orientation, disability, or political affiliation are flagged and redirected toward privacy-safe behavioral alternatives.

The taxonomy import preserves all rows, but recommendation search filters out sensitive matches by default.

## Audience Size Estimation

No real audience count data is provided in the exercise, so the estimator is a deterministic, probabilistic model. To stay grounded, **per-signal prevalence is derived directly from the four provided CSVs** rather than hardcoded source priors:

| Provided data                | What it tells us                              | Prevalence used                                                |
| ---------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| `location_taxonomy.csv`      | Hierarchical visit categories (2 levels)      | Top-level only → ~12%, sub-category → ~4%                      |
| `transaction_taxonomy.csv`   | Purchase categories (4-level hierarchy)       | Depth 1 → 0.20, 2 → 0.10, 3 → 0.05, 4 → 0.03 (deeper = narrower)|
| `cg_data_dictionary.csv`     | Field Type + `Attributes` (= value cardinality) | `BOOL` → 0.20, `INT` → 0.80, `ALPHA(_NUM)` with N values → 1/N |
| `cg_field_values.csv`        | Specific value of a parent field              | 1 / (parent field's `Attributes`) — e.g. gender = 2 values → 50% |

The estimator then treats the selected signals as an **intersection (AND)** of constraints, which matches how planners think about audiences (fitness AND premium AND 25-44):

1. Start from a base reachable population of 250M adults/devices.
2. Narrow the base by the requested age range first.
3. Look up each signal's taxonomy row and assign its prevalence from the table above.
4. Group signals by source (`LOCATION`, `TRANSACTION`, `CONSUMER_GRAPH_FIELD`, `CONSUMER_GRAPH_VALUE`).
5. Within a group, combine signals as **OR** (multiple fitness signals are alternative ways to identify the same audience).
6. Across groups, combine as **AND** with a small correlation lift (capped at the smallest group's probability, so no single constraint can be exceeded).
7. Compute a min/max band and a confidence score derived from signal count, source diversity, and average per-signal match confidence.

Properties:

- Adding more signals across sources **narrows** the audience, instead of inflating it.
- The result is independent of signal iteration order.
- Confidence is a quality score over the evidence and is decoupled from the reach number itself.

In production, `estimateAudienceSize` would be replaced with real reach/count APIs; the data-driven priors above are what we can defensibly compute from the exercise's inputs.

## Roles and Permissions

### Planner

- Create conversations
- View their own conversations
- Send chat messages
- Review and modify selected signals
- Estimate and approve their own audience plans

### Admin

- View all conversations
- View all users
- Preview imported taxonomy data
- Use the same conversation builder functionality

Role enforcement happens in the API middleware, not only in the frontend.

## Useful API Endpoints

```txt
POST   /api/auth/login
POST   /api/auth/register
GET    /api/auth/me

GET    /api/conversations
POST   /api/conversations
GET    /api/conversations/:id
POST   /api/conversations/:id/messages
POST   /api/conversations/:id/estimate
POST   /api/conversations/:id/approve
POST   /api/conversations/:id/signals/remove

GET    /api/admin/users
GET    /api/admin/conversations
GET    /api/admin/taxonomy
```

## Deployment Notes

Suggested free-tier deployment:

```txt
Frontend: Vercel
Backend: Render or Railway
Database: Supabase Postgres, Neon, Railway Postgres, or Render Postgres
```

### Backend deployment

Set these environment variables on the backend host:

```env
DATABASE_URL="your-production-postgres-url"
JWT_SECRET="long-random-secret"
PORT=4000
CORS_ORIGIN="https://your-frontend-domain.vercel.app"
GROQ_API_KEY="optional"
GROQ_MODEL="llama-3.1-8b-instant"
```

Build command:

```bash
npm install && npm run build -w apps/api
```

Start command:

```bash
npm run start -w apps/api
```

Run migrations and seed once:

```bash
npm run prisma:deploy -w apps/api
npm run seed -w apps/api
```

### Frontend deployment

Set:

```env
VITE_API_BASE_URL="https://your-api-host.com/api"
```

Build command:

```bash
npm install && npm run build -w apps/web
```

Output directory:

```txt
apps/web/dist
```

## Tradeoffs

- The sample taxonomy files are small and based on screenshots. Replace them with the full CSV exports for a real submission.
- The LLM orchestration uses simple JSON mode plus Zod validation. A production system could use stricter structured-output APIs and retry logic.
- The taxonomy search is keyword/synonym based. A production version could add embeddings, full-text search, BM25, or hybrid retrieval.
- The estimate is deterministic mock sizing because no count data was provided.
- The UI is functional rather than pixel-perfect, per the assignment instructions.

## Future Improvements

- Add streaming assistant responses
- Add audit logs for audience approvals
- Add full-text or vector search over taxonomy rows
- Add more robust conversational edit actions
- Add signal grouping and boolean logic: include, exclude, AND/OR
- Add real audience reach/count integration
- Add tests for authorization, estimator, taxonomy import, and agent output validation

## Troubleshooting npm install

If `npm install` fails with `Exit handler never called` or `ETIMEDOUT` while trying to fetch packages, first make sure the project is using the public npm registry and a stable Node version:

```bash
nvm install 22
nvm use 22
npm config set registry https://registry.npmjs.org/
rm -rf node_modules package-lock.json
npm install
```

The project can regenerate `package-lock.json` locally. If you use the included lockfile, its resolved package URLs should point to `https://registry.npmjs.org/`.
