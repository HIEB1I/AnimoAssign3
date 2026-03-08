import { Fragment, useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import SelectBox from "../../component/SelectBox";
import { cls } from "../../utilities/cls";
import {
  Search as SearchIcon,
  BookOpen,
  Plus,
  Edit,
  X,
  Info,
  GraduationCap,
  PanelRightClose,
} from "lucide-react";

import {
  addChairFacultyEntry,
  getChairFacultyDeloading,
  getChairFacultyHistory,
  getChairFacultyOptions,
  getChairFacultySchedule,
  listChairFaculty,
  updateChairFacultyDeloading,
  updateChairFacultyEntry,
  type ChairDeloadingType,
  type ChairFacultyDeloading,
  type FacultyRow,
  type FacultyUpsertPayload,
  type FMOptions,
} from "../../api";

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
  term?: string;
};

type FacultyUpdatePayload = FacultyUpsertPayload & {
  hire_date?: string;
};

type ChairScheduleResponse = {
  ok: boolean;
  term_id: string | null;
  term?: {
    acad_year_start?: number | null;
    term_number?: number | null;
  } | null;
  teaching_load?: ScheduleRow[];
};


type ChairHistoryResponse = {
  ok: boolean;
  acad_year_start?: number | null;
  academicYears?: number[];
  terms?: Record<string, HistRow[]>;
  teaching_history?: HistRow[];
};


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
  hire_date: string;
};

function summarizeCertifications(certs: unknown): { display: string; full: string; count: number } {
  const arr = Array.isArray(certs)
    ? certs
        .filter(Boolean)
        .map((c) => String(c).trim())
        .filter(Boolean)
    : [];

  const full = arr.length ? arr.join(", ") : "—";
  if (arr.length === 0) return { display: "—", full: "—", count: 0 };
  if (arr.length <= 2) return { display: full, full, count: arr.length };
  return { display: `${arr.slice(0, 2).join(", ")} +${arr.length - 2}`, full, count: arr.length };
}

function formatHireDateDisplay(raw: unknown): string {
  if (raw === null || raw === undefined) return "—";
  const s = String(raw).trim();
  if (!s) return "—";

  const m = /^\d{4}-\d{2}-\d{2}/.exec(s);
  let dt: Date | null = null;
  if (m) {
    const [y, mo, d] = m[0].split("-").map((n) => Number(n));
    if (Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d)) {
      dt = new Date(y, mo - 1, d);
    }
  } else {
    const parsed = Date.parse(s);
    if (!Number.isNaN(parsed)) dt = new Date(parsed);
  }

  if (!dt || Number.isNaN(dt.getTime())) return s;

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(dt);
}

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

function groupHistoryByTerm(rows: HistRow[]) {
  const groups: Record<string, HistRow[]> = { "Term 1": [], "Term 2": [], "Term 3": [] };
  rows.forEach((r) => {
    const t = r.term || "Term 1";
    if (!groups[t]) groups[t] = [];
    groups[t].push(r);
  });
  return groups;
}

function normalizeHistoryRows(data: any): HistRow[] {
  if (Array.isArray(data?.teaching_history)) {
    return data.teaching_history as HistRow[];
  }

  const terms = data?.terms;
  if (!terms || typeof terms !== "object") return [];

  const out: HistRow[] = [];
  Object.entries(terms as Record<string, any>).forEach(([term, rows]) => {
    if (!Array.isArray(rows)) return;
    rows.forEach((row) => {
      out.push({ ...(row as HistRow), term });
    });
  });
  return out;
}

function getFacultyDisplayName(row: Partial<FacultyRow> & { first_name?: string; last_name?: string; display_name?: string }): string {
  const displayName = String(row.display_name || "").trim();
  if (displayName) return displayName;

  const firstName = String(row.first_name || "").trim();
  const lastName = String(row.last_name || "").trim();
  if (lastName && firstName) return `${lastName}, ${firstName}`;
  if (lastName) return lastName;
  if (firstName) return firstName;
  return String(row.name || "").trim() || "—";
}

function getFacultyViewerName(row: Partial<FacultyRow> & { first_name?: string; last_name?: string }): string {
  const firstName = String(row.first_name || "").trim();
  const lastName = String(row.last_name || "").trim();
  if (firstName && lastName) return `${firstName} ${lastName}`;
  if (firstName) return firstName;
  if (lastName) return lastName;
  return String(row.name || "").trim() || "—";
}

function compactDayLines(row: { day1?: string; day2?: string }): string[] {
  return [row.day1, row.day2].map((value) => String(value || "").trim()).filter(Boolean);
}

function compactTimeLines(row: { begin1?: string; end1?: string; begin2?: string; end2?: string }): string[] {
  return [
    [row.begin1, row.end1],
    [row.begin2, row.end2],
  ]
    .map(([begin, end]) => {
      const start = String(begin || "").trim();
      const finish = String(end || "").trim();
      if (!start && !finish) return "";
      if (start && finish) return `${start}–${finish}`;
      return start || finish;
    })
    .filter(Boolean);
}

function renderCompactStack(lines: string[], align: "left" | "center" = "center") {
  if (lines.length === 0) {
    return <span className="text-gray-400">—</span>;
  }

  return (
    <div className={cls("space-y-1", align === "center" ? "text-center" : "text-left")}>
      {lines.map((line, idx) => (
        <div key={`${line}-${idx}`} className="whitespace-nowrap leading-5 text-gray-700">
          {line}
        </div>
      ))}
    </div>
  );
}

function renderScheduleTable(rows: ScheduleRow[]) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[38%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[10%]" />
            <col className="w-[12%]" />
            <col className="w-[16%]" />
          </colgroup>
          <thead className="border-b bg-gray-50 text-gray-900">
            <tr>
              <th className="px-4 py-2 text-left">Course Code &amp; Title</th>
              <th className="px-3 py-2 text-center">Section</th>
              <th className="px-3 py-2 text-center">Mode</th>
              <th className="px-3 py-2 text-center">Units</th>
              <th className="px-3 py-2 text-center">Day</th>
              <th className="px-3 py-2 text-center">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-gray-500">
                  No records
                </td>
              </tr>
            ) : (
              rows.map((r, idx) => (
                <tr key={`${r.course_code}-${r.section}-${idx}`} className="hover:bg-gray-50 align-top">
                  <td className="px-4 py-3 text-left font-semibold text-emerald-700">
                    {r.course_code || "—"}
                    <div className="text-xs font-normal text-gray-500">{r.course_title || "—"}</div>
                  </td>
                  <td className="px-3 py-3 text-center">{r.section || "—"}</td>
                  <td className="px-3 py-3 text-center">{r.mode || "—"}</td>
                  <td className="px-3 py-3 text-center">{r.units ?? "—"}</td>
                  <td className="px-3 py-3 text-center">{renderCompactStack(compactDayLines(r))}</td>
                  <td className="px-3 py-3 text-center">{renderCompactStack(compactTimeLines(r))}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderTeachingHistoryByTerm(rows: HistRow[]) {
  const groups = groupHistoryByTerm(rows);
  return (
    <div className="space-y-8">
      {(["Term 1", "Term 2", "Term 3"] as const).map((term) => (
        <div key={term} className="space-y-3">
          <div className="text-sm font-semibold text-emerald-700">{term}</div>
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-[46%]" />
                  <col className="w-[14%]" />
                  <col className="w-[10%]" />
                  <col className="w-[14%]" />
                  <col className="w-[16%]" />
                </colgroup>
                <thead className="border-b bg-gray-50 text-gray-900">
                  <tr>
                    <th className="px-4 py-2 text-left">Course Code &amp; Title</th>
                    <th className="px-3 py-2 text-center">Section</th>
                    <th className="px-3 py-2 text-center">Units</th>
                    <th className="px-3 py-2 text-center">Day</th>
                    <th className="px-3 py-2 text-center">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(groups[term] || []).length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                        No records
                      </td>
                    </tr>
                  ) : (
                    (groups[term] || []).map((r, idx) => (
                      <tr key={`${term}-${r.code}-${r.section}-${idx}`} className="hover:bg-gray-50 align-top">
                        <td className="px-4 py-3 text-left font-semibold text-emerald-700">
                          {r.code || "—"}
                          <div className="text-xs font-normal text-gray-500">{r.title || "—"}</div>
                        </td>
                        <td className="px-3 py-3 text-center">{r.section || "—"}</td>
                        <td className="px-3 py-3 text-center">{r.units ?? "—"}</td>
                        <td className="px-3 py-3 text-center">{renderCompactStack(compactDayLines(r))}</td>
                        <td className="px-3 py-3 text-center">{renderCompactStack(compactTimeLines(r))}</td>
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

export default function CHAIR_FacultyManagement() {
  const [department, setDepartment] = useState("All Departments");
  const [facultyType, setFacultyType] = useState("All Type");
  const [statusFilter, setStatusFilter] = useState("All Status");

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [deptOptions, setDeptOptions] = useState<string[]>(["All Departments"]);
  const [typeOptions, setTypeOptions] = useState<string[]>(["All Type"]);
  const statusOptions = useMemo(() => ["All Status", "Active", "On Leave"], []);

  const [academicYears, setAcademicYears] = useState<number[]>([]);
  const [panelAcademicYears, setPanelAcademicYears] = useState<number[]>([]);
  const [termLabel, setTermLabel] = useState("");
  const [activeTermId, setActiveTermId] = useState("");

  const [rows, setRows] = useState<FacultyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [selected, setSelected] = useState<FacultyRow | null>(null);

  const [historyYearIndex, setHistoryYearIndex] = useState(0);

  const [panelScheduleRows, setPanelScheduleRows] = useState<ScheduleRow[]>([]);
  const [panelHistoryRows, setPanelHistoryRows] = useState<HistRow[]>([]);
  const [panelHistoryBootstrapped, setPanelHistoryBootstrapped] = useState(false);
  const [panelScheduleLoading, setPanelScheduleLoading] = useState(false);
  const [panelHistoryLoading, setPanelHistoryLoading] = useState(false);
  const [panelScheduleError, setPanelScheduleError] = useState("");
  const [panelHistoryError, setPanelHistoryError] = useState("");
  const [panelScheduleTermTitle, setPanelScheduleTermTitle] = useState("");

  const [reloadToken, setReloadToken] = useState(0);

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

  const [editDeloading, setEditDeloading] = useState<ChairFacultyDeloading | null>(null);
  const [deloadingTypes, setDeloadingTypes] = useState<ChairDeloadingType[]>([]);
  const [deloadingLoading, setDeloadingLoading] = useState(false);

  const searchRef = useRef<HTMLInputElement | null>(null);

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
        setActiveTermId(opt.activeTerm?.term_id ? String(opt.activeTerm.term_id) : "");

        const years = Array.isArray(opt.academicYears) ? opt.academicYears : [];
        setAcademicYears(years);
        setPanelAcademicYears(years);
        setHistoryYearIndex(0);
      } catch (e: any) {
        setErr(e?.response?.data?.detail || e?.message || "Failed to load options.");
      }
    })();
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setErr("");

        const response = await listChairFaculty({
          department,
          facultyType,
          search,
        });

        if (!response?.ok) throw new Error("Failed to load faculty list");

        const fetchedRows = (response.rows || []).filter((row) => {
          if (!statusFilter || statusFilter === "All Status") return true;
          return String(row.status || "").trim().toLowerCase() === statusFilter.toLowerCase();
        });

        setRows(fetchedRows);
        setSelected((current) => {
          if (!current) return current;
          const matched = fetchedRows.find((row) => row.faculty_id === current.faculty_id);
          return matched || null;
        });
      } catch (e: any) {
        setRows([]);
        setSelected(null);
        setErr(e?.response?.data?.detail || e?.message || "Failed to load faculty list.");
      } finally {
        setLoading(false);
      }
    })();
  }, [department, facultyType, statusFilter, search, reloadToken]);

  const historyYearLabel = useMemo(() => {
    const ay = panelAcademicYears[historyYearIndex];
    return ay ? `AY ${ay}–${ay + 1}` : "—";
  }, [panelAcademicYears, historyYearIndex]);

  const selectedSummary = useMemo(() => {
    if (!selected) {
      return {
        certifications: { display: "—", full: "—", count: 0 },
        hireDate: "—",
        teachingYears: "—",
        teachingUnits: "—",
      };
    }

    return {
      certifications: summarizeCertifications((selected as any).certifications),
      hireDate: formatHireDateDisplay((selected as any).hire_date),
      teachingYears:
        (selected as any).teaching_years !== null && (selected as any).teaching_years !== undefined && (selected as any).teaching_years !== ""
          ? String((selected as any).teaching_years)
          : "—",
      teachingUnits:
        selected.teaching_units !== null && selected.teaching_units !== undefined && String(selected.teaching_units).trim() !== ""
          ? String(selected.teaching_units)
          : "—",
    };
  }, [selected]);

  const computedEditTeachingYears = useMemo(() => {
    if (!editForm) return null;
    return calcTeachingYearsFromHireDate(editForm.hire_date);
  }, [editForm]);


  const groupedFacultyRows = useMemo(() => {
    const normalizeDepartment = (value: unknown) => {
      const label = String(value || "").trim();
      return label || "Unassigned Department";
    };

    const getLastNameKey = (fullName: unknown) => {
      const cleaned = String(fullName || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!cleaned) return "";
      const parts = cleaned.split(" ");
      return (parts[parts.length - 1] || "").toLowerCase();
    };

    const sorted = [...rows].sort((a, b) => {
      const deptCompare = normalizeDepartment(a.department).localeCompare(normalizeDepartment(b.department), undefined, {
        sensitivity: "base",
      });
      if (deptCompare !== 0) return deptCompare;

      const lastNameCompare = getLastNameKey(a.name).localeCompare(getLastNameKey(b.name), undefined, {
        sensitivity: "base",
      });
      if (lastNameCompare !== 0) return lastNameCompare;

      return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
    });

    const total = sorted.length;
    const groups: Array<{ department: string; rows: FacultyRow[]; total: number }> = [];
    for (const row of sorted) {
      const departmentLabel = normalizeDepartment(row.department);
      const lastGroup = groups[groups.length - 1];
      if (!lastGroup || lastGroup.department !== departmentLabel) {
        groups.push({ department: departmentLabel, rows: [row], total });
      } else {
        lastGroup.rows.push(row);
      }
    }
    return groups;
  }, [rows]);

  useEffect(() => {
    if (!selected) {
      setPanelScheduleRows([]);
      setPanelHistoryRows([]);
      setPanelScheduleError("");
      setPanelHistoryError("");
      setPanelScheduleLoading(false);
      setPanelHistoryLoading(false);
      setPanelScheduleTermTitle("");
      setPanelAcademicYears(academicYears);
      setPanelHistoryBootstrapped(false);
      setHistoryYearIndex(0);
      return;
    }

    let cancelled = false;
    setPanelHistoryBootstrapped(false);

    (async () => {
      try {
        setPanelScheduleLoading(true);
        setPanelScheduleError("");
        const data = (await getChairFacultySchedule(selected.faculty_id)) as ChairScheduleResponse;
        if (cancelled) return;
        const ay = data?.term?.acad_year_start;
        const tn = data?.term?.term_number;
        setPanelScheduleTermTitle(ay != null ? `AY ${ay}-${ay + 1} · Term ${tn ?? "—"}` : termLabel || "Current Term");
        setPanelScheduleRows(Array.isArray(data?.teaching_load) ? data.teaching_load : []);
      } catch (e: any) {
        if (cancelled) return;
        setPanelScheduleRows([]);
        setPanelScheduleError(e?.response?.data?.detail || e?.message || "Failed to load schedule.");
      } finally {
        if (!cancelled) setPanelScheduleLoading(false);
      }
    })();

    (async () => {
      try {
        setPanelHistoryLoading(true);
        setPanelHistoryError("");
        const data = (await getChairFacultyHistory(selected.faculty_id)) as ChairHistoryResponse;
        if (cancelled) return;

        const years = Array.isArray(data?.academicYears) && data.academicYears.length > 0
          ? data.academicYears
          : academicYears;
        setPanelAcademicYears(years);

        const serverAy = typeof data?.acad_year_start === "number" ? data.acad_year_start : null;
        const resolvedIndex = serverAy != null ? years.indexOf(serverAy) : 0;
        const nextIndex = resolvedIndex >= 0 ? resolvedIndex : 0;
        setHistoryYearIndex(nextIndex);
        setPanelHistoryRows(normalizeHistoryRows(data));
        setPanelHistoryBootstrapped(true);
      } catch (e: any) {
        if (cancelled) return;
        setPanelAcademicYears(academicYears);
        setPanelHistoryRows([]);
        setPanelHistoryBootstrapped(true);
        setPanelHistoryError(e?.response?.data?.detail || e?.message || "Failed to load teaching history.");
      } finally {
        if (!cancelled) setPanelHistoryLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selected, academicYears, termLabel]);

  useEffect(() => {
    if (!selected || !panelHistoryBootstrapped) return;
    if (panelAcademicYears.length === 0) {
      setPanelHistoryRows([]);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        setPanelHistoryLoading(true);
        setPanelHistoryError("");
        const ay = panelAcademicYears[historyYearIndex];
        const data = (await getChairFacultyHistory(selected.faculty_id, ay)) as ChairHistoryResponse;
        if (cancelled) return;
        setPanelHistoryRows(normalizeHistoryRows(data));
      } catch (e: any) {
        if (cancelled) return;
        setPanelHistoryRows([]);
        setPanelHistoryError(e?.response?.data?.detail || e?.message || "Failed to load teaching history.");
      } finally {
        if (!cancelled) setPanelHistoryLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selected, historyYearIndex, panelAcademicYears, panelHistoryBootstrapped]);

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
        employment_type,
      };

      const certs = certifications.trim();
      if (certs) {
        payload.certifications = certs
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
      }

      const years = teaching_years.trim();
      if (years) {
        const n = Number(years);
        if (Number.isFinite(n)) payload.teaching_years = n;
      }

      const res = await addChairFacultyEntry(payload);
      if (!res?.ok) throw new Error("Failed to add faculty.");

      setAddOpen(false);
      setAddForm(emptyAddForm);
      setReloadToken((value) => value + 1);
    } catch (e: any) {
      setAddError(e?.response?.data?.detail || e?.message || "Error adding faculty.");
    } finally {
      setAddSaving(false);
    }
  };

  const openEditFaculty = (row: FacultyRow) => {
    const first_name = String((row as FacultyRow & { first_name?: string }).first_name || "").trim();
    const last_name = String((row as FacultyRow & { last_name?: string }).last_name || "").trim();

    let employment_type: "" | "FT" | "PT" = "";
    const displayType = String(row.faculty_type || "").toLowerCase();
    if (displayType.includes("full")) employment_type = "FT";
    else if (displayType.includes("part")) employment_type = "PT";
    else if (displayType === "ft" || displayType === "pt") employment_type = displayType.toUpperCase() as "FT" | "PT";

    setEditOpen(row);
    setEditForm({
      first_name,
      last_name,
      email: row.email || "",
      department: row.department || "",
      employment_type,
      certifications: Array.isArray((row as any).certifications) ? ((row as any).certifications as string[]).join(", ") : "",
      teaching_years:
        (row as any).teaching_years !== null && (row as any).teaching_years !== undefined && (row as any).teaching_years !== ""
          ? String((row as any).teaching_years)
          : "",
      hire_date: (row as any).hire_date ? String((row as any).hire_date) : "",
    });
    setEditError("");

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
    const { first_name, last_name, email, department: dept, employment_type, certifications, hire_date } = editForm;
    const trimmedEmail = email.trim();

    if (!first_name.trim() || !last_name.trim() || !trimmedEmail || !dept || !employment_type) {
      setEditError("Please fill out all required fields.");
      return;
    }

    setEditError("");
    setEditSaving(true);

    try {
      const payload: FacultyUpdatePayload = {
        first_name: first_name.trim(),
        last_name: last_name.trim(),
        email: trimmedEmail.toLowerCase(),
        department: dept,
        employment_type,
        hire_date: hire_date.trim(),
      };

      const certs = certifications.trim();
      payload.certifications = certs
        ? certs
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];

      const computedYears = calcTeachingYearsFromHireDate(hire_date);
      if (typeof computedYears === "number" && Number.isFinite(computedYears)) {
        payload.teaching_years = computedYears;
      }

      await updateChairFacultyEntry(editOpen.faculty_id, payload);

      if (activeTermId) {
        try {
          await updateChairFacultyDeloading({
            facultyId: editOpen.faculty_id,
            termId: activeTermId,
            type_id: editDeloading?.type_id ?? null,
            units_deloaded: editDeloading?.units_deloaded ?? null,
            notes: editDeloading?.notes ?? null,
          } as any);
        } catch {
          // Non-blocking by design.
        }
      }

      setEditOpen(null);
      setEditForm(null);
      setEditDeloading(null);
      setDeloadingTypes([]);
      setReloadToken((value) => value + 1);
    } catch (e: any) {
      setEditError(e?.response?.data?.detail || e?.message || "Error updating faculty.");
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <main className="w-full px-6 py-6">
        <header className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Faculty Directory</h1>
            <p className="text-sm text-gray-600">Manage faculty profiles, schedules, and teaching history for {termLabel || "the active term"}.</p>
          </div>

          <button
            type="button"
            onClick={openAddFaculty}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800"
          >
            <Plus className="h-4 w-4" />
            Add Faculty
          </button>
        </header>

        {err && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {err}
          </div>
        )}

        <div className="mb-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 grid h-9 w-9 place-items-center rounded-full bg-slate-200 text-slate-700">
              <Info className="h-5 w-5" />
            </div>
            <div>
              <div className="font-semibold">Chair Faculty Management</div>
              <div className="text-xs text-slate-600">
                Select any faculty member to review profile details on the right, then open Edit, Schedule, or Teaching History without leaving the page.
              </div>
            </div>
          </div>
        </div>

        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="relative min-w-[260px] flex-1">
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
                  window.requestAnimationFrame(() => searchRef.current?.focus());
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>

          <SelectBox value={department} onChange={setDepartment} options={deptOptions} />
          <SelectBox value={statusFilter} onChange={setStatusFilter} options={statusOptions} />
          <SelectBox value={facultyType} onChange={setFacultyType} options={typeOptions} />
        </div>

        <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-[minmax(260px,0.88fr)_minmax(0,1.62fr)]">
          <div className="min-w-0 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm md:max-h-[calc(100vh-3rem)]">
            <div className="border-b bg-gray-50 px-4 py-3">
            </div>

            <div className="overflow-auto md:max-h-[calc(100vh-8rem)]">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-[68%]" />
                  <col className="w-[32%]" />
                </colgroup>
                <thead className="border-b bg-gray-50 text-gray-900">
                  <tr>
                    <th className="px-4 py-3 text-left">Faculty</th>
                    <th className="px-3 py-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {loading ? (
                    <tr>
                      <td colSpan={2} className="px-4 py-6 text-center text-gray-500">
                        Loading…
                      </td>
                    </tr>
                  ) : groupedFacultyRows.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="px-4 py-6 text-center text-gray-500">
                        No results
                      </td>
                    </tr>
                  ) : (
                    groupedFacultyRows.map((group) => (
                      <Fragment key={group.department}>
                        <tr className="bg-slate-100/90">
                          <td colSpan={2} className="px-4 py-3 text-left align-middle">
                            <div className="text-sm font-semibold text-slate-900">{group.department}</div>
                            <div className="text-xs text-slate-500">
                              Showing {group.rows.length} of {group.total}
                            </div>
                          </td>
                        </tr>
                        {group.rows.map((row) => {
                          const isActive = selected?.faculty_id === row.faculty_id;
                          const statusLabel = row.status || "—";
                          const normalizedStatus = String(statusLabel).trim().toLowerCase();
                          const isAvailable = normalizedStatus === "active";

                          return (
                            <tr
                              key={row.faculty_id}
                              onClick={() => setSelected(row)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setSelected(row);
                                }
                              }}
                              tabIndex={0}
                              role="button"
                              aria-label={`View ${getFacultyViewerName(row as FacultyRow & { first_name?: string; last_name?: string }) || "faculty"} details`}
                              className={cls(
                                "cursor-pointer transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-500/30",
                                isActive && "bg-emerald-50/70"
                              )}
                            >
                              <td className="px-4 py-4 font-semibold text-emerald-700">
                                <div className="truncate" title={getFacultyDisplayName(row as FacultyRow & { first_name?: string; last_name?: string; display_name?: string })}>{getFacultyDisplayName(row as FacultyRow & { first_name?: string; last_name?: string; display_name?: string })}</div>
                                <div className="truncate text-xs font-normal text-gray-500" title={row.email || "—"}>{row.email || "—"}</div>
                              </td>
                              <td className="px-3 py-4 text-center">
                                <span
                                  className={cls(
                                    "inline-flex max-w-full items-center justify-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1",
                                    isAvailable
                                      ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
                                      : "bg-amber-100 text-amber-800 ring-amber-200"
                                  )}
                                  title={statusLabel}
                                >
                                  <span className="truncate">{statusLabel}</span>
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="min-w-0 md:sticky md:top-6 md:self-start">
            <div className="flex max-h-[calc(100vh-3rem)] min-h-0 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
              <div className="border-b bg-gradient-to-r from-slate-900 via-emerald-900 to-emerald-700 px-5 py-5 text-white">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">Faculty Viewer</div>
                    <h2 className="mt-1 text-lg font-semibold">{selected ? getFacultyViewerName(selected as FacultyRow & { first_name?: string; last_name?: string }) : "Select a faculty member"}</h2>
                    <p className="mt-1 text-sm text-white/85">
                      {selected?.email || "Choose any faculty from the list to inspect profile details and manage records here."}
                    </p>
                  </div>
                  {selected && (
                    <button
                      type="button"
                      onClick={() => setSelected(null)}
                      className="rounded-xl border border-white/15 bg-white/10 p-2 text-white/90 transition hover:bg-white/20"
                      aria-label="Close faculty viewer"
                      title="Close faculty viewer"
                    >
                      <PanelRightClose className="h-5 w-5" />
                    </button>
                  )}
                </div>

                {selected && (
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="rounded-xl bg-white/10 px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-white/70">Department</div>
                      <div className="mt-1 text-sm font-medium text-white">{selected.department || "—"}</div>
                    </div>
                    <div className="rounded-xl bg-white/10 px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-white/70">Faculty Type</div>
                      <div className="mt-1 text-sm font-medium text-white">{selected.faculty_type || "—"}</div>
                    </div>
                  </div>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50 p-5">
                {!selected && (
                  <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-5 py-10 text-center">
                    <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50 text-emerald-700">
                      <GraduationCap className="h-6 w-6" />
                    </div>
                    <h3 className="mt-4 text-base font-semibold text-gray-900">No faculty selected yet</h3>
                    <p className="mt-2 text-sm text-gray-600">
                      Click any faculty row to preview profile details, then use the action buttons here.
                    </p>
                  </div>
                )}

                {selected && (
                  <div className="grid grid-cols-1 gap-4">
                    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-gray-900">Quick Actions</div>
                          <div className="mt-1 text-xs text-gray-500">Update faculty details without leaving the page.</div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => openEditFaculty(selected)}
                            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                          >
                            <Edit className="h-4 w-4" />
                            Edit Faculty Details
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                      <div className="flex items-center gap-2 text-gray-900">
                        <GraduationCap className="h-4 w-4 text-emerald-700" />
                        <h3 className="font-semibold">Faculty Teaching Overview</h3>
                      </div>

                      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                          <div className="text-xs font-medium uppercase tracking-wide text-gray-600">Teaching Units</div>
                          <div className="mt-2 text-sm font-semibold text-gray-900">{selectedSummary.teachingUnits}</div>
                        </div>
                        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                          <div className="text-xs font-medium uppercase tracking-wide text-gray-600">Hire Date</div>
                          <div className="mt-2 text-sm font-semibold text-gray-900">{selectedSummary.hireDate}</div>
                        </div>
                        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                          <div className="text-xs font-medium uppercase tracking-wide text-gray-600">Teaching Years</div>
                          <div className="mt-2 text-sm font-semibold text-gray-900">{selectedSummary.teachingYears}</div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                      <div className="flex items-center gap-2 text-gray-900">
                        <BookOpen className="h-4 w-4 text-emerald-700" />
                        <h3 className="font-semibold">Certifications</h3>
                      </div>

                      {selectedSummary.certifications.count > 0 ? (
                        <div className="mt-3 space-y-2">
                          <div className="text-sm text-gray-700" title={selectedSummary.certifications.full}>
                            {selectedSummary.certifications.full}
                          </div>
                        </div>
                      ) : (
                        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                          No certifications recorded for this faculty member yet.
                        </div>
                      )}

                      <div className="mt-6 border-t border-gray-200 pt-6">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <h4 className="text-sm font-semibold text-gray-900">Schedule</h4>
                            <div className="mt-1 text-xs text-gray-500">Current teaching load displayed directly in the panel.</div>
                          </div>
                          {panelScheduleTermTitle && (
                            <div className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-900">
                              {panelScheduleTermTitle}
                            </div>
                          )}
                        </div>

                        <div className="mt-4">
                          {panelScheduleError ? (
                            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{panelScheduleError}</div>
                          ) : panelScheduleLoading ? (
                            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-600">Loading schedule…</div>
                          ) : panelScheduleRows.length === 0 ? (
                            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-600">No schedule records found.</div>
                          ) : (
                            renderScheduleTable(panelScheduleRows)
                          )}
                        </div>
                      </div>

                      <div className="mt-6 border-t border-gray-200 pt-6">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <h4 className="text-sm font-semibold text-gray-900">Teaching History</h4>
                            <div className="mt-1 text-xs text-gray-500">Previous terms shown here without extra actions.</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setHistoryYearIndex((value) => Math.min(value + 1, panelAcademicYears.length - 1))}
                              disabled={historyYearIndex >= panelAcademicYears.length - 1}
                              className={cls(
                                "rounded-lg border px-3 py-1.5 text-xs font-medium shadow-sm",
                                historyYearIndex >= panelAcademicYears.length - 1
                                  ? "cursor-not-allowed bg-gray-100 text-gray-400"
                                  : "bg-white text-gray-700 hover:bg-gray-50"
                              )}
                            >
                              ← Previous
                            </button>
                            <span className="min-w-[92px] text-center text-sm font-semibold text-gray-800">{historyYearLabel}</span>
                            <button
                              type="button"
                              onClick={() => setHistoryYearIndex((value) => Math.max(value - 1, 0))}
                              disabled={historyYearIndex <= 0}
                              className={cls(
                                "rounded-lg border px-3 py-1.5 text-xs font-medium shadow-sm",
                                historyYearIndex <= 0
                                  ? "cursor-not-allowed bg-gray-100 text-gray-400"
                                  : "bg-white text-gray-700 hover:bg-gray-50"
                              )}
                            >
                              Next →
                            </button>
                          </div>
                        </div>

                        <div className="mt-4">
                          {panelHistoryError ? (
                            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{panelHistoryError}</div>
                          ) : panelHistoryLoading ? (
                            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-600">Loading teaching history…</div>
                          ) : panelHistoryRows.length === 0 ? (
                            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-600">No teaching history found.</div>
                          ) : (
                            renderTeachingHistoryByTerm(panelHistoryRows)
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>

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
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{addError}</div>
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
                  onChange={(value) => setAddForm((f) => ({ ...f, department: value || "" }))}
                  options={deptOptions.filter((value) => value !== "All Departments")}
                />
              </div>
              <div>
                <Label>Faculty Type</Label>
                <SelectBox
                  value={addForm.employment_type === "FT" ? "Full-Time" : addForm.employment_type === "PT" ? "Part-Time" : ""}
                  onChange={(value) =>
                    setAddForm((f) => ({
                      ...f,
                      employment_type: value === "Full-Time" ? "FT" : value === "Part-Time" ? "PT" : "",
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
                  addSaving && "cursor-not-allowed opacity-70"
                )}
              >
                {addSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </Modal>

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
              <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{editError}</div>
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
                    <TextInput value={editForm.email} onChange={(e) => setEditForm((f) => (f ? { ...f, email: e.target.value } : f))} />
                  </div>
                  <div>
                    <Label>Department</Label>
                    <SelectBox
                      value={editForm.department}
                      onChange={(value) => setEditForm((f) => (f ? { ...f, department: value || "" } : f))}
                      options={deptOptions.filter((value) => value !== "All Departments")}
                    />
                  </div>
                  <div>
                    <Label>Faculty Type</Label>
                    <SelectBox
                      value={editForm.employment_type === "FT" ? "Full-Time" : editForm.employment_type === "PT" ? "Part-Time" : ""}
                      onChange={(value) =>
                        setEditForm((f) =>
                          f
                            ? {
                                ...f,
                                employment_type: value === "Full-Time" ? "FT" : value === "Part-Time" ? "PT" : "",
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
                      Teaching Years: <span className="font-semibold text-gray-800">{computedEditTeachingYears == null ? "—" : computedEditTeachingYears}</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                  <div className="mb-2 text-sm font-semibold text-gray-800">Deloading (optional)</div>
                  {deloadingLoading ? (
                    <div className="text-sm text-gray-600">Loading deloading…</div>
                  ) : (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                      <div>
                        <Label>Type</Label>
                        <SelectBox
                          value={
                            editDeloading?.type_id
                              ? deloadingTypes.find((type) => type.type_id === editDeloading.type_id)?.type || ""
                              : ""
                          }
                          onChange={(value) => {
                            const found = deloadingTypes.find((type) => type.type === value);
                            if (!found) {
                              setEditDeloading((current) => ({ ...(current || {}), type_id: null }));
                              return;
                            }
                            setEditDeloading((current) => ({ ...(current || {}), type_id: found.type_id }));
                          }}
                          options={["", ...deloadingTypes.map((type) => type.type)]}
                        />
                      </div>
                      <div>
                        <Label>Units Deloaded</Label>
                        <TextInput
                          type="number"
                          value={editDeloading?.units_deloaded != null ? String(editDeloading.units_deloaded) : ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            const parsed = value === "" ? null : Number(value);
                            setEditDeloading((current) => ({
                              ...(current || {}),
                              units_deloaded: parsed !== null && Number.isFinite(parsed) ? parsed : null,
                            }));
                          }}
                          placeholder="e.g. 3"
                        />
                      </div>
                      <div>
                        <Label>Notes</Label>
                        <TextInput
                          value={editDeloading?.notes ?? ""}
                          onChange={(e) => setEditDeloading((current) => ({ ...(current || {}), notes: e.target.value }))}
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
                      editSaving && "cursor-not-allowed opacity-70"
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
    </div>
  );
}
