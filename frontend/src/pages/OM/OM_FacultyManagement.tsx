import { useEffect, useMemo, useRef, useState } from "react";
import AppShell from "../../base/AppShell";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import { Search as SearchIcon, MoreVertical, User, Calendar, BookOpen, GraduationCap } from "lucide-react";
import {
  getOmHeader,
  getFacultyOptions,
  listFaculty,
  getFacultyProfile,
  getFacultySchedule,
  getFacultyHistory,
  type FacultyRow,
  type FMOptions,
} from "../../api";

/* ---- Action Menu ---- */
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
    const close = (e: MouseEvent) => open && !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} className="rounded-full p-2 hover:bg-gray-100 text-gray-700">
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-48 rounded-xl border border-gray-200 bg-white shadow-xl py-1 text-left z-50">
          <button onClick={() => { setOpen(false); onViewProfile(); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
            <User className="h-4 w-4" /> <span>Faculty Profile</span>
          </button>
          <button onClick={() => { setOpen(false); onViewSchedule(); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
            <Calendar className="h-4 w-4" /> <span>Schedule</span>
          </button>
          <button onClick={() => { setOpen(false); onViewHistory(); }} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
            <BookOpen className="h-4 w-4" /> <span>Teaching History</span>
          </button>
        </div>
      )}
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
  const [history, setHistory] = useState<any>(null);
  const [historyYearIndex, setHistoryYearIndex] = useState(0);

  // topbar name/subtitle from DB
  const [topName, setTopName] = useState<string>();
  const [topSub, setTopSub] = useState<string>();

  // Logged-in user
  const sessionUser = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("animo.user") || "null"); }
    catch { return null; }
  }, []);
  const userEmail = sessionUser?.email;
  const userId = sessionUser?.userId;

  // Load header + options once
  useEffect(() => {
    (async () => {
      try {
        const h = await getOmHeader(userEmail, userId);
        if (h.ok) {
          setTopName(h.profileName || "");
          setTopSub(h.profileSubtitle || "");
        }
      } catch {}
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
  }, [userEmail, userId]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Fetch table
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

  // open/close modals
  const openModal = (type: Exclude<ModalType, null>, item: FacultyRow) => { setSelected(item); setActiveModal(type); };
  const closeModal = () => { setActiveModal(null); setSelected(null); setProfile(null); setSchedule(null); setHistory(null); };

  // Load modal data
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
          const ay = academicYears[historyYearIndex];
          const data = await getFacultyHistory(selected.faculty_id, ay);
          setHistory(data);
        }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal, selected, historyYearIndex, academicYears]);

  const historyYearLabel = useMemo(() => {
    const ay = academicYears[historyYearIndex];
    return ay ? `AY ${ay}–${ay + 1}` : "—";
  }, [historyYearIndex, academicYears]);

  return (
    <AppShell topbarProfileName={topName} topbarProfileSubtitle={topSub}>
      <main className="w-full px-8 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold">Faculty Management</h1>
          <p className="text-sm text-gray-600">Manage faculty profiles, schedule, and teaching history</p>
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
        <div className="border border-gray-200 bg-gray-50 shadow-sm overflow-visible">
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
                <tr><td className="px-4 py-6 text-center text-gray-500" colSpan={7}>Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td className="px-4 py-6 text-center text-gray-500" colSpan={7}>No results</td></tr>
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
            <div className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-2xl overflow-y-auto max-h-[90vh]">
              {activeModal === "profile" && profile && (
                <>
                  <h2 className="text-lg font-semibold text-emerald-700 mb-6">Faculty Profile</h2>
                  <div className="grid grid-cols-3 gap-y-5 text-sm mb-8">
                    <div><p className="font-semibold text-gray-900">Name</p><p className="text-gray-600">{profile.name}</p></div>
                    <div><p className="font-semibold text-gray-900">Email</p><p className="text-gray-600">{profile.email}</p></div>
                    <div><p className="font-semibold text-gray-900">Department</p><p className="text-gray-600">{profile.department}</p></div>
                    <div><p className="font-semibold text-gray-900">Faculty Type</p><p className="text-gray-600">{profile.faculty_type}</p></div>
                    <div><p className="font-semibold text-gray-900">Status</p><p className="text-gray-600">{profile.status}</p></div>
                    <div><p className="font-semibold text-gray-900">Position</p><p className="text-gray-600">{profile.position || "—"}</p></div>
                    <div><p className="font-semibold text-gray-900">Admin Position</p><p className="text-gray-600">{profile.admin_position || "—"}</p></div>
                    <div><p className="font-semibold text-gray-900">Course Coordinator</p>
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
                    <div><p className="font-semibold">Teaching</p><p>{profile.load?.teaching ?? 0}</p></div>
                    <div><p className="font-semibold">Admin</p><p>{profile.load?.admin ?? 0}</p></div>
                    <div><p className="font-semibold">Research</p><p>{profile.load?.research ?? 0}</p></div>
                    <div><p className="font-semibold">Faculty Units</p><p>{profile.load?.faculty_units ?? 0}</p></div>
                  </div>
                </>
              )}

              {activeModal === "schedule" && schedule && (
                <>
                  <h2 className="text-lg font-semibold text-emerald-700 mb-6">Faculty Schedule</h2>
                  <div className="space-y-6">
                    {(schedule.days || []).map(({ day, entries }: any) => (
                      <div key={day} className="rounded-xl border border-gray-200 overflow-hidden">
                        <div className="px-4 py-2 text-sm font-semibold text-emerald-700 bg-gray-50 border-b">{day}</div>
                        <div className="overflow-x-auto">
                          <table className="min-w-full text-sm">
                            <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide border-b">
                              <tr>
                                {["Course Code", "Section", "Campus", "Room", "Time"].map((h) => (
                                  <th key={h} className="px-3 py-2 text-center font-medium whitespace-nowrap">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {entries.map((row: any, i: number) => (
                                <tr key={`${day}-${row.section}-${i}`} className={cls(i % 2 === 0 ? "bg-white" : "bg-gray-50", "text-gray-800")}>
                                  <td className="px-3 py-2 text-center">{row.code}</td>
                                  <td className="px-3 py-2 text-center">{row.section}</td>
                                  <td className="px-3 py-2 text-center">{row.campus}</td>
                                  <td className="px-3 py-2 text-center">{row.room}</td>
                                  <td className="px-3 py-2 text-center">{row.time}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {activeModal === "history" && history && (
                <>
                  <h2 className="text-lg font-semibold text-emerald-700 mb-6">Teaching History</h2>
                  <div className="flex justify-between items-center mb-4">
                    <button
                      onClick={() => setHistoryYearIndex((i) => Math.max(0, i - 1))}
                      disabled={historyYearIndex === 0}
                      className={cls(
                        "px-3 py-1.5 rounded-lg text-sm font-medium border shadow-sm",
                        historyYearIndex === 0 ? "bg-gray-100 text-gray-400 cursor-not-allowed" : "bg-white hover:bg-gray-50 text-gray-700"
                      )}
                    >
                      ← Previous
                    </button>
                    <span className="text-base font-semibold text-gray-800">{historyYearLabel}</span>
                    <button
                      onClick={() => setHistoryYearIndex((i) => Math.min(academicYears.length - 1, i + 1))}
                      disabled={historyYearIndex === academicYears.length - 1}
                      className={cls(
                        "px-3 py-1.5 rounded-lg text-sm font-medium border shadow-sm",
                        historyYearIndex === academicYears.length - 1 ? "bg-gray-100 text-gray-400 cursor-not-allowed" : "bg-white hover:bg-gray-50 text-gray-700"
                      )}
                    >
                      Next →
                    </button>
                  </div>

                  {Object.entries(history.terms || {}).map(([term, rows]: any) => (
                    <div key={term} className="rounded-xl border border-gray-200 mb-6 overflow-hidden">
                      <div className="px-4 py-2 text-sm font-semibold text-emerald-700 bg-gray-50 border-b">{term}</div>
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-sm">
                          <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide border-b">
                            <tr>
                              {["Course Code", "Section", "Units", "Mode", "Schedule"].map((h) => (
                                <th key={h} className="px-3 py-2 text-center font-medium whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r: any, i: number) => (
                              <tr key={`${term}-${i}`} className={cls("text-gray-700", i % 2 === 0 ? "bg-white" : "bg-gray-50")}>
                                <td className="px-3 py-2 text-center">{r.code}</td>
                                <td className="px-3 py-2 text-center">{r.section}</td>
                                <td className="px-3 py-2 text-center">{r.units}</td>
                                <td className="px-3 py-2 text-center">{r.mode}</td>
                                <td className="px-3 py-2 text-center">{r.schedule}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </>
              )}

              <div className="flex justify-end mt-8">
                <button onClick={closeModal} className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm">Close</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </AppShell>
  );
}
