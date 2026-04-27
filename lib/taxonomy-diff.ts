/**
 * Pure diff helper for the TeamDesk taxonomy refresh.
 *
 * Given the incoming TeamDesk rows and the current local rows (same shape),
 * classify each row into added / removed / renamed / unchanged. Callers use
 * this summary to drive the confirmation dialog and the apply step.
 *
 * The diff is keyed on the TeamDesk row id — stable across renames — so a
 * Label edit shows up as "renamed" rather than delete+add. This lets the
 * apply step auto-migrate tagged designs instead of flagging them.
 */

export interface TaxonomyRowDiffInput {
  /**
   * Stable identifier used to join rows across sides. When both sides have
   * real TeamDesk `@row.id` values, use those (stringified) so renames show
   * up as renames. When one side lacks them (pre-Supabase-migration state),
   * fall back to using `label` as the id — renames will then surface as
   * remove+add, which is an acceptable lossy mode.
   */
  id: string;
  label: string;
}

export interface TaxonomyAddition {
  id: string;
  label: string;
}

export interface TaxonomyRemoval {
  id: string;
  label: string;
}

export interface TaxonomyRename {
  id: string;
  from_label: string;
  to_label: string;
}

export interface TaxonomyDiff {
  /** Rows present on TeamDesk but not locally. Safe — no design impact. */
  added: TaxonomyAddition[];
  /** Rows present locally but gone from TeamDesk. Deletion — designs get flagged. */
  removed: TaxonomyRemoval[];
  /** Same id, different label. Auto-migrate. */
  renamed: TaxonomyRename[];
  /** Rows unchanged. Included for count accuracy, not sent over the wire. */
  unchanged_count: number;
  /** True if applying the diff cannot affect any existing design. */
  safe_to_apply_silently: boolean;
}

export function diffTaxonomies(
  local: TaxonomyRowDiffInput[],
  incoming: TaxonomyRowDiffInput[],
): TaxonomyDiff {
  const localById = new Map<string, TaxonomyRowDiffInput>();
  for (const r of local) localById.set(r.id, r);
  const incomingById = new Map<string, TaxonomyRowDiffInput>();
  for (const r of incoming) incomingById.set(r.id, r);

  const added: TaxonomyAddition[] = [];
  const removed: TaxonomyRemoval[] = [];
  const renamed: TaxonomyRename[] = [];
  let unchangedCount = 0;

  for (const row of incoming) {
    const localRow = localById.get(row.id);
    if (!localRow) {
      added.push({ id: row.id, label: row.label });
      continue;
    }
    if (localRow.label !== row.label) {
      renamed.push({ id: row.id, from_label: localRow.label, to_label: row.label });
      continue;
    }
    unchangedCount++;
  }
  for (const row of local) {
    if (!incomingById.has(row.id)) {
      removed.push({ id: row.id, label: row.label });
    }
  }

  // Silent apply is only safe when nothing existing-on-a-design is changing.
  // Renames update tag strings on designs (auto-migrate); deletions require a
  // reviewer look. Both should force the confirmation dialog.
  const safe_to_apply_silently = renamed.length === 0 && removed.length === 0;

  return { added, removed, renamed, unchanged_count: unchangedCount, safe_to_apply_silently };
}

/**
 * Summarize a diff into a one-line human string for logging / toast copy:
 *   "3 added, 2 renamed, 1 removed"
 */
export function summarizeDiff(d: TaxonomyDiff): string {
  const parts = [
    `${d.added.length} added`,
    `${d.renamed.length} renamed`,
    `${d.removed.length} removed`,
  ];
  return parts.join(", ");
}
