// frontend/src/pages/APO/APO_PreEnlistment.tsx
import React, { useEffect, useMemo, useState } from "react";
import Papa, { type ParseResult } from "papaparse";
import { Pencil, Check, Upload, Archive } from "lucide-react";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import SelectBox from "../../component/SelectBox";
import {
  getApoPreenlistment,
  importApoPreenlistment,
  archiveApoPreenlistment,
  getApoPreenlistmentMeta,
  type CountCsvRow,
  type StatCsvRow,
  type PreenlistmentCountDoc,
  type PreenlistmentStatDoc,
  type TermMeta,
  type ArchiveMetaItem,
} from "../../api";

export default function APO_PreEnlistment() {
  const [view, setView] = useState<"active" | "archives">("active");

  const [activeMeta, setActiveMeta] = useState<TermMeta | null>(null);
  const [enlistedCourses, setEnlistedCourses] = useState<string[][]>([]);
  const [enrollmentStats, setEnrollmentStats] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

  const [editIndexCourses, setEditIndexCourses] = useState<number | null>(null);
  const [editRowCourses, setEditRowCourses] = useState<string[] | null>(null);
  const [editIndexStats, setEditIndexStats] = useState<number | null>(null);
  const [editRowStats, setEditRowStats] = useState<string[] | null>(null);

  const [archiveTerms, setArchiveTerms] = useState<ArchiveMetaItem[]>([]);
  const [archiveTermId, setArchiveTermId] = useState<string>("");
  const [archiveCount, setArchiveCount] = useState<string[][]>([]);
  const [archiveStats, setArchiveStats] = useState<string[][]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);

  const user = useMemo(() => {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null;
  }, []);
  const fullName = user?.fullName ?? "APO";
  const roleName = useMemo(() => {
    if (!user?.roles) return "Academic Programming Officer";
    return user.roles.includes("apo") ? "Academic Programming Officer" : user.roles[0] || "User";
  }, [user]);

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
        await refresh();
      } catch (e: any) {
        setErr(e?.message || "Failed to load pre-enlistment data.");
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  const headerLabel = activeMeta ? `Term ${activeMeta.term_number ?? ""} ${activeMeta.ay_label}` : "";
  const campusLabel = activeMeta?.campus_label ? activeMeta.campus_label : "";

  const refresh = async () => {
    if (!user?.userId) return;
    const { count, statistics, meta } = await getApoPreenlistment(user.userId, undefined, "active");

    setActiveMeta((meta as TermMeta) ?? null);

    setEnlistedCourses(
      (count ?? ([] as PreenlistmentCountDoc[])).map((d) => [
        d.preenlistment_code || "",
        d.career,
        d.acad_group,
        d.campus_name,
        d.course_code,
        String(d.count),
      ])
    );
    setEnrollmentStats(
      (statistics ?? ([] as PreenlistmentStatDoc[])).map((s) => [
        s.program_code,
        String(s.freshman),
        String(s.sophomore),
        String(s.junior),
        String(s.senior),
      ])
    );
  };

  const startEditCourses = (i: number) => {
    setEditIndexCourses(i);
    setEditRowCourses([...(enlistedCourses[i] || [])]);
  };
  const saveEditCourses = async () => {
    if (editIndexCourses !== null && editRowCourses) {
      const updated = [...enlistedCourses];
      updated[editIndexCourses] = editRowCourses;
      setEnlistedCourses(updated);
      setEditIndexCourses(null);
      setEditRowCourses(null);

      try {
        if (!user?.userId) throw new Error("Not logged in");
        const rows: CountCsvRow[] = updated.map((r) => ({
          Code: r[0] || "",
          Career: r[1],
          "Acad Group": r[2],
          Campus: r[3] as "MANILA" | "LAGUNA",
          "Course Code": r[4],
          Count: Number(r[5] ?? 0),
        }));
        await importApoPreenlistment(user.userId, rows, [], undefined, { replaceCount: true });
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
        const rows: StatCsvRow[] = updated.map((r) => ({
          Program: r[0],
          FRESHMAN: Number(r[1] ?? 0),
          SOPHOMORE: Number(r[2] ?? 0),
          JUNIOR: Number(r[3] ?? 0),
          SENIOR: Number(r[4] ?? 0),
        }));
        await importApoPreenlistment(user.userId, [], rows, undefined, { replaceStats: true });
        await refresh();
      } catch (e) {
        console.error(e);
        setErr((e as Error).message || "Failed to save");
      }
    }
  };

  const handleImportCourses = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !user?.userId) return;
    Papa.parse<CountCsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results: ParseResult<CountCsvRow>) => {
        const rows = results.data.filter(
          (r) => r["Course Code"] && r.Career && r["Acad Group"] && r.Campus && r.Count !== undefined
        );
        await importApoPreenlistment(user.userId, rows, [], undefined, { replaceCount: true });
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
        await importApoPreenlistment(user.userId, [], rows, undefined, { replaceStats: true });
        await refresh();
      },
    });
  };

  const moveToArchives = async () => {
    if (!user?.userId) return;
    const label = activeMeta ? `Term ${activeMeta.term_number ?? ""} ${activeMeta.ay_label}` : "current term";
    if (!confirm(`Archive ${label}? This will snapshot active rows and advance to the next term.`)) return;
    try {
      setArchiving(true);
      await archiveApoPreenlistment(user.userId);
      await refresh();
    } catch (e: any) {
      setErr(e?.message || "Failed to archive.");
    } finally {
      setArchiving(false);
    }
  };

  const labelForTerm = (t: ArchiveMetaItem) => `${t.term_id} · ${t.ay_label}`;
  const labelToTid = (label: string) => label.split(" · ")[0] || "";

  const goToArchives = async () => {
    if (!user?.userId) return;
    setView("archives");
    setArchiveLoading(true);
    try {
      const { archives } = await getApoPreenlistmentMeta(user.userId);
      setArchiveTerms(archives);
      const firstTid = archives[0]?.term_id ?? "";
      setArchiveTermId(firstTid);
      if (firstTid) {
        const { count, statistics } = await getApoPreenlistment(user.userId, firstTid, "archive");
        setArchiveCount(
          (count ?? ([] as PreenlistmentCountDoc[])).map((d) => [
            d.career,
            d.acad_group,
            d.campus_name,
            d.course_code,
            String(d.count),
          ])
        );
        setArchiveStats(
          (statistics ?? ([] as PreenlistmentStatDoc[])).map((s) => [
            s.program_code,
            String(s.freshman),
            String(s.sophomore),
            String(s.junior),
            String(s.senior),
          ])
        );
      } else {
        setArchiveCount([]);
        setArchiveStats([]);
      }
    } finally {
      setArchiveLoading(false);
    }
  };

  const changeArchiveTerm = async (tidOrLabel: string) => {
    if (!user?.userId) return;
    const tid = tidOrLabel.includes(" · ") ? labelToTid(tidOrLabel) : tidOrLabel;
    setArchiveTermId(tid);
    setArchiveLoading(true);
    try {
      const { count, statistics } = await getApoPreenlistment(user.userId, tid, "archive");
      setArchiveCount(
        (count ?? ([] as PreenlistmentCountDoc[])).map((d) => [
          d.career,
          d.acad_group,
          d.campus_name,
          d.course_code,
          String(d.count),
        ])
      );
      setArchiveStats(
        (statistics ?? ([] as PreenlistmentStatDoc[])).map((s) => [
          s.program_code,
          String(s.freshman),
          String(s.sophomore),
          String(s.junior),
          String(s.senior),
        ])
      );
    } finally {
      setArchiveLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar fullName={fullName} role={campusLabel ? `${roleName} | ${campusLabel}` : roleName} />
      <Tabs
        mode="nav"
        items={[
          { label: "Pre-Enlistment", to: "/apo/preenlistment" },
          { label: "Course Offerings", to: "/apo/courseofferings" },
          { label: "Room Allocation", to: "/apo/roomallocation" },
        ]}
      />

      <main className="p-6 w-full">
        <div className="mb-3 flex items-center gap-2">
          <button
            className={`rounded-md px-3 py-2 text-sm border ${
              view === "active" ? "bg-white border-gray-300 shadow-sm" : "bg-transparent border-transparent text-gray-500"
            }`}
            onClick={() => setView("active")}
          >
            Active
          </button>

          <button
            className={`rounded-md px-3 py-2 text-sm border ${
              view === "archives" ? "bg-white border-gray-300 shadow-sm" : "bg-transparent border-transparent text-gray-500"
            }`}
            onClick={goToArchives}
          >
            Archived Data
          </button>

          {view === "active" && (
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={moveToArchives}
                disabled={archiving}
                className="inline-flex items-center gap-2 rounded-md border border-red-300 text-red-700 hover:bg-red-50 px-3 py-2 text-sm"
                title="Snapshot and advance term"
              >
                <Archive className="h-4 w-4" />
                Move to Archives
              </button>
            </div>
          )}
        </div>

        {view === "active" && (
          <div className="rounded-xl bg-white shadow-sm border border-gray-200 p-6 w-full">
            <div className="mb-3 text-sm">
              {loading && <span className="text-gray-500">Loading pre-enlistment data…</span>}
              {err && !loading && <span className="text-red-600">{err}</span>}
            </div>

            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold">Pre-Enlistment</h2>
                <p className="text-sm text-gray-500">{headerLabel}</p>
              </div>
            </div>

            <div className="flex flex-col md:flex-row">
              {/* left */}
              <section className="flex-1 max-h-[400px] overflow-y-auto pr-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-base font-semibold">List of Enlisted Courses</h3>
                  <label className="inline-flex items-center gap-2 rounded-md bg-[#008e4e] px-4 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110">
                    <Upload className="h-4 w-4" />
                    Import CSV
                    <input type="file" accept=".csv" onChange={handleImportCourses} className="hidden" />
                  </label>
                </div>
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
                            <button onClick={() => startEditCourses(i)} className="text-gray-500 hover:text-black" title="Edit count">
                              <Pencil className="h-4 w-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {enlistedCourses.length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-gray-500">
                          No rows yet — import a CSV.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>

              <div className="my-6 md:my-0 md:mx-6 border-t md:border-t-0 md:border-l border-gray-300"></div>

              {/* right */}
              <section className="flex-1 max-h-[400px] overflow-y-auto pl-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-base font-semibold">Enrollment Statistics</h3>
                  <label className="inline-flex items-center gap-2 rounded-md bg-[#008e4e] px-4 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110">
                    <Upload className="h-4 w-4" />
                    Import CSV
                    <input type="file" accept=".csv" onChange={handleImportStats} className="hidden" />
                  </label>
                </div>
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
                            <button onClick={() => startEditStats(i)} className="text-gray-500 hover:text-black" title="Edit stats">
                              <Pencil className="h-4 w-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {enrollmentStats.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-gray-500">
                          No rows yet — import a CSV.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>
            </div>
          </div>
        )}

        {view === "archives" && (
          <div className="rounded-xl bg-white shadow-sm border border-gray-200 p-6 w-full">
            <div className="mb-4 flex items-center gap-3">
              <h3 className="text-lg font-semibold">Archived Data</h3>

              <div className="ml-6 flex items-center gap-3">
                <label className="text-sm text-gray-600">Term / AY</label>
                <SelectBox
                  value={
                    archiveTermId && archiveTerms.length
                      ? `${archiveTerms.find(x => x.term_id === archiveTermId)!.term_id} · ${
                          archiveTerms.find(x => x.term_id === archiveTermId)!.ay_label
                        }`
                      : ""
                  }
                  onChange={(label) => changeArchiveTerm(label)}
                  options={archiveTerms.map((t) => `${t.term_id} · ${t.ay_label}`)}
                  placeholder="— Select Term —"
                  className="w-[280px]"
                  disabled={archiveLoading}
                />
                {archiveLoading && <span className="text-sm text-gray-500">Loading…</span>}
              </div>

              <div className="ml-auto">
                <button
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-gray-50"
                  onClick={() => setView("active")}
                >
                  Back to Active
                </button>
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              <div className="border rounded-lg overflow-hidden">
                <div className="px-4 py-2 border-b font-medium bg-gray-50">List of Enlisted Courses</div>
                <div className="max-h-[420px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-gray-500 border-b">
                      <tr>
                        <th className="py-2 px-2">Career</th>
                        <th className="py-2 px-2">Acad Group</th>
                        <th className="py-2 px-2">Campus</th>
                        <th className="py-2 px-2">Course Code</th>
                        <th className="py-2 px-2 text-right">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {archiveCount.map((r, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-2 px-2">{r[0]}</td>
                          <td className="py-2 px-2">{r[1]}</td>
                          <td className="py-2 px-2">{r[2]}</td>
                          <td className="py-2 px-2">{r[3]}</td>
                          <td className="py-2 px-2 text-right">{r[4]}</td>
                        </tr>
                      ))}
                      {archiveCount.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-gray-500">
                            No data.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="border rounded-lg overflow-hidden">
                <div className="px-4 py-2 border-b font-medium bg-gray-50">Enrollment Statistics</div>
                <div className="max-h-[420px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-gray-500 border-b">
                      <tr>
                        <th className="py-2 px-2">Program</th>
                        <th className="py-2 px-2 text-right">Freshman</th>
                        <th className="py-2 px-2 text-right">Sophomore</th>
                        <th className="py-2 px-2 text-right">Junior</th>
                        <th className="py-2 px-2 text-right">Senior</th>
                      </tr>
                    </thead>
                    <tbody>
                      {archiveStats.map((r, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="py-2 px-2">{r[0]}</td>
                          <td className="py-2 px-2 text-right">{r[1]}</td>
                          <td className="py-2 px-2 text-right">{r[2]}</td>
                          <td className="py-2 px-2 text-right">{r[3]}</td>
                          <td className="py-2 px-2 text-right">{r[4]}</td>
                        </tr>
                      ))}
                      {archiveStats.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-gray-500">
                            No data.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
