// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM_RP_CourseProfile.tsx
import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search as SearchIcon, ChevronLeft } from "lucide-react";
import { fetchCourseProfile } from "@/api";

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
  const [data, setData] = useState<CourseProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setData(null);

    const q = query.trim();
    if (!q) {
      setErr("Enter a course ID or course code (e.g., NSCOM01).");
      return;
    }

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

  const courseHeader = useMemo(() => {
    const code = (data?.course_code?.length ? joinCodes(data.course_code) : data?.course_id) ?? "";
    const title = data?.title || "No title listed";
    // REQUIRED FORMAT: "COURSE CODE - Course Title"
    return `${code || "—"} - ${title || "—"}`;
  }, [data]);

  return (
    <div className="w-full px-8 py-8">
      {/* Header (match TeachingHistory aesthetics) */}
      <h1 className="text-2xl font-bold mb-2">Course Profile</h1>
      <p className="text-sm text-gray-600 mb-6">
        View courses and the faculty who previously taught them.
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
                placeholder="Enter course code…"
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
        {err && (
          <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">
            {err}
          </div>
        )}
        {loading && <div className="px-4 py-4 text-sm text-gray-500">Loading…</div>}

        {/* Empty state */}
        {!loading && !err && !data && (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            No results yet. Enter a course ID or course code to search.
          </div>
        )}

        {/* ONE unified table for all sections */}
        {!loading && !err && data && (
          <div className="overflow-x-auto">
            <table className="min-w-full table-fixed text-sm">
              {/* 4 evenly spaced columns */}
              <colgroup>
                <col style={{ width: "25%" }} />
                <col style={{ width: "25%" }} />
                <col style={{ width: "25%" }} />
                <col style={{ width: "25%" }} />
              </colgroup>

              <thead>
                {/* COURSE CODE - Course Title (CENTERED) */}
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th colSpan={4} className="px-4 py-3 text-center text-emerald-700 font-semibold">
                    {courseHeader}
                  </th>
                </tr>
              </thead>

              <tbody className="border-b border-gray-200">
                {/* QUALIFIED FACULTY header row */}
                <tr className="bg-gray-50">
                  <td colSpan={4} className="px-4 py-2 text-sm font-semibold text-emerald-700 border-t">
                    Qualified Faculty
                  </td>
                </tr>

                {/* QUALIFIED FACULTY rows — NOT divided by columns */}
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

                {/* PAST INSTRUCTORS rows (Name + email under; Section/AY/Term filled) */}
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

                {/* PREFERENCES rows (no column labels here; show name+email centered) */}
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
        )}
      </div>
    </div>
  );
}
