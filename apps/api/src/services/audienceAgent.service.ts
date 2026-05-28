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

const defaultLowConfidenceThreshold = 0.75;

/**
 * Converts a planner's raw message into a short conversation title.
 * If the message is longer than 70 characters it is truncated to 67 chars and
 * "..." is appended so the title fits in a single line in the UI.
 */
function titleFromMessage(message: string) {
  const cleaned = message.replace(/\s+/g, " ").trim();
  return cleaned.length > 70 ? `${cleaned.slice(0, 67)}...` : cleaned;
}

/**
 * Strips assistant-style boilerplate from a message before processing it.
 * This handles the edge case where a planner accidentally pastes a previous
 * AI reply back into the chat. It detects known assistant marker phrases and,
 * if found, extracts only the last action-intent line (e.g. "estimate",
 * "approve") rather than treating the full pasted block as a new request.
 */
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

/**
 * Coerces the `audienceRequest` field from the LLM's agent-decision response
 * into a plain string. The LLM sometimes returns an object like
 * { text: "..." } or { request: "..." } instead of a bare string.
 * Falls back to the original planner message if the value is empty or
 * cannot be resolved to a string.
 */
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

/**
 * Parses phrases like "give me 5 more signals" or "add three additional
 * audiences" from the planner's message and returns the numeric count.
 * Supports digit forms ("5") and word forms ("five"). Returns null if no
 * explicit count is found, or 3 when the planner just says "add more"
 * without a specific number. Clamps the result to the range 1–20.
 */
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

/**
 * Returns true if the message is a yes/confirm-type reply.
 * Used to detect planner consent when the assistant has proposed a
 * pending action (e.g. removing low-confidence signals) and is waiting
 * for a "yes" before executing it.
 */
function isAffirmativeConfirmation(message: string) {
  return /^(yes|yep|yeah|sure|ok|okay|confirm|confirmed|remove|remove it|delete|delete it|do it|please remove|go ahead)\b/i.test(
    message.trim(),
  );
}

/**
 * Returns true if the message is a no/cancel-type reply.
 * Used as the counterpart to isAffirmativeConfirmation — if the planner
 * says "no" or "keep them", the pending action is cancelled instead of
 * executed.
 */
function isNegativeConfirmation(message: string) {
  return /^(no|nope|cancel|keep|keep them|do not|don't|stop)\b/i.test(
    message.trim(),
  );
}

/**
 * Extracts a confidence threshold from phrases like "below 80%" or
 * "under 0.6" in the planner's message. Converts percentage values (e.g.
 * 80) to a decimal (0.80) automatically. Clamps the result to 0.10–0.95.
 * Returns the default threshold of 0.75 if no explicit value is found.
 */
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

/**
 * Converts a decimal confidence value (e.g. 0.75) to a display-friendly
 * percentage string (e.g. "75%") for use in assistant reply messages.
 */
function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

/**
 * Deterministic (no-LLM) intent extraction using keyword pattern matching.
 * Called as the fallback when the LLM is unavailable or returns invalid JSON.
 * It scans the message for known domain keywords (fitness, premium, auto,
 * coffee, etc.) and populates the AudienceIntent fields manually.
 * If fewer than 3 words are in the message it sets clarificationNeeded=true
 * to prompt the planner for more detail.
 */
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

/**
 * LLM CALL #2 — Extracts a structured AudienceIntent object from the
 * planner's natural language message.
 *
 * The intent includes: ageRange, demographics, interests, behaviors,
 * locations, transactions, exclusions, sensitiveRequest flag, and most
 * importantly `searchKeywords` — concise terms used to drive the pgvector
 * taxonomy search.
 *
 * In REFINE mode the prompt includes the current brief and selected signal
 * names so the LLM focuses on what's new, not what already exists.
 * Falls back to fallbackIntentFromMessage() if the LLM call fails or
 * returns an invalid schema.
 */
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

/**
 * Generates a human-readable rationale sentence for a taxonomy signal
 * based on its source type. Each source type (LOCATION, TRANSACTION,
 * CONSUMER_GRAPH_FIELD, CONSUMER_GRAPH_VALUE) gets a different sentence
 * template that explains what the signal actually captures in plain English,
 * including the breadcrumb path when it differs from the signal name.
 */
function signalRationale(candidate: RankedTaxonomySignal): string {
  const name = cleanDisplayText(candidate.name);
  const path = candidate.path ? cleanDisplayText(candidate.path) : null;
  const breadcrumb = path && path !== name ? ` (under ${path})` : "";

  switch (candidate.source) {
    case "LOCATION":
      return `People who have physically visited ${name} locations${breadcrumb}, indicating real-world presence and intent in this category.`;
    case "TRANSACTION":
      return `People with purchase history or buying intent in ${name}${breadcrumb}, a strong behavioral signal for this audience.`;
    case "CONSUMER_GRAPH_FIELD":
      return `${name}${breadcrumb} — a demographic or interest attribute that directly characterises this audience segment.`;
    case "CONSUMER_GRAPH_VALUE":
      return `Targets individuals matching the specific profile value: ${name}${breadcrumb}.`;
    default:
      return `Taxonomy signal: ${name}${breadcrumb}.`;
  }
}

/**
 * Converts a RankedTaxonomySignal (raw DB row + score) into a
 * RecommendedSignal (the shape stored on AudiencePlan.selectedSignals).
 * The confidence score is derived from the candidate's position in the
 * ranked list and its raw search score:
 *   confidence = clamp(0.94 - index*0.045 + score*0.006, 0.58, 0.95)
 * Higher-ranked signals get higher confidence; the score bonus rewards
 * exact keyword matches.
 */
function candidateToRecommendedSignal(
  candidate: RankedTaxonomySignal,
  index: number,
): RecommendedSignal {
  const confidence = Math.max(
    0.58,
    Math.min(0.95, 0.94 - index * 0.045 + candidate.score * 0.006),
  );

  return {
    id: candidate.id,
    source: candidate.source,
    name: cleanDisplayText(candidate.name),
    path: candidate.path ? cleanDisplayText(candidate.path) : null,
    confidence: Number(confidence.toFixed(2)),
    rationale: signalRationale(candidate),
  };
}

/**
 * Clips a string to maxLength characters and appends "..." if truncated.
 * Used to keep the candidate payload sent to the LLM small enough that the
 * total prompt stays within the model's context window limit.
 */
function truncateForPrompt(value: string | null | undefined, maxLength = 160) {
  const cleaned = cleanDisplayText(value);
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3)}...` : cleaned;
}

/**
 * Deterministic (no-LLM) audience recommendation used when the LLM is
 * unavailable or returns invalid JSON. Takes the top 6 ranked taxonomy
 * candidates and converts them directly into recommended signals using
 * candidateToRecommendedSignal(). Sets clarificationNeeded=true if no
 * candidates were found.
 */
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

/**
 * LLM CALL #3 — Asks the LLM to select the best signals from the ranked
 * taxonomy candidates and write a specific rationale for each.
 *
 * Security: after the LLM responds, every recommended signal ID is validated
 * against the candidates map. IDs not in that map are silently dropped —
 * the LLM cannot hallucinate a signal that doesn't exist in the database.
 *
 * If the LLM selects fewer than maxSignals valid signals, supplemental
 * candidates are appended using candidateToRecommendedSignal() to ensure
 * the planner always sees a useful set of results.
 */
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

Rationale rules — this is important:
- rationale must be a single specific sentence that explains TWO things:
  1. What behaviour or attribute this signal captures (e.g. "people who have purchased running shoes")
  2. Why that makes it relevant to the planner's request (e.g. "indicating active interest in fitness")
- Do NOT write generic phrases like "aligns with the request" or "matches the audience".
- Do NOT copy the signal name as the entire rationale.
- Each signal must have a DIFFERENT rationale that reflects its own unique meaning.
- Example good rationale: "Captures people who dine out frequently at restaurants, directly matching the food-lover behaviour the planner is targeting."
- Example bad rationale: "Transaction match from the provided taxonomy that aligns with the requested audience."
`,
      },
      {
        role: "user",
        content: JSON.stringify({
          plannerRequest: message,
          extractedIntent: intent,
          candidates: candidatePayload,
          outputShape: {
            audienceName: "short descriptive name for the audience",
            summary: "1-2 sentence summary of the targeting strategy",
            recommendedSignals: [
              {
                id: "exact candidate id from the list above",
                source:
                  "LOCATION|TRANSACTION|CONSUMER_GRAPH_FIELD|CONSUMER_GRAPH_VALUE",
                name: "exact candidate name from the list above",
                path: "candidate path or null",
                confidence: 0.85,
                rationale: "One specific sentence: what this signal captures AND why it matches the planner's request.",
              },
            ],
            rejectedSignals: [
              { id: "string", name: "string", reason: "why this candidate was not selected" },
            ],
            clarificationNeeded: false,
            clarificationQuestion: null,
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

/**
 * Formats a list of RecommendedSignals into a numbered plain-text list
 * suitable for inclusion in an assistant reply message. Each line shows:
 * "N. Signal Name (SOURCE TYPE) — XX% confidence. Rationale sentence."
 * Returns "No signals selected yet." if the list is empty.
 */
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

/**
 * Builds the full assistant reply when a brand-new audience draft is created
 * (BUILD_AUDIENCE action). The message includes: the audience name, summary,
 * the numbered signal list, and instructions for next steps (approve, remove,
 * add more, broaden/narrow). Appends a clarifying question when needed.
 */
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

/**
 * Builds the assistant reply after a REFINE_AUDIENCE or ADD_SIGNAL action.
 * Shows how many new signals were added (and how many were requested),
 * lists only the newly added signals (not the full plan), and states the
 * updated total signal count. Includes next-step prompts for the planner.
 */
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

/**
 * Builds the assistant reply for the SHOW_SELECTED_SIGNALS action.
 * Lists every currently selected signal with name, source, confidence,
 * and rationale. Also shows the latest audience size estimate if one
 * has been calculated. Returns a short message if no signals exist yet.
 */
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

/**
 * Builds the assistant reply for the EXPLAIN_CURRENT_DRAFT action.
 * Gives the audience a plain-English explanation: the audience name,
 * its summary, and what each selected signal means in real-world terms.
 * Ends with a sentence explaining that these signals are the actual
 * targeting criteria the platform would apply.
 */
function formatCurrentDraftExplanation(plan: {
  audienceName: string | null;
  summary: string | null;
  selectedSignals: unknown;
}) {
  const selectedSignals = jsonSignals(plan);
  const name = plan.audienceName ?? "current draft audience";
  const summary =
    plan.summary ??
    "This draft is built from taxonomy-backed signals that matched your audience request.";

  if (selectedSignals.length === 0) {
    return `The current draft audience is "${name}", but it does not have any selected signals yet. Tell me who you want to reach and I can build it with taxonomy-backed signals.`;
  }

  return [
    `The current draft audience is "${name}".`,
    summary,
    "",
    "Each selected signal means:",
    formatSignalList(selectedSignals),
    "",
    "In plain English, these signals are the criteria the platform would use to find people who match the audience.",
  ].join("\n");
}

/**
 * Builds the assistant reply for the REVIEW_LOW_CONFIDENCE_SIGNALS action.
 * Lists all selected signals whose confidence is below the given threshold
 * and asks the planner to confirm whether they should be removed. The IDs
 * are stored in the message metadata as a pendingAction so the next yes/no
 * reply can execute or cancel the removal without another LLM call.
 */
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

/**
 * Builds the confirmation message sent after low-confidence signals have
 * been removed from the draft. Lists each removed signal and states the
 * new total signal count. Returns a "nothing was removed" message if the
 * signal IDs were not found in the current draft (e.g. already removed).
 */
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

/**
 * Builds the assistant reply that displays an audience size estimate.
 * When approved=true, the message confirms approval and shows the locked
 * estimate range. When approved=false (preview/draft), it shows the estimate
 * but reminds the planner they need to approve to lock it in.
 */
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

/**
 * Normalises a raw remove term into a set of searchable token variants.
 * For example "Hiking signal" becomes ["hiking", "hiking signal"] after
 * lowercasing, stripping punctuation, and removing filler stop words like
 * "signal", "audience", "the". Both the full cleaned phrase and each
 * individual token are returned so partial matches also work.
 */
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

/**
 * Returns true if a signal's name or path contains any of the remove terms
 * after normalisation. Used to match planner intent like "remove hiking"
 * against stored signal names like "Backpacking/Hiking" by checking all
 * token variants produced by normalizeRemoveSearchTerms().
 */
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

/**
 * Returns a minimal safe AgentDecision when the LLM is unavailable or
 * returns an invalid response for the routing call (LLM #1). If a plan
 * already exists it uses GENERAL_REPLY so the user sees an error message
 * without losing their draft. If no plan exists yet it uses ASK_CLARIFICATION.
 */
function fallbackAgentDecision(
  message: string,
  hasExistingPlan: boolean,
): AgentDecision {
  return {
    action: hasExistingPlan ? "GENERAL_REPLY" : "ASK_CLARIFICATION",
    assistantReply:
      "I am having trouble reaching the LLM right now. Please try again in a moment.",
    audienceRequest: null,
    signalsToAdd: [],
    signalsToRemove: [],
    needsMoreInfo: !hasExistingPlan,
    shouldEstimate: false,
    shouldApprove: false,
  };
}

type ResolvedAgentDecision = {
  decision: AgentDecision;
  source: "llm" | "fallback";
};

/**
 * LLM CALL #1 — Reads the planner's latest message, the current plan
 * summary, and the last 12 conversation turns, then returns a structured
 * AgentDecision selecting exactly one action from the allowed enum:
 * BUILD_AUDIENCE, REFINE_AUDIENCE, REMOVE_SIGNAL, ADD_SIGNAL,
 * APPROVE_AUDIENCE, ESTIMATE_AUDIENCE, SHOW_SELECTED_SIGNALS,
 * EXPLAIN_CURRENT_DRAFT, REVIEW_LOW_CONFIDENCE_SIGNALS, ASK_CLARIFICATION,
 * or GENERAL_REPLY.
 *
 * Returns both the decision and its source ("llm" | "fallback") so callers
 * can include provenance in message metadata for debugging.
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

Available actions:
- GENERAL_REPLY: answer conversationally without changing the draft.
- BUILD_AUDIENCE: create or replace an audience from a planner's targeting brief.
- REFINE_AUDIENCE: update the current draft by adding, broadening, narrowing, or emphasizing targeting concepts.
- REMOVE_SIGNAL: remove one or more selected signals from the current draft.
- ADD_SIGNAL: same intent as REFINE_AUDIENCE; use only if the user specifically asks to add signals.
- APPROVE_AUDIENCE: approve the current draft.
- ESTIMATE_AUDIENCE: estimate current draft reach without approving.
- SHOW_SELECTED_SIGNALS: show the current selected signals exactly as stored.
- EXPLAIN_CURRENT_DRAFT: explain what the current draft, audience, or selected signals mean.
- REVIEW_LOW_CONFIDENCE_SIGNALS: review selected signals with weak confidence and ask whether to remove them.
- ASK_CLARIFICATION: ask a useful follow-up when you cannot safely choose another action.

Routing rules:
- You decide the action from the latest user message, currentPlan, and recentConversation. Do not rely on keyword matching; infer intent from meaning.
- GENERAL_REPLY must answer naturally in the assistant's voice. Do not echo or repeat the user's message.
- If the user asks a casual question, greeting, product question, or explanation that does not require a database change, use GENERAL_REPLY or EXPLAIN_CURRENT_DRAFT.
- If hasExistingPlan is false, use BUILD_AUDIENCE only when the user gives a usable targeting brief. Otherwise use ASK_CLARIFICATION.
- If hasExistingPlan is true, keep the existing draft unless the user clearly asks to replace, reset, or start over.
- For REMOVE_SIGNAL, put human-readable signal names or concepts in signalsToRemove.
- For REFINE_AUDIENCE or ADD_SIGNAL, put requested concepts in signalsToAdd and put the user request in audienceRequest.
- assistantReply should be a helpful natural-language response for GENERAL_REPLY and ASK_CLARIFICATION. For actions that the backend will execute, use a short action statement.
- If you need more information from the user, set needsMoreInfo=true and choose ASK_CLARIFICATION. Never set needsMoreInfo=true while choosing BUILD_AUDIENCE or REFINE_AUDIENCE.

Output requirements:
- action is required.
- audienceRequest: plain string or null.
- signalsToAdd and signalsToRemove: arrays (never null).
- needsMoreInfo: boolean.
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
          outputShape: {
            action:
              "GENERAL_REPLY|BUILD_AUDIENCE|REFINE_AUDIENCE|REMOVE_SIGNAL|ADD_SIGNAL|APPROVE_AUDIENCE|ESTIMATE_AUDIENCE|SHOW_SELECTED_SIGNALS|EXPLAIN_CURRENT_DRAFT|REVIEW_LOW_CONFIDENCE_SIGNALS|ASK_CLARIFICATION",
            assistantReply: "string",
            audienceRequest: "string|null",
            signalsToAdd: ["string"],
            signalsToRemove: ["string"],
            needsMoreInfo: false,
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

/**
 * Returns true when the action should be treated as a refinement of an
 * existing plan rather than a full rebuild. Refinement means: keep existing
 * signals, merge in new ones, and preserve the original brief. Only true
 * when a plan already exists AND the action is REFINE_AUDIENCE or ADD_SIGNAL.
 */
function isAudienceRefinementAction(
  action: AgentDecision["action"],
  hasExistingPlan: boolean,
) {
  return (
    hasExistingPlan &&
    (action === "REFINE_AUDIENCE" || action === "ADD_SIGNAL")
  );
}

/**
 * Returns true if the action is one that triggers the full intent-extract →
 * taxonomy-search → LLM-recommend pipeline. Used to guard against sending
 * the planner to that pipeline when needsMoreInfo=true is set.
 */
function isAudienceBuildAction(action: AgentDecision["action"]) {
  return (
    action === "BUILD_AUDIENCE" ||
    action === "REFINE_AUDIENCE" ||
    action === "ADD_SIGNAL"
  );
}

/**
 * Loads the AudiencePlan for a conversation from the database.
 * Throws a 400 HttpError if no plan exists yet — callers use this to
 * guard actions (approve, remove, estimate) that require a plan to be
 * present before they can proceed.
 */
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

/**
 * Safely casts the JSONB `selectedSignals` column value to a typed
 * RecommendedSignal array. Prisma returns JSONB columns as `unknown`
 * because Zod/Prisma don't know the embedded shape at the ORM layer.
 */
function jsonSignals(plan: { selectedSignals: unknown }) {
  return (plan.selectedSignals ?? []) as RecommendedSignal[];
}

/**
 * Safely casts the JSONB `intent` column value to AudienceIntent | null.
 * Returns null when no intent has been stored yet (e.g. plan was just
 * created or the field is missing from an older row).
 */
function jsonIntent(plan: { intent: unknown }) {
  return (plan.intent ?? null) as AudienceIntent | null;
}

/**
 * Deduplicates a RecommendedSignal array by signal ID, preserving the
 * original order. The first occurrence of each ID is kept; subsequent
 * duplicates are discarded. Used after merging existing and new signals
 * to prevent the same taxonomy entry appearing twice in a plan.
 */
function removeDuplicateSignals(signals: RecommendedSignal[]) {
  const seen = new Set<string>();

  return signals.filter((signal) => {
    if (seen.has(signal.id)) return false;
    seen.add(signal.id);
    return true;
  });
}

/**
 * Merges new signals into an existing signal list, skipping any that are
 * already selected (by ID). If `limit` is provided, only the first `limit`
 * new signals are added — used when the planner requested a specific count
 * like "add 3 more". Returns both the added slice and the full merged list.
 */
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

/**
 * Removes signals from a list whose name or path matches any of the
 * remove terms. Used to apply REMOVE_SIGNAL intent during a REFINE action
 * when the planner says something like "add more fitness but remove hiking".
 * Returns the original list unchanged if removeTerms is empty.
 */
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

/**
 * Fills remaining signal slots from taxonomy candidates when the LLM
 * selected fewer signals than the planner requested. Filters out signals
 * already selected, blocked IDs (recently removed), and sensitive content.
 * When focusTerms are provided only candidates whose text contains at
 * least one focus term are included, keeping supplemental picks on-topic.
 */
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

/**
 * Extracts domain-specific keywords from a refinement message for use as
 * candidate filters. Strips stop words and expands known domain groups:
 * e.g. "car" expands to ["car", "cars", "auto", "automotive", "suv", ...].
 * Returns up to 20 terms. Used to make sure supplemental candidates stay
 * semantically relevant to the new concept the planner introduced.
 */
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

/**
 * Returns true if the candidate's name, path, or description contains at
 * least one of the focus terms (case-insensitive). When focusTerms is
 * empty every candidate passes (no filter applied). Used during refinement
 * to narrow the candidate pool to signals that are topically relevant to
 * the new concept the planner asked for.
 */
function candidateMatchesFocusTerms(
  candidate: RankedTaxonomySignal,
  focusTerms: string[],
) {
  if (focusTerms.length === 0) return true;
  const text =
    `${candidate.name} ${candidate.path ?? ""} ${candidate.description ?? ""}`.toLowerCase();
  return focusTerms.some((term) => text.includes(term.toLowerCase()));
}

/**
 * Scans the last 12 assistant messages' metadata for signal IDs that were
 * previously removed. Returns a Set of those IDs so the taxonomy search
 * and supplemental-signal logic can exclude them — preventing the agent
 * from immediately re-recommending a signal the planner just removed.
 */
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

/**
 * Type guard that checks whether a value is a plain object (not null, not
 * an array). Used throughout the service to safely access `metadata` fields
 * from message rows, which are typed as `unknown` by Prisma.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks whether the previous assistant message was a REVIEW_LOW_CONFIDENCE
 * prompt that is now waiting for planner confirmation (yes/no).
 * Looks at the last assistant message before the current user message and
 * reads its `pendingAction` metadata field. Returns the pending signal IDs
 * and threshold if found, or null if there is no pending action to resolve.
 */
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

/**
 * Executes the deferred low-confidence signal removal after the planner
 * confirms with "yes". Loads the current plan, splits selectedSignals into
 * removed (IDs in the pending set) and remaining, saves the remaining list
 * to the DB (resetting estimate fields), and writes an assistant confirmation
 * message with the removed signal names and the new total count.
 */
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

/**
 * EXPORTED — Approves or previews an audience plan.
 *
 * Runs the audience size estimator against the current selected signals and
 * intent, then writes the estimate fields to AudiencePlan. When approved=true
 * (APPROVE action) the plan and conversation are both marked APPROVED and the
 * estimate is locked. When approved=false (ESTIMATE action) the plan stays in
 * DRAFT but the estimate is still saved so the planner can see a preview.
 * Saves an assistant message with the estimate range and confidence.
 */
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

/**
 * EXPORTED — Removes a single signal from the plan by its exact database ID.
 * Called from the REST route when the planner clicks the remove button in the
 * UI panel (as opposed to typing "remove hiking" in the chat). Resets the
 * estimate fields to null since the audience composition changed, and saves
 * an assistant confirmation message.
 */
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

/**
 * Removes signals from the plan that match a text term typed in the chat
 * (e.g. "remove hiking"). Uses signalMatchesRemoveTerms() for fuzzy matching
 * so "hiking" also matches "Backpacking/Hiking". If no matching signal is
 * found, writes a helpful hint message showing what search term was tried.
 * Resets estimate fields and writes a confirmation message on success.
 */
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

/**
 * EXPORTED — Main entry point for every planner chat message.
 *
 * Full orchestration flow (in order):
 *  1. Clean the raw message (strip any pasted assistant text).
 *  2. Load the conversation with its plan and full message history.
 *  3. Check for a pending low-confidence removal — if the last assistant
 *     message was a yes/no prompt, resolve it immediately and return early.
 *  4. Block sensitive requests before any LLM call.
 *  5. LLM #1 — resolveAgentDecision() picks the action.
 *  6. Handle simple non-pipeline actions without calling more LLMs:
 *     needsMoreInfo guard, SHOW_SELECTED_SIGNALS, EXPLAIN_CURRENT_DRAFT,
 *     REVIEW_LOW_CONFIDENCE_SIGNALS, GENERAL_REPLY, ASK_CLARIFICATION,
 *     APPROVE_AUDIENCE, ESTIMATE_AUDIENCE, REMOVE_SIGNAL.
 *  7. For BUILD/REFINE/ADD_SIGNAL actions:
 *     a. Build the full audience request string (with context for refinement).
 *     b. LLM #2 — extractAudienceIntent() → structured intent + searchKeywords.
 *     c. pgvector taxonomy search → ranked candidates.
 *     d. LLM #3 — recommendAudience() → validated signal selection.
 *     e. Apply remove-term filters, merge with existing signals (refinement),
 *        top up with supplemental candidates if short.
 *     f. Upsert AudiencePlan, update conversation title/status.
 *     g. Save assistant message with full metadata for debugging.
 */
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

  const { decision, source: decisionSource } = await resolveAgentDecision({
    message,
    existingPlan,
    history: conversation.messages.map((item) => ({
      role: item.role,
      content: item.content,
    })),
  });

  if (
    isAudienceBuildAction(decision.action) &&
    decision.needsMoreInfo
  ) {
    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content: decision.assistantReply,
        metadata: {
          decision: {
            ...decision,
            action: "ASK_CLARIFICATION",
          },
          decisionSource,
          correctedInconsistentAction: decision.action,
        },
      },
    });
    return;
  }

  if (existingPlan && decision.action === "SHOW_SELECTED_SIGNALS") {
    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content: formatAllSelectedSignalsMessage(existingPlan),
        metadata: {
          decision,
          decisionSource,
          selectedSignalCount: jsonSignals(existingPlan).length,
        },
      },
    });
    return;
  }

  if (existingPlan && decision.action === "EXPLAIN_CURRENT_DRAFT") {
    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content: formatCurrentDraftExplanation(existingPlan),
        metadata: {
          decision,
          decisionSource,
          selectedSignalCount: jsonSignals(existingPlan).length,
        },
      },
    });
    return;
  }

  if (existingPlan && decision.action === "REVIEW_LOW_CONFIDENCE_SIGNALS") {
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
    !existingPlan &&
    decision.action !== "BUILD_AUDIENCE" &&
    decision.action !== "REFINE_AUDIENCE" &&
    decision.action !== "ADD_SIGNAL"
  ) {
    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content:
          decision.assistantReply ||
          "There is no draft audience yet. Tell me who you want to reach, and I can build one first.",
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

  if (
    existingPlan &&
    decision.action === "REMOVE_SIGNAL" &&
    removeTerms.length > 0
  ) {
    await removeSignalByText(conversationId, removeTerms[0]);
    return;
  }

  if (existingPlan && decision.action === "REMOVE_SIGNAL") {
    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.ASSISTANT,
        content:
          decision.assistantReply ||
          "Which selected signal should I remove from the current draft?",
        metadata: { decision, decisionSource },
      },
    });
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