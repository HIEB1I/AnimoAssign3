import React, { useEffect, useMemo, useState } from "react";
//import Papa, { type ParseResult } from "papaparse";
import Papa from "papaparse";
import { Pencil, Check, Upload, Archive, Download, X } from "lucide-react";
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
  reactivateApoPreenlistment,
} from "../../api";

const PREEN_TERM_KEY_PREFIX = "apo.preenTermId.";

function setPlanningTermForCampus(
  campusId: string,
  termId: string | null | undefined
) {
  if (!campusId || !termId) return;
  try {
    window.localStorage.setItem(PREEN_TERM_KEY_PREFIX + campusId, termId);
  } catch {
    // ignore storage errors
  }
}

// Compact, consistent pill wrappers
const miniBase =
  "inline-flex items-center h-9 rounded-full border-2 border-emerald-200 bg-white px-2 shadow-sm focus-within:border-emerald-400";
// Compact pill-style input (matches the dropdown box, no chevron)
function MiniFieldInput({
  value,
  onChange,
  placeholder = "",
  type = "text",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "number";
  className?: string;
}) {
  return (
    <div className={`${miniBase} ${className}`}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={type}
        className="w-full bg-transparent outline-none text-sm px-1"
      />
    </div>
  );
}

// NEW: custom compact dropdown (no native <select>, fully stylable)
function MiniSelectMenu({
  value,
  onChange,
  options,
  className = "",
  placeholder = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  return (
    <div ref={ref} className={`relative ${miniBase} ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 h-7 leading-none text-sm outline-none"
      >
        <span className={`${value ? "" : "text-neutral-400"}`}>
          {value || placeholder}
        </span>
        <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" className="opacity-60">
          <path d="M5 7l5 5 5-5H5z" />
        </svg>
      </button>

      {open && (
        <ul
          className="absolute left-0 top-[calc(100%+6px)] z-40 min-w-[120px]
                     rounded-xl border-2 border-emerald-200 bg-white shadow-lg overflow-hidden"
        >
          {options.map((opt) => {
            const active = opt === value;
            return (
              <li
                key={opt}
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                className={`px-3 py-2 text-sm cursor-pointer select-none hover:bg-emerald-50 ${
                  active ? "bg-emerald-50 font-medium" : ""
                }`}
              >
                {opt}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

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
  const [reactivating, setReactivating] = useState(false);
  // --- Add Row state (left panel - enlisted courses) ---
  const [addingRow, setAddingRow] = useState(false);
  const [newCareer, setNewCareer] = useState<"UGB" | "GSM">("UGB"); // uses SelectBox now
  const [newCourseCode, setNewCourseCode] = useState("");
  const [newCount, setNewCount] = useState<string>("0");


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

const refresh = async (forcedTermId?: string) => {
  if (!user?.userId) return;

  // If a termId is forced (e.g. after re-activate / archive), use that.
  // Otherwise, let the backend decide the planning term
  // (it will pick "next after is_current").
  const termToLoad = forcedTermId;

  const { count, statistics, meta } = await getApoPreenlistment(
    user.userId,
    termToLoad,
    "active",
    campusName || undefined
  );

  const termMeta = (meta as TermMeta) ?? null;
  setActiveMeta(termMeta);

  if (campusName && termMeta?.term_id) {
    setPlanningTermForCampus(campusName, termMeta.term_id);
  }

  setEnlistedCourses(
    (count ?? ([] as PreenlistmentCountDoc[])).map((d) => [
      d.preenlistment_code || "",
      d.career || "",                  // UGB / GSM as-is
      (d as any).acad_group || "",     // CSV 'Acad Group' or college_code
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
          activeMeta?.term_id,
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
const saveNewCourseRow = async () => {
  if (!user?.userId) {
    setErr("Not logged in.");
    return;
  }

  // Campus comes from role (MANILA/LAGUNA). Fallback: activeMeta campus_label (Title Case → UPPER)
  const campusCSV = (
    campusName || (activeMeta?.campus_label?.toUpperCase() as "MANILA" | "LAGUNA")
  ) as "MANILA" | "LAGUNA";
  if (!campusCSV) {
    setErr("Campus is required (cannot infer).");
    return;
  }

  if (!newCourseCode.trim()) {
    setErr("Course Code is required.");
    return;
  }

  try {
    setErr(null);

    const rows: CountCsvRow[] = [{
      Career: newCareer,                    // "UGB" | "GSM"
      "Acad Group": "CCS",                  // fixed as requested
      Campus: campusCSV,                    // fixed from role
      "Course Code": newCourseCode.trim().toUpperCase(),
      Count: Number(newCount || 0),
    }];

    const res = await importApoPreenlistment(
      user.userId,
      rows,
      [],
      activeMeta?.term_id,
      { replaceCount: false },
      campusName || undefined
    );

    if (!res || (res.insertedCount ?? 0) < 1) {
      setErr("Add failed: course not found or invalid fields. Check the Course Code.");
      return;
    }

    // reset UI
    setAddingRow(false);
    setNewCourseCode("");
    setNewCount("0");
    setNewCareer("UGB");

    await refresh();
  } catch (e: any) {
    console.error(e);
    setErr(e?.message || "Failed to add row.");
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
          activeMeta?.term_id,
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

/*  const handleImportCourses = (event: React.ChangeEvent<HTMLInputElement>) => {
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
          activeMeta?.term_id,
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
          activeMeta?.term_id,
          { replaceStats: true },
          campusName || undefined
        );
        await refresh();
      },
    });
  };

  
  
  */

 // Minimal shape we actually use
type CsvResult<T> = {
  data: T[];
  errors?: unknown[];
  meta?: unknown;
};

const handleImportCourses = (event: React.ChangeEvent<HTMLInputElement>) => {
  const file = event.target.files?.[0];
  if (!file || !user?.userId) return;

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: async (results: CsvResult<CountCsvRow>) => {
      const rows = results.data
        .map((r: CountCsvRow) => {
          if (!r.Campus && campusName) (r as any).Campus = campusName;
          return r;
        })
        .filter(
          (r: CountCsvRow) =>
            r["Course Code"] && r.Career && r.Campus && r.Count !== undefined
        );

      await importApoPreenlistment(
        user.userId,
        rows,
        [],
        undefined,
        { replaceCount: true },
        campusName || undefined
      );
      await refresh();
      event.currentTarget.value = "";
    },
    error: (err: unknown) => {
      console.error("CSV parse error (courses):", err);
      event.currentTarget.value = "";
    },
  });
};

const handleImportStats = (event: React.ChangeEvent<HTMLInputElement>) => {
  const file = event.target.files?.[0];
  if (!file || !user?.userId) return;

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: async (results: CsvResult<StatCsvRow>) => {
      const rows = results.data.filter((r: StatCsvRow) => !!r.Program);

      await importApoPreenlistment(
        user.userId,
        [],
        rows,
        undefined,
        { replaceStats: true },
        campusName || undefined
      );
      await refresh();
      event.currentTarget.value = "";
    },
    error: (err: unknown) => {
      console.error("CSV parse error (stats):", err);
      event.currentTarget.value = "";
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
    const label = activeMeta
      ? `Term ${activeMeta.term_number ?? ""} ${activeMeta.ay_label}`
      : "current term";

  if (!confirm(`Archive ${label}? This will snapshot active rows for BOTH Manila and Laguna and may advance the term.`)) {
    return;
  }

    try {
      setArchiving(true);

      // Archive the *same* planning term you are currently viewing
      const res = await archiveApoPreenlistment(
        user.userId,
        activeMeta?.term_id,
        campusName || undefined
      );

      const nextPlanningTermId = (res as any)?.newPlanningTermId as string | undefined;

      // If backend tells us the next planning term, load that explicitly.
      // Otherwise, let the backend compute it from is_current.
      if (nextPlanningTermId) {
        await refresh(nextPlanningTermId);
      } else {
        await refresh();
      }
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
      <TopBar
      fullName={fullName}
      role={campusLabel ? `${roleName} | ${campusLabel}` : roleName}
      inboxPath="/apo/inbox"
    />
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
                  <div className="flex items-center gap-2">
                    <label className="inline-flex items-center gap-2 rounded-md bg-[#008e4e] px-4 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110">
                      <Upload className="h-4 w-4" />
                      Import CSV
                      <input type="file" accept=".csv" onChange={handleImportCourses} className="hidden" />
                    </label>
                    <button
                      onClick={() => {
                        setErr(null);
                        setAddingRow((v) => !v);
                      }}
                      className="inline-flex items-center gap-2 rounded-md border border-emerald-300 text-emerald-700 bg-white px-3 py-2 text-sm hover:bg-emerald-50"
                      title="Add a single course row"
                    >
                      + Add
                    </button>
                  </div>
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

                    {addingRow && (
                      <tr className="bg-emerald-50/60 border-t">
                        {/* No. */}
                        <td className="py-2 px-2">—</td>

                        {/* Career — compact select with matching style */}
                        <td className="py-2 px-2">
                          <MiniSelectMenu
                            value={newCareer}
                            onChange={(v) => setNewCareer((v as "UGB" | "GSM") || "UGB")}
                            options={["UGB", "GSM"]}
                            className="w-[110px]"
                          />
                        </td>

                        {/* Acad Group — fixed pill */}
                        <td className="py-2 px-2">
                          <span className="inline-flex items-center rounded-full border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700">
                            CCS
                          </span>
                        </td>

                        {/* Campus — fixed pill */}
                        <td className="py-2 px-2">
                          <span className="inline-flex items-center rounded-full border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700">
                            {activeMeta?.campus_label || (campusName === "MANILA" ? "Manila" : "Laguna")}
                          </span>
                        </td>

                        {/* Course Code — compact input, no chevron */}
                        <td className="py-2 px-2">
                          <MiniFieldInput
                            value={newCourseCode}
                            onChange={(v) => setNewCourseCode(v.toUpperCase())}
                            placeholder="Course Code"
                            className="w-[150px]"
                          />
                        </td>

                        {/* Count — compact input, no chevron */}
                        <td className="py-2 px-2">
                          <MiniFieldInput
                            value={newCount}
                            onChange={(v) => setNewCount(v.replace(/[^\d]/g, ""))}
                            placeholder="0"
                            type="number"
                            className="w-[80px]"
                          />
                        </td>

                        {/* Actions — exact styles you provided */}
                        <td className="py-2 px-2 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <button
                              onClick={saveNewCourseRow}
                              className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50"
                              title="Save"
                            >
                              <Check className="h-4 w-4" strokeWidth={2.5} />
                            </button>
                            <button
                              onClick={() => {
                                setAddingRow(false);
                                setNewCourseCode("");
                                setNewCount("0");
                                setNewCareer("UGB");
                              }}
                              className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50"
                              title="Cancel"
                            >
                              <X className="h-4 w-4" strokeWidth={2.5} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {enlistedCourses.length === 0 && !addingRow && (
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
                  className="inline-flex items-center gap-2 rounded-md border border-emerald-300 text-emerald-700 bg-white/80 px-3 py-2 text-sm hover:bg-emerald-50 disabled:opacity-50"
                  disabled={!archiveTermId || reactivating}
                  title="Make this archived term the current active term"
                  onClick={async () => {
                    if (!user?.userId || !archiveTermId) return;
                    const sel = archiveTerms.find(t => t.term_id === archiveTermId);
                    const label = sel ? `Term ${sel.term_number ?? "—"} ${sel.ay_label}` : archiveTermId;
                    if (!confirm(`Make ${label} the active term${campusLabel ? ` for ${campusLabel}` : ""}?`)) return;

                    setReactivating(true);
                    try {
                      const res = await reactivateApoPreenlistment(
                        user.userId,
                        archiveTermId,
                        campusName || undefined
                      );
                      const planningTermId =
                        (res as any)?.planningTermId || archiveTermId;

                      setView("active");
                      // Show the planning term associated with this archive
                      await refresh(planningTermId);
                    } catch (e: any) {
                      setErr(e?.message || "Failed to reactivate term.");
                    } finally {
                      setReactivating(false);
                    }
                  }}
                >
                  {reactivating ? "Reactivating…" : "Make Active"}
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