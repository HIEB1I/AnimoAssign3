/* ------------- CHAIR_FacultyManagement.tsx ------------- */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import {
  Search as SearchIcon,
  MoreVertical,
  Calendar,
  BookOpen,
  Plus,
  PencilLine,
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

/* ---- Row actions menu ---- */
function ActionMenu({
  onEdit,
  onViewSchedule,
  onViewHistory,
}: {
  onEdit: () => void;
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
        <div className="absolute right-0 mt-2 w-52 rounded-xl border border-gray-200 bg-white shadow-xl py-1 text-left z-50">
          <button
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            <PencilLine className="h-4 w-4" /> <span>Edit Faculty Details</span>
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
  teaching_years: string;
};

export default function CHAIR_FacultyManagement() {
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

  // profile header info
  const [termLabel, setTermLabel] = useState<string>("");
  
  // ---------------------------------------

  // table rows
  const [rows, setRows] = useState<FacultyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

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
  const [addEmailError, setAddEmailError] = useState("");
  const [addError, setAddError] = useState("");
  const [addSaving, setAddSaving] = useState(false);

  const [editOpen, setEditOpen] = useState<FacultyRow | null>(null);
  const [editForm, setEditForm] = useState<EditFacultyForm | null>(null);
  const [editEmailError, setEditEmailError] = useState("");
  const [editError, setEditError] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const deptChoices = useMemo(
    () => deptOptions.filter((d) => d && d !== "All Departments"),
    [deptOptions]
  );

  const isValidDlsuEmail = (email: string) => {
    const trimmed = (email || "").trim();
    if (!trimmed) return true;
    const atIndex = trimmed.lastIndexOf("@");
    if (atIndex <= 0) return false;
    const local = trimmed.slice(0, atIndex);
    const domain = trimmed.slice(atIndex + 1);
    if (domain.toLowerCase() !== "dlsu.edu.ph") return false;
    if (!local.includes(".")) return false;
    if (/\s/.test(local)) return false;
    return true;
  };

  const openAddFaculty = () => {
    setAddForm(emptyAddForm);
    setAddEmailError("");
    setAddError("");
    setAddOpen(true);
  };

  const submitAddFaculty = async () => {
    const { first_name, last_name, email, department, employment_type, certifications, teaching_years } =
      addForm;

    const trimmedEmail = email.trim();
    const emailOk = isValidDlsuEmail(trimmedEmail);
    if (!emailOk) {
      setAddEmailError("Email is not a valid DLSU account");
      return;
    }

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
      setAddEmailError("");
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
      certifications: "",
      teaching_years: "",
    });
    setEditEmailError("");
    setEditError("");
  };

  const submitEditFaculty = async () => {
    if (!editOpen || !editForm) return;
    const { first_name, last_name, email, department, employment_type, certifications, teaching_years } = editForm;

    const trimmedEmail = email.trim();
    const emailOk = isValidDlsuEmail(trimmedEmail);
    if (!emailOk) {
      setEditEmailError("Email is not a valid DLSU account");
      return;
    }
    if (!first_name.trim() || !last_name.trim() || !trimmedEmail || !department || !employment_type) {
      setEditError("Please fill out all required fields.");
      return;
    }

    setEditError("");
    setEditSaving(true);

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

      const res = await updateChairFacultyEntry(editOpen.faculty_id, payload);
      if (!res || !res.ok) throw new Error("Failed to update faculty.");

      setEditOpen(null);
      setEditForm(null);
      setEditEmailError("");
      setEditError("");
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
        const { ok, rows } = await listChairFaculty({ department, facultyType, search });
        if (!ok) throw new Error("Failed to load faculty list");
        setRows(rows);
      } catch (e: any) {
        setRows([]);
        setErr(e?.response?.data?.detail || e?.message || "Failed to load faculty list.");
      } finally {
        setLoading(false);
      }
    })();
  }, [department, facultyType, search, reloadToken]);

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
        <button
          type="button"
          onClick={openAddFaculty}
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700"
        >
          <Plus className="h-4 w-4" /> Add Faculty
        </button>
      </div>

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
                      onEdit={() => openEditFaculty(r)}
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
              <TextInput placeholder="first.last@dlsu.edu.ph" value={addForm.email} onChange={(e) => {
                const v = e.target.value; setAddForm(f => ({...f, email: v}));
                setAddEmailError(isValidDlsuEmail(v) ? "" : "Email is not a valid DLSU account");
              }} />
              {addEmailError && addForm.email.trim() && <p className="mt-1 text-xs text-red-600">{addEmailError}</p>}
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
              <button onClick={submitAddFaculty} disabled={addSaving || !!addEmailError} className="rounded-lg bg-emerald-700 px-6 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:bg-emerald-300">
                {addSaving ? "Adding…" : "Add Faculty"}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={!!editOpen} onClose={() => { setEditOpen(null); setEditForm(null); }}>
        {editOpen && editForm && (
          <div className="p-6 sm:p-8">
            <div className="mb-6 flex items-start justify-between">
              <div>
                <h3 className="text-xl font-semibold text-emerald-700">Edit Faculty Details</h3>
                <div className="mt-1 text-sm text-gray-700">Faculty: <span className="font-medium">{editOpen.name}</span></div>
              </div>
              <button onClick={() => { setEditOpen(null); setEditForm(null); }} className="rounded-full p-1 hover:bg-gray-100"><X className="h-5 w-5" /></button>
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
                  setEditEmailError(isValidDlsuEmail(v) ? "" : "Email is not a valid DLSU account");
                }} />
                {editEmailError && editForm.email.trim() && <p className="mt-1 text-xs text-red-600">{editEmailError}</p>}
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div><Label>Department</Label><SelectBox value={editForm.department} onChange={(v) => setEditForm(f => f ? {...f, department: v || ""} : f)} options={deptChoices} /></div>
                <div><Label>Faculty Type</Label><SelectBox value={editForm.employment_type === "FT" ? "Full-Time" : editForm.employment_type === "PT" ? "Part-Time" : ""} onChange={(v) => setEditForm(f => f ? {...f, employment_type: v === "Full-Time" ? "FT" : v === "Part-Time" ? "PT" : ""} : f)} options={["Full-Time", "Part-Time"]} /></div>
                <div><Label>Certifications</Label><TextInput value={editForm.certifications} onChange={(e) => setEditForm(f => f ? {...f, certifications: e.target.value} : f)} /></div>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div><Label>Teaching Years</Label><TextInput type="number" min={0} value={editForm.teaching_years} onChange={(e) => setEditForm(f => f ? {...f, teaching_years: e.target.value} : f)} /></div>
              </div>
              <div className="mt-4 flex justify-end">
                <button onClick={submitEditFaculty} disabled={editSaving || !!editEmailError} className="rounded-lg bg-emerald-700 px-6 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:bg-emerald-300">
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