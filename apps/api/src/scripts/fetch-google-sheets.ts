import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const sheetId = process.env.GOOGLE_SHEET_ID;
const sheets = [
  "location_taxonomy",
  "transaction_taxonomy",
  "cg_data_dictionary",
  "cg_field_values",
];

if (!sheetId) {
  console.error("GOOGLE_SHEET_ID is required. Add it to apps/api/.env or export it before running this script.");
  process.exit(1);
}

const dataDir = path.resolve(process.cwd(), "data");
await fs.mkdir(dataDir, { recursive: true });

for (const sheet of sheets) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheet)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch ${sheet}: ${response.status} ${await response.text()}`);
  }

  const csv = await response.text();
  const filePath = path.join(dataDir, `${sheet}.csv`);
  await fs.writeFile(filePath, csv, "utf8");
  console.log(`Wrote ${filePath}`);
}
