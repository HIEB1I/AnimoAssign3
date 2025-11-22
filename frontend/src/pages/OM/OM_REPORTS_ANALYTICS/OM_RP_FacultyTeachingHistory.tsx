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
      next.add(id);
      setOpenIds(next); // Set open first to show loading immediately
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
 * UNITS HISTORY CHART COMPONENT (Minor Fix/Enhancement)
 * * Retains as a core part of the analytics view.
 * ----------------------------- */
type UnitsByTerm = { key: string; units: number };

function UnitsHistoryChart({ data, avgLoad }: { data: UnitsByTerm[], avgLoad: number }) {
  if (!data || data.length === 0) return null;

  let maxUnits = data.reduce((max, d) => Math.max(max, d.units), 0) * 1.1; // Add padding
  if (avgLoad > maxUnits) maxUnits = avgLoad * 1.1;
  const scaleFactor = maxUnits > 0 ? 100 / maxUnits : 0;
  
  return (
    // Replaced generic div with a styled card for visual impact
    <div className="p-5 rounded-xl border border-gray-200 bg-white shadow-lg">
      <h3 className="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
        📊 Teaching Load Trend (Units per Term)
      </h3>
      
      {/* Legend for context - Simplified */}
      <p className="text-xs text-gray-600 mb-4 border-b pb-3">
          <span className="text-emerald-500 font-semibold">Standard Load</span> | 
          <span className="text-red-500 ml-3 font-semibold">High Load (&gt; Avg + 20%)</span> |
          <span className="text-amber-500 ml-3 font-semibold">Low Load (&lt; Avg - 20%)</span> |
          <span className="text-indigo-700 ml-3 font-semibold">Reference Line: Average Load ({avgLoad.toFixed(1)} Units)</span>
      </p>

      <div className="flex flex-col space-y-4 text-sm"> {/* Increased spacing and font size */}
        {data.map((d) => {
          const percentage = d.units * scaleFactor;
          const avgLinePosition = avgLoad * scaleFactor;
          
          // Define thresholds for High/Low load (e.g., 20% deviation from average)
          const isHigh = avgLoad > 0 && d.units > avgLoad * 1.2;
          const isLow = avgLoad > 0 && d.units < avgLoad * 0.8;
          const barColor = isHigh ? 'bg-red-500' : isLow ? 'bg-amber-500' : 'bg-emerald-500';
          
          return (
            <div key={d.key} className="flex items-center">
              <span className="w-44 text-gray-700 font-medium whitespace-nowrap">{d.key}</span> {/* Wider label */}
              
              {/* Bar Container */}
              <div className="flex items-center w-full ml-6 relative h-6"> {/* Increased height */}
                
                {/* Horizontal Bar */}
                <div 
                  className={`rounded h-full ${barColor} transition-all duration-300`} // Added transition
                  style={{ width: `${percentage}%` }}
                  title={`${d.key}: ${d.units} Units`}
                />
                
                {/* Visual indicator for average load baseline - Changed color for contrast */}
                {avgLoad > 0 && (
                  <div 
                    className="absolute h-full w-[3px] bg-indigo-700 -translate-y-1/2 top-1/2 rounded-full" // Thicker line
                    style={{ left: `${avgLinePosition}%` }}
                    title={`Historical Average Load: ${avgLoad.toFixed(1)} units`}
                  />
                )}
                
                {/* Label - Placed outside the bar for clarity if bar is small */}
                <span className="ml-3 font-extrabold text-gray-800">
                  {d.units}
                  {(isHigh || isLow) && (
                      <span className={`ml-2 text-xs font-semibold ${isHigh ? 'text-red-500' : 'text-amber-500'}`}>
                          ({isHigh ? 'High' : 'Low'})
                      </span>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** -----------------------------
 * History Tables (REVISED for Clarity and Descriptive Analytics)
 * ----------------------------- */
function HistoryTables({ rows }: { rows: TeachingHistoryRow[] }) {
  // ... (Existing useMemo for grouped, sortedKeys, globalSummary, and unitsByTerm remain the same) ...
  const grouped = useMemo(() => groupByTermAndAy(rows || []), [rows]);
  
  // DERIVE KEYS FROM ROWS to preserve Backend Sort Order (AY Desc -> Term Desc).
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
  
  // Global summary logic
  const globalSummary = useMemo(() => {
    const totalUnitsOverall = rows.reduce((sum, r) => sum + (r.units || 0), 0);
    const totalCoursesOverall = rows.length;
    const uniqueCoursesOverall = Array.from(new Set(rows.map(r => r.course_code))).length;
    const acadYearsCovered = Array.from(new Set(rows.map(r => r.ay))).length;
    const termCount = sortedKeys.length;

    // Derived Analytics Metrics
    const courseRepeatRate = 
        totalCoursesOverall > 0 
            ? (totalCoursesOverall - uniqueCoursesOverall) / totalCoursesOverall 
            : 0;

    const avgCoursesPerAy = 
        acadYearsCovered > 0 
            ? totalCoursesOverall / acadYearsCovered 
            : 0;

    const avgUnitsPerTerm = termCount > 0 ? totalUnitsOverall / termCount : 0; // Essential for chart baseline

    // Logistics
    const campusCounts: Record<string, number> = {};
    const modeCounts: Record<string, number> = {};
    rows.forEach(r => {
        const c = r.campus || "Online/N/A";
        campusCounts[c] = (campusCounts[c] || 0) + 1;
        const m = r.mode || "N/A";
        modeCounts[m] = (modeCounts[m] || 0) + 1;
    });
    const primaryCampus = Object.entries(campusCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';
    const primaryMode = Object.entries(modeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';


    return {
        totalUnitsOverall, totalCoursesOverall, uniqueCoursesOverall, acadYearsCovered, 
        primaryCampus, primaryMode,
        courseRepeatRate, avgCoursesPerAy, avgUnitsPerTerm, termCount
    };
  }, [rows, sortedKeys]);
  
  // Units by Term logic
  const unitsByTerm = useMemo(() => {
    return sortedKeys.map(k => {
      const list = grouped[k] || [];
      const totalUnits = list.reduce((sum, r) => sum + (r.units || 0), 0);
      return { key: k, units: totalUnits };
    });
  }, [rows, sortedKeys, grouped]);


  return (
    <div className="space-y-8 mt-2">
      
      {/* 1. Global Performance Overview - Highlight the most insightful metrics */}
      <div className="p-6 rounded-xl border-4 border-emerald-100 bg-emerald-50 shadow-xl">
          <h3 className="text-xl font-extrabold text-emerald-800 mb-4 flex items-center gap-2">
            ⭐ Overall Faculty Profile: {globalSummary.acadYearsCovered} AYs Covered
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-sm">
              <div className="space-y-1 p-3 bg-white rounded-lg border">
                  <div className="text-gray-500 font-medium">Average Unit Load per Term</div>
                  <div className="text-3xl font-extrabold text-emerald-600">{globalSummary.avgUnitsPerTerm.toFixed(1)}</div>
                  <div className="text-gray-600">Units (Across {globalSummary.termCount} Terms)</div>
              </div>
              <div className="space-y-1 p-3 bg-white rounded-lg border">
                  <div className="text-gray-500 font-medium">Course Repetition Rate</div>
                  <div className="text-3xl font-extrabold text-indigo-600">{(globalSummary.courseRepeatRate * 100).toFixed(0)}%</div>
                  <div className="text-gray-600">{globalSummary.uniqueCoursesOverall} unique courses out of {globalSummary.totalCoursesOverall} total.</div>
              </div>
              <div className="space-y-1 p-3 bg-white rounded-lg border">
                  <div className="text-gray-500 font-medium">Avg Courses per Academic Year</div>
                  <div className="text-3xl font-extrabold text-amber-600">{globalSummary.avgCoursesPerAy.toFixed(1)}</div>
                  <div className="text-gray-600">Courses taught.</div>
              </div>
              <div className="space-y-1 p-3 bg-white rounded-lg border">
                  <div className="text-gray-500 font-medium">Primary Logistics</div>
                  <div className="text-xl font-bold text-gray-800">{globalSummary.primaryMode}</div>
                  <div className="text-gray-600">@ {globalSummary.primaryCampus}</div>
              </div>
          </div>
      </div>
      
      {/* 2. Visual Overview of Load */}
      <UnitsHistoryChart data={unitsByTerm} avgLoad={globalSummary.avgUnitsPerTerm} />
      
      {/* 3. Detailed Term History - Streamlined for focus */}
      <h3 className="text-xl font-bold text-gray-800 border-b pb-2 flex items-center gap-2">
        📅 Term-by-Term Course Details
      </h3>

      {sortedKeys.map((groupKey) => {
        const list = grouped[groupKey] || [];
        
        // Per-Term Summary Metrics Calculation
        const totalUnits = list.reduce((sum, r) => sum + (r.units || 0), 0);
        const numCourses = list.length;
        const avgUnitsPerCourse = numCourses > 0 ? (totalUnits / numCourses).toFixed(1) : 0;
        const uniqueCampuses = Array.from(new Set(list.map(r => r.campus || "N/A")));
        const uniqueModes = Array.from(new Set(list.map(r => r.mode || "Online")));
        
        // Term Load Anomaly Check
        const avgLoad = globalSummary.avgUnitsPerTerm;
        const isHighLoad = totalUnits > avgLoad * 1.2;
        const isLowLoad = totalUnits < avgLoad * 0.8;
        const loadColor = isHighLoad ? 'text-red-600 bg-red-50' : isLowLoad ? 'text-amber-600 bg-amber-50' : 'text-emerald-700 bg-gray-50';
        const loadStatus = isHighLoad ? 'HIGH LOAD' : isLowLoad ? 'LOW LOAD' : 'STANDARD LOAD';


        return (
          <div key={groupKey} className="rounded-xl border border-gray-200 overflow-hidden shadow-sm">
            {/* Header: Term + Load Status */}
            <div className={`px-4 py-3 text-lg font-bold ${loadColor} border-b`}>
              {groupKey} <span className="text-sm font-semibold ml-2">({loadStatus})</span>
            </div>
            
            {/* Term Summary: Focus on Load and Logistics */}
            <div className="p-4 bg-white border-b border-gray-100 grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                {/* Course Load Metrics */}
                <div className="space-y-0.5">
                    <div className="text-gray-500 font-medium">Total Courses</div>
                    <div className="text-xl font-bold text-gray-800">{numCourses}</div>
                </div>
                <div className="space-y-0.5">
                    <div className="text-gray-500 font-medium">Term Units (Avg Course Unit)</div>
                    <div className="text-xl font-bold text-gray-800">{totalUnits} ({avgUnitsPerCourse})</div>
                </div>
                {/* Logistics Metrics */}
                <div className="space-y-0.5">
                    <div className="text-gray-500 font-medium">Delivery Modes</div>
                    <div className="text-sm font-bold text-gray-800 mt-1">{uniqueModes.join(", ")}</div>
                </div>
                <div className="space-y-0.5">
                    <div className="text-gray-500 font-medium">Campuses</div>
                    <div className="text-sm font-bold text-gray-800 mt-1">{uniqueCampuses.join(", ")}</div>
                </div>
            </div>
            
            {/* Detailed Course Table */}
            <div className="overflow-x-auto">
              <table className="min-w-full table-fixed text-sm border-t border-gray-200">
                <colgroup>
                  <col className="w-[12%]" /> {/* Course Code */}
                  <col className="w-[8%]"  /> {/* Units */}
                  <col className="w-[10%]"  /> {/* Section */}
                  <col className="w-[30%]" /> {/* Primary Schedule (Day 1/Time/Room 1) */}
                  <col className="w-[20%]" /> {/* Secondary Schedule (Day 2/Room 2) */}
                  <col className="w-[10%]" /> {/* Mode */}
                  <col className="w-[10%]" /> {/* Campus */}
                </colgroup>
                <thead className="bg-gray-100 text-gray-700 text-xs uppercase tracking-wide">
                  <tr>
                    {[
                      "Course Code", "Units", "Section", 
                      "Primary Schedule", 
                      "Secondary Schedule",
                      "Mode", "Campus"
                    ].map((h) => (
                      <th key={h} className="px-3 py-2 text-center font-semibold whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.map((r, i) => (
                    <tr
                      key={i}
                      className={i % 2 === 0 ? "bg-white text-gray-800 hover:bg-gray-50" : "bg-gray-50 text-gray-800 hover:bg-gray-100"}
                      title={r.course_title} // Use title for Course Title
                    >
                      <td className="px-3 py-2 text-center font-medium">{r.course_code}</td>
                      <td className="px-3 py-2 text-center font-semibold">{r.units || "-"}</td>
                      <td className="px-3 py-2 text-center">{r.section_code}</td>
                      {/* Combined Primary Schedule */}
                      <td className="px-3 py-2 text-center whitespace-normal">
                          <span className="font-bold">{r.time || "-"}</span> on {r.day1 || "-"} in {r.room1 || "-"}
                      </td>
                       {/* Combined Secondary Schedule */}
                      <td className="px-3 py-2 text-center whitespace-normal text-gray-600">
                          {r.day2 || "-"} / {r.room2 || "-"}
                      </td>
                      <td className="px-3 py-2 text-center text-sm">{r.mode || "N/A"}</td>
                      <td className="px-3 py-2 text-center text-sm">{r.campus || "N/A"}</td>
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