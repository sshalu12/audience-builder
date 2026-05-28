# Scaling Problems & Solutions

## 1. Synchronous LLM blocking (3–6s wait per message)
**Problem:** `handlePlannerMessage` awaits 3 serial LLM calls before the HTTP response returns.  
**Fix:** Stream the routing reply (LLM #1) via SSE immediately. Move LLM #2 and #3 to a BullMQ background job; return 202 after saving the user message.

## 2. ONNX model inside the API process
**Problem:** `embedding.service.ts` loads ~150 MB of model weights into the API worker. Embedding requests block HTTP handling under concurrency.  
**Fix:** Extract into a dedicated embedding sidecar (Express or FastAPI). At low volume, swap to OpenAI `text-embedding-3-small` — zero in-process weight, one HTTP call.

## 3. Full conversation history loaded every turn
**Problem:** `prisma.conversation.findUnique({ include: { messages } })` fetches all messages with no limit. A 50-turn conversation loads 50 full JSONB rows on every message.  
**Fix:** Add `take: 15` to the messages query (agent only uses last 12 anyway). Add a Redis cache keyed by `conversationId` with a 5-minute TTL for hot conversations.

## 4. Rate-limit state is in-process memory
**Problem:** `rateLimitCooldownUntil` in `llm.service.ts` is a module-level variable. Multiple API instances each track their own cooldown independently — they don't share state.  
**Fix:** Store the cooldown in Redis: `SET groq:ratelimit:cooldown 1 EX 60`. All instances check the same key.

## 5. No job queue — all LLM calls hit Groq simultaneously
**Problem:** Under load, every user's request fires at Groq at the same time. No backpressure, no retry, no rate-limit coordination across instances.  
**Fix:** Add BullMQ (Redis-backed). Enqueue an `agent-reply` job per message. Workers process at a controlled concurrency (e.g., 5 parallel Groq calls max).


## 6. pgvector recall degrades at large taxonomy scale
**Problem:** Postgres is an incredible "general purpose" database. It is a jack-of-all-trades. But when you have over 1 million AI vectors, you are pushing Postgres to its absolute breaking point.

**Fix:** You stop using Postgres for AI searches entirely. You hire a "specialist"—databases like Qdrant or Weaviate. These are modern databases built from the ground up to do nothing else but AI vector math at massive, Google-level scales.

## 7. No real-time push — frontend polls for the reply
**Problem:** After posting a message the frontend either blocks on the HTTP response or must poll. No push mechanism.  
**Fix:** Add WebSocket support (`socket.io` or native `ws`). After the background job saves the assistant message, emit `message:created` to the conversation room. Frontend updates instantly.

---

