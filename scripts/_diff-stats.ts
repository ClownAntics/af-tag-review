/**
 * Quick stats pass over vision_vs_shopify_diff.csv — surface the top themes
 * that vision added to designs where Shopify was missing them, and vice versa.
 * Lightweight; for a real analysis just pivot the CSV in Excel.
 */
import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import { resolve } from "node:path";

const CSV = resolve("./vision_vs_shopify_diff.csv");

async function main() {
  const visionOnly = new Map<string, number>();
  const shopifyOnly = new Map<string, number>();
  const agreementByBand: Record<string, Record<string, number>> = {};

  const parser = createReadStream(CSV).pipe(
    parse({ columns: true, bom: true, skip_empty_lines: true, trim: true }),
  );

  let total = 0;
  for await (const r of parser as AsyncIterable<Record<string, string>>) {
    total++;
    const classif = r.classification || "(null)";
    const agree = r.theme_agreement;
    agreementByBand[classif] ||= {};
    agreementByBand[classif][agree] = (agreementByBand[classif][agree] || 0) + 1;

    for (const t of (r.vision_only_themes || "").split(";").map((x) => x.trim()).filter(Boolean)) {
      visionOnly.set(t, (visionOnly.get(t) || 0) + 1);
    }
    for (const t of (r.shopify_only_themes || "").split(";").map((x) => x.trim()).filter(Boolean)) {
      shopifyOnly.set(t, (shopifyOnly.get(t) || 0) + 1);
    }
  }

  console.log(`Total: ${total} designs\n`);

  console.log("Agreement by classification band:");
  console.log("  band    same  one_broader  disjoint  no_vision");
  for (const band of ["hit", "solid", "ok", "weak", "dead"]) {
    const s = agreementByBand[band] || {};
    const sum = Object.values(s).reduce((a, b) => a + b, 0);
    const pct = (n: number) => sum ? ((n / sum) * 100).toFixed(1) + "%" : "-";
    console.log(
      `  ${band.padEnd(7)}  ${pct(s.same || 0).padStart(5)}  ${pct((s.vision_broader || 0) + (s.shopify_broader || 0)).padStart(11)}  ${pct(s.disjoint || 0).padStart(8)}  ${pct(s.no_vision || 0).padStart(9)}  (n=${sum})`,
    );
  }

  console.log("\nTop 20 themes VISION added that Shopify was missing:");
  Array.from(visionOnly.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([t, n]) => console.log(`  ${String(n).padStart(5)}  ${t}`));

  console.log("\nTop 20 themes SHOPIFY has that vision did not agree with:");
  Array.from(shopifyOnly.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([t, n]) => console.log(`  ${String(n).padStart(5)}  ${t}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
