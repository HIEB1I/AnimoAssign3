// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM_RP_CourseProfile.tsx
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search as SearchIcon, ChevronLeft, BarChart2, Users, Layers, TrendingUp } from "lucide-react";
import { fetchCourseProfile, type CMCourseRow } from "@/api";

/* -----------------------------
 * Types matching backend payload
 * (UPDATED for new metrics)
 * ----------------------------- */

// Minimal Instructor/Faculty structure (used for Qualified and Top Instructors)
type InstructorInfo = {
  faculty_id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
};

// Section details (only needed for PastInstructorsTop3 in the new design, but kept for type)
type PastTeach = {
  course_code?: string[];
  section_id?: string;
  section_code?: string;
  term_id?: string;
  acad_year_start?: number;
  term_number?: number;
};

// Past Instructor (now includes the count)
type PastInstructorCount = InstructorInfo & {
  count?: number;
  sections?: PastTeach[];
};

// New history metrics structure
type HistoryMetrics = {
    total_sections: number;
    unique_instructors: number;
    avg_teaching_frequency: number;
    most_recent_taught: {
        acad_year_start?: number;
        term_number?: number;
    };
    ay_demand_visual: Array<{ ay: number; sections: number }>;
};

type PrefEntry = InstructorInfo;

// The main course profile payload (UPDATED)
type CourseProfile = {
  course_id: string;
  course_code?: string[];
  title?: string;
  qualified_faculty?: InstructorInfo[];
  past_instructors_top3?: PastInstructorCount[]; // Top 3 list
  past_instructors_remaining_count?: number; // Count of the rest
  history_metrics?: HistoryMetrics; // New aggregate metrics
  preferences?: string | PrefEntry[];
};


/* -----------------------------
 * Helpers (UI-only)
 * ----------------------------- */
function joinCodes(codes?: string[]): string {
  return codes && codes.length ? codes.join(", ") : "";
}
function fmtAY(start?: number): string {
  if (typeof start !== "number") return "—";
  return `${start}–${start + 1}`;
}
function fmtTerm(n?: number): string {
  return typeof n === "number" ? `Term ${n}` : "—";
}
function fullName(last?: string, first?: string) {
  const L = (last || "").trim();
  const F = (first || "").trim();
  if (!L && !F) return "—";
  if (!L) return F;
  if (!F) return L;
  return `${L}, ${F}`;
}

// Mock Component for the chart visualization
// In a real application, this would use a library like Recharts or Victory
const CourseDemandVisual = ({ data }: { data: Array<{ ay: number; sections: number }> }) => {
    if (!data || data.length === 0) {
        return <div className="p-4 text-center text-gray-500">No history data available for demand visualization.</div>;
    }

    const maxSections = Math.max(...data.map(d => d.sections));
    const normalizedData = data.map(d => ({
        ...d,
        height: (d.sections / maxSections) * 100, // percentage height
    }));

    return (
        <div className="p-4 bg-white rounded-lg border border-gray-200 shadow-inner">
            <h3 className="text-md font-semibold text-gray-800 mb-3 flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-emerald-500" />
                Course Demand by Academic Year
            </h3>
            <div className="flex justify-between items-end h-40">
                {normalizedData.map((d) => (
                    <div key={d.ay} className="flex flex-col items-center h-full justify-end group px-1">
                        <div
                            style={{ height: `${d.height}%`, minHeight: '5px' }}
                            className="w-4 bg-emerald-400 rounded-t-sm transition-all duration-300 hover:bg-emerald-600 relative"
                        >
                            <span className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-1 text-xs font-bold text-emerald-700 opacity-0 group-hover:opacity-100 transition-opacity">
                                {d.sections}
                            </span>
                        </div>
                        <span className="mt-1 text-xs text-gray-500 whitespace-nowrap">{fmtAY(d.ay).split('–')[0]}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};

// Reusable Metric Card for the Summary
const MetricCard = ({ title, value, icon: Icon, colorClass = "text-emerald-500" }: { title: string, value: string | number, icon: React.ElementType, colorClass?: string }) => (
    <div className="p-4 bg-white rounded-lg border border-gray-200 shadow-sm flex flex-col justify-between">
        <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-gray-500">{title}</h3>
            <Icon className={`w-5 h-5 ${colorClass}`} />
        </div>
        <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
    </div>
);


/* -----------------------------
 * Main Page
 * ----------------------------- */
export default function OM_RP_CourseProfile() {
  const [query, setQuery] = useState("");
  const [courseList, setCourseList] = useState<Array<{ course_id: string; code: string; title: string }>>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);

  const [data, setData] = useState<CourseProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // --- Fetch ALL courses on mount (default view) ---
  useEffect(() => {
    let alive = true;
    // ... (Keep existing fetch logic for course list) ...
    async function run() {
      setListErr(null);
      setListLoading(true);
      try {
        const u = JSON.parse(localStorage.getItem("animo.user") || "null");
        const userId = u?.userId;
        const userEmail = u?.email;

        // 1) get clusters
        const { getCMOptions, listCMCourses } = await import("@/api");
        const opts = await getCMOptions(userEmail, userId);
        const clusters = Array.isArray(opts?.clusters) ? opts.clusters : [];

        // 2) fetch all clusters (plus a baseline call with no cluster just in case)
        const calls = [
          listCMCourses({ userId, userEmail, search: "" }), // baseline
          ...clusters.map((cluster) => listCMCourses({ userId, userEmail, cluster, search: "" })),
        ];
        const results = await Promise.allSettled(calls);

        // 3) merge by course_id
        const map = new Map<string, { course_id: string; code: string; title: string }>();
        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          const rows = (r.value?.rows || []) as CMCourseRow[];
          for (const row of rows) {
            const key = row.course_id;
            if (!key) continue;
            if (!map.has(key)) {
              map.set(key, { course_id: row.course_id, code: row.code || "", title: row.title || "" });
            }
          }
        }
        const items = Array.from(map.values());

        // 4) sort alphabetically
        items.sort((a, b) => {
          const A = (a.code || "").toLowerCase();
          const B = (b.code || "").toLowerCase();
          if (A < B) return -1;
          if (A > B) return 1;
          return (a.title || "").localeCompare(b.title || "");
        });

        if (alive) setCourseList(items);
      } catch (e: any) {
        if (alive) setListErr(e?.message || "Failed to load course list.");
      } finally {
        if (alive) setListLoading(false);
      }
    }
    run();
    return () => { alive = false; };
  }, []);

  // --- Filtered list based on query (client-side) ---
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return courseList;
    return courseList.filter(
      (c) => c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)
    );
  }, [query, courseList]);

  // --- Load a single course profile ---
  async function loadProfile(q: string) {
    setErr(null);
    setData(null);
    setLoading(true);
    try {
      const res = await fetchCourseProfile(q);
      setData(res as CourseProfile);
    } catch (e: any) {
      setErr(e?.message || "Failed to fetch course profile");
    } finally {
      setLoading(false);
    }
  }

  // Enter key still works if user types an exact code and presses Search
  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return; // no-op; the list is already visible by default
    await loadProfile(q);
  }

  const courseHeader = useMemo(() => {
    const code = (data?.course_code?.length ? joinCodes(data.course_code) : data?.course_id) ?? "";
    const title = data?.title || "No title listed";
    return `${code || "—"} - ${title || "—"}`;
  }, [data]);

  const metrics = data?.history_metrics;

  return (
    <div className="w-full px-8 py-8">
      {/* Header */}
      <h1 className="text-2xl font-bold mb-2">Course Profile</h1>
      <p className="text-sm text-gray-600 mb-6">
        View analytical metrics on course history, demand, and faculty assignment stability.
      </p>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {/* Filter Bar (Back + Search) — same pattern as reference */}
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
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter courses by code or title…"
                className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
              />
              {!!query && (
                <button
                  type="button"
                  aria-label="Clear search"
                  title="Clear"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
                >
                  ×
                </button>
              )}
            </div>

            {/* Optional: direct Search will try to open profile for the typed code */}
            <button
              type="submit"
              disabled={loading}
              className={`rounded-lg border px-4 py-2 text-sm font-semibold ${
                loading
                  ? "cursor-default border-emerald-200 bg-emerald-200 text-emerald-900"
                  : "cursor-pointer border-emerald-500 bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
              }`}
              title="Open exact course profile for the typed code"
            >
              {loading ? "Searching…" : "Open"}
            </button>
          </form>
        </div>

        {/* Left: course list (default visible). Right: selected course details (Now a Dashboard) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-0">
          {/* Course list */}
          <div className="border-r border-gray-200">
            {listErr && (
              <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">
                {listErr}
              </div>
            )}
            {listLoading && <div className="px-4 py-4 text-sm text-gray-500">Loading course list…</div>}
            {!listLoading && !listErr && (
              <>
                <div className="px-4 py-2 text-xs text-gray-500 border-b">
                  Showing {filtered.length} of {courseList.length} courses
                </div>
                <ul className="max-h-[70vh] overflow-auto divide-y" role="list" aria-label="Courses">
                  {filtered.map((c) => (
                    <li key={c.course_id} className="bg-white">
                      <button
                        onClick={() => loadProfile(c.code || c.course_id)}
                        className="w-full text-left px-4 py-3 hover:bg-gray-50"
                        title="View course profile"
                      >
                        <div className="font-semibold text-emerald-700">{c.code || "—"}</div>
                        <div className="text-sm text-gray-700 line-clamp-1">{c.title || "No title"}</div>
                      </button>
                    </li>
                  ))}
                  {filtered.length === 0 && (
                    <li className="px-4 py-4 text-sm text-gray-500">No courses match your filter.</li>
                  )}
                </ul>
              </>
            )}
          </div>

          {/* Details panel (Dashboard) */}
          <div className="md:col-span-2 p-6 space-y-6">
            {/* Status / error rows for profile */}
            {err && (
              <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
                {err}
              </div>
            )}
            {loading && (
              <div className="px-4 py-4 text-sm text-gray-500">Loading course profile…</div>
            )}

            {/* Empty state when nothing selected yet */}
            {!loading && !err && !data && (
              <div className="px-6 py-10 text-center text-sm text-gray-500 border border-gray-200 rounded-lg">
                Select a course on the left to view its analytical profile.
              </div>
            )}

            {/* Main Dashboard Content */}
            {!loading && !err && data && (
                <div className="space-y-6">
                    {/* Header: Course Code and Title */}
                    <div className="bg-emerald-50 p-4 rounded-lg border border-emerald-200">
                        <h2 className="text-xl font-bold text-emerald-800">{courseHeader}</h2>
                        <p className="text-sm text-emerald-600">Course History & Assignment Analysis</p>
                    </div>

                    {/* 1. Global Summary Card (Analytical Metrics) */}
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <MetricCard
                            title="Total Sections"
                            value={metrics?.total_sections ?? 0}
                            icon={Layers}
                        />
                        <MetricCard
                            title="Unique Instructors"
                            value={metrics?.unique_instructors ?? 0}
                            icon={Users}
                            colorClass="text-indigo-500"
                        />
                        <MetricCard
                            title="Avg. Frequency (per AY)"
                            value={metrics?.avg_teaching_frequency?.toFixed(1) ?? "0.0"}
                            icon={TrendingUp}
                            colorClass="text-orange-500"
                        />
                         <MetricCard
                            title="Most Recent Taught"
                            value={metrics?.most_recent_taught?.acad_year_start ? `${fmtAY(metrics.most_recent_taught.acad_year_start)} ${fmtTerm(metrics.most_recent_taught.term_number)}` : "Never"}
                            icon={Layers}
                            colorClass="text-gray-500"
                        />
                    </div>

                    {/* 2. Demand Visual (Chart) */}
                    <CourseDemandVisual data={metrics?.ay_demand_visual ?? []} />

                    {/* 3. Detailed Panels: Qualified, Past Instructors, Preferences */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                        {/* Qualified Faculty (Simplified) */}
                        <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                            <h3 className="text-md font-semibold text-emerald-700 mb-3">
                                Qualified Faculty ({data.qualified_faculty?.length ?? 0} Total)
                            </h3>
                            <div className="flex flex-wrap gap-2 text-sm">
                                {data.qualified_faculty?.length === 0 ? (
                                    <p className="text-gray-500">None listed.</p>
                                ) : (
                                    data.qualified_faculty?.map((qf, _i) => (
                                        <span
                                            key={qf.faculty_id}
                                            className="px-3 py-1 bg-gray-100 rounded-full text-gray-700 whitespace-nowrap"
                                            title={qf.email}
                                        >
                                            {fullName(qf.last_name, qf.first_name)}
                                        </span>
                                    ))
                                )}
                            </div>
                        </div>

                        {/* Preferences (Current Term) */}
                        <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                            <h3 className="text-md font-semibold text-emerald-700 mb-3">
                                Preferences (Current Term)
                            </h3>
                            {typeof data.preferences === "string" ? (
                                <p className="text-sm text-gray-700">{data.preferences}</p>
                            ) : Array.isArray(data.preferences) && data.preferences.length > 0 ? (
                                <div className="flex flex-wrap gap-2 text-sm">
                                    {(data.preferences as PrefEntry[]).map((p) => (
                                        <span
                                            key={p.faculty_id}
                                            className="px-3 py-1 bg-emerald-100 rounded-full text-emerald-700 whitespace-nowrap"
                                            title={p.email}
                                        >
                                            {fullName(p.last_name, p.first_name)}
                                        </span>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-gray-500 text-sm">N/A</p>
                            )}
                        </div>
                        
                         {/* Past Instructors (Top 3 Insight) - Spans full width for clarity */}
                        <div className="md:col-span-2 bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                            <h3 className="text-md font-semibold text-emerald-700 mb-3">
                                Past Instructors Insight
                            </h3>
                            {(!data.past_instructors_top3 || data.past_instructors_top3.length === 0) ? (
                                <p className="text-gray-500">None listed.</p>
                            ) : (
                                <>
                                    <h4 className="font-semibold text-gray-700 mb-2">Top 3 Most Frequent Instructors</h4>
                                    <ul className="space-y-2">
                                        {data.past_instructors_top3.map((pi, i) => (
                                            <li key={pi.faculty_id} className="flex items-center justify-between p-3 bg-gray-50 rounded-md border border-gray-100">
                                                <div className="flex items-center space-x-3">
                                                    <span className={`text-xl font-extrabold ${i === 0 ? 'text-yellow-600' : i === 1 ? 'text-slate-500' : 'text-amber-700'}`}>
                                                        #{i + 1}
                                                    </span>
                                                    <div className="font-semibold text-gray-800">
                                                        {fullName(pi.last_name, pi.first_name)}
                                                    </div>
                                                </div>
                                                <div className="text-sm text-gray-600">
                                                    Taught <span className="font-bold text-lg text-emerald-600">{pi.count}</span> sections
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                    {data.past_instructors_remaining_count && data.past_instructors_remaining_count > 0 ? (
                                        <p className="mt-3 text-sm text-gray-500">
                                            ...and {data.past_instructors_remaining_count} other instructor(s).
                                        </p>
                                    ) : null}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}