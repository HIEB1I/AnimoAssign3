// frontend/src/pages/APO/APO_PreEnlistment.tsx
import React, { useEffect, useMemo, useState } from "react";
import Papa, { type ParseResult } from "papaparse";
import { Pencil, Check, Upload } from "lucide-react";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import {
  getApoPreenlistment,
  importApoPreenlistment,
  type CountCsvRow,
  type StatCsvRow,
} from "../../api";

/* ----------------------- Page ----------------------- */
export default function APO_PreEnlistment() {
  const [enlistedCourses, setEnlistedCourses] = useState<string[][]>([]);
  const [enrollmentStats, setEnrollmentStats] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [editIndexCourses, setEditIndexCourses] = useState<number | null>(null);
  const [editRowCourses, setEditRowCourses] = useState<string[] | null>(null);
  const [editIndexStats, setEditIndexStats] = useState<number | null>(null);
  const [editRowStats, setEditRowStats] = useState<string[] | null>(null);

  const user = useMemo(() => {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null; // { userId, email, fullName, roles }
  }, []);

  const fullName = user?.fullName ?? "APO";
  const roleName = useMemo(() => {
    if (!user?.roles) return "Academic Programming Officer";
    return user.roles.includes("apo") ? "Academic Programming Officer" : user.roles[0] || "User";
  }, [user]);

  // Fetch BOTH datasets from the single GET /api/apo/preenlistment
  useEffect(() => {
    (async () => {
      if (!user?.userId) {
        setErr("Not logged in.");
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setErr(null);
        const { count, statistics } = await getApoPreenlistment(user.userId, "TERM_2025_T1");

        setEnlistedCourses(
          (count || []).map((d) => [
            d.code || "",
            d.career,
            d.acad_group,
            d.campus,
            d.course_code,
            String(d.count),
          ])
        );

        setEnrollmentStats(
          (statistics || []).map((s) => [
            s.program,
            String(s.freshman),
            String(s.sophomore),
            String(s.junior),
            String(s.senior),
          ])
        );
      } catch (e: any) {
        setErr(e?.message || "Failed to load pre-enlistment data.");
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  const refresh = async () => {
    if (!user?.userId) return;
    const { count, statistics } = await getApoPreenlistment(user.userId, "TERM_2025_T1");
    setEnlistedCourses(
      (count || []).map((d) => [
        d.code || "",
        d.career,
        d.acad_group,
        d.campus,
        d.course_code,
        String(d.count),
      ])
    );
    setEnrollmentStats(
      (statistics || []).map((s) => [
        s.program,
        String(s.freshman),
        String(s.sophomore),
        String(s.junior),
        String(s.senior),
      ])
    );
  };

  // Inline edit (unchanged)
  const startEditCourses = (i: number) => {
    setEditIndexCourses(i);
    setEditRowCourses([...(enlistedCourses[i] || [])]);
  };
  const saveEditCourses = async () => {
    if (editIndexCourses !== null && editRowCourses) {
      // 1) update local table
      const updated = [...enlistedCourses];
      updated[editIndexCourses] = editRowCourses;
      setEnlistedCourses(updated);
      setEditIndexCourses(null);
      setEditRowCourses(null);

      // 2) persist to DB: send ALL rows with replaceCount=true
      try {
        if (!user?.userId) throw new Error("Not logged in");
        const rows = updated.map((r) => ({
          Code: r[0] || "",
          Career: r[1],
          "Acad Group": r[2],
          Campus: r[3] as "MANILA" | "LAGUNA",
          "Course Code": r[4],
          Count: Number(r[5] ?? 0),
        }));
        await importApoPreenlistment(user.userId, rows, [], "TERM_2025_T1", { replaceCount: true });

        // 3) reload from server to confirm
        await refresh();
      } catch (e) {
        console.error(e);
        setErr((e as Error).message || "Failed to save");
      }
    }
  };
  const startEditStats = (i: number) => {
    setEditIndexStats(i);
    setEditRowStats([...(enrollmentStats[i] || [])]);
  };
  const saveEditStats = async () => {
    if (editIndexStats !== null && editRowStats) {
      const updated = [...enrollmentStats];
      updated[editIndexStats] = editRowStats;
      setEnrollmentStats(updated);
      setEditIndexStats(null);
      setEditRowStats(null);

      try {
        if (!user?.userId) throw new Error("Not logged in");
        const rows = updated.map((r) => ({
          Program: r[0],
          FRESHMAN: Number(r[1] ?? 0),
          SOPHOMORE: Number(r[2] ?? 0),
          JUNIOR: Number(r[3] ?? 0),
          SENIOR: Number(r[4] ?? 0),
        }));
        await importApoPreenlistment(user.userId, [], rows, "TERM_2025_T1", { replaceStats: true });
        await refresh();
      } catch (e) {
        console.error(e);
        setErr((e as Error).message || "Failed to save");
      }
    }
  };
  // CSV Import → single POST → refresh
  const handleImportCourses = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !user?.userId) return;
    Papa.parse<CountCsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results: ParseResult<CountCsvRow>) => {
        const rows = results.data.filter(
          (r) =>
            r["Course Code"] &&
            r.Career &&
            r["Acad Group"] &&
            r.Campus &&
            r.Count !== undefined
        );
        await importApoPreenlistment(user.userId, rows, [], "TERM_2025_T1", { replaceCount: true });
        await refresh();
      },
    });
  };

  const handleImportStats = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !user?.userId) return;
    Papa.parse<StatCsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results: ParseResult<StatCsvRow>) => {
        const rows = results.data.filter((r) => !!r.Program);
        await importApoPreenlistment(user.userId, [], rows, "TERM_2025_T1", { replaceStats: true });
        await refresh();
      },
    });
  };

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar fullName={fullName} role={roleName} />
      <Tabs />

      <main className="p-6 w-full">
        <div className="rounded-xl bg-white shadow-sm border border-gray-200 p-6 w-full">
          <div className="mb-3 text-sm">
            {loading && <span className="text-gray-500">Loading pre-enlistment data…</span>}
            {err && !loading && <span className="text-red-600">{err}</span>}
          </div>

          <div className="flex flex-col md:flex-row">
            {/* Left Panel - Enlisted Courses */}
            <section className="flex-1 max-h-[400px] overflow-y-auto pr-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">List of Enlisted Courses</h2>
                <label className="ml-auto inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110">
                  <Upload className="h-4 w-4" />
                  Import CSV
                  <input type="file" accept=".csv" onChange={handleImportCourses} className="hidden" />
                </label>
              </div>
              <p className="text-sm text-gray-500 mb-4">Term 1 AY 2025-2026</p>

              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs text-gray-500 border-b">
                  <tr>
                    <th className="py-2">No.</th>
                    <th className="py-2">Career</th>
                    <th className="py-2">Acad Group</th>
                    <th className="py-2">Campus</th>
                    <th className="py-2">Course Code</th>
                    <th className="py-2">Count</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody className="text-gray-700">
                  {enlistedCourses.map((row, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                      {row.map((cell, j) => (
                        <td key={j} className="py-2 px-2 whitespace-nowrap">
                          {editIndexCourses === i && j === row.length - 1 ? (
                            <input
                              value={editRowCourses?.[j] ?? ""}
                              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                const base = editRowCourses ?? [];
                                const copy = [...base];
                                copy[j] = e.target.value;
                                setEditRowCourses(copy);
                              }}
                              type="number"
                              className="w-full px-2 py-1 text-sm rounded-md border border-gray-300 focus:ring-1 focus:ring-emerald-500"
                            />
                          ) : (
                            cell
                          )}
                        </td>
                      ))}
                      <td className="py-2 px-2 text-center">
                        {editIndexCourses === i ? (
                          <button
                            onClick={saveEditCourses}
                            className="h-7 w-7 flex items-center justify-center rounded-full border border-green-600 text-green-600 hover:bg-green-50"
                            title="Save"
                          >
                            <Check className="h-4 w-4" strokeWidth={2.5} />
                          </button>
                        ) : (
                          <button
                            onClick={() => startEditCourses(i)}
                            className="text-gray-500 hover:text-black"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {/* Divider */}
            <div className="my-6 md:my-0 md:mx-6 border-t md:border-t-0 md:border-l border-gray-300"></div>

            {/* Right Panel - Enrollment Stats */}
            <section className="flex-1 max-h-[400px] overflow-y-auto pl-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">Enrollment Statistics</h2>
                <label className="ml-auto inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110">
                  <Upload className="h-4 w-4" />
                  Import CSV
                  <input type="file" accept=".csv" onChange={handleImportStats} className="hidden" />
                </label>
              </div>
              <p className="text-sm text-gray-500 mb-4">Term 1 AY 2025-2026</p>

              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs text-gray-500 border-b">
                  <tr>
                    <th className="py-2">Program</th>
                    <th className="py-2">Freshman</th>
                    <th className="py-2">Sophomore</th>
                    <th className="py-2">Junior</th>
                    <th className="py-2">Senior</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody className="text-gray-700">
                  {enrollmentStats.map((row, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                      {row.map((cell, j) => (
                        <td key={j} className="py-2 px-2 whitespace-nowrap">
                          {editIndexStats === i && j > 0 ? (
                            <input
                              value={editRowStats?.[j] ?? ""}
                              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                const base = editRowStats ?? [];
                                const copy = [...base];
                                copy[j] = e.target.value;
                                setEditRowStats(copy);
                              }}
                              type="number"
                              className="w-full px-2 py-1 text-sm rounded-md border border-gray-300 focus:ring-1 focus:ring-emerald-500"
                            />
                          ) : (
                            cell
                          )}
                        </td>
                      ))}
                      <td className="py-2 px-2 text-center">
                        {editIndexStats === i ? (
                          <button
                            onClick={saveEditStats}
                            className="h-7 w-7 flex items-center justify-center rounded-full border border-green-600 text-green-600 hover:bg-green-50"
                            title="Save"
                          >
                            <Check className="h-4 w-4" strokeWidth={2.5} />
                          </button>
                        ) : (
                          <button
                            onClick={() => startEditStats(i)}
                            className="text-gray-500 hover:text-black"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
