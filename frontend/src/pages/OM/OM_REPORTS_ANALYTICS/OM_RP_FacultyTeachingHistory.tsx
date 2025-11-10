// frontend/src/pages/OM/OM_RP_FacultyTeachingHistory.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronDown, ChevronRight } from "lucide-react";
import { fetchTeachingHistory, listFaculty } from "../../../api";

/** -----------------------------
 * Types
 * ----------------------------- */
type Schedule = {
  day: string;
  start_time: string;
  end_time: string;
  room?: string;
  room_type?: string | null;
};

type TeachingHistoryRow = {
  term_name?: string;
  course_code?: string;
  course_title?: string;
  section_code?: string;
  units?: number;
  modality?: string;
  campus_id?: string;
  schedule: Schedule[];
};

type FacultyLite = { faculty_id: string; name: string };

/** -----------------------------
 * Helpers
 * ----------------------------- */
function hhmmRange(a?: string, b?: string) {
  const A = (a || "").trim();
  const B = (b || "").trim();
  if (!A && !B) return "";
  if (A && B) return `${A}–${B}`;
  return A || B || "";
}

function flattenSlots(s: Schedule[] = []) {
  const s1 = s[0];
  const s2 = s[1];
  return {
    day1: s1?.day || "",
    room1: s1?.room || "",
    day2: s2?.day || "",
    room2: s2?.room || "",
    time: s1 ? hhmmRange(s1.start_time, s1.end_time) : "",
  };
}

function groupByTerm(rows: TeachingHistoryRow[]) {
  const groups: Record<string, TeachingHistoryRow[]> = {};
  for (const r of rows) {
    const key = r.term_name || "Term 1";
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }
  return groups;
}

/** Sort helpers for "LAST, FIRST" (fallback if no comma) */
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

/** Format display as "Last, First" regardless of input shape */
function formatLastCommaFirst(name: string) {
  const { last, first } = splitLastFirst(name);
  if (!last && !first) return name || "";
  return first ? `${last}, ${first}` : last;
}

/** Normalize strings for robust matching */
function norm(s: string) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[.,']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build a search haystack for a name (covers multiple formats) */
function searchKeys(name: string) {
  const { last, first } = splitLastFirst(name);
  const all = [
    norm(name),                // raw (maybe already "Last, First")
    norm(`${last}, ${first}`), // forced Last, First
    norm(`${first} ${last}`),  // First Last
    norm(last),
    norm(first),
  ].filter(Boolean);
  return Array.from(new Set(all)).join(" | ");
}


/** -----------------------------
 * Page
 * ----------------------------- */
export default function OM_RP_FacultyTeachingHistory() {
  return (
    <div className="w-full px-8 py-8">
      <h1 className="text-2xl font-bold mb-2">Teaching History of Faculty</h1>
      <p className="text-sm text-gray-600 mb-6">
        Click a name to expand their teaching history.
      </p>
      <FacultyAccordion />
    </div>
  );
}

/** -----------------------------
 * Accordion List
 * ----------------------------- */
function FacultyAccordion() {
  // directory
  const [allFaculty, setAllFaculty] = useState<FacultyLite[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // open state (multiple allowed)
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  // per-faculty cache + loading/error
  const [cache, setCache] = useState<Record<string, TeachingHistoryRow[]>>({});
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  // load faculty list
  useEffect(() => {
    let cancelled = false;
    async function go() {
      setListLoading(true);
      setListError(null);
      try {
        const res = await listFaculty({});
        // de-duplicate by faculty_id just in case
        const uniq = new Map<string, FacultyLite>();
        (Array.isArray(res?.rows) ? res.rows : []).forEach((r: any) => {
          if (r?.faculty_id) uniq.set(r.faculty_id, { faculty_id: r.faculty_id, name: r.name });
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

  // Filter & sort (only display matching names)
  const filteredSorted = useMemo(() => {
    const q = norm(filter);
    const tokens = q ? q.split(" ") : [];
    const base = tokens.length
      ? allFaculty.filter((f) => {
          const hay = searchKeys(f.name);
          // require every token to appear in the haystack
          return tokens.every((t) => hay.includes(t));
        })
      : allFaculty;

    return [...base].sort((a, b) => compareLastFirst(a.name, b.name));
  }, [allFaculty, filter]);

  // when filter changes, auto-close any open accordions that no longer match
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
      // opening: fetch if not cached
      setOpenIds(next.add(id));
      if (cache[id]) return; // already cached
      setErrors((m) => ({ ...m, [id]: null }));
      setLoadingIds((s) => new Set(s).add(id));
      try {
        const data = await fetchTeachingHistory(id);
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        setCache((c) => ({ ...c, [id]: rows }));
      } catch (err: any) {
        setErrors((m) => ({ ...m, [id]: err?.message || "Failed to load teaching history." }));
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
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-gray-200">
        <Link
          to="/om/home/reports-analytics"
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 active:bg-gray-100"
          aria-label="Back"
          title="Back"
        >
          <ChevronLeft className="h-4 w-4" />
          <span>Back</span>
        </Link>

        <div className="relative flex-1 min-w-[260px]">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by faculty name…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
          {!!filter && (
            <button
              type="button"
              aria-label="Clear"
              onClick={() => setFilter("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
              title="Clear"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {listError && (
        <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{listError}</div>
      )}
      {listLoading && <div className="px-4 py-4 text-sm text-gray-500">Loading faculty…</div>}

      {/* Accordion list */}
      <ul className="divide-y">
        {!listLoading && filteredSorted.length === 0 && (
          <li className="p-4 text-sm text-gray-500">No faculty found.</li>
        )}
        {filteredSorted.map((f) => {
          const id = f.faculty_id;
          const isOpen = openIds.has(id);
          const isLoading = loadingIds.has(id);
          const err = errors[id] || null;
          const rows = cache[id] || [];

          return (
            <li key={id} className="bg-white">
              {/* Header row */}
              <button
                onClick={() => toggle(f)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50"
                aria-expanded={isOpen}
                aria-controls={`section-${id}`}
              >
                <span className="inline-flex items-center gap-2">
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  {/* Display as "Last, First" */}
                  <span className="font-medium text-gray-900">{formatLastCommaFirst(f.name)}</span>
                </span>
                <span className="text-xs text-gray-500">{isLoading ? "Loading…" : isOpen ? "Hide" : "Show"}</span>
              </button>

              {/* Dropdown content */}
              {isOpen && (
                <div id={`section-${id}`} className="px-4 pb-4">
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
 * Teaching history tables (grouped by term)
 * ----------------------------- */
function HistoryTables({ rows }: { rows: TeachingHistoryRow[] }) {
  const grouped = useMemo(() => groupByTerm(rows || []), [rows]);

  return (
    <div className="space-y-6 mt-2">
      {(Object.keys(grouped).sort() as string[]).map((term) => {
        const list = grouped[term] || [];
        return (
          <div key={term} className="rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2 text-sm font-semibold text-emerald-700 bg-gray-50 border-b">{term}</div>

            <div className="overflow-x-auto">
              <table className="min-w-full table-fixed text-sm border-t border-gray-200">
                {/* 8 evenly spaced columns */}
                <colgroup>
                  <col style={{ width: "12.5%" }} />
                  <col style={{ width: "12.5%" }} />
                  <col style={{ width: "12.5%" }} />
                  <col style={{ width: "12.5%" }} />
                  <col style={{ width: "12.5%" }} />
                  <col style={{ width: "12.5%" }} />
                  <col style={{ width: "12.5%" }} />
                  <col style={{ width: "12.5%" }} />
                </colgroup>
                <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                  <tr>
                    {[
                      "Course Code",
                      "Course Title",
                      "Section",
                      "Day 1",
                      "Room 1",
                      "Day 2",
                      "Room 2",
                      "Time",
                    ].map((h) => (
                      <th key={h} className="px-3 py-2 text-center font-medium whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-6 text-center text-sm text-gray-500">
                        No records.
                      </td>
                    </tr>
                  ) : (
                    list.map((r, i) => {
                      const slots = flattenSlots(r.schedule || []);
                      return (
                        <tr
                          key={`${term}-${r.course_code}-${r.section_code}-${i}`}
                          className={i % 2 === 0 ? "bg-white text-gray-800" : "bg-gray-50 text-gray-800"}
                        >
                          <td className="px-3 py-2 text-center">{r.course_code || ""}</td>
                          <td className="px-3 py-2 text-center">{r.course_title || ""}</td>
                          <td className="px-3 py-2 text-center">{r.section_code || ""}</td>
                          <td className="px-3 py-2 text-center">{slots.day1}</td>
                          <td className="px-3 py-2 text-center">{slots.room1}</td>
                          <td className="px-3 py-2 text-center">{slots.day2}</td>
                          <td className="px-3 py-2 text-center">{slots.room2}</td>
                          <td className="px-3 py-2 text-center">{slots.time}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
