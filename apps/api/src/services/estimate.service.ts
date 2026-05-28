import type { TaxonomySignal } from "@prisma/client";
import { prisma } from "../db.js";
import type {
  AudienceEstimate,
  AudienceIntent,
  RecommendedSignal,
} from "./schemas.js";

const basePopulation = 250_000_000;
const ageSpanFullRange = 78;

// Fallback priors used only when the taxonomy record for a signal cannot be
// resolved. The data-driven path below is the primary source of prevalence.
const fallbackPriors: Record<RecommendedSignal["source"], number> = {
  LOCATION: 0.1,
  TRANSACTION: 0.1,
  CONSUMER_GRAPH_FIELD: 0.15,
  CONSUMER_GRAPH_VALUE: 0.1,
};

function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ageFraction(intent?: AudienceIntent | null) {
  if (!intent?.ageRange?.min || !intent.ageRange.max) {
    return 1;
  }

  const span = Math.max(1, intent.ageRange.max - intent.ageRange.min + 1);
  return clamp(span / ageSpanFullRange, 0.08, 0.95);
}

// Per-signal prevalence derived from the four provided CSVs (as seeded into
// `TaxonomySignal`). Each branch reads the columns that exist for that source:
//   LOCATION  -> `location_taxonomy.csv` top_category / sub_category
//   TRANSACTION -> `transaction_taxonomy.csv` 4-level hierarchy
//   CONSUMER_GRAPH_FIELD -> `cg_data_dictionary.csv` Field Type + Attributes
//   CONSUMER_GRAPH_VALUE -> 1 / (parent field cardinality from the dictionary)
function prevalenceFromTaxonomy(
  record: TaxonomySignal,
  parentCardinality?: number,
): number {
  if (record.source === "LOCATION") {
    // Top-level visit category is much broader than a specific sub-category.
    return record.level2 ? 0.04 : 0.12;
  }

  if (record.source === "TRANSACTION") {
    const depth = [record.level1, record.level2, record.level3, record.level4]
      .filter(Boolean).length;
    const byDepth = [0.2, 0.1, 0.05, 0.03];
    return byDepth[Math.max(0, depth - 1)] ?? 0.05;
  }

  if (record.source === "CONSUMER_GRAPH_FIELD") {
    const raw = (record.raw ?? {}) as Record<string, string>;
    const type = (raw["Field Type"] ?? "").toUpperCase();
    const attrs = Number(raw["Attributes"]);

    // BOOL fields mean "has this trait" (e.g. credit_card_premium).
    if (type === "BOOL") return 0.2;
    // INT fields span a range; selecting the field alone is broad.
    if (type === "INT") return 0.8;
    // ALPHA / ALPHA_NUM with N distinct values: uniform prior of 1/N,
    // bounded so a binary-like field doesn't dominate.
    if (Number.isFinite(attrs) && attrs > 1) {
      return clamp(1 / attrs, 0.02, 0.5);
    }
    return 0.15;
  }

  // CONSUMER_GRAPH_VALUE: prevalence is 1 / (cardinality of the parent field).
  // e.g. gender has 2 values -> ~50%; language has 78 values -> ~1.3%.
  if (
    typeof parentCardinality === "number" &&
    Number.isFinite(parentCardinality) &&
    parentCardinality > 1
  ) {
    return clamp(1 / parentCardinality, 0.02, 0.5);
  }
  return 0.1;
}

function groupBySource(signals: RecommendedSignal[]) {
  const groups = new Map<RecommendedSignal["source"], RecommendedSignal[]>();
  for (const signal of signals) {
    const list = groups.get(signal.source) ?? [];
    list.push(signal);
    groups.set(signal.source, list);
  }
  return groups;
}

function orWithinGroup(
  signals: RecommendedSignal[],
  prevalenceById: Map<string, number>,
) {
  // Standard probabilistic OR assuming approximate independence within source.
  // The first signal sets the floor; additional signals nudge it up but with
  // diminishing returns because intra-source signals correlate.
  let nonMatch = 1;
  for (const signal of signals) {
    const prior =
      prevalenceById.get(signal.id) ?? fallbackPriors[signal.source] ?? 0.12;
    // Confidence modulates the prior only slightly: a low-quality taxonomy
    // match should not promise a higher prevalence than it deserves.
    const confidence = clamp(signal.confidence, 0, 1);
    const effective = prior * (0.85 + 0.15 * confidence);
    nonMatch *= 1 - effective;
  }
  return 1 - nonMatch;
}

async function buildPrevalenceMap(signals: RecommendedSignal[]) {
  const ids = signals.map((signal) => signal.id);
  const records = await prisma.taxonomySignal.findMany({
    where: { id: { in: ids } },
  });
  const recordById = new Map(records.map((record) => [record.id, record]));

  // For CONSUMER_GRAPH_VALUE signals we need the parent field's cardinality
  // (from cg_data_dictionary.csv -> Attributes). One batched query covers all.
  const parentFieldNames = [
    ...new Set(
      records
        .filter(
          (record) =>
            record.source === "CONSUMER_GRAPH_VALUE" && record.fieldName,
        )
        .map((record) => record.fieldName as string),
    ),
  ];

  const parentCardinalityByField = new Map<string, number>();
  if (parentFieldNames.length > 0) {
    const parents = await prisma.taxonomySignal.findMany({
      where: {
        source: "CONSUMER_GRAPH_FIELD",
        fieldName: { in: parentFieldNames },
      },
    });
    for (const parent of parents) {
      const raw = (parent.raw ?? {}) as Record<string, string>;
      const attrs = Number(raw["Attributes"]);
      if (parent.fieldName && Number.isFinite(attrs)) {
        parentCardinalityByField.set(parent.fieldName, attrs);
      }
    }
  }

  const prevalenceById = new Map<string, number>();
  for (const signal of signals) {
    const record = recordById.get(signal.id);
    if (!record) continue;
    const parentN =
      record.source === "CONSUMER_GRAPH_VALUE" && record.fieldName
        ? parentCardinalityByField.get(record.fieldName)
        : undefined;
    prevalenceById.set(signal.id, prevalenceFromTaxonomy(record, parentN));
  }

  return prevalenceById;
}

export async function estimateAudienceSize(input: {
  selectedSignals: RecommendedSignal[];
  intent?: AudienceIntent | null;
}): Promise<AudienceEstimate> {
  const signals = input.selectedSignals;

  const assumptions: string[] = [
    "Base reachable population is assumed to be 250M adults/devices.",
    "Age range narrows the base population before applying signal constraints.",
    "Per-signal prevalence is derived from the provided taxonomy data: location/transaction hierarchy depth, consumer graph field type, and field-value cardinality.",
    "Signals within the same source are combined as probabilistic OR (alternative ways to reach the same audience).",
    "Signals across sources are combined as probabilistic AND (independent constraints), with a small cross-source correlation lift that is capped at the smallest group's probability.",
    "Confidence is a quality score over the evidence (signal count, source diversity, average match confidence) and is independent of the reach number.",
  ];

  const effectiveBase = basePopulation * ageFraction(input.intent);

  if (signals.length === 0) {
    const reach = effectiveBase * 0.6;
    return {
      estimatedMin: Math.round(reach * 0.7),
      estimatedMax: Math.round(reach * 1.3),
      confidence: 0.5,
      methodology:
        "No targeting signals are selected, so the estimate uses a broad fallback fraction of the age-adjusted base population.",
      assumptions: [
        ...assumptions,
        "Fallback used because no signals were selected.",
      ],
    };
  }

  const prevalenceById = await buildPrevalenceMap(signals);

  const groups = groupBySource(signals);
  const groupProbabilities = [...groups.values()].map((groupSignals) =>
    orWithinGroup(groupSignals, prevalenceById),
  );
  const distinctSources = groupProbabilities.length;

  // AND across sources, with a small correlation lift for richer source mixes.
  const rawProduct = groupProbabilities.reduce((acc, p) => acc * p, 1);
  const overlapLift = clamp(1 + 0.15 * (distinctSources - 1), 1, 1.6);
  const minGroupProbability = Math.min(...groupProbabilities);

  // The intersection cannot exceed the smallest contributing group: that group
  // is itself a hard upper bound on the population matching every constraint.
  const audienceProbability = Math.min(
    rawProduct * overlapLift,
    minGroupProbability,
  );

  // Floor at 0.01% of the age-adjusted base so we never return 0 or absurdly
  // small numbers for tightly-targeted briefs.
  const reach = Math.max(
    effectiveBase * audienceProbability,
    effectiveBase * 0.0001,
  );

  const avgSignalConfidence = average(
    signals.map((signal) => clamp(signal.confidence, 0, 1)),
  );

  // Confidence: more signals + more diverse sources + stronger matches => higher.
  const confidence = clamp(
    0.4 +
      Math.min(signals.length, 8) * 0.035 +
      Math.max(0, distinctSources - 1) * 0.05 +
      avgSignalConfidence * 0.2,
    0.4,
    0.9,
  );

  // Uncertainty band: shrinks with more signals/sources/confidence, but never
  // collapses to zero because the underlying priors are themselves uncertain.
  const uncertainty = clamp(
    0.35 -
      Math.min(signals.length, 8) * 0.02 -
      Math.max(0, distinctSources - 1) * 0.02 +
      (1 - avgSignalConfidence) * 0.1,
    0.15,
    0.45,
  );

  const estimatedMin = Math.max(1_000, Math.round(reach * (1 - uncertainty)));
  const estimatedMax = Math.max(
    estimatedMin + 1_000,
    Math.round(reach * (1 + uncertainty)),
  );

  if (input.intent?.ageRange?.min && input.intent.ageRange.max) {
    assumptions.push(
      `Age range ${input.intent.ageRange.min}-${input.intent.ageRange.max} narrowed the base from 250M to ${Math.round(
        effectiveBase,
      ).toLocaleString()}.`,
    );
  }

  return {
    estimatedMin,
    estimatedMax,
    confidence: Number(confidence.toFixed(2)),
    methodology:
      "Probabilistic intersection model: age narrows the base; per-signal prevalence comes from the taxonomy data (hierarchy depth or field-value cardinality); signals OR within source and AND across sources, with a small correlation lift and a minimum-group ceiling.",
    assumptions,
  };
}
