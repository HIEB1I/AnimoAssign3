// frontend/src/pages/OM_RP_FacultyTeachingHistory.tsx
import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search as SearchIcon, ChevronLeft } from "lucide-react";
import { fetchTeachingHistory, listFaculty } from "../../../api";

/** -----------------------------
 * Types (unchanged, from OM_desc)
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

/** -----------------------------
 * Helpers (UI-only)
 * ----------------------------- */
function hhmmRange(a?: string, b?: string) {
  const A = (a || "").trim();
  const B = (b || "").trim();
  if (!A && !B) return "";
  if (A && B) return `${A}–${B}`;
  return A || B || "";
}

function flattenSlots(s: Schedule[] = []) {
  // First two meeting patterns only to fit the table
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

// Group rows by term label similar to "Term 1/2/3"
function groupByTerm(rows: TeachingHistoryRow[]) {
  const groups: Record<string, TeachingHistoryRow[]> = {};
  for (const r of rows) {
    const key = r.term_name || "Term 1";
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }
  return groups;
}

/** -----------------------------
 * Main Page (UI refreshed)
 * ----------------------------- */
export default function OM_RP_FacultyTeachingHistory() {
  return (
    <div className="w-full px-8 py-8">
      {/* Header (keep your inherited header + subtitle) */}
      <h1 className="text-2xl font-bold mb-2">Teaching History of Faculty</h1>
      <p className="text-sm text-gray-600 mb-6">
        Historical teaching loads and assignments by faculty member.
      </p>

      {/* Ref-styled content */}
      <TeachingHistorySearch />
    </div>
  );
}

/** -----------------------------
 * Teaching History Search Widget
 * (UI-only changes; backend call unchanged)
 * ----------------------------- */
function TeachingHistorySearch() {
  const [nameInput, setNameInput] = useState("");
  const [selectedName, setSelectedName] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<TeachingHistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  function pickBestMatch(list: Array<{ faculty_id: string; name: string }>, q: string) {
    if (!Array.isArray(list) || list.length === 0) return null;
    const query = q.trim().toLowerCase();
    // Prefer exact (case-insensitive) name match
    const exact = list.find((r) => (r.name || "").trim().toLowerCase() === query);
    if (exact) return exact;
    // Else first item that contains the query
    const partial = list.find((r) => (r.name || "").toLowerCase().includes(query));
    if (partial) return partial;
    // Fallback to first result
    return list[0];
  }

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRows([]);

    const q = (nameInput || "").trim();
    if (!q) {
      setError("Enter a faculty name.");
      return;
    }

    setLoading(true);
    try {
      // 1) Resolve faculty name → faculty_id using OM: Faculty Directory search
      const list = await listFaculty({ search: q }); // returns { ok, rows: FacultyRow[] }
      const candidates = Array.isArray(list?.rows) ? list.rows : [];
      const best = pickBestMatch(
        candidates.map((r: any) => ({ faculty_id: r.faculty_id, name: r.name })),
        q
      );
      if (!best) {
        setSelectedName(q);
        setRows([]);
        setError("No matching faculty found.");
        return;
      }

      // 2) Fetch teaching history by resolved faculty_id
      const data = await fetchTeachingHistory(best.faculty_id);
      setRows(Array.isArray(data?.rows) ? data.rows : []);
      setSelectedName(best.name || q);
    } catch (err: any) {
      setRows([]);
      setSelectedName("");
      setError(err?.message || "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  const grouped = useMemo(() => groupByTerm(rows || []), [rows]);

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      {/* Filter Bar (Back + Search) — button OUTSIDE the input */}
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

        <form onSubmit={onSearch} className="flex items-center gap-2 flex-1 min-w-[320px]">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Search by faculty name…"
              className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
            />
            {!!nameInput && (
              <button
                type="button"
                aria-label="Clear search"
                title="Clear"
                onClick={() => setNameInput("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
              >
                ×
              </button>
            )}
          </div>

          {/* Search button OUTSIDE the input box */}
          <button
            type="submit"
            disabled={loading}
            className={`rounded-lg border px-4 py-2 text-sm font-semibold ${
              loading
                ? "cursor-default border-emerald-200 bg-emerald-200 text-emerald-900"
                : "cursor-pointer border-emerald-500 bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
            }`}
          >
            {loading ? "Searching…" : "Search"}
          </button>
        </form>
      </div>

      {/* Status / error rows */}
      {error && (
        <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>
      )}
      {loading && <div className="px-4 py-4 text-sm text-gray-500">Loading…</div>}

      {/* Results */}
      {!loading && rows.length === 0 && !error && (
        <div className="px-4 py-6 text-center text-sm text-gray-500">
          {!selectedName ? "No results yet. Enter a faculty name to search." : "No records found."}
        </div>
      )}

      {/* Render tables by term — evenly spaced 8 columns (Mode removed) */}
      {!loading && rows.length > 0 && (
        <div className="p-4 space-y-6">
          <div className="text-sm text-gray-600">
            Showing results for{" "}
            <span className="font-semibold text-gray-900">{selectedName || "—"}</span>
          </div>

          {(Object.keys(grouped).sort() as string[]).map((term) => {
            const list = grouped[term] || [];
            return (
              <div key={term} className="rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-4 py-2 text-sm font-semibold text-emerald-700 bg-gray-50 border-b">
                  {term}
                </div>

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
      )}
    </div>
  );
}
