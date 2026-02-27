/* ------------- CHAIR_FacultyManagement.tsx ------------- */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import {
  Search as SearchIcon,
  Users,
  Calendar,
  BookOpen,
  Plus,
  Edit,
  Info,
  X as XIcon,
  X,
} from "lucide-react";

import {
  getChairFacultyOptions,
  listChairFaculty,
  getChairFacultySchedule,
  getChairFacultyHistory,
  addChairFacultyEntry,
  type FacultyRow,
  type FMOptions,
  type FacultyUpsertPayload,
  updateChairFacultyEntry,
  getChairFacultyDeloading,
  updateChairFacultyDeloading,
  type ChairDeloadingType,
  type ChairFacultyDeloading,
} from "../../api";

/* ---- Small shared bits (from ADMIN pattern) ---- */
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
    <div className="fixed inset-0 z-50">
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
const TextInput = (p: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input
    {...p}
    className={cls(
      "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/30",
      p.className
    )}
  />
);


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

/* ---- Compact inline action button ---- */
function ActionButton({
  onClick,
  icon,
  label,
}: {
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
      title={label}
      aria-label={label}
    >
      <span className="text-gray-600">{icon}</span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

/* ---------- Schedule + Teaching History table helpers (match OM_FacultyManagement) ---------- */
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
                  {(groups[t] || []).length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-6 text-center text-gray-500">
                        No records
                      </td>
                    </tr>
                  ) : (
                    (groups[t] || []).map((r, idx) => (
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
  teaching_years: string; // stored/legacy value (editable only via hire_date below)
  hire_date: string; // YYYY-MM-DD
};

function calcTeachingYearsFromHireDate(hireDate: string): number | null {
  if (!hireDate) return null;
  // Expecting YYYY-MM-DD from <input type="date" />
  const m = /^\d{4}-\d{2}-\d{2}$/.exec(hireDate.trim());
  if (!m) return null;

  const [y, mo, d] = hireDate.split("-").map((n) => Number(n));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;

  const now = new Date();
  // Whole-year diff with anniversary check.
  let years = now.getFullYear() - y;
  const hasNotReachedAnniversary =
    now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d);
  if (hasNotReachedAnniversary) years -= 1;
  if (years < 0) years = 0;
  return years;
}

export default function CHAIR_FacultyManagement() {
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

  // profile header info
  const [termLabel, setTermLabel] = useState<string>("");
  const [activeTermId, setActiveTermId] = useState<string>("");
  
  // ---------------------------------------

  // table rows
  const [rows, setRows] = useState<FacultyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  // baseline counts (used for "Showing X of Y" when search is active)
  const [baselineTotal, setBaselineTotal] = useState<number | null>(null);
  const [baselineDeptCounts, setBaselineDeptCounts] = useState<Record<string, number>>({});

  // refetch token
  const [reloadToken, setReloadToken] = useState(0);

  // modals
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [selected, setSelected] = useState<FacultyRow | null>(null);

  // modal data
  const [schedule, setSchedule] = useState<any>(null);

  // Academic years for Teaching History (same as OM)
  const [academicYears, setAcademicYears] = useState<number[]>([]);

  // Teaching history (OM-style: flat rows w/ term field)
  const [history, setHistory] = useState<{ teaching_history: HistRow[] } | null>(null);
  const [historyYearIndex, setHistoryYearIndex] = useState(0);

  // Add / Edit Faculty forms
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

  const [editOpen, setEditOpen] = useState<FacultyRow | null>(null);
  const [editForm, setEditForm] = useState<EditFacultyForm | null>(null);
  const [editError, setEditError] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const computedEditTeachingYears = useMemo(() => {
    if (!editForm) return null;
    return calcTeachingYearsFromHireDate(editForm.hire_date);
  }, [editForm]);

  // Deloading (Edit Faculty Details)
  const [deloadingTypes, setDeloadingTypes] = useState<ChairDeloadingType[]>([]);
  const [editDeloading, setEditDeloading] = useState<ChairFacultyDeloading | null>(null);
  const [deloadingLoading, setDeloadingLoading] = useState(false);

  const deptChoices = useMemo(
    () => deptOptions.filter((d) => d && d !== "All Departments"),
    [deptOptions]
  );

  const openAddFaculty = () => {
    setAddForm(emptyAddForm);
    setAddError("");
    setAddOpen(true);
  };

  const submitAddFaculty = async () => {
    const { first_name, last_name, email, department, employment_type, certifications, teaching_years } =
      addForm;

    const trimmedEmail = email.trim();
    if (!first_name.trim() || !last_name.trim() || !trimmedEmail || !department || !employment_type) {
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
        department,
        employment_type: employment_type as "FT" | "PT",
      };
      const certs = (certifications || "").trim();
      if (certs) payload.certifications = certs.split(",").map((c) => c.trim()).filter(Boolean);

      const yearsNum = Number((teaching_years || "").trim());
      if (!Number.isNaN(yearsNum) && (teaching_years || "").trim() !== "") {
        payload.teaching_years = yearsNum;
      }

      const res = await addChairFacultyEntry(payload);
      if (!res || !res.ok) throw new Error("Failed to add faculty.");

      setAddForm(emptyAddForm);
      setAddError("");
      setAddOpen(false);
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
      certifications: Array.isArray((row as any).certifications)
        ? ((row as any).certifications as string[]).join(", ")
        : "",
      teaching_years:
        (row as any).teaching_years != null && (row as any).teaching_years !== ""
          ? String((row as any).teaching_years)
          : "",
      hire_date: (row as any).hire_date ? String((row as any).hire_date) : "",
    });
    setEditError("");

    // Fetch deloading info for active term (best-effort; errors should not block editing).
    (async () => {
      try {
        setDeloadingLoading(true);
        const resp = await getChairFacultyDeloading({
          facultyId: row.faculty_id,
          termId: activeTermId || undefined,
        });
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
    const { first_name, last_name, email, department, employment_type, certifications, teaching_years, hire_date } =
      editForm;

    const trimmedEmail = email.trim();
    if (!first_name.trim() || !last_name.trim() || !trimmedEmail || !department || !employment_type) {
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
        department,
        employment_type: employment_type as "FT" | "PT",
      };
      const certs = (certifications || "").trim();
      if (certs) payload.certifications = certs.split(",").map((c) => c.trim()).filter(Boolean);

      // Prefer hire_date → backend computes and stores teaching_years.
      const computedYears = calcTeachingYearsFromHireDate(hire_date);
      if (hire_date && computedYears != null) {
        payload.hire_date = hire_date;
      } else {
        // Backward compatibility: allow saving existing numeric years if no hire_date is provided.
        const yearsNum = Number((teaching_years || "").trim());
        if (!Number.isNaN(yearsNum) && (teaching_years || "").trim() !== "") {
          payload.teaching_years = yearsNum;
        }
      }

      const res = await updateChairFacultyEntry(editOpen.faculty_id, payload as FacultyUpsertPayload);
      if (!res || !res.ok) throw new Error("Failed to update faculty.");

      // Save deloading edits (type + units). Notes are informational only.
      // Best-effort: if it fails, keep the faculty update and surface a message.
      const dlTypeId = (editDeloading as any)?.type_id;
      const dlUnitsRaw = (editDeloading as any)?.units_deloaded;
      const dlUnits =
        dlUnitsRaw == null || dlUnitsRaw === ""
          ? null
          : typeof dlUnitsRaw === "number"
            ? dlUnitsRaw
            : Number(dlUnitsRaw);

      // Only call update if the edit modal had deloading loaded or user changed fields.
      // If there is no active term id, backend will default to active term.
      if (editDeloading || deloadingTypes.length > 0) {
        await updateChairFacultyDeloading({
          facultyId: editOpen.faculty_id,
          termId: activeTermId || undefined,
          type_id: dlTypeId ?? null,
          units_deloaded: Number.isFinite(dlUnits as number) ? (dlUnits as number) : null,
        });
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

  // Load page options
  useEffect(() => {
    (async () => {
      try {
        const opt: FMOptions = await getChairFacultyOptions();
        if (!opt.ok) throw new Error("Failed to load options");
        setDeptOptions(["All Departments", ...(opt.departments || [])]);
        setTypeOptions(["All Type", ...(opt.facultyTypes || [])]);

        setAcademicYears(opt.academicYears || []);
        
        const ay = opt.activeTerm?.acad_year_start;
        const tn = opt.activeTerm?.term_number;
        const label = ay != null ? `Term ${tn ?? "—"} · AY ${ay}-${ay + 1}` : "";
        setTermLabel(label);
        setActiveTermId(String(opt.activeTerm?.term_id || ""));
      } catch (e: any) {
        setErr(e?.response?.data?.detail || e?.message || "Failed to load options.");
      }
    })();
  }, []);


  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Fetch list rows
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setErr("");
        const { ok, rows } = await listChairFaculty({ department, facultyType, status: statusFilter, search } as any);
        if (!ok) throw new Error("Failed to load faculty list");
        setRows(rows);

        // When search is empty, treat the fetched result as the baseline total.
        if (!search) {
          setBaselineTotal(rows.length);
          const counts: Record<string, number> = {};
          for (const r of rows) {
            const k = (r.department || "Uncategorized").trim() || "Uncategorized";
            counts[k] = (counts[k] || 0) + 1;
          }
          setBaselineDeptCounts(counts);
        }
      } catch (e: any) {
        setRows([]);
        setErr(e?.response?.data?.detail || e?.message || "Failed to load faculty list.");
      } finally {
        setLoading(false);
      }
    })();
  }, [department, facultyType, statusFilter, search, reloadToken]);

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

  // Load Modal Content (match OM_FacultyManagement behavior)
  useEffect(() => {
    (async () => {
      if (!activeModal || !selected) return;
      try {
        if (activeModal === "schedule") {
          const data = await getChairFacultySchedule(selected.faculty_id);
          setSchedule(data);
        } else if (activeModal === "history") {
          const ay = academicYears[historyYearIndex];
          const data = await getChairFacultyHistory(selected.faculty_id, ay);
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

  const searchRef = useRef<HTMLInputElement | null>(null);

  const grouped = useMemo(() => {
    const by: Record<string, FacultyRow[]> = {};
    for (const r of rows) {
      const key = (r.department || "Uncategorized").trim() || "Uncategorized";
      (by[key] ||= []).push(r);
    }

    const entries = Object.entries(by).sort(([a], [b]) => a.localeCompare(b));
    // If a department filter is selected, keep the UI consistent by returning a single group
    if (department && department !== "All Departments") {
      return [[department, rows]] as Array<[string, FacultyRow[]]>;
    }
    return entries;
  }, [rows, department]);

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Faculty Management</h1>
        <p className="text-sm text-gray-600">
          Manage faculty list and their schedules for {termLabel || ""}
        </p>
      </header>

      {err && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}

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

          <button
            type="button"
            onClick={openAddFaculty}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700"
          >
            <Plus className="h-4 w-4" /> Add Faculty
          </button>
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
                  <span className="text-xs text-gray-500">{`Showing ${items.length} of ${baselineDeptCounts[dept] ?? items.length}`}</span>
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

                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <ActionButton
                              onClick={() => openEditFaculty(r)}
                              icon={<Edit className="h-3.5 w-3.5" />}
                              label="Edit"
                            />
                            <ActionButton
                              onClick={() => openModal("schedule", r)}
                              icon={<Calendar className="h-3.5 w-3.5" />}
                              label="Schedule"
                            />
                            <ActionButton
                              onClick={() => openModal("history", r)}
                              icon={<BookOpen className="h-3.5 w-3.5" />}
                              label="History"
                            />
                          </div>
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
        <div className="fixed inset-0 z-[40] grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-screen-xl rounded-2xl bg-white p-6 shadow-2xl overflow-y-auto max-h-[90vh]">
            
            {activeModal === "schedule" && (
              <>
                <div className="text-center mb-4">
                  <h2 className="text-lg font-semibold text-emerald-700">Faculty Schedule</h2>
                  <p className="text-sm text-neutral-500">{selected?.name ?? ""}</p>
                </div>
                {!schedule ? (
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">Loading schedule…</div>
                ) : (schedule?.teaching_load || []).length === 0 ? (
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-600">No schedule records for the current term.</div>
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
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">Loading history…</div>
                ) : (history?.teaching_history || []).length === 0 ? (
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-600">No teaching history found.</div>
                ) : (
                  renderTeachingHistoryByTerm(history?.teaching_history || [])
                )}
              </>
            )}

            <div className="flex justify-end mt-8">
              <button onClick={closeModal} className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* -------- Add/Edit Modals (unchanged structure) -------- */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)}>
        <div className="p-6 sm:p-8">
          <div className="mb-6 flex items-start justify-between">
            <h3 className="text-xl font-semibold text-emerald-700">Add Faculty</h3>
            <button onClick={() => setAddOpen(false)} className="rounded-full p-1 hover:bg-gray-100"><X className="h-5 w-5" /></button>
          </div>
          {addError && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{addError}</div>}
          <div className="grid grid-cols-1 gap-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div><Label>Last Name</Label><TextInput placeholder="e.g., Santos" value={addForm.last_name} onChange={(e) => setAddForm(f => ({...f, last_name: e.target.value}))} /></div>
              <div><Label>First Name</Label><TextInput placeholder="e.g., Maria Ana" value={addForm.first_name} onChange={(e) => setAddForm(f => ({...f, first_name: e.target.value}))} /></div>
            </div>
            <div>
              <Label>Email</Label>
              <TextInput placeholder="name@domain.com" value={addForm.email} onChange={(e) => {
                const v = e.target.value; setAddForm(f => ({...f, email: v}));
              }} />
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div><Label>Department</Label><SelectBox value={addForm.department} onChange={(v) => setAddForm(f => ({...f, department: v || ""}))} options={deptChoices} placeholder="Select Dept" /></div>
              <div><Label>Faculty Type</Label><SelectBox value={addForm.employment_type === "FT" ? "Full-Time" : addForm.employment_type === "PT" ? "Part-Time" : ""} onChange={(v) => setAddForm(f => ({...f, employment_type: v === "Full-Time" ? "FT" : v === "Part-Time" ? "PT" : ""}))} options={["Full-Time", "Part-Time"]} placeholder="Select Type" /></div>
              <div><Label>Certifications</Label><TextInput placeholder="e.g., AWS, Azure" value={addForm.certifications} onChange={(e) => setAddForm(f => ({...f, certifications: e.target.value}))} /></div>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div><Label>Teaching Years</Label><TextInput type="number" min={0} value={addForm.teaching_years} onChange={(e) => setAddForm(f => ({...f, teaching_years: e.target.value}))} /></div>
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={submitAddFaculty} disabled={addSaving} className="rounded-lg bg-emerald-700 px-6 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:bg-emerald-300">
                {addSaving ? "Adding…" : "Add Faculty"}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={!!editOpen} onClose={() => { setEditOpen(null); setEditForm(null); setEditDeloading(null); setDeloadingTypes([]); }}>
        {editOpen && editForm && (
          <div className="p-6 sm:p-8">
            <div className="mb-6 flex items-start justify-between">
              <div>
                <h3 className="text-xl font-semibold text-emerald-700">Edit Faculty Details</h3>
                <div className="mt-1 text-sm text-gray-700">Faculty: <span className="font-medium">{editOpen.name}</span></div>
              </div>
              <button onClick={() => { setEditOpen(null); setEditForm(null); setEditDeloading(null); setDeloadingTypes([]); }} className="rounded-full p-1 hover:bg-gray-100"><X className="h-5 w-5" /></button>
            </div>
            {editError && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{editError}</div>}
            <div className="grid grid-cols-1 gap-5">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div><Label>Last Name</Label><TextInput value={editForm.last_name} onChange={(e) => setEditForm(f => f ? {...f, last_name: e.target.value} : f)} /></div>
                <div><Label>First Name</Label><TextInput value={editForm.first_name} onChange={(e) => setEditForm(f => f ? {...f, first_name: e.target.value} : f)} /></div>
              </div>
              <div>
                <Label>Email</Label>
                <TextInput value={editForm.email} onChange={(e) => {
                  const v = e.target.value; setEditForm(f => f ? {...f, email: v} : f);
                }} />
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div><Label>Department</Label><SelectBox value={editForm.department} onChange={(v) => setEditForm(f => f ? {...f, department: v || ""} : f)} options={deptChoices} /></div>
                <div><Label>Faculty Type</Label><SelectBox value={editForm.employment_type === "FT" ? "Full-Time" : editForm.employment_type === "PT" ? "Part-Time" : ""} onChange={(v) => setEditForm(f => f ? {...f, employment_type: v === "Full-Time" ? "FT" : v === "Part-Time" ? "PT" : ""} : f)} options={["Full-Time", "Part-Time"]} /></div>
                <div><Label>Certifications</Label><TextInput value={editForm.certifications} onChange={(e) => setEditForm(f => f ? {...f, certifications: e.target.value} : f)} /></div>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div>
                  <Label>Hire Date (Start Date)</Label>
                  <TextInput
                    type="date"
                    value={editForm.hire_date}
                    onChange={(e) =>
                      setEditForm((f) => (f ? { ...f, hire_date: e.target.value } : f))
                    }
                  />
                  <div className="mt-1 text-xs text-gray-600">
                    Teaching years will be calculated automatically from this date.
                  </div>
                </div>

                <div>
                  <Label>
                    <span className="inline-flex items-center gap-2">
                      Teaching Years (Calculated)
                      <span
                        className="inline-flex cursor-help items-center text-gray-500"
                        title="Teaching years is calculated based on the hire date."
                      >
                        <Info className="h-4 w-4" />
                      </span>
                    </span>
                  </Label>
                  <TextInput
                    type="text"
                    value={
                      computedEditTeachingYears != null
                        ? String(computedEditTeachingYears)
                        : (editForm.teaching_years || "").trim() || "—"
                    }
                    disabled
                    className="bg-gray-50"
                  />
                </div>
              </div>

              {/* Faculty Deloading (Active Term) */}
              <div className="mt-2 rounded-xl border border-gray-200 bg-gray-50 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-gray-900">Faculty Deloading (Active Term)</div>
                    <div className="text-xs text-gray-600">Type and units are editable. Notes are read-only.</div>
                  </div>
                  {deloadingLoading && <div className="text-xs text-gray-600">Loading…</div>}
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <div className="md:col-span-1">
                    <Label>Deloading Type</Label>
                    <div className={cls("w-full", deloadingLoading ? "pointer-events-none opacity-60" : "")}>
                      <SelectBox
                        value={(() => {
                          const id = (editDeloading as any)?.type_id;
                          const found = deloadingTypes.find((t) => t.type_id === id);
                          return found ? found.type : "— None —";
                        })()}
                        onChange={(v) => {
                          const selected = (v || "").toString();
                          if (!selected || selected === "— None —") {
                            setEditDeloading((cur) => ({ ...(cur || {}), type_id: null }));
                            return;
                          }
                          const found = deloadingTypes.find((t) => t.type === selected);
                          setEditDeloading((cur) => ({ ...(cur || {}), type_id: found?.type_id || null }));
                        }}
                        options={["— None —", ...deloadingTypes.map((t) => t.type)]}
                      />
                    </div>
                  </div>

                  <div className="md:col-span-1">
                    <Label>Units Deloaded</Label>
                    <TextInput
                      type="number"
                      min={0}
                      step="0.5"
                      value={
                        (editDeloading as any)?.units_deloaded == null
                          ? ""
                          : String((editDeloading as any)?.units_deloaded)
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        setEditDeloading((cur) => ({
                          ...(cur || {}),
                          units_deloaded: v === "" ? null : Number(v),
                        }));
                      }}
                      disabled={deloadingLoading}
                    />
                  </div>

                  <div className="md:col-span-3">
                    <Label>Deloading Notes (read-only)</Label>
                    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 whitespace-pre-wrap">
                      {((editDeloading as any)?.notes || "").trim() || "—"}
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <button onClick={submitEditFaculty} disabled={editSaving} className="rounded-lg bg-emerald-700 px-6 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:bg-emerald-300">
                  {editSaving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </main>
  );
}