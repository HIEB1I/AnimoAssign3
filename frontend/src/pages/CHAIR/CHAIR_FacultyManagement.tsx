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

function makeTeachingLoad(dataArray: any[]): TL[] {
  const byDay: Record<DayLong, TLItem[]> = {
    Monday: [],
    Tuesday: [],
    Wednesday: [],
    Thursday: [],
    Friday: [],
    Saturday: [],
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
  ay: string; // "AY 2024-2025"
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

// Excel-like, single-line cells except title
function renderTeachingHistoryLikeFacultyFromArray(flatRows: HistRow[]) {
  const groups = groupHistoryByTerm(flatRows);

  const HEADERS = [
    "Course Code",
    "Course Title",
    "Section",
    "Mode",
    "Day 1",
    "Room 1",
    "Day 2",
    "Room 2",
    "Time",
  ] as const;

  return (
    <div className="space-y-8">
      {(["Term 1", "Term 2", "Term 3"] as const).map((t) => (
        <div key={t} className="rounded-xl border border-gray-200 overflow-hidden bg-white">
          {/* Term header */}
          <div className="px-4 py-3 text-sm font-semibold text-emerald-700 bg-gray-50 border-b">
            {t}
          </div>

          {/* Fixed table */}
          <div>
            <table className="w-full table-fixed border-t border-gray-200">
              <colgroup>
                <col className="w-[12ch]" /> {/* Code */}
                <col className="w-[32ch]" /> {/* Title */}
                <col className="w-[10ch]" /> {/* Section */}
                <col className="w-[10ch]" /> {/* Mode */}
                <col className="w-[8ch]" /> {/* Day 1 */}
                <col className="w-[14ch]" /> {/* Room 1 */}
                <col className="w-[8ch]" /> {/* Day 2 */}
                <col className="w-[14ch]" /> {/* Room 2 */}
                <col className="w-[16ch]" /> {/* Time */}
              </colgroup>

              <thead>
                <tr className="text-xs text-gray-500">
                  {HEADERS.map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold text-center">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {(groups[t] ?? []).length === 0 ? (
                  <tr>
                    <td
                      colSpan={HEADERS.length}
                      className="px-4 py-6 text-center text-sm text-gray-500 bg-white"
                    >
                      No records.
                    </td>
                  </tr>
                ) : (
                  groups[t].map((r, i) => (
                    <tr key={`${t}-${i}`} className={cls("text-sm text-gray-700", i % 2 === 0 ? "bg-white" : "bg-gray-50")}>
                      <td className="px-3 py-2 text-center whitespace-nowrap">{r.code}</td>
                      <td className="px-3 py-2 text-center whitespace-normal break-words">
                        {r.title}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {r.section}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {r.mode ?? ""}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {r.day1 ?? ""}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {r.room1 ?? ""}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {r.day2 ?? ""}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {r.room2 ?? ""}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {r.time ?? ""}
                      </td>
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
  
  // History state (New logic: parallel load style)
  const [historyRows, setHistoryRows] = useState<HistRow[]>([]);
  const [historyAyOptions, setHistoryAyOptions] = useState<string[]>([]);
  const [historyAy, setHistoryAy] = useState<string>("");
  const [historyLoading, setHistoryLoading] = useState(false);

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
    
    if (type === "history") {
      setHistoryRows([]);
      setHistoryAyOptions([]);
      setHistoryAy("");
      setHistoryLoading(true);
    }
  };
  
  const closeModal = () => {
    setActiveModal(null);
    setSelected(null);
    setSchedule(null);
    setHistoryRows([]);
  };

  // Load Modal Content
  useEffect(() => {
    (async () => {
      if (!activeModal || !selected) return;

      // SCHEDULE
      if (activeModal === "schedule") {
        try {
          const data = await getChairFacultySchedule(selected.faculty_id);
          setSchedule(data);
        } catch { /* ignore */ }
      }

      // HISTORY (Single load of everything)
      if (activeModal === "history") {
        try {
          setHistoryLoading(true);
          // Calls backend which now returns flat "rows"
          const data = await getChairFacultyHistory(selected.faculty_id); 
          const rawRows: HistRow[] = data?.rows || [];
          
          setHistoryRows(rawRows);

          // Derive AY options client-side
          const uniqAys = Array.from(new Set(rawRows.map((r) => r.ay))).sort().reverse();
          setHistoryAyOptions(uniqAys);
          if (uniqAys.length > 0) {
            setHistoryAy(uniqAys[0]);
          }
        } catch { 
          setHistoryRows([]);
        } finally {
          setHistoryLoading(false);
        }
      }
    })();
  }, [activeModal, selected]);

  // Derived History Display
  const filteredHistory = useMemo(() => {
    if (!historyAy) return [];
    return historyRows.filter((r) => r.ay === historyAy);
  }, [historyRows, historyAy]);

  const historyIndex = historyAyOptions.indexOf(historyAy);
  const hasPrev = historyIndex < historyAyOptions.length - 1 && historyIndex !== -1;
  const hasNext = historyIndex > 0 && historyIndex !== -1;

  const goPrevAy = () => {
    if (hasPrev) setHistoryAy(historyAyOptions[historyIndex + 1]);
  };
  const goNextAy = () => {
    if (hasNext) setHistoryAy(historyAyOptions[historyIndex - 1]);
  };

  const renderTeachingLoadSummaryList = (s: any) => {
    const TL = makeTeachingLoad(s?.teaching_load || []);
    return (
      <div className="space-y-6">
        {TL.map((day) => (
          <div key={day.day} className="rounded-xl border border-emerald-700/50 overflow-hidden bg-white">
            <div className="px-5 py-3">
              <div className="text-emerald-700 font-semibold text-[15px]">{day.day}</div>
            </div>
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
                      {["Course Code","Course Title","Section","Units","Campus","Mode","Room","Time"].map((h) => (
                        <th key={h} className="px-3 py-2 font-semibold text-center border-b border-emerald-700/40">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {day.items.length === 0 ? (
                      <tr><td colSpan={8} className="px-4 py-6 text-center text-sm text-neutral-500 bg-white">No records.</td></tr>
                    ) : (
                      day.items.map((it, idx) => (
                        <tr key={`${day.day}-${it.code}-${it.sec}-${idx}`} className={cls("text-neutral-900 text-[13px]", idx % 2 === 0 ? "bg-white" : "bg-neutral-50")}>
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
                  renderTeachingLoadSummaryList(schedule)
                )}
              </>
            )}

            {activeModal === "history" && (
              <>
                <div className="text-center mb-4">
                  <h2 className="text-lg font-semibold text-emerald-700">Teaching History</h2>
                  <p className="text-sm text-neutral-500">{selected?.name ?? ""}</p>
                </div>

                {/* Client-side pagination controls for AY */}
                <div className="flex justify-between items-center mb-4">
                  <button
                    onClick={goPrevAy}
                    disabled={!hasPrev || historyLoading}
                    className={cls(
                      "px-3 py-1.5 rounded-lg text-sm font-medium border shadow-sm",
                      (!hasPrev || historyLoading) ? "bg-gray-100 text-gray-400 cursor-not-allowed" : "bg-white hover:bg-gray-50 text-gray-700"
                    )}
                  >
                    ← Previous
                  </button>

                  <span className="text-base font-semibold text-gray-800">
                    {historyLoading ? "Loading..." : (historyAy || "—")}
                  </span>

                  <button
                    onClick={goNextAy}
                    disabled={!hasNext || historyLoading}
                    className={cls(
                      "px-3 py-1.5 rounded-lg text-sm font-medium border shadow-sm",
                      (!hasNext || historyLoading) ? "bg-gray-100 text-gray-400 cursor-not-allowed" : "bg-white hover:bg-gray-50 text-gray-700"
                    )}
                  >
                    Next →
                  </button>
                </div>

                {historyLoading ? (
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">Loading history…</div>
                ) : filteredHistory.length === 0 ? (
                  <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-600">
                    {historyAyOptions.length === 0 ? "No history records found." : `No history records for ${historyAy}.`}
                  </div>
                ) : (
                  renderTeachingHistoryLikeFacultyFromArray(filteredHistory)
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