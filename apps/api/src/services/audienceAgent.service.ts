import {
  AudienceStatus,
  ConversationStatus,
  MessageRole,
} from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../utils/httpError.js";
import { estimateAudienceSize } from "./estimate.service.js";
import { generateStructuredJson } from "./llm.service.js";
import { isSensitiveText, sensitiveRequestMessage } from "./privacy.service.js";
import {
  AgentDecisionSchema,
  AudienceIntentSchema,
  AudienceRecommendationSchema,
  type AgentDecision,
  type AudienceEstimate,
  type AudienceIntent,
  type AudienceRecommendation,
  type RecommendedSignal,
} from "./schemas.js";
import {
  cleanDisplayText,
  keywordsFromIntent,
  searchTaxonomyByKeywords,
  type RankedTaxonomySignal,
} from "./taxonomy.service.js";

const approvalPattern =
  /\b(approve|approved|confirm|confirmed|looks good|ship it)\b/i;

const estimatePattern = /\b(estimate|size|reachable|reach)\b/i;

const removePattern = /\bremove\s+(.+)$/i;

const defaultLowConfidenceThreshold = 0.75;

function titleFromMessage(message: string) {
  const cleaned = message.replace(/\s+/g, " ").trim();
  return cleaned.length > 70 ? `${cleaned.slice(0, 67)}...` : cleaned;
}

function cleanPlannerMessage(message: string) {
  const assistantMarkers = [
    "I created a draft audience:",
    "Recommended signals:",
    "Recommended taxonomy-backed signals:",
    "Added taxonomy-backed signals:",
    "You can approve this audience",
    "Mock estimate generated",
    "Estimated reachable audience",
  ];

  const looksLikeCopiedAssistantMessage = assistantMarkers.some((marker) =>
    message.includes(marker),
  );

  if (!looksLikeCopiedAssistantMessage) {
    return message.trim();
  }

  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const lastIntent = [...lines].reverse().find((line) =>
    /\b(estimate|approve|remove|add|broader|narrower|focus|refine|include|exclude|show|list)\b/i.test(
      line,
    ),
  );

  return lastIntent ?? message.trim();
}

function normalizeAudienceRequest(value: unknown, fallback: string) {
  if (!value) return fallback;

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    const maybeText = value as {
      text?: unknown;
      request?: unknown;
      query?: unknown;
      audience?: unknown;
    };

    if (typeof maybeText.text === "string") return maybeText.text;
    if (typeof maybeText.request === "string") return maybeText.request;
    if (typeof maybeText.query === "string") return maybeText.query;
    if (typeof maybeText.audience === "string") return maybeText.audience;

    return JSON.stringify(value);
  }

  return fallback;
}

function requestedAdditionalSignalCount(message: string) {
  const lower = message.toLowerCase();

  const digitMatch =
    lower.match(
      /\b(?:add|include|recommend|show|give me)?\s*(\d{1,2})\s+(?:more|additional|new)\s*(?:audiences?|signals?|segments?|targets?)?\b/,
    ) ||
    lower.match(
      /\b(?:audiences?|signals?|segments?|targets?)\s*(?:of same category)?\s*(\d{1,2})\b/,
    );

  if (digitMatch?.[1]) {
    const count = Number(digitMatch[1]);
    if (Number.isFinite(count)) {
      return Math.max(1, Math.min(count, 20));
    }
  }

  const numberWords: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };

  const wordMatch = lower.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:more|additional|new)\b/,
  );

  if (wordMatch?.[1]) {
    return numberWords[wordMatch[1]];
  }

  if (/\b(add|include|recommend)\s+more\b/.test(lower)) {
    return 3;
  }

  return null;
}

function isListSelectedSignalsRequest(message: string) {
  const lower = message.toLowerCase();

  return (
    /\b(show|list|display|retrieve|get|see|view)\b.*\b(all|current|selected|added)\b.*\b(audiences?|signals?|segments?|targets?)\b/.test(
      lower,
    ) ||
    /\b(all|current|selected|added)\b.*\b(audiences?|signals?|segments?|targets?)\b/.test(
      lower,
    ) ||
    /\bwhat\b.*\b(audiences?|signals?|segments?|targets?)\b.*\b(added|selected|current)\b/.test(
      lower,
    ) ||
    /\bwhat have i added\b/.test(lower)
  );
}

function isLowConfidenceReviewRequest(message: string) {
  const lower = message.toLowerCase();

  return (
    /\b(low confidence|low-confidence|weak confidence|weak signals|lowest confidence|poor confidence)\b/.test(
      lower,
    ) &&
    /\b(remove|delete|drop|clean|clean up|review|find|show|which)\b/.test(lower)
  );
}

function isAffirmativeConfirmation(message: string) {
  return /^(yes|yep|yeah|sure|ok|okay|confirm|confirmed|remove|remove it|delete|delete it|do it|please remove|go ahead)\b/i.test(
    message.trim(),
  );
}

function isNegativeConfirmation(message: string) {
  return /^(no|nope|cancel|keep|keep them|do not|don't|stop)\b/i.test(
    message.trim(),
  );
}

function confidenceThresholdFromMessage(message: string) {
  const lower = message.toLowerCase();

  const match = lower.match(
    /\b(?:below|under|less than|lower than)\s*(\d{1,3})(?:\s*%|\s*percent)?\b/,
  );

  if (!match?.[1]) {
    return defaultLowConfidenceThreshold;
  }

  const raw = Number(match[1]);

  if (!Number.isFinite(raw)) {
    return defaultLowConfidenceThreshold;
  }

  const threshold = raw > 1 ? raw / 100 : raw;

  return Math.max(0.1, Math.min(threshold, 0.95));
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function fallbackIntentFromMessage(message: string): AudienceIntent {
  const lower = message.toLowerCase();
  const ageMatch = lower.match(/(\d{2})\s*(?:-|to|through)\s*(\d{2})/);

  const interests: string[] = [];
  const behaviors: string[] = [];
  const locations: string[] = [];
  const transactions: string[] = [];
  const demographics: string[] = [];
  const exclusions: string[] = [];

  if (/fitness|gym|exercise|running|hiking|yoga|health/.test(lower)) {
    interests.push("fitness");
    locations.push("fitness centers", "gyms");
    transactions.push("athletic apparel", "sporting goods", "running");
  }

  if (/premium|luxury|affluent|high income|upscale/.test(lower)) {
    behaviors.push("premium shopping", "luxury shopping", "affluent lifestyle");
    transactions.push("premium retail", "luxury goods");
    demographics.push("household income");
  }

  if (/parent|parents|moms|dads|kids|children|family/.test(lower)) {
    demographics.push("household with kids", "parents");
    interests.push("family parenting");
  }

  if (/auto|car|cars|suv|vehicle|dealership|automotive/.test(lower)) {
    interests.push("automotive", "cars");
    locations.push("car dealerships", "auto dealers");
    transactions.push("automotive", "SUV", "vehicle owners", "car accessories");
  }

  if (/coffee|cafe|cafes/.test(lower)) {
    interests.push("coffee");
    locations.push("cafes", "coffee shops");
    transactions.push("coffee", "dining out");
  }

  if (/organic|grocery|supermarket|healthy food/.test(lower)) {
    interests.push("healthy food");
    locations.push("grocery stores", "supermarkets");
    transactions.push("organic grocery", "grocery");
  }

  if (/travel|traveler|airport|hotel/.test(lower)) {
    interests.push("travel");
    locations.push("airports", "hotels");
    transactions.push("travel", "lodging");
  }

  const exclusionMatch = lower.match(/(?:exclude|excluding|without)\s+(.+)$/);
  if (exclusionMatch?.[1]) {
    exclusions.push(exclusionMatch[1]);
  }

  if (
    interests.length === 0 &&
    behaviors.length === 0 &&
    locations.length === 0 &&
    transactions.length === 0
  ) {
    interests.push(message);
  }

  return {
    ageRange: ageMatch
      ? {
          min: Number(ageMatch[1]),
          max: Number(ageMatch[2]),
        }
      : null,
    demographics,
    interests,
    behaviors,
    locations,
    transactions,
    exclusions,
    sensitiveRequest: isSensitiveText(message),
    safeAlternative: null,
    clarificationNeeded: message.trim().split(/\s+/).length < 3,
    clarificationQuestion:
      message.trim().split(/\s+/).length < 3
        ? "Can you add more detail about the behaviors, locations, purchases, or demographics you want to target?"
        : null,
  };
}

async function extractAudienceIntent(message: string) {
  const fallback = fallbackIntentFromMessage(message);
//   return fallback;
// }

  return generateStructuredJson<AudienceIntent>({
    label: "audience-intent",
    schema: AudienceIntentSchema,
    fallback,
    messages: [
      {
        role: "system",
        content: `
You are an advertising audience planning assistant.

Extract targeting intent from a planner's natural language request.
Extract requestedSignalCount from the user request.
Generate searchKeywords for taxonomy lookup.
The user may say "audience", "segment", or "signals"; treat those as targeting signals.

Return valid JSON only.

Rules:
- Do not invent taxonomy IDs.
- Extract keywords that can be used to search taxonomy data.
- For cars, include keywords such as automotive, cars, vehicle, SUV, dealership, auto.
- For fitness, include keywords such as fitness, gym, exercise, running, hiking, yoga.
- Flag sensitive targeting requests involving religion, ethnicity, race, health condition, sexual orientation, disability, or political affiliation.
`,
      },
      {
        role: "user",
        content: JSON.stringify({
          request: message,
          requiredShape: {
            ageRange: { min: "number|null", max: "number|null" },
            demographics: ["string"],
            interests: ["string"],
            behaviors: ["string"],
            locations: ["string"],
            transactions: ["string"],
            exclusions: ["string"],
            sensitiveRequest: "boolean",
            safeAlternative: "string|null",
            clarificationNeeded: "boolean",
            clarificationQuestion: "string|null",
          },
        }),
      },
    ],
  });
}

function candidateToRecommendedSignal(
  candidate: RankedTaxonomySignal,
  index: number,
): RecommendedSignal {
  const confidence = Math.max(
    0.58,
    Math.min(0.95, 0.94 - index * 0.045 + candidate.score * 0.006),
  );

  const sourceLabel = candidate.source
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter: string) => letter.toUpperCase());

  return {
    id: candidate.id,
    source: candidate.source,
    name: cleanDisplayText(candidate.name),
    path: candidate.path ? cleanDisplayText(candidate.path) : null,
    confidence: Number(confidence.toFixed(2)),
    rationale: `${sourceLabel} match from the provided taxonomy that aligns with the requested audience behavior or attribute.`,
  };
}

function fallbackRecommendation(
  message: string,
  intent: AudienceIntent,
  candidates: RankedTaxonomySignal[],
): AudienceRecommendation {
  const selected = candidates.slice(0, 6).map(candidateToRecommendedSignal);

  const ageText =
    intent.ageRange?.min && intent.ageRange.max
      ? ` ages ${intent.ageRange.min}-${intent.ageRange.max}`
      : "";

  const focus = [
    ...intent.interests,
    ...intent.behaviors,
    ...intent.locations,
    ...intent.transactions,
  ][0];

  return {
    audienceName: focus
      ? `${cleanDisplayText(focus)} audience${ageText}`
      : titleFromMessage(message),
    summary:
      selected.length > 0
        ? "I searched the available taxonomy and matched the request to taxonomy-backed behavioral, location, transaction, and consumer graph signals."
        : "I could not find strong taxonomy matches yet. Add more detail or search for a specific behavior, place, purchase, or demographic attribute.",
    recommendedSignals: selected,
    rejectedSignals: [],
    clarificationNeeded: selected.length === 0,
    clarificationQuestion:
      selected.length === 0
        ? "Could you describe the audience using locations they visit, products they buy, interests, or demographic attributes?"
        : null,
  };
}

async function recommendAudience(
  message: string,
  intent: AudienceIntent,
  candidates: RankedTaxonomySignal[],
  maxSignals = 8,
) {
  const fallback = fallbackRecommendation(message, intent, candidates);

  const candidatePayload = candidates.slice(0, 80).map((candidate) => ({
    id: candidate.id,
    source: candidate.source,
    name: cleanDisplayText(candidate.name),
    path: candidate.path ? cleanDisplayText(candidate.path) : null,
    description: candidate.description
      ? cleanDisplayText(candidate.description)
      : null,
    score: candidate.score,
  }));

  const recommendation = await generateStructuredJson<AudienceRecommendation>({
    label: "audience-recommendation",
    schema: AudienceRecommendationSchema,
    fallback,
    messages: [
      {
        role: "system",
        content: `
You select advertising targeting signals from a provided taxonomy.

Critical rules:
- You may ONLY recommend candidate IDs supplied by the backend.
- Do NOT invent signals.
- Do NOT invent IDs.
- Every recommended signal must be from the candidates list.
- Prefer behavioral, transaction, and location signals when relevant.
- Avoid sensitive targeting.
- confidence MUST be a number between 0 and 1, not a string.
- Return valid JSON only.
`,
      },
      {
        role: "user",
        content: JSON.stringify({
          plannerRequest: message,
          extractedIntent: intent,
          candidates: candidatePayload,
          outputShape: {
            audienceName: "string",
            summary: "string",
            recommendedSignals: [
              {
                id: "candidate id only",
                source:
                  "LOCATION|TRANSACTION|CONSUMER_GRAPH_FIELD|CONSUMER_GRAPH_VALUE",
                name: "candidate name",
                path: "candidate path|null",
                confidence: 0.85,
                rationale: "why this signal fits",
              },
            ],
            rejectedSignals: [
              { id: "string", name: "string", reason: "string" },
            ],
            clarificationNeeded: "boolean",
            clarificationQuestion: "string|null",
          },
        }),
      },
    ],
  });
  // const recommendation = fallback;
  
  const candidateById = new Map(
    candidatePayload.map((candidate) => [candidate.id, candidate]),
  );

  const safeSignals = recommendation.recommendedSignals
    .filter((signal) => candidateById.has(signal.id))
    .filter((signal) => !isSensitiveText(`${signal.name} ${signal.path ?? ""}`))
    .slice(0, maxSignals);

  return {
    ...recommendation,
    recommendedSignals:
      safeSignals.length > 0
        ? safeSignals
        : fallback.recommendedSignals.slice(0, maxSignals),
  };
}

function formatSignalList(signals: RecommendedSignal[]) {
  if (signals.length === 0) {
    return "No signals selected yet.";
  }

  return signals
    .map(
      (signal, index) =>
        `${index + 1}. ${signal.name} (${signal.source.replace(/_/g, " ")}) — ${Math.round(signal.confidence * 100)}% confidence. ${signal.rationale}`,
    )
    .join("\n");
}

function formatCreatedRecommendationMessage(
  recommendation: AudienceRecommendation,
) {
  const clarification =
    recommendation.clarificationNeeded && recommendation.clarificationQuestion
      ? `\n\nClarifying question: ${recommendation.clarificationQuestion}`
      : "";

  return [
    `I searched the available targeting taxonomy and created a draft audience: ${recommendation.audienceName}`,
    recommendation.summary,
    "",
    "Recommended taxonomy-backed signals:",
    formatSignalList(recommendation.recommendedSignals),
    "",
    "You can approve this audience, remove a signal, ask me to add more signals, or ask me to make it broader or narrower.",
    clarification,
  ].join("\n");
}

function formatRefinedRecommendationMessage({
  recommendation,
  addedSignals,
  totalSignals,
  requestedCount,
}: {
  recommendation: AudienceRecommendation;
  addedSignals: RecommendedSignal[];
  totalSignals: number;
  requestedCount: number | null;
}) {
  const requestedText =
    requestedCount && requestedCount > 0
      ? ` You asked for ${requestedCount} more.`
      : "";

  const header =
    addedSignals.length > 0
      ? `Done — I kept the existing draft and added ${addedSignals.length} new taxonomy-backed signal${addedSignals.length === 1 ? "" : "s"}.${requestedText}`
      : `I reviewed the taxonomy for additional matching signals, but I could not find new taxonomy-backed signals that are not already selected.`;

  const addedText =
    addedSignals.length > 0
      ? formatSignalList(addedSignals)
      : "No new signals were added.";

  return [
    header,
    "",
    "Search summary:",
    recommendation.summary,
    "",
    "Newly added signals:",
    addedText,
    "",
    `Current draft total: ${totalSignals} selected signal${totalSignals === 1 ? "" : "s"}.`,
    "",
    "You can ask me to show all selected signals, remove low-confidence signals, add more signals, estimate reach, or approve the audience.",
  ].join("\n");
}

function formatAllSelectedSignalsMessage(plan: {
  audienceName: string;
  summary: string;
  selectedSignals: unknown;
  estimatedMin: number | null;
  estimatedMax: number | null;
  confidence: number | null;
}) {
  const selectedSignals = jsonSignals(plan);

  if (selectedSignals.length === 0) {
    return "There are no selected audience signals in the current draft yet.";
  }

  const estimateText =
    plan.estimatedMin && plan.estimatedMax
      ? `Latest estimate: ${plan.estimatedMin.toLocaleString()} - ${plan.estimatedMax.toLocaleString()} reachable audience${plan.confidence ? `, ${Math.round(plan.confidence * 100)}% confidence` : ""}.`
      : "No audience-size estimate has been calculated yet.";

  return [
    `Here are all selected audience signals in the current draft: ${plan.audienceName}`,
    plan.summary,
    "",
    `Selected signals (${selectedSignals.length} total):`,
    formatSignalList(selectedSignals),
    "",
    estimateText,
  ].join("\n");
}

function formatLowConfidenceReviewMessage({
  lowConfidenceSignals,
  threshold,
}: {
  lowConfidenceSignals: RecommendedSignal[];
  threshold: number;
}) {
  if (lowConfidenceSignals.length === 0) {
    return `I checked the current draft and did not find any selected signals below ${formatPercent(
      threshold,
    )} confidence.`;
  }

  return [
    `I found ${lowConfidenceSignals.length} low-confidence selected signal${lowConfidenceSignals.length === 1 ? "" : "s"} below ${formatPercent(
      threshold,
    )}:`,
    "",
    formatSignalList(lowConfidenceSignals),
    "",
    `Do you want me to remove ${lowConfidenceSignals.length === 1 ? "this signal" : "these signals"} from the current draft? Reply "yes, remove them" or "no, keep them".`,
  ].join("\n");
}

function formatLowConfidenceRemovalMessage({
  removedSignals,
  remainingCount,
}: {
  removedSignals: RecommendedSignal[];
  remainingCount: number;
}) {
  if (removedSignals.length === 0) {
    return "I could not find the pending low-confidence signals in the current draft, so nothing was removed.";
  }

  return [
    `Removed ${removedSignals.length} low-confidence signal${removedSignals.length === 1 ? "" : "s"} from the current draft:`,
    "",
    formatSignalList(removedSignals),
    "",
    `The draft now has ${remainingCount} selected signal${remainingCount === 1 ? "" : "s"}.`,
  ].join("\n");
}

function formatEstimateMessage(estimate: AudienceEstimate, approved: boolean) {
  const status = approved ? "Approved" : "Estimated";

  return [
    `${status}. Estimated reachable audience: ${estimate.estimatedMin.toLocaleString()} - ${estimate.estimatedMax.toLocaleString()}.`,
    `Confidence: ${Math.round(estimate.confidence * 100)}%.`,
    estimate.methodology,
  ].join("\n");
}

function parseRemoveTerm(message: string) {
  const match = message.match(removePattern);
  return match?.[1]?.replace(/[.!?]$/, "").trim() ?? null;
}

function fallbackAgentDecision(
  message: string,
  hasExistingPlan: boolean,
): AgentDecision {
  const lower = message.toLowerCase();

  if (hasExistingPlan && approvalPattern.test(message)) {
    return {
      action: "APPROVE_AUDIENCE",
      assistantReply:
        "Great, I will approve this audience and calculate the reachable audience size.",
      audienceRequest: null,
      signalsToAdd: [],
      signalsToRemove: [],
      shouldEstimate: true,
      shouldApprove: true,
    };
  }

  if (
    hasExistingPlan &&
    estimatePattern.test(message) &&
    message.trim().split(/\s+/).length <= 7
  ) {
    return {
      action: "ESTIMATE_AUDIENCE",
      assistantReply: "I will estimate the current draft audience.",
      audienceRequest: null,
      signalsToAdd: [],
      signalsToRemove: [],
      shouldEstimate: true,
      shouldApprove: false,
    };
  }

  const removeTerm = hasExistingPlan ? parseRemoveTerm(message) : null;

  if (removeTerm) {
    return {
      action: "REMOVE_SIGNAL",
      assistantReply: `I will remove signals matching "${removeTerm}" from the current draft audience.`,
      audienceRequest: null,
      signalsToAdd: [],
      signalsToRemove: [removeTerm],
      shouldEstimate: false,
      shouldApprove: false,
    };
  }

  if (
    /\b(hi|hello|hey|thanks|thank you)\b/.test(lower) &&
    message.trim().split(/\s+/).length <= 4
  ) {
    return {
      action: "GENERAL_REPLY",
      assistantReply: hasExistingPlan
        ? "Happy to help. You can ask me to explain, refine, broaden, narrow, approve, estimate, or show the current audience."
        : "Hi! Tell me who you want to reach, and I will translate that into taxonomy-backed advertising signals.",
      audienceRequest: null,
      signalsToAdd: [],
      signalsToRemove: [],
      shouldEstimate: false,
      shouldApprove: false,
    };
  }

  if (
    hasExistingPlan &&
    /\b(why|explain|what does|what are|summarize|summary|rationale|how did you)\b/.test(
      lower,
    )
  ) {
    return {
      action: "GENERAL_REPLY",
      assistantReply:
        "I selected signals by searching the provided targeting taxonomy and choosing the rows that best match your planner request. Location signals represent places people visit, transaction signals represent purchases, and consumer graph signals represent demographic or lifestyle attributes.",
      audienceRequest: null,
      signalsToAdd: [],
      signalsToRemove: [],
      shouldEstimate: false,
      shouldApprove: false,
    };
  }

  if (
    hasExistingPlan &&
    /\b(add|include|more|same category|broader|narrower|focus|remove|exclude|premium|luxury|fitness|running|travel|auto|car|cars|parents|grocery|coffee)\b/.test(
      lower,
    )
  ) {
    return {
      action: "REFINE_AUDIENCE",
      assistantReply:
        "I will refine the current draft audience using taxonomy-backed signals.",
      audienceRequest: message,
      signalsToAdd: [],
      signalsToRemove: [],
      shouldEstimate: false,
      shouldApprove: false,
    };
  }

  const looksLikeAudienceRequest =
    message.trim().split(/\s+/).length >= 3 ||
    /\b(age|aged|target|reach|audience|people|users|shoppers|visitors|enthusiasts|buyers|parents|travelers|lovers)\b/.test(
      lower,
    );

  if (looksLikeAudienceRequest) {
    return {
      action: hasExistingPlan ? "REFINE_AUDIENCE" : "BUILD_AUDIENCE",
      assistantReply: hasExistingPlan
        ? "I will update the draft audience using your latest instruction."
        : "I will build a draft audience from your request.",
      audienceRequest: message,
      signalsToAdd: [],
      signalsToRemove: [],
      shouldEstimate: false,
      shouldApprove: false,
    };
  }

  return {
    action: "GENERAL_REPLY",
    assistantReply:
      "I can help you build an advertising audience, explain selected signals, refine the draft, approve it, estimate reach, or show the current selected audience signals.",
    audienceRequest: null,
    signalsToAdd: [],
    signalsToRemove: [],
    shouldEstimate: false,
    shouldApprove: false,
  };
}

async function decideNextAgentAction({
  message,
  existingPlan,
  history,
}: {
  message: string;
  existingPlan: unknown;
  history: Array<{ role: string; content: string }>;
}) {
  const fallback = fallbackAgentDecision(message, Boolean(existingPlan));
//   return fallback;
// }

  return generateStructuredJson<AgentDecision>({
    label: "agent-decision",
    schema: AgentDecisionSchema,
    fallback,
    messages: [
      {
        role: "system",
        content: `
You are a conversational advertising audience planning assistant.

You can answer normal questions, explain targeting choices, and also build, refine, approve, and estimate advertising audiences.

Return valid JSON only.

Rules:
- If the user is asking a general question, use GENERAL_REPLY.
- If the user describes a target audience and no plan exists, use BUILD_AUDIENCE.
- If there is an existing plan and the user asks to add, include, remove, broaden, narrow, focus, or add more signals, use REFINE_AUDIENCE or REMOVE_SIGNAL.
- If the user says "add more", "add 5 more", "same category", or similar, use REFINE_AUDIENCE and do not replace the existing audience.
- If the user asks for approval, use APPROVE_AUDIENCE.
- If the user asks for estimate, use ESTIMATE_AUDIENCE.

Output requirements:
- audienceRequest MUST always be a plain string or null.
- signalsToAdd MUST always be an array.
- signalsToRemove MUST always be an array.
- Never return null arrays.
- Never return objects for audienceRequest.
`,
      },
      {
        role: "user",
        content: JSON.stringify({
          latestUserMessage: message,
          hasExistingPlan: Boolean(existingPlan),
          currentPlan: existingPlan,
          recentConversation: history.slice(-12),
          outputShape: {
            action:
              "GENERAL_REPLY|BUILD_AUDIENCE|REFINE_AUDIENCE|REMOVE_SIGNAL|ADD_SIGNAL|APPROVE_AUDIENCE|ESTIMATE_AUDIENCE|ASK_CLARIFICATION",
            assistantReply: "natural conversational response to show user",
            audienceRequest: "audience request to build/refine from, or null",
            signalsToAdd: ["signal keywords to add"],
            signalsToRemove: ["signal keywords to remove"],
            shouldEstimate: "boolean",
            shouldApprove: "boolean",
          },
        }),
      },
    ],
  });
}

async function loadPlan(conversationId: string) {
  const plan = await prisma.audiencePlan.findUnique({
    where: { conversationId },
  });

  if (!plan) {
    throw new HttpError(
      400,
      "No audience plan exists for this conversation yet",
    );
  }

  return plan;
}

function jsonSignals(plan: { selectedSignals: unknown }) {
  return (plan.selectedSignals ?? []) as RecommendedSignal[];
}

function jsonIntent(plan: { intent: unknown }) {
  return (plan.intent ?? null) as AudienceIntent | null;
}

function removeDuplicateSignals(signals: RecommendedSignal[]) {
  const seen = new Set<string>();

  return signals.filter((signal) => {
    if (seen.has(signal.id)) return false;
    seen.add(signal.id);
    return true;
  });
}

function mergeSignals({
  existingSignals,
  newSignals,
  limit,
}: {
  existingSignals: RecommendedSignal[];
  newSignals: RecommendedSignal[];
  limit?: number | null;
}) {
  const existingIds = new Set(existingSignals.map((signal) => signal.id));

  const uniqueNewSignals = newSignals.filter(
    (signal) => !existingIds.has(signal.id),
  );

  const selectedNewSignals =
    typeof limit === "number" ? uniqueNewSignals.slice(0, limit) : uniqueNewSignals;

  return {
    addedSignals: selectedNewSignals,
    mergedSignals: removeDuplicateSignals([
      ...existingSignals,
      ...selectedNewSignals,
    ]),
  };
}

function filterSignalsByRemoveTerms({
  signals,
  removeTerms,
}: {
  signals: RecommendedSignal[];
  removeTerms: string[];
}) {
  if (removeTerms.length === 0) {
    return signals;
  }

  return signals.filter((signal) => {
    const text = `${signal.name} ${signal.path ?? ""}`.toLowerCase();
    return !removeTerms.some((term) => text.includes(term.toLowerCase()));
  });
}

function supplementalSignalsFromCandidates({
  candidates,
  selectedSignals,
  neededCount,
}: {
  candidates: RankedTaxonomySignal[];
  selectedSignals: RecommendedSignal[];
  neededCount: number;
}) {
  if (neededCount <= 0) {
    return [];
  }

  const selectedIds = new Set(selectedSignals.map((signal) => signal.id));

  return candidates
    .filter((candidate) => !selectedIds.has(candidate.id))
    .filter(
      (candidate) =>
        !isSensitiveText(`${candidate.name} ${candidate.path ?? ""}`),
    )
    .slice(0, neededCount)
    .map((candidate, index) =>
      candidateToRecommendedSignal(candidate, selectedSignals.length + index),
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findPendingLowConfidenceRemoval(
  messages: Array<{
    role: MessageRole | string;
    metadata: unknown;
  }>,
) {
  const messagesBeforeCurrentUser = messages.slice(0, -1);

  const lastAssistantMessage = [...messagesBeforeCurrentUser]
    .reverse()
    .find((message) => message.role === MessageRole.ASSISTANT);

  if (!lastAssistantMessage || !isRecord(lastAssistantMessage.metadata)) {
    return null;
  }

  const metadata = lastAssistantMessage.metadata;

  if (metadata.pendingAction !== "REMOVE_LOW_CONFIDENCE_SIGNALS") {
    return null;
  }

  const signalIds = Array.isArray(metadata.signalIds)
    ? metadata.signalIds.filter((id): id is string => typeof id === "string")
    : [];

  if (signalIds.length === 0) {
    return null;
  }

  return {
    signalIds,
    threshold:
      typeof metadata.threshold === "number"
        ? metadata.threshold
        : defaultLowConfidenceThreshold,
  };
}

async function removePendingLowConfidenceSignals({
  conversationId,
  signalIds,
}: {
  conversationId: string;
  signalIds: string[];
}) {
  const plan = await loadPlan(conversationId);
  const selectedSignals = jsonSignals(plan);
  const idSet = new Set(signalIds);

  const removedSignals = selectedSignals.filter((signal) => idSet.has(signal.id));
  const remainingSignals = selectedSignals.filter(
    (signal) => !idSet.has(signal.id),
  );

  await prisma.audiencePlan.update({
    where: { conversationId },
    data: {
      selectedSignals: remainingSignals,
      status: AudienceStatus.DRAFT,
      estimatedMin: null,
      estimatedMax: null,
      confidence: null,
      estimate: null,
    },
  });

  await prisma.message.create({
    data: {
      conversationId,
      role: MessageRole.ASSISTANT,
      content: formatLowConfidenceRemovalMessage({
        removedSignals,
        remainingCount: remainingSignals.length,
      }),
      metadata: {
        removedSignalIds: removedSignals.map((signal) => signal.id),
        clearedPendingAction: "REMOVE_LOW_CONFIDENCE_SIGNALS",
      },
    },
  });
}

export async function approveAudiencePlan(
  conversationId: string,
  approved = true,
) {
  const plan = await loadPlan(conversationId);
  const selectedSignals = jsonSignals(plan);
  const intent = jsonIntent(plan);
  const estimate = estimateAudienceSize({ selectedSignals, intent });

  await prisma.audiencePlan.update({
    where: { conversationId },
    data: {
      status: approved ? AudienceStatus.APPROVED : AudienceStatus.DRAFT,
      estimatedMin: estimate.estimatedMin,
      estimatedMax: estimate.estimatedMax,
      confidence: estimate.confidence,
      estimate,
    },
  });

  if (approved) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { status: ConversationStatus.APPROVED },
    });
  }

  const message = formatEstimateMessage(estimate, approved);

  await prisma.message.create({
    data: {
      conversationId,
      role: MessageRole.ASSISTANT,
      content: message,
      metadata: { estimate, approved },
    },
  });

  return estimate;
}

export async function removeSignalFromPlan(
  conversationId: string,
  signalId: string,
) {
  const plan = await loadPlan(conversationId);
  const selectedSignals = jsonSignals(plan);
  const signal = selectedSignals.find((item) => item.id === signalId);
  const nextSignals = selectedSignals.filter((item) => item.id !== signalId);

  await prisma.audiencePlan.update({
    where: { conversationId },
    data: {
      selectedSignals: nextSignals,
      status: AudienceStatus.DRAFT,
      estimatedMin: null,
      estimatedMax: null,
      confidence: null,
      estimate: null,
    },
  });

  const message = signal
    ? `Removed "${signal.name}" from the draft audience. You can approve the updated audience or continue refining it.`
    : "That signal was not found in the current draft audience.";

  await prisma.message.create({
    data: {
      conversationId,
      role: MessageRole.ASSISTANT,
      content: message,
      metadata: { removedSignalId: signalId },
    },
  });
}

export async function addSignalToPlan(
  conversationId: string,
  signalId: string,
) {
  const plan = await loadPlan(conversationId);
  const selectedSignals = jsonSignals(plan);

  if (selectedSignals.some((signal) => signal.id === signalId)) {
    return;
  }

  const candidate = await prisma.taxonomySignal.findUnique({
    where: { id: signalId },
  });

  if (!candidate) {
    throw new HttpError(404, "Taxonomy signal not found");
  }

  const signal = candidateToRecommendedSignal(
    { ...candidate, score: 5 },
    selectedSignals.length,
  );

  const nextSignals = [...selectedSignals, signal];

  await prisma.audiencePlan.update({
    where: { conversationId },
    data: {
      selectedSignals: nextSignals,
      status: AudienceStatus.DRAFT,
      estimatedMin: null,
      estimatedMax: null,
      confidence: null,
      estimate: null,
    },
  });

  await prisma.message.create({
    data: {
      conversationId,
      role: MessageRole.ASSISTANT,
      content: `Added "${signal.name}" to the draft audience.`,
      metadata: { addedSignalId: signalId },
    },
  });
}

async function removeSignalByText(conversationId: string, term: string) {
  const plan = await loadPlan(conversationId);
  const selectedSignals = jsonSignals(plan);
  const normalizedTerm = term.toLowerCase();

  const nextSignals = selectedSignals.filter(
    (signal) =>
      !`${signal.name} ${signal.path ?? ""}`
        .toLowerCase()
        .includes(normalizedTerm),
  );

  if (nextSignals.length === selectedSignals.length) {
    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content: `I could not find a selected signal matching "${term}". You can remove a signal from the panel or say the exact signal name.`,
      },
    });
    return;
  }

  await prisma.audiencePlan.update({
    where: { conversationId },
    data: {
      selectedSignals: nextSignals,
      status: AudienceStatus.DRAFT,
      estimatedMin: null,
      estimatedMax: null,
      confidence: null,
      estimate: null,
    },
  });

  await prisma.message.create({
    data: {
      conversationId,
      role: MessageRole.ASSISTANT,
      content: `Removed signals matching "${term}". The draft now has ${nextSignals.length} selected signal${nextSignals.length === 1 ? "" : "s"}.`,
    },
  });
}

export async function handlePlannerMessage(
  conversationId: string,
  rawMessage: string,
) {
  const message = cleanPlannerMessage(rawMessage);
  

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      audiencePlan: true,
      messages: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!conversation) {
    throw new HttpError(404, "Conversation not found");
  }

  const existingPlan = conversation.audiencePlan;

  const pendingLowConfidenceRemoval = findPendingLowConfidenceRemoval(
    conversation.messages,
  );

  if (existingPlan && pendingLowConfidenceRemoval) {
    if (isAffirmativeConfirmation(message)) {
      await removePendingLowConfidenceSignals({
        conversationId,
        signalIds: pendingLowConfidenceRemoval.signalIds,
      });
      return;
    }

    if (isNegativeConfirmation(message)) {
      await prisma.message.create({
        data: {
          conversationId,
          role: MessageRole.ASSISTANT,
          content:
            "No problem — I kept the low-confidence signals in the current draft. You can continue refining, estimate reach, or approve the audience.",
          metadata: {
            cancelledPendingAction: "REMOVE_LOW_CONFIDENCE_SIGNALS",
          },
        },
      });
      return;
    }
  }

  if (existingPlan && isListSelectedSignalsRequest(message)) {
    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content: formatAllSelectedSignalsMessage(existingPlan),
        metadata: {
          action: "SHOW_SELECTED_SIGNALS",
          selectedSignalCount: jsonSignals(existingPlan).length,
        },
      },
    });
    return;
  }

  if (existingPlan && isLowConfidenceReviewRequest(message)) {
    const threshold = confidenceThresholdFromMessage(message);
    const selectedSignals = jsonSignals(existingPlan);
    const lowConfidenceSignals = selectedSignals.filter(
      (signal) => signal.confidence < threshold,
    );

    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content: formatLowConfidenceReviewMessage({
          lowConfidenceSignals,
          threshold,
        }),
        metadata:
          lowConfidenceSignals.length > 0
            ? {
                pendingAction: "REMOVE_LOW_CONFIDENCE_SIGNALS",
                signalIds: lowConfidenceSignals.map((signal) => signal.id),
                threshold,
                lowConfidenceSignals,
              }
            : {
                action: "REVIEW_LOW_CONFIDENCE_SIGNALS",
                threshold,
                lowConfidenceSignals: [],
              },
      },
    });
    return;
  }

  const decision = await decideNextAgentAction({
    message,
    existingPlan,
    history: conversation.messages.map((item) => ({
      role: item.role,
      content: item.content,
    })),
  });

  if (
    decision.action === "GENERAL_REPLY" ||
    decision.action === "ASK_CLARIFICATION"
  ) {
    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content: decision.assistantReply,
        metadata: { decision },
      },
    });
    return;
  }

  if (
    existingPlan &&
    (decision.action === "APPROVE_AUDIENCE" || decision.shouldApprove)
  ) {
    await approveAudiencePlan(conversationId, true);
    return;
  }

  if (
    existingPlan &&
    (decision.action === "ESTIMATE_AUDIENCE" || decision.shouldEstimate)
  ) {
    await approveAudiencePlan(conversationId, false);
    return;
  }

  const removeTerms =
    decision.signalsToRemove.length > 0 ? [...decision.signalsToRemove] : [];

  const directRemoveTerm = existingPlan ? parseRemoveTerm(message) : null;

  if (directRemoveTerm && !removeTerms.includes(directRemoveTerm)) {
    removeTerms.push(directRemoveTerm);
  }

  if (
    existingPlan &&
    decision.action === "REMOVE_SIGNAL" &&
    removeTerms.length > 0
  ) {
    await removeSignalByText(conversationId, removeTerms[0]);
    return;
  }

  const normalizedDecisionRequest = normalizeAudienceRequest(
    decision.audienceRequest,
    message,
  );

  let audienceRequest = normalizedDecisionRequest;

  if (existingPlan && decision.action === "REFINE_AUDIENCE") {
    const currentIntent = jsonIntent(existingPlan);
    const currentSignals = jsonSignals(existingPlan).map(
      (signal) => signal.name,
    );
    const addCount = requestedAdditionalSignalCount(message);

    audienceRequest = [
      `Original brief: ${existingPlan.brief}`,
      currentIntent
        ? `Current extracted intent: ${JSON.stringify(currentIntent)}`
        : null,
      currentSignals.length
        ? `Current selected taxonomy signals: ${currentSignals.join(", ")}`
        : null,
      `Planner refinement: ${normalizedDecisionRequest}`,
      decision.signalsToAdd.length
        ? `Add or emphasize: ${decision.signalsToAdd.join(", ")}`
        : null,
      removeTerms.length
        ? `Remove or de-emphasize: ${removeTerms.join(", ")}`
        : null,
      addCount
        ? `Planner requested ${addCount} additional signals from the same category.`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const intent = await extractAudienceIntent(audienceRequest);
  const requestedCount =
  intent.requestedSignalCount ?? requestedAdditionalSignalCount(message) ?? 8;

  const keywords = [
    ...keywordsFromIntent(intent, audienceRequest),
    ...(Array.isArray(intent.searchKeywords) ? intent.searchKeywords : []),
  ];

  if (intent.sensitiveRequest) {
    const content = intent.safeAlternative ?? sensitiveRequestMessage();

    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content,
        metadata: { intent, decision },
      },
    });
    return;
  }

  const candidates = await searchTaxonomyByKeywords(keywords);

  const existingSignals = existingPlan ? jsonSignals(existingPlan) : [];
  const addCount = existingPlan ? requestedAdditionalSignalCount(message) : null;

  const maxSignalsToAskFor =
    existingPlan && addCount ? existingSignals.length + addCount + 5 : 8;

  const recommendation = await recommendAudience(
    audienceRequest,
    intent,
    candidates,
    maxSignalsToAskFor,
  );

  const recommendedSignalsAfterRemoveTerms = filterSignalsByRemoveTerms({
    signals: recommendation.recommendedSignals,
    removeTerms,
  });

  const finalRecommendation = {
    ...recommendation,
    recommendedSignals:
      recommendedSignalsAfterRemoveTerms.length > 0
        ? recommendedSignalsAfterRemoveTerms
        : recommendation.recommendedSignals,
  };

  const isRefinement = Boolean(
    existingPlan && decision.action === "REFINE_AUDIENCE",
  );

  const existingSignalsAfterRemoveTerms = filterSignalsByRemoveTerms({
    signals: existingSignals,
    removeTerms,
  });

  let addedSignals: RecommendedSignal[];
  let selectedSignals: RecommendedSignal[];

  if (isRefinement) {
    const firstMerge = mergeSignals({
      existingSignals: existingSignalsAfterRemoveTerms,
      newSignals: finalRecommendation.recommendedSignals,
      limit: addCount,
    });

    addedSignals = firstMerge.addedSignals;
    selectedSignals = firstMerge.mergedSignals;

    if (addCount && addedSignals.length < addCount) {
      const supplementalSignals = supplementalSignalsFromCandidates({
        candidates,
        selectedSignals,
        neededCount: addCount - addedSignals.length,
      });

      addedSignals = [...addedSignals, ...supplementalSignals];
      selectedSignals = removeDuplicateSignals([
        ...selectedSignals,
        ...supplementalSignals,
      ]);
    }
  } else {
    addedSignals = finalRecommendation.recommendedSignals;
    selectedSignals = finalRecommendation.recommendedSignals;
  }

  await prisma.audiencePlan.upsert({
    where: { conversationId },
    create: {
      conversationId,
      brief: normalizedDecisionRequest,
      audienceName: finalRecommendation.audienceName,
      summary: finalRecommendation.summary,
      intent,
      selectedSignals,
      status: AudienceStatus.DRAFT,
    },
    update: {
      brief: isRefinement
        ? existingPlan?.brief ?? normalizedDecisionRequest
        : normalizedDecisionRequest,
      audienceName: finalRecommendation.audienceName,
      summary: finalRecommendation.summary,
      intent,
      selectedSignals,
      status: AudienceStatus.DRAFT,
      estimatedMin: null,
      estimatedMax: null,
      confidence: null,
      estimate: null,
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      title: conversation.title ?? titleFromMessage(message),
      status: ConversationStatus.DRAFT,
    },
  });

  const assistantContent = isRefinement
    ? formatRefinedRecommendationMessage({
        recommendation: finalRecommendation,
        addedSignals,
        totalSignals: selectedSignals.length,
        requestedCount: addCount,
      })
    : formatCreatedRecommendationMessage(finalRecommendation);

  const prefix =
    decision.assistantReply && !assistantContent.includes(decision.assistantReply)
      ? `${decision.assistantReply}\n\n`
      : "";

  await prisma.message.create({
    data: {
      conversationId,
      role: MessageRole.ASSISTANT,
      content: `${prefix}${assistantContent}`,
      metadata: {
        intent,
        recommendation: {
          ...finalRecommendation,
          recommendedSignals: selectedSignals,
        },
        addedSignals,
        decision,
        candidateCount: candidates.length,
      },
    },
  });
}