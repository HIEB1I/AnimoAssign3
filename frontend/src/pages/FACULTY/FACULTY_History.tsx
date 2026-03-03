// frontend/src/pages/FACULTY/FACULTY_History.tsx
// Teaching History (Faculty)
// Goal: Match Deloadings UI exactly (same container + controls) and filter by Academic Year + Term.
// Notes:
// - No Term chips/tabs (including Term 3). Term is chosen via the same AY•Term dropdown as Deloadings.
// - Per-course chip shows how many sections were taught for the selected AY+Term.

import React, { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { API_BASE } from "../../api";

const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

type Row = {
  ay: string; // e.g. "AY 2025-2026"
  term: string; // e.g. "Term 1"
  code: string;
  title: string;
  section: string;
  units: number | null;
  campus: string | null;
  mode: string | null;
  day1: string | null;
  room1: string | null;
  day2: string | null;
  room2: string | null;
  time: string;
};

type OptionsPayload = { ok?: boolean; ays?: string[] };

type FetchPayload = { ok?: boolean; rows?: Row[] };

function getUserId(): string | null {
  try {
    const u = JSON.parse(localStorage.getItem("animo.user") || "null");
    return u?.userId || u?.user_id || null;
  } catch {
    return null;
  }
}

function parseAy(ay: string): { start: number; end: number } | null {
  const s = (ay || "").replace(/^AY\s*/i, "").trim();
  const years = s.match(/\d{4}/g) || [];
  const start = years[0] ? Number(years[0]) : NaN;
  const end = years[1] ? Number(years[1]) : Number.isFinite(start) ? start + 1 : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

function formatAy(ay: string): string {
  const p = parseAy(ay);
  if (!p) return (ay || "AY —").trim();
  return `AY ${p.start}–${p.end}`;
}

function courseKey(code: string, title: string) {
  return `${(code || "").trim()}||${(title || "").trim()}`.toUpperCase();
}

// ---------- shared Dropdown (intentionally identical to Deloadings) ----------
function Dropdown({
  value,
  onChange,
  options,
  className = "w-full",
  placeholder = "— Select an option —",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [hover, setHover] = React.useState(() => Math.max(0, options.findIndex((o) => o === value)));
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => setHover(Math.max(0, options.findIndex((o) => o === value))), [value, options]);

  React.useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !btnRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!open && ["ArrowDown", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHover((i) => (i + 1) % options.length);
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHover((i) => (i - 1 + options.length) % options.length);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onChange(options[hover] ?? options[0]);
      setOpen(false);
      btnRef.current?.focus();
    }
  };

  return (
    <div className={cls("relative", className)} onKeyDown={onKey}>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cls(
          "w-full min-w-0 rounded-xl border border-gray-200 bg-white py-2.5 pl-3 pr-10 text-left text-sm outline-none",
          "hover:bg-gray-50 focus:ring-2 focus:ring-emerald-500/30"
        )}
      >
        <span className="block min-w-0 truncate">{value || <span className="text-gray-400">{placeholder}</span>}</span>
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">▾</span>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-20 mt-2 max-h-80 w-full overflow-auto rounded-2xl border border-gray-300 bg-white shadow-lg"
        >
          {options.map((opt, i) => (
            <button
              key={opt}
              role="option"
              aria-selected={value === opt}
              onMouseEnter={() => setHover(i)}
              onClick={() => {
                onChange(opt);
                setOpen(false);
                btnRef.current?.focus();
              }}
              className={cls("block w-full px-4 py-3 text-left text-sm", i === hover && "bg-emerald-50")}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type Period = { ay: string; term: "Term 1" | "Term 2"; label: string };

export default function FACULTY_History({ embedded = false }: { embedded?: boolean } = {}) {
  const userId = useMemo(() => getUserId(), []);

  const [rows, setRows] = useState<Row[]>([]);
  const [ayOptions, setAyOptions] = useState<string[]>([]);
  const [period, setPeriod] = useState<string>("");
  const [query, setQuery] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Fetch rows + AY options (same call style as before; single source of truth = backend rows)
  useEffect(() => {
    if (!userId) return;

    const run = async () => {
      setLoading(true);
      setError("");
      try {
        const [optRes, rowsRes] = await Promise.all([
          fetch(`${API_BASE}/faculty/history?userId=${encodeURIComponent(userId)}&action=options`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
          fetch(`${API_BASE}/faculty/history?userId=${encodeURIComponent(userId)}&action=fetch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
        ]);

        const optJson = (await optRes.json()) as OptionsPayload;
        const rowJson = (await rowsRes.json()) as FetchPayload;

        const dataRows = Array.isArray(rowJson?.rows) ? rowJson.rows : [];
        setRows(dataRows);

        // Prefer backend-provided AY list, fallback to derived from rows
        const opts = Array.isArray(optJson?.ays) ? optJson.ays : [];
        const derived = Array.from(new Set(dataRows.map((r) => r.ay).filter(Boolean)));

        const finalAys = (opts.length ? opts : derived)
          .slice()
          .sort((a, b) => {
            const aa = parseAy(a)?.start ?? -1;
            const bb = parseAy(b)?.start ?? -1;
            return bb - aa;
          });

        setAyOptions(finalAys);
      } catch (e: any) {
        setError(e?.message || "Failed to load teaching history");
        setRows([]);
        setAyOptions([]);
      } finally {
        setLoading(false);
      }
    };

    run();
  }, [userId]);

  // Build AY•Term options (Term 1–2 only; no Term 3)
  const periods = useMemo<Period[]>(() => {
    const out: Period[] = [];
    const has = (ay: string, term: "Term 1" | "Term 2") => rows.some((r) => r.ay === ay && r.term === term);

    // newest AY first; within AY: Term 2 then Term 1 (latest first)
    const orderedAys = [...ayOptions];
    orderedAys.forEach((ay) => {
      ([("Term 2" as const), ("Term 1" as const)]).forEach((t) => {
        if (!rows.length) {
          // If rows are empty, still provide a navigable list (keeps UI consistent)
          out.push({ ay, term: t, label: `${formatAy(ay)} • ${t}` });
        } else if (has(ay, t)) {
          out.push({ ay, term: t, label: `${formatAy(ay)} • ${t}` });
        }
      });
    });

    // If backend returned no AYs but we do have rows, derive periods from rows directly
    if (!out.length && rows.length) {
      const uniq = new Map<string, Period>();
      rows.forEach((r) => {
        const t = (r.term || "") as any;
        if (t !== "Term 1" && t !== "Term 2") return;
        const k = `${r.ay}__${t}`;
        if (!uniq.has(k)) uniq.set(k, { ay: r.ay, term: t, label: `${formatAy(r.ay)} • ${t}` });
      });
      return Array.from(uniq.values()).sort((a, b) => {
        const ayA = parseAy(a.ay)?.start ?? -1;
        const ayB = parseAy(b.ay)?.start ?? -1;
        if (ayA !== ayB) return ayB - ayA;
        // term 2 first
        return (b.term === "Term 2" ? 2 : 1) - (a.term === "Term 2" ? 2 : 1);
      });
    }

    return out;
  }, [rows, ayOptions]);

  const periodMap = useMemo(() => {
    const m = new Map<string, Period>();
    periods.forEach((p) => m.set(p.label, p));
    return m;
  }, [periods]);

  // Default selection: newest available period
  useEffect(() => {
    if (!periods.length) return;
    if (period && periodMap.has(period)) return;
    setPeriod(periods[0].label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods]);

  const current = periodMap.get(period);

  const termIndex = useMemo(() => periods.findIndex((p) => p.label === period), [periods, period]);
  const atFirst = termIndex <= 0 || periods.length === 0;
  const atLast = termIndex === periods.length - 1 || periods.length === 0;

  const goPrev = () => {
    if (atFirst) return;
    const next = periods[Math.max(0, termIndex - 1)];
    if (next) setPeriod(next.label);
  };

  const goNext = () => {
    if (atLast) return;
    const next = periods[Math.min(periods.length - 1, termIndex + 1)];
    if (next) setPeriod(next.label);
  };

  // Per-course groups for selected AY+Term
  const courseGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const ay = current?.ay;
    const term = current?.term;

    const filtered = rows.filter((r) => {
      if (ay && r.ay !== ay) return false;
      if (term && r.term !== term) return false;
      if (!q) return true;
      const hay = `${r.code} ${r.title} ${r.section} ${r.campus || ""} ${r.mode || ""} ${r.time || ""}`.toLowerCase();
      return hay.includes(q);
    });

    // Count distinct sections per course for this AY+Term
    const map = new Map<string, { code: string; title: string; sections: Set<string> }>();
    filtered.forEach((r) => {
      const key = courseKey(r.code, r.title);
      const cur = map.get(key) || { code: r.code, title: r.title, sections: new Set<string>() };
      cur.sections.add(String(r.section || ""));
      map.set(key, cur);
    });

    return Array.from(map.values())
      .map((x) => ({ code: x.code, title: x.title, count: x.sections.size }))
      .sort((a, b) => (a.code || "").localeCompare(b.code || "") || (a.title || "").localeCompare(b.title || ""));
  }, [rows, current?.ay, current?.term, query]);

  const mostTaughtInAy = useMemo(() => {
    const ay = current?.ay;
    if (!ay) return null;
    const byAy = rows.filter((r) => r.ay === ay);
    const map = new Map<string, { code: string; title: string; sections: Set<string> }>();
    byAy.forEach((r) => {
      const key = courseKey(r.code, r.title);
      const cur = map.get(key) || { code: r.code, title: r.title, sections: new Set<string>() };
      cur.sections.add(String(r.section || ""));
      map.set(key, cur);
    });
    const best = Array.from(map.values())
      .map((x) => ({ code: x.code, title: x.title, totalCount: x.sections.size }))
      .sort((a, b) => b.totalCount - a.totalCount)[0];
    return best || null;
  }, [rows, current?.ay]);

  return (
    <div className={cls("w-full", embedded ? "" : "px-8 py-8")}>
      {!embedded && (
        <>
          <h1 className="text-2xl font-bold mb-1">Teaching History</h1>
          <p className="text-sm text-gray-600 mb-6">View your teaching history by academic year and term.</p>
        </>
      )}

      <div className="rounded-xl border border-gray-200 bg-white">
        {/* Top controls (COPY of Deloadings layout) */}
        <div className={cls("flex flex-wrap items-center gap-2 border-b border-gray-200", embedded ? "p-3" : "p-4")}>
          {/* Search */}
          <div className="flex-1 min-w-[260px]">
            <div
              className={cls(
                "relative flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 text-sm",
                embedded ? "py-2" : "py-2.5"
              )}
            >
              <Search className="h-4 w-4 text-gray-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by course code…"
                className="w-full bg-transparent outline-none placeholder:text-gray-400 pr-6"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="absolute right-2 inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-400 hover:text-gray-600"
                  title="Clear"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          {/* AY+Term nav */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={goPrev}
              disabled={atFirst}
              className={cls(
                "whitespace-nowrap rounded-lg border px-3 py-2 text-sm font-semibold",
                atFirst
                  ? "cursor-default border-gray-200 bg-gray-100 text-gray-500"
                  : "cursor-pointer border-[#007a55] bg-[#007a55] text-white hover:bg-[#006a4a]"
              )}
              title="Previous term"
            >
              ‹ Prev AY
            </button>

            <div className="w-[260px] min-w-[200px]">
              <Dropdown
                value={period}
                onChange={(label) => setPeriod(label)}
                options={periods.map((p) => p.label)}
                placeholder="Select academic year"
                className="w-full"
              />
            </div>

            <button
              type="button"
              onClick={goNext}
              disabled={atLast}
              className={cls(
                "whitespace-nowrap rounded-lg border px-3 py-2 text-sm font-semibold",
                atLast
                  ? "cursor-default border-gray-200 bg-gray-100 text-gray-500"
                  : "cursor-pointer border-[#007a55] bg-[#007a55] text-white hover:bg-[#006a4a]"
              )}
              title="Next term"
            >
              Next AY ›
            </button>
          </div>
        </div>

        {error && <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>}
        {loading && <div className="px-4 py-4 text-sm text-gray-500">Loading…</div>}

        {!loading && !error && (
          <div className={cls(embedded ? "p-3" : "p-4")}>
            {/* Highlighted callout for most-taught course (box) */}
            {mostTaughtInAy && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
                    Most taught course
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-semibold text-emerald-950">{mostTaughtInAy.code || "—"}</span>
                    <span className="min-w-0 truncate text-sm text-emerald-900">{mostTaughtInAy.title || "—"}</span>
                  </div>
                </div>

                <span className="shrink-0 inline-flex items-center rounded-full border border-emerald-300 bg-white px-2.5 py-0.5 text-[11px] font-semibold text-emerald-900">
                  {mostTaughtInAy.totalCount} {mostTaughtInAy.totalCount === 1 ? "section" : "sections"}
                </span>
              </div>
            )}

            {/* Course table (same structure vibe as Deloadings) */}
            <div className={cls("overflow-hidden rounded-xl border border-gray-200", mostTaughtInAy ? "mt-3" : "mt-0")}>
              <table className="min-w-full table-fixed text-sm">
                <colgroup>
                  <col style={{ width: "78%" }} />
                  <col style={{ width: "22%" }} />
                </colgroup>
                <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                  <tr>
                    {["Course Code & Title", "Taught"].map((h) => (
                      <th key={h} className={cls("px-3 py-2 font-medium", h === "Taught" ? "text-center" : "text-left")}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {courseGroups.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="px-4 py-6 text-center text-sm text-gray-500">
                        {query.trim() ? "No matching courses for this term." : "No records for this term."}
                      </td>
                    </tr>
                  ) : (
                    courseGroups.map((c, i) => (
                      <tr key={courseKey(c.code, c.title)} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                        <td className="px-3 py-2">
                          <div className="min-w-0">
                            <div className="font-semibold text-gray-900">{c.code || "—"}</div>
                            <div className="text-xs text-gray-500 line-clamp-1">{c.title || "—"}</div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-800">
                            {c.count} {c.count === 1 ? "section" : "sections"}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
