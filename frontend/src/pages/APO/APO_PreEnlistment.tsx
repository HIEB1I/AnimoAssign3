import React, { useEffect, useMemo, useState } from "react";
import Papa, { type ParseResult } from "papaparse";
import { Pencil, Check, Upload, Archive, Download } from "lucide-react";
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
  campusFromRoles,
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

  const archiveLabel = (t: ArchiveMetaItem) => `Term ${t.term_number ?? "—"} · ${t.ay_label}`;

  const user = useMemo(() => {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null;
  }, []);
  const fullName = user?.fullName ?? "APO";
  const campusName = campusFromRoles(user?.roles || []); // "MANILA" | "LAGUNA" | null
  const roleName = useMemo(() => {
    if (!user?.roles) return "Academic Programming Officer";
    return (user.roles as string[]).some((r) => /^apo\b/i.test(r))
      ? "Academic Programming Officer"
      : user.roles[0] || "User";
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.userId, campusName]);

  const headerLabel = activeMeta ? `Term ${activeMeta.term_number ?? ""} ${activeMeta.ay_label}` : "";
  const campusLabel = activeMeta?.campus_label
    ? activeMeta.campus_label
    : campusName === "MANILA"
    ? "Manila"
    : campusName === "LAGUNA"
    ? "Laguna"
    : "";

  const normalizeProgramCode = (s: PreenlistmentStatDoc) =>
    (s as any).program_code ?? (s as any)?.programs?.program_code ?? "";

  const refresh = async () => {
    if (!user?.userId) return;
    const { count, statistics, meta } = await getApoPreenlistment(
      user.userId,
      undefined,
      "active",
      campusName || undefined
    );

    setActiveMeta((meta as TermMeta) ?? null);

    // IMPORTANT: we read `.count` which backend guarantees from `preenlistment_count`
    setEnlistedCourses(
      (count ?? ([] as PreenlistmentCountDoc[])).map((d) => [
        d.preenlistment_code || "",
        d.career || "",                                  // UGB / GSM as-is
        (d as any).acad_group || "",                     // CSV 'Acad Group' or college_code fallback
        d.campus_name || "",
        d.course_code || "",
        String((d as any).count ?? 0),
      ])
    );

    setEnrollmentStats(
      (statistics ?? ([] as PreenlistmentStatDoc[])).map((s) => [
        normalizeProgramCode(s),
        String(s.freshman ?? 0),
        String(s.sophomore ?? 0),
        String(s.junior ?? 0),
        String(s.senior ?? 0),
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
          Career: r[1],                 // keep UGB/GSM for display
          "Acad Group": r[2],           // keep CSV code for display
          Campus: (r[3] as "MANILA" | "LAGUNA") || (campusName as "MANILA" | "LAGUNA"),
          "Course Code": r[4],
          Count: Number(r[5] ?? 0),
        }));
        await importApoPreenlistment(
          user.userId,
          rows,
          [],
          undefined,
          { replaceCount: true },
          campusName || undefined
        );
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
        await importApoPreenlistment(
          user.userId,
          [],
          rows,
          undefined,
          { replaceStats: true },
          campusName || undefined
        );
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
        const rows = results.data
          .map((r) => {
            if (!r.Campus && campusName) (r as any).Campus = campusName;
            return r;
          })
          .filter((r) => r["Course Code"] && r.Career && r.Campus && r.Count !== undefined);
        await importApoPreenlistment(
          user.userId,
          rows,
          [],
          undefined,
          { replaceCount: true },
          campusName || undefined
        );
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
        await importApoPreenlistment(
          user.userId,
          [],
          rows,
          undefined,
          { replaceStats: true },
          campusName || undefined
        );
        await refresh();
      },
    });
  };

  const [archiveCountTotal, setArchiveCountTotal] = useState(0);
  const [archiveStatsTotals, setArchiveStatsTotals] = useState([0, 0, 0, 0]);

  const calcArchiveTotals = (countRows: string[][], statRows: string[][]) => {
    setArchiveCountTotal(countRows.reduce((sum, r) => sum + (parseInt(r[4] as string, 10) || 0), 0));
    const sums = [0, 0, 0, 0];
    statRows.forEach((r) => {
      sums[0] += parseInt(r[1] as string, 10) || 0;
      sums[1] += parseInt(r[2] as string, 10) || 0;
      sums[2] += parseInt(r[3] as string, 10) || 0;
      sums[3] += parseInt(r[4] as string, 10) || 0;
    });
    setArchiveStatsTotals(sums);
  };

  const moveToArchives = async () => {
    if (!user?.userId) return;
    const label = activeMeta ? `Term ${activeMeta.term_number ?? ""} ${activeMeta.ay_label}` : "current term";
    if (!confirm(`Archive ${label}? This will snapshot active rows for your campus and may advance the term.`)) return;
    try {
      setArchiving(true);
      await archiveApoPreenlistment(user.userId, undefined, campusName || undefined);
      await refresh();
    } catch (e: any) {
      setErr(e?.message || "Failed to archive.");
    } finally {
      setArchiving(false);
    }
  };

  const goToArchives = async () => {
    if (!user?.userId) return;
    setView("archives");
    setArchiveLoading(true);
    try {
      const { archives } = await getApoPreenlistmentMeta(user.userId, campusName || undefined);
      setArchiveTerms(archives);
      const firstTid = archives[0]?.term_id ?? "";
      setArchiveTermId(firstTid);
      if (firstTid) {
        const { count, statistics } = await getApoPreenlistment(
          user.userId,
          firstTid,
          "archive",
          campusName || undefined
        );
        const countRows = (count ?? ([] as PreenlistmentCountDoc[])).map((d) => [
          d.career || "",
          (d as any).acad_group || "",
          d.campus_name || "",
          d.course_code || "",
          String((d as any).count ?? 0),
        ]);
        const statRows = (statistics ?? ([] as PreenlistmentStatDoc[])).map((s) => [
          normalizeProgramCode(s),
          String(s.freshman ?? 0),
          String(s.sophomore ?? 0),
          String(s.junior ?? 0),
          String(s.senior ?? 0),
        ]);
        setArchiveCount(countRows);
        setArchiveStats(statRows);
        calcArchiveTotals(countRows, statRows);
      } else {
        setArchiveCount([]);
        setArchiveStats([]);
        calcArchiveTotals([], []);
      }
    } finally {
      setArchiveLoading(false);
    }
  };

  const changeArchiveTerm = async (label: string) => {
    if (!user?.userId) return;
    const picked = archiveTerms.find((t) => archiveLabel(t) === label);
    const tid = picked?.term_id ?? "";
    setArchiveTermId(tid);
    setArchiveLoading(true);
    try {
      const { count, statistics } = await getApoPreenlistment(
        user.userId,
        tid,
        "archive",
        campusName || undefined
      );
      const countRows = (count ?? ([] as PreenlistmentCountDoc[])).map((d) => [
        d.career || "",
        (d as any).acad_group || "",
        d.campus_name || "",
        d.course_code || "",
        String((d as any).count ?? 0),
      ]);
      const statRows = (statistics ?? ([] as PreenlistmentStatDoc[])).map((s) => [
        normalizeProgramCode(s),
        String(s.freshman ?? 0),
        String(s.sophomore ?? 0),
        String(s.junior ?? 0),
        String(s.senior ?? 0),
      ]);
      setArchiveCount(countRows);
      setArchiveStats(statRows);
      calcArchiveTotals(countRows, statRows);
    } finally {
      setArchiveLoading(false);
    }
  };

  const exportCsv = (filename: string, headers: string[], rows: (string | number)[][]) => {
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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
            className={`rounded-md px-3 py-2 text-sm border ${view === "active" ? "bg-white border-gray-300 shadow-sm" : "bg-transparent border-transparent text-gray-500"}`}
            onClick={() => setView("active")}
          >
            Active
          </button>

          <button
            className={`rounded-md px-3 py-2 text-sm border ${view === "archives" ? "bg-white border-gray-300 shadow-sm" : "bg-transparent border-transparent text-gray-500"}`}
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
              <section className="flex-1 max-h-[420px] overflow-y-auto pr-4">
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
                        <td className="py-2 px-2">{i + 1}</td>
                        {row.slice(1).map((cell, j) => (
                          <td key={j} className="py-2 px-2 whitespace-nowrap">
                            {editIndexCourses === i && j === row.length - 2 ? (
                              <input
                                value={editRowCourses?.[j + 1] ?? ""}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                  const copy = [...(editRowCourses ?? [])];
                                  copy[j + 1] = e.target.value;
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
                              title="Edit count"
                            >
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
              <section className="flex-1 max-h-[420px] overflow-y-auto pl-4">
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
                                  const copy = [...(editRowStats ?? [])];
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
                              title="Edit stats"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {enrollmentStats.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-gray-500">
                          No data.
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
          <div className="rounded-2xl bg-white shadow-sm border border-neutral-200 p-6 w-full">
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <h3 className="text-lg font-semibold">Archived Data</h3>

              <div className="ml-6 flex items-center gap-3">
                <label className="text-sm text-gray-600">Term / AY</label>
                <SelectBox
                  value={
                    archiveTermId && archiveTerms.length
                      ? archiveLabel(archiveTerms.find((x) => x.term_id === archiveTermId)!)
                      : ""
                  }
                  onChange={(label) => changeArchiveTerm(label)}
                  options={archiveTerms.map(archiveLabel)}
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
              {/* Enlisted Courses */}
              <div className="border rounded-xl overflow-hidden shadow-[0_1px_10px_-6px_rgba(0,0,0,0.25)]">
                <div className="flex items-center justify-between gap-3 px-4 py-2 border-b bg-neutral-50/70">
                  <div className="font-medium text-neutral-800">List of Enlisted Courses</div>
                  <button
                    onClick={() => {
                      const sel = archiveTerms.find(t => t.term_id === archiveTermId);
                      const base = sel
                        ? `Term-${sel.term_number ?? "—"}_${sel.ay_label.replaceAll(" ", "-")}`
                        : (archiveTermId || "term");
                      exportCsv(
                        `${base}-courses.csv`,
                        ["Career", "Acad Group", "Campus", "Course Code", "Count"],
                        archiveCount
                      );
                    }}
                    className="inline-flex items-center gap-2 rounded-md border border-neutral-300 bg-white/80 px-3 py-1.5 text-sm hover:bg-neutral-50"
                    title="Export CSV"
                  >
                    <Download className="h-4 w-4" />
                    Export
                  </button>
                </div>

                <div className="max-h-[460px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur text-left text-xs text-neutral-500 border-b">
                      <tr>
                        <th className="py-2.5 px-3">Career</th>
                        <th className="py-2.5 px-3">Acad Group</th>
                        <th className="py-2.5 px-3">Campus</th>
                        <th className="py-2.5 px-3">Course Code</th>
                        <th className="py-2.5 px-3 text-right">Count</th>
                      </tr>
                    </thead>
                    <tbody className="text-neutral-800">
                      {archiveCount.map((r, i) => (
                        <tr
                          key={i}
                          className="border-b last:border-0 odd:bg-white even:bg-neutral-50/60 hover:bg-emerald-50/40 transition-colors"
                        >
                          <td className="py-2.5 px-3">{r[0]}</td>
                          <td className="py-2.5 px-3">{r[1]}</td>
                          <td className="py-2.5 px-3">{r[2]}</td>
                          <td className="py-2.5 px-3">{r[3]}</td>
                          <td className="py-2.5 px-3 text-right tabular-nums">{r[4]}</td>
                        </tr>
                      ))}
                      {archiveCount.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-gray-500">
                            No data.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="px-4 py-2 text-sm text-neutral-700 border-t bg-neutral-50/70">
                  Total Count: <strong className="tabular-nums">{archiveCountTotal}</strong>
                </div>
              </div>

              {/* Enrollment Statistics */}
              <div className="border rounded-xl overflow-hidden shadow-[0_1px_10px_-6px_rgba(0,0,0,0.25)]">
                <div className="flex items-center justify-between gap-3 px-4 py-2 border-b bg-neutral-50/70">
                  <div className="font-medium text-neutral-800">Enrollment Statistics</div>
                  <button
                    onClick={() => {
                      const sel = archiveTerms.find(t => t.term_id === archiveTermId);
                      const base = sel
                        ? `Term-${sel.term_number ?? "—"}_${sel.ay_label.replaceAll(" ", "-")}`
                        : (archiveTermId || "term");
                      exportCsv(
                        `${base}-stats.csv`,
                        ["Program", "Freshman", "Sophomore", "Junior", "Senior"],
                        archiveStats
                      );
                    }}
                    className="inline-flex items-center gap-2 rounded-md border border-neutral-300 bg-white/80 px-3 py-1.5 text-sm hover:bg-neutral-50"
                    title="Export CSV"
                  >
                    <Download className="h-4 w-4" />
                    Export
                  </button>
                </div>

                <div className="max-h-[460px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur text-left text-xs text-neutral-500 border-b">
                      <tr>
                        <th className="py-2.5 px-3">Program</th>
                        <th className="py-2.5 px-3 text-right">Freshman</th>
                        <th className="py-2.5 px-3 text-right">Sophomore</th>
                        <th className="py-2.5 px-3 text-right">Junior</th>
                        <th className="py-2.5 px-3 text-right">Senior</th>
                      </tr>
                    </thead>
                    <tbody className="text-neutral-800">
                      {archiveStats.map((r, i) => (
                        <tr
                          key={i}
                          className="border-b last:border-0 odd:bg-white even:bg-neutral-50/60 hover:bg-emerald-50/40 transition-colors"
                        >
                          <td className="py-2.5 px-3">{r[0]}</td>
                          <td className="py-2.5 px-3 text-right tabular-nums">{r[1]}</td>
                          <td className="py-2.5 px-3 text-right tabular-nums">{r[2]}</td>
                          <td className="py-2.5 px-3 text-right tabular-nums">{r[3]}</td>
                          <td className="py-2.5 px-3 text-right tabular-nums">{r[4]}</td>
                        </tr>
                      ))}
                      {archiveStats.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-gray-500">
                            No data.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="px-4 py-2 text-sm text-neutral-700 border-t bg-neutral-50/70">
                  Totals — F: <strong className="tabular-nums">{archiveStatsTotals[0]}</strong>
                  &nbsp; S: <strong className="tabular-nums">{archiveStatsTotals[1]}</strong>
                  &nbsp; J: <strong className="tabular-nums">{archiveStatsTotals[2]}</strong>
                  &nbsp; SR: <strong className="tabular-nums">{archiveStatsTotals[3]}</strong>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
