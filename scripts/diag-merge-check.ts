import { getAdminClient } from "./_supabase-admin";
(async () => {
  const sb = getAdminClient();
  for (const mat of ["Burlap", "Applique", "Linen"]) {
    const { data } = await sb
      .from("designs")
      .select("design_family,approved_tags,shopify_tags")
      .eq("status", "readytosend")
      .contains("approved_tags", [mat])
      .limit(1);
    const d = data?.[0];
    if (!d) { console.log(`${mat}: none`); continue; }
    const st = d.shopify_tags ?? [];
    const at = d.approved_tags ?? [];
    const preserved = st.every((t: string) => at.some((a: string) => a.toLowerCase() === t.toLowerCase()));
    console.log(`${mat} — ${d.design_family}: approved=${at.length} tags, shopify=${st.length} tags, has "${mat}"=${at.includes(mat)}, all shopify preserved=${preserved}`);
    console.log(`   approved: ${at.slice(0, 14).join(", ")}${at.length > 14 ? " …" : ""}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
