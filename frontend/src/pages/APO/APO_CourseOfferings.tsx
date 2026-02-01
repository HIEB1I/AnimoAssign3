import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
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
  Upload,
  Copy,
  Undo2,
  Redo2,
} from "lucide-react";
import TopBar from "../../component/TopBar";
import Tabs from "../../component/Tabs";
import SelectBox from "../../component/SelectBox";
import {
  getApoCourseOfferings,
  addApoOfferingRow,
  editApoOfferingRow,
  deleteApoOfferingRow,
  restoreApoOfferingRow,
  forwardApoCourseOfferings,
  approveApoOfferingsPlan,
  curriculumAddCourse,
  curriculumEditCourse,
  curriculumRemoveCourse,
  getElectiveOptions,
  searchCourseCatalog,      
  createCatalogCourse, 
  getEligibleRoomsForOffering,          
  importCurriculumCsv,    
  editCatalogCourse,  
  getSpecialClassData,
  updateApoSpecialClassRow,
  type ApiConflict,
  type CreateCoursePayload,  
  type CourseCatalogItem           
} from "../../api";

/* --------------------------------- helpers --------------------------------- */
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
type Day = (typeof DAYS)[number];

// === ADDED: Abbreviation mapping & coercers ===
const DAY_ABBR = ["M","T","W","H","F","S"] as const;
type DayAbbr = (typeof DAY_ABBR)[number];

const DAY_FULL_TO_ABBR: Record<Day, DayAbbr> = {
  Monday: "M",
  Tuesday: "T",
  Wednesday: "W",
  Thursday: "H",
  Friday: "F",
  Saturday: "S",
};


// Accepts wide variety: "M", "Mon", "MONDAY", "Th", "Thu", "THU", ...
const DAY_ALIASES: Record<string, Day> = {
  M: "Monday", MON: "Monday", MONDAY: "Monday",
  T: "Tuesday", TU: "Tuesday", TUE: "Tuesday", TUES: "Tuesday", TUESDAY: "Tuesday",
  W: "Wednesday", WED: "Wednesday", WEDNESDAY: "Wednesday",
  H: "Thursday", THU: "Thursday", THUR: "Thursday", THURS: "Thursday", THURSDAY: "Thursday",
  F: "Friday", FRI: "Friday", FRIDAY: "Friday",
  S: "Saturday", SA: "Saturday", SAT: "Saturday", SATURDAY: "Saturday",
};

function toFullDay(d?: string | null): Day | "" {
  const s = String(d || "").trim();
  if (!s) return "";
  const key = s.replace(/\./g, "").replace(/\s+/g, "").toUpperCase(); // strip dots/spaces
  if (DAY_ALIASES[key]) return DAY_ALIASES[key];
  // fallback: title-case check
  const norm = s[0]?.toUpperCase() + s.slice(1).toLowerCase();
  return (DAYS.includes(norm as Day) ? (norm as Day) : "") as Day | "";
}

// Abbreviation we POST back: "M/T/W/TH/F/S"
function toAbbrevDay(d?: string | null): DayAbbr | "" {
  const s = String(d || "").trim();
  if (!s) return "";
  const key = s.replace(/\./g, "").replace(/\s+/g, "").toUpperCase();

  if (["M", "MON", "MONDAY"].includes(key)) return "M";
  if (["T", "TU", "TUE", "TUES", "TUESDAY"].includes(key)) return "T";
  if (["W", "WED", "WEDNESDAY"].includes(key)) return "W";
  if (["H", "TH", "THU", "THUR", "THURS", "THURSDAY"].includes(key)) return "H";
  if (["F", "FRI", "FRIDAY"].includes(key)) return "F";
  if (["S", "SA", "SAT", "SATURDAY"].includes(key)) return "S";
  if ((DAYS as readonly string[]).includes(s)) return DAY_FULL_TO_ABBR[s as Day];
  return "";
}

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

// Allow user to type anything; coerce to exactly HHMM on save
const toHHMM = (s?: string | number | null) => {
  const raw = String(s ?? "").trim();
  const t = raw.replace(/\D/g, "").slice(0, 4);

  if (t.length === 4) return t;          // H1H2M1M2
  if (t.length === 3) return `0${t}`;    // HMM -> 0HMM
  if (t.length === 2) return `${t}00`;   // HH  -> HH00
  if (t.length === 1) return `0${t}00`;  // H   -> 0H00
  return "";
};

// Display: always normalize to HHMM then show "HH:MM"
const fmtTime = (s?: string | number | null) => {
  const hhmm = toHHMM(s);
  if (!hhmm) return "—";
  return `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
};

const GE_TIME_SLOTS = [
  { label: "07:30 - 09:00", start: "0730", end: "0900" },
  { label: "08:00 - 10:00", start: "0800", end: "1000" },

  { label: "09:00 - 12:00", start: "0900", end: "1200" },
  { label: "09:15 - 10:45", start: "0915", end: "1045" },
  { label: "09:15 - 12:30", start: "0915", end: "1230" },

  { label: "10:00 - 12:00", start: "1000", end: "1200" },
  { label: "10:00 - 13:00", start: "1000", end: "1300" },

  { label: "11:00 - 12:30", start: "1100", end: "1230" },
  { label: "11:00 - 13:00", start: "1100", end: "1300" },

  { label: "12:45 - 14:15", start: "1245", end: "1415" },

  { label: "13:00 - 15:00", start: "1300", end: "1500" },
  { label: "13:00 - 16:00", start: "1300", end: "1600" },
  { label: "13:15 - 14:15", start: "1315", end: "1415" },

  { label: "14:00 - 16:00", start: "1400", end: "1600" },
  { label: "14:30 - 16:00", start: "1430", end: "1600" },
  { label: "14:40 - 16:00", start: "1440", end: "1600" },

  { label: "15:30 - 17:30", start: "1530", end: "1730" },

  { label: "16:15 - 17:45", start: "1615", end: "1745" },

  { label: "18:00 - 19:30", start: "1800", end: "1930" },
  { label: "18:00 - 20:00", start: "1800", end: "2000" },
  { label: "18:00 - 21:00", start: "1800", end: "2100" },

  { label: "19:45 - 21:00", start: "1945", end: "2100" },
  { label: "19:45 - 21:15", start: "1945", end: "2115" },
];

const GE_PLACEHOLDER = "— Select —";

const geFindByLabel = (label: string) => GE_TIME_SLOTS.find(t => t.label === label);
const geFindByTimes = (start?: string | null, end?: string | null) => {
  const s = (start || "").replace(/\D/g, "");
  const e = (end || "").replace(/\D/g, "");
  return GE_TIME_SLOTS.find(t => t.start === s && t.end === e);
};
const geCurrentLabel = (slot?: { start_time?: string | null; end_time?: string | null }) => {
  const hit = geFindByTimes(slot?.start_time, slot?.end_time);
  return hit ? hit.label : GE_PLACEHOLDER;
};
// Format a slot as "HH:MM - HH:MM" for display when it's not one of the standard GE_TIME_SLOTS
const geCustomLabel = (slot?: { start_time?: string | null; end_time?: string | null }) => {
  const st = slot?.start_time ? fmtTime(slot.start_time) : "";
  const en = slot?.end_time ? fmtTime(slot.end_time) : "";
  if (!st && !en) return "";
  if (st && en) return `${st} - ${en}`;
  return st || en || "";
};

// Parse free-text into start/end HHMM (accepts "07:30 - 09:00", "0730-0900", "07300900", etc.)
const parseTimeRangeFromText = (
  text: string
): { start_time: string; end_time: string } | undefined => {
  const raw = (text || "").trim();
  if (!raw) return undefined;

  // Case 1: split by dash
  const parts = raw.split(/[-–—]/);
  if (parts.length >= 2) {
    const s = toHHMM(parts[0]);
    const e = toHHMM(parts[1]);
    if (s.length === 4 && e.length === 4) return { start_time: s, end_time: e };
  }

  // Case 2: just digits → 8-digit "HHMMHHMM"
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 8) {
    const s = digits.slice(0, 4);
    const e = digits.slice(4, 8);
    return { start_time: s, end_time: e };
  }

  // Otherwise, leave it unchanged (we won't override slot times)
  return undefined;
};

type TimeBandInputProps = {
  slot?: { start_time?: string | null; end_time?: string | null };
  onChange: (update: { start_time?: string; end_time?: string }) => void;
  className?: string;
  placeholder?: string;
};

/**
 * Searchable + free-text time band input:
 * - shows a text field
 * - filters GE_TIME_SLOTS as you type
 * - can also accept custom ranges not in GE_TIME_SLOTS
 */
const TimeBandInput: React.FC<TimeBandInputProps> = ({
  slot,
  onChange,
  className,
  placeholder = "e.g. 07:30 - 09:00",
}) => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string>("");

  // Sync when slot changes from the outside (e.g., opening a different row)
  useEffect(() => {
    const label = geCurrentLabel(slot);
    if (label !== GE_PLACEHOLDER) {
      setText(label);
    } else {
      setText(geCustomLabel(slot));
    }
  }, [slot?.start_time, slot?.end_time]);

  const filtered = useMemo(() => {
    const q = text.toLowerCase();
    return GE_TIME_SLOTS.filter((t) => t.label.toLowerCase().includes(q));
  }, [text]);

  const pick = (label: string) => {
    const hit = geFindByLabel(label);
    if (!hit) return;
    setText(label);
    onChange({ start_time: hit.start, end_time: hit.end });
    setOpen(false);
  };

  const handleBlur = () => {
    // allow click on dropdown items
    setTimeout(() => setOpen(false), 120);

    const parsed = parseTimeRangeFromText(text);
    if (parsed) {
      onChange(parsed);
    }
  };

  return (
    <div className={cls("relative inline-block min-w-[140px] whitespace-nowrap", className)}>
      <input
        className={cls(
          "w-full rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm shadow-sm",
          "focus:outline-none focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300"
        )}
        value={text}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          if (!text) {
            const label = geCurrentLabel(slot);
            if (label !== GE_PLACEHOLDER) setText(label);
          }
        }}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onBlur={handleBlur}
      />

      {open && filtered.length > 0 && (
        <div className="absolute left-0 right-0 z-20 mt-1 max-h-48 overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {filtered.map((t) => (
            <button
              key={t.label}
              type="button"
              onMouseDown={(e) => e.preventDefault()} // prevent input blur
              onClick={() => pick(t.label)}
              className="block w-full px-2 py-1 text-left text-sm hover:bg-emerald-50"
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// A slot can only receive a room if it has day + full HHMM times
const slotReady = (s?: { day?: Day | ""; start_time?: string; end_time?: string }) => {
  if (!s) return false;
  const dayOk = !!toFullDay(s.day || "");
  const st = toHHMM(s.start_time);
  const en = toHHMM(s.end_time);
  return dayOk && st.length === 4 && en.length === 4;
};

// strict (non-GE) slot: require day + full start + full end, optional room
const compactSlotStrict = (
  s?: { day?: Day | ""; start_time?: string; end_time?: string; room_id?: string }
) => {
  if (!s) return undefined;
  const dayFull = toFullDay(s.day || "");
  const start = toHHMM(s.start_time);
  const end = toHHMM(s.end_time);
  if (!(dayFull && start.length === 4 && end.length === 4)) return undefined;
  const out: any = { day: dayFull, start_time: start, end_time: end };
  if (s.room_id !== undefined) out.room_id = s.room_id ? s.room_id : null; // allow clear
  return out;
};

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
  submission?: {
    has_prior_submit?: boolean;
    submit_count?: number;
    first_submitted_at?: any;
    last_submitted_at?: any;
    last_submitted_by?: string;
  };
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

type SpecialClassSlot = {
  schedule_id?: string | null;
  day?: string | null;          // M/T/W/H/F/S
  start_time?: string | null;   // "0730"
  end_time?: string | null;     // "0900"
  room_id?: string | null;      // real room_id or "ONLINE"
  room_type?: string | null;    // e.g. "LECTURE", "LAB", "ONLINE"
  room_number?: string | null;  // resolved display label from backend
};

type SpecialClassRow = {
  special_id: string;
  campus_name?: string;
  term_id?: string;
  term_label?: string;
  student?: { student_number?: string; student_name?: string };
  course?: { course_code?: string; course_title?: string };
  section?: { section_id?: string; section_code?: string; section_remarks?: string };
  faculty?: { faculty_name?: string };
  schedule_entries?: SpecialClassSlot[];
  schedule_text?: string;
  slot1?: SpecialClassSlot | null;
  slot2?: SpecialClassSlot | null;
  remarks?: string | null;
  [k: string]: any; // Additional fields
};

type SpecialClassResponse = {
  campus?: { campus_id?: string; campus_name?: string };
  term_id?: string;
  term_label?: string;
  rows: SpecialClassRow[];
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

type ViewMode = "offerings" | "curriculum" | "specialclass";

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
  const [scData, setScData] = useState<SpecialClassResponse | null>(null);
  const [scRows, setScRows] = useState<SpecialClassRow[]>([]);
  const [scLoading, setScLoading] = useState(false);
  const [scErr, setScErr] = useState<string | null>(null);

  /** ------------------ Editing state ------------------ */
  const [scEditingId, setScEditingId] = useState<string | null>(null);
  const [scEditRemarks, setScEditRemarks] = useState<string>("");

  /** room edits (we store room_id because backend update wants room_id) */
  const [scEditRoom1, setScEditRoom1] = useState<string>(""); // room_id or "ONLINE"
  const [scEditRoom2, setScEditRoom2] = useState<string>("");

  /** eligible rooms cache per slot key `${special_id}:1` or `${special_id}:2` */
  const [scEligibleRooms, setScEligibleRooms] = useState<Record<string, any[]>>({});
  const [scEligibleRoomsLoading, setScEligibleRoomsLoading] = useState<Record<string, boolean>>({});
  const [scSaveLoadingId, setScSaveLoadingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [globalElectives, setGlobalElectives] = useState<CourseOption[]>([]);
  const [electiveOptionsCache, setElectiveOptionsCache] = useState<Record<string, CourseOption[]>>({});
// ---------- RoomSelectBox (SelectBox-powered) ----------
const RoomSelectBox: React.FC<{
  rooms: RoomOption[];
  value: string | null | undefined;   // room_id
  disabled?: boolean;
  className?: string;
  onChange: (roomId: string | null) => void;
}> = ({ rooms, value, disabled, className, onChange }) => {
  // prefer TBA if present and nothing is selected
  const tbaId =
    rooms.find(r => String(r.room_number || "").replace(/[-–—]/g, "").trim().toUpperCase() === "TBA")
      ?.room_id ?? null;

  const opts = React.useMemo(
    () => rooms.map(r => ({ id: r.room_id, label: r.room_number || r.room_id })),
    [rooms]
  );

  const currentLabel = React.useMemo(() => {
    const currentId = (value ?? tbaId ?? "") as string;
    const hit = opts.find(o => o.id === currentId);
    return hit ? hit.label : "TBA";
  }, [opts, value, tbaId]);

  return (
    <div className={cls("relative z-50 w-full min-w-0 max-w-full overflow-visible", className)}>
      <SelectBox
        value={currentLabel}
        onChange={(label: string) => {
          const match = opts.find(o => o.label === label);
          onChange(match?.id ?? tbaId ?? null);
        }}
        options={opts.map(o => o.label)}
        disabled={!!disabled}
        className="!min-w-0 w-full max-w-full"
      />
    </div>
  );
};

// ------ EligibleRoomSelect: fetch rooms that are truly available for the slot ------
const EligibleRoomSelect: React.FC<{
  userId: string;
  campusId: string;
  spec: {
    day?: string | null;
    start?: string | null;
    end?: string | null;
    roomType?: string | null;
    capacity?: number | null;
    excludeScheduleIds?: string[];
    // Optional context (especially useful for Special Class rows)
    sectionId?: string | null;
    scheduleId?: string | null;
  };
  fallbackRooms: RoomOption[];  // e.g., data.room_options (used when slot not ready)
  value: string | null | undefined;
  disabled?: boolean;
  className?: string;
  onChange: (roomId: string | null) => void;
}> = ({ userId, campusId, spec, fallbackRooms, value, disabled, className, onChange }) => {
  const [opts, setOpts] = useState<RoomOption[]>([]);

  const ready =
    !!toAbbrevDay(spec.day || "") &&
    toHHMM(spec.start || "").length === 4 &&
    toHHMM(spec.end || "").length === 4;

  useEffect(() => {
    let cancelled = false;

    const pickTba = (): RoomOption => {
      const hit =
        fallbackRooms.find(
          (r) =>
            String(r.room_number || "")
              .replace(/[-–—]/g, "")
              .trim()
              .toUpperCase() === "TBA"
        ) ?? null;

      return (
        hit ??
        ({
          room_id: "",
          room_number: "TBA",
          capacity: null,
          room_type: null,
        } as any)
      );
    };

    (async () => {
      const tbaOpt = pickTba();

      if (!ready || disabled) {
        const base = filterRoomsByCap(fallbackRooms, spec.capacity).filter(
          (r) => String(r.room_id || "").toUpperCase() !== "ONLINE"
        );
        if (!cancelled) setOpts(base.length ? base : [tbaOpt]);
        return;
      }

      try {
        // IMPORTANT: match backend query keys (handled by api.ts mapping too)
        const payload = {
          // When present, these allow the backend to infer enrollment_cap/room_type even if
          // Special Class rows lack those fields locally.
          section_id: spec.sectionId || undefined,
          schedule_id: spec.scheduleId || undefined,
          day: toAbbrevDay(spec.day || ""),
          start: toHHMM(spec.start || ""),
          end: toHHMM(spec.end || ""),
          room_type: spec.roomType || undefined,
          capacity: spec.capacity ?? undefined,
          exclude: spec.excludeScheduleIds || [],
        } as any;

        const res: any = await getEligibleRoomsForOffering(userId, payload);
        const list: RoomOption[] = Array.isArray(res?.rooms) ? res.rooms : res ?? [];

        const filtered = filterRoomsByCap(list, spec.capacity)
          .filter((r) => {
            if (!spec.roomType) return true;
            const a = String(r.room_type || "").toLowerCase();
            const b = String(spec.roomType || "").toLowerCase();
            return a === b;
          })
          .filter((r) => String(r.room_id || "").toUpperCase() !== "ONLINE");

        const merged: RoomOption[] = [
          tbaOpt,
          ...filtered.filter((r) => String(r.room_id || "") !== String(tbaOpt.room_id || "")),
        ];

        if (!cancelled) setOpts(merged);
      } catch {
        if (!cancelled) setOpts([tbaOpt]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    userId,
    campusId,
    spec.day,
    spec.start,
    spec.end,
    spec.roomType,
    spec.capacity,
    spec.excludeScheduleIds,
    disabled,
    fallbackRooms,
  ]);

  return (
    <RoomSelectBox
      rooms={opts}
      value={value}
      disabled={disabled || !ready}
      className={className}
      onChange={onChange}
    />
  );
};

  // curriculum state
  const [curr, setCurr] = useState<CurriculumResponse | null>(null);
  const [currSearch, setCurrSearch] = useState("");

  // per-program add selection (code-only select still stores course_id)
  const [currAddSel, setCurrAddSel] = useState<Record<string, string>>({});
  const [editorState, setEditorState] = useState<{
    open: boolean;
    program_id?: string;
    program_code?: string;
    batch_id?: string;
  } | null>(null);
  const [showCreateCourseModal, setShowCreateCourseModal] = useState(false);
  const [showEditCourseModal, setShowEditCourseModal] = useState(false); // ← NEW
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importBusy, setImportBusy] = useState(false);
const [showCurrImportModal, setShowCurrImportModal] = useState(false);
const [currImportErr, setCurrImportErr] = useState<string | null>(null);

  const downloadCurriculumCsvTemplate = () => {
    // CSV template for List of Courses (curriculum/flowchart import)
    const headers = [
      "Batch",
      "Program Level",
      "Program",
      "Term Number",
      "Academic Year",
      "Campus",
      "Course 1",
      "Course 2",
      "Course 3",
      "Course 4",
      "Course 5",
    ];
    const sample = [
      "ID 126",
      "Undergraduate",
      "BSCS-ST",
      "1",
      String(new Date().getFullYear() + 1),
      (curr?.campus?.campus_name ?? data?.campus?.campus_name ?? "Manila"),
      "CCDSALG",
      "CCPROG2",
      "",
      "",
      "",
    ];
    const csv = headers.join(",") + "\n" + sample.join(",") + "\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "apo_list_of_courses_template.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
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
  const apoCampus = String(user?.campus_name || user?.campus || user?.campusName || "").toUpperCase();

  const scRowsForCampus = useMemo(() => {
    const myCampus =
      apoCampus ||
      String(scData?.campus?.campus_name || "").toUpperCase() ||
      String(data?.campus?.campus_name || "").toUpperCase();

    if (!myCampus) return scRows;

    return scRows.filter((r) => {
      const rowCampus = String(r.campus_name || scData?.campus?.campus_name || "").toUpperCase();
      return !rowCampus || rowCampus === myCampus;
    });
  }, [scRows, apoCampus, scData?.campus?.campus_name, data?.campus?.campus_name]);


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

    // IMPORTANT: "All ID" dropdown is by batch_code label, but backend filters by batch_id.
    // Multiple batch_id can share the same batch_code. Send them ALL as CSV.
    let bId: string | undefined = undefined;
    if (batchCode !== "All ID") {
      const want = normCode(batchCode);
      const hits = (data?.filters.ids || [])
        .filter((b) => normCode(b.batch_code) === want)
        .map((b) => b.batch_id)
        .filter(Boolean);

      if (hits.length === 1) bId = hits[0];
      else if (hits.length > 1) bId = hits.join(",");
    }

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

  const [currentTermId, setCurrentTermId] = useState<string | null>(() =>
    localStorage.getItem("currentTermId")
  );

  const loadCurrentTerm = async () => {
    try {
      const response = await fetch("/api/terms?is_current=true");
      const data = await response.json();

      if (data?.term_id) {
        localStorage.setItem("currentTermId", data.term_id);
        setCurrentTermId(data.term_id);
      } else {
        console.error("No current term found.");
      }
    } catch (error) {
      console.error("Error fetching the current term:", error);
    }
  };

  useEffect(() => {
    loadCurrentTerm();
  }, []);


  const loadSpecialClass = async (termId?: string) => {
    setScLoading(true);
    setScErr(null);

    try {
      const userId = user?.userId;
      if (!userId) {
        setScErr("User is not logged in");
        return;
      }

      const data = await getSpecialClassData(userId, {
        term_id: termId,
        term_mode: "active",
      });

      setScData(data);
      setScRows(data.rows || []);
    } catch (e: any) {
      setScErr(
        e?.message ? `Failed to load special class data: ${e.message}` : "Failed to load special class data"
      );
    } finally {
      setScLoading(false);
    }
  };

  /** ------------------ helpers for edit mode ------------------ */
  const _slotFromRow = (row: any, idx: 1 | 2) => {
    const se = Array.isArray(row?.schedule_entries) ? row.schedule_entries : [];
    if (idx === 1) return row?.slot1 ?? se[0] ?? null;
    return row?.slot2 ?? se[1] ?? null;
  };

  const _roomIdFromSlot = (slot: any): string => {
    const rid = String(slot?.room_id ?? "").trim();
    if (rid && rid.toUpperCase() !== "ONLINE") return rid;

    const rn = String(slot?.room_number ?? "").trim().toUpperCase();
    if (rn === "ONLINE") return ""; // treat ONLINE as TBA

    return "";
  };

  const _scheduleIdsFromRow = (row: any): string[] => {
    const se = Array.isArray(row?.schedule_entries) ? row.schedule_entries : [];
    return se
      .map((x: any) => String(x?.schedule_id ?? "").trim())
      .filter(Boolean);
  };

  const _minCapacityFromRow = (row: any): number | undefined => {
    // best-effort: only pass if it exists in data model
    const v =
      row?.min_capacity ??
      row?.required_capacity ??
      row?.capacity ??
      row?.section?.min_capacity ??
      row?.section?.capacity;

    const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  /** Load eligible rooms for a specific row+slot using the SAME room-filter endpoint used in offerings */
  const ensureEligibleRoomsForSlot = async (row: SpecialClassRow, idx: 1 | 2) => {
    const key = `${row.special_id}:${idx}`;
    if (scEligibleRooms[key]) return;

    const userId = user?.userId;
    if (!userId) return;

    const slot = _slotFromRow(row as any, idx);
    const section_id = String((row as any)?.section_id ?? "").trim();
    const schedule_id = String((slot as any)?.schedule_id ?? "").trim();
    const day = String(slot?.day ?? "").trim();
    const start = String(slot?.start_time ?? "").trim();
    const end = String(slot?.end_time ?? "").trim();
    if (!day || !start || !end) return;

    const room_type = String(slot?.room_type ?? "").trim() || undefined;
    const capacity = _minCapacityFromRow(row);
    const exclude = _scheduleIdsFromRow(row);

    setScEligibleRoomsLoading((p) => ({ ...p, [key]: true }));
    try {
      const rooms = await getEligibleRoomsForOffering(userId, {
        section_id: section_id || undefined,
        schedule_id: schedule_id || undefined,
        day,
        start_time: start,
        end_time: end,
        room_type,
        capacity,
        exclude,
      });

      // rooms shape can vary; we keep it generic and label it in UI
      // rooms shape can vary; we keep it generic and label it in UI
      setScEligibleRooms((p) => ({ ...p, [key]: Array.isArray(rooms) ? rooms : [] }));
    } catch (e) {
      // don’t block editing; just keep rooms empty and rely on current room display
      setScEligibleRooms((p) => ({ ...p, [key]: [] }));
    } finally {
      setScEligibleRoomsLoading((p) => ({ ...p, [key]: false }));
    }
  };

  const beginEditSpecialClassRow = async (row: SpecialClassRow) => {
    setScEditingId(row.special_id);

    // remarks edit (special class remarks)
    setScEditRemarks(String(row.remarks ?? ""));

    // room edits (we store room_id)
    const s1 = _slotFromRow(row as any, 1);
    const s2 = _slotFromRow(row as any, 2);
    setScEditRoom1(_roomIdFromSlot(s1));
    setScEditRoom2(_roomIdFromSlot(s2));

    // preload eligible rooms for dropdowns (same logic as offerings)
    await Promise.all([ensureEligibleRoomsForSlot(row, 1), ensureEligibleRoomsForSlot(row, 2)]);
  };

  const cancelEditSpecialClassRow = () => {
    setScEditingId(null);
    setScEditRemarks("");
    setScEditRoom1("");
    setScEditRoom2("");
    setScSaveLoadingId(null);
  };

  const saveSpecialClassRowEdits = async (row: SpecialClassRow) => {
    const userId = user?.userId;
    if (!userId) {
      setScErr("User is not logged in");
      return;
    }

    setScSaveLoadingId(row.special_id);
    setScErr(null);

    try {
      // build schedule_entries payload (keep day/start/end; update room_id only)
      // IMPORTANT: some Special Class rows may not have schedule_entries populated,
      // but do have slot1/slot2. Use those as fallback so room changes persist and
      // immediately reflect in the table.
      const seBase =
        Array.isArray(row.schedule_entries) && row.schedule_entries.length > 0
          ? row.schedule_entries
          : [row.slot1, row.slot2].filter(Boolean);
      const next = [...(seBase as any[])].map((x) => ({ ...x }));

      if (next[0]) next[0].room_id = scEditRoom1 || null;
      if (next[1]) next[1].room_id = scEditRoom2 || null;

      await updateApoSpecialClassRow(userId, {
        special_id: row.special_id,
        term_id: row.term_id ?? scData?.term_id, // important for correct record
        remarks: scEditRemarks,
        schedule_entries: next.map((x) => ({
          schedule_id: x?.schedule_id ?? null,
          room_id: x?.room_id ?? null,
        })),
      });

      // Update UI after successful save
      setScRows((prev) =>
        prev.map((r) =>
          r.special_id !== row.special_id
            ? r
            : {
                ...r,
                remarks: scEditRemarks,
                schedule_entries: next,
                slot1: next[0] ?? r.slot1 ?? null,
                slot2: next[1] ?? r.slot2 ?? null,
              }
        )
      );

      cancelEditSpecialClassRow();
    } catch (e: any) {
      setScErr(
        e?.message
          ? `Failed to save special class edits: ${e.message}`
          : "Failed to save special class edits"
      );
      // keep edit mode open so user doesn’t lose input
    } finally {
      setScSaveLoadingId(null);
    }
  };

  // View switching: specialclass + curriculum only
  useEffect(() => {
    if (view === "specialclass") {
      const tid = currentTermId || data?.term_id || curr?.term_id || undefined;
      loadSpecialClass(tid);
      return;
    }

    if (view === "curriculum") loadCurriculum();
  }, [view, currentTermId, data?.term_id, curr?.term_id]);

  // Offerings: reload whenever dropdown filters change
  useEffect(() => {
    if (view !== "offerings") return;
  if (blockedByImport) {
    alert("You must import pre-enlistment data before making changes.");
    return;
  }
  if (blockedByImport) {
    alert("You must import pre-enlistment data before making changes.");
    return;
  }
    if (!user?.userId) return;

    // small debounce so rapid changes don't spam requests
    const t = setTimeout(() => {
      loadOfferings();
    }, 150);

    return () => clearTimeout(t);
  }, [view, user?.userId, level, departmentName, batchCode, programCode]);



  /* -------------------------- planning banner only -------------------------- */

  const blockedByImport = view === "offerings" && !!data?.planning?.needs_import;
  // Avoid showing the approval UI when there are no actionable updates.
  const hasPlanUpdates = view === "offerings" && !!data?.planning?.pending_changes?.length;
  // Show banner, but do NOT block editing
  const showApprovalBanner = view === "offerings" && !blockedByImport && hasPlanUpdates && !!data?.planning?.approval_required;

  const [showForward, setShowForward] = useState(false);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const didAutoOpenPlan = useRef(false);
  // If backend requires a comment but UI didn't know yet, force showing the comment prompt
  const [forceRequireNote, setForceRequireNote] = useState(false);
  const [submitAck, setSubmitAck] = useState<{ open: boolean; title: string; details: string }>({ open: false, title: '', details: '' });
  const hasPriorSubmit = useMemo(() => {
    const s: any = (data as any)?.submission;
    if (s && typeof s.has_prior_submit === "boolean") return !!s.has_prior_submit;
    return (data?.rows || []).some((r: any) => !!r.submitted_for_scheduling);
  }, [data]);

  // Make the approval step hard to miss: auto-open the planning review once per update cycle.
  // (But never show it when there are no pending changes.)
  useEffect(() => {
    if (view !== "offerings") return;
    if (!showApprovalBanner) return;
    if (showPlanModal) return;
    if (didAutoOpenPlan.current) return;
    didAutoOpenPlan.current = true;
    setShowPlanModal(true);
  }, [view, showApprovalBanner, showPlanModal]);

  // If updates disappear (approved or none), allow auto-open again when a new set appears later.
  useEffect(() => {
    if (!hasPlanUpdates) didAutoOpenPlan.current = false;
  }, [hasPlanUpdates, data?.term_id]);

  // If updates are no longer available (e.g., approved), ensure the modal is closed.
  useEffect(() => {
    if (showPlanModal && !hasPlanUpdates) setShowPlanModal(false);
  }, [showPlanModal, hasPlanUpdates]);
// Build a lookup so the modal can show "CODE — Title" instead of course_id
const planCourseIndex = useMemo(() => {
  type Meta = { code: string; title: string };
  const m: Record<string, Meta> = {};

  const put = (id?: string, code?: string | string[], title?: string) => {
    const c = Array.isArray(code) ? String(code[0] ?? "") : String(code ?? "");
    const t = String(title ?? "");
    const idKey = String(id ?? "").trim();
    const codeKey = c.trim().toUpperCase();

    // store by true course_id
    if (idKey && !m[idKey]) m[idKey] = { code: c, title: t };

    // also index by course_code so "CRS0245" lookups succeed
    if (codeKey && !m[codeKey]) m[codeKey] = { code: c, title: t };
  };

  // learn from rows
  (data?.rows || []).forEach((r: OfferingRow) =>
    put(r.course.course_id, r.course.course_code, r.course.course_title)
  );

  // learn from options
  const groups = (data?.course_options_by_group ?? {}) as Record<string, CourseOption[]>;
  Object.values(groups).forEach((arr) => {
    (arr || []).forEach((o) => put(o?.course_id, o?.course_code as any, o?.course_title));
  });

  return m;
}, [data?.rows, data?.course_options_by_group]);
// extra index entries we resolve on demand
const [extraCourseIndex, setExtraCourseIndex] = useState<Record<string, { code: string; title: string }>>({});

// when the Planning modal opens, make sure every change.course_id is resolvable
useEffect(() => {
  if (!showPlanModal || !user?.userId || !data?.planning?.pending_changes?.length) return;

  const have = (k: string) => !!(planCourseIndex[k] || planCourseIndex[k.toUpperCase()] || extraCourseIndex[k] || extraCourseIndex[k.toUpperCase()]);
  const missing = Array.from(
    new Set(
      (data.planning.pending_changes || [])
        .map((ch: any) => String(ch.course_id || "").trim())
        .filter((id) => id && !have(id))
    )
  );

  if (!missing.length) return;

  (async () => {
    const adds: Record<string, { code: string; title: string }> = {};
    for (const id of missing) {
      try {
        // try a direct catalog search by course_id (works in our catalog endpoint)
        const r = await searchCourseCatalog(user.userId, { q: id, limit: 1 });
        const hit = (r?.results || [])[0];
        if (hit) {
          const code = Array.isArray(hit.course_code) ? String(hit.course_code[0] ?? "") : String(hit.course_code ?? "");
          const title = String(hit.course_title ?? "");
          if (title || code) adds[id] = { code, title };
        }
      } catch {
        /* ignore; we just leave it as the id */
      }
    }
    if (Object.keys(adds).length) setExtraCourseIndex((prev) => ({ ...prev, ...adds }));
  })();
}, [showPlanModal, data?.planning?.pending_changes, planCourseIndex, extraCourseIndex, user?.userId]);

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

  /* ------------------------- Keyboard shortcut refs ------------------------- */
  // Keep keydown listener stable (mounted once) while always calling the latest
  // undo/redo handlers and reading the latest modal/edit state.
  const editingRef = useRef<{ row: OfferingRow; draft: EditDraft } | null>(null);
  const conflictRef = useRef<ConflictState | null>(null);
  const shortcutFnsRef = useRef<{
    undoEditDraft: () => void;
    redoEditDraft: () => void;
    undoServerChange: () => Promise<void>;
    redoServerChange: () => Promise<void>;
  }>({
    undoEditDraft: () => {},
    redoEditDraft: () => {},
    undoServerChange: async () => {},
    redoServerChange: async () => {},
  });

/* ------------------------- Undo / Redo (Edit Draft) ------------------------- */
// History applies to the current editing.draft only (safe: does not touch saved server data)
const [editUndo, setEditUndo] = useState<EditDraft[]>([]);
const [editRedo, setEditRedo] = useState<EditDraft[]>([]);
const editHistoryLock = useRef(false);
const lastDraftSigRef = useRef<string>("");

const undoEditDraft = () => {
  if (!editing) return;

  setEditUndo((u) => {
    if (!u.length) return u;

    const prev = u[u.length - 1];
    const cur = editing.draft;

    editHistoryLock.current = true;
    setEditRedo((r) => [...r, cur]);
    setEditing((p) => (p ? { ...p, draft: prev } : p));

    return u.slice(0, -1);
  });
};

const redoEditDraft = () => {
  if (!editing) return;

  setEditRedo((r) => {
    if (!r.length) return r;

    const next = r[r.length - 1];
    const cur = editing.draft;

    editHistoryLock.current = true;
    setEditUndo((u) => [...u, cur]);
    setEditing((p) => (p ? { ...p, draft: next } : p));

    return r.slice(0, -1);
  });
};

// Track every edit-draft change and push snapshots into undo stack
useEffect(() => {
  if (!editing) {
    setEditUndo([]);
    setEditRedo([]);
    lastDraftSigRef.current = "";
    return;
  }

  const sig = JSON.stringify(editing.draft ?? {});

  // If this change came from undo/redo, don’t record a new history entry
  if (editHistoryLock.current) {
    editHistoryLock.current = false;
    lastDraftSigRef.current = sig;
    return;
  }

  // First time entering edit mode (or switching rows)
  if (!lastDraftSigRef.current) {
    lastDraftSigRef.current = sig;
    return;
  }

  // No real change
  if (sig === lastDraftSigRef.current) return;

  // Push previous draft snapshot into undo, clear redo
  try {
    const prev = JSON.parse(lastDraftSigRef.current) as EditDraft;
    setEditUndo((u) => [...u, prev]);
    setEditRedo([]);
  } catch {
    // ignore malformed snapshot
  }

  lastDraftSigRef.current = sig;
}, [editing?.row?.section?.section_id, editing?.draft]);

/* -------------------- Undo / Redo (Server mutations) -------------------- */
// NOTE: This is for committed server changes (add/edit/delete/replace).
// It intentionally does NOT attempt to undo plan approvals or submissions.
type ServerOp = {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
};

const [srvUndo, setSrvUndo] = useState<ServerOp[]>([]);
const [srvRedo, setSrvRedo] = useState<ServerOp[]>([]);
const srvUndoRef = useRef<ServerOp[]>([]);
const srvRedoRef = useRef<ServerOp[]>([]);
const [srvBusy, setSrvBusy] = useState(false);

const syncSrvStacks = (u: ServerOp[], r: ServerOp[]) => {
  srvUndoRef.current = u;
  srvRedoRef.current = r;
  setSrvUndo(u);
  setSrvRedo(r);
};

const pushSrvOp = (op: ServerOp) => {
  // Any new server mutation invalidates the redo stack
  syncSrvStacks([...srvUndoRef.current, op], []);
};


const cloneJson = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const slotFromRow = (slot?: OfferingRow["slot1"]) => {
  if (!slot) return undefined;

  const day = toAbbrevDay(slot.day) || "";
  const st = toHHMM(slot.start_time);
  const en = toHHMM(slot.end_time);

  // keep explicit nulls (clear room)
  const roomId =
    (slot as any).room_id === null ? null : ((slot as any).room_id || "").toString().trim();

  const roomType = ((slot as any).room_type || "").toString().trim();

  if (!day && !st && !en && !roomId) return undefined;

  const out: any = {};
  if (day) out.day = day;
  if (st) out.start_time = st;
  if (en) out.end_time = en;

  if (roomId === null) out.room_id = null;
  else if (roomId) out.room_id = roomId;

  if (roomType) out.room_type = roomType;
  return out;
};

const rowToAddPayload = (r: OfferingRow) => {
  const courseType = r.course?.type_of_course || "";
  const isGE = isGEType(courseType);

  const rowIsPlaceholder = isElectivePlaceholderType(
    r.course.type_of_course || "",
    r.course.course_code,
    r.course.course_title
  );
  const rowIsSpecific = isSpecificElectiveType(r.course.type_of_course || "");

  const electiveParentId =
    r.links?.elective_placeholder_course_id ||
    (rowIsPlaceholder ? r.course.course_id : undefined);

  const payload: any = {
    batch_id: r.batch.batch_id,
    program_id: r.program.program_id,
    section_code: (r.section.section_code || "").toString(),
    enrollment_cap: r.section.enrollment_cap ?? "",
    remarks: r.section.remarks ?? "",
    campus_id: data?.campus?.campus_id || undefined,
    ...(isGE ? { auto_override: true } : {}),
  };

  if (rowIsSpecific && electiveParentId) {
    payload.for_placeholder_course_id = electiveParentId;
    payload.specific_course_id = r.course.course_id;
  } else {
    payload.course_id = r.course.course_id;
  }

  const s1 = slotFromRow(r.slot1);
  const s2 = slotFromRow(r.slot2);
  if (s1) payload.slot1 = s1;
  if (s2) payload.slot2 = s2;

  const fname = (r.faculty?.faculty_name || "").toString().trim();
  if (fname) payload.faculty_name = fname;

  // preserve ids if present (helpful for full-edit courses)
  if (r.faculty && "user_id" in r.faculty) payload.faculty_user_id = r.faculty.user_id ?? null;
  if (r.faculty && "faculty_id" in r.faculty) payload.faculty_id = r.faculty.faculty_id ?? null;

  return payload;
};

const rowToEditPayload = (r: OfferingRow) => {
  const courseType = r.course?.type_of_course || "";
  const isGE = isGEType(courseType);

  const rowIsPlaceholder = isElectivePlaceholderType(
    r.course.type_of_course || "",
    r.course.course_code,
    r.course.course_title
  );
  const rowIsSpecific = isSpecificElectiveType(r.course.type_of_course || "");

  const electiveParentId =
    r.links?.elective_placeholder_course_id ||
    (rowIsPlaceholder ? r.course.course_id : undefined);

  const payload: any = {
    section_id: r.section.section_id,
    course_id: r.course.course_id,
    section_code: (r.section.section_code || "").toString(),
    enrollment_cap: r.section.enrollment_cap ?? "",
    remarks: r.section.remarks ?? "",
    ...(isGE ? { auto_override: true } : {}),
  };

  if (rowIsSpecific && electiveParentId) {
    payload.for_placeholder_course_id = electiveParentId;
    payload.specific_course_id = r.course.course_id;
  } else if (rowIsPlaceholder) {
    payload.for_placeholder_course_id = r.course.course_id; // placeholder is its own parent
    payload.specific_course_id = undefined;
  }

  const s1 = slotFromRow(r.slot1);
  const s2 = slotFromRow(r.slot2);
  if (s1) payload.slot1 = s1;
  if (s2) payload.slot2 = s2;

  const fname = (r.faculty?.faculty_name || "").toString().trim();
  if (fname) payload.faculty_name = fname;

  if (r.faculty && "user_id" in r.faculty) payload.faculty_user_id = r.faculty.user_id ?? null;
  if (r.faculty && "faculty_id" in r.faculty) payload.faculty_id = r.faculty.faculty_id ?? null;

  return payload;
};

const runAddWithAutoOverride = async (payload: any, reason: string) => {
  if (!user?.userId) throw new Error("Not logged in.");
  const res = await addApoOfferingRow(user.userId, payload as any);
  if ("conflict" in res) {
    const res2 = await addApoOfferingRow(user.userId, {
      ...payload,
      override: true,
      override_token: res.conflict.override_token,
      override_reason: reason,
    } as any);
    if ("conflict" in res2) throw new Error("Action still has conflicts after override.");
    return res2;
  }
  return res;
};

const runEditWithAutoOverride = async (payload: any, reason: string) => {
  if (!user?.userId) throw new Error("Not logged in.");
  const res = await editApoOfferingRow(user.userId, payload as any);
  if ("conflict" in res) {
    const res2 = await editApoOfferingRow(user.userId, {
      ...payload,
      override: true,
      override_token: res.conflict.override_token,
      override_reason: reason,
    } as any);
    if ("conflict" in res2) throw new Error("Action still has conflicts after override.");
    return res2;
  }
  return res;
};

const runDeleteWithAutoOverride = async (payload: any, reason: string) => {
  if (!user?.userId) throw new Error("Not logged in.");
  const res = await deleteApoOfferingRow(user.userId, payload as any);
  if ("conflict" in res) {
    const res2 = await deleteApoOfferingRow(user.userId, {
      ...payload,
      override: true,
      override_token: res.conflict.override_token,
      override_reason: reason,
    } as any);
    if ("conflict" in res2) throw new Error("Action still has conflicts after override.");
    return res2;
  }
  return res;
};


const runRestoreRow = async (section_id: string) => {
  if (!user?.userId) throw new Error("Not logged in.");
  return await restoreApoOfferingRow(user.userId, { section_id });
};

const makeAddOp = (basePayload: any, createdSectionId: string): ServerOp => {
  let currentId = createdSectionId;
  const label = `Add ${String(basePayload?.course_id || basePayload?.specific_course_id || "section")}`;

  return {
    label,
    undo: async () => {
      await runDeleteWithAutoOverride({ section_id: currentId }, "Undo add");
    },
    redo: async () => {
      // If the prior undo was a SOFT delete (archived), restore in-place; otherwise re-add.
      try {
        await runRestoreRow(currentId);
      } catch {
        const r = await runAddWithAutoOverride(basePayload, "Redo add");
        currentId = (r as any).section_id || currentId;
      }
    },
  };
};

const makeEditOp = (sectionId: string, beforePayload: any, afterPayload: any, label?: string): ServerOp => {
  return {
    label: label || `Edit ${sectionId}`,
    undo: async () => {
      await runEditWithAutoOverride({ ...beforePayload, section_id: sectionId }, "Undo edit");
    },
    redo: async () => {
      await runEditWithAutoOverride({ ...afterPayload, section_id: sectionId }, "Redo edit");
    },
  };
};

const makeDeleteOp = (snapshotRow: OfferingRow): ServerOp => {
  const snap = cloneJson(snapshotRow);
  let currentId = snap.section.section_id;

  const label = `Delete ${String(snap.course?.course_code || snap.course?.course_id || "section")}`;

  return {
    label,
    undo: async () => {
      // If the delete was SOFT (archived), restore the original section_id; otherwise re-add from snapshot.
      try {
        await runRestoreRow(currentId);
        return;
      } catch {
        // fall back to re-add
      }
      const payload = rowToAddPayload(snap);
      const r = await runAddWithAutoOverride(payload, "Undo delete (re-add)");
      currentId = (r as any).section_id || currentId;
    },
    redo: async () => {
      await runDeleteWithAutoOverride({ section_id: currentId }, "Redo delete");
    },
  };
};

const undoServerChange = async () => {
  if (srvBusy) return;
  if (editing) return; // while editing, use draft undo/redo
  if (view !== "offerings") return;
  const stack = srvUndoRef.current;
  if (!stack.length) return;

  const op = stack[stack.length - 1];
  setSrvBusy(true);
  try {
    await op.undo();
    syncSrvStacks(stack.slice(0, -1), [...srvRedoRef.current, op]);
    await loadOfferings();
  } catch (e: any) {
    alert(e?.message || `Failed to undo: ${op.label}`);
  } finally {
    setSrvBusy(false);
  }
};

const redoServerChange = async () => {
  if (srvBusy) return;
  if (editing) return; // while editing, use draft undo/redo
  if (view !== "offerings") return;
  const stack = srvRedoRef.current;
  if (!stack.length) return;

  const op = stack[stack.length - 1];
  setSrvBusy(true);
  try {
    await op.redo();
    syncSrvStacks([...srvUndoRef.current, op], stack.slice(0, -1));
    await loadOfferings();
  } catch (e: any) {
    alert(e?.message || `Failed to redo: ${op.label}`);
  } finally {
    setSrvBusy(false);
  }
};

/* ---------------------- Keyboard shortcuts (Ctrl/Cmd) ---------------------- */
// NOTE: We intentionally do NOT override native undo/redo inside text inputs.
useEffect(() => {
  editingRef.current = editing;
}, [editing]);

useEffect(() => {
  conflictRef.current = conflict;
}, [conflict]);

useEffect(() => {
  shortcutFnsRef.current = {
    undoEditDraft,
    redoEditDraft,
    undoServerChange,
    redoServerChange,
  };
}, [undoEditDraft, redoEditDraft, undoServerChange, redoServerChange]);

useEffect(() => {
  const isEditableTarget = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    if (!el) return false;

    // Native form fields
    const tag = (el as any).tagName ? String((el as any).tagName).toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") return true;

    // contenteditable / rich editors
    if ((el as any).isContentEditable) return true;
    if (el.closest?.("[contenteditable='true']")) return true;
    if (el.getAttribute?.("role") === "textbox") return true;
    return false;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.altKey) return;

    const mod = e.ctrlKey || e.metaKey; // Ctrl (Win/Linux) / Cmd (Mac)
    if (!mod) return;

    const key = String(e.key || "").toLowerCase();
    if (key !== "z" && key !== "y") return;

    // Don’t intercept while the user is typing in an editable control
    if (isEditableTarget(e.target)) return;

    // Avoid undo/redo while resolving conflicts (keeps UX predictable)
    if (conflictRef.current) return;

    // We will handle it
    e.preventDefault();
    e.stopPropagation();

    const fns = shortcutFnsRef.current;
    const isEditing = !!editingRef.current;

    // Ctrl/Cmd+Z => Undo
    if (key === "z" && !e.shiftKey) {
      if (isEditing) fns.undoEditDraft();
      else void fns.undoServerChange();
      return;
    }

    // Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z => Redo
    if (key === "y" || (key === "z" && e.shiftKey)) {
      if (isEditing) fns.redoEditDraft();
      else void fns.redoServerChange();
    }
  };

  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}, []);


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
  // Build initial draft ONCE so we can seed Undo correctly
  const initialDraft: EditDraft = {
    section_id: row.section.section_id,
    section_code: initialSection,
    enrollment_cap: row.section.enrollment_cap ?? "",
    remarks: row.section.remarks ?? "",
    faculty_name: row.faculty?.faculty_name || "UNASSIGNED",
    slot1: row.slot1
      ? {
          day: toFullDay(row.slot1.day) as Day | "",
          start_time: toHHMM(row.slot1.start_time),
          end_time: toHHMM(row.slot1.end_time),
          ...(row.slot1.room_id ? { room_id: row.slot1.room_id } : {}),
        }
      : undefined,
    slot2: row.slot2
      ? {
          day: toFullDay(row.slot2.day) as Day | "",
          start_time: toHHMM(row.slot2.start_time),
          end_time: toHHMM(row.slot2.end_time),
          ...(row.slot2.room_id ? { room_id: row.slot2.room_id } : {}),
        }
      : undefined,
    for_placeholder_course_id: electiveParentId,
    specific_course_id: currentSpecificId,
  };

  // Reset undo/redo + seed the "current snapshot" immediately
  setEditUndo([]);
  setEditRedo([]);
  lastDraftSigRef.current = JSON.stringify(initialDraft);

  setEditing({ row, draft: initialDraft });
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

  // For Undo/Redo: capture the full "before" state (server payload shape)
  const undoBeforePayload = rowToEditPayload(editing.row);


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

// === ADDED: convert any day values to abbreviations before posting ===
if (payload.slot1?.day) (payload.slot1 as any).day = toAbbrevDay(payload.slot1.day) as any;
if (payload.slot2?.day) (payload.slot2 as any).day = toAbbrevDay(payload.slot2.day) as any;

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
        handleConflict("edit", res.conflict, { ...payload, __undo_before: undoBeforePayload });
        return;
      }
      const ov = await editApoOfferingRow(user.userId, {
        ...payload,
        override: true,
        override_token: res.conflict.override_token,
        override_reason: "GE edit – allow free-form section code, time, day, faculty",
      } as any);
      if ("conflict" in ov) {
        handleConflict("edit", ov.conflict, { ...payload, __undo_before: undoBeforePayload });
        return;
      }
    }

    // For Undo/Redo: store a reversible server op
    try {
      const afterPayloadFull = { ...undoBeforePayload, ...payload };
      pushSrvOp(
        makeEditOp(
          String(payload.section_id),
          undoBeforePayload,
          afterPayloadFull,
          `Edit ${String(editing.row.course?.course_code || editing.row.course?.course_id || payload.section_id)}`
        )
      );
    } catch {
      // ignore history errors
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

    // For Undo/Redo: if we are "replacing" an elective placeholder row, capture the before-state
    const undoAnchorRow = addAnchorSectionId ? rows.find((r) => r.section.section_id === addAnchorSectionId) : undefined;
    const undoBeforeAnchor = undoAnchorRow ? rowToEditPayload(undoAnchorRow) : null;

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
            handleConflict("edit", ov.conflict, { ...(editPayload as any), __undo_before: undoBeforeAnchor });
            return;
          }
        }
              // For Undo/Redo: record the placeholder replacement as a reversible EDIT operation
        try {
          if (undoBeforeAnchor && addAnchorSectionId) {
            const afterPayloadFull = { ...undoBeforeAnchor, ...(editPayload as any) };
            pushSrvOp(
              makeEditOp(
                addAnchorSectionId,
                undoBeforeAnchor,
                afterPayloadFull,
                `Replace elective on ${addAnchorSectionId}`
              )
            );
          }
        } catch {
          // ignore history errors
        }

} else {
        // normal, non-elective add flow
        const base: AddDraft = {
          ...addDraft,
          course_id: effectiveCourseId,
          auto_override: isGE,
          campus_id: data?.campus?.campus_id || undefined,
        };
        let createdSectionId: string | null = null;
        const res = await addApoOfferingRow(user.userId, base as any);
        if (!("conflict" in res)) {
          createdSectionId = (res as any).section_id || null;
        }
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
          if (!("conflict" in ov)) {
            createdSectionId = (ov as any).section_id || null;
          }
          if ("conflict" in ov) {
            handleConflict("add", ov.conflict, base);
            return;
          }
        }

        // For Undo/Redo: record ADD as reversible operation
        if (createdSectionId) {
          try {
            pushSrvOp(makeAddOp(base, createdSectionId));
          } catch {
            // ignore history errors
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

  const copyRow = async (r: OfferingRow) => {
    // Build a single, consistent copy string (row-scoped: uses the 'r' passed in)
    const programNo =
      (r.program?.program_code || "—") + "-" + (typeof r.block_index === "number" ? r.block_index : 1);

    const batchIdLabel = normCode(r.batch?.batch_code || "—");
    const courseCode = String(r.course?.course_code || "—");
    const courseTitle = String(r.course?.course_title || "—");

    const sectionCode = (r.section?.section_code || "—").toString();
    const facultyName = (r.faculty?.faculty_name || "UNASSIGNED").toString();

    const slotText = (slot?: OfferingRow["slot1"]) => {
      if (!slot) return "—";
      const day = toAbbrevDay(slot.day) || "—";
      const st = fmtTime(slot.start_time);
      const en = fmtTime(slot.end_time);
      const room = slot.room_number || slot.room_id || "—";
      return `${day} ${st}-${en} @ ${room}`;
    };

    const capacity =
      r.section?.enrollment_cap === null || r.section?.enrollment_cap === undefined
        ? "—"
        : String(r.section.enrollment_cap);

    const remarks = (r.section?.remarks || "—").toString();

    const text =
      `Program No: ${programNo}\n` +
      `Batch: ${batchIdLabel}\n` +
      `Course: ${courseCode} — ${courseTitle}\n` +
      `Section: ${sectionCode}\n` +
      `Faculty: ${facultyName}\n` +
      `Schedule 1: ${slotText(r.slot1)}\n` +
      `Schedule 2: ${slotText(r.slot2)}\n` +
      `Capacity: ${capacity}\n` +
      `Remarks: ${remarks}`;

    // Clipboard write with safe fallback
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      alert("Copied!");
    } catch {
      // last resort fallback attempt
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        alert("Copied!");
      } catch (e: any) {
        alert(e?.message || "Failed to copy.");
      }
    }
  };

  const doDelete = async (row: OfferingRow) => {
    if (blockedByImport) return;
    if (!user?.userId || !row.section.section_id) return;
    if (!confirm("Delete this section? You can undo using the Undo button.")) return;

    // For Undo/Redo: capture the row snapshot before deleting
    const undoSnapshot = cloneJson(row);

    setRows((prev) => prev.filter((r) => r.section.section_id !== row.section.section_id));
    if (editing?.row.section.section_id === row.section.section_id) setEditing(null);
    const res = await deleteApoOfferingRow(user.userId, { section_id: row.section.section_id } as any);
    if ("conflict" in res) {
      handleConflict("delete", res.conflict, { section_id: row.section.section_id, __undo_snapshot: undoSnapshot });
      return;
    }

    // For Undo/Redo: record DELETE as reversible operation
    try {
      pushSrvOp(makeDeleteOp(undoSnapshot));
    } catch {
      // ignore history errors
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
      <TopBar
        fullName={fullName}
        role={campusLabel ? `${roleName} | ${campusLabel}` : roleName}
        inboxPath="/apo/inbox"
      />
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
            List of Courses
          </button>
          <button
            onClick={() => setView("specialclass")}
            className={cls(
              "px-3 py-1.5 text-sm font-medium border-l border-emerald-700",
              view === "specialclass" ? "bg-emerald-700 text-white" : "bg-white text-emerald-700"
            )}
          >
            Special Class
          </button>
          </div>
        </div>
      </div>

      <main className="p-6 w-full">
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
          {/* Undo / Redo (Course Offerings tab only) */}
          {view === "offerings" && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                title={
                  editing
                    ? "Undo (edit draft)"
                    : srvUndo.length
                    ? `Undo: ${srvUndo[srvUndo.length - 1].label}`
                    : "Undo"
                }
                onClick={editing ? undoEditDraft : undoServerChange}
                disabled={editing ? editUndo.length === 0 : srvBusy || srvUndo.length === 0}
                className={cls(
                  "inline-flex h-9 w-9 items-center justify-center rounded-md border",
                  (editing ? editUndo.length === 0 : srvBusy || srvUndo.length === 0)
                    ? "opacity-40 cursor-not-allowed"
                    : "hover:bg-gray-50"
                )}
              >
                <Undo2 className="h-4 w-4 text-emerald-700" />
              </button>

              <button
                type="button"
                title={
                  editing
                    ? "Redo (edit draft)"
                    : srvRedo.length
                    ? `Redo: ${srvRedo[srvRedo.length - 1].label}`
                    : "Redo"
                }
                onClick={editing ? redoEditDraft : redoServerChange}
                disabled={editing ? editRedo.length === 0 : srvBusy || srvRedo.length === 0}
                className={cls(
                  "inline-flex h-9 w-9 items-center justify-center rounded-md border",
                  (editing ? editRedo.length === 0 : srvBusy || srvRedo.length === 0)
                    ? "opacity-40 cursor-not-allowed"
                    : "hover:bg-gray-50"
                )}
              >
                <Redo2 className="h-4 w-4 text-emerald-700" />
              </button>
            </div>
          )}

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
              <SelectBox
                value={batchCode}
                onChange={(v: string) => {
                  setBatchCode(v);
                  setProgramCode("All Programs"); // prevent stale program filter narrowing results
                }}
                options={idOptions}
              />

              <SelectBox
                value={programCode}
                onChange={(v: string) => setProgramCode(v)}
                options={["All Programs", ...(data?.filters.programs || []).map((p) => p.program_code)]}
              />

              {showCurrImportModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
                  <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-xl">
                    <div className="p-6">
                      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-emerald-600 text-emerald-700">
                        <Upload className="h-7 w-7" />
                      </div>

                      <h3 className="text-center text-xl font-semibold">
                        Import List of Courses CSV
                      </h3>

                      <p className="mt-1 text-center text-sm text-slate-600">
                        This will create or update curriculum rows for{" "}
                        <span className="font-semibold">
                          {(curr?.campus?.campus_name ?? data?.campus?.campus_name ?? "your campus")}
                        </span>{" "}
                        across multiple terms, based on <span className="font-semibold">Academic Year</span>{" "}
                        and <span className="font-semibold">Term Number</span>.
                      </p>

                      <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-slate-700">
                        <div className="mb-2 font-semibold text-emerald-800">CSV format</div>
                        <ul className="list-disc space-y-1 pl-5">
                          <li>
                            Required columns: <span className="font-semibold">Batch, Program Level, Program, Term Number, Academic Year, Campus, Course 1...</span>
                          </li>
                          <li>
                            Campus must match the selected campus shown above.
                          </li>
                          <li>
                            Each row becomes one curriculum row for that batch/program in that term.
                          </li>
                        </ul>

                        <button
                          type="button"
                          className="mt-3 inline-flex items-center gap-2 rounded-md border border-emerald-700 bg-white px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
                          onClick={downloadCurriculumCsvTemplate}
                          disabled={importBusy}
                        >
                          <Copy className="h-4 w-4" />
                          Download CSV template
                        </button>
                        <div className="mt-1 text-xs text-slate-500">
                          Use the template to avoid wrong columns / formatting.
                        </div>
                      </div>

                      {currImportErr && (
                        <div className="mt-4 whitespace-pre-line rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                          {currImportErr}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-end gap-2 border-t p-4">
                      <button
                        type="button"
                        className="rounded-md border px-4 py-2 text-sm"
                        onClick={() => {
                          setShowCurrImportModal(false);
                          setCurrImportErr(null);
                          if (fileInputRef.current) fileInputRef.current.value = "";
                        }}
                        disabled={importBusy}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm disabled:opacity-50"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={importBusy}
                      >
                        <Upload className="h-4 w-4" />
                        Choose File
                      </button>
                    </div>
                  </div>
                </div>
              )}

            </>
          )}
          {/* Right side of toolbar */}
          <div className="ml-auto flex items-center gap-3">
          {view === "offerings" && (
            <button
              onClick={() => {
                if (!user?.userId) return;
                // Always show the same styled confirmation modal (like OM → Forward to Chair).
                // For updates, the modal will require a comment.
                setForceRequireNote(false);
                setShowForward(true);
              }}
              className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm"
            >
              <Send className="h-4 w-4" />
              Submit for Scheduling
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

              {/* Right-side actions: Import CSV + Add Course + Edit Course */}
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md border border-emerald-700 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                  disabled={importBusy}
                  onClick={() => {
                    setCurrImportErr(null);
                    setShowCurrImportModal(true);
                  }}
                  title="Import curriculum (IDs / flowcharts) from CSV"
                >
                  <Plus className="h-4 w-4" />
                  Import CSV
                </button>

                <button
                  className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm"
                  onClick={() => setShowCreateCourseModal(true)}
                  title="Create a new course in the global catalog"
                >
                  <Plus className="h-4 w-4" />
                  Add Course
                </button>

                {/* NEW: open global Edit Course modal */}
                <button
                  className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm"
                  onClick={() => setShowEditCourseModal(true)}
                  title="Edit an existing course in the global catalog"
                >
                  <Edit className="h-4 w-4" />
                  Edit Course
                </button>
              </div>

              {/* Hidden file input for CSV upload */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const input = e.target as HTMLInputElement;
                  const file = input.files?.[0];
                  if (!file || !user?.userId) return;

                  setImportBusy(true);
                  setCurrImportErr(null);

                  //Papa.parse<any>(file, {
                   Papa.parse(file, {
                    header: true,
                    skipEmptyLines: true,
                    //complete: async (result) => {
                    complete: async (result: any) => {
                      try {
                        const rows = (result.data || []) as any[];

                        // ---- NEW: make termId and campusName guaranteed strings ----
                        const termId = curr?.term_id ?? data?.term_id;
                        const campusName =
                          curr?.campus?.campus_name ?? data?.campus?.campus_name;

                        if (!termId || !campusName) {
                          console.error("Missing term_id or campus_name for CSV import", {
                            termId,
                            campusName,
                          });
                          setCurrImportErr(
                            "Cannot import CSV: missing term or campus for this curriculum."
                          );
                          return;
                        }

                              
                        // ---------- Validate headers + rows (client-side) ----------
                        const normalize = (v: any) => String(v ?? "").trim();
                        const campusCol = (raw: any) => normalize(raw?.Campus || raw?.campus);
                        const batchCol = (raw: any) => normalize(raw?.Batch || raw?.batch);
                        const progCol = (raw: any) =>
                          normalize(raw?.Program || raw?.["Program Code"] || raw?.program || raw?.program_code);
                        const termNoCol = (raw: any) => normalize(raw?.["Term Number"] || raw?.TermNumber || raw?.term_number);
                        const ayCol = (raw: any) => normalize(raw?.["Academic Year"] || raw?.AY || raw?.acad_year_start);

                        const courseKeys = (result?.meta?.fields || []).filter((f: string) =>
                          /^course\s*\d+$/i.test(String(f || "").trim())
                        );

                        const headerAliases: Record<string, string[]> = {
                          "Batch": ["Batch", "batch"],
                          "Program Level": ["Program Level", "ProgramLevel"],
                          "Program": ["Program", "Program Code", "program", "program_code"],
                          "Term Number": ["Term Number", "TermNumber", "term_number"],
                          "Academic Year": ["Academic Year", "AY", "acad_year_start"],
                          "Campus": ["Campus", "campus"],
                        };

                        const fields = (result?.meta?.fields || []).map((f: any) => String(f || "").trim());
                        const missingHeaders = Object.entries(headerAliases)
                          .filter(([, aliases]) => !aliases.some((a) => fields.includes(a)))
                          .map(([canon]) => canon);
                        const rowErrors: string[] = [];

                        if (missingHeaders.length) {
                          rowErrors.push(
                            `Missing required column(s): ${missingHeaders.join(", ")}`
                          );
                        }
                        if (!courseKeys.length) {
                          rowErrors.push(
                            "Missing course columns. Include at least 'Course 1' (and Course 2, Course 3, ... as needed)."
                          );
                        }

                        const targetCampus = (campusName || "").trim().toLowerCase();

                        const seen = new Set<string>();
                        (rows || []).forEach((r: any, i: number) => {
                          if (!r) return;
                          const rowNo = i + 2; // CSV header is row 1
                          const batch = batchCol(r);
                          const prog = progCol(r);
                          const tno = termNoCol(r);
                          const ay = ayCol(r);
                          const cpn = campusCol(r);

                          // skip fully blank rows
                          const anyVal =
                            batch || prog || tno || ay || cpn || courseKeys.some((k: string) => normalize(r[k]));
                          if (!anyVal) return;

                          const errs: string[] = [];
                          if (!batch) errs.push("Batch is required");
                          if (!prog) errs.push("Program is required");
                          if (!tno) errs.push("Term Number is required");
                          if (!ay) errs.push("Academic Year is required");
                          if (!cpn) errs.push("Campus is required");

                          const tnoInt = parseInt(tno, 10);
                          if (tno && (!Number.isFinite(tnoInt) || tnoInt < 1 || tnoInt > 3)) {
                            errs.push("Term Number must be 1, 2, or 3");
                          }

                          const ayMatch = ay.match(/\d{4}/);
                          if (ay && !ayMatch) {
                            errs.push("Academic Year must include a 4-digit start year (e.g., 2027)");
                          }

                          if (cpn && targetCampus && cpn.toLowerCase() !== targetCampus) {
                            errs.push(`Campus must be ${campusName} (you are importing for ${campusName})`);
                          }

                          const courseVals = courseKeys
                            .map((k: string) => normalize(r[k]))
                            .filter(Boolean);
                          if (!courseVals.length) {
                            errs.push("At least one course code is required (Course 1, Course 2, ...)");
                          }

                          const dedupeKey = [batch, prog, ayMatch?.[0] || ay, String(tnoInt || tno)].join("|").toLowerCase();
                          if (batch && prog && ay && tno && seen.has(dedupeKey)) {
                            errs.push("Duplicate row for the same Batch + Program + Academic Year + Term Number");
                          } else if (batch && prog && ay && tno) {
                            seen.add(dedupeKey);
                          }

                          if (errs.length) {
                            rowErrors.push(`Row ${rowNo}: ${errs.join("; ")}`);
                          }
                        });

                        if (rowErrors.length) {
                          setCurrImportErr(
                            `Invalid Curriculum CSV file for ${String(campusName || "campus").toUpperCase()}. Nothing was saved.\n` +
                              rowErrors.map((e) => `- ${e}`).join("\n")
                          );
                          return;
                        }
                        // ---------- end validation ----------
const response = await importCurriculumCsv(user.userId, {
                      rows,
                      term_id: termId,
                      campus_name: campusName,
                    });

                    console.log("CSV import response:", response);

                    if (response.ok) {
                      const imported =
                        response.imported ?? response.curricula?.length ?? 0;

                      // NEW: always fall back to an empty array
                      const created = response.created_batches ?? [];
                      const createdText = created.length
                        ? `\nCreated batches: ${created.join(", ")}`
                        : "";

                      alert(
                        `CSV import successful.\n` +
                          `Imported ${imported} row(s).` +
                          createdText
                      );

                        }
                      } catch (err: any) {
                        console.error("CSV import failed:", err);
                        setCurrImportErr(err?.message || "CSV import failed");
                      } finally {
                        setImportBusy(false);
                        if (fileInputRef.current) fileInputRef.current.value = "";
                      }
                    },
                    //error: (err) => {
                    error: (err: unknown) => {
                      console.error("CSV parse error:", err);
                      setCurrImportErr("Failed to parse CSV file. Please check the format.");
                      setImportBusy(false);
                      input.value = "";
                    },
                  });
                }}
              />

              {showCurrImportModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
                  <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-xl">
                    <div className="p-6">
                      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-emerald-600 text-emerald-700">
                        <Upload className="h-7 w-7" />
                      </div>

                      <h3 className="text-center text-xl font-semibold">
                        Import List of Courses CSV
                      </h3>

                      <p className="mt-1 text-center text-sm text-slate-600">
                        This will create or update curriculum rows for{" "}
                        <span className="font-semibold">
                          {(curr?.campus?.campus_name ?? data?.campus?.campus_name ?? "your campus")}
                        </span>{" "}
                        across multiple terms, based on <span className="font-semibold">Academic Year</span>{" "}
                        and <span className="font-semibold">Term Number</span>.
                      </p>

                      <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-slate-700">
                        <div className="mb-2 font-semibold text-emerald-800">CSV format</div>
                        <ul className="list-disc space-y-1 pl-5">
                          <li>
                            Required columns: <span className="font-semibold">Batch, Program Level, Program, Term Number, Academic Year, Campus, Course 1...</span>
                          </li>
                          <li>
                            Campus must match the selected campus shown above.
                          </li>
                          <li>
                            Each row becomes one curriculum row for that batch/program in that term.
                          </li>
                        </ul>

                        <button
                          type="button"
                          className="mt-3 inline-flex items-center gap-2 rounded-md border border-emerald-700 bg-white px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
                          onClick={downloadCurriculumCsvTemplate}
                          disabled={importBusy}
                        >
                          <Copy className="h-4 w-4" />
                          Download CSV template
                        </button>
                        <div className="mt-1 text-xs text-slate-500">
                          Use the template to avoid wrong columns / formatting.
                        </div>
                      </div>

                      {currImportErr && (
                        <div className="mt-4 whitespace-pre-line rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                          {currImportErr}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-end gap-2 border-t p-4">
                      <button
                        type="button"
                        className="rounded-md border px-4 py-2 text-sm"
                        onClick={() => {
                          setShowCurrImportModal(false);
                          setCurrImportErr(null);
                          if (fileInputRef.current) fileInputRef.current.value = "";
                        }}
                        disabled={importBusy}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm disabled:opacity-50"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={importBusy}
                      >
                        <Upload className="h-4 w-4" />
                        Choose File
                      </button>
                    </div>
                  </div>
                </div>
              )}

            </>
          )}
        </div>
        <div className="rounded-xl bg-white shadow-sm border border-gray-200 p-4 sm:p-6 w-full" data-course-offerings>
          <div className="flex items-center justify-between mb-3 sm:mb-4">
            <div>
              <h2 className="text-lg font-bold">
                {view === "curriculum" ? "List of Courses" :
                view === "specialclass" ? "Special Class" : "Course Offerings"}
              </h2>
              <p className="text-sm text-gray-500">{loading ? "Loading…" : data?.term_label || curr?.term_label || ""}</p>
              {err && <p className="text-sm text-red-600">{err}</p>}
            </div>
          </div>

          {/* planning banner */}
          {view === "offerings" && data?.planning && (
            <>
              {showApprovalBanner && (
                <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 shadow-sm">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 grid h-9 w-9 place-items-center rounded-full bg-amber-200 text-amber-900">
                        <AlertTriangle className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="font-semibold text-amber-950">
                          Action required: Approve planning updates
                        </div>
                        <div className="text-sm text-amber-900">
                          {data?.planning?.pending_changes?.length || 0} change(s) are waiting for your approval.
                          These are <span className="font-semibold">not applied</span> until you approve.
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2">
                      <button
                        className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:brightness-110"
                        onClick={() => setShowPlanModal(true)}
                      >
                        Review &amp; Approve
                      </button>
                    </div>
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
                  <div   key={idLabel}
                    className="rounded-xl border border-gray-300 bg-white shadow-sm overflow-visible mb-6">
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
                            <div className="overflow-x-auto relative" style={{ overflowY: "visible" }}>
                              <table className="w-full text-sm border-collapse table-fixed">
                                  <colgroup>
                                    <col style={{ width: 96 }} />   {/* Program No. */}
                                    <col style={{ width: 230 }} />  {/* Course Code & Title */}
                                    <col style={{ width: 90 }} />   {/* Section */}
                                    <col style={{ width: 180 }} />  {/* Faculty */}
                                    <col style={{ width: 95 }} />   {/* Day 1 */}
                                    <col style={{ width: 70 }} />   {/* Begin 1 */}
                                    <col style={{ width: 70 }} />   {/* End 1 */}
                                    <col style={{ width: 120 }} />  {/* Room 1 */}
                                    <col style={{ width: 95 }} />   {/* Day 2 */}
                                    <col style={{ width: 70 }} />   {/* Begin 2 */}
                                    <col style={{ width: 70 }} />   {/* End 2 */}
                                    <col style={{ width: 120 }} />  {/* Room 2 */}
                                    <col style={{ width: 80 }} />   {/* Capacity */}
                                    <col style={{ width: 150 }} />  {/* Remarks */}
                                    <col style={{ width: 120 }} />  {/* Actions */}
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
                                          <td className="px-3 py-2 border border-gray-300">{toAbbrevDay(r.slot1?.day) || "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot1?.start_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot1?.end_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300">{r.slot1?.room_number || r.slot1?.room_id || "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{toAbbrevDay(r.slot2?.day) || "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot2?.start_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300">{fmtTime(r.slot2?.end_time)}</td>
                                          <td className="px-3 py-2 border border-gray-300">{r.slot2?.room_number || r.slot2?.room_id || "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{r.section.enrollment_cap ?? "—"}</td>
                                          <td className="px-3 py-2 border border-gray-300">{r.section.remarks || "—"}</td>
                                        <td className="px-3 py-2 border border-gray-300">
                                          <div className="flex flex-wrap gap-2">
                                            <button
                                              className="text-emerald-700 hover:text-emerald-900"
                                              title="Copy"
                                              onClick={() => copyRow(r)}
                                            >
                                              <Copy className="h-4 w-4" />
                                            </button>

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
                                            const placeholderLabel = "— Select specific elective —";
                                            const specificOptions = specificList.map((opt) => ({
                                              id: opt.course_id,
                                              label: `${codeOf(opt.course_code)} • ${opt.course_title}`,
                                            }));

                                            const currentSpecificId =
                                              editing?.draft.specific_course_id || (isSpecific ? r.course.course_id : "");
                                            const currentLabel =
                                              currentSpecificId
                                                ? specificOptions.find((o) => o.id === currentSpecificId)?.label || placeholderLabel
                                                : placeholderLabel;

                                            return (
                                              <div className="mt-2">
                                                <label className="text-xs font-medium text-slate-700 mb-1 block">
                                                  Specific Elective
                                                </label>
                                                <SelectBox
                                                  value={currentLabel}
                                                  onChange={(label: string) => {
                                                    const hit = specificOptions.find((o) => o.label === label);
                                                    const sid = hit?.id || "";
                                                    setEditing((p) =>
                                                      p && {
                                                        ...p,
                                                        draft: {
                                                          ...p.draft,
                                                          for_placeholder_course_id: parentId || undefined,
                                                          specific_course_id: sid || undefined,
                                                        },
                                                      }
                                                    );
                                                  }}
                                                  options={[placeholderLabel, ...specificOptions.map((o) => o.label)]}
                                                  className="!min-w-0 w-full max-w-full"
                                                />
                                              </div>
                                            );

                                            })()}
                                          </td>

                                          {/* Section code */}
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            <div className="w-full min-w-0">
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
                                            className={`${SOFT_INPUT} w-full min-w-0`}
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
                                            </div>
                                          </td>

                                          {/* Faculty - editable if GE */}
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            <div className="w-full min-w-0">
                                            {ge ? (
                                              <input
                                                value={editing?.draft.faculty_name || ""}
                                                onChange={(e) =>
                                                  setEditing((p) => p && { ...p, draft: { ...p.draft, faculty_name: e.target.value } })
                                                }
                                                placeholder="Faculty name"
                                                className={`${SOFT_INPUT} w-full min-w-0`}
                                              />
                                            ) : (
                                              <span className={r.faculty.faculty_name === "UNASSIGNED" ? "text-red-600 font-medium" : ""}>
                                                {r.faculty.faculty_name || "UNASSIGNED"}
                                              </span>
                                            )}
                                            </div>
                                          </td>

                                          {/* Slot 1 */}
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                          {ge ? (
                                            <SelectBox
                                              value={(editing?.draft.slot1?.day && editing.draft.slot1.day.length ? editing.draft.slot1.day : "—") as string}
                                              onChange={(label: string) =>
                                                setEditing(p => p && ({
                                                  ...p,
                                                  draft: {
                                                    ...p.draft,
                                                    slot1: { ...(p.draft.slot1 || {}), day: (label === "—" ? "" : (label as Day)) }
                                                  }
                                                }))
                                              }
                                              options={["—", ...DAYS]}
                                              className="!min-w-0 w-full max-w-full"
                                            />
                                          ) : (
                                            r.slot1?.day || "—"
                                          )}

                                          </td>
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            {ge ? (
                                              <TimeBandInput
                                                slot={editing?.draft.slot1}
                                                onChange={(update) =>
                                                  setEditing((p) =>
                                                    p && {
                                                      ...p,
                                                      draft: {
                                                        ...p.draft,
                                                        slot1: {
                                                          ...(p.draft.slot1 || {}),
                                                          ...update, // { start_time, end_time }
                                                        },
                                                      },
                                                    }
                                                  )
                                                }
                                              />
                                            ) : (
                                              fmtTime(r.slot1?.start_time)
                                            )}
                                          </td>

                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                          {ge ? (
                                            <div className="text-sm">{fmtTime(editing?.draft.slot1?.end_time) || "—"}</div>
                                          ) : (
                                            fmtTime(r.slot1?.end_time)
                                          )}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-200 bg-white relative overflow-visible">
                                            <div className="w-full max-w-[120px] overflow-visible">
                                              <EligibleRoomSelect
                                              userId={user?.userId}
                                              campusId={data?.campus?.campus_id || ""}
                                              spec={{
                                                day: (editing?.draft.slot1?.day || r.slot1?.day || "") as string,
                                                start: editing?.draft.slot1?.start_time || r.slot1?.start_time || "",
                                                end: editing?.draft.slot1?.end_time || r.slot1?.end_time || "",
                                                roomType: (r as any)?.slot1?.room_type || (r as any)?.slot2?.room_type || null,
                                                capacity: r.section.enrollment_cap ?? null,
                                                excludeScheduleIds: [r.slot1?.schedule_id, r.slot2?.schedule_id].filter(Boolean) as string[],
                                              }}
                                              fallbackRooms={filterRoomsByCap(data?.room_options || [], r.section.enrollment_cap)}
                                              value={editing?.draft.slot1?.room_id || null}
                                              disabled={scEligibleRoomsLoading[editing?.draft.slot1?.room_id ?? ""] || !slotReady(editing?.draft.slot1) && !slotReady(r.slot1 as any)}
                                              onChange={(roomId) =>
                                                setEditing(p => p && ({
                                                  ...p,
                                                  draft: { ...p.draft, slot1: { ...(p.draft.slot1 || {}), room_id: roomId ?? "" } }
                                                }))
                                              }
                                            />
                                            </div>
                                          </td>

                                          {/* Slot 2 */}
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            {ge ? (
                                              <SelectBox
                                                value={(editing?.draft.slot2?.day && editing.draft.slot2.day.length ? editing.draft.slot2.day : "—") as string}
                                                onChange={(label: string) =>
                                                  setEditing(p => p && ({
                                                    ...p,
                                                    draft: {
                                                      ...p.draft,
                                                      slot2: { ...(p.draft.slot2 || {}), day: (label === "—" ? "" : (label as Day)) }
                                                    }
                                                  }))
                                                }
                                                options={["—", ...DAYS]}
                                                className="!min-w-0 w-full max-w-full"
                                              />
                                            ) : (
                                              r.slot2?.day || "—"
                                            )}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                            {ge ? (
                                              <TimeBandInput
                                                slot={editing?.draft.slot2}
                                                onChange={(update) =>
                                                  setEditing((p) =>
                                                    p && {
                                                      ...p,
                                                      draft: {
                                                        ...p.draft,
                                                        slot2: {
                                                          ...(p.draft.slot2 || {}),
                                                          ...update, // { start_time, end_time }
                                                        },
                                                      },
                                                    }
                                                  )
                                                }
                                              />
                                            ) : (
                                              fmtTime(r.slot2?.start_time)
                                            )}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-200 bg-white">
                                          {ge ? (
                                            <div className="text-sm">{fmtTime(editing?.draft.slot2?.end_time) || "—"}</div>
                                          ) : (
                                            fmtTime(r.slot2?.end_time)
                                          )}
                                          </td>
                                          <td className="px-3 py-2 border border-gray-200 bg-white relative overflow-visible">
                                            <div className="w-full max-w-[120px] overflow-visible">
                                              <EligibleRoomSelect
                                              userId={user?.userId}
                                              campusId={data?.campus?.campus_id || ""}
                                              spec={{
                                                day: (editing?.draft.slot2?.day || r.slot2?.day || "") as string,
                                                start: editing?.draft.slot2?.start_time || r.slot2?.start_time || "",
                                                end: editing?.draft.slot2?.end_time || r.slot2?.end_time || "",
                                                roomType: (r as any)?.slot2?.room_type || (r as any)?.slot1?.room_type || null,
                                                capacity: r.section.enrollment_cap ?? null,
                                                excludeScheduleIds: [r.slot1?.schedule_id, r.slot2?.schedule_id].filter(Boolean) as string[],
                                              }}
                                              fallbackRooms={filterRoomsByCap(data?.room_options || [], r.section.enrollment_cap)}
                                              value={editing?.draft.slot2?.room_id || null}
                                              disabled={scEligibleRoomsLoading[editing?.draft.slot2?.room_id ?? ""] || !slotReady(editing?.draft.slot2) && !slotReady(r.slot2 as any)}
                                              onChange={(roomId) =>
                                                setEditing(p => p && ({
                                                  ...p,
                                                  draft: { ...p.draft, slot2: { ...(p.draft.slot2 || {}), room_id: roomId ?? "" } }
                                                }))
                                              }
                                            />
                                            </div>
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
                                                      {rowIsElective && (() => {
                                                        const placeholderLabel = "— Select specific elective —";
                                                        const specificOptions = specificElectives.map((opt) => ({
                                                          id: opt.course_id,
                                                          label: `${codeOf(opt.course_code)} • ${opt.course_title}`,
                                                        }));

                                                        const currentLabel =
                                                          addElectiveSpecificId
                                                            ? specificOptions.find((o) => o.id === addElectiveSpecificId)?.label || placeholderLabel
                                                            : placeholderLabel;

                                                        return (
                                                          <div className="mb-2">
                                                            <label className="text-xs font-medium text-slate-700 mb-1 block">
                                                              Specific Elective
                                                            </label>
                                                            <SelectBox
                                                              value={currentLabel}
                                                              onChange={(label: string) => {
                                                                const hit = specificOptions.find((o) => o.label === label);
                                                                const sid = hit?.id || "";
                                                                setAddElectiveSpecificId(sid);
                                                                setAddDraft((p) => ({
                                                                  ...p,
                                                                  for_placeholder_course_id: r.course.course_id,
                                                                  specific_course_id: sid || undefined,
                                                                  course_id: sid || "",
                                                                }));
                                                              }}
                                                              options={[placeholderLabel, ...specificOptions.map((o) => o.label)]}
                                                              className="!min-w-0 w-full max-w-full"
                                                            />
                                                          </div>
                                                        );
                                                      })()}
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
                                                rooms={filterRoomsByCap(data?.room_options || []).filter(
                                                  (room) => String(room.room_id || "").toUpperCase() !== "ONLINE"
                                                )}
                                                value={addDraft.slot2?.room_id || null}
                                                onChange={(roomId) => setAddDraft(p => ({ ...p, slot2: { ...(p.slot2 || {}), room_id: roomId ?? "" } }))}

                                                className="opacity-60"
                                              />
                                            </td>

                                            <td className="px-3 py-2 border border-gray-200 bg-white">—</td>
                                            <td className="px-3 py-2 border border-gray-200 bg-white">—</td>
                                            <td className="px-3 py-2 border border-gray-200 bg-white">—</td>
                                            <td className="px-3 py-2 border border-gray-200 bg-white">
                                              <RoomSelectBox
                                                rooms={filterRoomsByCap(data?.room_options || []).filter(
                                                  (room) => String(room.room_id || "").toUpperCase() !== "ONLINE"
                                                )}
                                                value={addDraft.slot1?.room_id || null}
                                                onChange={(roomId) => setAddDraft(p => ({ ...p, slot1: { ...(p.slot1 || {}), room_id: roomId ?? "" } }))}

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
            <div className="rounded-xl border border-gray-300 bg-white shadow-sm overflow-visible">
              {/* Header follows selection state */}
              <div className="bg-emerald-700 text-white px-4 py-3 text-center font-semibold">
                {selectedBatchId
                  ? `ID ${
                      (curr?.items || [])
                        .find((i) => i.batch_id === selectedBatchId)
                        ?.batch_code?.replace(/^ID\s*/i, "") || "—"
                    }`
                  : "List of Courses"}
              </div>

              {/* Single ID view */}
              {selectedBatchId ? (
                <div className="p-3"> {/* remove overflow-x-auto so grid can wrap */}
                  <div
                    className="grid gap-4"
                    style={{
                      gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                      alignItems: "start",
                      width: "100%",
                      boxSizing: "border-box",
                    }}
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
                          <div
                            key={pid}
                            className="rounded-lg border border-gray-200 overflow-hidden"
                            style={{ minWidth: 0, width: "100%", boxSizing: "border-box" }}
                          >
                            {/* header with add controls */}
                            <div className="flex items-center justify-between gap-2 border-b bg-gray-50 px-3 py-2">
                              {/* let the label take space; allow ellipsis only when needed */}
                              <div className="font-semibold text-emerald-800 flex-1 min-w-0 pr-2 break-words whitespace-normal">
                                <span className="block" title={programCode}>{programCode}</span>
                              </div>

                              {/* controls should not claim the whole row */}
                              <div className="flex items-center gap-2 flex-none min-w-[280px]" style={{ minWidth: 0 }}>
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
                                    handleCurrAdd(pid, itm.batch_id, selectedId);
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
                                <button
                                  className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white shadow-sm"
                                  onClick={() =>
                                    setEditorState({
                                      open: true,
                                      program_id: pid,
                                      program_code: programCode,
                                      batch_id: selectedBatchId!,   // single-ID view
                                    })
                                  }
                                  title="Edit program courses"
                                >
                                  <Edit className="h-4 w-4" />
                                  Edit
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
                                const replaceCodeToId: Record<string, string> = {};
                                allowedForReplace.forEach((o) => (replaceCodeToId[o.course_code] = o.course_id));

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
                          <div className="p-3">
                            <div
                              className="grid gap-4"
                              style={{
                                gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                                alignItems: "start",
                                width: "100%",
                                boxSizing: "border-box",
                              }}
                            >
                            {programList.map((itm) => {
                              const pid = itm.program_id;
                              const programCode = itm?.program_code || "—";
                              const opts = optionsByProgram[pid] || [];

                              const allowedIds = eligibleCourseIdsByProgram[pid] || new Set<string>();
                              const filteredOpts = (opts || []).filter((o) => allowedIds.has(o.course_id));

                              const codeToId: Record<string, string> = {};
                              const idToCode: Record<string, string> = {};
                              filteredOpts.forEach((o) => {
                                codeToId[o.course_code] = o.course_id;
                                idToCode[o.course_id] = o.course_code;
                              });

                              const filteredCourses = (itm?.courses || []).filter((c) => {
                                if (!currSearch.trim()) return true;
                                const q = currSearch.toLowerCase();
                                return c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q);
                              });

                              return (
                                  <div
                                    key={pid}
                                    className="rounded-lg border border-gray-200 overflow-hidden"
                                    style={{ minWidth: 0, width: "100%", boxSizing: "border-box" }}
                                  >
                                  {/* header with add controls */}
                                  <div className="flex items-center justify-between gap-2 border-b bg-gray-50 px-3 py-2">
                                    <div className="font-semibold text-emerald-800 flex-1 min-w-0 pr-2 break-words whitespace-normal">
                                      <span className="block" title={programCode}>{programCode}</span>
                                    </div>

                                    <div className="flex items-center gap-2 flex-none min-w-[280px]" style={{ minWidth: 0 }}>
                                      <button
                                        className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white shadow-sm"
                                        onClick={() =>
                                          setEditorState({
                                            open: true,
                                            program_id: pid,
                                            program_code: programCode,
                                            batch_id: itm.batch_id,      // all-IDs view
                                          })
                                        }
                                        title="Edit program courses"
                                      >
                                        <Edit className="h-4 w-4" />
                                        Edit
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
                                      const replaceCodeToId: Record<string, string> = {};
                                      allowedForReplace.forEach((o) => (replaceCodeToId[o.course_code] = o.course_id));

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
                                                    handleCurrEditUnits(pid, itm.batch_id, c.course_id, num);
                                                  }
                                                }}
                                              />
                                              <button
                                                className="text-red-500 hover:text-red-700"
                                                title="Remove"
                                                onClick={() => handleCurrRemove(pid, itm.batch_id, c.course_id)}
                                              >
                                                <Trash2 className="h-4 w-4" />
                                              </button>
                                            </div>
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
          {/* ------------------------------ Special Class ------------------------------ */}
          {view === "specialclass" && (
            <div className="rounded-xl border border-gray-300 bg-white shadow-sm overflow-hidden">
              <div className="bg-emerald-700 text-white px-4 py-3 text-center font-semibold">
                Special Class
              </div>

              <div className="p-3">
                {scErr && <div className="mb-2 text-sm text-red-600">{scErr}</div>}

                {scLoading ? (
                  <div className="text-sm text-neutral-500">Loading…</div>
                ) : scErr ? (
                  <div className="text-sm text-red-600">Failed to load special class: {scErr}</div>
                ) : scRowsForCampus.length === 0 ? (
                  <div className="text-sm text-neutral-500">No special class records found.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead className="bg-gray-50 text-emerald-800">
                        <tr className="text-[13px] font-semibold">
                          {[
                            "Student",
                            "Course",
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
                            "Remarks",
                            "Actions",
                          ].map((h) => (
                            <th key={h} className="px-3 py-2 text-left border border-gray-300">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>

                      <tbody>
                        {scRowsForCampus.map((raw) => {
                          const row = raw as any;
                          const isEditing = scEditingId === String(row.special_id);

                          const student_name = row?.student?.student_name ?? row?.student_name ?? "—";
                          const student_number = row?.student?.student_number ?? row?.student_number ?? "—";

                          const course_code_raw = row?.course?.course_code ?? row?.course_code ?? "";
                          const course_code = Array.isArray(course_code_raw)
                            ? String(course_code_raw[0] ?? "—")
                            : String(course_code_raw || "—");

                          const course_title = row?.course?.course_title ?? row?.course_title ?? "—";

                          const section_code = row?.section?.section_code ?? row?.section_code ?? "—";
                          const faculty_name = row?.faculty?.faculty_name ?? row?.faculty_name ?? "—";

                          const se = Array.isArray(row?.schedule_entries) ? row.schedule_entries : [];
                          const slot1 = row?.slot1 ?? se[0] ?? null;
                          const slot2 = row?.slot2 ?? se[1] ?? null;

                          const slotDay = (s: any) => (s?.day || "—");

                          const safeTime = (x: any) => {
                            const digits = String(x ?? "").replace(/\D/g, "");
                            if (!digits) return "—";
                            const hhmm = digits.padStart(4, "0");
                            return typeof fmtTime === "function" ? fmtTime(hhmm) : hhmm;
                          };
                          const slotStart = (s: any) => safeTime(s?.start_time);
                          const slotEnd = (s: any) => safeTime(s?.end_time);

                          const slotRoomLabel = (s: any) => {
                          const rn = String(s?.room_number || s?.room_name || "").trim();
                          const rid = String(s?.room_id || "").trim();

                          // Treat ONLINE as "no physical room". If a room_id exists, display it even
                          // if room_type was (incorrectly) stored as "Online" (delivery mode).
                          const ridOrRn = String(rn || rid).trim().toUpperCase();
                          if (ridOrRn === "ONLINE") return "TBA";
                          if (!rn && !rid) return "TBA";
                          return rn || rid || "TBA";

                          };


                          // Prefer row.remarks; fallback to section_remarks if backend sends it there
                          const remarks =
                            row?.remarks ?? row?.section?.section_remarks ?? row?.section_remarks ?? "—";

                          const slotReadySC = (s: any) =>
                            !!String(s?.day ?? "").trim() &&
                            !!String(s?.start_time ?? "").trim() &&
                            !!String(s?.end_time ?? "").trim();

                          const campusId =
                            scData?.campus?.campus_id ||
                            (data as any)?.campus?.campus_id ||
                            "";

                          const minCap = typeof _minCapacityFromRow === "function" ? _minCapacityFromRow(row) : undefined;
                          const excludeScheduleIds =
                            typeof _scheduleIdsFromRow === "function" ? _scheduleIdsFromRow(row) : [];

                          const fallbackRoomsBase = filterRoomsByCap(
                            ((data as any)?.room_options || []) as any[],
                            minCap
                          );

                          const fallbackRooms = fallbackRoomsBase;;

                          return (
                            <tr key={String(row.special_id)} className="hover:bg-neutral-50">
                              <td className="px-3 py-2 border border-gray-300">
                                <div className="font-medium">{student_name || "—"}</div>
                                <div className="text-xs text-gray-500">{student_number || "—"}</div>
                              </td>

                              <td className="px-3 py-2 border border-gray-300">
                                <div className="font-semibold text-emerald-700">{course_code || "—"}</div>
                                <div className="text-xs text-gray-500">{course_title || "—"}</div>
                              </td>

                              <td className="px-3 py-2 border border-gray-300">{section_code || "—"}</td>
                              <td className="px-3 py-2 border border-gray-300">{faculty_name || "—"}</td>

                              <td className="px-3 py-2 border border-gray-300">{slotDay(slot1)}</td>
                              <td className="px-3 py-2 border border-gray-300">{slotStart(slot1)}</td>
                              <td className="px-3 py-2 border border-gray-300">{slotEnd(slot1)}</td>
                              <td className="px-3 py-2 border border-gray-300">
                              {isEditing ? (
                              <div className="w-full max-w-[160px] overflow-visible">
                                <EligibleRoomSelect
                                    userId={user?.userId}
                                    campusId={campusId}
                                    spec={{
                                      day: String(slot1?.day ?? "").trim(),
                                      start: String(slot1?.start_time ?? "").trim(),
                                      end: String(slot1?.end_time ?? "").trim(),
                                      roomType: String(slot1?.room_type ?? row?.course?.room_type ?? "").trim() || null,
                                      capacity: minCap ?? null,
                                      excludeScheduleIds,
                                      // Let backend infer the correct section enrollment_cap from DB
                                      sectionId: String(row?.section_id ?? row?.section?.section_id ?? "").trim() || null,
                                      scheduleId: String(slot1?.schedule_id ?? "").trim() || null,
                                    }}
                                    fallbackRooms={fallbackRooms}
                                    value={scEditRoom1 || null}
                                    disabled={ 
                                      !slotReadySC(slot1) || !user?.userId || !campusId || scEligibleRoomsLoading[slot1?.room_id ?? ""] || fallbackRooms.length === 0
                                    }


                                    onChange={(roomId) => setScEditRoom1(roomId ?? "")}
                                  />
                                </div>
                              ) : (
                                slotRoomLabel(slot1)
                              )}
                              </td>

                              <td className="px-3 py-2 border border-gray-300">{slotDay(slot2)}</td>
                              <td className="px-3 py-2 border border-gray-300">{slotStart(slot2)}</td>
                              <td className="px-3 py-2 border border-gray-300">{slotEnd(slot2)}</td>
                              <td className="px-3 py-2 border border-gray-300">
                                {isEditing ? (
                                <div className="w-full max-w-[160px] overflow-visible">
                                  <EligibleRoomSelect
                                      userId={user?.userId}
                                      campusId={campusId}
                                      spec={{
                                        day: String(slot2?.day ?? "").trim(),
                                        start: String(slot2?.start_time ?? "").trim(),
                                        end: String(slot2?.end_time ?? "").trim(),
                                        roomType:
                                          String(slot2?.room_type ?? slot1?.room_type ?? row?.course?.room_type ?? "")
                                            .trim() || null,
                                        capacity: minCap ?? null,
                                        excludeScheduleIds,
                                        // Let backend infer the correct section enrollment_cap from DB
                                        sectionId: String(row?.section_id ?? row?.section?.section_id ?? "").trim() || null,
                                        scheduleId: String(slot2?.schedule_id ?? "").trim() || null,
                                      }}
                                      fallbackRooms={fallbackRooms}
                                      value={scEditRoom2 || null}
                                      disabled={!slotReadySC(slot2) || !user?.userId || !campusId}
                                      onChange={(roomId) => setScEditRoom2(roomId ?? "")}
                                    />
                                  </div>
                                ) : (
                                  slotRoomLabel(slot2)
                                )}
                              </td>

                              <td className="px-3 py-2 border border-gray-300">
                                {isEditing ? (
                                  <input
                                    className={cls(SOFT_INPUT, "w-64")}
                                    value={scEditRemarks}
                                    onChange={(e) => setScEditRemarks(e.target.value)}
                                    placeholder="Enter remarks…"
                                  />
                                ) : (
                                  String(remarks || "—")
                                )}
                              </td>

                              <td className="px-3 py-2 border border-gray-300">
                                {isEditing ? (
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={() => saveSpecialClassRowEdits(row)}
                                      disabled={scSaveLoadingId === String(row.special_id)}
                                      className={cls(
                                        "flex h-8 w-8 items-center justify-center rounded-full border-2",
                                        "border-green-600 text-green-600 hover:bg-green-50",
                                        scSaveLoadingId === String(row.special_id) && "opacity-50 cursor-not-allowed"
                                      )}
                                      title="Save"
                                    >
                                      <Check className="h-4 w-4" strokeWidth={2.5} />
                                    </button>

                                    <button
                                      onClick={cancelEditSpecialClassRow}
                                      disabled={scSaveLoadingId === String(row.special_id)}
                                      className={cls(
                                        "flex h-8 w-8 items-center justify-center rounded-full border-2",
                                        "border-red-600 text-red-600 hover:bg-red-50",
                                        scSaveLoadingId === String(row.special_id) && "opacity-50 cursor-not-allowed"
                                      )}
                                      title="Cancel"
                                    >
                                      <X className="h-4 w-4" strokeWidth={2.5} />
                                    </button>

                                    {scSaveLoadingId === String(row.special_id) && (
                                      <span className="text-xs text-gray-500">Saving…</span>
                                    )}
                                  </div>
                                ) : (
                                  <button
                                    className="text-emerald-700 hover:text-emerald-900"
                                    title="Edit"
                                    onClick={() => beginEditSpecialClassRow(row)}
                                  >
                                    <Edit className="h-4 w-4" />
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
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
                      const basePayload = { ...(conflict.original as any) };
                      delete (basePayload as any).__undo_before;
                      delete (basePayload as any).__undo_snapshot;

                      const resp = await addApoOfferingRow(user.userId, { ...basePayload, ...ov } as any);
                      if ("conflict" in (resp as any)) {
                        // If still conflicting, keep the modal open with the latest details
                        handleConflict("add", (resp as any).conflict, basePayload);
                        return;
                      }

                      const createdId = (resp as any).section_id as string;
                      if (createdId) pushSrvOp(makeAddOp(basePayload, createdId));
                    } else if (conflict.action === "edit") {
                      const raw = { ...(conflict.original as any) };
                      const before = (raw as any).__undo_before;
                      delete (raw as any).__undo_before;
                      delete (raw as any).__undo_snapshot;

                      const resp = await editApoOfferingRow(user.userId, { ...raw, ...ov } as any);
                      if ("conflict" in (resp as any)) {
                        handleConflict("edit", (resp as any).conflict, { ...raw, __undo_before: before });
                        return;
                      }

                      const sid = String((raw as any).section_id || "");
                      if (before && sid) {
                        const afterFull = { ...(before as any), ...(raw as any) };
                        pushSrvOp(makeEditOp(sid, before, afterFull, `Edit ${sid}`));
                      }
                    } else if (conflict.action === "delete") {
                      const raw = { ...(conflict.original as any) };
                      const snap = (raw as any).__undo_snapshot;
                      delete (raw as any).__undo_before;
                      delete (raw as any).__undo_snapshot;

                      const resp = await deleteApoOfferingRow(user.userId, { ...raw, ...ov } as any);
                      if ("conflict" in (resp as any)) {
                        handleConflict("delete", (resp as any).conflict, { ...raw, __undo_snapshot: snap });
                        return;
                      }

                      if (snap) pushSrvOp(makeDeleteOp(snap));
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
        <SubmitModal
          requireNote={hasPriorSubmit || forceRequireNote}
          onClose={() => setShowForward(false)}
          onSubmit={async (note) => {
            if (!user?.userId) return;

            const isUpdate = hasPriorSubmit || forceRequireNote;

            try {
              await forwardApoCourseOfferings(user.userId, {
                to: "scheduling",
                subject: `Submit for Scheduling — ${data?.term_label || ""}`,
                // First submission: no comment box, so send empty note.
                message: isUpdate ? (note || "") : "",
                exclude_conflicts: true,
              });

              await loadOfferings();
              setForceRequireNote(false);
              setShowForward(false);

              setSubmitAck({
                open: true,
                title: isUpdate ? "Course Offerings Updated" : "Course Offerings Submitted",
                details: isUpdate
                  ? "Your updates were submitted for scheduling and the Office Manager will see the changes."
                  : "Your course offerings were submitted for scheduling and the Office Manager can now review them.",
              });
            } catch (e: any) {
              const detail = e?.response?.data?.detail;
              const msg = detail || e?.message || "Submit failed.";

              if (String(detail || "").toLowerCase().includes("comment is required")) {
                setForceRequireNote(true);
                throw new Error("Comment is required for updates after initial submission.");
              }

              throw new Error(msg);
            }
          }}
        />
      )}

      {/* --------------------------- Acknowledgement Modal --------------------------- */}
      {submitAck.open && (
        <AckModal
          open={submitAck.open}
          title={submitAck.title}
          details={submitAck.details}
          onClose={() => setSubmitAck({ open: false, title: "", details: "" })}
        />
      )}

      {/* --------------------------- Planning Review Modal --------------------------- */}
      {showPlanModal && data?.planning && hasPlanUpdates && (
        <PlanReviewModal
          changes={data.planning.pending_changes || []}
          courseIndex={{ ...planCourseIndex, ...extraCourseIndex }}  // ⟵ merged
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

      {/* NEW: Global Edit Course modal (for courses collection) */}
      {showEditCourseModal && user?.userId && (
        <GlobalCourseEditModal
          userId={user.userId}
          onClose={() => setShowEditCourseModal(false)}
          onSaved={async () => {
            await loadCurriculum();      // refresh curriculum/list of courses
            setShowEditCourseModal(false);
          }}
        />
      )}

      {editorState?.open && curr && (
        <ProgramCoursesEditor
          userId={user?.userId}
          programId={editorState.program_id!}
          programCode={editorState.program_code!}
          batchId={editorState.batch_id!}
          allItems={curr.items}
          onClose={() => setEditorState(null)}
          onChanged={async () => { await loadCurriculum(); setEditorState(null); }}
        />
      )}
      {showCreateCourseModal && (
        <CreateCourseModal
          departments={(curr?.departments || []).map(d => ({ id: d.department_id, name: d.department_name }))}
          onClose={() => setShowCreateCourseModal(false)}
          onCreated={async () => {
            setShowCreateCourseModal(false);
            // refresh curriculum options so newly created course appears in editor/suggestions
            await loadCurriculum();
          }}
        />
      )}

    </div>
  );
}

/* --------------------------- Small helper components --------------------------- */

const SubmitModal: React.FC<{
  onClose: () => void;
  onSubmit: (note: string) => void | Promise<void>;
  requireNote?: boolean;
}> = ({ onClose, onSubmit, requireNote = false }) => {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  const canSubmit = !busy && (!requireNote || note.trim().length > 0);

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full border-2 border-emerald-600 text-emerald-700">
          <Send className="h-8 w-8" strokeWidth={2.5} />
        </div>

        <h3 className="mb-2 text-center text-2xl font-semibold">Submit for Scheduling?</h3>

        <p className="mx-auto mb-4 max-w-md text-center text-sm text-neutral-600">
          {requireNote ? (
            <>
              You already submitted before. Please describe what changed so the{' '}
              <span className="font-semibold">Office Manager</span> knows what to review.
            </>
          ) : (
            <>
              This will send the current{' '}
              <span className="font-semibold">Course Offerings</span> to the Office Manager for scheduling.
            </>
          )}
        </p>

        {requireNote && (
          <div className="mb-4">
            <label className="mb-1 block text-sm font-semibold text-gray-700">Comment (required)</label>
            <textarea
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm min-h-[120px] shadow-sm focus:ring-2 focus:ring-emerald-500/30"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Describe what was added, edited, or deleted…"
            />
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200 disabled:opacity-50"
          >
            Cancel
          </button>

          <button
            disabled={!canSubmit}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onSubmit(note);
              } catch (e: any) {
                setError(e?.message || "Submit failed.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
};

const AckModal: React.FC<{
  open: boolean;
  title: string;
  details: string;
  onClose: () => void;
}> = ({ open, title, details, onClose }) =>
  !open ? null : (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full border-2 border-emerald-600 text-emerald-700">
          <Check className="h-8 w-8" strokeWidth={2.5} />
        </div>
        <h3 className="mb-2 text-center text-2xl font-semibold">{title}</h3>
        <p className="mx-auto mb-6 max-w-sm text-center text-sm text-neutral-600">{details}</p>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );

const PlanReviewModal: React.FC<{
  changes: PlanningChange[];
  onClose: () => void;
  onApprove: () => void | Promise<void>;
  courseIndex?: Record<string, { code: string; title: string }>;
}> = ({ changes, onClose, onApprove, courseIndex = {} }) => {
  const [busy, setBusy] = useState(false);
  const summary = useMemo(() => {
    const s = { total: changes.length, add: 0, increase: 0, reduce: 0 };
    for (const ch of changes as any[]) {
      if (ch?.type === "add_course_to_curriculum") s.add += 1;
      else if (ch?.type === "sections_increase") s.increase += 1;
      else if (ch?.type === "sections_decrease") s.reduce += 1;
    }
    return s;
  }, [changes]);
  return (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/50 p-3 sm:p-6">
      <div className="w-[95vw] max-w-[980px] max-h-[90vh] mt-4 sm:mt-8 rounded-2xl bg-white shadow-2xl border border-gray-200 flex flex-col overflow-hidden">
        {/* Header (high-visibility) */}
        <div className="bg-amber-600 text-white px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 grid h-10 w-10 place-items-center rounded-full bg-white/15">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-base sm:text-lg font-extrabold tracking-tight">
                Approval required — Planning updates are pending
              </div>
              <div className="mt-1 text-sm text-white/90">
                These changes were generated from Pre‑Enlistment and <span className="font-semibold">will not be applied</span> until you approve.
              </div>
            </div>
          </div>
        </div>

        {/* Summary */}
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-amber-950">
            <span className="inline-flex items-center rounded-full bg-amber-100 px-3 py-1 font-semibold">
              Total: {summary.total}
            </span>
            {summary.add > 0 && (
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 font-semibold text-emerald-800">
                Add: {summary.add}
              </span>
            )}
            {summary.increase > 0 && (
              <span className="inline-flex items-center rounded-full bg-blue-100 px-3 py-1 font-semibold text-blue-800">
                Increase: {summary.increase}
              </span>
            )}
            {summary.reduce > 0 && (
              <span className="inline-flex items-center rounded-full bg-rose-100 px-3 py-1 font-semibold text-rose-800">
                Reduce: {summary.reduce}
              </span>
            )}
            <span className="ml-auto text-xs text-amber-900">
              Tip: review the list below, then click <span className="font-semibold">Approve updates</span>.
            </span>
          </div>
        </div>

        <div className="flex-1 min-h-0 p-4 sm:p-5 overflow-auto">
          {changes.length === 0 ? (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-slate-700">
              No pending changes.
            </div>
          ) : (
            <ul className="space-y-3">
              {changes.map((ch: any, i: number) => {
              const codeForCourse = (id?: string) => {
                const key = String(id || "");
                const meta =
                  courseIndex[key] ||
                  courseIndex[key.toUpperCase()];
                const code = (meta?.code || "").trim();
                return code || key || "Unknown course";
              };

                const TypeBadge = ({ text }: { text: string }) => (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                    {text}
                  </span>
                );

                // ---- Friendly summaries for known change types ----
                let title = "Update";
                let details: Array<{ k: string; v: React.ReactNode }> = [];
                let badge = "Update";

                switch (ch.type) {
                  case "add_course_to_curriculum":
                    title = "Add course to curriculum";
                    badge = "Add";
                    details = [
                      { k: "Course code", v: codeForCourse(ch.course_id) },
                      { k: "Enlisted", v: ch.count ?? "—" },
                      ...(ch.target ? [{ k: "Target", v: String(ch.target) }] : []),
                    ];
                    break;

                  case "sections_increase":
                    title = "Increase sections";
                    badge = "Increase";
                    details = [
                      { k: "Course code", v: codeForCourse(ch.course_id) },
                      { k: "Sections +", v: typeof ch.by_sections === "number" ? ch.by_sections : "—" },
                    ];
                    break;

                  case "sections_decrease":
                    title = "Reduce sections";
                    badge = "Reduce";
                    details = [
                      { k: "Course code", v: codeForCourse(ch.course_id) },
                      { k: "Sections −", v: typeof ch.by_sections === "number" ? ch.by_sections : "—" },
                    ];
                    break;


                  default:
                    // Unknown type: still show readable blocks, with optional raw toggle
                    title = (String(ch.type || "Update").replace(/_/g, " "));
                    badge = "Update";
                    details = Object.keys(ch)
                      .filter(k => k !== "type")
                      .map(k => ({ k, v: String(ch[k]) }));
                    break;
                }

                return (
                  <li key={i} className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-semibold text-slate-800">{title}</div>
                      <TypeBadge text={badge} />
                    </div>

                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                      {details.map((d, idx) => (
                        <div key={idx}>
                          <div className="text-xs uppercase text-gray-500">{d.k}</div>
                          <div className="font-medium text-slate-900 break-words">{d.v}</div>
                        </div>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2 border-t px-5 py-4">
          <button
            className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm font-medium hover:bg-neutral-200"
            onClick={onClose}
            disabled={busy}
          >
            Not now
          </button>
          <button
            disabled={busy || changes.length === 0}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-extrabold text-white shadow-sm hover:brightness-110 disabled:opacity-50"
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
            Approve updates
          </button>
        </div>
      </div>
    </div>
  );
};
type GlobalCourseEditModalProps = {
  userId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
};

const GlobalCourseEditModal: React.FC<GlobalCourseEditModalProps> = ({
  userId,
  onClose,
  onSaved,
}) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CourseCatalogItem[]>([]);
  const [loading, setLoading] = useState(false);

  const [selected, setSelected] = useState<CourseCatalogItem | null>(null);
  const [codeInputs, setCodeInputs] = useState<string[]>([""]);
  const [title, setTitle] = useState("");
  const [unitsText, setUnitsText] = useState("");

  const [saving, setSaving] = useState(false);
  const requestIdRef = useRef(0);

  // helpers for multi-code input UI
  const setCodeAt = (index: number, value: string) => {
    setCodeInputs((prev) => {
      const next = [...prev];
      next[index] = value.toUpperCase();
      return next;
    });
  };

  const addCodeRow = () => {
    setCodeInputs((prev) => [...prev, ""]);
  };

  const removeCodeRow = (index: number) => {
    setCodeInputs((prev) => prev.filter((_, i) => i !== index));
  };


  // Debounced search in the global course catalog
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }

    const myId = ++requestIdRef.current;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const resp = await searchCourseCatalog(userId, { q, limit: 100 });
        const arr = Array.isArray((resp as any)?.results) ? (resp as any).results : [];
        if (myId === requestIdRef.current) {
          setResults(arr);
        }
      } catch {
        if (myId === requestIdRef.current) {
          setResults([]);
        }
      } finally {
        if (myId === requestIdRef.current) {
          setLoading(false);
        }
      }
    }, 300);

    return () => clearTimeout(t);
  }, [query, userId]);

  const pickCourse = (c: CourseCatalogItem) => {
    setSelected(c);

    const codesArr = Array.isArray(c.course_code)
      ? (c.course_code as any[])
          .map((x) => String(x || ""))
          .filter(Boolean)
      : [String(c.course_code || "")].filter(Boolean);

    // Put each code into its own row
    setCodeInputs(codesArr.length ? codesArr : [""]);

    setTitle(c.course_title || "");
    setUnitsText(typeof c.units === "number" ? String(c.units) : "");
  };

  const save = async () => {
    if (!selected) {
      alert("Please select a course first.");
      return;
    }

    // normalize each input separately; ignore empty rows
    const codes = codeInputs
      .map((s) => normCode(s))
      .filter(Boolean);

    if (!codes.length) {
      alert("Please enter at least one course code.");
      return;
    }

    const t = title.trim();
    if (!t) {
      alert("Please enter a course title.");
      return;
    }

    const u = unitsText.trim();
    const units = u === "" ? null : Number(u);
    if (u !== "" && Number.isNaN(units as number)) {
      alert("Units must be a number.");
      return;
    }

    setSaving(true);
    try {
      const res = await editCatalogCourse(userId, {
        course_id: selected.course_id,
        course_code: codes,      // will be saved as array in DB
        course_title: t,
        units,
      });

      if ((res as any)?.ok === false) {
        alert((res as any)?.message || "Failed to update course.");
      } else {
        await onSaved();
      }
    } catch (e: any) {
      alert(e?.message || "Failed to update course.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-4xl rounded-xl bg-white shadow-xl border border-gray-200">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="font-semibold">Edit Global Course</div>
          <button className="rounded-md border px-3 py-1.5 text-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
          {/* LEFT: search & pick a course */}
          <div className="rounded-lg border">
            <div className="px-3 py-2 bg-gray-50 font-semibold text-sm">Search course</div>
            <div className="p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Type code or title (min 2 characters)…"
                  className={cls(SOFT_INPUT, "pl-9")}
                />
              </div>
            </div>
            <div className="max-h-[50vh] overflow-auto divide-y">
              {loading && (
                <div className="p-3 text-sm text-neutral-500">Searching…</div>
              )}
              {!loading && query.trim().length >= 2 && results.length === 0 && (
                <div className="p-3 text-sm text-neutral-500">No courses found.</div>
              )}
              {!loading &&
                results.map((c) => {
                  const codeText = Array.isArray(c.course_code)
                    ? String((c.course_code as any[])[0] ?? "")
                    : String(c.course_code ?? "");
                  const isActive = selected && selected.course_id === c.course_id;

                  return (
                    <button
                      key={c.course_id}
                      type="button"
                      onClick={() => pickCourse(c)}
                      className={cls(
                        "w-full text-left px-3 py-2 text-sm",
                        isActive ? "bg-emerald-50" : "bg-white"
                      )}
                    >
                      <div className="font-semibold text-emerald-700">{codeText}</div>
                      <div className="text-[11px] text-neutral-600 truncate">
                        {c.course_title}
                      </div>
                    </button>
                  );
                })}
            </div>
          </div>

          {/* RIGHT: edit details */}
          <div className="rounded-lg border">
            <div className="px-3 py-2 bg-gray-50 font-semibold text-sm">Details</div>
            <div className="p-3 space-y-3">
              {!selected && (
                <div className="text-sm text-neutral-500">
                  Select a course on the left to edit its codes, title, and units.
                </div>
              )}

              {selected && (
                <>
                  <div>
                    <label className="text-xs font-medium text-slate-700 mb-1 block">
                      Course Codes (multiple allowed)
                    </label>

                    {codeInputs.map((code, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-2 mb-2"
                      >
                        <input
                          className={cls(SOFT_INPUT, "flex-1")}
                          value={code}
                          onChange={(e) => setCodeAt(idx, e.target.value)}
                          placeholder={idx === 0 ? "e.g. CCPROG1" : "Alternative code"}
                        />
                        {codeInputs.length > 1 && (
                          <button
                            type="button"
                            className="rounded-md border px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                            onClick={() => removeCodeRow(idx)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}

                    <button
                      type="button"
                      className="mt-1 text-xs font-medium text-emerald-700 hover:underline"
                      onClick={addCodeRow}
                    >
                      + Add another code
                    </button>

                    <p className="mt-1 text-[11px] text-slate-500">
                      Each row will be saved as a separate entry in the{" "}
                      <code>course_code</code> array in the database.
                    </p>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-700 mb-1 block">
                      Course Title
                    </label>
                    <input
                      className={SOFT_INPUT}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Course title"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-700 mb-1 block">
                      Units
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      className={SOFT_INPUT}
                      value={unitsText}
                      onChange={(e) => setUnitsText(e.target.value)}
                      placeholder="3"
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button className="rounded-md border px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            disabled={saving || !selected}
            className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            onClick={save}
          >
            <Check className="inline-block h-4 w-4 mr-1 align-[-2px]" />
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
};

type ProgramCoursesEditorProps = {
  userId?: string;
  programId: string;
  programCode: string;
  batchId: string;
  allItems: CurriculumItem[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
};

const ProgramCoursesEditor: React.FC<ProgramCoursesEditorProps> = ({
  userId,
  programId,
  programCode,
  batchId,
  allItems,
  onClose,
  onChanged,
}) => {
  // Build a merged “base” curriculum entry (program+batch)
  const base = useMemo(() => {
    const merged: CurriculumItem = {
      program_id: programId,
      program_code: programCode,
      department_id: "",
      department_name: "",
      batch_id: batchId,
      batch_code: "",
      courses: [],
    };
    (allItems || []).forEach((i) => {
      if (i.program_id === programId && i.batch_id === batchId) {
        merged.department_id ||= i.department_id;
        merged.department_name ||= i.department_name || "";
        merged.batch_code ||= i.batch_code;
        merged.courses.push(...i.courses);
      }
    });
    const seen = new Set<string>();
    merged.courses = merged.courses
      .filter((c) => (seen.has(c.course_id) ? false : (seen.add(c.course_id), true)))
      .sort((a, b) => a.code.localeCompare(b.code));
    return merged;
  }, [programId, batchId, programCode, allItems]);

  const [current, setCurrent] = useState(base.courses);
  const currentIds = useMemo(() => new Set(current.map((c) => c.course_id)), [current]);

const [query, setQuery] = useState("");
const [results, setResults] = useState<CourseCatalogItem[]>([]);
const [suggestions, setSuggestions] = useState<CourseCatalogItem[]>([]);
const [busy, setBusy] = useState(false);

// NEW: protect against stale responses + show stable UI while searching
const requestIdRef = useRef(0);
const [loadingSearch, setLoadingSearch] = useState(false);
// --- robust filtering for code/title, ignoring case/space/dashes ---
const norm = (s?: string) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/-/g, "");

const filterCatalog = (arr: CourseCatalogItem[], q: string) => {
  const nq = norm(q);
  if (!nq) return arr;
  return (arr || []).filter((r) =>
    norm(String(r.course_code)).includes(nq) ||
    norm(r.course_title).includes(nq)
  );
};

  // Initial suggestions (wildcard search → fallback to curriculum options)
  useEffect(() => {
    (async () => {
      if (!userId) return;
      let out: any[] = [];
      try {
        const r = await searchCourseCatalog(userId, { q: "*", limit: 500 });
        out = Array.isArray(r?.results) ? r.results : [];
      } catch {}
      if (!out.length) {
        // fallback: reuse curriculum options
        const resp: any = await getApoCourseOfferings(userId, { view: "curriculum" });
        const opts: any[] = resp?.course_options_by_program?.[programId] || [];
        out = opts.map((o) => ({
          course_id: o.course_id,
          course_code: o.course_code,
          course_title: o.course_title,
          department_id: o.department_id,
          units: o.units,
          program_level: o.program_level,
        }));
      }
      setSuggestions(out);
    })();
  }, [userId, programId]);

  // Debounced live search (only if 2+ chars)
  useEffect(() => {
    const q = query.trim();
    const myId = ++requestIdRef.current;
    const t = setTimeout(async () => {
      if (!userId) return;
      if (q.length < 2) {
        if (myId === requestIdRef.current) setResults([]);
        return;
      }
      setLoadingSearch(true);
      try {
        const resp = await searchCourseCatalog(userId, { q, limit: 500 });
        const arr = Array.isArray((resp as any)?.results) ? (resp as any).results : [];
        if (myId === requestIdRef.current) setResults(arr);
        setResults(arr);
      } catch {
        if (myId === requestIdRef.current) setResults([]);
      } finally {
        if (myId === requestIdRef.current) setLoadingSearch(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, userId]);

const source = results.length ? results : suggestions;
const list = filterCatalog(source, query);
const noMatches = query.trim().length >= 2 && list.length === 0;


  const adds = useMemo(() => {
    const baseIds = new Set(base.courses.map((c) => c.course_id));
    return current.filter((c) => !baseIds.has(c.course_id));
  }, [base.courses, current]);

  const removes = useMemo(() => {
    const nowIds = new Set(current.map((c) => c.course_id));
    return base.courses.filter((c) => !nowIds.has(c.course_id));
  }, [base.courses, current]);

  const save = async () => {
    if (!userId) return;
    setBusy(true);
    try {
      for (const r of removes) {
        await curriculumRemoveCourse(userId, {
          program_id: programId,
          batch_id: batchId,
          course_id: r.course_id,
        } as any);
      }
      for (const a of adds) {
        await curriculumAddCourse(userId, {
          program_id: programId,
          batch_id: batchId,
          course_id: a.course_id,
        } as any);
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-5xl rounded-xl bg-white shadow-xl border border-gray-200">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="font-semibold">
            Edit Courses to Take — {programCode} • {base.batch_code || "ID"}
          </div>
          <button className="rounded-md border px-3 py-1.5 text-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
          {/* Current courses */}
          <div className="rounded-lg border">
            <div className="px-3 py-2 bg-gray-50 font-semibold">Current courses</div>
            <div className="max-h-[60vh] overflow-auto divide-y">
              {current.length === 0 && <div className="p-3 text-sm text-neutral-500">No courses.</div>}
              {current.map((c) => (
                <div key={c.course_id} className="p-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-emerald-700">{c.code}</div>
                    <div className="text-[11px] text-neutral-600 truncate" title={c.title}>
                      {c.title}
                    </div>
                  </div>
                  <button
                    className="text-red-600 hover:text-red-800"
                    title="Remove"
                    onClick={() => setCurrent((prev) => prev.filter((x) => x.course_id !== c.course_id))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Global catalog search */}
          <div className="rounded-lg border">
            <div className="px-3 py-2 bg-gray-50 font-semibold">Add from catalog</div>
            <div className="p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Type code or title to search all courses…"
                  className={cls(SOFT_INPUT, "pl-9")}
                />
              </div>
            </div>

            <div className="max-h-[52vh] overflow-auto divide-y">
              {loadingSearch && (
                <div className="p-3 text-sm text-neutral-500">Searching…</div>
              )}
              {!loadingSearch && noMatches && (
                <div className="p-3 text-sm text-neutral-500">
                  No matches for “{query.trim()}”.
                </div>
              )}
              {!loadingSearch && list.map((r) => {
                    const inCurr = currentIds.has(r.course_id);
                    return (
                  <div key={r.course_id} className="p-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-emerald-700">{String(r.course_code)}</div>
                      <div className="text-[11px] text-neutral-600 truncate" title={r.course_title}>
                        {r.course_title}
                      </div>
                    </div>
                    <button
                      disabled={inCurr}
                      className={`rounded-md border px-2 py-1 text-sm ${inCurr ? "opacity-50" : "text-emerald-700"}`}
                      onClick={() => {
                        if (inCurr) return;
                        setCurrent((prev) => [
                          ...prev,
                          {
                            course_id: r.course_id,
                            code: String(r.course_code),
                            title: r.course_title,
                            department_id: r.department_id || base.department_id,
                            units: typeof r.units === "number" ? r.units : null,
                            program_level: r.program_level || "",
                            source: "DB",
                          },
                        ]);
                      }}
                    >
                      {inCurr ? "Added" : "Add"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button className="rounded-md border px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            disabled={busy || (adds.length === 0 && removes.length === 0)}
            className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            onClick={save}
          >
            <Check className="inline-block h-4 w-4 mr-1 align-[-2px]" />
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
};
/* ==== CREATE COURSE MODAL (fixed + SelectBox dropdowns) ==== */
const CreateCourseModal: React.FC<{
  departments: { id: string; name: string }[];
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}> = ({ departments, onClose, onCreated }) => {
  // Show names in the SelectBox; map back to id on save
  const [deptName, setDeptName] = useState<string>(departments[0]?.name || "");

  // Exact UI labels you want
  const LEVEL_LABELS = ["Undergraduate", "Graduate Studies"] as const;
  type LevelLabel = (typeof LEVEL_LABELS)[number];
  const [level, setLevel] = useState<LevelLabel>("Undergraduate");

  const TYPE_OF_OPTIONS = ["GE", "Major", "Foundation", "Elective", "Elective Course", "SHS"] as const;
  type TypeOf = (typeof TYPE_OF_OPTIONS)[number];
  const [typeOf, setTypeOf] = useState<TypeOf>("Elective Course");

  const ROOM_TYPES = ["Classroom", "Comlab"] as const;
  type RoomType = (typeof ROOM_TYPES)[number];
  const [roomType, setRoomType] = useState<RoomType>("Classroom");

  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [units, setUnits] = useState<string>("");
  const [desc, setDesc] = useState("");
  const [capacity, setCapacity] = useState<string>("");
  const [minEnroll, setMinEnroll] = useState<string>("");

  const [busy, setBusy] = useState(false);

  const user = useMemo(() => {
    const raw = localStorage.getItem("animo.user");
    return raw ? JSON.parse(raw) : null;
  }, []);

  // Resolve selected department id
  const deptId = useMemo(
    () => departments.find((d) => d.name === deptName)?.id || departments[0]?.id || "",
    [departments, deptName]
  );

  const canSave = !!deptId && !!level && !!code.trim() && !!title.trim();

  const save = async () => {
    if (!user?.userId || !canSave) return;
    setBusy(true);
    try {
      // Map UI label -> API code
      const levelCode = (level === "Graduate Studies" ? "GS" : "UGS") as "UGS" | "GS";

      const payload: CreateCoursePayload = {
        department_id: deptId,
        program_level: levelCode,                 // <-- FIXED (type-safe)
        course_code: code.trim().toUpperCase(),
        course_title: title.trim(),
        units: units === "" ? null : Number(units),
        type_of_course: (typeOf || null) as string | null,
        description: desc || "",
        room_type: (roomType || null) as string | null,
        capacity: capacity === "" ? null : Number(capacity),   // max_enrollee equivalent
        min_enrollee: minEnroll === "" ? null : Number(minEnroll),
      };

      const res = await createCatalogCourse(user.userId, payload);
      if (res?.ok) {
        alert(`Course ${payload.course_code} created (course_id: ${res.course?.course_id || "new"})`);
        await onCreated();
      } else {
        alert(res?.message || "Failed to create course.");
      }
    } catch (e: any) {
      alert(e?.message || "Failed to create course.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl border border-gray-200">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="font-semibold">Add Course (Global Catalog)</div>
          <button className="rounded-md border px-3 py-1.5 text-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Department (SelectBox) */}
          <div className="md:col-span-1">
            <label className="text-xs font-medium text-slate-700 mb-1 block">Department</label>
            <SelectBox
              value={deptName || "— Select —"}
              onChange={(v: string) => setDeptName(v)}
              options={departments.length ? departments.map((d) => d.name) : ["— Select —"]}
              className="w-full"
            />
          </div>

          {/* Program Level (SelectBox) */}
          <div className="md:col-span-1">
            <label className="text-xs font-medium text-slate-700 mb-1 block">Program Level</label>
            <SelectBox
              value={level}
              onChange={(v: string) => setLevel(v as LevelLabel)}
              options={[...LEVEL_LABELS]}
              className="w-full"
            />
          </div>

          {/* Course Code */}
          <div>
            <label className="text-xs font-medium text-slate-700">Course Code</label>
            <input
              className={SOFT_INPUT}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder=" "
            />
          </div>

          {/* Course Title */}
          <div>
            <label className="text-xs font-medium text-slate-700">Course Title</label>
            <input
              className={SOFT_INPUT}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Course title"
            />
          </div>

          {/* Units */}
          <div>
            <label className="text-xs font-medium text-slate-700">Units</label>
            <input
              type="number"
              step="0.5"
              className={SOFT_INPUT}
              value={units}
              onChange={(e) => setUnits(e.target.value)}
              placeholder="3"
            />
          </div>

          {/* Type of Course (SelectBox) */}
          <div>
            <label className="text-xs font-medium text-slate-700 mb-1 block">Type of Course</label>
            <SelectBox
              value={typeOf}
              onChange={(v: string) => setTypeOf(v as TypeOf)}
              options={[...TYPE_OF_OPTIONS]}
              className="w-full"
            />
          </div>

          {/* Room Type (SelectBox) */}
          <div>
            <label className="text-xs font-medium text-slate-700 mb-1 block">Room Type</label>
            <SelectBox
              value={roomType}
              onChange={(v: string) => setRoomType(v as RoomType)}
              options={[...ROOM_TYPES]}
              className="w-full"
            />
          </div>

          {/* Capacity */}
          <div>
            <label className="text-xs font-medium text-slate-700">Capacity (max enrollees)</label>
            <input
              type="number"
              className={SOFT_INPUT}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              placeholder="45"
            />
          </div>

          {/* Min Enrollees */}
          <div>
            <label className="text-xs font-medium text-slate-700">Min Enrollees (optional)</label>
            <input
              type="number"
              className={SOFT_INPUT}
              value={minEnroll}
              onChange={(e) => setMinEnroll(e.target.value)}
            />
          </div>

          {/* Description */}
          <div className="md:col-span-2">
            <label className="text-xs font-medium text-slate-700">Description</label>
            <textarea
              className={cls(SOFT_INPUT, "min-h-[96px]")}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="Optional description…"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button className="rounded-md border px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            disabled={!canSave || busy}
            className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            onClick={save}
          >
            Create Course
          </button>
        </div>
      </div>
    </div>
  );
};
