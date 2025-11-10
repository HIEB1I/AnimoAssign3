/* ------------- OM_FacultyManagement.tsx ------------- */
import { useEffect, useMemo, useRef, useState } from "react";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import {
  Search as SearchIcon,
  MoreVertical,
  User,
  Calendar,
  BookOpen,
  GraduationCap,
} from "lucide-react";

import {
  getFacultyOptions,
  listFaculty,
  getFacultyProfile,
  getFacultySchedule,
  getFacultyHistory,
  type FacultyRow,
  type FMOptions,
} from "../../api";

/* ---- Row actions menu ---- */
function ActionMenu({
  onViewProfile,
  onViewSchedule,
  onViewHistory,
}: {
  onViewProfile: () => void;
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
             
              onViewProfile();
           
            }}
           
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          
          >
            <User className="h-4 w-4" /> <span>Faculty Profile</span>
          </button>
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

/* ---------- Helpers to mirror FACULTY_Overview list view ---------- */
type DayLong = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";
const DAY_ORDER: DayLong[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type TLItem = {
  code: string;
  title: string;
  sec: string;
  units: number;
  campus: string;
  mode: string;
  room: string;
  time: string;
};
type TL = { day: DayLong; items: TLItem[] };

// (Same mapping as in FACULTY_Overview)
function makeTeachingLoad(dataArray: any[]): TL[] {
  const byDay: Record<DayLong, TLItem[]> = {
    Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [],
  };
  (dataArray || []).forEach((c: any) => {
    const day = (c.day || "") as DayLong;
    if (!DAY_ORDER.includes(day)) return;
    byDay[day].push({
      code: c.course_code ?? "",
      title: c.course_title ?? "",
      sec: c.section ?? "",
      units: Number(c.units) || 0,
      campus: c.campus || "—",
      mode: c.mode || "Online",
      room: c.room || "Online",
      time: c.time || "",
    });
  });
  return DAY_ORDER.map((d) => ({ day: d, items: byDay[d] }));
}

/* ---------- History helpers (mirror FACULTY_History grouping/columns) ---------- */
type HistRow = {
  code: string;
  title: string;
  section: string;
  mode?: string | null;
  day1?: string | null;
  room1?: string | null;
  day2?: string | null;
  room2?: string | null;
  time?: string | null;
  term?: string | null; // "Term 1" | "Term 2" | "Term 3"
};

// Group rows by Term 1/2/3 like FACULTY_History
function groupHistoryByTerm(rows: HistRow[]) {
  const groups: Record<string, HistRow[]> = { "Term 1": [], "Term 2": [], "Term 3": [] };
  rows.forEach((r) => {
    const t = (r.term as string) || "Term 1";
    if (!groups[t]) groups[t] = [];
    groups[t].push(r);
  });
  return groups;
}

// Excel-like, single-line cells except title (no horizontal scroll)
function renderTeachingHistoryLikeFacultyFromArray(flatRows: HistRow[]) {
  const groups = groupHistoryByTerm(flatRows);

  const HEADERS = [
    "Course Code","Course Title","Section",
    "Mode","Day 1","Room 1","Day 2","Room 2","Time",
  ] as const;

  return (
    <div className="space-y-8">
      {(["Term 1","Term 2","Term 3"] as const).map((t) => (
        <div key={t} className="rounded-xl border border-gray-200 overflow-hidden bg-white">
          {/* Term header */}
          <div className="px-4 py-3 text-sm font-semibold text-emerald-700 bg-gray-50 border-b">
            {t}
          </div>

          {/* Excel-inspired fixed table */}
          <div>
            <table className="w-full table-fixed border-t border-gray-200">
              <colgroup>
                <col className="w-[12ch]" /> {/* Code */}
                <col className="w-[32ch]" /> {/* Title (can wrap) */}
                <col className="w-[10ch]" /> {/* Section */}
                <col className="w-[10ch]" /> {/* Mode */}
                <col className="w-[8ch]"  /> {/* Day 1 */}
                <col className="w-[14ch]" /> {/* Room 1 */}
                <col className="w-[8ch]"  /> {/* Day 2 */}
                <col className="w-[14ch]" /> {/* Room 2 */}
                <col className="w-[16ch]" /> {/* Time */}
              </colgroup>

              <thead>
                <tr className="text-xs text-gray-600 bg-emerald-50">
                  {HEADERS.map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold text-center">{h}</th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {(groups[t] ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={HEADERS.length} className="px-4 py-6 text-center text-sm text-gray-500 bg-white">
                      No records.
                    </td>
                  </tr>
                ) : (
                  groups[t].map((r, i) => (
                    <tr key={`${t}-${i}`} className={i % 2 ? "bg-gray-50" : "bg-white"}>
                      <td className="px-3 py-2 text-center text-[13px] whitespace-nowrap">{r.code}</td>
                      <td className="px-3 py-2 text-center text-[13px] whitespace-normal break-words">{r.title}</td>
                      <td className="px-3 py-2 text-center text-[13px] whitespace-nowrap">{r.section}</td>
                      <td className="px-3 py-2 text-center text-[13px] whitespace-nowrap">{r.mode ?? ""}</td>
                      <td className="px-3 py-2 text-center text-[13px] whitespace-nowrap">{r.day1 ?? ""}</td>
                      <td className="px-3 py-2 text-center text-[13px] whitespace-nowrap">{r.room1 ?? ""}</td>
                      <td className="px-3 py-2 text-center text-[13px] whitespace-nowrap">{r.day2 ?? ""}</td>
                      <td className="px-3 py-2 text-center text-[13px] whitespace-nowrap">{r.room2 ?? ""}</td>
                      <td className="px-3 py-2 text-center text-[13px] whitespace-nowrap">{r.time ?? ""}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Page ---------------- */
export default function OM_FacultyManagement() {
  type ModalType = null | "profile" | "schedule" | "history";

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

  // table rows
  const [rows, setRows] = useState<FacultyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  // modals
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [selected, setSelected] = useState<FacultyRow | null>(null);

  // modal data
  const [profile, setProfile] = useState<any>(null);
  const [schedule, setSchedule] = useState<any>(null);

  // history now expects { teaching_history: HistRow[] }
  const [history, setHistory] = useState<{ teaching_history: HistRow[] } | null>(null);
  const [historyYearIndex, setHistoryYearIndex] = useState(0);

  // Load dropdown options
  useEffect(() => {
    (async () => {
      try {
        const opt: FMOptions = await getFacultyOptions();
        if (!opt.ok) throw new Error("Failed to load options");
        setDeptOptions(["All Departments", ...opt.departments]);
        setTypeOptions(["All Type", ...opt.facultyTypes]);
        setAcademicYears(opt.academicYears);
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
   
    setProfile(null);
   
    setSchedule(null);
   
    setHistory(null);
 
  };

  // Load modal content
  useEffect(() => {
    (async () => {
      if (!activeModal || !selected) return;
      try {
        if (activeModal === "profile") {
          const { profile } = await getFacultyProfile(selected.faculty_id);
          setProfile(profile);
        } else if (activeModal === "schedule") {
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

  /* ---------- Renderers ---------- */
  const renderTeachingLoadSummaryList = (s: any) => {
    // backend returns { teaching_load: [...] }
    const TL = makeTeachingLoad(s?.teaching_load || []);

    return (
      <div className="space-y-6">
        {TL.map((day) => (
          <div key={day.day} className="rounded-xl border border-emerald-700/50 overflow-hidden bg-white">
            {/* Day header */}
            <div className="px-5 py-3">
              <div className="text-emerald-700 font-semibold text-[15px]">{day.day}</div>
            </div>

            {/* Excel-like table (no horizontal scroll) */}
            <div className="px-4 pb-4">
              <div className="rounded-xl border border-emerald-700/40">
                <table className="w-full table-fixed">
                  <colgroup>
                    <col style={{ width: "12%" }} />
                    <col style={{ width: "32%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "12%" }} />
                    <col style={{ width: "10%" }} />
                    <col style={{ width: "10%" }} />
                    <col style={{ width: "8%" }} />
                  </colgroup>
                  <thead>
                    <tr className="text-[11.5px] uppercase tracking-wide text-emerald-800 bg-emerald-50">
                      {[
                        "Course Code","Course Title","Section","Units","Campus","Mode","Room","Time",
                      ].map((h) => (
                        <th key={h} className="px-3 py-2 font-semibold text-center border-b border-emerald-700/40">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {day.items.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-4 py-6 text-center text-sm text-neutral-500 bg-white">
                          No records.
                        </td>
                      </tr>
                    ) : (
                      day.items.map((it, idx) => (
                        <tr
                          key={`${day.day}-${it.code}-${it.sec}-${idx}`}
                          className={cls("text-neutral-900 text-[13px]", idx % 2 === 0 ? "bg-white" : "bg-neutral-50")}
                        >
                          <td className="px-3 py-2 text-center whitespace-nowrap border-t border-emerald-700/30">{it.code}</td>
                          <td className="px-3 py-2 text-center whitespace-normal break-words border-t border-emerald-700/30">{it.title || "—"}</td>
                          <td className="px-3 py-2 text-center whitespace-nowrap border-t border-emerald-700/30">{it.sec}</td>
                          <td className="px-3 py-2 text-center whitespace-nowrap border-t border-emerald-700/30">{it.units}</td>
                          <td className="px-3 py-2 text-center whitespace-nowrap border-t border-emerald-700/30">{it.campus}</td>
                          <td className="px-3 py-2 text-center whitespace-nowrap border-t border-emerald-700/30">{it.mode}</td>
                          <td className="px-3 py-2 text-center whitespace-nowrap border-t border-emerald-700/30">{it.room}</td>
                          <td className="px-3 py-2 text-center whitespace-nowrap border-t border-emerald-700/30">{it.time}</td>
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
  };

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Faculty Directory</h1>
        <p className="text-sm text-gray-600">Browse and manage faculty profile, schedule and history.</p>
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
                      onViewProfile={() => openModal("profile", r)}
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
              {activeModal === "profile" && profile && (
                <>
                  <h2 className="text-lg font-semibold text-emerald-700 mb-6">Faculty Profile</h2>
                  <div className="grid grid-cols-3 gap-y-5 text-sm mb-8">
                    <div>
                      <p className="font-semibold text-gray-900">Name</p>
                      <p className="text-gray-600">{profile.name}</p>
                    </div>
                    <div>
                      <p className="font-semibold text-gray-900">Email</p>
                      <p className="text-gray-600">{profile.email}</p>
                    </div>
                    <div>
                      <p className="font-semibold text-gray-900">Department</p>
                      <p className="text-gray-600">{profile.department}</p>
                    </div>
                    <div>
                      <p className="font-semibold text-gray-900">Faculty Type</p>
                      <p className="text-gray-600">{profile.faculty_type}</p>
                    </div>
                    <div>
                      <p className="font-semibold text-gray-900">Status</p>
                      <p className="text-gray-600">{profile.status}</p>
                    </div>
                    <div>
                      <p className="font-semibold text-gray-900">Position</p>
                      <p className="text-gray-600">{profile.position || "—"}</p>
                    </div>
                    <div>
                      <p className="font-semibold text-gray-900">Admin Position</p>
                      <p className="text-gray-600">{profile.admin_position || "—"}</p>
                    </div>
                    <div>
                      <p className="font-semibold text-gray-900">Course Coordinator</p>
                      <p className="text-gray-600">
                        {Array.isArray(profile.course_coordinator_of) && profile.course_coordinator_of.length
                          ? profile.course_coordinator_of.join(", ")
                          : "—"}
                      </p>
                    </div>
                  </div>
                  <h3 className="text-md font-semibold flex items-center gap-2 mb-2 text-gray-900">
                    <GraduationCap className="h-5 w-5 text-emerald-700" />
                    Nature of Load
                  </h3>
                  <div className="grid grid-cols-4 text-left text-sm mb-4">
                    <div>
                      <p className="font-semibold">Teaching</p>
                      <p>{profile.load?.teaching ?? 0}</p>
                    </div>
                    <div>
                      <p className="font-semibold">Admin</p>
                      <p>{profile.load?.admin ?? 0}</p>
                    </div>
                    <div>
                      <p className="font-semibold">Research</p>
                      <p>{profile.load?.research ?? 0}</p>
                    </div>
                    <div>
                      <p className="font-semibold">Faculty Units</p>
                      <p>{profile.load?.faculty_units ?? 0}</p>
                    </div>
                  </div>
                </>
              )}

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
                    renderTeachingLoadSummaryList(schedule)
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
                  <div className="flex justify-between items-center mb-4">
                    <button
                      // Previous = go to OLDER AY (increase index)
                      onClick={() => setHistoryYearIndex((i) => Math.min(academicYears.length - 1, i + 1))}
                      disabled={historyYearIndex === academicYears.length - 1}
                      className={cls(
                        "px-3 py-1.5 rounded-lg text-sm font-medium border shadow-sm",
                        historyYearIndex === academicYears.length - 1
                          ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                          : "bg-white hover:bg-gray-50 text-gray-700"
                      )}
                    >
                      ← Previous
                    </button>

                    <span className="text-base font-semibold text-gray-800">{historyYearLabel}</span>

                    <button
                      // Next = go to NEWER AY (decrease index)
                      onClick={() => setHistoryYearIndex((i) => Math.max(0, i - 1))}
                      disabled={historyYearIndex === 0}
                      className={cls(
                        "px-3 py-1.5 rounded-lg text-sm font-medium border shadow-sm",
                        historyYearIndex === 0
                          ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                          : "bg-white hover:bg-gray-50 text-gray-700"
                      )}
                    >
                      Next →
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
                    renderTeachingHistoryLikeFacultyFromArray(history.teaching_history)
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
