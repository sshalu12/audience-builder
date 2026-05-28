import {
  AudienceStatus,
  ConversationStatus,
  MessageRole,
  Prisma,
} from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../utils/httpError.js";
import { estimateAudienceSize } from "./estimate.service.js";
import { generateJson, type AgentDecisionContext } from "./llm.service.js";
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

function requestedSignalCountFromMessage(message: string) {
  const lower = message.toLowerCase();

  const digitMatch =
    lower.match(
      /\b(?:suggest|recommend|show|give|add|include)\s*(?:me\s*)?(\d{1,2})\s*(?:more|additional|new)?\s*(?:audiences?|signals?|segments?|targets?)\b/,
    ) ||
    lower.match(
      /\b(\d{1,2})\s*(?:more|additional|new)?\s*(?:audiences?|signals?|segments?|targets?)\b/,
    ) ||
    lower.match(
      /\b(?:add|include|recommend|show|give me)?\s*(\d{1,2})\s*(?:more|additional|new)\s*(?:audiences?|signals?|segments?|targets?)?\b/,
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
    /\b(show|list|display|retrieve|get|see|view)\b.*\b(all|current|selected|added)\b.*\b(audiences?|signals?|segments?|targets?)\b/.test(lower) ||
    /\bwhat\b.*\b(audiences?|signals?|segments?|targets?)\b.*\b(added|selected|current)\b/.test(lower) ||
    /\bwhich\b.*\b(audiences?|signals?|segments?|targets?)\b.*\b(selected|added|current)\b/.test(lower) ||
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

// True if the planner's first message has no concrete targeting concept
// (no behavior, interest, location, purchase, age range, or demographic noun).
// Used to prompt for a real brief instead of building a random draft from
// "build me an audience", "create a segment", etc.
function isVagueAudienceBrief(message: string) {
  const cleaned = message.trim().toLowerCase();
  if (cleaned.length === 0) return true;

  const wordCount = cleaned.split(/\s+/).length;

  const onlyMetaWords =
    /^(build|create|make|generate|set up|setup|give|show|suggest|recommend|design|draft)\s+(me\s+)?(an?\s+|some\s+|the\s+)?(audience|audiences|segment|segments|signals?|targets?|plan|draft)s?\.?\??$/i;
  if (onlyMetaWords.test(cleaned)) return true;

  if (wordCount <= 2 && /^(audience|signals?|segments?|targets?)\.?$/i.test(cleaned)) {
    return true;
  }

  // Has an age range -> not vague.
  if (/\b\d{1,2}\s*(?:-|to)\s*\d{1,2}\b/.test(cleaned)) return false;
  if (/\b(?:aged|age|years? old|under|over)\s+\d{1,2}\b/.test(cleaned)) return false;

  // Has a recognisable targeting concept noun -> not vague.
  const conceptPattern =
    /\b(fitness|gym|exercise|yoga|running|runner|hiker|hiking|cyclist|sports?|athletic|premium|luxury|affluent|upscale|wealthy|high[- ]income|parent|parents|mom|moms|dad|dads|kids?|children|family|toddler|baby|babies|coffee|cafe|grocery|groceries|organic|food|foodie|dining|restaurant|wine|beer|cocktail|travel|traveler|airline|hotel|tourism|vacation|auto|automotive|cars?|suv|truck|dealership|fashion|beauty|cosmetic|tech|technology|gamer|gaming|outdoor|hiking|home|homeowner|renter|furniture|pet|pets|dog|cat|investor|donor|charity|charitable|graduate|student|professional|retiree|senior|millennials?|gen[ -]?z|boomers?)\b/i;
  if (conceptPattern.test(cleaned)) return false;

  // Long descriptive sentences (>= 5 meaningful words) are probably specific
  // even if no single keyword matches our list.
  if (wordCount >= 6) return false;

  return true;
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
    searchKeywords: [
      ...interests,
      ...behaviors,
      ...locations,
      ...transactions,
    ],
    requestedSignalCount: null,
  };
}

async function extractAudienceIntent(
  message: string,
  context?: {
    mode: "BUILD" | "REFINE";
    currentBrief?: string | null;
    currentSignals?: string[];
    signalsToAdd?: string[];
    signalsToRemove?: string[];
  },
) {
  const fallback = fallbackIntentFromMessage(message);

  return generateJson<AudienceIntent>({
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
Generate searchKeywords for taxonomy lookup after understanding the user's intent.
The user may say "audience", "segment", or "signals"; treat those as targeting signals.

Return valid JSON only.

Rules:
- Do not invent taxonomy IDs.
- searchKeywords are the bridge to taxonomy lookup. They must be concise targeting concepts, not a copy of the whole sentence.
- If mode is REFINE, prioritize the latest request and signalsToAdd. Use currentBrief/currentSignals only as context for what already exists.
- If mode is REFINE and the user asks for a new concept like "car lovers" or "food lovers", searchKeywords must focus on that new concept, not the old audience.
- If mode is REFINE and the user says "more" or "same category" without a new concept, use currentSignals/currentBrief to infer similar taxonomy concepts.
- For cars, include keywords such as automotive, cars, vehicle, SUV, dealership, auto.
- For food lovers, include keywords such as food, dining, restaurants, grocery, supermarket, coffee, organic.
- For fitness, include keywords such as fitness, gym, exercise, running, hiking, yoga.
- Flag sensitive targeting requests involving religion, ethnicity, race, health condition, sexual orientation, disability, or political affiliation.
`,
      },
      {
        role: "user",
        content: JSON.stringify({
          request: message,
          context,
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
            requestedSignalCount: "number|null",
            searchKeywords: ["concise taxonomy lookup terms"],
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

function truncateForPrompt(value: string | null | undefined, maxLength = 160) {
  const cleaned = cleanDisplayText(value);
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3)}...` : cleaned;
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

  const candidatePayload = candidates.slice(0, 24).map((candidate) => ({
    id: candidate.id,
    source: candidate.source,
    name: truncateForPrompt(candidate.name, 100),
    path: candidate.path ? truncateForPrompt(candidate.path, 140) : null,
    description: candidate.description
      ? truncateForPrompt(candidate.description, 120)
      : null,
    score: candidate.score,
  }));

  const recommendation = await generateJson<AudienceRecommendation>({
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

  const candidateById = new Map(
    candidatePayload.map((candidate) => [candidate.id, candidate]),
  );

  const resolved = recommendation ?? fallback;

  const safeSignals = resolved.recommendedSignals
    .filter((signal) => candidateById.has(signal.id))
    .filter((signal) => !isSensitiveText(`${signal.name} ${signal.path ?? ""}`))
    .slice(0, maxSignals);

  const selectedIds = new Set(safeSignals.map((signal) => signal.id));
  const supplementalSignals = candidates
    .filter((candidate) => !selectedIds.has(candidate.id))
    .filter(
      (candidate) =>
        !isSensitiveText(`${candidate.name} ${candidate.path ?? ""}`),
    )
    .slice(0, Math.max(0, maxSignals - safeSignals.length))
    .map((candidate, index) =>
      candidateToRecommendedSignal(candidate, safeSignals.length + index),
    );

  const finalSignals = [...safeSignals, ...supplementalSignals].slice(
    0,
    maxSignals,
  );

  return {
    ...resolved,
    recommendedSignals:
      finalSignals.length > 0
        ? finalSignals
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
  audienceName: string | null;
  summary: string | null;
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
  const header = approved
    ? `Approved. Estimated reachable audience: ${estimate.estimatedMin.toLocaleString()} - ${estimate.estimatedMax.toLocaleString()}.`
    : `Preview reach (audience is still in draft): ${estimate.estimatedMin.toLocaleString()} - ${estimate.estimatedMax.toLocaleString()}. Approve the audience to lock the estimate.`;

  return [
    header,
    `Confidence: ${Math.round(estimate.confidence * 100)}%.`,
    estimate.methodology,
  ].join("\n");
}

function parseRemoveTerm(message: string) {
  const match = message.match(removePattern);
  return match?.[1]?.replace(/[.!?]$/, "").trim() ?? null;
}

const removeTermStopWords = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "my",
  "current",
  "from",
  "signal",
  "signals",
  "audience",
  "audiences",
  "segment",
  "segments",
  "target",
  "targets",
]);

/** Turns "Hiking signal" / "audience Hiking" into searchable terms like "hiking". */
function normalizeRemoveSearchTerms(term: string) {
  const cleaned = term.trim().toLowerCase().replace(/[.!?]+$/, "");
  const tokens = cleaned
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !removeTermStopWords.has(token));

  const variants = new Set<string>();
  if (tokens.length > 0) {
    variants.add(tokens.join(" "));
    for (const token of tokens) {
      variants.add(token);
    }
  } else if (cleaned.length > 0) {
    variants.add(cleaned);
  }

  return [...variants];
}

function signalMatchesRemoveTerms(
  signal: RecommendedSignal,
  removeTerms: string[],
) {
  const haystack = `${signal.name} ${signal.path ?? ""}`.toLowerCase();

  return removeTerms.some((term) =>
    normalizeRemoveSearchTerms(term).some((variant) =>
      haystack.includes(variant),
    ),
  );
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
    /\b(add|include|also|as well|along with|plus|more|same category|broader|narrower|focus|remove|exclude|premium|luxury|fitness|running|travel|auto|car|cars|parents|grocery|coffee)\b/.test(
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

  if (!hasExistingPlan && isVagueAudienceBrief(message)) {
    return {
      action: "ASK_CLARIFICATION",
      assistantReply:
        "Sure — who do you want to reach? Describe the audience in a sentence or two. For example: \"fitness enthusiasts aged 25-44 with premium shopping habits\", \"parents of toddlers who shop at Whole Foods\", or \"luxury car shoppers in California\".",
      audienceRequest: null,
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

type ResolvedAgentDecision = {
  decision: AgentDecision;
  source: "llm" | "fallback";
};

/**
 * LLM chooses the next action from conversation + plan context.
 * Deterministic rules in fallbackAgentDecision run only when the LLM call
 * fails (no API key, invalid JSON, schema validation error, rate limit, etc.).
 */
async function resolveAgentDecision({
  message,
  existingPlan,
  history,
}: {
  message: string;
  existingPlan: unknown;
  history: Array<{ role: string; content: string }>;
}): Promise<ResolvedAgentDecision> {
  const hasExistingPlan = Boolean(existingPlan);
  const fallback = fallbackAgentDecision(message, hasExistingPlan);
  const decisionContext: AgentDecisionContext = { hasExistingPlan };

  const llmDecision = await generateJson<AgentDecision>({
    label: "agent-decision",
    schema: AgentDecisionSchema,
    decisionContext,
    messages: [
      {
        role: "system",
        content: `
You are a conversational advertising audience planning assistant.

Your job is to read the planner's latest message and choose exactly one action.
Return valid JSON only.

Action selection (follow strictly):
- GENERAL_REPLY: greetings, thanks, or questions that do not change the draft.
- BUILD_AUDIENCE: only when hasExistingPlan is false and the user describes a new target audience.
- REFINE_AUDIENCE: when hasExistingPlan is true and the user wants to add, include, broaden, narrow, or extend the current draft. This includes phrases like "add", "also", "as well", "along with", "plus", "include", or "more".
- REMOVE_SIGNAL: user wants to drop signals from the current draft.
- ADD_SIGNAL: optional synonym for adding signals when hasExistingPlan is true; prefer REFINE_AUDIENCE.
- APPROVE_AUDIENCE: user confirms or approves the draft.
- ESTIMATE_AUDIENCE: user asks for reach/size estimate without approving.
- ASK_CLARIFICATION: the request is too vague to act on.

Critical:
- When hasExistingPlan is true, do NOT use BUILD_AUDIENCE unless the user explicitly asks to start over, replace everything, reset, or create a brand-new audience from scratch.
- When hasExistingPlan is true and the user adds a new segment (e.g. "add car lovers as well"), use REFINE_AUDIENCE so existing selected signals are kept.
- When hasExistingPlan is false and the user message has no concrete targeting concept (e.g. "build me an audience", "create a segment", "give me signals"), use ASK_CLARIFICATION and ask who they want to reach. Do NOT use BUILD_AUDIENCE for empty or vague briefs.
- audienceRequest should capture what to build or refine; use the latest user message text.
- signalsToAdd / signalsToRemove: keyword hints from the user message (arrays, may be empty).
- assistantReply: short action statement (not a question) for BUILD_AUDIENCE and REFINE_AUDIENCE. For ASK_CLARIFICATION, assistantReply must be a friendly question asking for concrete targeting details (behavior, interest, location, purchase, age, or demographic).

Output requirements:
- action is required.
- audienceRequest: plain string or null.
- signalsToAdd and signalsToRemove: arrays (never null).
- shouldEstimate and shouldApprove: booleans.
`,
      },
      {
        role: "user",
        content: JSON.stringify({
          latestUserMessage: message,
          hasExistingPlan,
          currentPlan: existingPlan,
          recentConversation: history.slice(-12),
          examples: [
            {
              hasExistingPlan: false,
              message: "fitness enthusiasts aged 25-44 with premium shopping habits",
              action: "BUILD_AUDIENCE",
            },
            {
              hasExistingPlan: false,
              message: "build me an audience",
              action: "ASK_CLARIFICATION",
              assistantReply:
                "Sure — who do you want to reach? Tell me a behavior, interest, location, purchase, or demographic to target.",
            },
            {
              hasExistingPlan: false,
              message: "create a segment",
              action: "ASK_CLARIFICATION",
            },
            {
              hasExistingPlan: true,
              message: "add car lover audience as well",
              action: "REFINE_AUDIENCE",
            },
          ],
          outputShape: {
            action:
              "GENERAL_REPLY|BUILD_AUDIENCE|REFINE_AUDIENCE|REMOVE_SIGNAL|ADD_SIGNAL|APPROVE_AUDIENCE|ESTIMATE_AUDIENCE|ASK_CLARIFICATION",
            assistantReply: "string",
            audienceRequest: "string|null",
            signalsToAdd: ["string"],
            signalsToRemove: ["string"],
            shouldEstimate: false,
            shouldApprove: false,
          },
        }),
      },
    ],
  });

  if (llmDecision) {
    return { decision: llmDecision, source: "llm" };
  }

  console.warn(
    `[agent-decision] LLM did not return a valid decision; using deterministic fallback (action=${fallback.action}).`,
  );
  return { decision: fallback, source: "fallback" };
}

function isAudienceRefinementAction(
  action: AgentDecision["action"],
  hasExistingPlan: boolean,
) {
  return (
    hasExistingPlan &&
    (action === "REFINE_AUDIENCE" || action === "ADD_SIGNAL")
  );
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

  return signals.filter((signal) => !signalMatchesRemoveTerms(signal, removeTerms));
}

function supplementalSignalsFromCandidates({
  candidates,
  selectedSignals,
  neededCount,
  blockedIds,
  focusTerms,
}: {
  candidates: RankedTaxonomySignal[];
  selectedSignals: RecommendedSignal[];
  neededCount: number;
  blockedIds?: Set<string>;
  focusTerms?: string[];
}) {
  if (neededCount <= 0) {
    return [];
  }

  const selectedIds = new Set(selectedSignals.map((signal) => signal.id));
  const blocked = blockedIds ?? new Set<string>();
  const terms = (focusTerms ?? []).map((term) => term.toLowerCase());

  const filtered = candidates
    .filter((candidate) => !selectedIds.has(candidate.id))
    .filter((candidate) => !blocked.has(candidate.id))
    .filter(
      (candidate) =>
        !isSensitiveText(`${candidate.name} ${candidate.path ?? ""}`),
    );

  const byFocusTerms =
    terms.length > 0
      ? filtered.filter((candidate) => {
          const text =
            `${candidate.name} ${candidate.path ?? ""} ${candidate.description ?? ""}`.toLowerCase();
          return terms.some((term) => text.includes(term));
        })
      : filtered;

  return (terms.length > 0 ? byFocusTerms : filtered)
    .slice(0, neededCount)
    .map((candidate, index) =>
      candidateToRecommendedSignal(candidate, selectedSignals.length + index),
    );
}

function extractFocusTerms(message: string) {
  const lower = message.toLowerCase();
  const terms = lower
    .split(/[^a-z0-9]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 2);

  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "those",
    "these",
    "audience",
    "audiences",
    "signal",
    "signals",
    "segment",
    "segments",
    "target",
    "targets",
    "add",
    "more",
    "also",
    "related",
    "about",
    "lover",
    "lovers",
  ]);

  const baseTerms = terms.filter((term) => !stopWords.has(term));
  const expanded = new Set(baseTerms);

  if (baseTerms.some((term) => ["car", "cars", "auto", "automotive", "vehicle"].includes(term))) {
    ["car", "cars", "auto", "automotive", "vehicle", "suv", "dealership"].forEach((term) =>
      expanded.add(term),
    );
  }
  if (baseTerms.some((term) => ["food", "foods", "dining", "restaurant", "grocery"].includes(term))) {
    [
      "food",
      "dining",
      "restaurant",
      "restaurants",
      "grocery",
      "groceries",
      "supermarket",
      "coffee",
      "cafe",
      "organic",
      "culinary",
    ].forEach((term) => expanded.add(term));
  }
  if (baseTerms.some((term) => ["fitness", "gym", "exercise", "running"].includes(term))) {
    ["fitness", "gym", "exercise", "running", "sports"].forEach((term) =>
      expanded.add(term),
    );
  }

  return [...expanded].slice(0, 20);
}

function candidateMatchesFocusTerms(
  candidate: RankedTaxonomySignal,
  focusTerms: string[],
) {
  if (focusTerms.length === 0) return true;
  const text =
    `${candidate.name} ${candidate.path ?? ""} ${candidate.description ?? ""}`.toLowerCase();
  return focusTerms.some((term) => text.includes(term.toLowerCase()));
}

function findRecentlyRemovedSignalIds(
  messages: Array<{
    role: MessageRole | string;
    metadata: unknown;
  }>,
) {
  const ids = new Set<string>();
  const recentAssistantMessages = [...messages]
    .reverse()
    .filter((item) => item.role === MessageRole.ASSISTANT)
    .slice(0, 12);

  for (const message of recentAssistantMessages) {
    if (!isRecord(message.metadata)) continue;

    const removedSignalId =
      typeof message.metadata.removedSignalId === "string"
        ? message.metadata.removedSignalId
        : null;
    if (removedSignalId) {
      ids.add(removedSignalId);
    }

    const removedSignalIds = Array.isArray(message.metadata.removedSignalIds)
      ? message.metadata.removedSignalIds.filter(
          (id): id is string => typeof id === "string",
        )
      : [];
    removedSignalIds.forEach((id) => ids.add(id));
  }

  return ids;
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
      estimate: Prisma.JsonNull,
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
  const estimate = await estimateAudienceSize({ selectedSignals, intent });

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
      estimate: Prisma.JsonNull,
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

async function removeSignalByText(conversationId: string, term: string) {
  const plan = await loadPlan(conversationId);
  const selectedSignals = jsonSignals(plan);
  const removeTerms = [term];

  const removedSignals = selectedSignals.filter((signal) =>
    signalMatchesRemoveTerms(signal, removeTerms),
  );
  const nextSignals = selectedSignals.filter(
    (signal) => !signalMatchesRemoveTerms(signal, removeTerms),
  );

  if (removedSignals.length === 0) {
    const hint =
      normalizeRemoveSearchTerms(term).join(", ") || term.toLowerCase();
    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content: `I could not find a selected signal matching "${term}". Try the signal name only (e.g. "remove ${hint}"), or remove it from the panel on the right.`,
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
      estimate: Prisma.JsonNull,
    },
  });

  const removedNames = removedSignals.map((signal) => signal.name).join(", ");
  await prisma.message.create({
    data: {
      conversationId,
      role: MessageRole.ASSISTANT,
      content:
        removedSignals.length === 1
          ? `Removed "${removedNames}" from the draft audience. The draft now has ${nextSignals.length} selected signal${nextSignals.length === 1 ? "" : "s"}.`
          : `Removed ${removedSignals.length} signals (${removedNames}). The draft now has ${nextSignals.length} selected signal${nextSignals.length === 1 ? "" : "s"}.`,
      metadata: {
        removedSignalIds: removedSignals.map((signal) => signal.id),
      },
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

  if (isSensitiveText(message)) {
    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content: sensitiveRequestMessage(),
        metadata: {
          action: "SENSITIVE_REQUEST_BLOCKED",
          source: "pre-llm-guard",
        },
      },
    });
    return;
  }

  if (!existingPlan && isVagueAudienceBrief(message)) {
    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content:
          "Sure — who do you want to reach? Describe the audience in a sentence or two. For example: \"fitness enthusiasts aged 25-44 with premium shopping habits\", \"parents of toddlers who shop at Whole Foods\", or \"luxury car shoppers in California\".",
        metadata: {
          action: "ASK_CLARIFICATION",
          reason: "vague-brief",
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

  const { decision, source: decisionSource } = await resolveAgentDecision({
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
        metadata: { decision, decisionSource },
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
  const isRefinement = isAudienceRefinementAction(
    decision.action,
    Boolean(existingPlan),
  );
  const recentlyRemovedSignalIds = findRecentlyRemovedSignalIds(
    conversation.messages,
  );

  let audienceRequest = normalizedDecisionRequest;

  if (isRefinement && existingPlan) {
    const currentIntent = jsonIntent(existingPlan);
    const currentSignals = jsonSignals(existingPlan).map(
      (signal) => signal.name,
    );
    const addCount = requestedSignalCountFromMessage(normalizedDecisionRequest);

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

  const focusTerms = isRefinement
    ? extractFocusTerms(
        [normalizedDecisionRequest, ...decision.signalsToAdd].join(" "),
      )
    : [];

  const intentSourceText = isRefinement ? normalizedDecisionRequest : audienceRequest;
  const currentSignalsForContext =
    existingPlan && isRefinement
      ? jsonSignals(existingPlan).map((signal) => signal.name)
      : [];
  const intent =
    (await extractAudienceIntent(intentSourceText, {
      mode: isRefinement ? "REFINE" : "BUILD",
      currentBrief: existingPlan?.brief ?? null,
      currentSignals: currentSignalsForContext,
      signalsToAdd: decision.signalsToAdd,
      signalsToRemove: removeTerms,
    })) ?? fallbackIntentFromMessage(intentSourceText);

  const llmSearchKeywords = Array.isArray(intent.searchKeywords)
    ? intent.searchKeywords.filter((keyword) => keyword.trim().length > 1)
    : [];
  const keywords =
    llmSearchKeywords.length > 0
      ? llmSearchKeywords
      : keywordsFromIntent(intent, intentSourceText);

  if (intent.sensitiveRequest) {
    const content = intent.safeAlternative ?? sensitiveRequestMessage();

    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content,
        metadata: { intent, decision, decisionSource },
      },
    });
    return;
  }

  const searchKeywords = keywords;
  const baseCandidates = await searchTaxonomyByKeywords(searchKeywords);
  const taxonomyFocusTerms = isRefinement ? keywords : focusTerms;
  const filteredCandidates = baseCandidates
    .filter((candidate) => !recentlyRemovedSignalIds.has(candidate.id))
    .filter((candidate) => candidateMatchesFocusTerms(candidate, taxonomyFocusTerms));
  const candidates =
    isRefinement && filteredCandidates.length > 0
      ? filteredCandidates
      : baseCandidates.filter(
          (candidate) => !recentlyRemovedSignalIds.has(candidate.id),
        );

  const existingSignals = existingPlan ? jsonSignals(existingPlan) : [];
  const requestedCount = Math.max(
    1,
    Math.min(
      Number(requestedSignalCountFromMessage(message) ?? intent.requestedSignalCount ?? 5),
      20,
    ),
  );
  const addCount = existingPlan
    ? requestedSignalCountFromMessage(normalizedDecisionRequest)
    : null;

  const maxSignalsToAskFor =
    existingPlan && addCount ? existingSignals.length + addCount + 5 : requestedCount;

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

  const finalRecommendation: AudienceRecommendation = {
    ...recommendation,
    recommendedSignals:
      recommendedSignalsAfterRemoveTerms.length > 0
        ? recommendedSignalsAfterRemoveTerms
        : recommendation.recommendedSignals,
  };

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
        blockedIds: recentlyRemovedSignalIds,
        focusTerms: taxonomyFocusTerms,
      });

      addedSignals = [...addedSignals, ...supplementalSignals];
      selectedSignals = removeDuplicateSignals([
        ...selectedSignals,
        ...supplementalSignals,
      ]);
    }
  } else {
    addedSignals = finalRecommendation.recommendedSignals.slice(0, requestedCount);
    selectedSignals = finalRecommendation.recommendedSignals.slice(0, requestedCount);
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
      estimate: Prisma.JsonNull,
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
        decisionSource,
        candidateCount: candidates.length,
      },
    },
  });
}