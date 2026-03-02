/* ------------- CHAIR_FacultyManagement.tsx ------------- */
/**
 * Goal: Match OM_FacultyManagement UI/flow (table grouped by department + 3-dot Actions menu),
 * while keeping CHAIR add/edit faculty capabilities.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type InputHTMLAttributes } from "react";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import {
  Search as SearchIcon,
  Calendar,
  BookOpen,
  MoreVertical,
  Plus,
  Edit,
  X as XIcon,
  X,
  Info,
} from "lucide-react";

import {
  getChairFacultyOptions,
  listChairFaculty,
  getChairFacultySchedule,
  getChairFacultyHistory,
  addChairFacultyEntry,
  updateChairFacultyEntry,
  getChairFacultyDeloading,
  updateChairFacultyDeloading,
  type FacultyRow,
  type FMOptions,
  type FacultyUpsertPayload,
  type ChairDeloadingType,
  type ChairFacultyDeloading,
} from "../../api";

/* ---- Small shared bits (from CHAIR pattern) ---- */
function Modal({
  open,
  onClose,
  children,
  width = "max-w-3xl",
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[2100]">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute inset-0 grid place-items-center p-4">
        <div className={cls("w-full rounded-2xl bg-white shadow-2xl", width)}>{children}</div>
      </div>
    </div>
  );
}

const Label = ({ children }: { children: ReactNode }) => (
  <label className="mb-1 block text-sm font-semibold text-gray-800">{children}</label>
);

const TextInput = (p: InputHTMLAttributes<HTMLInputElement>) => (
  <input
    {...p}
    className={cls(
      "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30",
      p.className
    )}
  />
);

/* ---------- Schedule + Teaching History table helpers (OM style) ---------- */
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
  if (arr.length === 0) return { display: "—", full: "—" };
  if (arr.length <= 2) return { display: full, full };
  return { display: `${arr.slice(0, 2).join(", ")} +${arr.length - 2}`, full };
}

/**
 * Display hire dates as: "January 1, 2008".
 *
 * Backend typically returns YYYY-MM-DD; we parse the date portion and format
 * in a timezone-safe way (avoids UTC shifting).
 */
function formatHireDateDisplay(raw: any): string {
  if (raw === null || raw === undefined) return "—";
  const s = String(raw).trim();
  if (!s) return "—";

  // Prefer parsing the date-only portion to avoid timezone shifts.
  const m = /^\d{4}-\d{2}-\d{2}/.exec(s);
  let dt: Date | null = null;
  if (m) {
    const [y, mo, d] = m[0].split("-").map((n) => Number(n));
    if (Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d)) {
      dt = new Date(y, mo - 1, d);
    }
  } else {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) dt = new Date(t);
  }

  if (!dt || Number.isNaN(dt.getTime())) return s; // fallback keeps legacy values visible

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(dt);
}

/* ---------------- Add/Edit forms (CHAIR) ---------------- */
type AddFacultyForm = {
  first_name: string;
  last_name: string;
  email: string;
  department: string;
  employment_type: "" | "FT" | "PT";
  certifications: string;
  teaching_years: string;
};

type EditFacultyForm = {
  first_name: string;
  last_name: string;
  email: string;
  department: string;
  employment_type: "" | "FT" | "PT";
  certifications: string;
  teaching_years: string;
  hire_date: string; // YYYY-MM-DD
};

function calcTeachingYearsFromHireDate(hireDate: string): number | null {
  if (!hireDate) return null;
  const m = /^\d{4}-\d{2}-\d{2}$/.exec(hireDate.trim());
  if (!m) return null;

  const [y, mo, d] = hireDate.split("-").map((n) => Number(n));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;

  const now = new Date();
  let years = now.getFullYear() - y;
  const hasNotReachedAnniversary =
    now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d);
  if (hasNotReachedAnniversary) years -= 1;
  if (years < 0) years = 0;
  return years;
}

/* ---------------- Page ---------------- */
export default function CHAIR_FacultyManagement() {
  type ModalType = null | "schedule" | "history";

  // filters (match OM)
  const [department, setDepartment] = useState("All Departments");
  const [facultyType, setFacultyType] = useState("All Type");
  const [statusFilter, setStatusFilter] = useState("All Status");

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // options
  const [deptOptions, setDeptOptions] = useState<string[]>(["All Departments"]);
  const [typeOptions, setTypeOptions] = useState<string[]>(["All Type"]);
  const statusOptions = useMemo(() => ["All Status", "Active", "On Leave"], []);

  const [academicYears, setAcademicYears] = useState<number[]>([]);
  const [termLabel, setTermLabel] = useState("");
  const [activeTermId, setActiveTermId] = useState("");

  // rows
  const [rows, setRows] = useState<FacultyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  // baseline total count for “Showing X of Y”
  const [baselineTotalFaculty, setBaselineTotalFaculty] = useState<number>(0);

  // actions dropdown (3-dots)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const openMenuRef = useRef<HTMLDivElement | null>(null);

  // schedule/history modals
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [selected, setSelected] = useState<FacultyRow | null>(null);
  const [schedule, setSchedule] = useState<any>(null);
  const [history, setHistory] = useState<{ teaching_history: HistRow[] } | null>(null);
  const [historyYearIndex, setHistoryYearIndex] = useState(0);
  const [modalError, setModalError] = useState("");

  // force reload
  const [reloadToken, setReloadToken] = useState(0);

  // add faculty
  const emptyAddForm: AddFacultyForm = {
    first_name: "",
    last_name: "",
    email: "",
    department: "",
    employment_type: "",
    certifications: "",
    teaching_years: "",
  };
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddFacultyForm>(emptyAddForm);
  const [addError, setAddError] = useState("");
  const [addSaving, setAddSaving] = useState(false);

  // edit faculty
  const [editOpen, setEditOpen] = useState<FacultyRow | null>(null);
  const [editForm, setEditForm] = useState<EditFacultyForm | null>(null);
  const [editError, setEditError] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // deloading (edit modal)
  const [editDeloading, setEditDeloading] = useState<ChairFacultyDeloading | null>(null);
  const [deloadingTypes, setDeloadingTypes] = useState<ChairDeloadingType[]>([]);
  const [deloadingLoading, setDeloadingLoading] = useState(false);

  const computedEditTeachingYears = useMemo(() => {
    if (!editForm) return null;
    return calcTeachingYearsFromHireDate(editForm.hire_date);
  }, [editForm?.hire_date]);

  // options
  useEffect(() => {
    (async () => {
      try {
        const opt: FMOptions = await getChairFacultyOptions();
        if (!opt.ok) throw new Error("Failed to load options");

        setDeptOptions(["All Departments", ...(opt.departments || [])]);
        setTypeOptions(["All Type", ...(opt.facultyTypes || [])]);

        const ay = opt.activeTerm?.acad_year_start;
        const tn = opt.activeTerm?.term_number;
        setTermLabel(ay ? `Term ${tn ?? "—"} · AY ${ay}-${ay + 1}` : "");

        const years = Array.isArray(opt.academicYears) ? opt.academicYears : [];
        setAcademicYears(years);
        setHistoryYearIndex(0);

        setActiveTermId(opt.activeTerm?.term_id ? String(opt.activeTerm.term_id) : "");
      } catch (e: any) {
        setErr(e?.response?.data?.detail || e?.message || "Failed to load options.");
      }
    })();
  }, []);

  // debounce search
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Ensure baseline total faculty count is known (X of Y)
  useEffect(() => {
    if (baselineTotalFaculty > 0) return;
    (async () => {
      try {
        const { ok, rows: allRows } = await listChairFaculty({
          department: "All Departments",
          facultyType: "All Type",
          search: "",
        });
        if (ok) setBaselineTotalFaculty((allRows || []).length);
      } catch {
        // ignore baseline fetch errors
      }
    })();
  }, [baselineTotalFaculty]);

  // Close 3-dot menu on outside click / ESC
  useEffect(() => {
    if (!openMenuId) return;

    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (openMenuRef.current && !openMenuRef.current.contains(target)) setOpenMenuId(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenMenuId(null);

    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenuId]);

  // Fetch rows (status filter is client-side, match OM)
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setErr("");

        const { ok, rows: fetchedRows } = await listChairFaculty({ department, facultyType, search });
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
  }, [department, facultyType, statusFilter, search, baselineTotalFaculty, reloadToken]);

  const openModal = (type: Exclude<ModalType, null>, item: FacultyRow) => {
    setSelected(item);
    setModalError("");
    if (type === "history") {
      // default to first AY, if available
      setHistoryYearIndex(0);
      setHistory(null);
    }
    if (type === "schedule") setSchedule(null);
    setActiveModal(type);
  };

  const closeModal = () => {
    setActiveModal(null);
    setModalError("");
    setSelected(null);
    setSchedule(null);
    setHistory(null);
    setOpenMenuId(null);
  };

  // Load schedule/history modal content
  useEffect(() => {
    (async () => {
      if (!activeModal || !selected) return;
      try {
        const facKey = (selected as any)?.user_id || selected?.user_id || selected.faculty_id;

        if (activeModal === "schedule") {
          const data = await getChairFacultySchedule(String(facKey));
          setSchedule(data);
        } else if (activeModal === "history") {
          const ay = academicYears[historyYearIndex];
          const data = await getChairFacultyHistory(String(facKey), ay);
          setHistory({ teaching_history: (data as any)?.teaching_history || [] });
        }
      } catch (e: any) {
        const msg =
          e?.message ||
          (activeModal === "schedule" ? "Failed to load schedule." : "Failed to load teaching history.");
        setModalError(String(msg));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal, selected, historyYearIndex, academicYears]);

  const historyYearLabel = useMemo(() => {
    const ay = academicYears[historyYearIndex];
    return ay ? `AY ${ay}–${ay + 1}` : "—";
  }, [historyYearIndex, academicYears]);

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

  // group by department (match OM)
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

  // ---- Add/Edit handlers (CHAIR) ----
  const openAddFaculty = () => {
    setAddError("");
    setAddForm({
      ...emptyAddForm,
      department: department !== "All Departments" ? department : "",
    });
    setAddOpen(true);
  };

  const submitAddFaculty = async () => {
    const { first_name, last_name, email, department: dept, employment_type, certifications, teaching_years } = addForm;
    const trimmedEmail = email.trim();

    if (!first_name.trim() || !last_name.trim() || !trimmedEmail || !dept || !employment_type) {
      setAddError("Please fill out all required fields.");
      return;
    }

    setAddError("");
    setAddSaving(true);
    try {
      const payload: FacultyUpsertPayload = {
        first_name: first_name.trim(),
        last_name: last_name.trim(),
        email: trimmedEmail.toLowerCase(),
        department: dept,
        employment_type: employment_type as "FT" | "PT",
      };

      const certs = (certifications || "").trim();
      if (certs) {
        payload.certifications = certs
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }

      const ty = (teaching_years || "").trim();
      if (ty) {
        const n = Number(ty);
        if (Number.isFinite(n)) payload.teaching_years = n;
      }

      const res = await addChairFacultyEntry(payload);
      if (!res?.ok) throw new Error("Failed to add faculty.");

      setAddOpen(false);
      setAddForm(emptyAddForm);
      setReloadToken((t) => t + 1);
    } catch (e: any) {
      setAddError(e?.response?.data?.detail || e?.message || "Error adding faculty.");
    } finally {
      setAddSaving(false);
    }
  };

  const openEditFaculty = (row: FacultyRow) => {
    const fullName = (row.name || "").trim();
    let first_name = "";
    let last_name = "";
    if (fullName) {
      const parts = fullName.split(/\s+/);
      if (parts.length === 1) first_name = parts[0];
      else {
        last_name = parts[parts.length - 1];
        first_name = parts.slice(0, -1).join(" ");
      }
    }

    let employment_type: "" | "FT" | "PT" = "";
    const ftDisplay = (row.faculty_type || "").toLowerCase();
    if (ftDisplay.includes("full")) employment_type = "FT";
    else if (ftDisplay.includes("part")) employment_type = "PT";
    else if (ftDisplay === "ft" || ftDisplay === "pt") employment_type = ftDisplay.toUpperCase() as "FT" | "PT";

    setEditOpen(row);
    setEditForm({
      first_name,
      last_name,
      email: row.email || "",
      department: row.department || "",
      employment_type,
      certifications: Array.isArray((row as any).certifications) ? ((row as any).certifications as string[]).join(", ") : "",
      teaching_years: (row as any).teaching_years != null && (row as any).teaching_years !== "" ? String((row as any).teaching_years) : "",
      hire_date: (row as any).hire_date ? String((row as any).hire_date) : "",
    });
    setEditError("");

    // best-effort: deloading for active term
    (async () => {
      try {
        setDeloadingLoading(true);
        const resp = await getChairFacultyDeloading({ facultyId: row.faculty_id, termId: activeTermId || undefined });
        setDeloadingTypes(Array.isArray(resp?.types) ? resp.types : []);
        setEditDeloading(resp?.current ?? null);
      } catch {
        setDeloadingTypes([]);
        setEditDeloading(null);
      } finally {
        setDeloadingLoading(false);
      }
    })();
  };

  const submitEditFaculty = async () => {
    if (!editOpen || !editForm) return;
    const { first_name, last_name, email, department: dept, employment_type, certifications, hire_date } = editForm;

    const trimmedEmail = email.trim();
    if (!first_name.trim() || !last_name.trim() || !trimmedEmail || !dept || !employment_type) {
      setEditError("Please fill out all required fields.");
      return;
    }

    setEditError("");
    setEditSaving(true);

    try {
      const payload: any = {
        first_name: first_name.trim(),
        last_name: last_name.trim(),
        email: trimmedEmail.toLowerCase(),
        department: dept,
        employment_type: employment_type as "FT" | "PT",
      };

      // Persist hire date; backend normalizes YYYY-MM-DD and computes teaching years from it.
      payload.hire_date = (hire_date || "").trim();


      const certs = (certifications || "").trim();
      if (certs) {
        payload.certifications = certs
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
      }

      // Teaching years is derived from hire date on backend; we pass computed value if valid.
      const tyComputed = calcTeachingYearsFromHireDate(hire_date);
      if (typeof tyComputed === "number" && Number.isFinite(tyComputed)) payload.teaching_years = tyComputed;

      await updateChairFacultyEntry(editOpen.faculty_id, payload as FacultyUpsertPayload);

      
// Update deloading (best-effort)
try {
  if (activeTermId) {
    await updateChairFacultyDeloading({
      facultyId: editOpen.faculty_id,
      termId: activeTermId,
      type_id: editDeloading?.type_id ?? null,
      units_deloaded: editDeloading?.units_deloaded ?? null,
    });
  }
} catch {
  // ignore deloading errors (do not block save)
}

      setEditOpen(null);
      setEditForm(null);
      setEditError("");
      setEditDeloading(null);
      setDeloadingTypes([]);

      setReloadToken((t) => t + 1);
    } catch (e: any) {
      setEditError(e?.response?.data?.detail || e?.message || "Error updating faculty.");
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Faculty Directory</h1>
        <p className="text-sm text-gray-600">Manage faculty list and their schedules for {termLabel || ""}</p>
      </header>

      {err && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>
      )}

      {/* Filters (match OM) */}
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

        <button
          type="button"
          onClick={openAddFaculty}
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700"
        >
          <Plus className="h-4 w-4" /> Add Faculty
        </button>
      </div>

      <section className="space-y-6">
        {loading ? (
          <div className="border border-gray-200 bg-white shadow-sm overflow-visible rounded-xl">
            <table className="w-full table-fixed text-sm">
              <thead className="bg-gray-50 border-b text-gray-900">
                <tr>
                  <th className="w-[14.2857%] text-left px-4 py-2">Faculty</th>
                  <th className="w-[14.2857%] text-center px-4 py-2">Faculty Type</th>
                  <th className="w-[14.2857%] text-left px-4 py-2">Certifications</th>
                  <th className="w-[14.2857%] text-center px-4 py-2">Hire Date</th>
                  <th className="w-[14.2857%] text-center px-4 py-2">Teaching Years</th>
                  <th className="w-[14.2857%] text-center px-4 py-2">Status</th>
                  <th className="w-[14.2857%] text-center px-2 py-2">Actions</th>
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
              <thead className="bg-gray-50 border-b text-gray-900">
                <tr>
                  <th className="w-[14.2857%] text-left px-4 py-2">Faculty</th>
                  <th className="w-[14.2857%] text-center px-4 py-2">Faculty Type</th>
                  <th className="w-[14.2857%] text-left px-4 py-2">Certifications</th>
                  <th className="w-[14.2857%] text-center px-4 py-2">Hire Date</th>
                  <th className="w-[14.2857%] text-center px-4 py-2">Teaching Years</th>
                  <th className="w-[14.2857%] text-center px-4 py-2">Status</th>
                  <th className="w-[14.2857%] text-center px-2 py-2">Actions</th>
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
                    <thead className="bg-gray-50 border-b text-gray-900">
                      <tr>
                        <th className="w-[14.2857%] text-left px-4 py-2">Faculty</th>
                        <th className="w-[14.2857%] text-center px-4 py-2">Faculty Type</th>
                        <th className="w-[14.2857%] text-left px-4 py-2">Certifications</th>
                        <th className="w-[14.2857%] text-center px-4 py-2">Hire Date</th>
                        <th className="w-[14.2857%] text-center px-4 py-2">Teaching Years</th>
                        <th className="w-[14.2857%] text-center px-4 py-2">Status</th>
                        <th className="w-[14.2857%] text-center px-2 py-2">Actions</th>
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

                        const cert = summarizeCertifications((r as any).certifications);
                        const hireDate = formatHireDateDisplay((r as any)?.hire_date);

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

                            <td className="px-4 py-3 text-center">{((r as any).teaching_years ?? "—") as any}</td>

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
                                        openEditFaculty(r);
                                      }}
                                    >
                                      <Edit className="h-4 w-4 text-gray-500" />
                                      <span>Edit Faculty</span>
                                    </button>

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

      {/* -------- Schedule / History Modals (OM style) -------- */}
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

                  {!!schedule && (
                    <div className="mb-4">
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

                  <div className="flex justify-between items-center mb-4">
                    <button
                      onClick={() => setHistoryYearIndex((i) => Math.min(i + 1, academicYears.length - 1))}
                      disabled={historyYearIndex >= academicYears.length - 1}
                      className={cls(
                        "px-3 py-1.5 rounded-lg text-sm font-medium border shadow-sm",
                        historyYearIndex >= academicYears.length - 1
                          ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                          : "bg-white hover:bg-gray-50 text-gray-700"
                      )}
                    >
                      ← Previous
                    </button>

                    <span className="text-base font-semibold text-gray-800">{historyYearLabel}</span>

                    <button
                      onClick={() => setHistoryYearIndex((i) => Math.max(i - 1, 0))}
                      disabled={historyYearIndex <= 0}
                      className={cls(
                        "px-3 py-1.5 rounded-lg text-sm font-medium border shadow-sm",
                        historyYearIndex <= 0
                          ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                          : "bg-white hover:bg-gray-50 text-gray-700"
                      )}
                    >
                      Next →
                    </button>
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

      {/* ---------------- Add Faculty Modal ---------------- */}
      <Modal
        open={addOpen}
        onClose={() => {
          if (addSaving) return;
          setAddOpen(false);
        }}
        width="max-w-2xl"
      >
        <div className="p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold text-emerald-700">Add Faculty</h2>
              <p className="text-sm text-gray-500">Create a new faculty entry.</p>
            </div>
            <button
              type="button"
              onClick={() => !addSaving && setAddOpen(false)}
              className="rounded-full p-1 hover:bg-gray-100"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {addError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {addError}
            </div>
          )}

          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label>Last Name</Label>
              <TextInput value={addForm.last_name} onChange={(e) => setAddForm((f) => ({ ...f, last_name: e.target.value }))} />
            </div>
            <div>
              <Label>First Name</Label>
              <TextInput value={addForm.first_name} onChange={(e) => setAddForm((f) => ({ ...f, first_name: e.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <Label>Email</Label>
              <TextInput
                value={addForm.email}
                onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="name@dlsu.edu.ph"
              />
            </div>
            <div>
              <Label>Department</Label>
              <SelectBox
                value={addForm.department}
                onChange={(v) => setAddForm((f) => ({ ...f, department: v || "" }))}
                options={deptOptions.filter((d) => d !== "All Departments")}
              />
            </div>
            <div>
              <Label>Faculty Type</Label>
              <SelectBox
                value={addForm.employment_type === "FT" ? "Full-Time" : addForm.employment_type === "PT" ? "Part-Time" : ""}
                onChange={(v) =>
                  setAddForm((f) => ({
                    ...f,
                    employment_type: v === "Full-Time" ? "FT" : v === "Part-Time" ? "PT" : "",
                  }))
                }
                options={["Full-Time", "Part-Time"]}
              />
            </div>
            <div className="sm:col-span-2">
              <Label>Certifications</Label>
              <TextInput
                value={addForm.certifications}
                onChange={(e) => setAddForm((f) => ({ ...f, certifications: e.target.value }))}
                placeholder="Comma-separated (optional)"
              />
            </div>
            <div className="sm:col-span-2">
              <Label>Teaching Years</Label>
              <TextInput
                value={addForm.teaching_years}
                onChange={(e) => setAddForm((f) => ({ ...f, teaching_years: e.target.value }))}
                placeholder="Optional"
              />
            </div>
          </div>

          <div className="mt-6 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => !addSaving && setAddOpen(false)}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={addSaving}
              onClick={() => void submitAddFaculty()}
              className={cls(
                "rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700",
                addSaving && "opacity-70 cursor-not-allowed"
              )}
            >
              {addSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ---------------- Edit Faculty Modal ---------------- */}
      <Modal
        open={!!editOpen}
        onClose={() => {
          if (editSaving) return;
          setEditOpen(null);
          setEditForm(null);
          setEditDeloading(null);
          setDeloadingTypes([]);
        }}
        width="max-w-3xl"
      >
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-emerald-700">Edit Faculty Details</h2>
              <p className="text-sm text-gray-500">{editOpen?.name || ""}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                if (editSaving) return;
                setEditOpen(null);
                setEditForm(null);
                setEditDeloading(null);
                setDeloadingTypes([]);
              }}
              className="rounded-full p-1 hover:bg-gray-100"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {editError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {editError}
            </div>
          )}

          {editForm && (
            <div className="mt-5 space-y-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Label>Last Name</Label>
                  <TextInput value={editForm.last_name} onChange={(e) => setEditForm((f) => (f ? { ...f, last_name: e.target.value } : f))} />
                </div>
                <div>
                  <Label>First Name</Label>
                  <TextInput value={editForm.first_name} onChange={(e) => setEditForm((f) => (f ? { ...f, first_name: e.target.value } : f))} />
                </div>

                <div className="sm:col-span-2">
                  <Label>Email</Label>
                  <TextInput
                    value={editForm.email}
                    onChange={(e) => setEditForm((f) => (f ? { ...f, email: e.target.value } : f))}
                  />
                </div>

                <div>
                  <Label>Department</Label>
                  <SelectBox
                    value={editForm.department}
                    onChange={(v) => setEditForm((f) => (f ? { ...f, department: v || "" } : f))}
                    options={deptOptions.filter((d) => d !== "All Departments")}
                  />
                </div>

                <div>
                  <Label>Faculty Type</Label>
                  <SelectBox
                    value={editForm.employment_type === "FT" ? "Full-Time" : editForm.employment_type === "PT" ? "Part-Time" : ""}
                    onChange={(v) =>
                      setEditForm((f) =>
                        f
                          ? {
                              ...f,
                              employment_type: v === "Full-Time" ? "FT" : v === "Part-Time" ? "PT" : "",
                            }
                          : f
                      )
                    }
                    options={["Full-Time", "Part-Time"]}
                  />
                </div>

                <div className="sm:col-span-2">
                  <Label>Certifications</Label>
                  <TextInput
                    value={editForm.certifications}
                    onChange={(e) => setEditForm((f) => (f ? { ...f, certifications: e.target.value } : f))}
                    placeholder="Comma-separated"
                  />
                </div>

                <div className="sm:col-span-2">
                  <Label>
                    Hire Date{" "}
                    <span className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-gray-500">
                      <Info className="h-3.5 w-3.5" /> used to compute Teaching Years
                    </span>
                  </Label>
                  <TextInput
                    type="date"
                    value={editForm.hire_date}
                    onChange={(e) => setEditForm((f) => (f ? { ...f, hire_date: e.target.value } : f))}
                  />
                  <div className="mt-1 text-xs text-gray-500">
                    Teaching Years:{" "}
                    <span className="font-semibold text-gray-800">
                      {computedEditTeachingYears == null ? "—" : computedEditTeachingYears}
                    </span>
                  </div>
                </div>
              </div>

              {/* Deloading (optional) */}
              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                <div className="mb-2 text-sm font-semibold text-gray-800">Deloading (optional)</div>
                {deloadingLoading ? (
                  <div className="text-sm text-gray-600">Loading deloading…</div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div className="sm:col-span-1">
                      <Label>Type</Label>
                      <SelectBox
                        value={
                          editDeloading?.type_id
                            ? deloadingTypes.find((t) => t.type_id === editDeloading.type_id)?.type || ""
                            : ""
                        }
                        onChange={(v) => {
                          const found = deloadingTypes.find((t) => t.type === v);
                          if (!found) {
                            setEditDeloading((cur) => ({ ...(cur || {}), type_id: null }));
                          } else {
                            setEditDeloading((cur) => ({ ...(cur || {}), type_id: found.type_id }));
                          }
                        }}
                        options={["", ...deloadingTypes.map((t) => t.type)]}
                      />
                    </div>
                    <div className="sm:col-span-1">
                      <Label>Units Deloaded</Label>
                      <TextInput
                        type="number"
                        value={editDeloading?.units_deloaded != null ? String(editDeloading.units_deloaded) : ""}
                        onChange={(e) => {
                          const n = e.target.value === "" ? null : Number(e.target.value);
                          setEditDeloading((cur) => ({ ...(cur || {}), units_deloaded: Number.isFinite(n as any) ? (n as any) : null }));
                        }}
                        placeholder="e.g. 3"
                      />
                    </div>
                    <div className="sm:col-span-1">
                      <Label>Notes</Label>
                      <TextInput
                        value={(editDeloading?.notes ?? "") as any}
                        onChange={(e) => setEditDeloading((cur) => ({ ...(cur || {}), notes: e.target.value }))}
                        placeholder="Optional"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (editSaving) return;
                    setEditOpen(null);
                    setEditForm(null);
                    setEditDeloading(null);
                    setDeloadingTypes([]);
                  }}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm hover:bg-gray-50"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  disabled={editSaving}
                  onClick={() => void submitEditFaculty()}
                  className={cls(
                    "rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700",
                    editSaving && "opacity-70 cursor-not-allowed"
                  )}
                >
                  {editSaving ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </main>
  );
}
