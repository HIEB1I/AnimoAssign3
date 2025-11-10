// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM_RP_CourseProfile.tsx
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search as SearchIcon, ChevronLeft, ChevronDown, ChevronRight } from "lucide-react";
import { fetchCourseProfile, type CMCourseRow } from "@/api";

/* -----------------------------
 * Types matching backend payload
 * ----------------------------- */
type QualifiedFaculty = {
  faculty_id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
};

type PastTeach = {
  course_code?: string[];
  section_id?: string;
  section_code?: string;
  term_id?: string;
  acad_year_start?: number;
  term_number?: number;
};

type PastInstructor = {
  faculty_id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  count?: number;
  sections: PastTeach[];
};

type SimplePref = { faculty_id: string; name?: string };

type PrefEntry = {
  faculty_id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
};

type CourseProfile = {
  course_id: string;
  course_code?: string[];
  title?: string;
  qualified_faculty?: QualifiedFaculty[];
  past_instructors?: PastInstructor[];
  preferences?: string | SimplePref[] | PrefEntry[];
};

/* -----------------------------
 * Helpers (UI-only)
 * ----------------------------- */
function joinCodes(codes?: string[]): string {
  return codes && codes.length ? codes.join(", ") : "";
}
function fmtAY(start?: number): string {
  if (typeof start !== "number") return "AY —";
  return `AY ${start}-${start + 1}`;
}
function fmtTerm(n?: number): string {
  return typeof n === "number" ? `Term ${n}` : "Term —";
}
function fullName(last?: string, first?: string) {
  const L = (last || "").trim();
  const F = (first || "").trim();
  if (!L && !F) return "—";
  if (!L) return F;
  if (!F) return L;
  return `${L}, ${F}`;
}

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
  const [open, setOpen] = useState(false); // accordion state

  // --- Fetch ALL courses on mount (default view) ---
  useEffect(() => {
    let alive = true;
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
    setOpen(false);
    setLoading(true);
    try {
      const res = await fetchCourseProfile(q);
      setData(res as CourseProfile);
      // auto-open details once loaded
      setOpen(true);
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

  return (
    <div className="w-full px-8 py-8">
      {/* Header (match TeachingHistory aesthetics) */}
      <h1 className="text-2xl font-bold mb-2">Course Profile</h1>
      <p className="text-sm text-gray-600 mb-6">
        Browse the list of courses below. Click a course to view qualified faculty, past instructors, and current-term preferences.
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

        {/* Left: course list (default visible). Right: selected course details */}
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
                <ul className="max-h-[60vh] overflow-auto divide-y" role="list" aria-label="Courses">
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

          {/* Details panel (spans remaining columns) */}
          <div className="md:col-span-2">
            {/* Status / error rows for profile */}
            {err && (
              <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">
                {err}
              </div>
            )}
            {loading && (
              <div className="px-4 py-4 text-sm text-gray-500">Loading course profile…</div>
            )}

            {/* Empty state when nothing selected yet */}
            {!loading && !err && !data && (
              <div className="px-6 py-10 text-center text-sm text-gray-500">
                Select a course on the left to view its profile.
              </div>
            )}

            {/* Accordion-style detail (default collapsed; auto-opens after load) */}
            {!loading && !err && data && (
              <ul className="divide-y" role="list">
                <li className="bg-white">
                  {/* Header row: only "CODE - Title" (click to toggle) */}
                  <button
                    onClick={() => setOpen((v) => !v)}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50"
                    aria-expanded={open}
                    aria-controls="course-details"
                  >
                    <span className="inline-flex items-center gap-2">
                      {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      <span className="font-semibold text-emerald-700">{courseHeader}</span>
                    </span>
                    <span className="text-xs text-gray-500">{open ? "Hide" : "Show"}</span>
                  </button>

                  {/* Dropdown content with the original table layout */}
                  {open && (
                    <div id="course-details" className="px-4 pb-4">
                      <div className="overflow-x-auto rounded-xl border border-gray-200">
                        <table className="min-w-full table-fixed text-sm">
                          {/* 4 evenly spaced columns */}
                          <colgroup>
                            <col style={{ width: "25%" }} />
                            <col style={{ width: "25%" }} />
                            <col style={{ width: "25%" }} />
                            <col style={{ width: "25%" }} />
                          </colgroup>

                          <tbody className="border-b border-gray-200">
                            {/* QUALIFIED FACULTY header row */}
                            <tr className="bg-gray-50">
                              <td colSpan={4} className="px-4 py-2 text-sm font-semibold text-emerald-700 border-t">
                                Qualified Faculty
                              </td>
                            </tr>

                            {/* QUALIFIED FACULTY rows */}
                            {(!data.qualified_faculty || data.qualified_faculty.length === 0) && (
                              <tr>
                                <td colSpan={4} className="px-4 py-4 text-center text-gray-500">
                                  None listed.
                                </td>
                              </tr>
                            )}
                            {data.qualified_faculty?.map((qf, i) => (
                              <tr key={`${qf.faculty_id}-${i}`} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                                <td colSpan={4} className="px-3 py-3">
                                  <div className="text-center">
                                    <div className="font-semibold text-emerald-700">
                                      {fullName(qf.last_name, qf.first_name)}
                                    </div>
                                    <div className="text-xs text-gray-600">{qf.email || "—"}</div>
                                  </div>
                                </td>
                              </tr>
                            ))}

                            {/* PAST INSTRUCTORS header row */}
                            <tr className="bg-gray-50">
                              <td colSpan={4} className="px-4 py-2 text-sm font-semibold text-emerald-700 border-t">
                                Past Instructors
                              </td>
                            </tr>

                            {/* Column labels ONLY for Past Instructors */}
                            <tr className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide border-y border-gray-200">
                              {["Name", "Section", "AY", "Term"].map((h) => (
                                <td key={h} className="px-3 py-2 text-center font-medium whitespace-nowrap">
                                  {h}
                                </td>
                              ))}
                            </tr>

                            {/* PAST INSTRUCTORS rows */}
                            {(!data.past_instructors || data.past_instructors.length === 0) && (
                              <tr>
                                <td colSpan={4} className="px-4 py-4 text-center text-gray-500">
                                  None listed.
                                </td>
                              </tr>
                            )}
                            {data.past_instructors?.flatMap((pi, idx) => {
                              const rows = (pi.sections || []).length ? pi.sections : [null];
                              return rows.map((s, i2) => {
                                const ayText = s ? fmtAY(s.acad_year_start) : "—";
                                const termText = s ? fmtTerm(s.term_number) : "—";
                                const section = s ? (s.section_code || s.section_id || "—") : "—";
                                return (
                                  <tr
                                    key={`${pi.faculty_id}-${s?.section_id ?? i2}-${idx}`}
                                    className={(idx + i2) % 2 === 0 ? "bg-white" : "bg-gray-50"}
                                  >
                                    <td className="px-3 py-2 text-center">
                                      <div className="font-semibold text-emerald-700">
                                        {fullName(pi.last_name, pi.first_name)}
                                      </div>
                                      <div className="text-xs text-gray-600">{pi.email || "—"}</div>
                                    </td>
                                    <td className="px-3 py-2 text-center">{section}</td>
                                    <td className="px-3 py-2 text-center">{ayText}</td>
                                    <td className="px-3 py-2 text-center">{termText}</td>
                                  </tr>
                                );
                              });
                            })}

                            {/* PREFERENCES header row */}
                            <tr className="bg-gray-50">
                              <td colSpan={4} className="px-4 py-2 text-sm font-semibold text-emerald-700 border-t">
                                Preferences (Current Term)
                              </td>
                            </tr>

                            {/* PREFERENCES rows */}
                            {typeof data.preferences === "string" ? (
                              <tr>
                                <td colSpan={4} className="px-4 py-4 text-sm text-gray-700 text-center">
                                  {data.preferences}
                                </td>
                              </tr>
                            ) : Array.isArray(data.preferences) ? (
                              (data.preferences as PrefEntry[]).length === 0 ? (
                                <tr>
                                  <td colSpan={4} className="px-4 py-4 text-center text-gray-500">
                                    N/A
                                  </td>
                                </tr>
                              ) : (
                                (data.preferences as PrefEntry[]).map((p, i) => (
                                  <tr key={`${p.faculty_id}-${i}`} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                                    <td colSpan={4} className="px-3 py-3">
                                      <div className="text-center">
                                        <div className="font-semibold text-emerald-700">
                                          {fullName(p.last_name, p.first_name)}
                                        </div>
                                        <div className="text-xs text-gray-600">{p.email || "—"}</div>
                                      </div>
                                    </td>
                                  </tr>
                                ))
                              )
                            ) : null}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </li>
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
