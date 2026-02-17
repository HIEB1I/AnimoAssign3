// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM_RP_CourseProfile.tsx
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Search as SearchIcon,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  BarChart2,
  Users,
  Layers,
} from "lucide-react";
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
  source?: string;
  teaching_history?: {
    count?: number;
    most_recent_taught?: { acad_year_start?: number; term_number?: number };
  };
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
  past_instructors_others?: PastInstructorCount[]; // Remaining instructors (expandable)
  history_metrics?: HistoryMetrics; // New aggregate metrics
  preferences?: string | PrefEntry[];
  active_term?: {
    term_id?: string;
    acad_year_start?: number;
    term_number?: number;
  };
  // Term navigation (same pattern as Deloading Utilization)
  term?: {
    term_id?: string;
    acad_year_start?: number;
    term_number?: number;
  };
  has_prev?: boolean;
  has_next?: boolean;
  terms?: Array<{
    term_id: string;
    acad_year_start: number;
    term_number: number;
    is_current?: boolean;
  }>;
  current_index?: number;
};

type TermLite = {
  term_id: string;
  acad_year_start: number;
  term_number: number;
  is_current?: boolean;
};

type AYDemandRow = {
  ay: number;
  t1?: number;
  t2?: number;
  t3?: number;
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

function QualifiedHoverContent({ qf }: { qf: InstructorInfo }) {
  const src = qf.source || "—";
  const th = qf.teaching_history;

  const hasTeaching =
    !!th && Array.isArray((th as any).terms) && (th as any).terms.length > 0;

  // If no teaching history details, just show source
  if (!hasTeaching) return <div>{src}</div>;

  const terms = (
    (th as any).terms as Array<{
      acad_year_start?: number;
      term_number?: number;
    }>
  ).filter(
    (t) =>
      typeof t.acad_year_start === "number" && typeof t.term_number === "number"
  );

  const count = Number(th?.count ?? terms.length);

  return (
    <div className="whitespace-pre-line">
      <div className="font-semibold text-gray-800">{`Teaching History (${count}x)`}</div>
      {terms.slice(0, 10).map((t, i) => (
        <div key={i}>{`${fmtAY(t.acad_year_start)} T${t.term_number}`}</div>
      ))}
      {terms.length > 10 ? (
        <div className="text-gray-500">{`+${terms.length - 10} more…`}</div>
      ) : null}
      {/* keep KAC info if present */}
      {src.includes("Qualified KAC") ? (
        <div className="mt-1 text-gray-600">Qualified KAC</div>
      ) : null}
    </div>
  );
}

const CourseDemandVisual = ({ data }: { data: AYDemandRow[] }) => {
  if (!data || data.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500">
        No history data available.
      </div>
    );
  }

  const rows = [...data].sort((a, b) => a.ay - b.ay);

  return (
    <div className="p-4 bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="text-md font-semibold text-emerald-700 flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-emerald-500" />
          Course Demand Over Time
        </h3>
      </div>

      <p className="text-xs text-gray-600 mb-3">
        Demand is measured as the{" "}
        <span className="font-semibold">number of sections offered</span> per
        term in each academic year.
      </p>

      <div className="overflow-auto rounded-md border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left px-3 py-2 font-semibold">
                Academic Year
              </th>
              <th className="text-right px-3 py-2 font-semibold">
                T1 Sections
              </th>
              <th className="text-right px-3 py-2 font-semibold">
                T2 Sections
              </th>
              <th className="text-right px-3 py-2 font-semibold">
                T3 Sections
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.ay} className="bg-white">
                <td className="px-3 py-2 whitespace-nowrap">{fmtAY(r.ay)}</td>
                <td className="px-3 py-2 text-right font-semibold text-gray-900">
                  {Number(r.t1 ?? 0)}
                </td>
                <td className="px-3 py-2 text-right font-semibold text-gray-900">
                  {Number(r.t2 ?? 0)}
                </td>
                <td className="px-3 py-2 text-right font-semibold text-gray-900">
                  {Number(r.t3 ?? 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// // Demand visualization (UI-only, no external chart libs)
// // Goal: make the "Course Demand" view easy to read at a glance.
// const CourseDemandVisual = ({ data }: { data: Array<{ ay: number; sections: number }> }) => {
//   if (!data || data.length === 0) {
//     return (
//       <div className="p-4 text-center text-gray-500">
//         No history data available.
//       </div>
//     );
//   }

//   const rows = [...data].sort((a, b) => a.ay - b.ay);

//   return (
//     <div className="p-4 bg-white rounded-lg border border-gray-200 shadow-sm">
//       <div className="flex items-start justify-between gap-3 mb-2">
//         <h3 className="text-md font-semibold text-emerald-700 flex items-center gap-2">
//           <BarChart2 className="w-4 h-4 text-emerald-500" />
//           Course Demand Over Time
//         </h3>
//       </div>

//       <p className="text-xs text-gray-600 mb-3">
//         Demand is measured as the <span className="font-semibold">number of sections offered</span> for this course in each academic year.
//         Use this to spot growth/decline patterns and years with unusually high or low offerings.
//       </p>

//       <div className="overflow-auto rounded-md border border-gray-200">
//         <table className="w-full text-sm">
//           <thead className="bg-gray-50 text-gray-600">
//             <tr>
//               <th className="text-left px-3 py-2 font-semibold">Academic Year</th>
//               <th className="text-right px-3 py-2 font-semibold">Sections</th>
//               <th className="text-right px-3 py-2 font-semibold">Change</th>
//             </tr>
//           </thead>
//           <tbody className="divide-y">
//             {rows.map((r, idx) => {
//               const prev = idx > 0 ? rows[idx - 1].sections : null;
//               const delta = prev === null ? null : r.sections - prev;
//               const deltaLabel = delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta}`;
//               const deltaClass =
//                 delta === null
//                   ? 'text-gray-500'
//                   : delta > 0
//                     ? 'text-emerald-700'
//                     : delta < 0
//                       ? 'text-red-700'
//                       : 'text-gray-700';

//               return (
//                 <tr key={r.ay} className="bg-white">
//                   <td className="px-3 py-2 whitespace-nowrap">{fmtAY(r.ay)}</td>
//                   <td className="px-3 py-2 text-right font-semibold text-gray-900">{r.sections}</td>
//                   <td className={`px-3 py-2 text-right font-semibold ${deltaClass}`}>{deltaLabel}</td>
//                 </tr>
//               );
//             })}
//           </tbody>
//         </table>
//       </div>
//     </div>
//   );
// };

// Reusable Metric Card for the Summary
const MetricCard = ({
  title,
  value,
  helper,
  icon: Icon,
  colorClass = "text-emerald-500",
}: {
  title: string;
  value: string | number;
  helper?: string;
  icon: React.ElementType;
  colorClass?: string;
}) => (
  <div className="p-4 bg-white rounded-lg border border-gray-200 shadow-sm flex flex-col justify-between">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-medium text-gray-500">{title}</h3>
        {helper ? (
          <p className="text-xs text-gray-500 mt-0.5">{helper}</p>
        ) : null}
      </div>
      <Icon className={`w-5 h-5 ${colorClass}`} />
    </div>
    <p className="mt-2 text-2xl font-bold text-gray-900">{value}</p>
  </div>
);

/* -----------------------------
 * Main Page
 * ----------------------------- */
export default function OM_RP_CourseProfile() {
  const [query, setQuery] = useState("");
  const [courseList, setCourseList] = useState<
    Array<{ course_id: string; code: string; title: string }>
  >([]);
  const [listLoading, setListLoading] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);

  const [data, setData] = useState<CourseProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [terms, setTerms] = useState<TermLite[]>([]);

  const [showOtherInstructors, setShowOtherInstructors] = useState(false);

  // Reset expandable state when switching course
  useEffect(() => {
    setShowOtherInstructors(false);
  }, [data?.course_id]);

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
          ...clusters.map((cluster) =>
            listCMCourses({ userId, userEmail, cluster, search: "" })
          ),
        ];
        const results = await Promise.allSettled(calls);

        // 3) merge by course_id
        const map = new Map<
          string,
          { course_id: string; code: string; title: string }
        >();
        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          const rows = (r.value?.rows || []) as CMCourseRow[];
          for (const row of rows) {
            const key = row.course_id;
            if (!key) continue;
            if (!map.has(key)) {
              map.set(key, {
                course_id: row.course_id,
                code: row.code || "",
                title: row.title || "",
              });
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
    return () => {
      alive = false;
    };
  }, []);

  // --- Filtered list based on query (client-side) ---
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return courseList;
    return courseList.filter(
      (c) =>
        c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)
    );
  }, [query, courseList]);

  useEffect(() => {
    // collapse 'other instructors' list when switching courses
    setShowOtherInstructors(false);
  }, [data?.course_id]);

  // --- Load a single course profile ---
  async function loadProfile(
    q: string,
    direction: "current" | "next" | "prev" = "current",
    anchorTermId?: string
  ) {
    setErr(null);
    setLoading(true);
    try {
      const res = await fetchCourseProfile(q, anchorTermId, direction);
      const payload = res as CourseProfile;
      setData(payload);
      if (Array.isArray(payload.terms)) setTerms(payload.terms as TermLite[]);
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

  const prefsUnique = useMemo(() => {
    if (!data) return [];
    if (typeof data.preferences === "string") return [];
    if (!Array.isArray(data.preferences)) return [];
    const seen = new Map<string, PrefEntry>();
    for (const p of data.preferences as PrefEntry[]) {
      const fid = (p?.faculty_id || "").trim();
      if (!fid) continue;
      if (!seen.has(fid)) seen.set(fid, p);
    }
    return Array.from(seen.values());
  }, [data]);
  const courseHeader = useMemo(() => {
    const code =
      (data?.course_code?.length
        ? joinCodes(data.course_code)
        : data?.course_id) ?? "";
    const title = data?.title || "No title listed";
    return `${code || "—"} - ${title || "—"}`;
  }, [data]);

  const metrics = data?.history_metrics;

  function pillLabelOf(t: { acad_year_start?: number; term_number?: number }) {
    const ay = t?.acad_year_start;
    const tn = t?.term_number;
    if (typeof ay === "number" && typeof tn === "number")
      return `AY ${fmtAY(ay)} • Term ${tn}`;
    if (typeof ay === "number") return `AY ${fmtAY(ay)}`;
    if (typeof tn === "number") return `Term ${tn}`;
    return "—";
  }

  const currentIndex = useMemo(() => {
    if (typeof data?.current_index === "number") return data.current_index;
    const tid = data?.term?.term_id;
    if (!tid) return 0;
    const idx = terms.findIndex((t) => t.term_id === tid);
    return idx >= 0 ? idx : 0;
  }, [data?.current_index, data?.term?.term_id, terms]);

  const currentPillLabel = useMemo(
    () =>
      data?.term
        ? pillLabelOf(data.term)
        : data?.active_term
        ? pillLabelOf(data.active_term)
        : "—",
    [data?.term, data?.active_term]
  );

  const planningTermId = useMemo(() => {
    if (!terms || terms.length === 0) return "";
    const curIdx = terms.findIndex((t) => t.is_current);
    if (curIdx >= 0) {
      const next = terms[curIdx + 1];
      return (next?.term_id || terms[curIdx]?.term_id || "").trim();
    }
    return (terms[terms.length - 1]?.term_id || "").trim();
  }, [terms]);

  const isActiveTerm = useMemo(() => {
    const viewed = (
      data?.term?.term_id ||
      data?.active_term?.term_id ||
      ""
    ).trim();
    if (!viewed) return false;
    if (!planningTermId) return false;
    return viewed === planningTermId;
  }, [data?.term?.term_id, data?.active_term?.term_id, planningTermId]);

  const activeTermLabel = useMemo(() => {
    if (!terms || terms.length === 0) return "";
    const curIdx = terms.findIndex((t) => !!t.is_current);
    if (curIdx < 0)
      return "Active indicates the planning term (next term after the current term).";
  }, [terms]);

  return (
    <div className="w-full px-8 py-8">
      {/* Header */}
      <h1 className="text-2xl font-bold mb-2">Course Profile</h1>
      <p className="text-sm text-gray-600 mb-6">
        View analytical metrics on course history, demand, and faculty
        assignment stability.
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

          <form
            onSubmit={onSearch}
            className="flex items-center gap-2 flex-1 min-w-[320px]"
          >
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by course code…"
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
            {listLoading && (
              <div className="px-4 py-4 text-sm text-gray-500">
                Loading course list…
              </div>
            )}
            {!listLoading && !listErr && (
              <>
                <div className="px-4 py-2 text-xs text-gray-500 border-b">
                  Showing {filtered.length} of {courseList.length} courses
                </div>
                <ul
                  className="max-h-[70vh] overflow-auto divide-y"
                  role="list"
                  aria-label="Courses"
                >
                  {filtered.map((c) => (
                    <li key={c.course_id} className="bg-white">
                      <button
                        onClick={() => loadProfile(c.code || c.course_id)}
                        className="w-full text-left px-4 py-3 hover:bg-gray-50"
                        title="View course profile"
                      >
                        <div className="font-semibold text-emerald-700">
                          {c.code || "—"}
                        </div>
                        <div className="text-sm text-gray-700 line-clamp-1">
                          {c.title || "No title"}
                        </div>
                      </button>
                    </li>
                  ))}
                  {filtered.length === 0 && (
                    <li className="px-4 py-4 text-sm text-gray-500">
                      No courses match your filter.
                    </li>
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
              <div className="px-4 py-4 text-sm text-gray-500">
                Loading course profile…
              </div>
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
                {/* Term / Academic Year navigation (same UX as Deloading Utilization) */}
                {!!(data?.term || data?.active_term) && (
                  <div className="relative flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
                    <div className="flex flex-1 items-center justify-between gap-3">
                      <button
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
                        disabled={!data?.has_prev || loading}
                        onClick={() =>
                          loadProfile(
                            data.course_id,
                            "prev",
                            data?.term?.term_id || data?.active_term?.term_id
                          )
                        }
                        title="Previous term"
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span>Previous Term</span>
                      </button>

                      <button
                        className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
                        disabled={!data?.has_next || loading}
                        onClick={() =>
                          loadProfile(
                            data.course_id,
                            "next",
                            data?.term?.term_id || data?.active_term?.term_id
                          )
                        }
                        title="Next term"
                      >
                        <span>Next Term</span>
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>

                    <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-1">
                      <div className="inline-flex items-center rounded-full border border-emerald-100 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800 shadow-sm">
                        <span>{currentPillLabel}</span>
                        {isActiveTerm && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-emerald-200 px-2 py-0.5 text-[11px] font-semibold text-emerald-900">
                            Active
                          </span>
                        )}
                      </div>
                      {terms.length > 0 && (
                        <div className="text-xs text-gray-500">
                          {currentIndex + 1} of {terms.length}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Header: Course Code and Title */}
                <div className="bg-emerald-50 p-4 rounded-lg border border-emerald-200">
                  <h2 className="text-xl font-bold text-emerald-800">
                    {courseHeader}
                  </h2>
                  <p className="text-sm text-emerald-600">
                    Course History & Assignment Analysis
                  </p>
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
                    title="Most Recent Taught"
                    value={
                      metrics?.most_recent_taught?.acad_year_start
                        ? `${fmtAY(
                            metrics.most_recent_taught.acad_year_start
                          )} ${fmtTerm(metrics.most_recent_taught.term_number)}`
                        : "Never"
                    }
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
                      Qualified Faculty ({data.qualified_faculty?.length ?? 0}{" "}
                      Total)
                    </h3>
                    <div className="flex flex-wrap gap-2 text-sm">
                      {data.qualified_faculty?.length === 0 ? (
                        <p className="text-gray-500">None listed.</p>
                      ) : (
                        data.qualified_faculty?.map((qf) => (
                          <span key={qf.faculty_id} className="relative group">
                            <span
                              className="px-3 py-1 bg-gray-100 rounded-full text-gray-700 whitespace-nowrap cursor-help"
                              title={`${fullName(
                                qf.last_name,
                                qf.first_name
                              )} — ${qf.source || "—"}`}
                            >
                              {fullName(qf.last_name, qf.first_name)}
                            </span>
                            <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 -translate-x-1/2 opacity-0 group-hover:opacity-100">
                              <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 shadow-sm w-72 max-w-sm whitespace-normal break-words leading-relaxed text-left">
                                <QualifiedHoverContent qf={qf} />
                              </div>
                            </div>
                          </span>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Preferences (Active Term) */}
                  <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                    <h3 className="text-md font-semibold text-emerald-700 mb-3">
                      Preferences (Active Term)
                    </h3>
                    {activeTermLabel ? (
                      <p className="-mt-2 mb-3 text-xs text-gray-600">
                        {activeTermLabel}
                      </p>
                    ) : null}
                    {typeof data.preferences === "string" ? (
                      <p className="text-sm text-gray-700">
                        {data.preferences}
                      </p>
                    ) : prefsUnique.length > 0 ? (
                      <div className="flex flex-wrap gap-2 text-sm">
                        {prefsUnique.map((p) => (
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
                    {!data.past_instructors_top3 ||
                    data.past_instructors_top3.length === 0 ? (
                      <p className="text-gray-500">None listed.</p>
                    ) : (
                      <>
                        <h4 className="font-semibold text-gray-700 mb-2">
                          Top 3 Most Frequent Instructors
                        </h4>
                        <ul className="space-y-2">
                          {data.past_instructors_top3.map((pi, i) => (
                            <li
                              key={pi.faculty_id}
                              className="flex items-center justify-between p-3 bg-gray-50 rounded-md border border-gray-100"
                            >
                              <div className="flex items-center space-x-3">
                                <span
                                  className={`text-xl font-extrabold ${
                                    i === 0
                                      ? "text-yellow-600"
                                      : i === 1
                                      ? "text-slate-500"
                                      : "text-amber-700"
                                  }`}
                                >
                                  #{i + 1}
                                </span>
                                <div className="font-semibold text-gray-800">
                                  {fullName(pi.last_name, pi.first_name)}
                                </div>
                              </div>
                              <div className="text-sm text-gray-600">
                                Taught{" "}
                                <span className="font-bold text-lg text-emerald-600">
                                  {pi.count}
                                </span>{" "}
                                sections
                              </div>
                            </li>
                          ))}
                        </ul>
                        {(() => {
                          const otherCount =
                            data.past_instructors_remaining_count ||
                            (data.past_instructors_others?.length ?? 0);
                          if (!otherCount) return null;
                          return (
                            <div className="mt-3">
                              <button
                                type="button"
                                onClick={() =>
                                  setShowOtherInstructors((v) => !v)
                                }
                                className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50"
                              >
                                <span>
                                  {showOtherInstructors ? "Hide" : "Show"}{" "}
                                  {otherCount} other instructor(s)
                                </span>
                                {showOtherInstructors ? (
                                  <ChevronUp className="h-4 w-4 text-gray-600" />
                                ) : (
                                  <ChevronDown className="h-4 w-4 text-gray-600" />
                                )}
                              </button>

                              {showOtherInstructors && (
                                <div className="mt-2 max-h-64 overflow-auto rounded-md border border-gray-200 bg-white">
                                  {data.past_instructors_others &&
                                  data.past_instructors_others.length ? (
                                    <ul className="divide-y">
                                      {data.past_instructors_others.map(
                                        (pi) => (
                                          <li
                                            key={pi.faculty_id}
                                            className="flex items-center justify-between px-3 py-2"
                                          >
                                            <div className="text-sm font-medium text-gray-800">
                                              {fullName(
                                                pi.last_name,
                                                pi.first_name
                                              )}
                                            </div>
                                            <div className="text-sm text-gray-600">
                                              <span className="font-semibold text-emerald-700">
                                                {pi.count ?? 0}
                                              </span>{" "}
                                              time(s)
                                            </div>
                                          </li>
                                        )
                                      )}
                                    </ul>
                                  ) : (
                                    <div className="px-3 py-2 text-sm text-gray-500">
                                      No details available.
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}
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
