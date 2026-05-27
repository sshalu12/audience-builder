import type { AudienceEstimate, AudienceIntent, RecommendedSignal } from "./schemas.js";

const basePopulation = 250_000_000;

const sourceMultipliers: Record<RecommendedSignal["source"], number> = {
  LOCATION: 0.72,
  TRANSACTION: 0.68,
  CONSUMER_GRAPH_FIELD: 0.82,
  CONSUMER_GRAPH_VALUE: 0.78,
};

function rarityAdjustment(signal: RecommendedSignal) {
  const name = `${signal.name} ${signal.path ?? ""}`.toLowerCase();
  let multiplier = 1;

  if (name.includes("luxury") || name.includes("premium") || name.includes("affluent")) {
    multiplier *= 0.72;
  }

  if (name.includes("organic")) {
    multiplier *= 0.84;
  }

  if (name.includes("grocery") || name.includes("restaurant") || name.includes("supermarket")) {
    multiplier *= 1.12;
  }

  if (name.includes("fitness") || name.includes("gym") || name.includes("running")) {
    multiplier *= 0.9;
  }

  if (name.includes("suv") || name.includes("auto") || name.includes("vehicle")) {
    multiplier *= 0.8;
  }

  return Math.max(0.35, Math.min(multiplier, 1.2));
}

function ageMultiplier(intent?: AudienceIntent | null) {
  if (!intent?.ageRange?.min || !intent.ageRange.max) {
    return 1;
  }

  const span = Math.max(1, intent.ageRange.max - intent.ageRange.min + 1);
  return Math.min(Math.max(span / 78, 0.08), 0.9);
}

function deterministicJitter(signals: RecommendedSignal[]) {
  if (signals.length === 0) return 1;

  const key = signals
    .map((signal) => `${signal.id}:${signal.name}:${signal.source}`)
    .sort()
    .join("|");

  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }

  return 0.92 + (hash % 17) / 100;
}

export function estimateAudienceSize(input: {
  selectedSignals: RecommendedSignal[];
  intent?: AudienceIntent | null;
}): AudienceEstimate {
  const signals = input.selectedSignals;
  const assumptions: string[] = [
    "Base reachable population is assumed to be 250M adults/devices.",
    "Each selected signal narrows the audience using a deterministic signal-type multiplier.",
    "A rarity adjustment is applied for terms such as premium, luxury, organic, fitness, and automotive.",
    "Overlap discounting reduces the impact of each additional signal without forcing all audiences to the same floor.",
    "A deterministic combination adjustment is applied so different selected-signal sets produce different estimates.",
  ];

  if (signals.length === 0) {
    const reach = basePopulation * 0.5;

    return {
      estimatedMin: Math.round(reach * 0.8),
      estimatedMax: Math.round(reach * 1.2),
      confidence: 0.58,
      methodology:
        "Mock estimate generated from a broad fallback audience because no targeting signals were selected. Real count data was not provided in the exercise.",
      assumptions: [...assumptions, "No signals were selected, so the estimate uses a broad fallback audience."],
    };
  }

  let reach = basePopulation;

  signals.forEach((signal, index) => {
    const baseMultiplier = sourceMultipliers[signal.source] ?? 0.75;
    const overlapDiscount = 1 - Math.min(index, 8) * 0.025;

    reach *= baseMultiplier * rarityAdjustment(signal) * overlapDiscount;
  });

  const computedAgeMultiplier = ageMultiplier(input.intent);
  if (computedAgeMultiplier < 1) {
    reach *= computedAgeMultiplier;
    assumptions.push("Age range narrows the estimate using the requested min/max ages.");
  }

  reach *= deterministicJitter(signals);

  const minimumReach = basePopulation * 0.00005;
  reach = Math.max(reach, minimumReach);

  const uncertainty = Math.min(0.35, 0.18 + signals.length * 0.018);
  const estimatedMin = Math.max(1_000, Math.round(reach * (1 - uncertainty)));
  const estimatedMax = Math.max(estimatedMin + 1_000, Math.round(reach * (1 + uncertainty)));

  let confidence = 0.84;
  confidence -= Math.max(0, signals.length - 4) * 0.03;
  confidence += signals.reduce((sum, signal) => sum + signal.confidence, 0) / Math.max(signals.length, 1) * 0.08;
  confidence = Math.max(0.48, Math.min(confidence, 0.94));

  return {
    estimatedMin,
    estimatedMax,
    confidence: Number(confidence.toFixed(2)),
    methodology:
      "Mock estimate generated from a fixed base population, source-specific narrowing factors, rarity adjustments, overlap discounting, deterministic signal-combination adjustment, and optional age-range narrowing. Real count data was not provided in the exercise.",
    assumptions,
  };
}
