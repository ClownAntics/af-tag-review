/**
 * Staff Picks report — every design currently tagged `Staff-Pick`, with who
 * picked it (the latest `staff_picked` event's actor) and when, plus a
 * per-person tally. Server component; gated by the auth middleware like the
 * rest of the app.
 */
import { getAdminSupabase } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

const STAFF_PICK_TAG = "Staff-Pick";

interface PickRow {
  design_family: string;
  design_name: string | null;
  image_url: string | null;
  manufacturer: string | null;
  status: string;
  picked_by: string | null;
  picked_at: string | null;
}

async function loadPicks(): Promise<PickRow[]> {
  const sb = getAdminSupabase();

  // 1. Designs currently carrying the Staff-Pick tag.
  const designs: {
    design_family: string;
    design_name: string | null;
    image_url: string | null;
    manufacturer: string | null;
    status: string;
  }[] = [];
  const PAGE = 1000;
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await sb
      .from("designs")
      .select("design_family,design_name,image_url,manufacturer,status")
      .contains("approved_tags", [STAFF_PICK_TAG])
      .range(o, o + PAGE - 1);
    if (error) throw new Error(error.message);
    const b = data ?? [];
    designs.push(...(b as typeof designs));
    if (b.length < PAGE) break;
  }

  // 2. Latest staff_picked event per family (who + when).
  const families = designs.map((d) => d.design_family);
  const latest = new Map<string, { actor: string | null; timestamp: string }>();
  for (let i = 0; i < families.length; i += 300) {
    const slice = families.slice(i, i + 300);
    const { data } = await sb
      .from("events")
      .select("design_family,actor,timestamp")
      .eq("event_type", "staff_picked")
      .in("design_family", slice)
      .order("timestamp", { ascending: false });
    for (const e of (data ?? []) as { design_family: string; actor: string | null; timestamp: string }[]) {
      // First row per family wins (desc order ⇒ latest).
      if (!latest.has(e.design_family)) latest.set(e.design_family, { actor: e.actor, timestamp: e.timestamp });
    }
  }

  return designs
    .map((d) => ({
      ...d,
      picked_by: latest.get(d.design_family)?.actor ?? null,
      picked_at: latest.get(d.design_family)?.timestamp ?? null,
    }))
    .sort((a, b) => (b.picked_at ?? "").localeCompare(a.picked_at ?? ""));
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export default async function StaffPicksPage() {
  let picks: PickRow[] = [];
  let error: string | null = null;
  try {
    picks = await loadPicks();
  } catch (e) {
    error = (e as Error).message;
  }

  const byPicker = new Map<string, number>();
  for (const p of picks) byPicker.set(p.picked_by ?? "unknown", (byPicker.get(p.picked_by ?? "unknown") ?? 0) + 1);
  const tally = [...byPicker.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <main className="max-w-5xl mx-auto px-6 py-8 space-y-5 w-full">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Staff Picks</h1>
          <p className="text-sm text-muted">
            {picks.length} design{picks.length === 1 ? "" : "s"} currently tagged{" "}
            <code className="text-xs">Staff-Pick</code> · who picked each.
          </p>
        </div>
        <a href="/" className="text-xs text-muted hover:text-foreground hover:underline">
          ← Back to Tag Review
        </a>
      </header>

      {error && (
        <p className="text-sm text-[#A32D2D] bg-[#FBEAEA] border border-[#F0C9C9] rounded-md px-3 py-2">
          Failed to load: {error}
        </p>
      )}

      {tally.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tally.map(([who, n]) => (
            <span key={who} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border bg-zinc-50">
              <span className="font-mono">{who}</span>
              <span className="text-muted-2">·</span>
              <span className="font-medium">{n}</span>
            </span>
          ))}
        </div>
      )}

      {picks.length === 0 && !error ? (
        <p className="text-sm text-muted italic">No staff picks yet. Star a design on the Updated tile to add one.</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs text-muted border-b border-border">
              <th className="py-2 font-medium">Design</th>
              <th className="py-2 font-medium">Manufacturer</th>
              <th className="py-2 font-medium">Picked by</th>
              <th className="py-2 font-medium">Picked</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {picks.map((p) => (
              <tr key={p.design_family} className="border-b border-border/60 hover:bg-zinc-50">
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2.5">
                    {p.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image_url} alt="" width={32} height={42} className="rounded object-cover bg-zinc-100 shrink-0" />
                    ) : (
                      <div className="w-8 h-[42px] rounded bg-zinc-100 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate">{p.design_name || p.design_family}</div>
                      <div className="text-[11px] text-muted-2 font-mono">{p.design_family}</div>
                    </div>
                  </div>
                </td>
                <td className="py-2 pr-3 text-muted">{p.manufacturer ?? "—"}</td>
                <td className="py-2 pr-3 font-mono text-[13px]">{p.picked_by ?? "—"}</td>
                <td className="py-2 pr-3 text-muted whitespace-nowrap">{fmtDate(p.picked_at)}</td>
                <td className="py-2 text-muted">{p.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
