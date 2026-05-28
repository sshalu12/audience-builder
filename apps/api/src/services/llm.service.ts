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

function extractJson(text: string) {
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const firstObject = cleaned.indexOf("{");
  const lastObject = cleaned.lastIndexOf("}");

  if (firstObject >= 0 && lastObject > firstObject) {
    return cleaned.slice(firstObject, lastObject + 1);
  }

  return cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

// Groq sometimes 400s when system + user messages are nested. Flattening the
// system instructions into the first user message is a documented workaround.
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

function getFirst(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }

  return undefined;
}

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
  ASK: "ASK_CLARIFICATION",
  CLARIFY: "ASK_CLARIFICATION",
  REPLY: "GENERAL_REPLY",
  GENERAL: "GENERAL_REPLY",
};

function normalizeAction(value: unknown) {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return actionAliases[normalized] ?? normalized;
}

function isTruthy(value: unknown) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["true", "yes", "y", "1"].includes(value.trim().toLowerCase());
}

function hasItems(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

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
    ASK_CLARIFICATION: "I need a bit more detail to continue.",
    GENERAL_REPLY: "How can I help with your audience?",
  };

  return replies[typeof action === "string" ? action : "GENERAL_REPLY"] ??
    replies.GENERAL_REPLY;
}

function inferAction(
  record: Record<string, unknown>,
  context?: AgentDecisionContext,
) {
  if (record.action !== undefined) return record.action;
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

// Maps the variety of field names different LLMs emit to the names the Zod
// schemas expect. This is the single place where we tolerate LLM aliasing.
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
const wrapperKeys = ["decision", "result", "response", "data", "output", "json"];

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

function errorStatus(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const maybeStatus = (error as { status?: unknown }).status;
  return typeof maybeStatus === "number" ? maybeStatus : null;
}

function useFallback<T>(input: GenerateJsonInput<T>, reason: string) {
  console.warn(
    `[LLM fallback] ${input.label ?? "generateJson"}: ${reason}`,
  );
  return input.fallback ?? null;
}

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
