import OpenAI from "openai";
import type { z } from "zod";
import { config } from "../config.js";

const apiKey = config.groqApiKey;
const model = config.groqModel;

const client = apiKey
  ? new OpenAI({
      apiKey,
      baseURL: "https://api.groq.com/openai/v1",
    })
  : null;

if (!client) {
  console.warn(
    "[LLM] No GROQ_API_KEY configured. The agent will run in deterministic fallback mode.",
  );
}

const rateLimitCooldownMs = 60_000;
let rateLimitCooldownUntil = 0;

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AgentDecisionContext = {
  hasExistingPlan: boolean;
};

type GenerateJsonInput<T> = {
  label?: string;
  schema?: z.ZodTypeAny;
  fallback?: T;
  messages?: ChatMessage[];
  /** Used when label is agent-decision to infer action if the model omits it. */
  decisionContext?: AgentDecisionContext;
};

/** Strips markdown code fences and extracts the first {...} JSON object from LLM output. */
function extractJson(text: string) {
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const firstObject = cleaned.indexOf("{");
  const lastObject = cleaned.lastIndexOf("}");

  if (firstObject >= 0 && lastObject > firstObject) {
    return cleaned.slice(firstObject, lastObject + 1);
  }

  return cleaned;
}

/** Type guard — returns true only for plain objects (not null, not arrays). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tries to JSON.parse a string value; returns the original value if it fails or isn't a string. */
function parseMaybeJson(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(extractJson(value));
  } catch {
    return value;
  }
}

/**
 * When the LLM returns plain prose instead of JSON, wraps the text as a
 * GENERAL_REPLY decision so the conversation can still continue gracefully.
 */
function fallbackDecisionFromText(content: string) {
  const text = content.trim();
  if (!text) return null;

  return {
    action: "GENERAL_REPLY",
    assistantReply: text,
    audienceRequest: null,
    signalsToAdd: [],
    signalsToRemove: [],
    shouldEstimate: false,
    shouldApprove: false,
  };
}

/**
 * Merges all system messages into the first user message as plain text.
 * Groq occasionally rejects requests with a nested system+user structure (400);
 * this is the documented workaround for that API quirk.
 */
function flattenSystemIntoUser(messages: ChatMessage[]) {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");

  const rest = messages.filter((message) => message.role !== "system");

  if (!systemText) {
    return messages;
  }

  const firstUserIndex = rest.findIndex((message) => message.role === "user");

  if (firstUserIndex === -1) {
    return [
      { role: "user" as const, content: `${systemText}\n\nReturn valid JSON only.` },
      ...rest,
    ];
  }

  return rest.map((message, index) =>
    index === firstUserIndex
      ? {
          ...message,
          content: `${systemText}\n\n${message.content}\n\nReturn valid JSON only.`,
        }
      : message,
  );
}

/** Returns the value of the first key found in `record`; used for field-alias resolution. */
function getFirst(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }

  return undefined;
}

/** Coerces a bare string into a single-element array; leaves actual arrays untouched. */
function normalizeArray(value: unknown) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return value;
}

const actionAliases: Record<string, string> = {
  BUILD: "BUILD_AUDIENCE",
  CREATE: "BUILD_AUDIENCE",
  CREATE_AUDIENCE: "BUILD_AUDIENCE",
  REFINE: "REFINE_AUDIENCE",
  UPDATE: "REFINE_AUDIENCE",
  UPDATE_AUDIENCE: "REFINE_AUDIENCE",
  REMOVE: "REMOVE_SIGNAL",
  DELETE_SIGNAL: "REMOVE_SIGNAL",
  ADD: "ADD_SIGNAL",
  APPROVE: "APPROVE_AUDIENCE",
  ESTIMATE: "ESTIMATE_AUDIENCE",
  SIZE_AUDIENCE: "ESTIMATE_AUDIENCE",
  SHOW: "SHOW_SELECTED_SIGNALS",
  LIST: "SHOW_SELECTED_SIGNALS",
  DISPLAY: "SHOW_SELECTED_SIGNALS",
  SHOW_SIGNALS: "SHOW_SELECTED_SIGNALS",
  SHOW_SELECTED: "SHOW_SELECTED_SIGNALS",
  EXPLAIN: "EXPLAIN_CURRENT_DRAFT",
  DESCRIBE: "EXPLAIN_CURRENT_DRAFT",
  SUMMARIZE: "EXPLAIN_CURRENT_DRAFT",
  REVIEW_LOW_CONFIDENCE: "REVIEW_LOW_CONFIDENCE_SIGNALS",
  ASK: "ASK_CLARIFICATION",
  CLARIFY: "ASK_CLARIFICATION",
  REPLY: "GENERAL_REPLY",
  GENERAL: "GENERAL_REPLY",
};

/** Maps LLM action aliases (e.g. "BUILD", "CREATE") to canonical enum values (e.g. "BUILD_AUDIENCE"). */
function normalizeAction(value: unknown) {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return actionAliases[normalized] ?? normalized;
}

/** Returns true for boolean true or string "true"/"yes"/"y"/"1" — handles LLM boolean stringification. */
function isTruthy(value: unknown) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["true", "yes", "y", "1"].includes(value.trim().toLowerCase());
}

/** Returns true if value is a non-empty array or a non-empty string. */
function hasItems(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns a canned one-line assistant reply for each action type when the LLM omits assistantReply. */
function defaultAssistantReplyForAction(record: Record<string, unknown>) {
  const action =
    typeof record.action === "string"
      ? normalizeAction(record.action)
      : "GENERAL_REPLY";

  const replies: Record<string, string> = {
    REMOVE_SIGNAL:
      "I will remove the matching signal(s) from the current draft audience.",
    REFINE_AUDIENCE:
      "I will refine the current draft audience using taxonomy-backed signals.",
    BUILD_AUDIENCE: "I will build a draft audience from your request.",
    APPROVE_AUDIENCE:
      "I will approve this audience and calculate the reachable audience size.",
    ESTIMATE_AUDIENCE: "I will estimate the current draft audience.",
    ADD_SIGNAL: "I will add signals to the current draft audience.",
    SHOW_SELECTED_SIGNALS: "I will show the selected signals in the current draft.",
    EXPLAIN_CURRENT_DRAFT: "I will explain the current draft audience.",
    REVIEW_LOW_CONFIDENCE_SIGNALS:
      "I will review the current draft for low-confidence signals.",
    ASK_CLARIFICATION: "I need a bit more detail to continue.",
    GENERAL_REPLY: "How can I help with your audience?",
  };

  return replies[typeof action === "string" ? action : "GENERAL_REPLY"] ??
    replies.GENERAL_REPLY;
}

/**
 * Infers the `action` field from other present fields when the LLM omits it.
 * Checks flags in priority order: needsMoreInfo → shouldApprove → shouldEstimate
 * → signalsToRemove → signalsToAdd → audienceRequest → assistantReply.
 */
function inferAction(
  record: Record<string, unknown>,
  context?: AgentDecisionContext,
) {
  if (record.action !== undefined) return record.action;
  if (isTruthy(record.needsMoreInfo)) return "ASK_CLARIFICATION";
  if (isTruthy(record.shouldApprove)) return "APPROVE_AUDIENCE";
  if (isTruthy(record.shouldEstimate)) return "ESTIMATE_AUDIENCE";
  if (hasItems(record.signalsToRemove)) return "REMOVE_SIGNAL";
  if (hasItems(record.signalsToAdd)) {
    return context?.hasExistingPlan ? "REFINE_AUDIENCE" : "ADD_SIGNAL";
  }
  if (record.audienceRequest !== undefined && record.audienceRequest !== null) {
    return context?.hasExistingPlan ? "REFINE_AUDIENCE" : "BUILD_AUDIENCE";
  }
  if (record.assistantReply !== undefined) return "GENERAL_REPLY";
  return undefined;
}

// Maps every alternate field name an LLM might emit to the canonical name the
// Zod schemas expect. All LLM aliasing is handled here — nowhere else.
const fieldAliases: Record<string, string[]> = {
  action: ["action", "decisionAction", "nextAction", "type"],
  assistantReply: [
    "assistantReply",
    "reply",
    "message",
    "assistantMessage",
    "responseText",
    "text",
  ],
  audienceRequest: [
    "audienceRequest",
    "request",
    "plannerRequest",
    "query",
    "audience",
  ],
  signalsToAdd: [
    "signalsToAdd",
    "addSignals",
    "signalsToInclude",
    "includeSignals",
    "add",
  ],
  signalsToRemove: [
    "signalsToRemove",
    "removeSignals",
    "signalsToExclude",
    "excludeSignals",
    "remove",
  ],
  shouldEstimate: [
    "shouldEstimate",
    "estimate",
    "estimateAudience",
    "shouldSize",
  ],
  shouldApprove: ["shouldApprove", "approve", "approveAudience"],
  needsMoreInfo: [
    "needsMoreInfo",
    "requiresMoreInfo",
    "needsClarification",
    "clarificationNeeded",
  ],
  ageRange: ["ageRange", "age", "ages"],
  audienceName: ["audienceName", "name", "title", "segmentName"],
  summary: ["summary", "description"],
  recommendedSignals: [
    "recommendedSignals",
    "signals",
    "selectedSignals",
    "recommendations",
  ],
};

const arrayFields = new Set(["signalsToAdd", "signalsToRemove"]);

/**
 * Normalises a single LLM response candidate: resolves field aliases to
 * canonical names, normalises the action value, infers a missing action,
 * and fills in a default assistantReply when the decision context is set.
 */
function normalizeCandidate(
  value: unknown,
  decisionContext?: AgentDecisionContext,
): unknown {
  const parsed = parseMaybeJson(value);
  if (!isRecord(parsed)) {
    return parsed;
  }

  const next: Record<string, unknown> = { ...parsed };

  for (const [canonical, aliases] of Object.entries(fieldAliases)) {
    const found = getFirst(next, aliases);
    if (found === undefined) continue;

    next[canonical] =
      canonical === "action"
        ? normalizeAction(found)
        : arrayFields.has(canonical)
          ? normalizeArray(found)
          : found;
  }

  const inferred = inferAction(next, decisionContext);
  if (inferred !== undefined) {
    next.action = normalizeAction(inferred);
  }

  if (decisionContext) {
    const reply = next.assistantReply;
    if (typeof reply !== "string" || !reply.trim()) {
      next.assistantReply = defaultAssistantReplyForAction(next);
    }
  }

  return next;
}

// LLMs sometimes wrap the payload in an envelope key (e.g. `{ decision: {…} }`).
// Try the original payload first, then each known wrapper.
const wrapperKeys = [
  "decision",
  "result",
  "response",
  "data",
  "output",
  "outputShape",
  "json",
];

/**
 * Returns all normalised candidate payloads to try Zod validation against.
 * Includes the top-level object and any values found under known wrapper keys
 * (e.g. { decision: {...} }) since different LLMs use different envelope shapes.
 */
function candidatePayloads(
  parsed: unknown,
  decisionContext?: AgentDecisionContext,
) {
  const candidates: unknown[] = [normalizeCandidate(parsed, decisionContext)];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    for (const key of wrapperKeys) {
      if (key in candidate) {
        candidates.push(normalizeCandidate(candidate[key], decisionContext));
      }
    }
  }

  return candidates;
}

/** Safely extracts the HTTP status code from an API error object, or returns null. */
function errorStatus(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const maybeStatus = (error as { status?: unknown }).status;
  return typeof maybeStatus === "number" ? maybeStatus : null;
}

/** Logs a warning with the reason and returns the caller-provided fallback value (or null). */
function useFallback<T>(input: GenerateJsonInput<T>, reason: string) {
  console.warn(
    `[LLM fallback] ${input.label ?? "generateJson"}: ${reason}`,
  );
  return input.fallback ?? null;
}

/**
 * EXPORTED — Core LLM call. Sends messages to Groq and returns a validated,
 * typed JSON response.
 *
 * Handles all failure modes in order:
 *  - No client / no messages / rate-limit cooldown → fallback immediately.
 *  - 400 from Groq → retry once with system prompt flattened into user message.
 *  - 413 (payload too large) → fallback.
 *  - LLM returns plain text instead of JSON → coerce to GENERAL_REPLY if
 *    it's an agent-decision call, otherwise fallback.
 *  - JSON parses but fails Zod validation → try all candidate payloads
 *    (including envelope-unwrapped variants) before falling back.
 *  - 429 rate limit → set 60-second cooldown, fallback.
 *  - Any other 4xx → fallback with diagnostic message.
 */
export async function generateJson<T>(
  input: GenerateJsonInput<T>,
): Promise<T | null> {
  if (!client) {
    return useFallback(input, "LLM client is not configured.");
  }

  if (!input.messages?.length) {
    return useFallback(input, "No messages provided to LLM call.");
  }

  if (Date.now() < rateLimitCooldownUntil) {
    return useFallback(input, "Rate limit cooldown active.");
  }

  try {
    let completion;
    try {
      completion = await client.chat.completions.create({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: input.messages,
      });
    } catch (error) {
      if (errorStatus(error) === 413) {
        return useFallback(input, "Request was too large (413).");
      }

      if (errorStatus(error) === 400) {
        console.warn(
          `[LLM] ${input.label ?? "generateJson"}: Groq rejected message shape (400). Retrying with flattened system prompt.`,
        );
        completion = await client.chat.completions.create({
          model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: flattenSystemIntoUser(input.messages),
        });
      } else {
        throw error;
      }
    }

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      return useFallback(input, "Empty completion content.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(content));
    } catch {
      const decision = fallbackDecisionFromText(content);
      if (input.label === "agent-decision" && input.schema && decision) {
        const result = input.schema.safeParse(decision);
        if (result.success) {
          console.warn(
            `[LLM] ${input.label}: Non-JSON content from LLM; coerced into GENERAL_REPLY.`,
          );
          return result.data;
        }
      }

      return useFallback(input, "Non-JSON content returned by LLM.");
    }

    if (input.schema) {
      let lastIssues: z.ZodIssue[] = [];

      for (const candidate of candidatePayloads(parsed, input.decisionContext)) {
        const result = input.schema.safeParse(candidate);
        if (result.success) {
          return result.data;
        }
        lastIssues = result.error.issues;
      }

      return useFallback(
        input,
        `Schema validation failed: ${JSON.stringify(lastIssues)}`,
      );
    }

    return parsed as T;
  } catch (error) {
    const status = errorStatus(error);

    if (status === 429) {
      rateLimitCooldownUntil = Date.now() + rateLimitCooldownMs;
      return useFallback(
        input,
        "Rate limit reached (429). Cooling down for 60s.",
      );
    }

    if (status && status >= 400 && status < 500) {
      return useFallback(
        input,
        `Groq returned a 4xx client error (${status}). Check GROQ_API_KEY, GROQ_MODEL, and request payload.`,
      );
    }

    return useFallback(
      input,
      `Request failed with status ${status ?? "unknown"}.`,
    );
  }
}
