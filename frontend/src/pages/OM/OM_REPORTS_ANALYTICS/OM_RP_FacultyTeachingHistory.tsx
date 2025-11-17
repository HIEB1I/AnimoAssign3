// frontend/src/pages/OM/OM_RP_FacultyTeachingHistory.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronDown, ChevronRight } from "lucide-react";
import { fetchTeachingHistory, listFaculty } from "../../../api";

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
  
  // Flattened Schedule
  day1?: string;
  room1?: string;
  day2?: string;
  room2?: string;
  time?: string;
};

type FacultyLite = { faculty_id: string; name: string };

/** -----------------------------
 * Helpers
 * ----------------------------- */
function groupByTermAndAy(rows: TeachingHistoryRow[]) {
  // We group by AY first, then Term, or just group by "AY X - Term Y" to keep it simple 
  // but the UI request implies keeping the existing "Group by Term" visually, 
  // however, to distinguish AYs, we should key by AY+Term.
  const groups: Record<string, TeachingHistoryRow[]> = {};
  for (const r of rows) {
    // Key example: "AY 2024-2025 • Term 1"
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


/** -----------------------------
 * Page Component
 * ----------------------------- */
export default function OM_RP_FacultyTeachingHistory() {
  return (
    <div className="w-full px-8 py-8">
      <h1 className="text-2xl font-bold mb-2">Teaching History of Faculty</h1>
      <p className="text-sm text-gray-600 mb-6">
        Click a name to expand their complete teaching history.
      </p>
      <FacultyAccordion />
    </div>
  );
}

/** -----------------------------
 * Accordion List
 * ----------------------------- */
function FacultyAccordion() {
  const [allFaculty, setAllFaculty] = useState<FacultyLite[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [cache, setCache] = useState<Record<string, TeachingHistoryRow[]>>({});
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  useEffect(() => {
    let cancelled = false;
    async function go() {
      setListLoading(true);
      setListError(null);
      try {
        const res = await listFaculty({});
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
    return () => { cancelled = true; };
  }, []);

  const filteredSorted = useMemo(() => {
    const q = norm(filter);
    const tokens = q ? q.split(" ") : [];
    const base = tokens.length
      ? allFaculty.filter((f) => {
          const hay = searchKeys(f.name);
          return tokens.every((t) => hay.includes(t));
        })
      : allFaculty;
    return [...base].sort((a, b) => compareLastFirst(a.name, b.name));
  }, [allFaculty, filter]);

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
      setOpenIds(next.add(id));
      if (cache[id]) return;
      
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
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by faculty name…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
          {!!filter && (
            <button
              onClick={() => setFilter("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {listError && <div className="px-4 py-3 text-sm text-red-700 bg-red-50">{listError}</div>}
      {listLoading && <div className="px-4 py-4 text-sm text-gray-500">Loading faculty…</div>}

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
 * History Tables (Updated to 9-column logic)
 * ----------------------------- */
function HistoryTables({ rows }: { rows: TeachingHistoryRow[] }) {
  const grouped = useMemo(() => groupByTermAndAy(rows || []), [rows]);
  
  // Keys are "AY X • Term Y". Sort desc (newest AY first).
  const sortedKeys = Object.keys(grouped).sort().reverse();

  return (
    <div className="space-y-6 mt-2">
      {sortedKeys.map((groupKey) => {
        const list = grouped[groupKey] || [];
        return (
          <div key={groupKey} className="rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2 text-sm font-semibold text-emerald-700 bg-gray-50 border-b">
              {groupKey}
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full table-fixed text-sm border-t border-gray-200">
                <colgroup>
                  <col className="w-[12ch]" /> {/* Course Code */}
                  <col className="w-[28ch]" /> {/* Course Title */}
                  <col className="w-[8ch]"  /> {/* Section */}
                  <col className="w-[8ch]"  /> {/* Mode */}
                  <col className="w-[6ch]"  /> {/* Day 1 */}
                  <col className="w-[12ch]" /> {/* Room 1 */}
                  <col className="w-[6ch]"  /> {/* Day 2 */}
                  <col className="w-[12ch]" /> {/* Room 2 */}
                  <col className="w-[14ch]" /> {/* Time */}
                </colgroup>
                <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                  <tr>
                    {[
                      "Course Code", "Course Title", "Section", "Mode",
                      "Day 1", "Room 1", "Day 2", "Room 2", "Time"
                    ].map((h) => (
                      <th key={h} className="px-3 py-2 text-center font-medium whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.map((r, i) => (
                    <tr
                      key={i}
                      className={i % 2 === 0 ? "bg-white text-gray-800" : "bg-gray-50 text-gray-800"}
                    >
                      <td className="px-3 py-2 text-center">{r.course_code}</td>
                      <td className="px-3 py-2 text-center whitespace-normal">{r.course_title}</td>
                      <td className="px-3 py-2 text-center">{r.section_code}</td>
                      <td className="px-3 py-2 text-center">{r.mode}</td>
                      <td className="px-3 py-2 text-center">{r.day1 || "-"}</td>
                      <td className="px-3 py-2 text-center">{r.room1 || "-"}</td>
                      <td className="px-3 py-2 text-center">{r.day2 || "-"}</td>
                      <td className="px-3 py-2 text-center">{r.room2 || "-"}</td>
                      <td className="px-3 py-2 text-center">{r.time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}