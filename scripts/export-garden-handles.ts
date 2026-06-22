/**
 * Export a { design_family → garden-flag Shopify handle } map for the
 * af-sales-research CSV "product_url" column, so it can link straight to
 * /products/<handle> instead of a SKU search.
 *
 * "Garden flag" = the product whose variant SKU starts with AFGF (each AF
 * design_family spans garden + house + banner products; we want the garden
 * one). Writes JSON to af-sales-research/lib/garden-handles.json.
 *
 *   npx tsx scripts/export-garden-handles.ts --limit 500   # quick sample
 *   npx tsx scripts/export-garden-handles.ts               # full pull + write
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { listProducts } from "../lib/shopify";
import { parseSku } from "../lib/sku-parser";

const OUT = resolve(
  "C:/Users/gbcab/ClownAntics Dropbox/Blake Cabot/Docs/Internet Business/200904 Clown/202604 AF Research App/af-sales-research/lib/garden-handles.json",
);

async function main() {
  const argv = process.argv.slice(2);
  const limIdx = argv.indexOf("--limit");
  const max = limIdx >= 0 ? Number(argv[limIdx + 1]) : undefined;

  const handles = new Map<string, string>();
  let seen = 0;
  let gardenProducts = 0;
  for await (const p of listProducts({ max })) {
    seen++;
    // Find a garden-flag variant SKU on this product.
    const gardenSku = (p.variants ?? [])
      .map((v) => (v.sku ?? "").trim().toUpperCase())
      .find((s) => s.startsWith("AFGF"));
    if (!gardenSku || !p.handle) continue;
    const parsed = parseSku(gardenSku);
    if (!parsed) continue;
    gardenProducts++;
    // First garden product wins per family (handles are stable; dupes rare).
    if (!handles.has(parsed.designFamily)) handles.set(parsed.designFamily, p.handle);
    if (seen % 1000 === 0) process.stdout.write(`  scanned ${seen}, garden families ${handles.size}\r`);
  }

  console.log(`\nScanned ${seen} products, ${gardenProducts} garden products, ${handles.size} families with a handle.`);
  console.log("Samples:");
  for (const [fam, h] of [...handles].slice(0, 8)) console.log(`  ${fam.padEnd(10)} ${h}`);

  if (max) {
    console.log("\n--limit set → sample only, not writing the JSON.");
    return;
  }
  const obj = Object.fromEntries([...handles].sort((a, b) => a[0].localeCompare(b[0])));
  writeFileSync(OUT, JSON.stringify(obj, null, 0) + "\n");
  console.log(`\nWrote ${handles.size} handles → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
