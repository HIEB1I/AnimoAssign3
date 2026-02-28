// frontend/src/pages/OM/OM_RP_FacultyTeachingHistory.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronDown, ChevronRight, Calendar, Search as SearchIcon } from "lucide-react";
import { fetchTeachingHistory, listFaculty } from "../../../api";
import SelectBox from "../../../component/SelectBox";

/** -----------------------------
 * Types (Updated to match FACULTY logic)
 * ----------------------------- */
type TeachingHistoryRow = {
  ay: string;
  term_name: string;
  course_code: string;
  course_title: string;
  section_code: string;
  units?: number;
  campus?: string;
  mode?: string;

  employment_type?: string;
  standard_load_units?: number;

  // Flattened Schedule
  day1?: string;
  room1?: string;
  begin1?: string;
  end1?: string;
  day2?: string;
  room2?: string;
  begin2?: string;
  end2?: string;
  time?: string;
};

type FacultyLite = { faculty_id: string; name: string };

/** -----------------------------
 * Helpers
 * ----------------------------- */
function groupByTermAndAy(rows: TeachingHistoryRow[]) {
  const groups: Record<string, TeachingHistoryRow[]> = {};
  for (const r of rows) {
    const key = `${r.ay} • ${r.term_name}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }
  return groups;
}

/** Sort helpers for "LAST, FIRST" */
function splitLastFirst(name: string): { last: string; first: string } {
  const raw = String(name || "").trim();
  if (!raw) return { last: "", first: "" };
  if (raw.includes(",")) {
    const [last, rest] = raw.split(",", 2);
    return { last: (last || "").trim(), first: (rest || "").trim() };
  }
  const parts = raw.split(/\s+/);
  const last = parts[parts.length - 1] || "";
  const first = parts.slice(0, -1).join(" ");
  return { last, first };
}

function compareLastFirst(a: string, b: string) {
  const A = splitLastFirst(a.toUpperCase());
  const B = splitLastFirst(b.toUpperCase());
  const byLast = A.last.localeCompare(B.last);
  return byLast !== 0 ? byLast : A.first.localeCompare(B.first);
}

function formatLastCommaFirst(name: string) {
  const { last, first } = splitLastFirst(name);
  if (!last && !first) return name || "";
  return first ? `${last}, ${first}` : last;
}

function norm(s: string) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[.,']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchKeys(name: string) {
  const { last, first } = splitLastFirst(name);
  const all = [
    norm(name),
    norm(`${last}, ${first}`),
    norm(`${first} ${last}`),
    norm(last),
    norm(first),
  ].filter(Boolean);
  return Array.from(new Set(all)).join(" | ");
}

function dayInitial(day?: string | null): string {
  const raw = String(day || "").trim();
  if (!raw) return "—";
  if (raw.length === 1) return raw.toUpperCase();

  const d = raw.toLowerCase();
  // In AnimoAssign, Thursday is commonly shown as "H".
  if (d.startsWith("th")) return "H";
  if (d.startsWith("tu")) return "T";
  if (d.startsWith("t")) return "T";
  if (d.startsWith("m")) return "M";
  if (d.startsWith("w")) return "W";
  if (d.startsWith("f")) return "F";
  if (d.startsWith("sa")) return "S";
  if (d.startsWith("su")) return "U";
  if (d.startsWith("s")) return "S";
  return raw[0]!.toUpperCase();
}

/** -----------------------------
 * Schedule helpers for Teaching History table
 * ----------------------------- */
function fmtTimeToken(t: string): string {
  const raw = String(t || "").trim();
  if (!raw) return "";
  const m1 = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (m1) return `${m1[1].padStart(2, "0")}:${m1[2]}`;
  const m2 = raw.match(/^\d{3,4}$/);
  if (m2) {
    const s = raw.padStart(4, "0");
    return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
  }
  return raw;
}

function parseBeginEnd(part: string): { begin?: string; end?: string } {
  const s = String(part || "").trim();
  if (!s) return {};
  const cleaned = s.replace(/[–—]/g, "-").replace(/\s+to\s+/gi, "-");
  const pieces = cleaned
    .split("-")
    .map((x) => x.trim())
    .filter(Boolean);
  if (pieces.length >= 2) {
    return {
      begin: fmtTimeToken(pieces[0] ?? ""),
      end: fmtTimeToken(pieces[pieces.length - 1] ?? ""),
    };
  }

  const tokens = cleaned.match(/(\d{1,2}:\d{2}|\d{3,4})\s*(?:AM|PM)?/gi) || [];
  if (tokens.length >= 2) {
    return {
      begin: fmtTimeToken(tokens[0] ?? ""),
      end: fmtTimeToken(tokens[1] ?? ""),
    };
  }
  return { begin: fmtTimeToken(cleaned) };
}

function splitTimeForDays(
  time?: string | null,
  hasSecondDay?: boolean
): {
  begin1?: string;
  end1?: string;
  begin2?: string;
  end2?: string;
} {
  const raw = String(time || "").trim();
  if (!raw) return {};
  const chunks = raw
    .split(/[|/;]/)
    .map((c) => c.trim())
    .filter(Boolean);

  const first = parseBeginEnd(chunks[0] || "");
  const second = chunks[1]
    ? parseBeginEnd(chunks[1])
    : hasSecondDay
    ? first
    : {};

  return {
    begin1: first.begin,
    end1: first.end,
    begin2: second.begin,
    end2: second.end,
  };
}

/** -----------------------------
 * Page Component
 * ----------------------------- */
export default function OM_RP_FacultyTeachingHistory() {
  return (
    <div className="w-full px-8 py-8">
      <h1 className="text-2xl font-bold mb-2">Teaching History per Faculty</h1>
      <p className="text-sm text-gray-600 mb-6">
        Shows a descriptive summary of a faculty member's past teaching loads (courses/sections taught). 
      </p>
      <FacultyAccordion />
    </div>
  );
}

/** -----------------------------
 * Accordion List
 * ----------------------------- */
/** -----------------------------
 * Campus inference (Teaching History)
 * Primary campus is computed across ALL teaching history rows based on section codes:
 * - Manila: sections starting with S / G
 * - Laguna: sections starting with XX / XC
 * The "primary" is whichever appears most; tie (and both >0) => Both.
 * ----------------------------- */
type PrimaryCampus = "Manila" | "Laguna" | "Both" | "N/A";

function computePrimaryCourseFromRows(rows: TeachingHistoryRow[]): { code: string; title: string } {
  const counts: Record<string, { times: number; title: string; firstIdx: number }> = {};
  (rows || []).forEach((r, idx) => {
    const code = String(r.course_code || "").trim();
    if (!code) return;
    const title = String(r.course_title || "").trim();
    if (!counts[code]) counts[code] = { times: 0, title, firstIdx: idx };
    counts[code].times += 1;
    if (!counts[code].title && title) counts[code].title = title;
  });

  const best = Object.entries(counts)
    .sort((a, b) => {
      const A = a[1];
      const B = b[1];
      if (B.times !== A.times) return B.times - A.times;
      return A.firstIdx - B.firstIdx;
    })
    .map(([code, meta]) => ({ code, title: meta.title }))
    .find((x) => x.code);

  return best || { code: "N/A", title: "" };
}

function inferCampusFromSection(sectionCode?: string | null): "Manila" | "Laguna" | null {
  const s = String(sectionCode || "").trim().toUpperCase();
  if (!s) return null;
  if (s.startsWith("XX") || s.startsWith("XC")) return "Laguna";
  const first = s[0];
  if (first === "S" || first === "G") return "Manila";
  return null;
}


function inferCampusFromRow(r: TeachingHistoryRow): "Manila" | "Laguna" | null {
  const c = String(r?.campus || "").trim().toLowerCase();
  if (c.includes("manila")) return "Manila";
  if (c.includes("laguna")) return "Laguna";
  // fallback: infer from section code prefixes (legacy)
  return inferCampusFromSection(r?.section_code);
}

function computePrimaryCampusFromRows(rows: TeachingHistoryRow[]): PrimaryCampus {
  let manila = 0;
  let laguna = 0;
  for (const r of rows || []) {
    const c = inferCampusFromRow(r);
    if (c === "Manila") manila += 1;
    else if (c === "Laguna") laguna += 1;
  }
  if (manila > 0 && laguna > 0) {
    if (manila > laguna) return "Manila";
    if (laguna > manila) return "Laguna";
    return "Both";
  }
  if (manila > 0) return "Manila";
  if (laguna > 0) return "Laguna";
  return "N/A";
}

/** -----------------------------
 * Accordion List
 * ----------------------------- */
function FacultyAccordion() {
  const [allFaculty, setAllFaculty] = useState<FacultyLite[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [filter, setFilter] = useState("");

  // Advanced filters (computed from teaching history, cached)
  const [primaryCourseFilter, setPrimaryCourseFilter] = useState("");

  type CampusFilterLabel = "All campuses" | "Manila" | "Laguna" | "Both";
  const campusOptions: CampusFilterLabel[] = ["All campuses", "Manila", "Laguna", "Both"];
  const [campusFilter, setCampusFilter] = useState<CampusFilterLabel>("All campuses");
  const [filterComputingCount, setFilterComputingCount] = useState(0);
  const isFilterComputing = filterComputingCount > 0;

  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [cache, setCache] = useState<Record<string, TeachingHistoryRow[]>>({});
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  // Primary campus per faculty (computed from teaching history; cached)
  const [primaryCampusByFaculty, setPrimaryCampusByFaculty] = useState<Record<string, PrimaryCampus>>({});
  const [primaryCourseByFaculty, setPrimaryCourseByFaculty] = useState<
    Record<string, { code: string; title: string }>
  >({});

  useEffect(() => {
    let cancelled = false;
    async function go() {
      setListLoading(true);
      setListError(null);
      try {
        const res = await listFaculty({});
        const uniq = new Map<string, FacultyLite>();
        (Array.isArray(res?.rows) ? res.rows : []).forEach((r: any) => {
          if (!r?.faculty_id) return;
          const name = String(r?.name || "").trim();
          if (!name) return; // avoid blank row in list
          uniq.set(r.faculty_id, { faculty_id: r.faculty_id, name });
        });
        if (!cancelled) setAllFaculty(Array.from(uniq.values()));
      } catch (err: any) {
        if (!cancelled) {
          setAllFaculty([]);
          setListError(err?.message || "Failed to load faculty list.");
        }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    }
    go();
    return () => {
      cancelled = true;
    };
  }, []);

  // When a campus filter is selected, compute primary campus for all faculty (if missing)
  useEffect(() => {
    if (campusFilter === "All campuses") return;

    let cancelled = false;

    async function computeMissing() {
      const missing = allFaculty
        .map((f) => f.faculty_id)
        .filter((id) => !(id in primaryCampusByFaculty));

      if (missing.length === 0) return;

      setFilterComputingCount((c) => c + 1);

      const updates: Record<string, PrimaryCampus> = {};
      const CONCURRENCY = 6;
      let ptr = 0;

      const workers = new Array(CONCURRENCY).fill(0).map(async () => {
        while (ptr < missing.length && !cancelled) {
          const id = missing[ptr++];
          try {
            const data = await fetchTeachingHistory(id);
            const rows = Array.isArray(data?.rows) ? (data.rows as TeachingHistoryRow[]) : [];
            updates[id] = computePrimaryCampusFromRows(rows);
          } catch {
            updates[id] = "N/A";
          }
        }
      });

      await Promise.all(workers);

      if (cancelled) return;
      setPrimaryCampusByFaculty((prev) => ({ ...prev, ...updates }));
      setFilterComputingCount((c) => Math.max(0, c - 1));
    }

    computeMissing();

    return () => {
      cancelled = true;
    };
  }, [campusFilter, allFaculty, primaryCampusByFaculty]);

  // When a primary course filter is used, compute primary course for all faculty (if missing)
  useEffect(() => {
    if (!primaryCourseFilter.trim()) return;

    let cancelled = false;

    async function computeMissing() {
      const missing = allFaculty
        .map((f) => f.faculty_id)
        .filter((id) => !(id in primaryCourseByFaculty));

      if (missing.length === 0) return;

      setFilterComputingCount((c) => c + 1);

      const updates: Record<string, { code: string; title: string }> = {};
      const CONCURRENCY = 6;
      let ptr = 0;

      const workers = new Array(CONCURRENCY).fill(0).map(async () => {
        while (ptr < missing.length && !cancelled) {
          const id = missing[ptr++];
          try {
            const data = await fetchTeachingHistory(id);
            const rows = Array.isArray(data?.rows) ? (data.rows as TeachingHistoryRow[]) : [];
            updates[id] = computePrimaryCourseFromRows(rows);
          } catch {
            updates[id] = { code: "N/A", title: "" };
          }
        }
      });

      await Promise.all(workers);

      if (cancelled) return;
      setPrimaryCourseByFaculty((prev) => ({ ...prev, ...updates }));
      setFilterComputingCount((c) => Math.max(0, c - 1));
    }

    computeMissing();

    return () => {
      cancelled = true;
    };
  }, [primaryCourseFilter, allFaculty, primaryCourseByFaculty]);

  const filteredSorted = useMemo(() => {
    const q = norm(filter);
    const tokens = q ? q.split(" ") : [];

    // search filter
    let base = tokens.length
      ? allFaculty.filter((f) => {
          const hay = searchKeys(f.name);
          return tokens.every((t) => hay.includes(t));
        })
      : allFaculty;

    // campus filter (primary campus)
    if (campusFilter !== "All campuses") {
      base = base.filter((f) => {
        const pc = primaryCampusByFaculty[f.faculty_id];
        return pc === campusFilter; // "Manila" | "Laguna" | "Both"
      });
    }

    // primary course filter (most taught course code/title)
    if (primaryCourseFilter.trim()) {
      const cq = norm(primaryCourseFilter);
      const ctokens = cq ? cq.split(" ") : [];
      base = base.filter((f) => {
        const info = primaryCourseByFaculty[f.faculty_id];
        if (!info) return false;
        const hay = norm(`${info.code} ${info.title}`);
        return ctokens.every((t) => hay.includes(t));
      });
    }

    return [...base].sort((a, b) => compareLastFirst(a.name, b.name));
  }, [allFaculty, filter, campusFilter, primaryCampusByFaculty, primaryCourseFilter, primaryCourseByFaculty]);

  useEffect(() => {
    const visibleIds = new Set(filteredSorted.map((f) => f.faculty_id));
    setOpenIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) if (visibleIds.has(id)) next.add(id);
      return next;
    });
  }, [filteredSorted]);

  const toggle = useCallback(
    async (f: FacultyLite) => {
      const id = f.faculty_id;
      const next = new Set(openIds);
      if (next.has(id)) {
        next.delete(id);
        setOpenIds(next);
        return;
      }
      next.add(id);
      setOpenIds(next); // Set open first to show loading immediately

      // If already cached, no need to re-fetch
      if (cache[id]) return;

      setErrors((m) => ({ ...m, [id]: null }));
      setLoadingIds((s) => new Set(s).add(id));
      try {
        const data = await fetchTeachingHistory(id);
        const rows = Array.isArray(data?.rows) ? (data.rows as TeachingHistoryRow[]) : [];
        setCache((c) => ({ ...c, [id]: rows }));

        // compute primary campus from section codes
        setPrimaryCampusByFaculty((prev) => {
          if (prev[id]) return prev;
          return { ...prev, [id]: computePrimaryCampusFromRows(rows) };
        });

        setPrimaryCourseByFaculty((prev) => {
          if (prev[id]) return prev;
          return { ...prev, [id]: computePrimaryCourseFromRows(rows) };
        });
      } catch (err: any) {
        setErrors((m) => ({
          ...m,
          [id]: err?.message || "Failed to load teaching history.",
        }));
      } finally {
        setLoadingIds((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      }
    },
    [openIds, cache]
  );

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-gray-200">
        <Link
          to="/om/home/reports-analytics"
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50"
        >
          <ChevronLeft className="h-4 w-4" />
          <span>Back</span>
        </Link>

        <div className="relative flex-1 min-w-[260px]">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search by faculty name…"
            className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
          {!!filter && (
            <button
              onClick={() => setFilter("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <SelectBox
          value={campusFilter}
          onChange={(v) => setCampusFilter(v as CampusFilterLabel)}
          options={campusOptions as unknown as string[]}
        />

        <div className="text-sm font-bold text-gray-900 whitespace-nowrap">
          Most Taught Course:
        </div>

        <div className="relative flex-1 min-w-[260px]">
          <input
            value={primaryCourseFilter}
            onChange={(e) => setPrimaryCourseFilter(e.target.value)}
            placeholder="Search by course code…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
          {!!primaryCourseFilter && (
            <button
              onClick={() => setPrimaryCourseFilter("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
              aria-label="Clear primary course filter"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {isFilterComputing && (campusFilter !== "All campuses" || !!primaryCourseFilter.trim()) && (
        <div className="px-4 py-2 text-xs text-gray-500 border-b border-gray-100">
          Computing filter fields from teaching history…
        </div>
      )}

      {listError && (
        <div className="px-4 py-3 text-sm text-red-700 bg-red-50">{listError}</div>
      )}
      {listLoading && (
        <div className="px-4 py-4 text-sm text-gray-500">Loading faculty…</div>
      )}

      <ul className="divide-y">
        {!listLoading && filteredSorted.length === 0 && (
          <li className="p-4 text-sm text-gray-500">No faculty found.</li>
        )}
        {filteredSorted.map((f) => {
          const id = f.faculty_id;
          const isOpen = openIds.has(id);
          const isLoading = loadingIds.has(id);
          const err = errors[id];
          const rows = cache[id] || [];

          return (
            <li key={id} className="bg-white">
              <button
                onClick={() => toggle(f)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50"
              >
                <span className="inline-flex items-center gap-2">
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <span className="font-medium text-gray-900">{formatLastCommaFirst(f.name)}</span>
                </span>
                <span className="text-xs text-gray-500">{isLoading ? "Loading…" : isOpen ? "Hide" : "Show"}</span>
              </button>

              {isOpen && (
                <div className="px-4 pb-4">
                  {err && (
                    <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                      {err}
                    </div>
                  )}
                  {isLoading && !rows.length && (
                    <div className="px-1 py-2 text-sm text-gray-500">Loading teaching history…</div>
                  )}
                  {!isLoading && rows.length === 0 && !err && (
                    <div className="px-1 py-2 text-sm text-gray-500">No records found.</div>
                  )}
                  {!isLoading && rows.length > 0 && <HistoryTables rows={rows} />}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** -----------------------------
 * UNITS HISTORY CHART COMPONENT (Minor Fix/Enhancement)
 * * Retains as a core part of the analytics view.
 * ----------------------------- */
type UnitsByTerm = { key: string; units: number };

function UnitsHistoryChart({
  data,
  avgLoad,
  standardLoad,
}: {
  data: UnitsByTerm[];
  avgLoad: number;
  standardLoad: number;
}) {
  if (!data || data.length === 0) return null;
  const MAX_STANDARD = 30; // fixed visual scale (0–30 units)

  const PAGE = 5;
  const [visibleCount, setVisibleCount] = useState(PAGE);

  // reset when faculty changes / new data loaded
  useEffect(() => {
    setVisibleCount(PAGE);
  }, [data.length]);

  const visibleData = data.slice(0, visibleCount);
  const canShowMore = visibleCount < data.length;
  const canShowLess = data.length > PAGE && visibleCount > PAGE;

  // Keep a consistent scale so markers/labels don't jump per faculty.
  // If a value exceeds 30, it will be clamped to the max width.
  const scaleFactor = 100 / MAX_STANDARD;
  const clampPct = (p: number) => Math.max(0, Math.min(100, p));

  return (
    // Replaced generic div with a styled card for visual impact
    <div className="p-5 rounded-xl border border-gray-200 bg-white shadow-lg">
      <h3 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
        Teaching Load Trend (Units per Term)
      </h3>

      {/* Legend for context - Simplified */}
      <p className="text-xs text-gray-600 mb-4 border-b pb-3">
        <span
          className="text-emerald-700 font-semibold"
          title="Standard teaching load baseline: FT=12 units, PT=6 units. Marker uses this faculty's employee type."
        >
          Standard (FT=12, PT=6)
        </span>{" "}
        |
        <span
          className="text-red-600 ml-3 font-semibold"
          title="Above Standard: greater than this faculty's standard baseline (FT=12, PT=6)"
        >
          Above Standard
        </span>{" "}
        |
        <span
          className="text-amber-600 ml-3 font-semibold"
          title="Below Standard: less than this faculty's standard baseline (FT=12, PT=6)"
        >
          Below Standard
        </span>{" "}
        |
        <span
          className="text-indigo-700 ml-3 font-semibold"
          title="This vertical line marks the historical average for this faculty."
        >
          Avg line: {avgLoad.toFixed(1)} units
        </span>
      </p>

      <div className="flex flex-col space-y-4 text-sm">
        {" "}
        {/* Increased spacing and font size */}
        {visibleData.map((d) => {
          const percentage = clampPct(d.units * scaleFactor);
          const avgLinePosition = clampPct(avgLoad * scaleFactor);
          const standardLinePosition = clampPct(standardLoad * scaleFactor);

          // Color-code strictly vs. the faculty's STANDARD baseline.
          // (Avg line remains informational; bar colors remain stable and intuitive.)
          const base = standardLoad;
          const isHigh = base > 0 && d.units > base;
          const isLow = base > 0 && d.units < base;
          const barColor = isHigh
            ? "bg-red-500"
            : isLow
            ? "bg-amber-500"
            : "bg-emerald-500";

          return (
            <div
              key={d.key}
              className="flex items-center"
              title={`${d.key}: ${d.units} units | Avg: ${avgLoad.toFixed(
                1
              )}`}
            >
              <span className="w-44 text-gray-700 font-medium whitespace-nowrap">
                {d.key}
              </span>{" "}
              {/* Wider label */}
              {/* Bar Container */}
              <div className="flex items-center w-full ml-6 relative h-6">
                {/* Horizontal Bar */}
                <div
                  className={`rounded h-full ${barColor} transition-all duration-300 pointer-events-none`}
                  style={{ width: `${percentage}%` }}
                />

                {/* Visual indicator for average load baseline */}
                {avgLoad > 0 && (
                  <div
                    className="absolute h-full w-[3px] bg-indigo-700 -translate-y-1/2 top-1/2 rounded-full pointer-events-none"
                    style={{ left: `${avgLinePosition}%` }}
                  />
                )}

                {standardLoad > 0 && (
                  <div
                    className="absolute h-full w-[3px] bg-emerald-600 -translate-y-1/2 top-1/2 rounded-full pointer-events-none"
                    style={{ left: `${standardLinePosition}%` }}
                  />
                )}

                {/* Label - Placed outside the bar for clarity if bar is small */}
                <span className="ml-3 font-extrabold text-gray-800">
                  {d.units}
                  {(isHigh || isLow) && (
                    <span
                      className={`ml-2 text-xs font-semibold ${
                        isHigh ? "text-red-500" : "text-amber-500"
                      }`}
                    >
                      ({isHigh ? "Above Std" : "Below Std"})
                    </span>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Scale (fixed at the bottom of the chart, aligned with the bars) */}
      <div className="mt-2 flex items-center">
        <span className="w-44" />
        <div className="w-full ml-6 flex justify-between text-[10px] text-gray-500">
          <span>0 units</span>
          <span>{MAX_STANDARD} units</span>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        {canShowLess && (
          <button
            className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50"
            onClick={() => setVisibleCount(PAGE)}
          >
            Show less
          </button>
        )}

        {canShowMore && (
          <button
            className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50"
            onClick={() =>
              setVisibleCount((c) => Math.min(c + PAGE, data.length))
            }
          >
            Show 5 more
          </button>
        )}
      </div>
    </div>
  );
}

/** -----------------------------
 * History Tables (REVISED for Clarity and Descriptive Analytics)
 * ----------------------------- */
/** -----------------------------
 * History Tables (revised: includes Courses Taught list + cleaner profile card)
 * ----------------------------- */
function HistoryTables({ rows }: { rows: TeachingHistoryRow[] }) {
  const grouped = useMemo(() => groupByTermAndAy(rows || []), [rows]);
  const [termIdx, setTermIdx] = useState(0); // 0 = latest (sortedKeys is already desc)

  // preserve backend sort order by first-seen keys
  const sortedKeys = useMemo(() => {
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const r of rows) {
      const k = `${r.ay} • ${r.term_name}`;
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
    return keys;
  }, [rows]);

  useEffect(() => setTermIdx(0), [rows]);

  const activeKey = sortedKeys[termIdx];
  const activeRows = activeKey ? grouped[activeKey] || [] : [];

  const globalSummary = useMemo(() => {
    const termCount = sortedKeys.length;
    const totalUnitsOverall = rows.reduce((sum, r) => sum + (r.units || 0), 0);
    const avgUnitsPerTerm = termCount > 0 ? totalUnitsOverall / termCount : 0;

    const acadYearsCovered = Array.from(new Set(rows.map((r) => r.ay))).length;

    const primaryCampus = computePrimaryCampusFromRows(rows);

    // Standard baseline is always FT=12, PT=6.
    // (Do NOT trust per-row standard_load_units; marker must be consistent.)
    const empType = (rows.find((r) => r.employment_type)?.employment_type || "").toUpperCase();
    const standardLoad = empType.includes("PT") ? 6 : 12;

    const courseCounts: Record<string, number> = {};
    rows.forEach((r) => {
      const code = (r.course_code || "").trim() || "N/A";
      courseCounts[code] = (courseCounts[code] || 0) + 1;
    });

    const mostTaughtCourseEntry =
      Object.entries(courseCounts).filter(([k]) => k !== "N/A").sort((a, b) => b[1] - a[1])[0] || null;

    const mostTaughtCourse = mostTaughtCourseEntry?.[0] || "—";
    const mostTaughtCount = mostTaughtCourseEntry?.[1] || 0;

    return {
      acadYearsCovered,
      termCount,
      avgUnitsPerTerm,
      standardLoad,
      primaryCampus,
      mostTaughtCourse,
      mostTaughtCount,
    };
  }, [rows, sortedKeys]);

  const unitsByTerm = useMemo(() => {
    return sortedKeys.map((k) => {
      const list = grouped[k] || [];
      const totalUnits = list.reduce((sum, r) => sum + (r.units || 0), 0);
      return { key: k, units: totalUnits };
    });
  }, [sortedKeys, grouped]);

  // --- Courses taught list (all courses shown; optional filter) ---
  const [courseFilter, setCourseFilter] = useState("");
  useEffect(() => setCourseFilter(""), [rows]); // reset when switching faculty

  type CourseSummary = {
    course_code: string;
    course_title: string;
    times: number;
    lastKey?: string;
    lastIdx: number;
  };

  const courses = useMemo(() => {
    const keyIndex = new Map<string, number>();
    sortedKeys.forEach((k, i) => keyIndex.set(k, i));

    const map = new Map<string, CourseSummary>();

    for (const r of rows || []) {
      const code = String(r.course_code || "").trim();
      if (!code) continue;

      const key = `${r.ay} • ${r.term_name}`;
      const idx = keyIndex.get(key) ?? 999;

      const existing = map.get(code);
      if (!existing) {
        map.set(code, {
          course_code: code,
          course_title: String(r.course_title || "").trim(),
          times: 1,
          lastKey: key,
          lastIdx: idx,
        });
      } else {
        existing.times += 1;
        if (!existing.course_title && r.course_title) existing.course_title = String(r.course_title).trim();
        if (idx < existing.lastIdx) {
          existing.lastIdx = idx;
          existing.lastKey = key;
        }
      }
    }

    let out = Array.from(map.values()).sort((a, b) => {
      if (a.lastIdx !== b.lastIdx) return a.lastIdx - b.lastIdx; // most recent first
      return a.course_code.localeCompare(b.course_code);
    });

    const q = courseFilter.trim().toLowerCase();
    if (q) {
      out = out.filter((c) => {
        const hay = `${c.course_code} ${c.course_title}`.toLowerCase();
        return hay.includes(q);
      });
    }

    return out;
  }, [rows, sortedKeys, courseFilter]);

  return (
    <div className="space-y-6 mt-2">
      {/* Profile + Courses taught (in one card like the load trend card) */}
      <div className="p-5 rounded-xl border border-gray-200 bg-white shadow-lg">
        {/* Overall Faculty Profile */}
        <div className="mb-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Overall Faculty Profile</h3>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 h-full flex flex-col justify-between">
              <div className="text-emerald-800 font-medium">Primary Campus</div>
              <div className="mt-1 text-base font-semibold text-emerald-900">{globalSummary.primaryCampus}</div>
              <div className="text-xs text-emerald-800">Across teaching history</div>
            </div>

            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 h-full flex flex-col justify-between">
              <div className="text-emerald-800 font-medium">Most Taught</div>
              <div className="mt-1 text-base font-semibold text-emerald-900 truncate">{globalSummary.mostTaughtCourse}</div>
              <div className="text-xs text-emerald-800">{mostTaughtCountLabel(globalSummary.mostTaughtCount)}</div>
            </div>
          </div>
        </div>

        {/* Courses Taught */}
        <div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-base font-semibold text-gray-900">Courses Taught</h4>
              <p className="text-xs text-gray-600">{courseFilter ? `${courses.length} match(es)` : `${courses.length} unique course(s)`}</p>
            </div>

            <div className="relative min-w-[220px]">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </span>
              <input
                value={courseFilter}
                onChange={(e) => setCourseFilter(e.target.value)}
                placeholder="Search by Course Code..."
                className="w-full rounded-lg border border-gray-300 pl-9 pr-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
              />
              {!!courseFilter && (
                <button
                  onClick={() => setCourseFilter("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
                  aria-label="Clear course filter"
                >
                  ×
                </button>
              )}
            </div>
          </div>

          <div className="mt-3 border-t border-gray-200">
            {courses.length === 0 ? (
              <div className="py-4 text-sm text-gray-500">No courses found.</div>
            ) : (
              <div className="divide-y divide-gray-200">
                {courses.map((c) => {
                  const isRecent = c.lastIdx === 0;
                  return (
                    <div key={c.course_code} className="py-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="font-semibold text-emerald-700">{c.course_code}</div>
                          {isRecent && (
                            <div className="inline-flex items-center gap-1 text-xs text-emerald-700">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                              <span>Recent</span>
                            </div>
                          )}
                        </div>
                        <div className="text-xs text-gray-600 truncate">{c.course_title || "—"}</div>
                        <div className="text-xs text-gray-500 mt-1">Last {c.lastKey || "—"}</div>
                      </div>

                      <div className="shrink-0 text-xs text-gray-600 rounded-full border border-gray-200 px-2 py-1">
                        {c.times}×
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Teaching Load Trend */}
      <UnitsHistoryChart data={unitsByTerm} avgLoad={globalSummary.avgUnitsPerTerm} standardLoad={globalSummary.standardLoad} />

      {/* Term Details header */}
      <div>
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          <h3 className="text-base font-semibold text-gray-900">Term-by-Term Course Details</h3>
        </div>
        <hr className="mt-4 mx-1 border-gray-200" />
      </div>

      {/* Term navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 mt-3 mb-4">
        <button
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
          disabled={termIdx >= sortedKeys.length - 1}
          onClick={() => setTermIdx((i) => Math.min(i + 1, sortedKeys.length - 1))}
          title="Previous term"
        >
          <ChevronLeft className="h-4 w-4" />
          <span>Previous</span>
        </button>

        <div className="flex flex-col items-center gap-1">
          <div className="rounded-full border border-emerald-100 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800 shadow-sm">
            {activeKey || "—"}
          </div>
          {sortedKeys.length > 0 && (
            <div className="text-xs text-gray-500">
              {termIdx + 1} of {sortedKeys.length}
            </div>
          )}
        </div>

        <button
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
          disabled={termIdx <= 0}
          onClick={() => setTermIdx((i) => Math.max(i - 1, 0))}
          title="Next term"
        >
          <span>Next</span>
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Term table */}
      {activeKey && (
        <div className="space-y-4">
          <div className="border border-gray-200 bg-white shadow-sm overflow-visible rounded-xl">
            <div className="overflow-x-auto rounded-xl">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b text-gray-700">
                  <tr>
                    <th className="text-left px-4 py-2">Course Code &amp; Title</th>
                    <th className="text-left px-4 py-2">Section</th>
                    <th className="text-center px-4 py-2">Units</th>
                    <th className="text-left px-4 py-2">Day 1</th>
                    <th className="text-left px-4 py-2">Begin 1</th>
                    <th className="text-left px-4 py-2">End 1</th>
                    <th className="text-left px-4 py-2">Day 2</th>
                    <th className="text-left px-4 py-2">Begin 2</th>
                    <th className="text-left px-4 py-2">End 2</th>
                  </tr>
                </thead>

                <tbody className="divide-y">
                  {activeRows.map((r, idx) => {
                    const t = splitTimeForDays(r.time, !!r.day2);
                    const begin1 = r.begin1 ?? t.begin1;
                    const end1 = r.end1 ?? t.end1;
                    const begin2 = r.begin2 ?? t.begin2;
                    const end2 = r.end2 ?? t.end2;
                    return (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-left font-semibold text-emerald-700">
                          {r.course_code || "—"}
                          <div className="text-xs text-gray-500">{r.course_title || "—"}</div>
                        </td>

                        <td className="px-4 py-3">{r.section_code || "—"}</td>
                        <td className="px-4 py-3 text-center">{r.units ?? "—"}</td>
                        <td className="px-4 py-3">{dayInitial(r.day1)}</td>
                        <td className="px-4 py-3">{begin1 ?? "—"}</td>
                        <td className="px-4 py-3">{end1 ?? "—"}</td>
                        <td className="px-4 py-3">{dayInitial(r.day2)}</td>
                        <td className="px-4 py-3">{begin2 ?? "—"}</td>
                        <td className="px-4 py-3">{end2 ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function mostTaughtCountLabel(n: number) {
  if (!n || n <= 0) return "—";
  return `${n} time(s)`;
}
