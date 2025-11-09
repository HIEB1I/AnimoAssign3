import React, { useEffect, useMemo, useState } from "react";
import {
  Edit,
  Trash2,
  Check,
  Search,
  X,
  Send,
  Plus,
  ChevronDown,
  AlertTriangle,
} from "lucide-react";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import SelectBox from "../../component/SelectBox";
import {
  getApoCourseOfferings,
  addApoOfferingRow,
  editApoOfferingRow,
  deleteApoOfferingRow,
  forwardApoCourseOfferings,
  approveApoOfferingsPlan,
  curriculumAddCourse,
  curriculumEditCourse,
  curriculumRemoveCourse,
  getElectiveOptions,                 // <-- ADD THIS
  type ApiConflict,
} from "../../api";

/* --------------------------------- helpers --------------------------------- */
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
type Day = (typeof DAYS)[number];

type RoomOption = {
  room_id: string;
  room_number: string;
  capacity?: number | null;
  room_type?: string | null;
  building?: string;            
};

const filterRoomsByCap = (options: RoomOption[], cap?: number | null) => {
  const c = typeof cap === "number" ? cap : 0;
  const seen = new Set<string>();
  const unique = (options || []).filter((o) => {
    const key = (o.room_id ?? "") + "::" + (o.room_number ?? "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.filter((r) => typeof r.capacity !== "number" || !c || (r.capacity as number) >= c);
};

const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

// Display: "HH:MM" or "—"
const fmtTime = (s?: string) => {
  const t = (s || "").replace(/\D/g, "");
  if (t.length !== 4) return s || "—";
  return `${t.slice(0, 2)}:${t.slice(2)}`;
};

// Allow user to type anything; coerce to exactly HHMM on save
const toHHMM = (s?: string) => {
  const t = (s || "").replace(/\D/g, "").slice(0, 4);
  if (t.length === 4) return t;          // H1H2M1M2
  if (t.length === 3) return `0${t}`;    // H M M -> 0HMM
  if (t.length === 2) return `${t}00`;   // HH   -> HH00
  if (t.length === 1) return `0${t}00`;  // H    -> 0H00
  return "";
};

// exactly HHMM check
const isFullTime = (s?: string) => ((s || "").replace(/\D/g, "")).length === 4;

// allow partial typing (0..4 digits)
const sanitizeTime = (s?: string) => (s || "").replace(/\D/g, "").slice(0, 4);

// A slot can only receive a room if it has day + full HHMM times
const slotReady = (s?: { day?: Day | ""; start_time?: string; end_time?: string }) =>
  !!(s && s.day && isFullTime(s.start_time) && isFullTime(s.end_time));

// strict (non-GE) slot: require day + full start + full end, optional room
const compactSlotStrict = (
  s?: { day?: Day | ""; start_time?: string; end_time?: string; room_id?: string }
) => {
  if (!s) return undefined;
  const day = (s.day || "") as Day | "";
  const start = sanitizeTime(s.start_time);
  const end = sanitizeTime(s.end_time);
  if (!(day && isFullTime(start) && isFullTime(end))) return undefined;
  const out: any = { day, start_time: start, end_time: end };
  if (s.room_id) out.room_id = s.room_id;
  return out;
};

// GE slot: allow partial updates, only send the keys that are actually provided
// GE slot: allow partial updates, but never send empty strings
const compactSlotGE = (
  s?: { day?: Day | ""; start_time?: string; end_time?: string; room_id?: string }
) => {
  if (!s) return undefined;
  const out: any = {};

  if ((s.day || "") as Day | "") out.day = s.day;

  // strictly send HHMM only when we have a real time
  const st = toHHMM(s.start_time);
  if (st.length === 4) out.start_time = st;

  const en = toHHMM(s.end_time);
  if (en.length === 4) out.end_time = en;

  // normalize room: "" -> null (explicit clear), undefined -> do not touch
  if (s.room_id !== undefined) out.room_id = s.room_id ? s.room_id : null;

  return Object.keys(out).length ? out : undefined;
};


const normCode = (s?: string) =>
  (s || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/^ID\s*(\d+)$/, "ID $1");

const isGEType = (t?: string) => {
  const s = String(t || "").trim().toLowerCase();
  return s.startsWith("ge") || s.includes("general education") || /^ge[\s/_-]/.test(s);
};

/** Elective helpers (robust and tolerant of label variations) */
const typeOf = (v: unknown) => String(v ?? "");
const isElectivePlaceholderType = (type?: string, code?: string, title?: string) => {
  const tt = (type || "").toLowerCase().trim();
  if (tt.includes("elective course")) return false;   // never treat specific electives as placeholders
  if (tt === "elective") return true;                 // explicit placeholder type

  const cc = (code || "").toUpperCase();
  const ti = (title || "").toLowerCase();
  // heuristics for placeholders like ITELEC1/2/etc.
  const looksLikePlaceholderCode = /\bELEC\d*\b/.test(cc) || /ELEC/.test(cc);
  const titleMentionsElective = ti.includes("elective");
  return looksLikePlaceholderCode || titleMentionsElective;
};

const isSpecificElectiveType = (type?: string) => {
  const tt = typeOf(type).toLowerCase().trim();
  return tt === "elective course" || tt.includes("elective course") || tt.includes("specific elective");
};

const parseBatchNumber = (batchCode?: string) => {
  const m = (batchCode || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
};

// Soft, neutral inputs for edit/add rows
const SOFT_INPUT =
  "w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm shadow-sm " +
  "focus:outline-none focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300";

const SOFT_SELECT =
  "block w-full min-w-0 max-w-full appearance-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm " +
  "shadow-sm outline-none focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300";

/* ---------------------------------- types ---------------------------------- */

type OfferingRow = {
  program_no: string;
  block_index?: number;
  batch: { batch_id: string; batch_code: string; batch_number?: number | null };
  program: { program_id?: string; program_code?: string; program_name?: string }; // program_name optional
  course: {
    course_id: string;
    course_code: string;
    course_title: string;
    program_level?: string;
    program_level_label?: string;
    department_id?: string;
    department_name?: string;
    type_of_course?: string | null;
  };
  section: { section_id: string; section_code: string; enrollment_cap: number | null; remarks: string };
  faculty: { faculty_id?: string | null; user_id?: string | null; faculty_name: string };
  slot1?: {
    schedule_id?: string;
    day: Day | "";
    start_time: string;
    end_time: string;
    room_id?: string;
    room_number?: string;
  };
  slot2?: {
    schedule_id?: string;
    day: Day | "";
    start_time: string;
    end_time: string;
    room_id?: string;
    room_number?: string;
  };
  sizing: {
    preenlistment_total: number;
    cohort_estimate: number;
    planning_demand: number;
    planned_capacity: number;
    existing_sections: number;
    suggest_additional: number;
    deficit: number;
  };
  links: {
    curriculum_id?: string;
    term_id: string;
    course_id: string;
    batch_id?: string;
    program_id?: string;
    section_id?: string;
    elective_placeholder_course_id?: string;
  };
};

type CourseOption = {
  course_id: string;
  course_code: string | string[]; // tolerate array or string
  course_title: string;
  type_of_course?: string | null;
};

const codeOf = (v: unknown) =>
  Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
const titleOf = (v: unknown) => String(v ?? "");

type PlanningChange =
  | {
      type: "add_course_to_curriculum";
      course_id: string;
      count?: number;
      target?: { program_id: string; batch_id: string } | null;
    }
  | { type: "sections_increase"; course_id: string; by_sections?: number; by_capacity?: number }
  | { type: "sections_decrease"; course_id: string; by_sections?: number; by_capacity?: number };

type OfferingsResponse = {
  campus: { campus_id: string; campus_name: string };
  term_id: string;
  term_label: string;
  filters: {
    levels: string[];
    departments: { department_id: string; department_name: string }[];
    ids: { batch_id: string; batch_code: string }[];
    programs: { program_id: string; program_code: string }[];
  };
  rows: OfferingRow[];
  course_options_by_group: Record<string, CourseOption[]>;
  all_specific_electives?: CourseOption[];
  room_options: RoomOption[];
  planning?: {
    needs_import: boolean;
    approval_required: boolean;
    pending_changes?: PlanningChange[];
  };
};

type CurriculumItem = {
  program_id: string;
  program_code: string;
  department_id: string;
  department_name: string;
  batch_id: string;
  batch_code: string;
  courses: {
    course_id: string;
    code: string;
    title: string;
    department_id: string;
    department_name?: string;
    program_level?: string;
    source?: "DB" | "custom" | string;
    units?: number | null;
  }[];
};

type DeptCourseOption = {
  course_id: string;
  course_code: string;
  course_title: string;
  department_id: string;
  program_level?: string;
  program_level_code?: string;
  units?: number | null;
  type_of_course?: string | null;
};
type CurriculumResponse = {
  campus: { campus_id: string; campus_name: string };
  term_id: string;
  term_label: string;
  items: CurriculumItem[];
  course_options_by_program: Record<string, DeptCourseOption[]>;
  departments: { department_id: string; department_name: string }[];
};

/* ---------------------------- small action types ---------------------------- */

type ActionKind = "add" | "edit" | "delete";

type AddDraft = {
  batch_id: string;
  program_id?: string;
  course_id: string;
  enrollment_cap?: number;
  remarks?: string;
  slot1?: { room_id?: string };
  slot2?: { room_id?: string };
  section_code?: string;

  // elective linkage
  for_placeholder_course_id?: string;
  specific_course_id?: string;

  // backend flags + context
  auto_override?: boolean;   // <-- add this
  campus_id?: string;        // <-- keep this (you already use it)
};

// EXTENDED: allow GE to update everything
type EditDraft = {
  section_id: string;
  section_code?: string;
  enrollment_cap?: number | "";
  remarks?: string;

  faculty_name?: string;

  slot1?: {
    day?: Day | "";
    start_time?: string; // "HHMM"
    end_time?: string;   // "HHMM"
    room_id?: string;
  };
  slot2?: {
    day?: Day | "";
    start_time?: string;
    end_time?: string;
    room_id?: string;
  };

  for_placeholder_course_id?: string;
  specific_course_id?: string;

  // optional flags used by backend when relaxing constraints
  auto_override?: boolean;
};
type DelDraft = { section_id: string };

type ConflictState = {
  action: ActionKind;
  token: string;
  violations: { code: string; level: string; message: string; data?: any }[];
  preview: any;
  original: AddDraft | EditDraft | DelDraft;
  reason: string;
};

type ViewMode = "offerings" | "curriculum";

/* ----------------------- SECTION CODE RULES (NEW) ----------------------- */

function isGraduateLevel(level?: string) {
  const s = String(level || "").toLowerCase();
  return s.startsWith("graduate") || s === "gs";
}
function isUndergradLevel(level?: string) {
  const s = String(level || "").toLowerCase();
  return s.startsWith("undergraduate") || s === "ug";
}
function isCBLProgramName(name?: string) {
  const s = String(name || "").trim();
  return /\(CBL\)\s*$/i.test(s);
}
function deriveExpectedSectionPattern(
  row: OfferingRow,
  campusName: string
): { prefix: "S" | "G" | "XX" | "XC"; start: "11" | "01" | "22" | "23" } | null {
  const manila = (campusName || "").toUpperCase() === "MANILA";
  const laguna = (campusName || "").toUpperCase() === "LAGUNA";
  const level = row?.course?.program_level || row?.course?.program_level_label;

  if (manila && isUndergradLevel(level)) return { prefix: "S", start: "11" };
  if (manila && isGraduateLevel(level)) return { prefix: "G", start: "01" };

  if (laguna && isUndergradLevel(level)) {
    const cbl =
      isCBLProgramName(row?.program?.program_name) ||
      isCBLProgramName(row?.program?.program_code);
    if (cbl) return { prefix: "XC", start: "23" };
    return { prefix: "XX", start: "22" };
  }

  // If none matched, return null (we won't enforce)
  return null;
}

/** Normalize a typed section code to expected campus/level pattern. */
function normalizeSectionCodeInput(
  value: string | undefined,
  row: OfferingRow,
  campusName: string
): string | undefined {
  const v = (value || "").toUpperCase().replace(/\s+/g, "");
  const rule = deriveExpectedSectionPattern(row, campusName);
  if (!rule) return v || undefined;

  // Extract number part from user's input (keep last 2 digits if present)
  const numMatch = v.match(/(\d{1,3})$/);
  let digits = numMatch ? numMatch[1] : "";

  // Default digits to the rule's start if blank
  if (!digits) digits = rule.start;

  // Keep at least 2 digits (pad left if needed). If they typed more (e.g., 113), keep it.
  if (digits.length === 1) digits = `0${digits}`;

  // Compose with enforced prefix
  return `${rule.prefix}${digits}`;
}

/** Compute a default section code suggestion for display (e.g., "S11"). */
function defaultSectionCode(row: OfferingRow, campusName: string): string | null {
  const rule = deriveExpectedSectionPattern(row, campusName);
  return rule ? `${rule.prefix}${rule.start}` : null;
}

/* --------------------------------- component -------------------------------- */

export default function CourseOfferingsPage() {
  const [view, setView] = useState<ViewMode>("offerings");

  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<string>("All Levels");
  const [departmentName, setDepartmentName] = useState<string>("All Departments");
  const [programCode, setProgramCode] = useState<string>("All Programs");
  const [batchCode, setBatchCode] = useState<string>("All ID");

  const [data, setData] = useState<OfferingsResponse | null>(null);
  const [rows, setRows] = useState<OfferingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [globalElectives, setGlobalElectives] = useState<CourseOption[]>([]);
  const [electiveOptionsCache, setElectiveOptionsCache] = useState<Record<string, CourseOption[]>>({});
// ---------- RoomSelectBox (SelectBox-powered) ----------
const RoomSelectBox: React.FC<{
  rooms: RoomOption[];
  value: string | null | undefined;
  disabled?: boolean;
  className?: string;
  onChange: (roomId: string | null) => void;
}> = ({ rooms, value, disabled, className, onChange }) => {
  const items = useMemo(
    () => rooms.map(r => ({
      id: r.room_id,
      label: r.building ? `${r.building} ${r.room_number}` : r.room_number
    })),
    [rooms]
  );

  // shorter placeholder avoids forcing the cell wider than its col width
  const placeholder = disabled ? "— Set day+time —" : "— Select room —";
  const currentLabel = value ? (items.find(x => x.id === value)?.label ?? placeholder) : placeholder;
  const optionLabels = [placeholder, ...items.map(x => x.label)];

  return (
    <SelectBox
      value={currentLabel}
      onChange={(label) => {
        if (label === placeholder) return onChange(null);
        const hit = items.find(x => x.label === label);
        onChange(hit?.id ?? null);
      }}
      options={optionLabels}
      disabled={!!disabled}
      // !min-w-0 + max-w-full stops SelectBox from pushing into next columns
      className={cls("!min-w-0 w-full max-w-full overflow-hidden text-ellipsis", className)}
    />
  );
};

  // curriculum state
  const [curr, setCurr] = useState<CurriculumResponse | null>(null);
  const [currSearch, setCurrSearch] = useState("");

  // per-program add selection (code-only select still stores course_id)
  const [currAddSel, setCurrAddSel] = useState<Record<string, string>>({});

  // Offerings collapse state (keyed by "ID::PROGRAM")
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const user = useMemo(() => {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null;
  }, []);
  const fullName = user?.fullName ?? "APO";
  const roleName = useMemo(() => {
    if (!user?.roles) return "Academic Programming Officer";
    return (user.roles as string[]).some((r) => /^apo\b/i.test(r))
      ? "Academic Programming Officer"
      : (user.roles[0] as string) || "User";
  }, [user]);
  const campusLabel = data?.campus?.campus_name || curr?.campus?.campus_name || "";
  // --- Electives: per-placeholder fetch helper ---
  async function ensureElectiveOptionsFor(placeholderId?: string) {
    if (!user?.userId || !placeholderId) return;
    if (electiveOptionsCache[placeholderId]) return;

    const { options } = await getElectiveOptions(user.userId, placeholderId);
    const list = (options || []).map(o => ({
      ...o,
      course_code: Array.isArray(o.course_code) ? (o.course_code[0] ?? "") : (o.course_code ?? ""),
      type_of_course: "Elective Course",
    }));

    setElectiveOptionsCache(prev => ({ ...prev, [placeholderId]: list }));
  }

  /* ---------------------------------- load ---------------------------------- */

  const resolveFilterIds = () => {
    const deptId =
      departmentName === "All Departments"
        ? undefined
        : data?.filters.departments.find((d) => d.department_name === departmentName)?.department_id;
    const progId =
      programCode === "All Programs"
        ? undefined
        : (data?.filters.programs || []).find((p) => p.program_code === programCode)?.program_id;
    const bId =
      batchCode === "All ID"
        ? undefined
        : (data?.filters.ids || []).find((b) => normCode(b.batch_code) === normCode(batchCode))?.batch_id;
    return { deptId, progId, bId };
  };

const loadOfferings = async () => {
  if (!user?.userId) return;
  setLoading(true);
  setErr(null);
  try {
    const { deptId, progId, bId } = resolveFilterIds();
    const resp = await getApoCourseOfferings(user.userId, {
      view: "offerings",
      level: level === "All Levels" ? undefined : normalizeLevel(level),
      department_id: deptId,
      program_id: progId,
      batch_id: bId,
    });
    setData(resp as OfferingsResponse);
    setRows((resp as OfferingsResponse).rows);

    // NEW: if backend didn't send a global list, fetch it using getElectiveOptions
    const hasServerList =
      Array.isArray((resp as any).all_specific_electives) &&
      (resp as any).all_specific_electives.length > 0;

    if (!hasServerList) {
      const r = await getElectiveOptions(user.userId); // <-- now actually used
      const list = (r?.options ?? []).map(o => ({
        ...o,
        course_code: Array.isArray(o.course_code) ? (o.course_code[0] ?? "") : (o.course_code ?? ""),
        type_of_course: "Elective Course",
      }));
      setGlobalElectives(list);
    } else {
      setGlobalElectives([]); // prefer server-provided list
    }
  } catch (e: any) {
    setErr(e?.message || "Failed to load course offerings.");
    setRows([]);
  } finally {
    setLoading(false);
  }
};


  const loadCurriculum = async () => {
    if (!user?.userId) return;
    setLoading(true);
    setErr(null);
    try {
      const resp = (await getApoCourseOfferings(user.userId, { view: "curriculum" })) as unknown as CurriculumResponse;
      setCurr(resp);
    } catch (e: any) {
      setErr(e?.message || "Failed to load curriculum.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (view === "offerings") loadOfferings();
    else loadCurriculum();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    if (view === "offerings") loadOfferings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, departmentName, programCode, batchCode]);

  /* -------------------------- planning banner only -------------------------- */

  const blockedByImport = view === "offerings" && !!data?.planning?.needs_import;
  // Show banner, but do NOT block editing
  const showApprovalBanner = view === "offerings" && !blockedByImport && !!data?.planning?.approval_required;

  const [showForward, setShowForward] = useState(false);
  const [showPlanModal, setShowPlanModal] = useState(false);

  /* --------------------------------- filters -------------------------------- */
  const normalizeLevel = (v?: string) => {
    const t = String(v || "").trim().toLowerCase();
    if (t === "gs" || t.startsWith("graduate")) return "Graduate Studies";
    if (t === "ug" || t.startsWith("undergraduate")) return "Undergraduate";
    return String(v || "");
  };
  const levelOptions = useMemo(() => {
    // Normalize anything the backend sends so “Graduate” and “Graduate Studies” collapse
    const fromServer = (data?.filters.levels || []).map(normalizeLevel);
    const s = new Set(fromServer);

    // Make sure the two expected labels always exist
    s.add("Undergraduate");
    if ((data?.campus?.campus_name || "").toUpperCase() === "MANILA") {
      s.add("Graduate Studies"); // never add the bare “Graduate”
    }

    return ["All Levels", ...Array.from(s)];
  }, [data?.filters.levels, data?.campus?.campus_name]);

  const idOptions = useMemo(() => {
    const seen = new Set<string>();
    const arr: string[] = ["All ID"];
    (data?.filters.ids || []).forEach((b) => {
      const label = normCode(b.batch_code);
      if (!seen.has(label)) {
        seen.add(label);
        arr.push(label);
      }
    });
    return arr;
  }, [data?.filters.ids]);

  const searchPlaceholder =
    view === "curriculum"
      ? "Search by Program, ID, code, title…"
      : "Search by Program No., code, title, faculty, room…";

  /* ------------------------------ offerings table ----------------------------- */

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    const hit = (s?: string | number | null) => (s === 0 ? "0" : (s || "")).toString().toLowerCase().includes(q);
    return rows.filter((r) => {
      const { course: c, section: sec, faculty: f, slot1: s1, slot2: s2 } = r;
      return (
        hit(r.program_no) ||
        hit(c.course_code) ||
        hit(c.course_title) ||
        hit(c.program_level) ||
        hit(c.program_level_label) ||
        hit(c.department_name) ||
        hit(sec.section_code) ||
        hit(sec.enrollment_cap ?? "") ||
        hit(sec.remarks) ||
        hit(f.faculty_name) ||
        (s1 &&
          (hit(s1.day) ||
            hit(fmtTime(s1.start_time)) ||
            hit(fmtTime(s1.end_time)) ||
            hit(s1.room_id) ||
            hit(s1.room_number))) ||
        (s2 &&
          (hit(s2.day) ||
            hit(fmtTime(s2.start_time)) ||
            hit(fmtTime(s2.end_time)) ||
            hit(s2.room_id) ||
            hit(s2.room_number))) ||
        hit(r.batch.batch_code) ||
        hit(r.program.program_code)
      );
    });
  }, [rows, search]);

  const groups = useMemo(() => {
    const out: Record<string, Record<string, OfferingRow[]>> = {};
    for (const r of filtered) {
      const idKey = normCode(r.batch.batch_code) || "—";
      const progKey = r.program.program_code || "—";
      (out[idKey] ||= {});
      (out[idKey][progKey] ||= []).push(r);
    }
    return out;
  }, [filtered]);

  /* ---------------------------- offerings: editing --------------------------- */

  const [editing, setEditing] = useState<{ row: OfferingRow; draft: EditDraft } | null>(null);

  const startEdit = (row: OfferingRow) => {
    if (blockedByImport) return; // only block when import not done
    if (!row.section.section_id) return;

    const rowIsPlaceholder = isElectivePlaceholderType(
      row.course.type_of_course || "",
      row.course.course_code,
      row.course.course_title
    );
    const rowIsSpecificElective = isSpecificElectiveType(row.course.type_of_course || "");

    // Prefer backend-provided parent id; else, if this row is a placeholder, the row's own id is the parent.
    const electiveParentId =
      row.links?.elective_placeholder_course_id ||
      (rowIsPlaceholder ? row.course.course_id : undefined);

    // NEW: prefetch list for this specific placeholder (if any)
    ensureElectiveOptionsFor(electiveParentId);

    // If this row is already a specific elective, prefill the specific id to the current course id
    const currentSpecificId = rowIsSpecificElective ? row.course.course_id : undefined;

    const expectedDefault = defaultSectionCode(row, data?.campus?.campus_name || "");
    const initialSection = row.section.section_code || expectedDefault || "";

  setEditing({
    row,
    draft: {
      section_id: row.section.section_id,
      section_code: initialSection,
      enrollment_cap: row.section.enrollment_cap ?? "",
      remarks: row.section.remarks ?? "",
      faculty_name: row.faculty?.faculty_name || "UNASSIGNED",
      slot1: row.slot1
        ? {
            day: (row.slot1.day as Day | ""),
            start_time: row.slot1.start_time,
            end_time: row.slot1.end_time,
            ...(row.slot1.room_id ? { room_id: row.slot1.room_id } : {}), // <- no empty string
          }
        : undefined,
      slot2: row.slot2
        ? {
            day: (row.slot2.day as Day | ""),
            start_time: row.slot2.start_time,
            end_time: row.slot2.end_time,
            ...(row.slot2.room_id ? { room_id: row.slot2.room_id } : {}), // <- no empty string
          }
        : undefined,

      for_placeholder_course_id: electiveParentId,
      specific_course_id: currentSpecificId,
    },
  });
};

  const handleConflict = (action: ActionKind, apiConflict: ApiConflict, original: any) => {
    setConflict({
      action,
      token: apiConflict.override_token,
      violations: (apiConflict.violations || []).map((v: any) => ({
        code: v.code,
        level: v.level ?? "error",
        message: v.message,
        data: v.data,
      })),
      preview: apiConflict.preview_changes || {},
      original,
      reason: "",
    });
  };

  const facultyIndexByName = useMemo(() => {
    const m: Record<string, { user_id?: string; faculty_id?: string }> = {};
    (data?.rows || []).forEach(r => {
      const name = (r.faculty?.faculty_name || "").trim().toLowerCase();
      if (!name) return;
      m[name] = {
        user_id: r.faculty?.user_id || m[name]?.user_id,
        faculty_id: r.faculty?.faculty_id || m[name]?.faculty_id,
      };
    });
    return m;
  }, [data?.rows]);

  const addOptionsTypeById = useMemo(() => {
    const m: Record<string, string> = {};
    Object.values(data?.course_options_by_group || {}).forEach((arr) => {
      (arr || []).forEach((o) => {
        if (o?.course_id) m[o.course_id] = ((o.type_of_course as string) || "").toLowerCase();
      });
    });
    return m;
  }, [data?.course_options_by_group]);

  const codeText = (v: string | string[] | null | undefined) =>
    Array.isArray(v) ? (v[0] ?? "") : (v ?? "");

  // prefer server-provided global list if present
const allSpecificElectives: CourseOption[] = useMemo(() => {
  const fromServer = (data?.all_specific_electives || [])
    .filter(o => isSpecificElectiveType(o.type_of_course || ""))
    .map(o => ({ ...o, course_code: codeText(o.course_code) }));

  // Prefer server list; otherwise use globalElectives fetched via getElectiveOptions
  const primary = fromServer.length ? fromServer : globalElectives;

  if (primary.length) {
    return [...primary].sort((a,b)=>codeText(a.course_code).localeCompare(codeText(b.course_code)));
  }

  // last resort: derive from grouped options
  const seen = new Set<string>();
  const out: CourseOption[] = [];
  Object.values(data?.course_options_by_group || {}).forEach(arr => {
    (arr || []).forEach((o: any) => {
      const t = String(o?.type_of_course || "").toLowerCase().trim();
      if (!(t === "elective course" || t.includes("elective course"))) return;
      const id = String(o?.course_id || "");
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({
        course_id: id,
        course_code: codeText(o?.course_code),
        course_title: String(o?.course_title || ""),
        type_of_course: String(o?.type_of_course || ""),
      });
    });
  });
  return out.sort((a,b)=>codeText(a.course_code).localeCompare(codeText(b.course_code)));
}, [data?.all_specific_electives, data?.course_options_by_group, globalElectives]);


const saveEdit = async () => {
  if (!editing || !user?.userId) return;

  const isGE = isGEType(editing.row?.course?.type_of_course || "");

  // --- Grab current + draft codes ---
  const campusName = data?.campus?.campus_name || "";
  const currentCode = (editing.row.section.section_code || "").toUpperCase().replace(/\s+/g, "");
  const rawDraftCode = (editing.draft.section_code || "").trim().toUpperCase();

  // GE: DO NOT normalize; respect what they typed; if blank, keep current.
  // Non-GE: normalize to campus rules only if they changed it.
  let sectionCodeToSend: string | undefined;
  if (isGE) {
    if (rawDraftCode !== "") sectionCodeToSend = rawDraftCode;
    else if (currentCode) sectionCodeToSend = currentCode;
    // else undefined -> let backend decide
  } else {
    const normalized = rawDraftCode
      ? (normalizeSectionCodeInput(rawDraftCode, editing.row, campusName) || rawDraftCode)
      : "";
    if (normalized && normalized !== currentCode) sectionCodeToSend = normalized;
  }

  // --- Build payload ---
const payload: any = {
  section_id: editing.draft.section_id,
  course_id: editing.row.course.course_id,           // ← add this
  enrollment_cap: editing.draft.enrollment_cap === "" ? null : editing.draft.enrollment_cap,
  remarks: editing.draft.remarks,
  for_placeholder_course_id: editing.draft.for_placeholder_course_id,
  specific_course_id: editing.draft.specific_course_id,
  ...(isGE ? { auto_override: true } : {}),
};
if (sectionCodeToSend !== undefined) payload.section_code = sectionCodeToSend;

const s1 = isGE ? compactSlotGE(editing.draft.slot1) : compactSlotStrict(editing.draft.slot1);
const s2 = isGE ? compactSlotGE(editing.draft.slot2) : compactSlotStrict(editing.draft.slot2);
if (s1 && Object.keys(s1).length) payload.slot1 = s1;
if (s2 && Object.keys(s2).length) payload.slot2 = s2;

if (isGE) {
  payload.faculty_name = (editing.draft.faculty_name || "UNASSIGNED").trim() || "UNASSIGNED";
  const idx = facultyIndexByName[payload.faculty_name.toLowerCase()];
  if (idx?.user_id !== undefined) payload.faculty_user_id = idx.user_id ?? null;
  if (idx?.faculty_id !== undefined) payload.faculty_id = idx.faculty_id ?? null;
}

  try {
    let res: any = await editApoOfferingRow(user.userId, payload);

    // conflict handling (+ override on second attempt)
    if ("conflict" in res) {
      if (!isGE) {
        handleConflict("edit", res.conflict, payload);
        return;
      }
      const ov = await editApoOfferingRow(user.userId, {
        ...payload,
        override: true,
        override_token: res.conflict.override_token,
        override_reason: "GE edit – allow free-form section code, time, day, faculty",
      } as any);
      if ("conflict" in ov) {
        handleConflict("edit", ov.conflict, payload);
        return;
      }
    }

    setEditing(null);
    await loadOfferings();
  } catch (e: any) {
    alert(e?.message || "Failed to save changes.");
    setEditing(null);
  }
};

  /* ----------------------------- offerings: add row ----------------------------- */

  const rowKeyOf = (r: OfferingRow) =>
    r.section.section_id
      ? `sec:${r.section.section_id}`
      : `combo:${r.batch.batch_id}|${r.program.program_id}|${r.course.course_id}`;

  const [addAnchorKey, setAddAnchorKey] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState<AddDraft>({
    batch_id: "",
    program_id: "",
    course_id: "",
    // enrollment_cap: 20,
    remarks: "",
    slot1: { room_id: "" },
    slot2: { room_id: "" },
  });
  const [addCourseCode, setAddCourseCode] = useState<string>("— Select a course —");
  const [addElectiveSpecificId, setAddElectiveSpecificId] = useState<string>(""); // UI-only helper
  const [adding, setAdding] = useState(false);
  const [addAnchorSectionId, setAddAnchorSectionId] = useState<string | null>(null);

  const doAdd = async () => {
    if (blockedByImport) return;
    if (!user?.userId) return;

    const effectiveCourseId = addDraft.specific_course_id || addDraft.course_id;
    if (!effectiveCourseId) return;

    const isElectiveFlow = !!addDraft.for_placeholder_course_id;
    if (isElectiveFlow && !addDraft.specific_course_id) {
      alert("Please choose the Specific Elective to offer.");
      return;
    }

    setAdding(true);
    try {
      const courseType = addOptionsTypeById[effectiveCourseId] || "";
      const isGE = isGEType(courseType);

      // --- If started from a placeholder row, REPLACE it via EDIT ---
      if (isElectiveFlow && addAnchorSectionId) {
        const editPayload: EditDraft & { course_id?: string } = {
          section_id: addAnchorSectionId,
          for_placeholder_course_id: addDraft.for_placeholder_course_id,
          specific_course_id: addDraft.specific_course_id,
        };
        (editPayload as any).course_id = effectiveCourseId;

        const res = await editApoOfferingRow(user.userId, editPayload as any);
        if ("conflict" in res) {
          const ov = await editApoOfferingRow(user.userId, {
            ...editPayload,
            override: true,
            override_token: res.conflict.override_token,
            override_reason: "Elective replacement",
          } as any);
          if ("conflict" in ov) {
            handleConflict("edit", ov.conflict, editPayload);
            return;
          }
        }
      } else {
        // normal, non-elective add flow
        const base: AddDraft = {
          ...addDraft,
          course_id: effectiveCourseId,
          auto_override: isGE,
          campus_id: data?.campus?.campus_id || undefined,
        };
        const res = await addApoOfferingRow(user.userId, base as any);
        if ("conflict" in res) {
          const SAFE_AUTO_CODES = new Set(["NO_ROOM_SET","SEAT_DEFICIT","PREFIX_MISMATCH","CODE_WITHOUT_NUMBER","PLAN_NOT_APPROVED"]);
          const canAuto = isGE || (res.conflict.violations || []).every((v) => SAFE_AUTO_CODES.has(v.code));
          if (!canAuto) {
            handleConflict("add", res.conflict, base);
            return;
          }
          const ov = await addApoOfferingRow(user.userId, {
            ...base,
            override: true,
            override_token: res.conflict.override_token,
            override_reason: isGE ? "GE course – relax planning rules" : "Proceed despite planning warnings",
          } as any);
          if ("conflict" in ov) {
            handleConflict("add", ov.conflict, base);
            return;
          }
        }
      }

      await loadOfferings();
      setAddAnchorKey(null);
      setAddAnchorSectionId(null);
      setAddCourseCode("— Select a course —");
      setAddElectiveSpecificId("");
      setAddDraft({
        batch_id: "",
        program_id: "",
        course_id: "",
        enrollment_cap: 20,
        remarks: "",
        slot1: { room_id: "" },
        slot2: { room_id: "" },
      });
    } finally {
      setAdding(false);
    }
  };

  const doDelete = async (row: OfferingRow) => {
    if (blockedByImport) return;
    if (!user?.userId || !row.section.section_id) return;
    if (!confirm("Delete this section? This cannot be undone.")) return;
    setRows((prev) => prev.filter((r) => r.section.section_id !== row.section.section_id));
    if (editing?.row.section.section_id === row.section.section_id) setEditing(null);
    const res = await deleteApoOfferingRow(user.userId, { section_id: row.section.section_id } as any);
    if ("conflict" in res) {
      handleConflict("delete", res.conflict, { section_id: row.section.section_id });
      return;
    }
    await loadOfferings();
  };

  /* --------------------------- curriculum structures -------------------------- */

  const currPrograms = useMemo(() => {
    const arr = (curr?.items || []).map((i) => ({ id: i.program_id, code: i.program_code }));
    return arr.filter((x, idx) => arr.findIndex((a) => a.id === x.id) === idx);
  }, [curr?.items]);

  const currBatches = useMemo(() => {
    const arr = (curr?.items || []).map((i) => ({ id: i.batch_id, code: i.batch_code }));
    return arr.filter((x, idx) => arr.findIndex((a) => a.id === x.id) === idx);
  }, [curr?.items]);

  const selectedProgramId = useMemo(() => {
    if (programCode === "All Programs") return undefined;
    return currPrograms.find((p) => p.code === programCode)?.id;
  }, [programCode, currPrograms]);

  const selectedBatchId = useMemo(() => {
    if (batchCode === "All ID") return undefined;
    return currBatches.find((b) => normCode(b.code) === normCode(batchCode))?.id;
  }, [batchCode, currBatches]);

  const optionsByProgram: Record<string, DeptCourseOption[]> = curr?.course_options_by_program || {};

  /* ===== Curriculum grouped by ID (batch) ===== */
  type BatchGroup = {
    batch_id: string;
    batch_code: string;
    batch_number: number;
    programs: Record<string, CurriculumItem>; // program_id -> item merged
  };
  const curriculumByBatch = useMemo(() => {
    const map: Record<string, BatchGroup> = {};
    for (const it of curr?.items || []) {
      if (selectedProgramId && it.program_id !== selectedProgramId) continue;
      if (selectedBatchId && it.batch_id !== selectedBatchId) continue;

      const bkey = normCode(it.batch_code);
      if (!map[bkey]) {
        map[bkey] = {
          batch_id: it.batch_id,
          batch_code: bkey,
          batch_number: parseBatchNumber(it.batch_code),
          programs: {},
        };
      }
      if (!map[bkey].programs[it.program_id]) {
        map[bkey].programs[it.program_id] = { ...it, courses: [...it.courses] };
      } else {
        map[bkey].programs[it.program_id].courses.push(...it.courses);
      }
    }

    // de-dup + sort per program
    Object.values(map).forEach((grp) => {
      Object.keys(grp.programs).forEach((pid) => {
        const seen = new Set<string>();
        grp.programs[pid].courses = grp.programs[pid].courses
          .filter((c) => (seen.has(c.course_id) ? false : (seen.add(c.course_id), true)))
          .sort((a, b) => a.code.localeCompare(b.code));
      });
    });

    // turn into ordered array
    const arr = Object.values(map).sort((a, b) => a.batch_number - b.batch_number);
    return arr;
  }, [curr?.items, selectedProgramId, selectedBatchId]);

  // For "single-batch" view we still need per-program map + consistent order
  const singleBatchPrograms = useMemo(() => {
    if (!selectedBatchId) return {};
    const map: Record<string, CurriculumItem> = {};
    for (const i of curr?.items || []) {
      if (i.batch_id !== selectedBatchId) continue;
      if (selectedProgramId && i.program_id !== selectedProgramId) continue;
      if (!map[i.program_id]) map[i.program_id] = { ...i, courses: [...i.courses] };
      else map[i.program_id].courses = [...map[i.program_id].courses, ...i.courses];
    }
    Object.keys(map).forEach((pid) => {
      const seen = new Set<string>();
      map[pid].courses = map[pid].courses
        .filter((c) => (seen.has(c.course_id) ? false : (seen.add(c.course_id), true)))
        .sort((a, b) => a.code.localeCompare(b.code));
    });
    return map;
  }, [curr?.items, selectedBatchId, selectedProgramId]);

  const eligibleCourseIdsByProgram = useMemo(() => {
    const m: Record<string, Set<string>> = {};
    (curr?.items || []).forEach((it) => {
      const bag = (m[it.program_id] ||= new Set<string>());
      it.courses.forEach((c) => bag.add(c.course_id));
    });
    return m;
  }, [curr?.items]);

  /* ------------------------------ curriculum CRUD ----------------------------- */

  const handleCurrAdd = async (program_id: string, batch_id: string, course_id: string) => {
    if (!user?.userId || !course_id) return;
    await curriculumAddCourse(user.userId, { program_id, batch_id, course_id } as any);
    setCurrAddSel((p) => ({ ...p, [program_id]: "" }));
    await loadCurriculum();
  };

  const handleCurrAddCustom = async (
    program_id: string,
    batch_id: string,
    newCourse: { course_code: string; course_title: string; department_id: string; program_level: string; units?: number }
  ) => {
    if (!user?.userId) return;
    await curriculumAddCourse(user.userId, { program_id, batch_id, new_course: newCourse } as any);
    setCurrAddSel((p) => ({ ...p, [program_id]: "" }));
    await loadCurriculum();
  };

  const handleCurrReplace = async (program_id: string, batch_id: string, old_course_id: string, new_course_id: string) => {
    if (!user?.userId) return;
    await curriculumEditCourse(user.userId, { program_id, batch_id, old_course_id, new_course_id } as any);
    await loadCurriculum();
  };

  const handleCurrEditUnits = async (program_id: string, batch_id: string, course_id: string, units: number | null) => {
    if (!user?.userId) return;
    await curriculumEditCourse(user.userId, {
      program_id,
      batch_id,
      old_course_id: course_id,
      update_course: { units },
    } as any);
    await loadCurriculum();
  };

  const handleCurrRemove = async (program_id: string, batch_id: string, course_id: string) => {
    if (!user?.userId) return;
    if (!confirm("Remove this course from the curriculum?")) return;
    await curriculumRemoveCourse(user.userId, { program_id, batch_id, course_id });
    await loadCurriculum();
  };

  /* ----------------------------------- UI ----------------------------------- */

  return (
    <div className="min-h-screen w-full bg-gray-50 text-slate-900">
      <TopBar fullName={fullName} role={campusLabel ? `${roleName} | ${campusLabel}` : roleName} />
      <Tabs
        mode="nav"
        items={[
          { label: "Pre-Enlistment", to: "/apo/preenlistment" },
          { label: "Course Offerings", to: "/apo/courseofferings" },
          { label: "Room Allocation", to: "/apo/roomallocation" },
        ]}
      />

      {/* View toggle */}
      <div className="px-6 pt-4 w-full">
        <div className="flex items-center justify-start">
          <div className="inline-flex overflow-hidden rounded-lg border border-emerald-700">
            <button
              onClick={() => setView("offerings")}
              className={cls(
                "px-3 py-1.5 text-sm font-medium",
                view === "offerings" ? "bg-emerald-700 text-white" : "bg-white text-emerald-700"
              )}
            >
              Course Offerings
            </button>
            <button
              onClick={() => setView("curriculum")}
              className={cls(
                "px-3 py-1.5 text-sm font-medium border-l border-emerald-700",
                view === "curriculum" ? "bg-emerald-700 text-white" : "bg-white text-emerald-700"
              )}
            >
              Curriculum
            </button>
          </div>
        </div>
      </div>

      <main className="p-6 w-full">
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              value={view === "offerings" ? search : currSearch}
              onChange={(e) => (view === "offerings" ? setSearch(e.target.value) : setCurrSearch(e.target.value))}
              placeholder={searchPlaceholder}
              className="w-full rounded-lg border px-9 py-2 text-sm"
            />
          </div>

          {/* Offerings filters */}
          {view === "offerings" && (
            <>
              <SelectBox value={level} onChange={(v: string) => setLevel(v)} options={levelOptions} />
              <SelectBox
                value={departmentName}
                onChange={(v: string) => setDepartmentName(v)}
                options={["All Departments", ...(data?.filters.departments || []).map((d) => d.department_name)]}
              />
              <SelectBox value={batchCode} onChange={(v: string) => setBatchCode(v)} options={idOptions} />
              <SelectBox
                value={programCode}
                onChange={(v: string) => setProgramCode(v)}
                options={["All Programs", ...(data?.filters.programs || []).map((p) => p.program_code)]}
              />
            </>
          )}
          {/* Right side of toolbar */}
          <div className="ml-auto flex items-center gap-3">
            {view === "offerings" && (
              <button
                onClick={() => setShowForward(true)}
                className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm"
              >
                <Send className="h-4 w-4" />
                Forward
              </button>
            )}
          </div>
          {/* Curriculum filters */}
          {view === "curriculum" && (
            <>
              <SelectBox
                value={programCode}
                onChange={(v: string) => {
                  setProgramCode(v);
                  setCurrAddSel({});
                }}
                options={["All Programs", ...currPrograms.map((p) => p.code)]}
              />
              <SelectBox
                value={batchCode}
                onChange={(v: string) => {
                  setBatchCode(v);
                  setCurrAddSel({});
                }}
                options={["All ID", ...currBatches.map((b) => b.code)]}
              />
            </>
          )}
        </div>

        {/* card */}
        <div className="rounded-xl bg-white shadow-sm border border-gray-200 p-4 sm:p-6 w-full" data-course-offerings>
          <div className="flex items-center justify-between mb-3 sm:mb-4">
            <div>
              <h2 className="text-lg font-bold">{view === "curriculum" ? "Curriculum" : "Course Offerings"}</h2>
              <p className="text-sm text-gray-500">{loading ? "Loading…" : data?.term_label || curr?.term_label || ""}</p>
              {err && <p className="text-sm text-red-600">{err}</p>}
            </div>
          </div>

          {/* planning banner */}
          {view === "offerings" && data?.planning && (
            <>
              {showApprovalBanner && (
                <div className="mb-4 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-blue-900">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium">Planning updates are ready</div>
                    <button
                      className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white shadow-sm"
                      onClick={() => setShowPlanModal(true)}
                    >
                      Review &amp; Approve
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ------------------------------ Offerings ------------------------------ */}
          {view === "offerings" && (
            <>
              {blockedByImport ? (
                <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50 p-8 text-center text-amber-900">
                  <p className="text-sm">
                    Pre-Enlistment count and statistics are required before planning course offerings.
                  </p>
                  <a
                    href="/apo/preenlistment"
                    className="mt-3 inline-flex items-center gap-2 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm"
                  >
                    Go to Pre-Enlistment
                  </a>
                </div>
              ) : (
                Object.entries(groups).map(([idLabel, byProgram]) => (
                  <div key={idLabel} className="rounded-xl border border-gray-300 bg-white shadow-sm overflow-hidden mb-6">
                    <div className="bg-[#21804A] text-white px-4 py-3 text-center font-semibold">{idLabel}</div>
                    {Object.entries(byProgram).map(([progLabel, list]) => {
                      const key = `${idLabel}::${progLabel}`;
                      const isCollapsed = !!collapsedGroups[key];
                      return (
                        <div key={key} className="border-t border-gray-200">
                          <button
                            onClick={() =>
                              setCollapsedGroups((prev) => ({
                                ...prev,
                                [key]: !prev[key],
                              }))
                            }
                            className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left"
                          >
                            <span className="font-semibold text-emerald-800">{progLabel}</span>
                            <ChevronDown className={cls("h-4 w-4 transition-transform", isCollapsed && "rotate-180")} />
                          </button>

                          {!isCollapsed && (
                            <div className="p-0">
                              <div className="overflow-x-auto">
                                <table className="w-full text-sm table-fixed border-collapse">
                                  <colgroup>
                                    <col style={{ width: 96 }} />   {/* Program No. */}
                                    <col style={{ width: 280 }} />  {/* Course Code & Title */}
                                    <col style={{ width: 96 }} />   {/* Section */}
                                    <col style={{ width: 180 }} />  {/* Faculty */}
                                    <col style={{ width: 96 }} />   {/* Day 1 */}
                                    <col style={{ width: 96 }} />   {/* Begin 1 */}
                                    <col style={{ width: 96 }} />   {/* End 1 */}
                                    <col style={{ width: 200 }} />  {/* Room 1 */}
                                    <col style={{ width: 96 }} />   {/* Day 2 */}
                                    <col style={{ width: 96 }} />   {/* Begin 2 */}
                                    <col style={{ width: 96 }} />   {/* End 2 */}
                                    <col style={{ width: 200 }} />  {/* Room 2 */}
                                    <col style={{ width: 96 }} />   {/* Capacity */}
                                    <col style={{ width: 200 }} />  {/* Remarks */}
                                    <col style={{ width: 144 }} />  {/* Actions */}
                                  </colgroup>
                                  <thead className="bg-gray-50 text-emerald-800 sticky top-0 z-10">
                                    <tr className="text-[13px] font-semibold">
                                      {[
                                        "Program No.",
                                        "Course Code & Title",
                                        "Section",
                                        "Faculty",
                                        "Day 1",
                                        "Begin 1",
                                        "End 1",
                                        "Room 1",
                                        "Day 2",
                                        "Begin 2",
                                        "End 2",
                                        "Room 2",
                                        "Capacity",
                                        "Remarks",
                                        "Actions",
                                      ].map((h, i) => (
                                        <th key={i} className="px-3 py-2 text-left border border-gray-300">
                                          {h}
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {list.map((r) => {
                                      const isEditing = editing?.row.section.section_id === r.section.section_id;
                                      const canEditDelete = !!r.section.section_id; // no approval gate
                                      const rowKey = rowKeyOf(r);
                                      const ge = isGEType(r.course.type_of_course || "");
                                      const rowIsElective = isElectivePlaceholderType(
                                        r.course.type_of_course || "",
                                        r.course.course_code,
                                        r.course.course_title
                                      );

                                      const suggestion =
                                        r.sizing?.deficit > 0 || (r.sizing?.suggest_additional || 0) > 0 ? (
                                          <div className="mt-1 text-xs text-gray-600">
                                            <span className="mr-3">
                                              Demand: <strong>{r.sizing.planning_demand}</strong>
                                            </span>
                                            <span className="mr-3">
                                              Pre-enlisted: <strong>{r.sizing.preenlistment_total}</strong>
                                            </span>
                                            <span className="mr-3">
                                              Planned cap: <strong>{r.sizing.planned_capacity}</strong>
                                            </span>
                                            {r.sizing.deficit > 0 && <span className="text-red-600 mr-3">Deficit: {r.sizing.deficit}</span>}
                                            {r.sizing.suggest_additional > 0 && (
                                              <span className="text-emerald-700">Suggest +{r.sizing.suggest_additional} section(s)</span>
                                            )}
                                          </div>
                                        ) : null;

                                      const campusName = data?.campus?.campus_name || "";
                                      const currentCode = (r.section.section_code || "").toUpperCase().replace(/\s+/g, "");
                                      const suggestedCode =
                                        normalizeSectionCodeInput(currentCode, r, campusName) || defaultSectionCode(r, campusName);
                                      const showExpected = !currentCode || (suggestedCode && suggestedCode !== currentCode);

                                      const viewRow = (
                                        <tr key={(r.section.section_id || r.course.course_id) + "-v"} className="hover:bg-neutral-50">
                                          <td className="px-3 py-2 border border-gray-300">
                                            {(r.program?.program_code || "—") +
                                              "-" +
                                              (typeof r.block_index === "number" ? r.block_index : 1)}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-300 align-top">
                                            <div className="font-semibold text-emerald-700 break-words">
                                              {r.course.course_code}{" "}
                                              {isGEType(r.course.type_of_course || "") && (
                                                <span className="ml-1 inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 align-middle">
                                                  GE
                                                </span>
                                              )}
                                              {(rowIsElective || isSpecificElectiveType(r.course.type_of_course || "")) && (
                                                <span className="ml-1 inline-block rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 align-middle">
                                                  Elective
                                                </span>
                                              )}
                                            </div>
                                            <div className="text-xs text-gray-500 leading-snug break-words whitespace-normal">
                                              {r.course.course_title}
                                            </div>
                                            {suggestion}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-300">
                                            <div>{currentCode || "—"}</div>
                                            {showExpected && suggestedCode && (
                                              <div className="text-[11px] text-neutral-500 mt-0.5">Expected: {suggestedCode}</div>
                                            )}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-300">
                                            <span className={r.faculty.faculty_name === "UNASSIGNED" ? "text-red-600 font-medium" : ""}>
                                              {r.faculty.faculty_name}
                                            </span>
                                          </td>
                                          <td className="px-3 py-2 border border-gray-300">{r.slot1?.day || "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot1?.start_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot1?.end_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300">{r.slot1?.room_number || r.slot1?.room_id || "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{r.slot2?.day || "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot2?.start_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot2?.end_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300">{r.slot2?.room_number || r.slot2?.room_id || "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{r.section.enrollment_cap ?? "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{r.section.remarks || "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">
                                            <div className="flex flex-wrap gap-2">
                                              {canEditDelete && (
                                                <>
                                                  <button
                                                    className="text-emerald-700 hover:text-emerald-900"
                                                    title="Edit"
                                                    onClick={() => startEdit(r)}
                                                  >
                                                    <Edit className="h-4 w-4" />
                                                  </button>
                                                  <button
                                                    className="text-red-500 hover:text-red-700"
                                                    title="Delete"
                                                    onClick={() => doDelete(r)}
                                                  >
                                                    <Trash2 className="h-4 w-4" />
                                                  </button>
                                                </>
                                              )}
                                              <button
                                                className="text-emerald-700 hover:text-emerald-900"
                                                title="Add row (create section)"
                                                onClick={() => {
                                                  setAddAnchorKey(rowKey);
                                                  setAddElectiveSpecificId("");
                                                  const elective = isElectivePlaceholderType(
                                                    r.course.type_of_course || "",
                                                    r.course.course_code,
                                                    r.course.course_title
                                                  );
                                                  setAddCourseCode(elective ? r.course.course_code : "— Select a course —");

                                                  // remember the row we’re acting on (so we can REPLACE it)
                                                  setAddAnchorSectionId(elective ? (r.section.section_id || null) : null);

                                                  setAddDraft({
                                                    batch_id: r.batch.batch_id,
                                                    program_id: r.program.program_id,
                                                    course_id: elective ? r.course.course_id : "",
                                                    for_placeholder_course_id: elective ? r.course.course_id : undefined,
                                                    specific_course_id: undefined,
                                                    enrollment_cap: r.section.enrollment_cap ?? 20,
                                                    remarks: "",
                                                    slot1: { room_id: "" },
                                                    slot2: { room_id: "" },
                                                    // optional section_code left blank (backend auto). We show hint below.
                                                  });
                                                }}

                                              >
                                                <Plus className="h-4 w-4" />
                                              </button>
                                            </div>
                                          </td>
                                        </tr>
                                      );

                                      const editRow = (
                                        <tr
                                          key={r.section.section_id + "-e"}
                                          className="bg-white"
                                          style={{ boxShadow: "0 2px 10px rgba(0,0,0,0.05)" }}
                                        >
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            {(r.program?.program_code || "—") +
                                              "-" +
                                              (typeof r.block_index === "number" ? r.block_index : 1)}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-200 bg-white align-top">
                                            <div className="font-semibold text-emerald-700 break-words">{r.course.course_code}</div>
                                            <div className="text-xs text-gray-500 leading-snug break-words whitespace-normal">
                                              {r.course.course_title}
                                            </div>

                                            {(() => {
                                              const isPlaceholder = isElectivePlaceholderType(
                                                r.course.type_of_course || "",
                                                r.course.course_code,
                                                r.course.course_title
                                              );
                                              const isSpecific = isSpecificElectiveType(r.course.type_of_course || "");
                                              const hasParent = !!(r.links?.elective_placeholder_course_id || (isPlaceholder ? r.course.course_id : ""));
                                              const electiveEditable = isPlaceholder || isSpecific || hasParent;

                                              if (!electiveEditable) return null;

                                              // Prefer the server list if it exists and has items; else fallback to derived list
                                              const preferServer =
                                              Array.isArray(data?.all_specific_electives) && data!.all_specific_electives!.length > 0
                                                ? data!.all_specific_electives!
                                                : allSpecificElectives;

                                            const parentId =
                                              editing?.draft.for_placeholder_course_id ||
                                              r.links?.elective_placeholder_course_id ||
                                              (isPlaceholder ? r.course.course_id : "");

                                            // NEW: prefer per-placeholder cache, else the global list
                                            const sourceList =
                                              (parentId && electiveOptionsCache[parentId]) ||
                                              preferServer;

                                            const specificList = (sourceList || []).filter((o) =>
                                              isSpecificElectiveType(o.type_of_course || "")
                                            );

                                            const currentSpecific = editing?.draft.specific_course_id || (isSpecific ? r.course.course_id : "");


                                              return (
                                                <div className="mt-2">
                                                  <label className="text-xs font-medium text-slate-700 mb-1 block">Specific Elective</label>
                                                  <div className="relative">
                                                    <select
                                                      className={SOFT_SELECT}
                                                      value={currentSpecific || ""}
                                                      onChange={(e) => {
                                                        const sid = e.target.value || "";
                                                        setEditing((p) =>
                                                          p && {
                                                            ...p,
                                                            draft: {
                                                              ...p.draft,
                                                              // keep parent linkage if we know it
                                                              for_placeholder_course_id: parentId || undefined,
                                                              specific_course_id: sid || undefined,
                                                            },
                                                          }
                                                        );
                                                      }}
                                                    >
                                                      <option value="">— Select specific elective —</option>
                                                      {specificList.map((opt) => {
                                                        const code = codeOf(opt.course_code);
                                                        return (
                                                          <option key={opt.course_id} value={opt.course_id}>
                                                            {code} • {opt.course_title}
                                                          </option>
                                                        );
                                                      })}
                                                    </select>
                                                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                                                  </div>
                                                </div>
                                              );
                                            })()}
                                          </td>

                                          {/* Section code */}
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                          <input
                                            value={editing?.draft.section_code || ""}
                                            onChange={(e) => {
                                              const raw = e.target.value || "";
                                              setEditing((p) => p && { ...p, draft: { ...p.draft, section_code: raw.toUpperCase() } });
                                            }}
                                            onBlur={(e) => {
                                              const raw = (e.target.value || "").trim();
                                              // still no normalize here — just keep an uppercase, trimmed value
                                              setEditing((p) => p && { ...p, draft: { ...p.draft, section_code: raw.toUpperCase() } });
                                            }}
                                            placeholder={defaultSectionCode(r, data?.campus?.campus_name || "") || "Section code"}
                                            className={SOFT_INPUT}
                                          />

                                            {(() => {
                                              const campusName = data?.campus?.campus_name || "";
                                              const editRaw = (editing?.draft.section_code || "").toUpperCase().replace(/\s+/g, "");
                                              const editSuggested =
                                                normalizeSectionCodeInput(editRaw, r, campusName) || defaultSectionCode(r, campusName);
                                              const showPrefixHint = !editRaw || (editSuggested && editSuggested !== editRaw);
                                              return showPrefixHint && editSuggested ? (
                                                <div className="text-[11px] text-neutral-500 mt-1">
                                                  Expected prefix → <b>{editSuggested.replace(/\d+$/,"")}</b> (e.g., {editSuggested})
                                                </div>
                                              ) : null;
                                            })()}
                                          </td>

                                          {/* Faculty - editable if GE */}
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            {ge ? (
                                              <input
                                                value={editing?.draft.faculty_name || ""}
                                                onChange={(e) =>
                                                  setEditing((p) => p && { ...p, draft: { ...p.draft, faculty_name: e.target.value } })
                                                }
                                                placeholder="Faculty name"
                                                className={SOFT_INPUT}
                                              />
                                            ) : (
                                              <span className={r.faculty.faculty_name === "UNASSIGNED" ? "text-red-600 font-medium" : ""}>
                                                {r.faculty.faculty_name || "UNASSIGNED"}
                                              </span>
                                            )}
                                          </td>

                                          {/* Slot 1 */}
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            {ge ? (
                                              <div className="relative">
                                                <select
                                                  value={editing?.draft.slot1?.day || ""}
                                                  onChange={(e) =>
                                                    setEditing(
                                                      (p) =>
                                                        p &&
                                                        {
                                                          ...p,
                                                          draft: {
                                                            ...p.draft,
                                                            slot1: { ...(p.draft.slot1 || {}), day: e.target.value as Day | "" },
                                                          },
                                                        }
                                                    )
                                                  }
                                                  className={SOFT_SELECT}
                                                >
                                                  <option value="">—</option>
                                                  {DAYS.map((d) => (
                                                    <option key={d} value={d}>
                                                      {d}
                                                    </option>
                                                  ))}
                                                </select>
                                                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                                              </div>
                                            ) : (
                                              r.slot1?.day || "—"
                                            )}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            {ge ? (
                                              <input
                                                value={editing?.draft.slot1?.start_time || ""}
                                                onChange={(e) =>
                                                  setEditing(
                                                    (p) =>
                                                      p &&
                                                      {
                                                        ...p,
                                                        draft: {
                                                          ...p.draft,
                                                          slot1: { ...(p.draft.slot1 || {}), start_time: sanitizeTime(e.target.value) },
                                                        },
                                                      }
                                                  )
                                                }
                                                placeholder="HHMM"
                                                className={SOFT_INPUT}
                                              />

                                            ) : (
                                              fmtTime(r.slot1?.start_time)
                                            )}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            {ge ? (
                                            <input
                                              value={editing?.draft.slot1?.end_time || ""}
                                              onChange={(e) =>
                                                setEditing(
                                                  (p) =>
                                                    p &&
                                                    {
                                                      ...p,
                                                      draft: {
                                                        ...p.draft,
                                                        slot1: { ...(p.draft.slot1 || {}), end_time: sanitizeTime(e.target.value) },
                                                      },
                                                    }
                                                )
                                              }
                                              placeholder="HHMM"
                                              className={SOFT_INPUT}
                                            />

                                            ) : (
                                              fmtTime(r.slot1?.end_time)
                                            )}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-200 bg-white relative overflow-visible">
                                            <RoomSelectBox
                                              rooms={filterRoomsByCap(data?.room_options || [])}
                                              value={editing?.draft.slot1?.room_id || null}
                                              disabled={!slotReady(editing?.draft.slot1)}    // still locked until Day+Begin+End
                                              onChange={(roomId) =>
                                                setEditing(p => p && ({
                                                  ...p,
                                                  draft: { ...p.draft, slot1: { ...(p.draft.slot1 || {}), room_id: roomId ?? "" } }
                                                }))
                                              }
                                            />
                                          </td>

                                          {/* Slot 2 */}
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            {ge ? (
                                              <div className="relative">
                                                <select
                                                  value={editing?.draft.slot2?.day || ""}
                                                  onChange={(e) =>
                                                    setEditing(
                                                      (p) =>
                                                        p &&
                                                        {
                                                          ...p,
                                                          draft: {
                                                            ...p.draft,
                                                            slot2: { ...(p.draft.slot2 || {}), day: e.target.value as Day | "" },
                                                          },
                                                        }
                                                    )
                                                  }
                                                  className={SOFT_SELECT}
                                                >
                                                  <option value="">—</option>
                                                  {DAYS.map((d) => (
                                                    <option key={d} value={d}>
                                                      {d}
                                                    </option>
                                                  ))}
                                                </select>
                                                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                                              </div>
                                            ) : (
                                              r.slot2?.day || "—"
                                            )}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            {ge ? (
                                              <input
                                                value={editing?.draft.slot2?.start_time || ""}
                                                onChange={(e) =>
                                                  setEditing(
                                                    (p) =>
                                                      p &&
                                                      {
                                                        ...p,
                                                        draft: {
                                                          ...p.draft,
                                                          slot2: { ...(p.draft.slot2 || {}), start_time: sanitizeTime(e.target.value) },
                                                        },
                                                      }
                                                  )
                                                }
                                                placeholder="HHMM"
                                                className={SOFT_INPUT}
                                              />

                                            ) : (
                                              fmtTime(r.slot2?.start_time)
                                            )}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            {ge ? (
                                              <input
                                                value={editing?.draft.slot2?.end_time || ""}
                                                onChange={(e) =>
                                                  setEditing(
                                                    (p) =>
                                                      p &&
                                                      {
                                                        ...p,
                                                        draft: {
                                                          ...p.draft,
                                                          slot2: { ...(p.draft.slot2 || {}), end_time: sanitizeTime(e.target.value) },
                                                        },
                                                      }
                                                  )
                                                }
                                                placeholder="HHMM"
                                                className={SOFT_INPUT}
                                              />

                                            ) : (
                                              fmtTime(r.slot2?.end_time)
                                            )}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-200 bg-white relative overflow-visible">
                                            <RoomSelectBox
                                              rooms={filterRoomsByCap(data?.room_options || [])}
                                              value={editing?.draft.slot2?.room_id || null}
                                              disabled={!slotReady(editing?.draft.slot2)}
                                              onChange={(roomId) =>
                                                setEditing(p => p && ({
                                                  ...p,
                                                  draft: { ...p.draft, slot2: { ...(p.draft.slot2 || {}), room_id: roomId ?? "" } }
                                                }))
                                              }
                                            />
                                          </td>

                                          {/* Capacity */}
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            <input
                                              value={editing?.draft.enrollment_cap ?? ""}
                                              onChange={(e) => {
                                                const v = e.target.value;
                                                setEditing((p) =>
                                                  p
                                                    ? {
                                                        ...p,
                                                        draft: { ...p.draft, enrollment_cap: v === "" ? "" : Number(v) },
                                                      }
                                                    : p
                                                );
                                              }}
                                              placeholder="(blank to clear)"
                                              className={SOFT_INPUT}
                                            />
                                          </td>

                                          {/* Remarks */}
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            <input
                                              value={editing?.draft.remarks || ""}
                                              onChange={(e) =>
                                                setEditing((p) => p && { ...p, draft: { ...p.draft, remarks: e.target.value } })
                                              }
                                              className={SOFT_INPUT}
                                            />
                                          </td>

                                          {/* Actions */}
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            <div className="flex items-center gap-2">
                                              <button
                                                onClick={saveEdit}
                                                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50"
                                                title="Save"
                                              >
                                                <Check className="h-4 w-4" strokeWidth={2.5} />
                                              </button>
                                              <button
                                                onClick={() => setEditing(null)}
                                                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50"
                                                title="Cancel"
                                              >
                                                <X className="h-4 w-4" strokeWidth={2.5} />
                                              </button>
                                            </div>
                                          </td>
                                        </tr>
                                      );

                                      /* ---------- Inline Add Row ---------- */
                                      const addInline =
                                        addAnchorKey === rowKey && (
                                          <tr
                                            key={(r.section.section_id || r.course.course_id) + "-a"}
                                            className="bg-white"
                                            style={{ boxShadow: "0 2px 10px rgba(0,0,0,0.05)" }}
                                          >
                                            <td className="px-3 py-2 border border-gray-200 bg-white">
                                              {(r.program?.program_code || "—") +
                                                "-" +
                                                (typeof r.block_index === "number" ? r.block_index : 1)}
                                            </td>
                                            <td className="px-3 py-2 border border-gray-200 bg-white align-top">
                                              {(() => {
                                                  const groupKey = `${r.batch.batch_id}|${r.program.program_id}`;
                                                  const groupOptions: CourseOption[] = data?.course_options_by_group?.[groupKey] || [];
                                                  const codes = [
                                                    "— Select a course —",
                                                    ...groupOptions
                                                      .filter((o) => !isSpecificElectiveType(o.type_of_course || "")) // hide "Elective Course"
                                                      .map((o) => codeOf(o.course_code)),
                                                  ];

                                                  const codeToId: Record<string, string> = {};
                                                  const codeToTitle: Record<string, string> = {};
                                                  const codeToType: Record<string, string> = {};
                                                  groupOptions.forEach((o) => {
                                                    const c = codeOf(o.course_code);
                                                    codeToId[c] = o.course_id;
                                                    codeToTitle[c] = titleOf(o.course_title);
                                                    codeToType[c] = (o.type_of_course as string) || "";
                                                  });

                                                  const rowIsElective = isElectivePlaceholderType(
                                                    r.course.type_of_course || "",
                                                    r.course.course_code as any,
                                                    r.course.course_title
                                                  );
                                                  let specificElectives = groupOptions.filter((o) =>
                                                    isSpecificElectiveType(o.type_of_course || "")
                                                  );

                                                  const parentId = r.course.course_id; // placeholder row's course_id

                                                  // NEW: prefetch and prefer per-placeholder cache
                                                  if (parentId) ensureElectiveOptionsFor(parentId);

                                                  const preferServer =
                                                    Array.isArray(data?.all_specific_electives) && data!.all_specific_electives!.length > 0
                                                      ? data!.all_specific_electives!
                                                      : allSpecificElectives;

                                                  specificElectives =
                                                    (parentId && electiveOptionsCache[parentId]) ||
                                                    specificElectives.length
                                                      ? specificElectives
                                                      : preferServer.filter((o) => isSpecificElectiveType(o.type_of_course || ""));


                                                  const selectedType = codeToType[addCourseCode] || "";
                                                  const isGE = isGEType(selectedType);
                                                  return (
                                                    <>
                                                      {/* Primary course select (disabled if this row is a placeholder elective) */}
                                                      <div className="mb-2">
                                                        <SelectBox
                                                            value={addCourseCode}
                                                            onChange={(v: string) => {
                                                            if (rowIsElective) return; // fixed to the placeholder course
                                                            setAddCourseCode(v);
                                                            setAddElectiveSpecificId("");
                                                            setAddDraft((p: AddDraft) => ({
                                                              ...p,
                                                              batch_id: r.batch.batch_id,
                                                              program_id: r.program.program_id,
                                                              course_id: codeToId[v] || "",
                                                              for_placeholder_course_id: undefined,
                                                              specific_course_id: undefined,
                                                            }));
                                                          }}
                                                          options={codes}
                                                          disabled={rowIsElective}
                                                          className="!min-w-0 w-full max-w-full" 
                                                        />
                                                      </div>
                                                      <div className="text-xs text-neutral-600 flex items-center gap-2 mb-2">
                                                        <span className="truncate">
                                                          {rowIsElective
                                                            ? r.course.course_title
                                                            : codeToTitle[addCourseCode] || "—"}
                                                        </span>
                                                        {isGE && (
                                                          <span className="inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                                                            GE
                                                          </span>
                                                        )}
                                                        {rowIsElective && (
                                                          <span className="inline-block rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                                                            Elective
                                                          </span>
                                                        )}
                                                      </div>

                                                      {/* Secondary select only for Elective placeholders */}
                                                      {rowIsElective && (
                                                        <div className="mb-2">
                                                          <label className="text-xs font-medium text-slate-700 mb-1 block">
                                                            Specific Elective
                                                          </label>
                                                          <div className="relative">
                                                            <select
                                                              className={SOFT_SELECT}
                                                              value={addElectiveSpecificId}
                                                              onChange={(e) => {
                                                                const sid = e.target.value;
                                                                setAddElectiveSpecificId(sid);
                                                                setAddDraft((p) => ({
                                                                  ...p,
                                                                  for_placeholder_course_id: r.course.course_id,
                                                                  specific_course_id: sid || undefined,
                                                                  course_id: sid || "",
                                                                }));
                                                              }}
                                                            >
                                                              <option value="">— Select specific elective —</option>
                                                              {specificElectives.map((opt) => {
                                                                const code = codeOf(opt.course_code);
                                                                return (
                                                                  <option value={opt.course_id} key={opt.course_id}>
                                                                    {code} • {opt.course_title}
                                                                  </option>
                                                                );
                                                              })}
                                                            </select>
                                                            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                                                          </div>
                                                        </div>
                                                      )}
                                                    </>
                                                  );
                                                })()}
                                            </td>

                                            {/* Section column (Auto) with expected hint */}
                                            <td className="px-3 py-2 border border-gray-200 bg-white">
                                              <div>Auto</div>
                                              {(() => {
                                                const hint = defaultSectionCode(r, data?.campus?.campus_name || "");
                                                return hint ? (
                                                  <div className="text-[11px] text-neutral-500 mt-0.5">
                                                    Will follow campus rules → <b>{hint}</b>
                                                  </div>
                                                ) : null;
                                              })()}
                                            </td>

                                            <td className="px-3 py-2 border border-gray-200 bg-white">UNASSIGNED</td>
                                            <td className="px-3 py-2 border border-gray-200 bg-white">—</td>
                                            <td className="px-3 py-2 border border-gray-200 bg-white">—</td>
                                            <td className="px-3 py-2 border border-gray-200 bg-white">—</td>
                                            <td className="px-3 py-2 border border-gray-200 bg-white">
                                              <RoomSelectBox
                                                rooms={filterRoomsByCap(data?.room_options || [])}
                                                value={addDraft.slot1?.room_id || null}
                                                disabled={true}                         // stays disabled in Add Row
                                                onChange={(roomId) =>
                                                  setAddDraft(p => ({ ...p, slot1: { ...(p.slot1 || {}), room_id: roomId ?? "" } }))
                                                }
                                                className="opacity-60"
                                              />
                                            </td>

                                            <td className="px-3 py-2 border border-gray-200 bg-white">—</td>
                                            <td className="px-3 py-2 border border-gray-200 bg-white">—</td>
                                            <td className="px-3 py-2 border border-gray-200 bg-white">—</td>
                                            <td className="px-3 py-2 border border-gray-200 bg-white">
                                              <RoomSelectBox
                                                rooms={filterRoomsByCap(data?.room_options || [])}
                                                value={addDraft.slot2?.room_id || null}
                                                disabled={true}
                                                onChange={(roomId) =>
                                                  setAddDraft(p => ({ ...p, slot2: { ...(p.slot2 || {}), room_id: roomId ?? "" } }))
                                                }
                                                className="opacity-60"
                                              />
                                            </td>

                                            <td className="px-3 py-2 border border-gray-200 bg-white">
                                              <input
                                                value={addDraft.enrollment_cap ?? ""}
                                                onChange={(e) => setAddDraft((p) => ({ ...p, enrollment_cap: Number(e.target.value || 0) }))}
                                                className={SOFT_INPUT}
                                              />
                                            </td>
                                            <td className="px-3 py-2 border border-gray-200 bg-white">
                                              <input
                                                value={addDraft.remarks || ""}
                                                onChange={(e) => setAddDraft((p) => ({ ...p, remarks: e.target.value }))}
                                                className={SOFT_INPUT}
                                              />
                                            </td>
                                            <td className="px-3 py-2 border border-gray-200 bg-white">
                                              <div className="flex justify-start gap-2">
                                                <button
                                                  disabled={
                                                    adding ||
                                                    !(
                                                      addDraft.specific_course_id || // elective case
                                                      addDraft.course_id // non-elective
                                                    )
                                                  }
                                                  onClick={doAdd}
                                                  className={cls(
                                                    "flex h-8 w-8 items-center justify-center rounded-full border-2",
                                                    "border-green-600 text-green-600 hover:bg-green-50 disabled:opacity-50"
                                                  )}
                                                  title="Save"
                                                >
                                                  <Check className="h-4 w-4" strokeWidth={2.5} />
                                                </button>
                                                <button
                                                  onClick={() => {
                                                    setAddAnchorKey(null);
                                                    setAddElectiveSpecificId("");
                                                  }}
                                                  className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50"
                                                  title="Cancel"
                                                >
                                                  <X className="h-4 w-4" strokeWidth={2.5} />
                                                </button>
                                              </div>
                                            </td>
                                          </tr>
                                        );

                                      return (
                                        <React.Fragment key={r.section.section_id || r.course.course_id}>
                                          {isEditing ? editRow : viewRow}
                                          {addInline}
                                        </React.Fragment>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </>
          )}

          {/* ------------------------------ Curriculum ----------------------------- */}
          {view === "curriculum" && (
            <div className="rounded-xl border border-gray-300 bg-white shadow-sm overflow-hidden">
              {/* Header follows selection state */}
              <div className="bg-emerald-700 text-white px-4 py-3 text-center font-semibold">
                {selectedBatchId
                  ? `ID ${
                      (curr?.items || [])
                        .find((i) => i.batch_id === selectedBatchId)
                        ?.batch_code?.replace(/^ID\s*/i, "") || "—"
                    }`
                  : "Curriculum"}
              </div>

              {/* Single ID view */}
              {selectedBatchId ? (
                <div className="p-3 overflow-x-auto">
                  <div
                    className="grid gap-4"
                    style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}
                  >
                    {Object.keys(singleBatchPrograms)
                      .sort((a, b) =>
                        (singleBatchPrograms[a]?.program_code || "").localeCompare(
                          singleBatchPrograms[b]?.program_code || ""
                        )
                      )
                      .map((pid) => {
                        const itm = (singleBatchPrograms as any)[pid] as CurriculumItem | undefined;
                        if (!itm) return null;

                        const programCode = itm?.program_code || "—";
                        const deptId = itm?.department_id || "";
                        const canAdd = !!selectedBatchId;
                        const opts = optionsByProgram[pid] || [];
                        const selectedId = currAddSel[pid] || "";

                        const allowedIds = eligibleCourseIdsByProgram[pid] || new Set<string>();
                        const filteredOpts = (opts || []).filter((o) => allowedIds.has(o.course_id));

                        const codeOptions = filteredOpts.map((o) => o.course_code);
                        const codeToId: Record<string, string> = {};
                        const idToCode: Record<string, string> = {};
                        filteredOpts.forEach((o) => {
                          codeToId[o.course_code] = o.course_id;
                          idToCode[o.course_id] = o.course_code;
                        });

                        const selectedLabel = selectedId ? idToCode[selectedId] || "— Add course —" : "— Add course —";

                        const filteredCourses = (itm?.courses || []).filter((c) => {
                          if (!currSearch.trim()) return true;
                          const q = currSearch.toLowerCase();
                          return c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q);
                        });

                        return (
                          <div key={pid} className="rounded-lg border border-gray-200 overflow-hidden">
                            {/* header with add controls */}
                            <div className="flex items-center justify-between gap-2 border-b bg-gray-50 px-3 py-2">
                              <div className="font-semibold text-emerald-800 truncate" title={programCode}>
                                {programCode}
                              </div>

                              <div className="flex items-center gap-2 w-full max-w-full">
                                <div className="w-full min-w-0">
                                  <SelectBox
                                    value={selectedLabel}
                                    onChange={(label: string) => {
                                      const cid = codeToId[label] || "";
                                      setCurrAddSel((p) => ({ ...p, [pid]: cid }));
                                    }}
                                    options={["— Add course —", ...codeOptions]}
                                  />
                                </div>

                                <button
                                  className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white shadow-sm"
                                  disabled={!canAdd || !selectedId}
                                  onClick={() => {
                                    if (!selectedBatchId || !selectedId) return;
                                    handleCurrAdd(pid, selectedBatchId, selectedId);
                                  }}
                                >
                                  <Plus className="h-4 w-4" />
                                  Add
                                </button>

                                <button
                                  className="inline-flex items-center gap-2 rounded-md border border-emerald-700 px-3 py-1.5 text-sm font-medium text-emerald-700"
                                  onClick={() => {
                                    if (!selectedBatchId) return;
                                    const code = prompt("New course code:")?.trim();
                                    const title = code ? prompt("Course title:")?.trim() : "";
                                    const level = title
                                      ? prompt("Program level (Undergraduate or Graduate Studies):")?.trim()
                                      : "";
                                    const unitsStr = level ? prompt("Units (number):")?.trim() : "";
                                    const unitsNum = unitsStr ? Number(unitsStr) : undefined;
                                    if (!code || !title || !level) return;
                                    handleCurrAddCustom(pid, selectedBatchId, {
                                      course_code: normCode(code),
                                      course_title: title!,
                                      department_id: deptId,
                                      program_level: level!,
                                      units: isNaN(unitsNum as number) ? undefined : (unitsNum as number),
                                    });
                                  }}
                                >
                                  <Plus className="h-4 w-4" />
                                  Custom
                                </button>
                              </div>
                            </div>

                            {/* body: course cards */}
                            <div className="divide-y">
                              {filteredCourses.length === 0 && (
                                <div className="px-3 py-6 text-sm text-neutral-500 text-center">No courses.</div>
                              )}

                              {filteredCourses.map((c) => {
                                const units = typeof c.units === "number" ? c.units : null;

                                const allowedForReplace = (opts || []).filter((o) =>
                                  (eligibleCourseIdsByProgram[pid] || new Set()).has(o.course_id)
                                );
                                const replaceCodes = allowedForReplace.map((o) => o.course_code);
                                const replaceCodeToId: Record<string, string> = {};
                                allowedForReplace.forEach((o) => (replaceCodeToId[o.course_code] = o.course_id));
                                const replacePlaceholder = "Edit…";

                                return (
                                  <div key={c.course_id} className="px-3 py-2 bg-white">
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <div className="font-semibold text-emerald-700 break-words">{c.code}</div>
                                        <div className="text-[11px] text-neutral-600 truncate" title={c.title}>
                                          {c.title}
                                        </div>
                                      </div>
                                      <div className="flex items-center gap-3">
                                        <input
                                          type="number"
                                          step="0.5"
                                          defaultValue={units ?? ""}
                                          placeholder="units"
                                          className="h-9 w-16 rounded border px-2 text-sm text-center"
                                          onBlur={(e) => {
                                            if (!selectedBatchId) return;
                                            const v = e.currentTarget.value.trim();
                                            const num = v === "" ? null : Number(v);
                                            if (v === "" || !isNaN(num!)) {
                                              handleCurrEditUnits(pid, selectedBatchId, c.course_id, num);
                                            }
                                          }}
                                        />
                                        <button
                                          className="text-red-500 hover:text-red-700"
                                          title="Remove"
                                          onClick={() => selectedBatchId && handleCurrRemove(pid, selectedBatchId, c.course_id)}
                                        >
                                          <Trash2 className="h-4 w-4" />
                                        </button>
                                      </div>
                                    </div>

                                    {/* replace via SelectBox (codes only) */}
                                    <div className="mt-2 w-full min-w-0">
                                      <SelectBox
                                        value={replacePlaceholder}
                                        onChange={(label: string) => {
                                          if (label === replacePlaceholder) return;
                                          const newId = replaceCodeToId[label];
                                          if (!newId || !selectedBatchId) return;
                                          handleCurrReplace(pid, selectedBatchId, c.course_id, newId);
                                        }}
                                        options={[replacePlaceholder, ...replaceCodes]}
                                      />
                                    </div>
                                  </div>
                                );
                              })}

                              {/* footer: total units */}
                              <div className="px-3 py-2 bg-emerald-50">
                                <div className="flex items-center justify-between font-semibold text-emerald-800">
                                  <span>Total</span>
                                  <span>
                                    {filteredCourses.reduce((s, c) => s + (typeof c.units === "number" ? c.units : 0), 0)}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              ) : (
                /* ===== All IDs view ===== */
                <div className="divide-y">
                  {curriculumByBatch.length === 0 && (
                    <div className="px-3 py-6 text-sm text-neutral-500 text-center">No curriculum data.</div>
                  )}

                  {curriculumByBatch.map((grp) => {
                    const programList = Object.values(grp.programs).sort((a, b) =>
                      (a.program_code || "").localeCompare(b.program_code || "")
                    );
                    return (
                      <div key={grp.batch_id} className="overflow-hidden">
                        <div className="bg-emerald-600 text-white px-4 py-2 font-semibold text-center">
                          {grp.batch_code}
                        </div>
                        <div className="p-3 overflow-x-auto">
                          <div
                            className="grid gap-4"
                            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}
                          >
                            {programList.map((itm) => {
                              const pid = itm.program_id;
                              const programCode = itm?.program_code || "—";
                              const deptId = itm?.department_id || "";
                              const opts = optionsByProgram[pid] || [];
                              const selectedId = currAddSel[pid] || "";

                              const allowedIds = eligibleCourseIdsByProgram[pid] || new Set<string>();
                              const filteredOpts = (opts || []).filter((o) => allowedIds.has(o.course_id));

                              const codeOptions = filteredOpts.map((o) => o.course_code);
                              const codeToId: Record<string, string> = {};
                              const idToCode: Record<string, string> = {};
                              filteredOpts.forEach((o) => {
                                codeToId[o.course_code] = o.course_id;
                                idToCode[o.course_id] = o.course_code;
                              });

                              const selectedLabel = selectedId ? idToCode[selectedId] || "— Add course —" : "— Add course —";

                              const filteredCourses = (itm?.courses || []).filter((c) => {
                                if (!currSearch.trim()) return true;
                                const q = currSearch.toLowerCase();
                                return c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q);
                              });

                              return (
                                <div key={pid} className="rounded-lg border border-gray-200 overflow-hidden">
                                  {/* header with add controls */}
                                  <div className="flex items-center justify-between gap-2 border-b bg-gray-50 px-3 py-2">
                                    <div className="font-semibold text-emerald-800 truncate" title={programCode}>
                                      {programCode}
                                    </div>

                                    <div className="flex items-center gap-2 w-full max-w-full">
                                      <div className="w-full min-w-0">
                                        <SelectBox
                                          value={selectedLabel}
                                          onChange={(label: string) => {
                                            const cid = codeToId[label] || "";
                                            setCurrAddSel((p) => ({ ...p, [pid]: cid }));
                                          }}
                                          options={["— Add course —", ...codeOptions]}
                                        />
                                      </div>

                                      <button
                                        className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white shadow-sm"
                                        disabled={!grp.batch_id || !selectedId}
                                        onClick={() => {
                                          if (!grp.batch_id || !selectedId) return;
                                          handleCurrAdd(pid, grp.batch_id, selectedId);
                                        }}
                                      >
                                        <Plus className="h-4 w-4" />
                                        Add
                                      </button>

                                      <button
                                        className="inline-flex items-center gap-2 rounded-md border border-emerald-700 px-3 py-1.5 text-sm font-medium text-emerald-700"
                                        onClick={() => {
                                          const code = prompt("New course code:")?.trim();
                                          const title = code ? prompt("Course title:")?.trim() : "";
                                          const level = title
                                            ? prompt("Program level (Undergraduate or Graduate Studies):")?.trim()
                                            : "";
                                          const unitsStr = level ? prompt("Units (number):")?.trim() : "";
                                          const unitsNum = unitsStr ? Number(unitsStr) : undefined;
                                          if (!code || !title || !level || !grp.batch_id) return;
                                          handleCurrAddCustom(pid, grp.batch_id, {
                                            course_code: normCode(code),
                                            course_title: title!,
                                            department_id: deptId,
                                            program_level: level!,
                                            units: isNaN(unitsNum as number) ? undefined : (unitsNum as number),
                                          });
                                        }}
                                      >
                                        <Plus className="h-4 w-4" />
                                        Custom
                                      </button>
                                    </div>
                                  </div>

                                  {/* body: course cards */}
                                  <div className="divide-y">
                                    {filteredCourses.length === 0 && (
                                      <div className="px-3 py-6 text-sm text-neutral-500 text-center">No courses.</div>
                                    )}

                                    {filteredCourses.map((c) => {
                                      const units = typeof c.units === "number" ? c.units : null;

                                      const allowedForReplace = (opts || []).filter((o) =>
                                        (eligibleCourseIdsByProgram[pid] || new Set()).has(o.course_id)
                                      );
                                      const replaceCodes = allowedForReplace.map((o) => o.course_code);
                                      const replaceCodeToId: Record<string, string> = {};
                                      allowedForReplace.forEach((o) => (replaceCodeToId[o.course_code] = o.course_id));
                                      const replacePlaceholder = "Edit…";

                                      return (
                                        <div key={c.course_id} className="px-3 py-2 bg-white">
                                          <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                              <div className="font-semibold text-emerald-700 break-words">{c.code}</div>
                                              <div className="text-[11px] text-neutral-600 truncate" title={c.title}>
                                                {c.title}
                                              </div>
                                            </div>
                                            <div className="flex items-center gap-3">
                                              <input
                                                type="number"
                                                step="0.5"
                                                defaultValue={units ?? ""}
                                                placeholder="units"
                                                className="h-9 w-16 rounded border px-2 text-sm text-center"
                                                onBlur={(e) => {
                                                  const v = e.currentTarget.value.trim();
                                                  const num = v === "" ? null : Number(v);
                                                  if (v === "" || !isNaN(num!)) {
                                                    handleCurrEditUnits(pid, grp.batch_id, c.course_id, num);
                                                  }
                                                }}
                                              />
                                              <button
                                                className="text-red-500 hover:text-red-700"
                                                title="Remove"
                                                onClick={() => handleCurrRemove(pid, grp.batch_id, c.course_id)}
                                              >
                                                <Trash2 className="h-4 w-4" />
                                              </button>
                                            </div>
                                          </div>

                                          {/* replace via SelectBox (codes only) */}
                                          <div className="mt-2 w-full min-w-0">
                                            <SelectBox
                                              value={replacePlaceholder}
                                              onChange={(label: string) => {
                                                if (label === replacePlaceholder) return;
                                                const newId = replaceCodeToId[label];
                                                if (!newId) return;
                                                handleCurrReplace(pid, grp.batch_id, c.course_id, newId);
                                              }}
                                              options={[replacePlaceholder, ...replaceCodes]}
                                            />
                                          </div>
                                        </div>
                                      );
                                    })}

                                    {/* footer: total units */}
                                    <div className="px-3 py-2 bg-emerald-50">
                                      <div className="flex items-center justify-between font-semibold text-emerald-800">
                                        <span>Total</span>
                                        <span>
                                          {filteredCourses.reduce(
                                            (s, c) => s + (typeof c.units === "number" ? c.units : 0),
                                            0
                                          )}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* ----------------------------- Conflict Modal ----------------------------- */}
      {conflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl border border-gray-200">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              <div className="font-semibold">Conflicts detected</div>
            </div>
            <div className="p-4 max-h-[70vh] overflow-auto space-y-3">
              <div className="text-sm">
                The system found some issues with your change. You can review the details below and choose to override if
                appropriate.
              </div>
              <div className="rounded border border-amber-200 bg-amber-50 p-3">
                <ul className="list-disc pl-5 text-sm text-amber-900 space-y-1">
                  {conflict.violations.map((v, i) => (
                    <li key={i}>
                      <span className="font-medium">{v.code}</span>: {v.message}
                    </li>
                  ))}
                </ul>
              </div>
              {conflict.preview && (
                <div>
                  <div className="text-xs font-semibold text-slate-700 mb-1">Preview of changes</div>
                  <pre className="text-xs bg-slate-50 border rounded p-2 overflow-auto">
{JSON.stringify(conflict.preview, null, 2)}
                  </pre>
                </div>
              )}
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1 block">Override reason (optional)</label>
                <input
                  className="w-full rounded border px-3 py-2 text-sm"
                  value={conflict.reason}
                  onChange={(e) => setConflict({ ...conflict, reason: e.target.value })}
                  placeholder="e.g., Proceed despite planning warnings"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
              <button
                className="rounded-md border px-3 py-1.5 text-sm"
                onClick={() => setConflict(null)}
              >
                Cancel
              </button>
              <button
                className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white"
                onClick={async () => {
                  if (!conflict || !user?.userId) return;
                  const ov = {
                    override: true,
                    override_token: conflict.token,
                    override_reason: conflict.reason || "Proceed with override",
                  } as any;

                  try {
                    if (conflict.action === "add") {
                      await addApoOfferingRow(user.userId, { ...(conflict.original as any), ...ov });
                    } else if (conflict.action === "edit") {
                      await editApoOfferingRow(user.userId, { ...(conflict.original as any), ...ov });
                    } else if (conflict.action === "delete") {
                      await deleteApoOfferingRow(user.userId, { ...(conflict.original as any), ...ov });
                    }
                    setConflict(null);
                    await loadOfferings();
                  } catch (e: any) {
                    alert(e?.message || "Failed to apply override.");
                  }
                }}
              >
                Override &amp; Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ----------------------------- Forward Modal ----------------------------- */}
      {showForward && (
        <ForwardModal
          onClose={() => setShowForward(false)}
          onSubmit={async (note) => {
            if (!user?.userId) return;
            try {
              await forwardApoCourseOfferings(user.userId, {
                to: "", // leave empty if backend resolves recipients
                subject: `Course Offerings – ${data?.term_label || ""}`,
                message: note,
              });
              setShowForward(false);
              alert("Plan forwarded.");
            } catch (e: any) {
              alert(e?.message || "Failed to forward.");
            }
          }}
        />
      )}

      {/* --------------------------- Planning Review Modal --------------------------- */}
      {showPlanModal && data?.planning && (
        <PlanReviewModal
          changes={data.planning.pending_changes || []}
          onClose={() => setShowPlanModal(false)}
          onApprove={async () => {
            if (!user?.userId) return;
            try {
              await approveApoOfferingsPlan(user.userId);
              setShowPlanModal(false);
              await loadOfferings();
            } catch (e: any) {
              alert(e?.message || "Failed to approve plan.");
            }
          }}
        />
      )}
    </div>
  );
}

/* --------------------------- Small helper components --------------------------- */
const ForwardModal: React.FC<{
  onClose: () => void;
  onSubmit: (note: string) => void | Promise<void>;
}> = ({ onClose, onSubmit }) => {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl border border-gray-200">
        <div className="border-b px-4 py-3 font-semibold">Forward Plan</div>
        <div className="p-4 space-y-2">
          <div className="text-sm text-slate-700">
            Add an optional note before forwarding the course offerings plan for review/approval.
          </div>
          <textarea
            className="w-full rounded border px-3 py-2 text-sm min-h-[120px]"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note to reviewers…"
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button className="rounded-md border px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            disabled={busy}
            className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(note);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Send className="inline-block h-4 w-4 mr-1 align-[-2px]" />
            Forward
          </button>
        </div>
      </div>
    </div>
  );
};

const PlanReviewModal: React.FC<{
  changes: PlanningChange[];
  onClose: () => void;
  onApprove: () => void | Promise<void>;
}> = ({ changes, onClose, onApprove }) => {
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-3xl rounded-xl bg-white shadow-xl border border-gray-200">
        <div className="border-b px-4 py-3 font-semibold">Review Planning Updates</div>
        <div className="p-4 max-h-[70vh] overflow-auto">
          {changes.length === 0 ? (
            <div className="text-sm text-slate-700">No pending changes.</div>
          ) : (
            <ul className="space-y-3">
              {changes.map((ch, i) => (
                <li key={i} className="rounded border p-3">
                  <div className="text-sm font-semibold">{ch.type}</div>
                  <pre className="text-xs bg-slate-50 border rounded p-2 mt-2 overflow-auto">
{JSON.stringify(ch, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button className="rounded-md border px-3 py-1.5 text-sm" onClick={onClose}>
            Close
          </button>
          <button
            disabled={busy || changes.length === 0}
            className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            onClick={async () => {
              setBusy(true);
              try {
                await onApprove();
              } finally {
                setBusy(false);
              }
            }}
          >
            <Check className="inline-block h-4 w-4 mr-1 align-[-2px]" />
            Approve
          </button>
        </div>
      </div>
    </div>
  );
};
