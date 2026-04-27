/**
 * TeamDesk client — FL Themes taxonomy source of truth.
 *
 * Blake edits the taxonomy in TeamDesk. This module fetches the current FL
 * Themes table for the Settings → Refresh flow and normalizes TeamDesk's
 * raw JSON into our canonical `TeamDeskRow` shape.
 *
 * Required env vars (set on Vercel and in .env.local for dev):
 *   TEAMDESK_API_TOKEN     — read-only API token (generate a dedicated one
 *                             under TeamDesk → Setup → Integration APIs)
 *   TEAMDESK_ACCOUNT       — TeamDesk subdomain, e.g. "clownantics" for
 *                             https://clownantics.teamdesk.net
 *   TEAMDESK_DB_ID         — TeamDesk database numeric id (27503 for ClownAntics)
 *   TEAMDESK_TABLE_ID      — FL Theme table identifier: either the name
 *                             ("FL Theme", URL-encoded as needed) or the
 *                             alias ("t_236519"). Prefer the alias — it's
 *                             stable across table renames.
 *   TEAMDESK_VIEW_URL      — browser-friendly URL for the "Source" link and
 *                             "Open TeamDesk table ↗" button
 *
 * URL shape:
 *   GET https://<account>.teamdesk.net/secure/api/v2/<db_id>/-/<table>/select.json
 *       ?Authorization=<token>
 *
 * Docs: https://www.teamdesk.net/help/2143.aspx
 */

export interface TeamDeskRow {
  /** TeamDesk unique row id (stable across renames — use for diffing). */
  id: number;
  /** Canonical display string — "Name: Sub: SubSub" or "Name". */
  label: string;
  /** Leaf concept (Search Term) — the actual tag token stored on designs. */
  search_term: string | null;
  notes: string | null;
  name: string;
  sub_theme: string | null;
  sub_sub_theme: string | null;
  level: 1 | 2 | 3;
  is_holiday: boolean;
  is_occasion: boolean;
  is_season: boolean;
  is_business_theme: boolean;
  is_spring: boolean;
  is_summer: boolean;
  is_fall: boolean;
  is_winter: boolean;
  is_xmas: boolean;
  /**
   * Textual conflict tokens (e.g. "All Seasons", "All Holidays") pulled
   * straight from TeamDesk. Kept as strings (not ids) because that's how the
   * local export-taxonomy.ts already encodes them and the UI reads them.
   */
  conflicts_with: string[];
  /** Parent row's FL Id (string-numeric, not @row.id). Level-1 rows → null. */
  parent_ref: string | null;
  /** Parent row's resolved label, for UX convenience. */
  parent_label: string | null;
}

export class TeamDeskNotConfiguredError extends Error {
  constructor() {
    super(
      "TeamDesk API not configured — set TEAMDESK_API_TOKEN, TEAMDESK_ACCOUNT, TEAMDESK_DB_ID, and TEAMDESK_TABLE_ID.",
    );
    this.name = "TeamDeskNotConfiguredError";
  }
}

/** True iff the minimum env is present to call TeamDesk. */
export function isConfigured(): boolean {
  return Boolean(
    process.env.TEAMDESK_API_TOKEN &&
      process.env.TEAMDESK_ACCOUNT &&
      process.env.TEAMDESK_DB_ID &&
      process.env.TEAMDESK_TABLE_ID,
  );
}

/** The browser-facing URL used for the "Source" link and "Open ↗" button. */
export function viewUrl(): string | null {
  return process.env.TEAMDESK_VIEW_URL || null;
}

/** Shape TeamDesk returns for each row in the FL Theme select. */
interface TeamDeskRawRow {
  "@row.id": number;
  /** TeamDesk's FL-specific string id — used as the parent reference key. */
  Id: string;
  Name: string;
  "Sub Theme": string | null;
  "Sub Sub Theme": string | null;
  "Search Term": string | null;
  Notes: string | null;
  "Related FL Theme (ref)": string | null;
  "IsHoliday?": boolean;
  "isOccasion?": boolean;
  "isSeason?": boolean;
  "isBusinessTheme?": boolean;
  "isSpring?": boolean;
  "isSummer?": boolean;
  "isFall?": boolean;
  "isWinter?": boolean;
  "isXmas?": boolean;
  ConflictsWith: string | null;
}

function buildLabel(
  name: string,
  sub: string | null,
  subSub: string | null,
): string {
  if (subSub && sub) return `${name}: ${sub}: ${subSub}`;
  if (sub) return `${name}: ${sub}`;
  return name;
}

function detectLevel(raw: TeamDeskRawRow): 1 | 2 | 3 {
  if (raw["Sub Sub Theme"]) return 3;
  if (raw["Sub Theme"]) return 2;
  return 1;
}

/** Parse TeamDesk's comma-separated ConflictsWith string into trimmed tokens. */
function parseConflicts(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Map raw TeamDesk rows to our normalized shape. Two passes so we can resolve
 * `parent_label` by looking up the parent's own Name/Sub/SubSub in an index.
 */
export function normalizeTeamDeskRows(rows: TeamDeskRawRow[]): TeamDeskRow[] {
  const labelByTdId = new Map<string, string>();
  for (const r of rows) {
    labelByTdId.set(r.Id, buildLabel(r.Name, r["Sub Theme"], r["Sub Sub Theme"]));
  }

  return rows.map((r) => {
    const label = buildLabel(r.Name, r["Sub Theme"], r["Sub Sub Theme"]);
    const parent_ref = r["Related FL Theme (ref)"] || null;
    const parent_label = parent_ref ? labelByTdId.get(parent_ref) ?? null : null;
    return {
      id: r["@row.id"],
      label,
      search_term: r["Search Term"],
      notes: r.Notes,
      name: r.Name,
      sub_theme: r["Sub Theme"],
      sub_sub_theme: r["Sub Sub Theme"],
      level: detectLevel(r),
      is_holiday: !!r["IsHoliday?"],
      is_occasion: !!r["isOccasion?"],
      is_season: !!r["isSeason?"],
      is_business_theme: !!r["isBusinessTheme?"],
      is_spring: !!r["isSpring?"],
      is_summer: !!r["isSummer?"],
      is_fall: !!r["isFall?"],
      is_winter: !!r["isWinter?"],
      is_xmas: !!r["isXmas?"],
      conflicts_with: parseConflicts(r.ConflictsWith),
      parent_ref,
      parent_label,
    };
  });
}

/**
 * Pull every FL Theme row from TeamDesk.
 *
 * The /-/ segment in the URL is TeamDesk's placeholder for "no view filter"
 * (i.e. return all rows, not scoped to a specific saved view). Authorization
 * goes as a query-string parameter, not a header — TeamDesk's REST API
 * supports either, but the query-param form matches the Playground and is
 * simpler to debug.
 */
export async function listFlThemes(): Promise<TeamDeskRow[]> {
  if (!isConfigured()) {
    throw new TeamDeskNotConfiguredError();
  }

  const account = process.env.TEAMDESK_ACCOUNT!;
  const dbId = process.env.TEAMDESK_DB_ID!;
  const tableId = process.env.TEAMDESK_TABLE_ID!;
  const token = process.env.TEAMDESK_API_TOKEN!;

  const url = `https://${account}.teamdesk.net/secure/api/v2/${dbId}/-/${encodeURIComponent(
    tableId,
  )}/select.json?Authorization=${encodeURIComponent(token)}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    // TeamDesk returns the full table in a single response; no pagination.
    // For ~700 rows that's a few hundred KB at most.
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `TeamDesk ${res.status} ${res.statusText}: ${body.slice(0, 400)}`,
    );
  }
  const raw = (await res.json()) as TeamDeskRawRow[];
  if (!Array.isArray(raw)) {
    throw new Error(
      `TeamDesk response was not an array — got ${typeof raw}. Response: ${JSON.stringify(raw).slice(0, 400)}`,
    );
  }
  return normalizeTeamDeskRows(raw);
}
