import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";

import Tabs from "../../component/Tabs";


import TopBar from "../../component/TopBar";
import {
  getStudentCourseOfferingsOptions,
  searchStudentCourseOfferings,
  type StudentCourseOfferingsOptions,
  type CourseOfferingsSearchPayload,
  type CourseOfferingsSearchResponse,
} from "../../api";

/* ---------------- Local Types ---------------- */
type UserData = { userId: string; fullName: string; roles?: string[] };

function dayLabel(d?: string) {
  if (!d) return "—";
  return String(d).toUpperCase();
}

function fmtTime(t?: string) {
  if (!t) return "—";
  const raw = String(t).trim().replace(":", "");
  const n = raw.padStart(4, "0");
  if (!/^\d{4}$/.test(n)) return "—";
  return `${n.slice(0, 2)}${n.slice(2)}`; // show like 0730
}

function termHeader(term?: { acad_year_start?: number | string; term_number?: number | string }) {
  const ay = Number.parseInt(String(term?.acad_year_start ?? ""), 10);
  const tn = term?.term_number;
  if (!Number.isFinite(ay) || !tn) return "";
  return `Term ${tn} · AY ${ay}-${ay + 1}`;
}

export default function STUDENT_CourseOfferings() {
  const user: UserData | null = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("animo.user") || "null");
    } catch {
      return null;
    }
  }, []);
  const userId = user?.userId ?? null;
  const fullName = user?.fullName ?? "Student";

  const [options, setOptions] = useState<StudentCourseOfferingsOptions>({
    ok: false,
    term: undefined,
    courses: [],
  });

  const [courseInput, setCourseInput] = useState("");

  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  // must stay null until user searches
  const [result, setResult] = useState<CourseOfferingsSearchResponse | null>(null);

  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        setLoading(true);
        const opt = await getStudentCourseOfferingsOptions(userId);
        setOptions(opt);
      } catch (e: any) {
        setError(e?.response?.data?.detail || e?.message || "Failed to load course offerings.");
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]);

  const doSearch = async () => {
    if (!userId) {
      setError("User not logged in.");
      return;
    }
    const code = courseInput.trim().toUpperCase();
    if (!code) {
      setError("Please enter a course code.");
      return;
    }

    try {
      setSearching(true);
      setError("");
      const payload: CourseOfferingsSearchPayload = { courseCode: code };
      const res = await searchStudentCourseOfferings(userId, payload);
      setResult(res);
    } catch (e: any) {
      setResult(null);
      setError(e?.response?.data?.detail || e?.message || "Search failed.");
    } finally {
      setSearching(false);
    }
  };

  const clear = () => {
    setCourseInput("");
    setResult(null);
    setError("");
  };

  const termPill = termHeader(options.term);

  const visibleSections = useMemo(() => {
    if (!result?.sections?.length) return [];

    // Hide Special Class and Dissolved sections from regular Course Offerings.
    return result.sections.filter((s) => {
      const r = String(s.remarks || "").toUpperCase();
      return !r.includes("SPECIAL CLASS") && !r.includes("DISSOLVED");
    });
  }, [result]);

  return (
    <div className="min-h-screen w-full bg-white text-slate-900">
      <TopBar fullName={fullName} role="Student" inboxPath="/student/inbox" />

      <Tabs
        mode="nav"
        items={[
          { label: "Course Offerings", to: "/student/courseofferings" },
          { label: "Class Petition", to: "/student/petition" },
          { label: "Special Class", to: "/student/specialclass" },
        ]}
      />

      <main className="p-6 max-w-7xl mx-auto">
        <section className="w-full rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          {/* header row */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-xl font-bold">Course Offerings</h2>
              {termPill ? (
                <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                  {termPill}
                </span>
              ) : null}
            </div>
          </div>

          <p className="mt-2 text-sm text-gray-600">
            Search a course to view available sections, schedules, and assigned faculty.
          </p>

          {error && (
            <div className="mt-4 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          {loading ? (
            <div className="mt-4 text-sm text-gray-500">Loading…</div>
          ) : (
            <>
              {/* search row (aligned) */}
              <div className="mt-5">
                <label className="block text-sm font-semibold text-emerald-700 mb-2">
                  Course Code
                </label>

                <div className="grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-center">
                  <input
                    value={courseInput}
                    onChange={(e) => setCourseInput(e.target.value)}
                    placeholder="Type a course code"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                  />

                  <button
                    onClick={doSearch}
                    disabled={searching}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#21804A] px-5 py-2 text-sm font-medium text-white hover:bg-[#18693B] disabled:opacity-60"
                  >
                    <Search className="h-4 w-4" />
                    {searching ? "Searching…" : "Search"}
                  </button>

                  <button
                    onClick={clear}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* results */}
              <div className="mt-6">
                {!result ? (
                  <div className="text-sm text-gray-500">
                    
                  </div>
                ) : visibleSections.length === 0 ? (
                  <div className="text-sm text-gray-500">
                    {result.sections.length > 0 ? (
                      <>
                        Only <span className="font-medium">Special Class</span> sections are available for{" "}
                        <span className="font-semibold">{result.course?.course_code}</span>. 
                      </>
                    ) : (
                      <>
                        No sections found for{" "}
                        <span className="font-semibold">{result.course?.course_code}</span>.
                      </>
                    )}
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr className="text-left text-gray-700">
                          <th className="px-3 py-2 border-b">Section</th>
                          <th className="px-3 py-2 border-b">Day/s & Time</th>
                          <th className="px-3 py-2 border-b">Room</th>
                          <th className="px-3 py-2 border-b">Faculty</th>
                          <th className="px-3 py-2 border-b">Remarks</th>
                        </tr>
                      </thead>

                      <tbody>
                        {visibleSections.map((s, idx) => {
                          const rowBg = idx % 2 === 0 ? "bg-white" : "bg-gray-50";
                          return (
                            <tr key={s.section_id} className={`${rowBg} hover:bg-emerald-50/40`}>
                              <td className="px-3 py-2 border-b">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold">{s.section_code}</span>
                                </div>
                              </td>

                              <td className="px-3 py-2 border-b align-top">
                                {s.schedules?.length ? (
                                  <div className="space-y-1">
                                    {s.schedules.map((sc, i) => (
                                      <div key={i} className="leading-tight">
                                        <span className="font-medium">{dayLabel(sc.day)}</span>{" "}
                                        {fmtTime(sc.start_time)} - {fmtTime(sc.end_time)}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-gray-400">—</span>
                                )}
                              </td>

                              <td className="px-3 py-2 border-b align-top">
                                {s.schedules?.length ? (
                                  <div className="space-y-1">
                                    {s.schedules.map((sc, i) => (
                                      <div key={i}>
                                        {String(sc.room_number || "").trim() ? (
                                          sc.room_number
                                        ) : (
                                          <span className="text-gray-800">TBA</span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-gray-400">—</span>
                                )}
                              </td>

                              <td className="px-3 py-2 border-b">
                                {s.faculty_name?.trim() ? (
                                  s.faculty_name
                                ) : (
                                  <span className="text-gray-400">UNASSIGNED</span>
                                )}
                              </td>

                              <td className="px-3 py-2 border-b">
                                {s.remarks?.trim() ? s.remarks : <span className="text-gray-400">—</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}