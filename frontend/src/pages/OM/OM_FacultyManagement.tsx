/* ------------- OM_FacultyManagement.tsx ------------- */
import { useEffect, useMemo, useRef, useState } from "react";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import {
  Search as SearchIcon,
  Calendar,
  BookOpen,
  MoreVertical,
  X as XIcon,
} from "lucide-react";

import {
  getFacultyOptions,
  listFaculty,
  getFacultySchedule,
  getFacultyHistory,
  type FacultyRow,
  type FMOptions,
} from "../../api";

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
    <div className="border border-gray-200 bg-white shadow-sm overflow-auto rounded-xl">
      <div className="overflow-x-auto rounded-xl">
          <table className="w-full text-sm table-auto">
            <thead className="bg-gray-50 border-b text-gray-900">
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

function summarizeCertifications(certs: any): { display: string; full: string } {
  const arr = Array.isArray(certs)
    ? certs
        .filter(Boolean)
        .map((c) => String(c).trim())
        .filter(Boolean)
    : [];

  const full = arr.length ? arr.join(", ") : "—";

  // Keep the list compact in-table (full list is still available via tooltip).
  // Examples:
  // - ["AWS", "Cisco"] -> "AWS, Cisco"
  // - ["AWS", "Cisco", "TESDA", "..." ] -> "AWS, Cisco +2"
  if (arr.length === 0) return { display: "—", full: "—" };
  if (arr.length <= 2) return { display: full, full };

  return { display: `${arr.slice(0, 2).join(", ")} +${arr.length - 2}`, full };
}

/* ---------------- Page ---------------- */
export default function OM_FacultyManagement() {
  type ModalType = null | "schedule" | "history";

  // filters
  const [department, setDepartment] = useState("All Departments");
  const [facultyType, setFacultyType] = useState("All Type");
  const [statusFilter, setStatusFilter] = useState("All Status");

  // live search
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // options
  const [deptOptions, setDeptOptions] = useState<string[]>(["All Departments"]);
  const [typeOptions, setTypeOptions] = useState<string[]>(["All Type"]);
  const statusOptions = useMemo(() => ["All Status", "Active", "On Leave"], []);
  const [historyYears, setHistoryYears] = useState<number[]>([]);
  const [termLabel, setTermLabel] = useState("");

  // rows
  const [rows, setRows] = useState<FacultyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  // baseline total count for “Showing X of Y” (Y = total faculty in directory)
  const [baselineTotalFaculty, setBaselineTotalFaculty] = useState<number>(0);

  // modals
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [selected, setSelected] = useState<FacultyRow | null>(null);

  // row actions dropdown
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const openMenuRef = useRef<HTMLDivElement | null>(null);

  const [modalError, setModalError] = useState<string>("");
  const [schedule, setSchedule] = useState<any>(null);
  const [history, setHistory] = useState<{ teaching_history: HistRow[] } | null>(null);
  const [historyYearIndex, setHistoryYearIndex] = useState(0);

  // Load dropdown options + term label
  useEffect(() => {
    (async () => {
      try {
        const opt: FMOptions = await getFacultyOptions();
        if (!opt.ok) throw new Error("Failed to load options");

        setDeptOptions(["All Departments", ...(opt.departments || [])]);
        setTypeOptions(["All Type", ...(opt.facultyTypes || [])]);

        const ay = opt.activeTerm?.acad_year_start;
        const tn = opt.activeTerm?.term_number;
        setTermLabel(ay ? `Term ${tn ?? "—"} · AY ${ay}-${ay + 1}` : "");
      } catch (e: any) {
        setErr(e?.response?.data?.detail || e?.message || "Failed to load options.");
      }
    })();
  }, []);

  // Debounce search input
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Ensure we always know the total faculty count in the directory (for "X of Y")
  useEffect(() => {
    if (baselineTotalFaculty > 0) return;
    (async () => {
      try {
        const { ok, rows: allRows } = await listFaculty({
          department: "All Departments",
          facultyType: "All Type",
          search: "",
        });
        if (ok) setBaselineTotalFaculty((allRows || []).length);
      } catch {
        // ignore baseline fetch errors (page still works)
      }
    })();
  }, [baselineTotalFaculty]);

  // Close actions dropdown on outside click / ESC
  useEffect(() => {
    if (!openMenuId) return;

    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (openMenuRef.current && !openMenuRef.current.contains(target)) {
        setOpenMenuId(null);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenuId(null);
    };

    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenuId]);

  // Fetch rows (status filter is client-side)
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setErr("");

        const { ok, rows: fetchedRows } = await listFaculty({ department, facultyType, search });
        if (!ok) throw new Error("Failed to load faculty list");

        const filtered = (fetchedRows || []).filter((r) => {
          if (!statusFilter || statusFilter === "All Status") return true;
          return String(r.status || "").trim().toLowerCase() === statusFilter.toLowerCase();
        });

        setRows(filtered);

        if (
          baselineTotalFaculty === 0 &&
          department === "All Departments" &&
          facultyType === "All Type" &&
          !search
        ) {
          setBaselineTotalFaculty((fetchedRows || []).length);
        }
      } catch (e: any) {
        setRows([]);
        setErr(e?.response?.data?.detail || e?.message || "Failed to load faculty list.");
      } finally {
        setLoading(false);
      }
    })();
  }, [department, facultyType, statusFilter, search, baselineTotalFaculty]);

  const openModal = (type: Exclude<ModalType, null>, item: FacultyRow) => {
    setSelected(item);
    setModalError("");
    if (type === "history") {
      setHistoryYears([]);
      setHistoryYearIndex(0);
      setHistory(null);
    }
    setActiveModal(type);
  };

  const closeModal = () => {
    setActiveModal(null);
    setModalError("");
    setSelected(null);
    setSchedule(null);
    setHistory(null);
    setHistoryYears([]);
    setHistoryYearIndex(0);
    setOpenMenuId(null);
  };

  // Load modal content
  useEffect(() => {
    (async () => {
      if (!activeModal || !selected) return;
      try {
        // In seeded/legacy data, `faculty_assignments.faculty_id` may store either
        // faculty_profiles.faculty_id OR users.user_id. The list API returns
        // `user_id` (when resolvable), so prefer it for schedule/history queries.
        const facKey = (selected as any)?.user_id || selected.faculty_id;

        if (activeModal === "schedule") {
          const data = await getFacultySchedule(facKey);
          setSchedule(data);
        } else if (activeModal === "history") {
          if (!historyYears.length) {
            const data = await getFacultyHistory(facKey);
            const yrs = Array.isArray(data?.academicYears) ? data.academicYears : [];
            setHistoryYears(yrs);

            const ayStart = typeof data?.acad_year_start === "number" ? data.acad_year_start : yrs[0];
            const idx = ayStart != null && yrs.length ? Math.max(0, yrs.indexOf(ayStart)) : 0;
            setHistoryYearIndex(idx);

            setHistory({ teaching_history: data?.teaching_history || [] });
          } else {
            const ay = historyYears[historyYearIndex];
            const data = await getFacultyHistory(facKey, ay);
            setHistory({ teaching_history: data?.teaching_history || [] });
          }
        }
      } catch (e: any) {
        const msg =
          e?.message ||
          (activeModal === "schedule" ? "Failed to load schedule." : "Failed to load teaching history.");
        setModalError(String(msg));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal, selected, historyYearIndex, historyYears]);

  const historyYearLabel = useMemo(() => {
    const ay = historyYears[historyYearIndex];
    return ay ? `AY ${ay}–${ay + 1}` : "—";
  }, [historyYearIndex, historyYears]);

  const scheduleMeta = useMemo(() => {
    const terms = Array.isArray(schedule?.terms) ? schedule.terms : [];
    const idxFromServer = typeof schedule?.term_index === "number" ? schedule.term_index : -1;
    const idxFromList = terms.findIndex((t: any) => String(t?.term_id ?? "") === String(schedule?.term_id ?? ""));
    const termIndex = idxFromServer >= 0 ? idxFromServer : Math.max(0, idxFromList);

    const term = (schedule?.term as any) || terms[termIndex] || null;
    const ay = term?.acad_year_start;
    const tn = term?.term_number;

    const centerTitle =
      typeof ay === "number"
        ? `AY ${ay}–${ay + 1} · Term ${tn ?? "—"}`
        : tn != null
          ? `Term ${tn}`
          : schedule?.term_id
            ? `Term ${schedule.term_id}`
            : "Term";

    const isActive =
      schedule?.active_term_id != null && String(schedule.active_term_id) === String(schedule?.term_id);

    return { centerTitle, isActive, termIndex, terms };
  }, [schedule]);

  const grouped = useMemo(() => {
    const by: Record<string, FacultyRow[]> = {};
    for (const r of rows) {
      const key = (r.department || "Uncategorized").trim() || "Uncategorized";
      (by[key] ||= []).push(r);
    }

    const entries = Object.entries(by).sort(([a], [b]) => a.localeCompare(b));
    if (department && department !== "All Departments") {
      return [[department, rows]] as Array<[string, FacultyRow[]]>;
    }
    return entries;
  }, [rows, department]);

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Faculty Directory</h1>
        <p className="text-sm text-gray-600">Manage faculty list and their schedules for {termLabel || ""}</p>
      </header>

      {err && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
        <div className="relative flex-1 min-w-[260px]">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            ref={searchRef}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full rounded-lg border border-gray-300 px-9 py-2 pr-8 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => {
                setSearchInput("");
                setSearch("");
                requestAnimationFrame(() => searchRef.current?.focus());
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <SelectBox value={department} onChange={setDepartment} options={deptOptions} />
        <SelectBox value={facultyType} onChange={setFacultyType} options={typeOptions} />
        <SelectBox value={statusFilter} onChange={setStatusFilter} options={statusOptions} />
      </div>

      <section className="space-y-6">
        {loading ? (
          <div className="border border-gray-200 bg-white shadow-sm overflow-visible rounded-xl">
            <table className="w-full table-fixed text-sm">
              <thead className="bg-white border-b text-gray-700">
                <tr>
                  <th className="w-[30%] text-left px-4 py-3">Faculty</th>
                  <th className="w-[12%] text-center px-4 py-3">Faculty Type</th>
                  <th className="w-[22%] text-left px-4 py-3">Certifications</th>
                  <th className="w-[12%] text-center px-4 py-3">Hire Date</th>
                  <th className="w-[10%] text-center px-4 py-3">Teaching Years</th>
                  <th className="w-[10%] text-center px-4 py-3">Status</th>
                  <th className="w-16 text-center px-2 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr>
                  <td className="px-4 py-6 text-center text-gray-500" colSpan={7}>
                    Loading…
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : rows.length === 0 ? (
          <div className="border border-gray-200 bg-white shadow-sm overflow-visible rounded-xl">
            <table className="w-full table-fixed text-sm">
              <thead className="bg-white border-b text-gray-700">
                <tr>
                  <th className="w-[30%] text-left px-4 py-3">Faculty</th>
                  <th className="w-[12%] text-center px-4 py-3">Faculty Type</th>
                  <th className="w-[22%] text-left px-4 py-3">Certifications</th>
                  <th className="w-[12%] text-center px-4 py-3">Hire Date</th>
                  <th className="w-[10%] text-center px-4 py-3">Teaching Years</th>
                  <th className="w-[10%] text-center px-4 py-3">Status</th>
                  <th className="w-16 text-center px-2 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr>
                  <td className="px-4 py-6 text-center text-gray-500" colSpan={7}>
                    No results
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          grouped.map(([dept, items]) => (
            <div key={dept} className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-gray-800">{dept}</h2>
                  <span className="text-xs text-gray-500">{`Showing ${items.length} of ${baselineTotalFaculty || items.length}`}</span>
                </div>
              </div>

              <div className="border border-gray-200 bg-white shadow-sm overflow-visible rounded-xl">
                <div className="overflow-x-auto rounded-xl">
                  <table className="w-full table-fixed text-sm">
                    <thead className="bg-white border-b text-gray-700">
                      <tr>
                        <th className="w-[30%] text-left px-4 py-3">Faculty</th>
                        <th className="w-[12%] text-center px-4 py-3">Faculty Type</th>
                        <th className="w-[22%] text-left px-4 py-3">Certifications</th>
                        <th className="w-[12%] text-center px-4 py-3">Hire Date</th>
                        <th className="w-[10%] text-center px-4 py-3">Teaching Years</th>
                        <th className="w-[10%] text-center px-4 py-3">Status</th>
                        <th className="w-16 text-center px-2 py-3"> </th>
                      </tr>
                    </thead>

                    <tbody className="divide-y">
                      {items.map((r) => {
                        const s = String(r.status || "").toLowerCase();
                        const chip =
                          s.includes("active")
                            ? "bg-emerald-100 text-emerald-700"
                            : s.includes("leave") || s.includes("inactive")
                              ? "bg-amber-100 text-amber-700"
                              : "bg-gray-100 text-gray-700";

                        const cert = summarizeCertifications(r.certifications);

                        const hireDate = (r as any)?.hire_date ? String((r as any).hire_date) : "—";

                        return (
                          <tr key={r.faculty_id} className="hover:bg-gray-50">
                            <td className="px-4 py-3 text-emerald-700 font-semibold">
                              {r.name || "—"}
                              <div className="text-xs text-gray-500">{r.email || "—"}</div>
                            </td>

                            <td className="px-4 py-3 text-center">{r.faculty_type || "—"}</td>

                            <td className="px-4 py-3">
                              <div
                                className="block w-full max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-gray-900"
                                title={cert.full}
                              >
                                {cert.display}
                              </div>
                            </td>

                            <td className="px-4 py-3 text-center whitespace-nowrap">{hireDate}</td>

                            <td className="px-4 py-3 text-center">{(r.teaching_years ?? "—") as any}</td>

                            <td className="px-4 py-3 text-center">
                              <span className={cls("inline-block rounded-full px-3 py-1 text-xs font-semibold", chip)}>
                                {r.status || "—"}
                              </span>
                            </td>

                            <td className="px-2 py-3 text-center">
                              <div
                                className="relative flex items-center justify-center"
                                ref={(node) => {
                                  if (openMenuId === r.faculty_id) openMenuRef.current = node;
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() => setOpenMenuId((cur) => (cur === r.faculty_id ? null : r.faculty_id))}
                                  className={cls(
                                    // No extra "white box" around the 3-dots. Keep it clean and table-native.
                                    "inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-700 hover:bg-gray-100",
                                    openMenuId === r.faculty_id ? "bg-gray-100" : ""
                                  )}
                                  aria-haspopup="menu"
                                  aria-expanded={openMenuId === r.faculty_id}
                                  aria-label="Actions"
                                  title="Actions"
                                >
                                  <MoreVertical className="h-4 w-4" />
                                </button>

                                {openMenuId === r.faculty_id && (
                                  <div
                                    role="menu"
                                    className="absolute right-0 top-11 z-30 w-56 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg"
                                  >
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                                      onClick={() => {
                                        setOpenMenuId(null);
                                        openModal("schedule", r);
                                      }}
                                    >
                                      <Calendar className="h-4 w-4 text-gray-500" />
                                      <span>Schedule</span>
                                    </button>

                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                                      onClick={() => {
                                        setOpenMenuId(null);
                                        openModal("history", r);
                                      }}
                                    >
                                      <BookOpen className="h-4 w-4 text-gray-500" />
                                      <span>Teaching History</span>
                                    </button>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ))
        )}
      </section>

      {/* -------- Schedule / History Modals -------- */}
      {activeModal && selected && (
        <div className="fixed inset-0 z-[2000] grid place-items-center bg-black/40 p-4">
          <div className="relative w-full max-w-screen-xl rounded-2xl bg-white shadow-2xl overflow-y-auto max-h-[90vh]">
            {/* Top-right close (X) */}
            <button
              type="button"
              onClick={closeModal}
              aria-label="Close"
              className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-600 shadow-sm hover:bg-gray-50 hover:text-gray-800"
            >
              <XIcon className="h-5 w-5" />
            </button>

            <div className="p-6 pt-10">
              {!!modalError && (
                <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {modalError}
                </div>
              )}

              {activeModal === "schedule" && (
                <>
                  <div className="text-center mb-4">
                    <h2 className="text-lg font-semibold text-emerald-700">Faculty Schedule</h2>
                    <p className="text-sm text-neutral-500">{selected?.name ?? ""}</p>
                  </div>

                  {/* Term header (Chair-style) */}
                  {!!schedule && (
                    <div className="mb-4">
                      {/* Only show ONE schedule (latest term). No prev/next buttons per UI feedback. */}
                      <div className="flex justify-center">
                        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-1.5">
                          <span className="text-sm font-semibold text-emerald-900">{scheduleMeta.centerTitle}</span>
                          {scheduleMeta.isActive && (
                            <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                              Active
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {!schedule ? (
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
                      Loading schedule…
                    </div>
                  ) : (schedule?.teaching_load || []).length === 0 ? (
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-600">
                      No schedule records found.
                    </div>
                  ) : (
                    renderScheduleTable(schedule?.teaching_load || [])
                  )}
                </>
              )}

              {activeModal === "history" && (
                <>
                  <div className="text-center mb-4">
                    <h2 className="text-lg font-semibold text-emerald-700">Teaching History</h2>
                    <p className="text-sm text-neutral-500">{selected?.name ?? ""}</p>
                  </div>

                  {/* AY header (Chair-style) */}
                  <div className="mb-4">
                    <div className="grid grid-cols-3 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setHistoryYearIndex((i) => Math.min(i + 1, historyYears.length - 1))}
                        disabled={historyYearIndex >= historyYears.length - 1}
                        className={cls(
                          "justify-self-start inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium shadow-sm",
                          historyYearIndex >= historyYears.length - 1
                            ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                            : "bg-white hover:bg-gray-50 text-gray-700"
                        )}
                      >
                        <span>←</span>
                        <span>Previous AY</span>
                      </button>

                      <div className="justify-self-center text-center">
                        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-1.5">
                          <span className="text-sm font-semibold text-emerald-900">{historyYearLabel}</span>
                        </div>
                        {historyYears.length > 0 && (
                          <div className="mt-1 text-xs text-gray-500">
                            {historyYearIndex + 1} of {historyYears.length}
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => setHistoryYearIndex((i) => Math.max(i - 1, 0))}
                        disabled={historyYearIndex <= 0}
                        className={cls(
                          "justify-self-end inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium shadow-sm",
                          historyYearIndex <= 0
                            ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                            : "bg-white hover:bg-gray-50 text-gray-700"
                        )}
                      >
                        <span>Next AY</span>
                        <span>→</span>
                      </button>
                    </div>
                  </div>

                  {!history ? (
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
                      Loading history…
                    </div>
                  ) : (history?.teaching_history || []).length === 0 ? (
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-600">
                      No teaching history found.
                    </div>
                  ) : (
                    renderTeachingHistoryByTerm(history?.teaching_history || [])
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
