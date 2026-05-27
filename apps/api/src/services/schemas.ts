import { z } from "zod";

export const AgeRangeSchema = z
  .object({
    min: z.number().int().nullable(),
    max: z.number().int().nullable(),
  })
  .nullable();



export const AudienceIntentSchema = z.object({
  ageRange: AgeRangeSchema,
  demographics: z.array(z.string()).default([]),
  interests: z.array(z.string()).default([]),
  behaviors: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  transactions: z.array(z.string()).default([]),
  exclusions: z.array(z.string()).default([]),
  sensitiveRequest: z.boolean().default(false),
  safeAlternative: z.string().nullable().default(null),
  clarificationNeeded: z.boolean().default(false),
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
  audienceName: z.string(),
  summary: z.string(),
  recommendedSignals: z.array(RecommendedSignalSchema).default([]),
  rejectedSignals: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        reason: z.string(),
      })
    )
    .default([]),
  clarificationNeeded: z.boolean().default(false),
  clarificationQuestion: z.string().nullable().default(null),
});

export type AudienceRecommendation = z.infer<typeof AudienceRecommendationSchema>;

export const AudienceEstimateSchema = z.object({
  estimatedMin: z.number().int(),
  estimatedMax: z.number().int(),
  confidence: z.number().min(0).max(1),
  methodology: z.string(),
  assumptions: z.array(z.string()),
});

export type AudienceEstimate = z.infer<typeof AudienceEstimateSchema>;
export const AgentDecisionSchema = z.object({
  action: z.enum([
    "GENERAL_REPLY",
    "BUILD_AUDIENCE",
    "REFINE_AUDIENCE",
    "REMOVE_SIGNAL",
    "ADD_SIGNAL",
    "APPROVE_AUDIENCE",
    "ESTIMATE_AUDIENCE",
    "ASK_CLARIFICATION",
  ]),
  assistantReply: z.string(),
  audienceRequest: z
  .union([
    z.string(),
    z.object({
      text: z.string(),
    }),
  ])
  .nullable()
  .optional()
  .transform((value) => {
    if (!value) return null;

    if (typeof value === "string") {
      return value;
    }

    return value.text;
  }),
  signalsToAdd: z
  .array(z.string())
  .nullable()
  .default([])
  .transform((v) => v ?? []),

signalsToRemove: z
  .array(z.string())
  .nullable()
  .default([])
  .transform((v) => v ?? []),
  shouldEstimate: z.boolean().default(false),
  shouldApprove: z.boolean().default(false),
});

export type AgentDecision = z.infer<
  typeof AgentDecisionSchema
>;