/* ------------- OM_FacultyManagement.tsx ------------- */
import { useEffect, useMemo, useRef, useState } from "react";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import {
  Search as SearchIcon,
  Users,
  Calendar,
  BookOpen,
  MoreVertical,
  Eye,
  X as XIcon,
} from "lucide-react";

import {
  getFacultyOptions,
  listFaculty,
  getFacultyDetails,
  getFacultySchedule,
  getFacultyHistory,
  type FacultyRow,
  type FMOptions,
  type FacultyDetailsResponse,
} from "../../api";

function InitialsAvatar({ name }: { name: string }) {
  const initials = useMemo(() => {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] ?? "?";
    const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
    return (a + b).toUpperCase();
  }, [name]);

  return (
    <span
      aria-hidden="true"
      className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-gray-100 text-[12px] font-semibold text-gray-700 ring-1 ring-inset ring-gray-200"
    >
      {initials}
    </span>
  );
}

// NOTE: Buttons were replaced by a 3-dots actions dropdown per UI requirements.

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
  type ModalType = null | "details" | "schedule" | "history";

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

  // details modal
  const [details, setDetails] = useState<FacultyDetailsResponse | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
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
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Ensure we always know the total faculty count in the directory (for "X of Y")
  useEffect(() => {
    if (baselineTotalFaculty > 0) return;
    (async () => {
      try {
        const { ok, rows } = await listFaculty({
          department: "All Departments",
          facultyType: "All Type",
          search: "",
        });
        if (ok) setBaselineTotalFaculty((rows || []).length);
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

        const { ok, rows } = await listFaculty({ department, facultyType, search });
        if (!ok) throw new Error("Failed to load faculty list");

        const filtered = (rows || []).filter((r) => {
          if (!statusFilter || statusFilter === "All Status") return true;
          return String(r.status || "").trim().toLowerCase() === statusFilter.toLowerCase();
        });

        setRows(filtered);

        // Set baseline total once from the full directory (no filters/search)
        if (
          baselineTotalFaculty === 0 &&
          department === "All Departments" &&
          facultyType === "All Type" &&
          !search
        ) {
          setBaselineTotalFaculty((rows || []).length);
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
    setDetails(null);
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
    setDetails(null);
    setDetailsLoading(false);
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
        if (activeModal === "details") {
          setDetailsLoading(true);
          const data = await getFacultyDetails(selected.faculty_id);
          setDetails(data);
          setDetailsLoading(false);
        } else if (activeModal === "schedule") {
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
          (activeModal === "details"
            ? "Failed to load faculty details."
            : activeModal === "schedule"
              ? "Failed to load schedule."
              : "Failed to load teaching history.");
        setModalError(String(msg));
        setDetailsLoading(false);
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
    schedule?.active_term_id != null &&
    String(schedule.active_term_id) === String(schedule?.term_id);

  const indexLabel = terms.length ? `${termIndex + 1} of ${terms.length}` : "";

  return { terms, termIndex, centerTitle, isActive, indexLabel };
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

  const searchRef = useRef<HTMLInputElement | null>(null);

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Faculty Directory</h1>
        <p className="text-sm text-gray-600">Manage faculty list and their schedules for {termLabel || ""}</p>
      </header>

      {err && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>
      )}

      {/* Filters (match Chair layout; OM has no Add/Edit) */}
      <div className="sticky top-0 z-10 mb-6 -mx-8 px-8 pt-2">
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-gray-200 bg-white/90 p-4 shadow-sm backdrop-blur">
          <div className="relative flex-1 min-w-[240px]">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              ref={searchRef}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by name or email…"
              className="w-full rounded-lg border border-gray-300 pl-9 pr-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
            />

            {searchInput.trim().length > 0 && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setSearchInput("");
                  setSearch("");
                  requestAnimationFrame(() => searchRef.current?.focus());
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-neutral-500 hover:bg-gray-100 hover:text-neutral-700"
              >
                <XIcon className="h-4 w-4" />
              </button>
            )}
          </div>

          <SelectBox value={department} onChange={setDepartment} options={deptOptions} />
          <SelectBox value={facultyType} onChange={setFacultyType} options={typeOptions} />
          <SelectBox value={statusFilter} onChange={setStatusFilter} options={statusOptions} />
        </div>
      </div>

      <section className="space-y-4">
        {loading ? (
          <div className="grid gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full bg-gray-100" />
                    <div>
                      <div className="h-4 w-48 rounded bg-gray-100" />
                      <div className="mt-2 h-3 w-56 rounded bg-gray-50" />
                    </div>
                  </div>
                  <div className="h-8 w-8 rounded-full bg-gray-50" />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <div className="h-6 w-24 rounded-full bg-gray-50" />
                  <div className="h-6 w-28 rounded-full bg-gray-50" />
                  <div className="h-6 w-20 rounded-full bg-gray-50" />
                  <div className="h-6 w-24 rounded-full bg-gray-50" />
                </div>
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
            <div className="mx-auto mb-2 grid h-12 w-12 place-items-center rounded-2xl bg-gray-50">
              <Users className="h-6 w-6 text-gray-400" />
            </div>
            <div className="text-sm font-medium text-gray-900">No results</div>
            <div className="mt-1 text-sm text-gray-500">Try a different search term or adjust the filters.</div>
          </div>
        ) : (
          grouped.map(([dept, items]) => (
            <div key={dept} className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-gray-900">{dept}</h2>
                  <span className="text-xs text-gray-500">{`Showing ${items.length} of ${baselineTotalFaculty || items.length}`}</span>
                </div>
              </div>

              <div className="grid gap-2">
                {items.map((r) => {
                  const name = r.name || "—";
                  const status = String(r.status || "").toLowerCase();
                  const statusTone = status.includes("active")
                    ? "emerald"
                    : status.includes("inactive")
                      ? "amber"
                      : "gray";

                  return (
                    <div
                      key={r.faculty_id}
                      className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm transition hover:shadow"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex min-w-[240px] items-start gap-3">
                          <InitialsAvatar name={name} />
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-gray-900">{name}</div>
                            <div className="truncate text-xs text-gray-500">{r.email || "—"}</div>
                          </div>
                        </div>

                        <div className="flex-1 min-w-[220px]">
                          <div className="grid grid-cols-3 rounded-xl bg-gray-50 px-3 py-2 text-center divide-x divide-gray-200">
                            <div className="min-w-0 px-2 flex flex-col items-center justify-center">
                              <div className="text-[11px] font-semibold text-gray-500">Units</div>
                              <div className="truncate text-sm font-normal text-gray-900">{r.teaching_units ?? "—"}</div>
                            </div>

                            <div className="min-w-0 px-2 flex flex-col items-center justify-center">
                              <div className="text-[11px] font-semibold text-gray-500">Employment</div>
                              <div className="truncate text-sm font-normal text-gray-900">{r.faculty_type || "—"}</div>
                            </div>

                            <div className="min-w-0 px-2 flex flex-col items-center justify-center">
                              <div className="text-[11px] font-semibold text-gray-500">Status</div>
                              <div
                                className={cls(
                                  "truncate text-sm font-normal",
                                  statusTone === "emerald"
                                    ? "text-emerald-700"
                                    : statusTone === "amber"
                                      ? "text-amber-700"
                                      : "text-gray-700"
                                )}
                              >
                                {r.status || "—"}
                              </div>
                            </div>
                          </div>
                        </div>

                        <div
                          className="relative flex items-center justify-end"
                          ref={(node) => {
                            if (openMenuId === r.faculty_id) openMenuRef.current = node;
                          }}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setOpenMenuId((cur) => (cur === r.faculty_id ? null : r.faculty_id))
                            }
                            className={cls(
                              "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-700 shadow-sm hover:bg-gray-50",
                              openMenuId === r.faculty_id ? "ring-2 ring-emerald-500/30" : ""
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
                                  openModal("details", r);
                                }}
                              >
                                <Eye className="h-4 w-4 text-gray-500" />
                                <span>View more details</span>
                              </button>

                              <div className="h-px bg-gray-100" />

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
                                <span>History</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
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

              {activeModal === "details" && (
                <>
                  <div className="text-center mb-4">
                    <h2 className="text-lg font-semibold text-emerald-700">Faculty Details</h2>
                    <p className="text-sm text-neutral-500">{selected?.name ?? ""}</p>
                  </div>

                  {detailsLoading ? (
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
                      Loading details…
                    </div>
                  ) : !details ? (
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-600">
                      No details found.
                    </div>
                  ) : (
                    <div className="space-y-6">
                      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                        <div className="text-sm font-semibold text-emerald-700 mb-3">Basic Information</div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 text-sm">
                          <div>
                            <div className="text-xs text-gray-500">First Name</div>
                            <div className="font-medium text-gray-900">{details.details.first_name || "—"}</div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500">Last Name</div>
                            <div className="font-medium text-gray-900">{details.details.last_name || "—"}</div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500">Email</div>
                            <div className="font-medium text-gray-900">{details.details.email || "—"}</div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500">Department</div>
                            <div className="font-medium text-gray-900">{details.details.department || "—"}</div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500">Faculty Type</div>
                            <div className="font-medium text-gray-900">{details.details.faculty_type || "—"}</div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500">Hire Date</div>
                            <div className="font-medium text-gray-900">{details.details.hire_date || "—"}</div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500">Teaching Years</div>
                            <div className="font-medium text-gray-900">{details.details.teaching_years ?? "—"}</div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                        <div className="text-sm font-semibold text-emerald-700 mb-3">Certifications</div>
                        {details.details.certifications?.length ? (
                          <div className="flex flex-wrap gap-2">
                            {details.details.certifications.map((c, i) => (
                              <span
                                key={i}
                                className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800"
                              >
                                {c}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <div className="text-sm text-gray-600">—</div>
                        )}
                      </div>

                      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                        <div className="text-sm font-semibold text-emerald-700 mb-3">Deloading (Active Term)</div>
                        {!details.deloading ? (
                          <div className="text-sm text-gray-600">No deloading record for the active term.</div>
                        ) : (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 text-sm">
                            <div className="md:col-span-2">
                              <div className="text-xs text-gray-500">Term</div>
                              <div className="font-medium text-gray-900">{details.deloading.term_label || details.deloading.term_id}</div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500">Type</div>
                              <div className="font-medium text-gray-900">{details.deloading.deloading_type || "—"}</div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500">Units Deloaded</div>
                              <div className="font-medium text-gray-900">{details.deloading.units_deloaded ?? "—"}</div>
                            </div>
                            <div className="md:col-span-2">
                              <div className="text-xs text-gray-500">Notes</div>
                              <div className="font-medium text-gray-900">{details.deloading.notes || "—"}</div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
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
                      <div className="grid grid-cols-3 items-center gap-2">
                        <button
                          type="button"
                          onClick={async () => {
                            const i = scheduleMeta.termIndex - 1;
                            if (!selected || i < 0) return;
                            const tid = scheduleMeta.terms?.[i]?.term_id;
                            if (!tid) return;
                            setSchedule(null);
                            const facKey = (selected as any)?.user_id || selected.faculty_id;
                            const data = await getFacultySchedule(facKey, tid);
                            setSchedule(data);
                          }}
                          disabled={scheduleMeta.termIndex <= 0}
                          className={cls(
                            "justify-self-start inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium shadow-sm",
                            scheduleMeta.termIndex <= 0
                              ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                              : "bg-white hover:bg-gray-50 text-gray-700"
                          )}
                        >
                          <span>←</span>
                          <span>Previous Term</span>
                        </button>

                        <div className="justify-self-center text-center">
                          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-1.5">
                            <span className="text-sm font-semibold text-emerald-900">{scheduleMeta.centerTitle}</span>
                            {scheduleMeta.isActive && (
                              <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                                Active
                              </span>
                            )}
                          </div>
                          {scheduleMeta.indexLabel && (
                            <div className="mt-1 text-xs text-gray-500">{scheduleMeta.indexLabel}</div>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={async () => {
                            const i = scheduleMeta.termIndex + 1;
                            if (!selected || i >= (scheduleMeta.terms?.length || 0)) return;
                            const tid = scheduleMeta.terms?.[i]?.term_id;
                            if (!tid) return;
                            setSchedule(null);
                            const facKey = (selected as any)?.user_id || selected.faculty_id;
                            const data = await getFacultySchedule(facKey, tid);
                            setSchedule(data);
                          }}
                          disabled={scheduleMeta.termIndex >= (scheduleMeta.terms?.length || 0) - 1}
                          className={cls(
                            "justify-self-end inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium shadow-sm",
                            scheduleMeta.termIndex >= (scheduleMeta.terms?.length || 0) - 1
                              ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                              : "bg-white hover:bg-gray-50 text-gray-700"
                          )}
                        >
                          <span>Next Term</span>
                          <span>→</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {!schedule ? (
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
                      Loading schedule…
                    </div>
                  ) : (schedule?.teaching_load || []).length === 0 ? (
                    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-600">
                      No schedule records for the selected term.
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