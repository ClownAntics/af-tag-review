"use client";

/**
 * Review filter bar. Sits above the status tiles. Filters cascade:
 *   Theme → Sub-theme → Sub-sub-theme
 * Tag / Type / Manufacturer are independent dimensions.
 *
 * Changing any filter triggers a full refresh of both counts and the active
 * tile's queue (via the externalDataVersion bump in the parent).
 *
 * The dropdowns are search-as-you-type comboboxes — native <select> doesn't
 * scale to 500+ canonical taxonomy tags. Substring match is case-insensitive
 * and multi-word (each whitespace-separated term must appear).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_REVIEW_FILTERS,
  type FilterOptions,
  type ReviewFilters,
} from "@/lib/types";

interface Props {
  filters: ReviewFilters;
  onChange: (next: ReviewFilters) => void;
}

export function FilterBar({ filters, onChange }: Props) {
  const [options, setOptions] = useState<FilterOptions | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/review/filter-options")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((d: FilterOptions) => {
        if (!cancelled) setOptions(d);
      })
      .catch(() => {
        // Non-fatal; dropdowns stay empty with just "All …" entries.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty =
    filters.themeName !== "all" ||
    filters.subTheme !== "all" ||
    filters.subSubTheme !== "all" ||
    filters.tag !== "all" ||
    filters.productType !== "all" ||
    filters.manufacturer !== "all";

  // Cascade: sub-theme dropdown is filtered by active theme; sub-sub by sub/theme.
  // The API sorts by full hierarchical string ("Birds: Cardinals"), but the
  // dropdown shows only the trailing segment, so we re-sort here by the
  // visible label to keep the alphabetical order users see consistent across
  // parent groups (otherwise "Beach, Lighthouses, Bluebirds, Cardinals" looks
  // scrambled when no theme is selected).
  const subThemes = options?.subThemes || [];
  const subSubs = options?.subSubThemes || [];
  const subLabel = (s: string) => s.replace(/^[^:]+:\s*/, "");
  const subSubLabel = (s: string) => s.split(": ").slice(-1)[0];
  const filteredSubs = (
    filters.themeName === "all"
      ? subThemes
      : subThemes.filter((s) => s.startsWith(`${filters.themeName}: `))
  )
    .slice()
    .sort((a, b) => subLabel(a).localeCompare(subLabel(b)));
  const filteredSubSubs = (
    filters.subTheme !== "all"
      ? subSubs.filter((s) => s.startsWith(`${filters.subTheme}: `))
      : filters.themeName !== "all"
        ? subSubs.filter((s) => s.startsWith(`${filters.themeName}: `))
        : subSubs
  )
    .slice()
    .sort((a, b) => subSubLabel(a).localeCompare(subSubLabel(b)));

  const update = (next: Partial<ReviewFilters>) =>
    onChange({ ...filters, ...next });

  return (
    <div className="flex flex-wrap gap-2 items-center text-xs text-muted">
      <Combobox
        label="Manufacturer"
        value={filters.manufacturer}
        onChange={(v) => update({ manufacturer: v })}
        options={[
          { value: "all", label: "All manufacturers" },
          ...(options?.manufacturers || []).map((m) => ({ value: m, label: m })),
        ]}
      />
      <Combobox
        label="Theme"
        value={filters.themeName}
        onChange={(v) =>
          update({ themeName: v, subTheme: "all", subSubTheme: "all" })
        }
        options={[
          { value: "all", label: "All themes" },
          ...(options?.themeNames || []).map((t) => ({ value: t, label: t })),
        ]}
      />
      <Combobox
        label="Sub"
        value={filters.subTheme}
        onChange={(v) => update({ subTheme: v, subSubTheme: "all" })}
        options={[
          { value: "all", label: "All sub-themes" },
          ...filteredSubs.map((t) => ({
            value: t,
            label: subLabel(t),
          })),
        ]}
      />
      <Combobox
        label="Sub-sub"
        value={filters.subSubTheme}
        onChange={(v) => update({ subSubTheme: v })}
        options={[
          { value: "all", label: "All sub-sub-themes" },
          ...filteredSubSubs.map((t) => ({
            value: t,
            label: subSubLabel(t),
          })),
        ]}
      />
      <Combobox
        label="Tag"
        value={filters.tag}
        onChange={(v) => update({ tag: v })}
        options={[
          { value: "all", label: "All tags" },
          ...(options?.tags || []).map((t) => ({ value: t, label: t })),
        ]}
      />
      <Combobox
        label="Type"
        value={filters.productType}
        onChange={(v) => update({ productType: v })}
        options={[
          { value: "all", label: "All types" },
          ...(options?.productTypes || []).map((p) => ({ value: p, label: p })),
        ]}
      />
      {dirty && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_REVIEW_FILTERS)}
          className="text-xs text-muted hover:text-foreground px-2 underline decoration-dotted underline-offset-2"
        >
          Clear
        </button>
      )}
    </div>
  );
}

interface ComboOption {
  value: string;
  label: string;
}

/**
 * Search-as-you-type filter dropdown. Native <select> falls over at
 * 500+ tags (the Tag dropdown's case post-canonicalize) and even at
 * 30+ the type-to-jump only matches the first character. Click the
 * trigger → popover with an input you can type into + filtered list.
 * Substring match, case-insensitive, multi-word (each whitespace-
 * separated term must appear in the label).
 */
function Combobox({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected =
    options.find((o) => o.value === value) ?? { value: "all", label: "" };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    const terms = q.split(/\s+/).filter(Boolean);
    return options.filter((o) => {
      const hay = o.label.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [options, query]);

  // Close on outside click + ESC. Reset query when reopening.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    // Focus the input on open so typing immediately filters.
    setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Clamp the keyboard cursor when the filter changes.
  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [filtered.length, activeIndex]);

  // Scroll the active row into view as the user arrow-keys through.
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const select = (opt: ComboOption) => {
    onChange(opt.value);
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  };

  return (
    <div ref={wrapRef} className="relative flex items-center gap-1.5">
      <span>{label}:</span>
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setQuery("");
          setActiveIndex(0);
        }}
        className={`bg-card border rounded px-2 py-1 text-xs text-foreground hover:border-foreground/40 focus:outline-none focus:border-foreground max-w-[200px] truncate text-left ${
          value !== "all"
            ? "border-foreground/60 font-medium"
            : "border-border"
        }`}
        title={selected.label}
      >
        {selected.label || "—"}{" "}
        <span className="text-muted-2">▾</span>
      </button>

      {open && (
        <div className="absolute z-20 top-full left-[calc(var(--label-width,0px)+0.375rem)] mt-1 w-64 bg-white border border-border rounded-md shadow-lg overflow-hidden">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const opt = filtered[activeIndex];
                if (opt) select(opt);
              }
            }}
            placeholder={`Filter ${label.toLowerCase()}… (${options.length - 1} options)`}
            className="w-full px-3 py-2 text-xs border-b border-border focus:outline-none focus:bg-zinc-50"
            autoComplete="off"
            spellCheck={false}
          />
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted italic">
              No matches.
            </div>
          ) : (
            <ul
              ref={listRef}
              className="max-h-72 overflow-y-auto py-1"
            >
              {filtered.map((o, i) => {
                const isSelected = o.value === value;
                const isActive = i === activeIndex;
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        select(o);
                      }}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between gap-2 ${
                        isActive ? "bg-zinc-100" : "hover:bg-zinc-50"
                      } ${isSelected ? "font-medium" : ""}`}
                    >
                      <span className="truncate">{o.label}</span>
                      {isSelected && (
                        <span className="text-[#0F6E56] shrink-0">✓</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
