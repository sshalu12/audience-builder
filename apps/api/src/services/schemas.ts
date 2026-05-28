import { z } from "zod";

const BooleanishSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;

  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(normalized)) return true;
  if (["false", "no", "n", "0"].includes(normalized)) return false;

  return value;
}, z.boolean());

export const AgeRangeSchema = z
  .object({
    min: z.coerce.number().int().nullable(),
    max: z.coerce.number().int().nullable(),
  })
  .nullable();

export const AudienceIntentSchema = z.object({
  ageRange: AgeRangeSchema.default(null),
  demographics: z.array(z.string()).default([]),
  interests: z.array(z.string()).default([]),
  behaviors: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  transactions: z.array(z.string()).default([]),
  exclusions: z.array(z.string()).default([]),
  sensitiveRequest: BooleanishSchema.default(false),
  safeAlternative: z.string().nullable().default(null),
  clarificationNeeded: BooleanishSchema.default(false),
  clarificationQuestion: z.string().nullable().default(null),
  requestedSignalCount: z.coerce.number().nullable().optional(),
  searchKeywords: z.array(z.string()).default([]),
});

export type AudienceIntent = z.infer<typeof AudienceIntentSchema>;

export const RecommendedSignalSchema = z.object({
  id: z.string(),
  source: z.enum([
    "LOCATION",
    "TRANSACTION",
    "CONSUMER_GRAPH_FIELD",
    "CONSUMER_GRAPH_VALUE",
  ]),
  name: z.string(),
  path: z.string().nullable().optional(),
  confidence: z.coerce.number(),
  rationale: z.string(),
});

export type RecommendedSignal = z.infer<typeof RecommendedSignalSchema>;

export const AudienceRecommendationSchema = z.object({
  audienceName: z.string().default("Draft audience"),
  summary: z
    .string()
    .default(
      "Matched the request to taxonomy-backed targeting signals from the available catalog.",
    ),
  recommendedSignals: z.array(RecommendedSignalSchema).default([]),
  rejectedSignals: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
  clarificationNeeded: BooleanishSchema.default(false),
  clarificationQuestion: z.string().nullable().default(null),
});

export type AudienceRecommendation = z.infer<typeof AudienceRecommendationSchema>;

export type AudienceEstimate = {
  estimatedMin: number;
  estimatedMax: number;
  confidence: number;
  methodology: string;
  assumptions: string[];
};

export const AgentDecisionSchema = z.object({
  action: z.enum([
    "GENERAL_REPLY",
    "BUILD_AUDIENCE",
    "REFINE_AUDIENCE",
    "REMOVE_SIGNAL",
    "ADD_SIGNAL",
    "APPROVE_AUDIENCE",
    "ESTIMATE_AUDIENCE",
    "SHOW_SELECTED_SIGNALS",
    "EXPLAIN_CURRENT_DRAFT",
    "REVIEW_LOW_CONFIDENCE_SIGNALS",
    "ASK_CLARIFICATION",
  ]),
  assistantReply: z.string().default(""),
  audienceRequest: z
    .union([z.string(), z.object({ text: z.string() })])
    .nullable()
    .optional()
    .transform((value) => {
      if (!value) return null;
      if (typeof value === "string") return value;
      return value.text;
    }),
  signalsToAdd: z
    .array(z.string())
    .nullable()
    .default([])
    .transform((value) => value ?? []),
  signalsToRemove: z
    .array(z.string())
    .nullable()
    .default([])
    .transform((value) => value ?? []),
  needsMoreInfo: BooleanishSchema.default(false),
  shouldEstimate: BooleanishSchema.default(false),
  shouldApprove: BooleanishSchema.default(false),
});

export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
