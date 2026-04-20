/**
 * Aggregate invoice line items into design_monthly_sales (design_family × YYYY-MM).
 *
 * Powers the "Units by month" chart in the DetailModal. Reads the same TeamDesk
 * invoice CSV that import-teamdesk.ts uses, groups by design_family and year-month,
 * sums Quantity, and upserts. Applies the same channel filter (CA and FLAMZ CAN
 * are skipped, matching the rest of the pipeline).
 *
 * Usage:
 *   npx tsx scripts/import-monthly-sales.ts                   # uses DEFAULT_CSV
 *   npx tsx scripts/import-monthly-sales.ts ./data/foo.csv
 *
 * Run whenever you refresh the invoice CSV. Idempotent — replaces the table.
 */
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { parse } from "csv-parse";
import { parseSku } from "../lib/sku-parser";
import { chunkedUpsert, getAdminClient } from "./_supabase-admin";

const DEFAULT_CSV =
  "C:/Users/gbcab/ClownAntics Dropbox/Blake Cabot/Docs/Internet Business/200904 Clown/202604 AF Research App/Invoice Line Items_AF Image Review Export.csv";

const SKIPPED_CHANNELS = new Set(["CA", "FLAMZ CAN"]);

interface Row {
  design_family: string;
  year_month: string;
  units: number;
}

async function main() {
  const csvPath = resolve(process.argv[2] || DEFAULT_CSV);
  console.log(`Reading: ${csvPath}\n`);

  // (family, YYYY-MM) → summed units
  const agg = new Map<string, number>();

  let rows = 0;
  let skippedParse = 0;
  let skippedChannel = 0;
  let skippedDate = 0;

  const parser = createReadStream(csvPath).pipe(
    parse({ columns: true, bom: true, skip_empty_lines: true, trim: true }),
  );

  for await (const r of parser as AsyncIterable<Record<string, string>>) {
    rows++;
    const rawSku = r["SKU"];
    const orderDate = r["Order Number - Date"];
    const source = r["Order Number - OrderSourceCalc"] || "";
    const quantityStr = r["Quantity"] || "0";
    const quantity = parseInt(quantityStr, 10);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    if (SKIPPED_CHANNELS.has(source)) {
      skippedChannel++;
      continue;
    }

    const parsed = parseSku(rawSku);
    if (!parsed) {
      skippedParse++;
      continue;
    }

    if (!orderDate || orderDate.length < 7) {
      skippedDate++;
      continue;
    }
    // TeamDesk format "2024-03-15 ..." — slice first 7 chars = "YYYY-MM".
    const yearMonth = orderDate.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
      skippedDate++;
      continue;
    }

    const key = `${parsed.designFamily}|${yearMonth}`;
    agg.set(key, (agg.get(key) || 0) + quantity);
  }

  console.log("Parse summary:");
  console.log(`  rows read:          ${rows}`);
  console.log(`  aggregated buckets: ${agg.size}`);
  console.log(`  skipped (channel):  ${skippedChannel}`);
  console.log(`  skipped (parse):    ${skippedParse}`);
  console.log(`  skipped (date):     ${skippedDate}`);
  console.log("");

  // Only keep rows whose design_family exists in the designs table (to avoid
  // FK violations on the upsert).
  const sb = getAdminClient();
  const knownFamilies = new Set<string>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family")
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    const chunk = (data || []) as { design_family: string }[];
    for (const d of chunk) knownFamilies.add(d.design_family);
    if (chunk.length < 1000) break;
  }

  const rowsToUpsert: Row[] = [];
  let droppedUnknown = 0;
  for (const [key, units] of agg.entries()) {
    const [design_family, year_month] = key.split("|");
    if (!knownFamilies.has(design_family)) {
      droppedUnknown++;
      continue;
    }
    rowsToUpsert.push({ design_family, year_month, units });
  }
  console.log(`  dropped (family not in designs): ${droppedUnknown}`);
  console.log(`  will upsert: ${rowsToUpsert.length}\n`);

  // Truncate first so old monthly data doesn't linger when the invoice CSV is
  // re-exported with a different window.
  console.log("Clearing existing design_monthly_sales…");
  const { error: delErr } = await sb
    .from("design_monthly_sales")
    .delete()
    .neq("design_family", "__never__");
  if (delErr) throw new Error(`delete: ${delErr.message}`);

  console.log(`Inserting ${rowsToUpsert.length} rows…`);
  await chunkedUpsert("design_monthly_sales", rowsToUpsert, sb, "design_family,year_month");

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
