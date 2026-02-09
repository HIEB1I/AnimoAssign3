/* ------------- OM_FacultyManagement.tsx ------------- */
import { useEffect, useMemo, useRef, useState } from "react";
import SelectBox from "../../component/SelectBox";
import {
  Search as SearchIcon,
  MoreVertical,
  Calendar,
  BookOpen,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  getFacultyOptions,
  listFaculty,
  getFacultySchedule,
  getFacultyHistory,
  type FacultyRow,
  type FMOptions,
} from "../../api";

/* ---- Row actions menu ---- */
function ActionMenu({
  onViewSchedule,
  onViewHistory,
}: {
  onViewSchedule: () => void;
  onViewHistory: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) =>
      open && !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-full p-2 hover:bg-gray-100 text-gray-700"
        title="Actions"
        aria-label="Actions"
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-48 rounded-xl border border-gray-200 bg-white shadow-xl py-1 text-left z-50">
          <button
           
            onClick={() => {
              setOpen(false);             
              onViewSchedule();           
            }}
           
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          
          >
            <Calendar className="h-4 w-4" /> <span>Schedule</span>
          </button>
          <button
           
            onClick={() => {
             
              setOpen(false);
             
              onViewHistory();
           
            }}
           
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          
          >
            <BookOpen className="h-4 w-4" /> <span>Teaching History</span>
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- Schedule + Teaching History table helpers (Reports & Analytics style) ---------- */
type ScheduleRow = {
  course_code: string;
  course_title: string;
  section: string;
  units?: number;
  mode?: string;
  day1?: string;
  begin1?: string;
  end1?: string;
  day2?: string;
  begin2?: string;
  end2?: string;
};

type HistRow = {
  code: string;
  title: string;
  section: string;
  units?: number;
  day1?: string;
  begin1?: string;
  end1?: string;
  day2?: string;
  begin2?: string;
  end2?: string;
  term?: string; // "Term 1" | "Term 2" | "Term 3"
};

function groupHistoryByTerm(rows: HistRow[]) {
  const groups: Record<string, HistRow[]> = { "Term 1": [], "Term 2": [], "Term 3": [] };
  rows.forEach((r) => {
    const t = (r.term as string) || "Term 1";
    if (!groups[t]) groups[t] = [];
    groups[t].push(r);
  });
  return groups;
}

function renderScheduleTable(rows: ScheduleRow[]) {
  return (
    <div className="border border-gray-200 bg-gray-50 shadow-sm overflow-visible rounded-xl">
      <div className="overflow-x-auto rounded-xl">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b text-gray-700">
            <tr>
              <th className="text-left px-4 py-2">Course Code &amp; Title</th>
              <th className="text-left px-4 py-2">Section</th>
              <th className="text-left px-4 py-2">Mode</th>
              <th className="text-center px-4 py-2">Units</th>

              <th className="text-left px-4 py-2">Day 1</th>
              <th className="text-left px-4 py-2">Begin 1</th>
              <th className="text-left px-4 py-2">End 1</th>

              <th className="text-left px-4 py-2">Day 2</th>
              <th className="text-left px-4 py-2">Begin 2</th>
              <th className="text-left px-4 py-2">End 2</th>
            </tr>
          </thead>

          <tbody className="divide-y">
            {(rows || []).length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-6 text-center text-gray-500">
                  No records
                </td>
              </tr>
            ) : (
              (rows || []).map((r, idx) => (
                <tr key={idx} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-left font-semibold text-emerald-700">
                    {r.course_code || "—"}
                    <div className="text-xs text-gray-500">{r.course_title || "—"}</div>
                  </td>
                  <td className="px-4 py-3 text-left">{r.section || "—"}</td>
                  <td className="px-4 py-3 text-left">{r.mode || "—"}</td>
                  <td className="px-4 py-3 text-center">{r.units ?? "—"}</td>

                  <td className="px-4 py-3 text-left">{r.day1 || "—"}</td>
                  <td className="px-4 py-3 text-left whitespace-nowrap">{r.begin1 || "—"}</td>
                  <td className="px-4 py-3 text-left whitespace-nowrap">{r.end1 || "—"}</td>

                  <td className="px-4 py-3 text-left">{r.day2 || "—"}</td>
                  <td className="px-4 py-3 text-left whitespace-nowrap">{r.begin2 || "—"}</td>
                  <td className="px-4 py-3 text-left whitespace-nowrap">{r.end2 || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderTeachingHistoryByTerm(flatRows: HistRow[]) {
  const groups = groupHistoryByTerm(flatRows);

  return (
    <div className="space-y-10">
      {(["Term 1", "Term 2", "Term 3"] as const).map((t) => (
        <div key={t} className="space-y-3">
          <div className="text-sm font-semibold text-emerald-700">{t}</div>

          <div className="border border-gray-200 bg-gray-50 shadow-sm overflow-visible rounded-xl">
            <div className="overflow-x-auto rounded-xl">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b text-gray-700">
                  <tr>
                    <th className="text-left px-4 py-2">Course Code &amp; Title</th>
                    <th className="text-left px-4 py-2">Section</th>
                    <th className="text-center px-4 py-2">Units</th>

                    <th className="text-left px-4 py-2">Day 1</th>
                    <th className="text-left px-4 py-2">Begin 1</th>
                    <th className="text-left px-4 py-2">End 1</th>

                    <th className="text-left px-4 py-2">Day 2</th>
                    <th className="text-left px-4 py-2">Begin 2</th>
                    <th className="text-left px-4 py-2">End 2</th>
                  </tr>
                </thead>

                <tbody className="divide-y">
                  {(groups[t] ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-6 text-center text-gray-500">
                        No records
                      </td>
                    </tr>
                  ) : (
                    (groups[t] ?? []).map((r, idx) => (
                      <tr key={`${t}-${idx}`} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-left font-semibold text-emerald-700">
                          {r.code || "—"}
                          <div className="text-xs text-gray-500">{r.title || "—"}</div>
                        </td>
                        <td className="px-4 py-3 text-left">{r.section || "—"}</td>
                        <td className="px-4 py-3 text-center">{r.units ?? "—"}</td>

                        <td className="px-4 py-3 text-left">{r.day1 || "—"}</td>
                        <td className="px-4 py-3 text-left whitespace-nowrap">{r.begin1 || "—"}</td>
                        <td className="px-4 py-3 text-left whitespace-nowrap">{r.end1 || "—"}</td>

                        <td className="px-4 py-3 text-left">{r.day2 || "—"}</td>
                        <td className="px-4 py-3 text-left whitespace-nowrap">{r.begin2 || "—"}</td>
                        <td className="px-4 py-3 text-left whitespace-nowrap">{r.end2 || "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Page ---------------- */
export default function OM_FacultyManagement() {
  type ModalType = null | "schedule" | "history";

  // filters
  const [department, setDepartment] = useState("All Departments");
  const [facultyType, setFacultyType] = useState("All Type");

  // live search
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // options
  const [deptOptions, setDeptOptions] = useState<string[]>(["All Departments"]);
  const [typeOptions, setTypeOptions] = useState<string[]>(["All Type"]);
  const [academicYears, setAcademicYears] = useState<number[]>([]);
  const [termLabel, setTermLabel] = useState("");

  // table rows
  const [rows, setRows] = useState<FacultyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  // modals
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [selected, setSelected] = useState<FacultyRow | null>(null);

  // modal data
  const [schedule, setSchedule] = useState<any>(null);

  // history now expects { teaching_history: HistRow[] }
  const [history, setHistory] = useState<{ teaching_history: HistRow[] } | null>(null);
  const [historyYearIndex, setHistoryYearIndex] = useState(0);

  // Load dropdown options + working-term label
  useEffect(() => {
    (async () => {
      try {
        const opt: FMOptions = await getFacultyOptions();
        if (!opt.ok) throw new Error("Failed to load options");

        setDeptOptions(["All Departments", ...(opt.departments || [])]);
        setTypeOptions(["All Type", ...(opt.facultyTypes || [])]);
        setAcademicYears(opt.academicYears || []);

        // Build AY/Term label just like Course Management
        const ay = opt.activeTerm?.acad_year_start;
        const tn = opt.activeTerm?.term_number;
        setTermLabel(ay ? `Term ${tn ?? "—"} · AY ${ay}-${ay + 1}` : "");
      } catch (e: any) {
        setErr(e?.response?.data?.detail || e?.message || "Failed to load options.");
      }
    })();
  }, []);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Fetch table rows when filters/search change
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setErr("");
        const { ok, rows } = await listFaculty({ department, facultyType, search });
        if (!ok) throw new Error("Failed to load faculty list");
        setRows(rows);
      } catch (e: any) {
        setRows([]);
        setErr(e?.response?.data?.detail || e?.message || "Failed to load faculty list.");
      } finally {
        setLoading(false);
      }
    })();
  }, [department, facultyType, search]);

  // modal open/close
  const openModal = (type: Exclude<ModalType, null>, item: FacultyRow) => {
   
    setSelected(item);
   
    setActiveModal(type);
 
  };
  const closeModal = () => {
   
    setActiveModal(null);
   
    setSelected(null);
   
    setSchedule(null);
   
    setHistory(null);
 
  };

  // Load modal content
  useEffect(() => {
    (async () => {
      if (!activeModal || !selected) return;
      try {
        if (activeModal === "schedule") {
          const data = await getFacultySchedule(selected.faculty_id);
          setSchedule(data);
        } else if (activeModal === "history") {
          // Pass AY start (number) — api helper also accepts termId (string)
          const ay = academicYears[historyYearIndex];
          const data = await getFacultyHistory(selected.faculty_id, ay);
          setHistory({ teaching_history: data?.teaching_history || [] });
        }
      } catch {
        /* ignore per-modal fetch errors */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal, selected, historyYearIndex, academicYears]);

  const historyYearLabel = useMemo(() => {
    const ay = academicYears[historyYearIndex];
    return ay ? `AY ${ay}–${ay + 1}` : "—";
  }, [historyYearIndex, academicYears]);

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Faculty Directory</h1>
        <p className="text-sm text-gray-600">
          Manage faculty list and their schedules for {termLabel || ""}
        </p>
      </header>

      {err && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
        <div className="relative flex-1 min-w-[260px]">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
        </div>

        <SelectBox value={department} onChange={setDepartment} options={deptOptions} />
        <SelectBox value={facultyType} onChange={setFacultyType} options={typeOptions} />
      </div>

      {/* Table */}
      <div className="border border-gray-200 bg-gray-50 shadow-sm overflow-visible rounded-xl">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b text-gray-700">
            <tr>
              <th className="text-left px-4 py-2">Faculty</th>
              <th className="text-left px-4 py-2">Department</th>
              <th className="text-left px-4 py-2">Position</th>
              <th className="text-center px-4 py-2">Teaching Units</th>
              <th className="text-center px-4 py-2">Faculty Type</th>
              <th className="text-center px-4 py-2">Status</th>
              <th className="text-center px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                  
                <td className="px-4 py-6 text-center text-gray-500" colSpan={7}>
                    Loading…
                  </td>
                
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                  
                <td className="px-4 py-6 text-center text-gray-500" colSpan={7}>
                    No results
                  </td>
                
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.faculty_id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-emerald-700 font-semibold">
                    {r.name}
                    <div className="text-xs text-gray-500">{r.email}</div>
                  </td>
                  <td className="px-4 py-3">{r.department}</td>
                  <td className="px-4 py-3">{r.position || "—"}</td>
                  <td className="text-center">{r.teaching_units}</td>
                  <td className="text-center">{r.faculty_type}</td>
                  <td className="text-center text-gray-800">{r.status}</td>
                  <td className="text-center">
                    <ActionMenu
                      onViewSchedule={() => openModal("schedule", r)}
                      onViewHistory={() => openModal("history", r)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

        {/* -------- Modals -------- */}
        {activeModal && selected && (
          <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4">
            <div className="w-full max-w-screen-xl rounded-2xl bg-white p-6 shadow-2xl overflow-y-auto max-h-[90vh]">
              {activeModal === "schedule" && (
                <>
                  <div className="text-center mb-4">
                    <h2 className="text-lg font-semibold text-emerald-700">Faculty Schedule</h2>
                    <p className="text-sm text-neutral-500">{selected?.name ?? ""}</p>
                  </div>

                  {!schedule ? (
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
                      Loading schedule…
                    </div>
                  ) : (schedule?.teaching_load || []).length === 0 ? (
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-600">
                      No schedule records for the current term.
                    </div>
                  ) : (
                    renderScheduleTable(schedule?.teaching_load || [])
                  )}
                </>
              )}

              {activeModal === "history" && (
                <>
                  {/* Title + faculty name */}
                  <div className="text-center mb-4">
                    <h2 className="text-lg font-semibold text-emerald-700">Teaching History</h2>
                    <p className="text-sm text-neutral-500">{selected?.name ?? ""}</p>
                  </div>

                  {/* Prev / Next AY controls (existing OM behavior kept) */}
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                    <button
                      className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
                      // Previous = go to OLDER AY (increase index)
                      onClick={() =>
                        setHistoryYearIndex((i) => Math.min(academicYears.length - 1, i + 1))
                      }
                      disabled={historyYearIndex === academicYears.length - 1}
                      title="Previous academic year"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      <span>Previous</span>
                    </button>

                    <div className="flex flex-col items-center gap-1">
                      <div className="rounded-full border border-emerald-100 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800 shadow-sm">
                        {historyYearLabel}
                      </div>
                      {academicYears.length > 0 && (
                        <div className="text-xs text-gray-500">
                          {Math.min(historyYearIndex + 1, academicYears.length)} of {academicYears.length}
                        </div>
                      )}
                    </div>

                    <button
                      className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
                      // Next = go to NEWER AY (decrease index)
                      onClick={() => setHistoryYearIndex((i) => Math.max(0, i - 1))}
                      disabled={historyYearIndex === 0}
                      title="Next academic year"
                    >
                      <span>Next</span>
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Body */}
                  {!history ? (
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
                      Loading history…
                    </div>
                  ) : (history?.teaching_history || []).length === 0 ? (
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-600">
                      No history records for {historyYearLabel}.
                    </div>
                  ) : (
                    renderTeachingHistoryByTerm(history.teaching_history)
                  )}
                </>
              )}

              <div className="flex justify-end mt-8">
                <button onClick={closeModal} className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm">
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

  );
}
