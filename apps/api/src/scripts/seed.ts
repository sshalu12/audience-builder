import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { parse } from "csv-parse/sync";
import { Role, SignalSource } from "@prisma/client";
import { prisma } from "../db.js";
import { generateEmbeddingsForAllSignals } from "../services/embedding.service.js";

function dataPath(fileName: string) {
  return path.resolve(process.cwd(), "data", fileName);
}

type CsvRow = Record<string, string | undefined>;

function readCsv(fileName: string): CsvRow[] {
  const filePath = dataPath(fileName);
  if (!fs.existsSync(filePath)) {
    console.warn(`Skipping missing file: ${filePath}`);
    return [];
  }

  const content = fs.readFileSync(filePath, "utf8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as CsvRow[];
}

function clean(value?: string | null) {
  const text = (value ?? "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : null;
}

function compactPath(...parts: Array<string | null | undefined>) {
  return parts.map(clean).filter(Boolean).join(" > ") || null;
}

function toJson(row: CsvRow) {
  return JSON.parse(JSON.stringify(row)) as Record<string, string>;
}

async function seedUsers() {
  const passwordHash = await bcrypt.hash("password123", 12);

  await prisma.user.upsert({
    where: { email: "admin@example.com" },
    create: {
      email: "admin@example.com",
      name: "Demo Admin",
      passwordHash,
      role: Role.ADMIN,
    },
    update: { passwordHash, role: Role.ADMIN },
  });

  await prisma.user.upsert({
    where: { email: "planner@example.com" },
    create: {
      email: "planner@example.com",
      name: "Demo Planner",
      passwordHash,
      role: Role.PLANNER,
    },
    update: { passwordHash, role: Role.PLANNER },
  });
}

async function seedLocationTaxonomy() {
  const rows = readCsv("location_taxonomy.csv");
  const signals = rows.flatMap((row, index) => {
    const top = clean(row.top_category ?? row.Top_Category ?? row["top category"]);
    const sub = clean(row.sub_category ?? row.Sub_Category ?? row["sub category"]);
    const name = sub ?? top;

    if (!name) return [];

    return [
      {
        source: SignalSource.LOCATION,
        externalId: `location-${index + 1}`,
        name,
        description: sub ? `Location visit category under ${top}` : "Top-level location visit category",
        path: compactPath(top, sub),
        level1: top,
        level2: sub,
        raw: toJson(row),
      },
    ];
  });

  if (signals.length > 0) {
    await prisma.taxonomySignal.createMany({ data: signals });
  }

  return signals.length;
}

async function seedTransactionTaxonomy() {
  const rows = readCsv("transaction_taxonomy.csv");
  const signals = rows.flatMap((row, index) => {
    const level1 = clean(row["Level 1"] ?? row.level1 ?? row.Level1);
    const level2 = clean(row["Level 2"] ?? row.level2 ?? row.Level2);
    const level3 = clean(row["Level 3"] ?? row.level3 ?? row.Level3);
    const level4 = clean(row["Level 4"] ?? row.level4 ?? row.Level4);
    const name = level4 ?? level3 ?? level2 ?? level1;

    if (!name) return [];

    return [
      {
        source: SignalSource.TRANSACTION,
        externalId: `transaction-${index + 1}`,
        name,
        description: "Purchase category from transaction taxonomy",
        path: compactPath(level1, level2, level3, level4),
        level1,
        level2,
        level3,
        level4,
        raw: toJson(row),
      },
    ];
  });

  if (signals.length > 0) {
    await prisma.taxonomySignal.createMany({ data: signals });
  }

  return signals.length;
}

async function seedConsumerGraphDictionary() {
  const rows = readCsv("cg_data_dictionary.csv");
  const signals = rows.flatMap((row, index) => {
    const fieldDescription = clean(row["Field Description"] ?? row.field_description);
    const fieldName = clean(row["Field Name"] ?? row.field_name);
    const fieldType = clean(row["Field Type"] ?? row.field_type);
    const fieldValues = clean(row["Field Values"] ?? row.field_values);
    const min = clean(row["Field Range Min"] ?? row.field_range_min);
    const max = clean(row["Field Range Max"] ?? row.field_range_max);
    const name = fieldDescription ?? fieldName;

    if (!name) return [];

    return [
      {
        source: SignalSource.CONSUMER_GRAPH_FIELD,
        externalId: `cg-field-${index + 1}`,
        name,
        description: [
          fieldName ? `Field: ${fieldName}` : null,
          fieldType ? `Type: ${fieldType}` : null,
          fieldValues ? `Values: ${fieldValues}` : null,
          min || max ? `Range: ${min ?? ""}-${max ?? ""}` : null,
        ]
          .filter(Boolean)
          .join(" | "),
        path: compactPath("Consumer Graph", name),
        fieldName,
        fieldValue: fieldValues,
        raw: toJson(row),
      },
    ];
  });

  if (signals.length > 0) {
    await prisma.taxonomySignal.createMany({ data: signals });
  }

  return signals.length;
}

async function seedConsumerGraphValues() {
  const rows = readCsv("cg_field_values.csv");
  const signals = rows.flatMap((row, index) => {
    const fieldName = clean(row["Field Name"] ?? row.field_name);
    const fieldValue = clean(row["Field Value"] ?? row.field_value);
    const valueDescription = clean(row["Field Value Description"] ?? row.field_value_description);
    const name = fieldName && valueDescription ? `${fieldName}: ${valueDescription}` : valueDescription;

    if (!name) return [];

    return [
      {
        source: SignalSource.CONSUMER_GRAPH_VALUE,
        externalId: `cg-value-${index + 1}`,
        name,
        description: `Consumer graph lookup value for ${fieldName}`,
        path: compactPath("Consumer Graph Values", fieldName, valueDescription),
        fieldName,
        fieldValue,
        raw: toJson(row),
      },
    ];
  });

  if (signals.length > 0) {
    await prisma.taxonomySignal.createMany({ data: signals });
  }

  return signals.length;
}

async function main() {
  await seedUsers();
  await prisma.taxonomySignal.deleteMany();

  const counts = {
    location: await seedLocationTaxonomy(),
    transaction: await seedTransactionTaxonomy(),
    consumerGraphFields: await seedConsumerGraphDictionary(),
    consumerGraphValues: await seedConsumerGraphValues(),
  };

  console.log("Seed complete", counts);
  await generateEmbeddingsForAllSignals();
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
