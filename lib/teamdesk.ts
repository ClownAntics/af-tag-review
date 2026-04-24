/**
 * TeamDesk client — FL Themes taxonomy source of truth.
 *
 * Blake edits the taxonomy in TeamDesk (https://www.teamdesk.net). This module
 * fetches the current FL Themes table for the Settings → Refresh flow.
 *
 * **Status: STUB**. Auth is deferred. Blake will generate a read-only API
 * token; until then `isConfigured()` returns false and `listFlThemes()`
 * throws a recognizable "not configured" error the API routes translate
 * into a friendly 503.
 *
 * Required env vars (set on Vercel once the token exists):
 *   TEAMDESK_API_TOKEN     — read-only token for the FL Themes table
 *   TEAMDESK_DB_ID         — the TeamDesk database numeric id
 *   TEAMDESK_TABLE_ID      — FL Themes table id within that database
 *   TEAMDESK_VIEW_URL      — browser-friendly URL for the "Open TeamDesk
 *                             table ↗" button and the Source link
 */

export interface TeamDeskRow {
  /** TeamDesk unique id (stable across renames). */
  id: number;
  /** Canonical display string — "Name: Sub: SubSub" or "Name". */
  label: string;
  /** Leaf concept (Search Term). */
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
  /** Ids of taxonomy rows that mutually exclude this one. */
  conflicts_with: number[];
  /** Parent row id (hierarchy). Level-1 rows have null. */
  parent_ref: number | null;
  /** Parent row's resolved label, for UX convenience. */
  parent_label: string | null;
}

export class TeamDeskNotConfiguredError extends Error {
  constructor() {
    super(
      "TeamDesk API not configured — set TEAMDESK_API_TOKEN, TEAMDESK_DB_ID, TEAMDESK_TABLE_ID, and TEAMDESK_VIEW_URL on the server.",
    );
    this.name = "TeamDeskNotConfiguredError";
  }
}

/** True iff the minimum env is present to call TeamDesk. */
export function isConfigured(): boolean {
  return Boolean(
    process.env.TEAMDESK_API_TOKEN &&
      process.env.TEAMDESK_DB_ID &&
      process.env.TEAMDESK_TABLE_ID,
  );
}

/** The browser-facing URL used for the "Source" link and "Open ↗" button. */
export function viewUrl(): string | null {
  return process.env.TEAMDESK_VIEW_URL || null;
}

/**
 * Pull every FL Themes row from TeamDesk. Returns a plain array shape the
 * diff helper can operate on without knowing about TeamDesk specifics.
 *
 * Not yet wired to the real API — implementation will follow once auth is
 * available. The endpoint path will look roughly like:
 *   GET https://www.teamdesk.net/secure/api/v2/<db_id>/<table_id>/select.json
 *     ?Authorization=<token>
 *
 * See https://www.teamdesk.net/help/2143.aspx for the exact shape.
 */
export async function listFlThemes(): Promise<TeamDeskRow[]> {
  if (!isConfigured()) {
    throw new TeamDeskNotConfiguredError();
  }
  // TODO(blake-auth): replace stub with real fetch once token is provisioned.
  // The code below documents the intended shape but is never reached today.
  //
  // const url = `https://www.teamdesk.net/secure/api/v2/${process.env.TEAMDESK_DB_ID}/${process.env.TEAMDESK_TABLE_ID}/select.json`;
  // const res = await fetch(url, {
  //   headers: { Authorization: `Bearer ${process.env.TEAMDESK_API_TOKEN}` },
  // });
  // if (!res.ok) throw new Error(`TeamDesk ${res.status}: ${await res.text()}`);
  // const rows = (await res.json()) as unknown[];
  // return rows.map(normalizeTeamDeskRow);

  throw new Error(
    "TeamDesk fetch is not implemented yet — TODO(blake-auth): wire real API call once token is provisioned.",
  );
}
