import React, { useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import AppShell from "../../base/AppShell";
import { runOmAutoAssign } from "../../api.ts";
import { submitOmLoadAssignment } from "../../api.ts";

import {
  getOmLoadAssignmentList,
  getOmLoadAssignmentProfile,
  getAllFaculty,
} from "../../api";

import { cls } from "../../utilities/cls";
import {
  ChevronDown,
  Search as SearchIcon,
  Play,
  RefreshCcw,
  Send,
  Save,
  CheckCheck,
  Plus,
  MessageSquareText,
  Check,
  Trash2,
  X,
} from "lucide-react";
import { InboxContent as OMInboxContent } from "./OM_Inbox";

export type FlagSeverity = "warning" | "error";

export type RowFlagType =
  | "KAC_MISMATCH"
  | "SCHEDULE_PREF_MISMATCH"
  | "DOUBLE_BOOKED"
  | "MODE_MISMATCH"
  | "INCOMPLETE_ROW"
  | "DAY_MISMATCH"
  | "TIME_MISMATCH"
  | "GS_NO_PHD"
  | "GE_BLOCKED_SLOT";

export interface RowFlag {
  type: RowFlagType;
  severity: FlagSeverity;
  message: string;
}

export type RowFlagsById = Record<string, RowFlag[]>;

interface FacultyPref {
  day: string;
  begin: number;
  end: number;
}

interface ValidationContext {
  courseToKac: Record<string, string>; // course_id → kac_id
  facultyToKacs: Record<string, string[]>; // faculty_id → allowed kac_ids

  facultyPrefWindows: Record<string, FacultyPref[]>; // faculty_id → time windows
  facultyAllowedModes: Record<string, string[]>; // faculty_id → ["F2F","HYB","FOL"]

  // optional: section/course allowed modes if different
  courseAllowedModes?: Record<string, string[]>;

  courseProgramLevel?: Record<string, string>;
  facultyHasPhd?: Record<string, boolean>;

  sectionCampus?: Record<string, string>;
  sectionCourse?: Record<string, string>;
  courseTypeOfCourse?: Record<string, string>;

  campusNames?: Record<string, string>;
}

/* ---------------- Small inputs ---------------- */
function SelectBox({
  value,
  onChange,
  options,
  placeholder = "— Select —",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<number>(() =>
    Math.max(
      0,
      options.findIndex((o) => o === value)
    )
  );

  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !btnRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className={cls("relative min-w-[120px]", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cls(
          "w-full rounded-md border border-gray-300 bg-white",
          "px-1.5 py-1 text-center text-[13px] leading-tight",
          "shadow-sm focus:ring-2 focus:ring-emerald-500/30"
        )}
      >
        {value || <span className="text-gray-400">{placeholder}</span>}
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2" />
      </button>

      {open && (
        <div
          ref={listRef}
          className="absolute z-20 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-gray-300 bg-white shadow-xl"
        >
          {options.map((opt, i) => (
            <button
              key={opt}
              onMouseEnter={() => setHover(i)}
              onClick={() => {
                onChange(opt);
                setOpen(false);
                btnRef.current?.focus();
              }}
              className={cls(
                "block w-full px-4 py-2 text-left text-sm",
                i === hover && "bg-emerald-50",
                value === opt && "bg-emerald-100 text-emerald-800 font-medium"
              )}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TextBox({
  value,
  onChange,
  placeholder = "",
  className = "",
  disabled = false,
  align = "left",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  align?: "left" | "center";
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={cls(
        "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm",
        "focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none transition",
        "placeholder-gray-400",
        align === "center" && "text-center",
        disabled && "cursor-not-allowed bg-gray-100 text-gray-400 opacity-70",
        className
      )}
    />
  );
}

/* --------- Searchable + typeable ComboBox (for Faculty) --------- */
function ComboBox({
  value,
  onChange,
  options,
  placeholder = "— Select or type —",
  className = "",
}: {
  value?: string | null;
  onChange: (v: string) => void;
  options?: (string | null | undefined)[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value ?? "");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => setQuery(value ?? ""), [value]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = useMemo(() => {
    const safeOptions = (options ?? []).map((o) => (o ?? "").toString());
    const q = (query ?? "").trim().toLowerCase();

    // If no search text, show everything
    if (!q) return safeOptions;

    const matches = safeOptions.filter((o) => o.toLowerCase().includes(q));

    // If nothing matches the current text (like "Sahur, Thung"),
    // fall back to showing all options instead of "No matches"
    return matches.length > 0 ? matches : safeOptions;
  }, [options, query]);

  return (
    <div ref={wrapRef} className={cls("relative", className)}>
      <input
        className="w-full rounded-lg border border-gray-300 px-3 py-2 pr-8 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
        value={query ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          setQuery(v);
          setOpen(true);
          onChange(v);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
      />
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />

      {open && (
        <div className="absolute z-30 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-gray-300 bg-white shadow-xl">
          {filtered.length === 0 ? (
            <div className="px-4 py-2 text-sm text-gray-500">
              No matches{" "}
              {(options?.length ?? 0) === 0 && " (no faculty loaded)"}
            </div>
          ) : (
            filtered.map((opt) => (
              <button
                key={opt}
                onClick={() => {
                  onChange(opt);
                  setQuery(opt);
                  setOpen(false);
                }}
                className="block w-full px-4 py-2 text-left text-sm hover:bg-emerald-50"
              >
                {opt || "—"}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
/* ---------------- Types + helpers ---------------- */
type Row = {
  id: string;
  selected?: boolean;
  course_id?: string;
  course: string;
  title: string;
  units: number | "";
  section: string;
  faculty: string;
  faculty_id?: string;
  day1: string;
  begin1: string;
  end1: string;
  room1: string;
  day2: string;
  begin2: string;
  end2: string;
  room2: string;
  capacity: number | "";
  mode?: string;
  status?: "" | "Confirmed" | "Pending" | "Unassigned" | "Conflict";
  conflictNote?: string;
  editable?: boolean;
  campus_id?: string;
};

// --- Validation helpers & engine (row-level flags) ---

function checkKacMismatch(row: Row, ctx: ValidationContext): RowFlag | null {
  if (!row.faculty_id) return null;

  // Prefer course_id (from backend), fall back to course code if needed
  const courseKey = (row as any).course_id || row.course;
  if (!courseKey) return null;

  const courseKac = ctx.courseToKac[courseKey];
  const allowedKacs = ctx.facultyToKacs[row.faculty_id] || [];

  if (courseKac && !allowedKacs.includes(courseKac)) {
    return {
      type: "KAC_MISMATCH",
      severity: "error",
      message:
        "KAC mismatch: this course is outside the faculty’s KAC cluster.",
    };
  }
  return null;
}

function checkDayMismatch(row: Row, ctx: ValidationContext): RowFlag | null {
  const fid = row.faculty_id;
  if (!fid) return null;

  const prefs = ctx.facultyPrefWindows[fid] || [];
  if (!prefs.length) return null;

  const allowedDays = new Set(prefs.map((p) => p.day.toUpperCase()));

  const days = [
    (row.day1 || "").toUpperCase(),
    (row.day2 || "").toUpperCase(),
  ].filter(Boolean);

  for (const d of days) {
    if (!allowedDays.has(d)) {
      return {
        type: "DAY_MISMATCH",
        severity: "warning", // or "error" if you prefer
        message: `Faculty is not available on ${d}.`,
      };
    }
  }

  return null;
}

function checkTimeMismatch(row: Row, ctx: ValidationContext): RowFlag | null {
  const fid = row.faculty_id;
  if (!fid) return null;

  const prefs = ctx.facultyPrefWindows[fid] || [];
  if (!prefs.length) return null;

  const toMin = (t?: string): number | null => {
    if (!t) return null;
    const s = t.trim();
    const hh = s.length === 3 ? s.slice(0, 1) : s.slice(0, 2);
    const mm = s.slice(-2);
    const h = Number(hh);
    const m = Number(mm);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  };

  type Meet = { day: string; b: number; e: number };
  const meets: Meet[] = [];

  const add = (d?: string, b?: string, e?: string) => {
    const day = (d || "").toUpperCase();
    const bb = toMin(b);
    const ee = toMin(e);
    if (!day || bb == null || ee == null || ee <= bb) return;
    meets.push({ day, b: bb, e: ee });
  };

  add(row.day1, row.begin1, row.end1);
  add(row.day2, row.begin2, row.end2);

  for (const m of meets) {
    const sameDayPrefs = prefs.filter((p) => p.day === m.day);
    if (!sameDayPrefs.length) continue; // day mismatch covered separately

    const ok = sameDayPrefs.some((p) => p.begin <= m.b && p.end >= m.e);

    if (!ok) {
      return {
        type: "TIME_MISMATCH",
        severity: "warning",
        message: `Time ${m.day} ${row.begin1}-${row.end1} is outside preferred windows.`,
      };
    }
  }

  return null;
}

function checkModeMismatch(row: Row, ctx: ValidationContext): RowFlag | null {
  const fid = row.faculty_id;
  const rowMode = (row.mode || "").trim().toUpperCase();
  if (!fid || !rowMode) return null;

  const allowed = ctx.facultyAllowedModes[fid] || [];
  if (!allowed.length) return null;

  const allowedUpper = allowed.map((m) => (m || "").trim().toUpperCase());
  if (allowedUpper.includes(rowMode)) return null;

  return {
    type: "MODE_MISMATCH",
    severity: "error",
    message: `Mode mismatch: faculty prefers ${allowed.join(
      ", "
    )} but this section is set to ${rowMode}.`,
  };
}

function checkIncompleteRow(row: Row): RowFlag | null {
  const hasAnyData =
    !!row.faculty ||
    !!row.faculty_id ||
    !!row.day1 ||
    !!row.begin1 ||
    !!row.end1 ||
    !!row.day2 ||
    !!row.begin2 ||
    !!row.end2 ||
    !!row.mode;

  if (!hasAnyData) return null;

  const missingCore =
    !row.section ||
    !row.faculty ||
    !row.mode ||
    !row.day1 ||
    !row.begin1 ||
    !row.end1;

  const hasAnyMeet2 = !!row.day2 || !!row.begin2 || !!row.end2;
  const missingMeet2 = hasAnyMeet2 && (!row.day2 || !row.begin2 || !row.end2);

  if (!missingCore && !missingMeet2) return null;

  return {
    type: "INCOMPLETE_ROW",
    severity: "warning",
    message: "Row is incomplete: please fill required fields before approval.",
  };
}

function checkGsNoPhd(row: Row, ctx: ValidationContext): RowFlag | null {
  const cid = row.course;
  const fid = row.faculty_id;
  if (!cid || !fid) return null;

  const levelMap = ctx.courseProgramLevel || {};
  const level = (levelMap[cid] || "").toUpperCase();

  if (level !== "GS") return null; // only care about GS courses

  const phdMap = ctx.facultyHasPhd || {};
  const hasPhd = !!phdMap[fid];

  if (hasPhd) return null;

  return {
    type: "GS_NO_PHD",
    severity: "error",
    message:
      "Graduate School (GS) sections must be handled by PhD-certified faculty.",
  };
}

function checkGeBlockedSlots(
  rows: Row[],
  ctx: ValidationContext
): RowFlagsById {
  const result: RowFlagsById = {};

  const sectionCampus = ctx.sectionCampus || {};
  const sectionCourse = ctx.sectionCourse || {};
  const courseType = ctx.courseTypeOfCourse || {};

  type BlockOwner = {
    rowId: string;
    label: string; // e.g., "CCPROG1 S11"
  };

  // key = "DAY|BEGIN|END" => owner (GE @ CMPS0002 row)
  const blocked: Record<string, BlockOwner> = {};

  const makeKey = (
    day?: string,
    begin?: string,
    end?: string
  ): string | null => {
    const d = (day || "").trim().toUpperCase();
    const b = (begin || "").trim();
    const e = (end || "").trim();
    if (!d || !b || !e) return null;
    return `${d}|${b}|${e}`;
  };

  // 1) First pass: record all GE @ CMPS0002 slots as "blocked"
  for (const row of rows) {
    const sid = row.id;
    if (!sid) continue;

    const campus = (sectionCampus[sid] || "").toUpperCase();
    if (campus !== "CMPS0002") continue;

    const cid = sectionCourse[sid];
    const toc = (courseType[cid] || "").toUpperCase();
    if (toc !== "GE") continue; // only GE courses create blocked slots

    const label = `${row.course || "?"} ${row.section || ""}`.trim();

    const k1 = makeKey(row.day1, row.begin1, row.end1);
    if (k1) blocked[k1] = { rowId: sid, label };

    const k2 = makeKey(row.day2, row.begin2, row.end2);
    if (k2) blocked[k2] = { rowId: sid, label };
  }

  if (Object.keys(blocked).length === 0) return result;

  // 2) Second pass: for ALL CMPS0002 rows, if they use a blocked slot from another section → flag
  for (const row of rows) {
    const sid = row.id;
    if (!sid) continue;

    const campus = (sectionCampus[sid] || "").toUpperCase();
    if (campus !== "CMPS0002") continue; // only CMPS0002 rows are affected

    const rowFlags: RowFlag[] = [];

    const checkSlot = (day?: string, begin?: string, end?: string) => {
      const key = makeKey(day, begin, end);
      if (!key) return;

      const owner = blocked[key];
      if (!owner) return;
      if (owner.rowId === sid) return; // it's the same GE section, allowed

      rowFlags.push({
        type: "GE_BLOCKED_SLOT",
        severity: "error",
        message: `This CMPS0002 schedule uses a GE-reserved slot also used by ${owner.label}.`,
      });
    };

    checkSlot(row.day1, row.begin1, row.end1);
    checkSlot(row.day2, row.begin2, row.end2);

    if (rowFlags.length > 0) {
      result[sid] = (result[sid] || []).concat(rowFlags);
    }
  }

  return result;
}

function checkDoubleBookings(rows: Row[]): RowFlagsById {
  const result: RowFlagsById = {};

  // key = faculty_id|day|begin|end  → list of rowIds
  const slotMap: Record<string, string[]> = {};

  for (const row of rows) {
    const fid = row.faculty_id;
    if (!fid) continue;

    const slots = [
      { day: row.day1, begin: row.begin1, end: row.end1 },
      { day: row.day2, begin: row.begin2, end: row.end2 },
    ];

    for (const s of slots) {
      const day = (s.day || "").trim();
      const begin = (s.begin || "").trim();
      const end = (s.end || "").trim();
      if (!day || !begin || !end) continue;

      const key = `${fid}|${day}|${begin}|${end}`;
      if (!slotMap[key]) slotMap[key] = [];
      slotMap[key].push(row.id);
    }
  }

  for (const [key, rowIds] of Object.entries(slotMap)) {
    if (rowIds.length <= 1) continue; // no conflict

    const [, day, begin, end] = key.split("|");
    const msg = `Schedule conflict: faculty has multiple sections on ${day} at ${begin}-${end}.`;

    for (const rowId of rowIds) {
      if (!result[rowId]) result[rowId] = [];
      result[rowId].push({
        type: "DOUBLE_BOOKED",
        severity: "error",
        message: msg,
      });
    }
  }

  return result;
}

function validateAllRows(rows: Row[], ctx: ValidationContext): RowFlagsById {
  const flags: RowFlagsById = {};

  // 1) group by faculty for cross-row checks
  const rowsByFaculty: Record<string, Row[]> = {};
  for (const row of rows) {
    const fid = row.faculty_id;
    if (!fid) continue;
    if (!rowsByFaculty[fid]) rowsByFaculty[fid] = [];
    rowsByFaculty[fid].push(row);
  }

  // 2) per-row checks
  for (const row of rows) {
    const rowFlags: RowFlag[] = [];

    const kacFlag = checkKacMismatch(row, ctx);
    if (kacFlag) rowFlags.push(kacFlag);

    const dayFlag = checkDayMismatch(row, ctx);
    if (dayFlag) rowFlags.push(dayFlag);

    const timeFlag = checkTimeMismatch(row, ctx);
    if (timeFlag) rowFlags.push(timeFlag);

    const modeFlag = checkModeMismatch(row, ctx);
    if (modeFlag) rowFlags.push(modeFlag);

    const incompleteFlag = checkIncompleteRow(row);
    if (incompleteFlag) rowFlags.push(incompleteFlag);

    const gsFlag = checkGsNoPhd(row, ctx);
    if (gsFlag) rowFlags.push(gsFlag);

    if (rowFlags.length > 0) {
      flags[row.id] = rowFlags;
    }
  }

  // 3) cross-row: same faculty double-booked (exact day/time match)
  const doubleBookedFlags = checkDoubleBookings(rows);
  for (const [rowId, conflictFlags] of Object.entries(doubleBookedFlags)) {
    if (!flags[rowId]) flags[rowId] = [];
    flags[rowId].push(...conflictFlags);
  }

  for (const [rowId, conflictFlags] of Object.entries(doubleBookedFlags)) {
    if (!flags[rowId]) flags[rowId] = [];
    flags[rowId].push(...conflictFlags);
  }

  // 4) cross-row: GE @ CMPS0002 blocked slots
  const geFlags = checkGeBlockedSlots(rows, ctx);
  for (const [rowId, geRowFlags] of Object.entries(geFlags)) {
    if (!flags[rowId]) flags[rowId] = [];
    flags[rowId].push(...geRowFlags);
  }

  return flags;
}

const toPrettyTime = (t?: string) => {
  if (!t) return "";
  const s = t.trim();
  if (!/^\d{3,4}$/.test(s)) return t;
  const hh = s.length === 3 ? s.slice(0, 1) : s.slice(0, 2);
  const mm = s.slice(-2);
  return `${parseInt(hh, 10)}:${mm}`;
};
const timeRange = (begin?: string, end?: string) => {
  const b = toPrettyTime(begin);
  const e = toPrettyTime(end);
  return b && e ? `${b}–${e}` : b || e || "—";
};

const DAY_OPTIONS = ["M", "T", "W", "H", "F", "S"];
const MODE_OPTIONS = ["FOL", "HYB", "F2F"];
const ROOM_OPTIONS = ["Online", "Classroom", "Comlab"];
const TIME_BEGIN_OPTIONS = [
  "0730",
  "0800",
  "0900",
  "0915",
  "1000",
  "1100",
  "1245",
  "1300",
  "1315",
  "1400",
  "1430",
  "1440",
  "1530",
  "1615",
  "1800",
  "1945",
];
const TIME_END_OPTIONS = [
  "0900",
  "1000",
  "1200",
  "1045",
  "1230",
  "1300",
  "1500",
  "1415",
  "1600",
  "1730",
  "1745",
  "1930",
  "2000",
  "2100",
  "2115",
];

// --- NEW UTILITY FUNCTION FOR AUTO-FILL ---
/**
 * Calculates the standard end time (90 minutes later) for a given start time in "HHMM" format.
 * Returns the calculated "HHMM" string.
 * @param startHhmm - Start time string, e.g., "0730"
 */
function calculateEndTime(startHhmm: string): string {
  if (!startHhmm || startHhmm.length < 4) return "";

  try {
    const startH = parseInt(startHhmm.slice(0, 2), 10);
    const startM = parseInt(startHhmm.slice(2), 10);

    let endH = startH;
    let endM = startM + 90; // Standard 90-minute slot

    // Handle minute overflow
    if (endM >= 60) {
      endH += Math.floor(endM / 60);
      endM = endM % 60;
    }

    // Handle end time past midnight (should not happen based on options, but safe guard)
    if (endH >= 24) {
      endH = 23; // Cap at 23:59 if needed, but for 21:15 end we cap at 21:15
      endM = 15;
    }

    return `${String(endH).padStart(2, "0")}${String(endM).padStart(2, "0")}`;
  } catch (e) {
    console.error("Error calculating end time for", startHhmm, e);
    return "";
  }
}

/* ---------------- Reusable small components ---------------- */
const StatusChip = ({ r }: { r: Row }) => {
  const [show, setShow] = useState(false);
  const [place, setPlace] = useState<"top" | "bottom">("bottom");
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!show || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    setPlace(below < 72 ? "top" : "bottom");
  }, [show]);

  if (!r.status) return <span className="inline-block w-24 h-6" />;
  const tone =
    r.status === "Confirmed"
      ? "bg-green-100 text-green-700"
      : r.status === "Pending"
      ? "bg-yellow-100 text-yellow-700"
      : r.status === "Unassigned"
      ? "bg-gray-200 text-gray-700"
      : "bg-red-600 text-white";

  return (
    <span
      ref={ref}
      className={cls(
        "inline-flex h-6 min-w-[6rem] items-center justify-center rounded-full px-3 text-xs font-semibold",
        tone,
        "relative"
      )}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      tabIndex={0}
    >
      {r.status === "Conflict" ? "Conflict" : r.status}
      {r.status === "Conflict" && r.conflictNote && show && (
        <div
          className={cls(
            "absolute z-[2000] w-[min(70vw,260px)] rounded-md border border-gray-200 bg-white px-3 py-2",
            "text-[12px] leading-snug text-gray-900 shadow-xl whitespace-normal break-words",
            place === "bottom"
              ? "top-[110%] left-1/2 -translate-x-1/2"
              : "bottom-[110%] left-1/2 -translate-x-1/2"
          )}
          role="status"
        >
          <span
            className={cls(
              "absolute block h-2 w-2 rotate-45 border border-gray-200 bg-white",
              place === "bottom"
                ? "-top-1 left-1/2 -translate-x-1/2 border-b-0 border-r-0"
                : "-bottom-1 left-1/2 -translate-x-1/2 border-t-0 border-l-0"
            )}
          />
          {r.conflictNote}
        </div>
      )}
    </span>
  );
};

const ApproveModal = ({
  open,
  onClose,
  onApprove,
}: {
  open: boolean;
  onClose: () => void;
  onApprove: () => void;
}) =>
  !open ? null : (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full border-2 border-emerald-600 text-emerald-700">
          <Check className="h-8 w-8" strokeWidth={2.5} />
        </div>
        <h3 className="mb-2 text-center text-2xl font-semibold">
          Are you sure?
        </h3>
        <p className="mx-auto mb-6 max-w-md text-center text-sm text-neutral-600">
          Please confirm that this is the final{" "}
          <span className="font-semibold">Faculty Load Assignment</span> to be
          submitted to the{" "}
          <span className="font-semibold">Office Assistant</span>. Once
          submitted, this action cannot be undone and the button will be
          disabled.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200"
          >
            Cancel
          </button>
          <button
            onClick={onApprove}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            Yes, I Approve
          </button>
        </div>
      </div>
    </div>
  );

const SendModal = ({
  open,
  onClose,
  rows,
}: {
  open: boolean;
  onClose: () => void;
  rows: Row[];
}) => {
  if (!open) return null;
  const byFaculty = Object.entries(
    rows.reduce<Record<string, Row[]>>((acc, r) => {
      const k = r.faculty || "Unassigned";
      (acc[k] ||= []).push(r);
      return acc;
    }, {})
  );
  const manyGroups = byFaculty.length > 1;

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-5xl rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-1">
          <h3 className="text-[22px] font-extrabold text-emerald-700">
            Teaching Load Assignments for Term 1, AY 2025 - 2026
          </h3>
          <div className="mt-0.5 text-[11px] text-gray-600">
            To:{" "}
            {Array.from(
              new Set(rows.map((r) => r.faculty || "Unassigned"))
            ).join(", ")}
          </div>
        </div>

        <p className="mt-5 text-[13px] text-gray-700">
          Please let me know if the following teaching load below is acceptable
          to you:
        </p>

        <div className="mt-4">
          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full table-fixed text-[13px]">
              <colgroup>
                <col className="w-[140px]" />
                <col />
                <col className="w-[90px]" />
                <col className="w-[72px]" />
                <col className="w-[120px]" />
                <col className="w-[110px]" />
                <col className="w-[70px]" />
                <col className="w-[120px]" />
                <col className="w-[120px]" />
              </colgroup>
              <thead className="bg-gray-50 text-gray-700">
                <tr className="[&>th]:border-b [&>th]:border-gray-200">
                  <th className="px-4 py-3 text-left font-semibold">
                    Course Code
                  </th>
                  <th className="px-4 py-3 text-left font-semibold">
                    Course Title
                  </th>
                  <th className="px-4 py-3 text-left font-semibold">Section</th>
                  <th className="px-4 py-3 text-left font-semibold">Units</th>
                  <th className="px-4 py-3 text-left font-semibold">Campus</th>
                  <th className="px-4 py-3 text-left font-semibold">Mode</th>
                  <th className="px-4 py-3 text-left font-semibold">Day</th>
                  <th className="px-4 py-3 text-left font-semibold">Room</th>
                  <th className="px-4 py-3 text-left font-semibold">Time</th>
                </tr>
              </thead>
              <tbody className="text-gray-900">
                {byFaculty.map(([faculty, items]) => (
                  <React.Fragment key={faculty}>
                    {manyGroups && (
                      <tr className="bg-white">
                        <td
                          colSpan={9}
                          className="px-4 pt-5 pb-2 text-[12px] font-semibold text-gray-900"
                        >
                          {faculty}
                        </td>
                      </tr>
                    )}
                    {items.map((r) => (
                      <tr
                        key={r.id}
                        className={cls(
                          "bg-white",
                          "[&>td]:border-t [&>td]:border-gray-100"
                        )}
                      >
                        <td className="px-4 py-3 align-middle">
                          {r.course || "—"}
                        </td>
                        <td className="px-4 py-3 align-middle truncate">
                          {r.title || "—"}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {r.section || "—"}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {r.units !== "" ? String(r.units) : "—"}
                        </td>
                        <td className="px-4 py-3 align-middle text-gray-800">
                          —
                        </td>
                        <td className="px-4 py-3 align-middle text-gray-800">
                          —
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {r.day1 || "—"}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {r.room1 || "—"}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {timeRange(r.begin1, r.end1)}
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-4 py-8 text-center text-sm text-gray-500"
                    >
                      No rows selected.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200"
          >
            Cancel
          </button>
          <button
            onClick={onClose}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            <Send className="h-4 w-4" />
            Send
          </button>
        </div>
      </div>
    </div>
  );
};

const RequestChangeModal = ({
  open,
  from,
  onClose,
}: {
  open: boolean;
  from?: string;
  onClose: () => void;
}) =>
  !open ? null : (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl relative">
        <button
          aria-label="Close"
          className="absolute right-3 top-3 rounded-md p-1.5 hover:bg-gray-100"
          onClick={onClose}
        >
          <X className="h-5 w-5 text-gray-500" />
        </button>

        <h3 className="text-lg font-semibold text-emerald-700 mb-4">
          Request for Change
        </h3>
        <div className="text-sm text-gray-600 mb-4">
          From: <span className="font-semibold">{from}</span>
        </div>

        <div className="grid gap-2 text-sm mb-4">
          <div>
            <div className="font-semibold text-gray-900">Change</div>
            <div className="text-gray-700">Change Class Time</div>
          </div>
          <div>
            <div className="font-semibold text-gray-900">Time</div>
            <div className="text-gray-700">11:00AM - 12:30PM</div>
          </div>
          <div>
            <div className="font-semibold text-gray-900">Other remarks</div>
            <div className="text-gray-700">
              Other commitments to that timeframe.
            </div>
          </div>
        </div>

        <label className="block text-sm font-medium mb-1">Reply</label>
        <textarea
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30 mb-6"
          rows={4}
          placeholder="Type your reply..."
        />

        <div className="flex justify-end gap-2">
          <button className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm">
            Reject
          </button>
          <button className="px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm">
            Approve
          </button>
          <button
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm"
            onClick={onClose}
          >
            Reply
          </button>
        </div>
      </div>
    </div>
  );

const NewSectionModal = ({
  open,
  onClose,
  onSave,
  courseOptions,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (data: {
    course: string;
    section: string;
    units: string;
    campus_id: string;
  }) => void;
  courseOptions: { code: string; title: string }[];
}) => {
  const [course, setCourse] = useState("");
  const [section, setSection] = useState("");
  const [units, setUnits] = useState("");
  const [campusId, setCampusId] = useState("");

  useEffect(() => {
    if (!open) {
      setCourse("");
      setSection("");
      setUnits("");
      setCampusId("");
    }
  }, [open]);

  if (!open) return null;

  const selectedCourseTitle =
    courseOptions.find((c) => c.code === course)?.title || "";

  const handleSave = () => {
    if (!course || !section) {
      alert("Please fill at least course code and section code.");
      return;
    }
    onSave({
      course,
      section,
      units,
      campus_id: campusId,
    });
  };

  return (
    <div className="fixed inset-0 z-[130] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl relative">
        <button
          aria-label="Close"
          className="absolute right-3 top-3 rounded-md p-1.5 hover:bg-gray-100"
          onClick={onClose}
        >
          <X className="h-5 w-5 text-gray-500" />
        </button>

        <h3 className="mb-4 text-lg font-semibold text-emerald-700">
          Add New Section
        </h3>

        <div className="space-y-4 text-sm">
          {/* Course code */}
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700">
              Course Code
            </label>
            <SelectBox
              value={course}
              onChange={setCourse}
              options={courseOptions.map((c) => c.code)}
              placeholder="— Select course code —"
              className="w-full"
            />
            <div className="mt-1 text-[11px] text-gray-500 min-h-[16px]">
              {selectedCourseTitle || "Course title will appear here."}
            </div>
          </div>

          {/* Section code */}
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700">
              Section Code
            </label>
            <TextBox
              value={section}
              onChange={setSection}
              placeholder="e.g. S11"
            />
          </div>

          {/* Units */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-700">
                Units
              </label>
              <TextBox value={units} onChange={setUnits} placeholder="e.g. 3" />
            </div>

            {/* Campus ID (simple text for now) */}
            <div>
              <label className="mb-1 block text-xs font-semibold text-gray-700">
                Campus ID
              </label>
              <TextBox
                value={campusId}
                onChange={setCampusId}
                placeholder="e.g. CMPS0001"
              />
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            <Save className="h-4 w-4" />
            Save New Section
          </button>
        </div>
      </div>
    </div>
  );
};

/* ---------------- Main ---------------- */
export default function OM_LoadAssignment() {
  // Session (DB-driven, no hardcodes)
  const session: {
    userId?: string;
    fullName?: string;
    roles?: string[];
  } | null = (() => {
    try {
      return JSON.parse(localStorage.getItem("animo.user") || "null");
    } catch {
      return null;
    }
  })();

  const userId = session?.userId || "";

  const [isAssigning, setIsAssigning] = useState(false);

  const [showNewSectionModal, setShowNewSectionModal] = useState(false);

  const [preferredByFaculty, setPreferredByFaculty] = useState<
    Record<string, number>
  >({});

  async function runAutoAssign() {
    if (!userId) return;

    // FRONTEND GUARD: block auto-assign while there are unsaved edits
    if (hasLocalEdits) {
      alert(
        "Auto-assign is disabled while you have manual edits.\n\nPlease save/discard your changes or refresh the list before running Auto-assign."
      );
      return;
    }

    try {
      setIsAssigning(true);
      const res = await runOmAutoAssign({ user_id: userId });

      // NEW: capture preferred units coming from backend debug
      const debug = (res as any)?.debug || {};
      const prefMap = debug.preferred_units_by_faculty || {};
      setPreferredByFaculty(prefMap);

      console.log("DEBUG from run:", debug);
      console.log("Preferred map:", prefMap);

      setRows(Array.isArray(res?.rows) ? res.rows : []);
      setTerm(typeof res?.term === "string" ? res.term : "");
      setMode("run");
      setApproved(false);
      setHasLocalEdits(false); // result from algorithm is the new clean baseline
    } catch (e) {
      console.error(e);
      alert(`Auto-assign failed: ${String(e)}`);
    } finally {
      setIsAssigning(false);
    }
  }

  const normRoles = (session?.roles || []).map((r) =>
    String(r).toLowerCase().replace(/\s+/g, "_")
  );

  // TopBar profile from DB (fallback to session)
  const [profileName, setProfileName] = useState<string>(
    session?.fullName || ""
  );
  const [profileSubtitle, setProfileSubtitle] = useState<string>("");

  // Term label from backend (no hardcoding)
  const [term, setTerm] = useState<string>("");

  useEffect(() => {
    (async () => {
      if (!userId) return;
      try {
        const p = await getOmLoadAssignmentProfile(userId);

        // 1. Determine Base Title from DB or Fallback
        let roleTitle = p?.position_title || "";

        // Fallback: If no title in DB, but has OM role in session
        if (
          !roleTitle &&
          (normRoles.includes("office_manager") ||
            normRoles.includes("role0006"))
        ) {
          roleTitle = "Office Manager";
        }

        // 2. Append Department ONCE if available
        if (roleTitle && p?.dept_name) {
          roleTitle = `${roleTitle} | ${p.dept_name}`;
        }

        setProfileSubtitle(roleTitle);
        setProfileName(p?.full_name || session?.fullName || "");

        setProfileSubtitle(roleTitle);

        // 3. Name Fallback
        setProfileName(p?.full_name || session?.fullName || "");
      } catch {
        /* ignore; non-blocking for UI */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [validationContext, setValidationContext] = useState<ValidationContext>(
    {
      courseToKac: {},
      facultyToKacs: {},
      facultyPrefWindows: {},
      facultyAllowedModes: {},
      courseAllowedModes: {},
      courseProgramLevel: {},
      facultyHasPhd: {},
      sectionCampus: {},
      sectionCourse: {},
      courseTypeOfCourse: {},
    }
  );

  const [rowFlags, setRowFlags] = useState<RowFlagsById>({});

  useEffect(() => {
    const newFlags = validateAllRows(rows, validationContext);
    setRowFlags(newFlags);
  }, [rows, validationContext]);
  type Mode = "idle" | "manual" | "run";
  const [mode, setMode] = useState<Mode>("idle");
  const isRunning = mode !== "idle";
  const isRun = mode === "run";
  const hasReco = isRunning && rows.length > 0;
  const [showApprove, setShowApprove] = useState(false);
  const [approved, setApproved] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [reqChange, setReqChange] = useState<{ open: boolean; from?: string }>({
    open: false,
  });

  /** Track if there are unsaved/manual edits in the grid */
  const [hasLocalEdits, setHasLocalEdits] = useState(false);

  const [facultyList, setFacultyList] = useState<Faculty[]>([]);

  // Load all faculty once on mount
  useEffect(() => {
    (async () => {
      try {
        const list = await getAllFaculty(); // should be an array
        console.log("DEBUG faculty list from API:", list);
        if (Array.isArray(list)) {
          setFacultyList(list);
        } else {
          console.warn("getAllFaculty returned non-array:", list);
          setFacultyList([]);
        }
      } catch (e) {
        console.error("Failed to load faculty list", e);
        setFacultyList([]);
      }
    })();
  }, []);

  // Show the main Load Assignment content only on /om or /om/load-assignment
  const loc = useLocation();
  const isIndex = /^\/om(\/(load-assignment|home))?$/.test(loc.pathname);

  // === Inbox-as-tab behavior (mirrors Faculty) ===
  const [showInbox, setShowInbox] = useState(false);
  useEffect(() => {
    const onOpen = () => setShowInbox(true);
    const onClose = () => setShowInbox(false);
    window.addEventListener("om:openInbox" as any, onOpen);
    window.addEventListener("om:closeInbox" as any, onClose);
    return () => {
      window.removeEventListener("om:openInbox" as any, onOpen);
      window.removeEventListener("om:closeInbox" as any, onClose);
    };
  }, []);

  const [initialLoaded, setInitialLoaded] = useState(false);

  const setCell = <K extends keyof Row>(id: string, key: K, val: Row[K]) => {
    setHasLocalEdits(true); // mark grid as dirty
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [key]: val } : r))
    );
  };

  const filtered = rows.filter((r) => {
    const s = search.trim().toLowerCase();
    if (!s) return true;
    return (
      r.course.toLowerCase().includes(s) ||
      (r.faculty || "").toLowerCase().includes(s) ||
      (r.section || "").toLowerCase().includes(s)
    );
  });

  const allSelected =
    isRunning && filtered.length > 0 && filtered.every((r) => r.selected);
  const toggleSelectAll = (checked: boolean) =>
    setRows((prev) =>
      prev.map((r) =>
        filtered.some((fr) => fr.id === r.id) ? { ...r, selected: checked } : r
      )
    );
  const selectedRows = rows.filter((r) => r.selected);
  const anySelected = selectedRows.length > 0;

  const loadFromServer = async () => {
    if (!userId) return;
    const res = await getOmLoadAssignmentList(userId);

    const prefMap = (res as any)?.preferred_units_by_faculty || {};
    setPreferredByFaculty(prefMap);

    // hydrate validation context for row flags
    setValidationContext({
      courseToKac: (res as any)?.courseToKac || {},
      facultyToKacs: (res as any)?.facultyToKacs || {},
      facultyPrefWindows: (res as any)?.facultyPrefWindows || {},
      facultyAllowedModes: (res as any)?.facultyAllowedModes || {},
      courseAllowedModes: {},
      courseProgramLevel: (res as any)?.courseProgramLevel || {},
      facultyHasPhd: (res as any)?.facultyHasPhd || {},
      sectionCampus: (res as any)?.sectionCampus || {},
      sectionCourse: (res as any)?.sectionCourse || {},
      courseTypeOfCourse: (res as any)?.courseTypeOfCourse || {},
    });

    setRows(Array.isArray(res?.rows) ? res.rows : []);
    setTerm(typeof res?.term === "string" ? res.term : "");
    setMode("run");
    setApproved(false);
    setHasLocalEdits(false);
  };

  useEffect(() => {
    if (initialLoaded) return; // prevent double loading
    setInitialLoaded(true);
    loadFromServer(); // auto-load on page open
  }, [initialLoaded]);

  const addRow = () => {
    setShowNewSectionModal(true);
  };  

  const getEditFlags = (r: Row) => {
    const editAll = !!r.editable;
    const editSchedule = editAll || isRun;
    return {
      course: editAll,
      title: editAll,
      units: editAll,
      section: editAll,
      faculty: editSchedule,
      day1: editSchedule,
      begin1: editSchedule,
      end1: editSchedule,
      room1: editAll,
      day2: editSchedule,
      begin2: editSchedule,
      end2: editSchedule,
      room2: editAll,
      capacity: editAll,
      mode: editSchedule,
    } as const;
  };

  const Cell = ({
    editable,
    value,
    onChange,
    className = "",
    align = "left",
    placeholder = "",
    displayClass = "",
  }: {
    editable: boolean;
    value: string;
    onChange: (v: string) => void;
    className?: string;
    align?: "left" | "center";
    placeholder?: string;
    displayClass?: string;
  }) =>
    editable ? (
      <TextBox
        value={value}
        onChange={onChange}
        className={className}
        align={align}
        placeholder={placeholder}
      />
    ) : value ? (
      <span className={displayClass}>{value}</span>
    ) : (
      <>—</>
    );

  async function handleSaveDraft() {
    if (!userId) return;

    try {
      await submitOmLoadAssignment(userId, { rows }, "save");
      await loadFromServer(); // pull fresh rows from DB
      setHasLocalEdits(false); // grid now matches DB
    } catch (e) {
      console.error(e);
      alert(`Save draft failed: ${String(e)}`);
    }
  }

  // function RowFlagBadges({ flags }: { flags?: RowFlag[] }) {
  //   if (!flags || flags.length === 0) return null;

  //   return (
  //     <div className="mt-1 space-y-0.5">
  //       {flags.map((f, i) => (
  //         <div
  //           key={i}
  //           className={cls(
  //             "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold",
  //             f.severity === "error"
  //               ? "bg-red-50 text-red-700 border border-red-200"
  //               : "bg-amber-50 text-amber-700 border border-amber-200"
  //           )}
  //           title={f.message}
  //         >
  //           {f.type.replace(/_/g, " ")}
  //         </div>
  //       ))}
  //     </div>
  //   );
  // }

  /** Fields that must be filled before a row can be approved */
  const isRowIncompleteForApproval = (r: Row) => {
    // treat “touched” rows as those with any scheduling/faculty info
    const hasAnyData =
      !!r.day1 || !!r.begin1 || !!r.end1 || !!r.day2 || !!r.begin2 || !!r.end2;

    if (!hasAnyData) return false; // completely empty row → ignore

    // REQUIRED core fields
    const missingCore =
      !r.section ||
      !r.faculty ||
      !r.mode ||
      !r.day1 ||
      !r.begin1 ||
      !r.end1;

    // For meeting 2: if any of the 4 is filled, require all 4
    const hasAnyMeet2 = !!r.day2 || !!r.begin2 || !!r.end2;
    const missingMeet2 = hasAnyMeet2 && (!r.day2 || !r.begin2 || !r.end2);

    return missingCore || missingMeet2;
  };

  type Faculty = {
    faculty_id: string;
    faculty_name_display: string;
    preferred_units?: number | null;
  };

  const facultyOptions = useMemo(() => {
    return (facultyList ?? [])
      .map((f) => f.faculty_name_display || f.faculty_id)
      .filter((name) => name.trim().length > 0)
      .sort((a, b) => a.localeCompare(b));
  }, [facultyList]);

  const facultyNameToId = useMemo(() => {
    const map: Record<string, string> = {};
    (facultyList ?? []).forEach((f) => {
      const name = f.faculty_name_display || f.faculty_id;
      if (name) map[name] = f.faculty_id;
    });
    console.log("DEBUG facultyNameToId map:", map);
    return map;
  }, [facultyList]);

  const facultyById = useMemo(() => {
    const map: Record<string, Faculty> = {};
    (facultyList ?? []).forEach((f) => {
      if (f.faculty_id) {
        map[f.faculty_id] = f;
      }
    });
    return map;
  }, [facultyList]);

  const hasAnyErrors = useMemo(
    () =>
      Object.values(rowFlags).some((flags) =>
        flags.some((f) => f.severity === "error")
      ),
    [rowFlags]
  );

  type FacultySummaryRow = {
    facultyId: string;
    facultyName: string;
    assignedUnits: number;
    preferredUnits: number | null;
    diff: number | null;
  };

  const facultySummary: FacultySummaryRow[] = useMemo(() => {
    const acc: Record<string, FacultySummaryRow> = {};

    for (const r of rows) {
      if (!r.faculty && !r.faculty_id) continue;

      const key = r.faculty_id || r.faculty || "";
      if (!key) continue;

      const numericUnits =
        typeof r.units === "number"
          ? r.units
          : parseFloat(String(r.units || "0")) || 0;

      if (!acc[key]) {
        const meta = r.faculty_id ? facultyById[r.faculty_id] : undefined;
        const facultyName =
          r.faculty || meta?.faculty_name_display || r.faculty_id || "—";

        // NEW: first try map from backend, then fallback to meta.preferred_units
        const prefFromMap = r.faculty_id
          ? preferredByFaculty[r.faculty_id]
          : undefined;

        const preferredUnits =
          typeof prefFromMap === "number"
            ? prefFromMap
            : meta && typeof meta.preferred_units === "number"
            ? meta.preferred_units
            : null;

        acc[key] = {
          facultyId: r.faculty_id || "",
          facultyName,
          assignedUnits: 0,
          preferredUnits,
          diff: null,
        };
      }

      acc[key].assignedUnits += numericUnits;
    }

    // compute diff after accumulating
    Object.values(acc).forEach((row) => {
      if (row.preferredUnits != null) {
        row.diff = row.assignedUnits - row.preferredUnits;
      }
    });

    return Object.values(acc).sort((a, b) =>
      a.facultyName.localeCompare(b.facultyName)
    );
  }, [rows, facultyById, preferredByFaculty]);

  // ---- Rule alerts for Tab 2 (violations / warnings) ----
  type RuleAlert = {
    id: string;
    rule: string;
    severity: "error" | "warning";
    facultyName?: string;
    facultyId?: string;
    rowNumber?: number;
    message: string;
  };

  const ruleAlerts: RuleAlert[] = useMemo(() => {
    const alerts: RuleAlert[] = [];

    // Helper: hhmm -> minutes since midnight (e.g. "0730" -> 450)
    const toMinutes = (t?: string): number | null => {
      if (!t) return null;
      const s = t.trim();
      if (!/^\d{3,4}$/.test(s)) return null;
      const hh = s.length === 3 ? s.slice(0, 1) : s.slice(0, 2);
      const mm = s.slice(-2);
      const h = Number(hh);
      const m = Number(mm);
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      return h * 60 + m;
    };

    // 1) Build intervals per faculty+day from rows
    type Interval = {
      facultyKey: string;
      facultyName: string;
      facultyId?: string;
      day: string;
      start: number;
      end: number;
      row: Row;
    };

    const byKey: Record<string, Interval[]> = {};

    rows.forEach((r) => {
      const facultyKey = r.faculty_id || r.faculty;
      if (!facultyKey) return;
      const facultyName = r.faculty || facultyKey;
      const facultyId = r.faculty_id;

      const d1 = (r.day1 || "").trim();
      const b1 = toMinutes(r.begin1);
      const e1 = toMinutes(r.end1);
      if (d1 && b1 != null && e1 != null && e1 > b1) {
        const k = `${facultyKey}__${d1}`;
        (byKey[k] ||= []).push({
          facultyKey,
          facultyName,
          facultyId,
          day: d1,
          start: b1,
          end: e1,
          row: r,
        });
      }

      const d2 = (r.day2 || "").trim();
      const b2 = toMinutes(r.begin2);
      const e2 = toMinutes(r.end2);
      if (d2 && b2 != null && e2 != null && e2 > b2) {
        const k = `${facultyKey}__${d2}`;
        (byKey[k] ||= []).push({
          facultyKey,
          facultyName,
          facultyId,
          day: d2,
          start: b2,
          end: e2,
          row: r,
        });
      }
    });

    const MAX_CONSEC = 4 * 60 + 30; // 4.5 hours
    const GAP_TOL = 15; // minutes

    // 2) For each faculty+day, detect 4.5h+ consecutive teaching streaks
    Object.entries(byKey).forEach(([key, arr]) => {
      if (arr.length === 0) return;
      arr.sort((a, b) => a.start - b.start);

      let streakStart = arr[0].start;
      let streakEnd = arr[0].end;
      let streakTeach = streakEnd - streakStart;
      let streakIntervals: Interval[] = [arr[0]];

      for (let i = 1; i < arr.length; i++) {
        const iv = arr[i];
        const gap = iv.start - streakEnd;
        const dur = iv.end - iv.start;

        if (gap <= GAP_TOL) {
          // extend streak
          streakEnd = iv.end;
          streakTeach += dur;
          streakIntervals.push(iv);
        } else {
          // new streak
          streakStart = iv.start;
          streakEnd = iv.end;
          streakTeach = dur;
          streakIntervals = [iv];
        }

        if (streakTeach > MAX_CONSEC) {
          const sample = streakIntervals[0];
          const facultyName = sample.facultyName;
          const facultyId = sample.facultyId;
          const day = sample.day;

          const sections = Array.from(
            new Set(
              streakIntervals.map((x) =>
                `${x.row.course || "?"} ${x.row.section || ""}`.trim()
              )
            )
          ).join(", ");

          // use the first row in the streak as the reference row
          const rowIndex = rows.findIndex((x) => x.id === sample.row.id);

          alerts.push({
            id: `${key}-streak`,
            rule: "MAX_CONSEC_4_5H",
            severity: "warning",
            facultyName,
            facultyId,
            rowNumber: rowIndex >= 0 ? rowIndex + 1 : undefined,
            message: `${facultyName} has more than 4.5 consecutive hours of teaching on ${day} (sections: ${sections}).`,
          });

          break; // one alert per faculty+day is enough
        }
      }
    });

    // 3) Incomplete rows (same logic as hasIncompleteRows)
    rows.forEach((r, idx) => {
      if (isRowIncompleteForApproval(r)) {
        const rowIndex = rows.findIndex((x) => x.id === r.id);
        alerts.push({
          id: `incomplete-${idx}-${r.id}`,
          rule: "INCOMPLETE_ROW",
          severity: "error",
          facultyName: r.faculty || undefined,
          facultyId: r.faculty_id,
          rowNumber: rowIndex + 1,
          message: `Row ${
            idx + 1
          } has missing required fields but contains partial schedule/faculty data.`,
        });
      }
    });

    // 3b) KAC mismatch (same pattern as INCOMPLETE_ROW)
    rows.forEach((r) => {
      const flags = rowFlags[r.id];
      if (!flags) return;

      const kac = flags.find((f) => f.type === "KAC_MISMATCH");
      if (!kac) return;

      const rowIndex = rows.findIndex((x) => x.id === r.id);

      alerts.push({
        id: `kac-${r.id}`,
        rule: "KAC_MISMATCH",
        severity: "error",
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        rowNumber: rowIndex + 1,
        message: `KAC mismatch: ${
          r.faculty || "This faculty"
        } is not aligned with the KAC cluster for ${r.course} ${r.section}.`,
      });
    });

    // 3c) Mode mismatch between faculty preference and row.mode
    rows.forEach((r) => {
      const flags = rowFlags[r.id];
      if (!flags) return;

      const modeFlag = flags.find((f) => f.type === "MODE_MISMATCH");
      if (!modeFlag) return;

      const fid = r.faculty_id || "";
      const allowed = validationContext.facultyAllowedModes[fid] || [];
      const prefLabel = allowed.join(", ") || "another mode";
      const rowModeLabel = (r.mode || "").toUpperCase() || "unspecified";
      const rowIndex = rows.findIndex((x) => x.id === r.id);

      alerts.push({
        id: `mode-${r.id}`,
        rule: "MODE_MISMATCH",
        severity: "error",
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        rowNumber: rowIndex + 1,
        message: `Mode mismatch: ${
          r.faculty || "This faculty"
        } prefers ${prefLabel} but this row is ${rowModeLabel}.`,
      });
    });

    // 3d) Same day/time double-booking (from rowFlags)
    rows.forEach((r) => {
      const flags = rowFlags[r.id];
      if (!flags) return;

      const dbl = flags.find((f) => f.type === "DOUBLE_BOOKED");
      if (!dbl) return;

      const rowIndex = rows.findIndex((x) => x.id === r.id);

      alerts.push({
        id: `double-${r.id}`,
        rule: "DOUBLE_BOOKED",
        severity: "error",
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        rowNumber: rowIndex + 1,
        message:
          dbl.message ||
          "Schedule conflict: faculty is assigned to multiple sections at the same day and time.",
      });
    });

    // 3e) day to faculty_preferences mismatch (from rowFlags)
    rows.forEach((r) => {
      const flags = rowFlags[r.id];
      if (!flags) return;

      const flag = flags.find((f) => f.type === "DAY_MISMATCH");
      if (!flag) return;

      const rowIndex = rows.findIndex((x) => x.id === r.id);

      alerts.push({
        id: `day-${r.id}`,
        rule: "DAY_MISMATCH",
        severity: flag.severity,
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        rowNumber: rowIndex + 1,
        message: flag.message,
      });
    });

    // 3f) time to faculty_preferences mismatch (from rowFlags)
    rows.forEach((r) => {
      const flags = rowFlags[r.id];
      if (!flags) return;

      const flag = flags.find((f) => f.type === "TIME_MISMATCH");
      if (!flag) return;

      const rowIndex = rows.findIndex((x) => x.id === r.id);

      alerts.push({
        id: `time-${r.id}`,
        rule: "TIME_MISMATCH",
        severity: flag.severity,
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        rowNumber: rowIndex + 1,
        message: flag.message,
      });
    });

    // 3g) GS sections assigned to non-PhD faculty
    rows.forEach((r) => {
      const flags = rowFlags[r.id];
      if (!flags) return;

      const flag = flags.find((f) => f.type === "GS_NO_PHD");
      if (!flag) return;

      const rowIndex = rows.findIndex((x) => x.id === r.id);

      alerts.push({
        id: `gs-${r.id}`,
        rule: "GS_NO_PHD",
        severity: flag.severity,
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        rowNumber: rowIndex >= 0 ? rowIndex + 1 : undefined,
        message:
          flag.message ||
          `GS course ${r.course || "?"} ${
            r.section || ""
          } is assigned to a non-PhD faculty member.`,
      });
    });

    // 3h) GE @ CMPS0002 blocked slot violations
    rows.forEach((r) => {
      const flags = rowFlags[r.id];
      if (!flags) return;

      const geFlag = flags.find((f) => f.type === "GE_BLOCKED_SLOT");
      if (!geFlag) return;

      const rowIndex = rows.findIndex((x) => x.id === r.id);

      alerts.push({
        id: `ge-block-${r.id}`,
        rule: "GE_BLOCKED_SLOT",
        severity: geFlag.severity,
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        rowNumber: rowIndex >= 0 ? rowIndex + 1 : undefined,
        message:
          geFlag.message ||
          `GE slot conflict: ${r.course || "?"} ${
            r.section || ""
          } is using a GE-reserved schedule at CMPS0002.`,
      });
    });

    // 3i) Faculty with 4+ distinct preps (courses)
    {
      const prepsByFaculty: Record<string, Set<string>> = {};
      const facultyLabel: Record<string, { name: string; id?: string }> = {};

      rows.forEach((r) => {
        const fid = r.faculty_id;
        const courseCode = r.course;
        if (!fid || !courseCode) return;

        if (!prepsByFaculty[fid]) prepsByFaculty[fid] = new Set();
        prepsByFaculty[fid].add(courseCode);

        if (!facultyLabel[fid]) {
          facultyLabel[fid] = {
            name: r.faculty || fid,
            id: fid,
          };
        }
      });

      Object.entries(prepsByFaculty).forEach(([fid, courseSet]) => {
        const prepCount = courseSet.size;
        if (prepCount < 4) return; // only flag 4+ preps

        const labelInfo = facultyLabel[fid] || { name: fid, id: fid };
        const facultyName = labelInfo.name;
        const facultyId = labelInfo.id;
        const courseList = Array.from(courseSet).join(", ");

        alerts.push({
          id: `max-preps-${fid}`,
          rule: "MAX_PREPS",
          severity: "warning", // or "error" if you want it hard-blocking
          facultyName,
          facultyId,
          message: `${facultyName} has ${prepCount} different preps (${courseList}). Recommended maximum is 3.`,
        });
      });
    }

    // 4) Sections where auto-assign had to drop a faculty
    //    (backend marks them as Unassigned + conflictNote)
    rows.forEach((r, idx) => {
      if (
        r.status === "Unassigned" &&
        !r.faculty &&
        r.conflictNote &&
        r.conflictNote.toLowerCase().includes("no compatible time slot")
      ) {
        alerts.push({
          id: `no-slot-${idx}-${r.id}`,
          rule: "NO_SLOT_FROM_PREFS",
          severity: "warning",
          facultyName: undefined,
          facultyId: undefined,
          message:
            `Section ${r.course || "?"} ${r.section || ""} ` +
            `was left unassigned: ${r.conflictNote}`,
        });
      }
    });

    return alerts;
  }, [rows, rowFlags, validationContext, isRowIncompleteForApproval]);

  type BlockedSectionRow = {
    rowId: string;
    course: string; // course_code
    section: string; // sections.section_code
    campusId: string;
    campusName?: string;
    day1?: string;
    begin1?: string;
    end1?: string;
    day2?: string;
    begin2?: string;
    end2?: string;
  };

  const blockedSections: BlockedSectionRow[] = useMemo(() => {
    const res: BlockedSectionRow[] = [];
    const seen = new Set<string>();

    const sectionCampus = validationContext.sectionCampus || {};
    const sectionCourse = validationContext.sectionCourse || {};
    const courseType = validationContext.courseTypeOfCourse || {};
    const campusNames = validationContext.campusNames || {};

    for (const r of rows) {
      const sid = r.id;
      if (!sid) continue;

      const campusIdRaw = sectionCampus[sid] || "";
      const campusId = campusIdRaw.toUpperCase();
      if (campusId !== "CMPS0002") continue; // only CMPS0002

      const cid = sectionCourse[sid];
      const toc = (courseType[cid] || "").toUpperCase();
      if (toc !== "GE") continue; // only GE courses are "blocked"

      const key = sid;
      if (seen.has(key)) continue;
      seen.add(key);

      res.push({
        rowId: sid,
        course: r.course || cid || "?",
        section: r.section || "",
        campusId: campusIdRaw || "",
        campusName: campusNames[campusIdRaw] || campusIdRaw || "",
        day1: r.day1,
        begin1: r.begin1,
        end1: r.end1,
        day2: r.day2,
        begin2: r.begin2,
        end2: r.end2,
      });
    }

    return res;
  }, [rows, validationContext]);

  const [summaryTab, setSummaryTab] = useState<"units" | "second" | "blocked">(
    "units"
  );

  const courseOptions = useMemo(() => {
    const map: Record<string, string> = {};

    rows.forEach((r) => {
      const code = (r.course || "").trim();
      const title = (r.title || "").trim();
      if (code && title && !map[code]) {
        map[code] = title;
      }
    });

    return Object.entries(map)
      .map(([code, title]) => ({ code, title }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [rows]);

  return (
    <AppShell
      // make TopBar’s Inbox icon open our OM Inbox-as-tab
      topbarProfileName={profileName || " "}
      topbarProfileSubtitle={profileSubtitle || " "}
      // @ts-ignore
      topbarInboxEvent="om:openInbox"
    >
      {/* If Inbox is opened from the TopBar, show it like a tab */}
      {showInbox ? (
        <OMInboxContent />
      ) : (
        <>
          {/* Child “tabs” (Course Mgt, Faculty Form, etc.) render here */}
          <Outlet />

          {/* Show the main Load Assignment UI only on /om or /om/load-assignment */}
          {isIndex && (
            <main className="w-full px-8 py-8">
              <header className="mb-6 flex items-start justify-between">
                <div>
                  <h1 className="text-2xl font-bold">
                    Load Assignment <span className="text-gray-400">|</span>{" "}
                    <span className="font-black">{term}</span>
                  </h1>
                  <p className="text-sm text-gray-600">
                    Manage course assignments and faculty workload distribution
                  </p>
                </div>
              </header>

              <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="relative flex-1 min-w-[260px]">
                  <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by course, section, or faculty..."
                    className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
                  />
                </div>

                <div className="ml-auto flex items-center gap-2">
                  <button
                    disabled={!hasReco}
                    onClick={handleSaveDraft}
                    className={cls(
                      "inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium shadow-sm",
                      hasReco
                        ? "bg-gray-800 text-white hover:brightness-110"
                        : "bg-gray-200 text-gray-500 cursor-not-allowed"
                    )}
                    title={
                      !hasReco
                        ? "No recommendations to save yet"
                        : "Save current assignments to the database"
                    }
                  >
                    <Save className="h-4 w-4" />
                    Save Draft
                  </button>
                  <button
                    disabled={!hasReco || approved}
                    className={cls(
                      "rounded-lg px-4 py-2 font-semibold shadow-sm flex items-center gap-2",
                      !(!hasReco || approved)
                        ? "bg-emerald-600 text-white hover:bg-emerald-700" // enabled (GREEN)
                        : "bg-gray-200 text-gray-400 cursor-not-allowed" // disabled
                    )}
                    onClick={() => {
                      if (hasAnyErrors) {
                        const proceed = window.confirm(
                          [
                            "There are validation errors (e.g., KAC mismatch, mode mismatch, or schedule conflicts).",
                            "",
                            "Do you still want to proceed with approval?",
                          ].join("\n")
                        );
                        if (!proceed) return;
                      }

                      setShowApprove(true);
                    }}
                  >
                    <CheckCheck className="h-4 w-4" />
                    Forward
                  </button>
                </div>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                <div className="flex items-center justify-between px-4 pt-4">
                  <h2 className="text-lg font-semibold">
                    Load Recommendations
                  </h2>

                  {/* --- MODIFIED SECTION START --- */}
                  <div className="flex items-center gap-2">
                    {/* New/Moved Auto-assign button */}
                    <button
                      onClick={runAutoAssign}
                      disabled={isAssigning || hasLocalEdits}
                      className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110 disabled:opacity-60"
                      title={
                        hasLocalEdits
                          ? "Auto-assign is disabled while you have manual edits. Save or refresh first."
                          : "Run auto-assignment algorithm"
                      }
                    >
                      <Play className="h-4 w-4" />
                      {isAssigning ? "Assigning…" : "Auto-assign"}
                    </button>

                    {/* Refresh button (always visible if running) */}
                    {isRunning && (
                      <button
                        onClick={loadFromServer}
                        className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium hover:bg-gray-50"
                      >
                        <RefreshCcw className="h-4 w-4" />
                        Refresh
                      </button>
                    )}

                    {/* To Faculty button (only visible if running and a row is selected) */}
                    <button
                      disabled={!anySelected || !isRunning}
                      onClick={() => setShowSend(true)}
                      className={cls(
                        "inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium shadow-sm",
                        anySelected && isRunning
                          ? "bg-blue-600 text-white hover:brightness-110"
                          : "bg-gray-200 text-gray-500 cursor-not-allowed"
                      )}
                      title={
                        anySelected
                          ? "Send to selected faculty"
                          : "Select at least one row"
                      }
                    >
                      <Send className="h-4 w-4" />
                      To Faculty
                    </button>

                    {/* Original Import CSV block removed */}
                    {/* {isRunning ? (...) : (
                        <div className="flex items-center gap-2">
                          <button className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110">
                            <Upload className="h-4 w-4" />
                            Import CSV
                          </button>
                          <button
                            onClick={loadFromServer}
                            className="inline-flex items-center gap-2 rounded-md border border-emerald-700 text-emerald-800 bg-white px-3.5 py-2 text-sm font-medium hover:bg-emerald-50"
                          >
                            <Play className="h-4 w-4" />
                            Run
                          </button>
                        </div>
                      )
                    } */}
                  </div>
                  {/* --- MODIFIED SECTION END --- */}

                </div>

                <div className="overflow-x-auto overflow-y-auto max-h-[58vh] mt-3">
                  <table className="min-w-full text-sm table-fixed">
                    <colgroup>
                      <col className="w-[46px]" />
                      <col className="w-[160px]" />
                      <col className="w-[26%]" />
                      <col className="w-[70px]" />
                      <col className="w-[80px]" />
                      <col className="w-[18%]" />
                      <col className="w-[72px]" />
                      <col className="w-[96px]" />
                      <col className="w-[96px]" />
                      <col className="w-[96px]" />
                      <col className="w-[72px]" />
                      <col className="w-[96px]" />
                      <col className="w-[96px]" />
                      <col className="w-[96px]" />
                      <col className="w-[80px]" />
                      <col className="w-[100px]" />
                      <col className="w-[110px]" />
                    </colgroup>

                    <thead className="bg-gray-50 border-y text-gray-700">
                      <tr className="whitespace-nowrap">
                        <th className="px-3 py-2 text-center">
                          {isRunning && (
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={(e) =>
                                toggleSelectAll(e.target.checked)
                              }
                              className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                              title="Select all"
                            />
                          )}
                        </th>
                        <th className="text-left px-4 py-2">Course & Title</th>
                        <th className="text-center px-2 py-2">Units</th>
                        <th className="text-center px-2 py-2">Section</th>
                        <th className="text-left px-4 py-2">Faculty</th>
                        <th className="text-center px-2 py-2">Day 1</th>
                        <th className="text-center px-2 py-2">Begin 1</th>
                        <th className="text-center px-2 py-2">End 1</th>
                        <th className="text-center px-2 py-2">Room 1</th>
                        <th className="text-center px-2 py-2">Day 2</th>
                        <th className="text-center px-2 py-2">Begin 2</th>
                        <th className="text-center px-2 py-2">End 2</th>
                        <th className="text-center px-2 py-2">Room 2</th>
                        <th className="text-center px-2 py-2">Capacity</th>
                        <th className="text-center px-2 py-2">Mode</th>
                        <th className="text-center px-2 py-2">Status</th>
                        <th className="text-center px-2 py-2">Actions</th>
                      </tr>
                    </thead>

                    <tbody className="divide-y">
                      {filtered.map((r, idx) => {
                        const e = getEditFlags(r);
                        const unread = r.status === "Pending";
                        return (
                          <tr
                            key={r.id}
                            className="hover:bg-gray-50 whitespace-nowrap"
                          >
                            <td className="px-3 py-2 text-center">
                              {isRunning && (
                                <input
                                  type="checkbox"
                                  checked={!!r.selected}
                                  onChange={(ev) =>
                                    setCell(
                                      r.id,
                                      "selected",
                                      ev.target.checked as any
                                    )
                                  }
                                  className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                                  title={`Select row ${idx + 1}`}
                                />
                              )}
                            </td>

                            <td className="px-4 py-2 align-top">
                              {getEditFlags(r).course ? (
                                <div className="flex flex-col gap-1">
                                  {/* Course code dropdown */}
                                  <SelectBox
                                    value={r.course || ""}
                                    onChange={(code) => {
                                      setCell(r.id, "course", code);
                                      const found = courseOptions.find(
                                        (c) => c.code === code
                                      );
                                      setCell(
                                        r.id,
                                        "title",
                                        (found?.title || "") as Row["title"]
                                      );
                                    }}
                                    options={courseOptions.map((c) => c.code)}
                                    placeholder="— Select course —"
                                    className="w-[160px]"
                                  />

                                  {/* Auto-filled course title (read-only text) */}
                                  <div className="text-gray-600 text-xs max-w-xs truncate">
                                    {r.title ||
                                      courseOptions.find(
                                        (c) => c.code === r.course
                                      )?.title ||
                                      "—"}
                                  </div>
                                </div>
                              ) : (
                                // Non-editable rows: same as before
                                <div>
                                  <div className="font-semibold text-emerald-700">
                                    {r.course || "—"}
                                  </div>
                                  <div className="text-gray-600 text-sm">
                                    {r.title || "—"}
                                  </div>
                                </div>
                              )}
                            </td>

                            <td className="px-2 py-2 text-center">
                              <Cell
                                editable={e.units}
                                value={String(r.units ?? "")}
                                onChange={(v) =>
                                  setCell(r.id, "units", v as any)
                                }
                                className="w-[60px]"
                                align="center"
                              />
                            </td>

                            <td className="px-2 py-2 text-center">
                              <Cell
                                editable={e.section}
                                value={r.section}
                                onChange={(v) => setCell(r.id, "section", v)}
                                className="w-[68px]"
                                align="center"
                              />
                            </td>

                            <td className="px-4 py-2">
                              {e.faculty ? (
                                <ComboBox
                                  value={r.faculty ?? ""}
                                  onChange={(v) => {
                                    setCell(r.id, "faculty", v);
                                    const fid = facultyNameToId[v] || "";
                                    setCell(r.id, "faculty_id", fid as any);
                                  }}
                                  options={facultyOptions}
                                  className="w-[200px] md:w-[240px] lg:w-[280px]"
                                />
                              ) : (
                                <span className="block w-[200px] md:w-[240px] lg:w-[280px] truncate">
                                  {r.faculty || "—"}
                                </span>
                              )}
                            </td>

                            <td className="px-2 py-2 text-center">
                              {e.day1 ? (
                                <SelectBox
                                  value={r.day1}
                                  onChange={(v) => setCell(r.id, "day1", v)}
                                  options={DAY_OPTIONS}
                                  className="w-[70px] text-center"
                                />
                              ) : (
                                <span>{r.day1 || "—"}</span>
                              )}
                            </td>

                            <td className="px-2 py-2 text-center">
                              {e.begin1 ? (
                                <SelectBox
                                  value={r.begin1}
                                  onChange={(v) => {
                                    setCell(r.id, "begin1", v);
                                    // *** NEW: Auto-fill End1 on Begin1 change ***
                                    if (v) {
                                      const autoEnd = calculateEndTime(v);
                                      setCell(r.id, "end1", autoEnd);
                                    }
                                    // *******************************************
                                  }}
                                  options={TIME_BEGIN_OPTIONS}
                                  className="w-[70px] text-center"
                                />
                              ) : (
                                <span>{r.begin1 || "—"}</span>
                              )}
                            </td>

                            <td className="px-2 py-2 text-center">
                              {e.end1 ? (
                                <SelectBox
                                  value={r.end1}
                                  onChange={(v) => setCell(r.id, "end1", v)}
                                  options={TIME_END_OPTIONS}
                                  className="w-[70px] text-center"
                                />
                              ) : (
                                <span>{r.end1 || "—"}</span>
                              )}
                            </td>

                            <td className="px-2 py-2 text-center">
                              {e.room1 ? (
                                <SelectBox
                                  value={r.room1 || ""}
                                  onChange={(v) =>
                                    setCell(r.id, "room1", v as Row["room1"])
                                  }
                                  options={ROOM_OPTIONS}
                                  className="w-[100px] text-center"
                                />
                              ) : (
                                <span>{r.room1 || "—"}</span>
                              )}
                            </td>

                            <td className="px-2 py-2 text-center">
                              {e.day2 ? (
                                <SelectBox
                                  value={r.day2}
                                  onChange={(v) => setCell(r.id, "day2", v)}
                                  options={DAY_OPTIONS}
                                  className="w-[70px] text-center"
                                />
                              ) : (
                                <span>{r.day2 || "—"}</span>
                              )}
                            </td>

                            <td className="px-2 py-2 text-center">
                              {e.begin2 ? (
                                <SelectBox
                                  value={r.begin2}
                                  onChange={(v) => {
                                    setCell(r.id, "begin2", v);
                                    // *** NEW: Auto-fill End2 on Begin2 change ***
                                    if (v) {
                                      const autoEnd = calculateEndTime(v);
                                      setCell(r.id, "end2", autoEnd);
                                    }
                                    // *******************************************
                                  }}
                                  options={TIME_BEGIN_OPTIONS}
                                  className="w-[70px] text-center"
                                />
                              ) : (
                                <span>{r.begin2 || "—"}</span>
                              )}
                            </td>

                            <td className="px-2 py-2 text-center">
                              {e.end2 ? (
                                <SelectBox
                                  value={r.end2}
                                  onChange={(v) => setCell(r.id, "end2", v)}
                                  options={TIME_END_OPTIONS}
                                  className="w-[70px] text-center"
                                />
                              ) : (
                                <span>{r.end2 || "—"}</span>
                              )}
                            </td>

                            <td className="px-2 py-2 text-center">
                              {e.room2 ? (
                                <SelectBox
                                  value={r.room2 || ""}
                                  onChange={(v) =>
                                    setCell(r.id, "room2", v as Row["room2"])
                                  }
                                  options={ROOM_OPTIONS}
                                  className="w-[100px] text-center"
                                />
                              ) : (
                                <span>{r.room2 || "—"}</span>
                              )}
                            </td>

                            <td className="px-2 py-2 text-center">
                              <Cell
                                editable={e.capacity}
                                value={String(r.capacity ?? "")}
                                onChange={(v) =>
                                  setCell(r.id, "capacity", v as any)
                                }
                                className="w-[64px]"
                                align="center"
                              />
                            </td>
                            <td className="px-2 py-2 text-center">
                              {e.mode ? (
                                <SelectBox
                                  value={r.mode || ""}
                                  onChange={(v) =>
                                    setCell(r.id, "mode", v as Row["mode"])
                                  }
                                  options={MODE_OPTIONS}
                                  className="w-[80px] text-center"
                                />
                              ) : (
                                <span>{r.mode || "—"}</span>
                              )}
                            </td>
                            <td className="px-2 py-2 text-center">
                              <StatusChip r={r} />
                            </td>

                            <td className="px-2 py-2 text-center">
                              {isRunning && (
                                <div className="relative flex items-center justify-center gap-3 text-emerald-700">
                                  <button
                                    className="relative hover:brightness-110"
                                    title="Message"
                                    onClick={() =>
                                      setReqChange({
                                        open: true,
                                        from: r.faculty || "Faculty",
                                      })
                                    }
                                  >
                                    <MessageSquareText className="h-5 w-5" />
                                    {unread && (
                                      <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-red-600" />
                                    )}
                                  </button>

                                  <button
                                    className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-emerald-700 text-emerald-700 hover:bg-emerald-50"
                                    title="Approve row"
                                  >
                                    <Check
                                      className="h-4 w-4"
                                      strokeWidth={2.5}
                                    />
                                  </button>

                                  {String(r.id).startsWith("manual-") && (
                                    <button
                                      className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-red-600 text-red-600 hover:bg-red-50"
                                      title="Remove this line"
                                      onClick={() =>
                                        setRows((prev) =>
                                          prev.filter((row) => row.id !== r.id)
                                        )
                                      }
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </button>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}

                      {filtered.length === 0 && (
                        <tr>
                          <td
                            colSpan={17}
                            className="px-4 py-10 text-center text-sm text-gray-500"
                          >
                            No data yet. Click{" "}
                            <span className="font-medium">Auto-assign</span> or{" "}
                            <span className="font-medium">Add new line</span> to
                            begin.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="border-t px-4 py-3">
                  <div className="flex justify-start">
                    <button
                      onClick={addRow}
                      className="inline-flex items-center gap-2 rounded-lg border border-gray-400 px-3 py-1.5 text-sm text-gray-800 hover:bg-gray-100"
                      title="Add new line"
                    >
                      <Plus className="h-4 w-4" />
                      Add new line
                    </button>
                  </div>
                  {/* Right: Auto-assign (Run algorithm) - REMOVED from bottom */}
                  {/* <div className="flex items-center gap-2">
                    <button
                      onClick={runAutoAssign}
                      disabled={isAssigning || hasLocalEdits}
                      className="inline-flex items-center gap-2 rounded-md border border-emerald-700 text-emerald-800 bg-white px-3.5 py-2 text-sm font-medium hover:bg-emerald-50 disabled:opacity-60"
                      title={
                        hasLocalEdits
                          ? "Auto-assign is disabled while you have manual edits. Save or refresh first."
                          : "Run auto-assignment algorithm"
                      }
                    >
                      <Play className="h-4 w-4" />
                      {isAssigning ? "Assigning…" : "Auto-assign"}
                    </button>
                  </div> */}
                </div>
              </div>
              {/* ---- Summary section under Load Recommendations ---- */}
              {rows.length > 0 && (
                <div className="mt-6 rounded-xl border border-gray-200 bg-white shadow-sm">
                  <div className="flex items-center justify-between px-4 pt-4 pb-2">
                    <div>
                      <h2 className="text-lg font-semibold">
                        Faculty Load Summary
                      </h2>
                      <p className="text-xs text-gray-500">
                        Total assigned units vs preferred units per faculty for{" "}
                        <span className="font-semibold">
                          {term || "this term"}
                        </span>
                        .
                      </p>
                    </div>

                    {/* Summary internal tabs */}
                    <div className="flex gap-2">
                      <button
                        onClick={() => setSummaryTab("units")}
                        className={cls(
                          "px-3 py-1 text-xs rounded-full border",
                          summaryTab === "units"
                            ? "bg-emerald-600 text-white border-emerald-600"
                            : "bg-white text-gray-700 border-gray-300"
                        )}
                      >
                        Units vs Prefs
                      </button>

                      <button
                        onClick={() => setSummaryTab("second")}
                        className={cls(
                          "px-3 py-1 text-xs rounded-full border",
                          summaryTab === "second"
                            ? "bg-emerald-600 text-white border-emerald-600"
                            : "bg-white text-gray-700 border-gray-300"
                        )}
                      >
                        Violation Flags
                      </button>

                      {/* NEW: Blocked sections tab */}
                      <button
                        onClick={() => setSummaryTab("blocked")}
                        className={cls(
                          "px-3 py-1 text-xs rounded-full border",
                          summaryTab === "blocked"
                            ? "bg-emerald-600 text-white border-emerald-600"
                            : "bg-white text-gray-700 border-gray-300"
                        )}
                      >
                        Blocked Sections
                      </button>
                    </div>
                  </div>

                  {/* Tab 1: Units vs Preferred Units */}
                  {summaryTab === "units" && (
                    <div className="border-t px-4 pb-4 overflow-x-auto w-full">
                      <table className="w-full text-sm table-fixed">
                        <thead className="bg-gray-50 border-y text-gray-700">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold">
                              Faculty
                            </th>
                            <th className="px-3 py-2 text-right font-semibold">
                              Assigned Units
                            </th>
                            <th className="px-3 py-2 text-right font-semibold">
                              Preferred Units
                            </th>
                            <th className="px-3 py-2 text-right font-semibold">
                              Δ (Assigned - Pref)
                            </th>
                            <th className="px-3 py-2 text-center font-semibold">
                              Status
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {facultySummary.length === 0 && (
                            <tr>
                              <td
                                colSpan={5}
                                className="px-3 py-6 text-center text-xs text-gray-500"
                              >
                                No faculty have assignments yet for this term.
                              </td>
                            </tr>
                          )}

                          {facultySummary.map((f) => {
                            const hasPref = f.preferredUnits != null;
                            let statusLabel = "—";
                            let statusTone =
                              "bg-gray-100 text-gray-700 border-gray-200";

                            if (hasPref && f.diff != null) {
                              if (f.diff > 0) {
                                statusLabel = `Over by ${f.diff}`;
                                statusTone =
                                  "bg-red-50 text-red-700 border-red-200";
                              } else if (f.diff < 0) {
                                statusLabel = `Under by ${Math.abs(f.diff)}`;
                                statusTone =
                                  "bg-amber-50 text-amber-700 border-amber-200";
                              } else {
                                statusLabel = "Match";
                                statusTone =
                                  "bg-emerald-50 text-emerald-700 border-emerald-200";
                              }
                            }

                            return (
                              <tr key={f.facultyId || f.facultyName}>
                                <td className="px-3 py-2 align-middle">
                                  <div className="font-medium text-gray-900">
                                    {f.facultyName}
                                  </div>
                                  {f.facultyId && (
                                    <div className="text-[11px] text-gray-400">
                                      {f.facultyId}
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right align-middle">
                                  {f.assignedUnits
                                    .toFixed(1)
                                    .replace(/\.0$/, "")}
                                </td>
                                <td className="px-3 py-2 text-right align-middle">
                                  {hasPref
                                    ? f
                                        .preferredUnits!.toFixed(1)
                                        .replace(/\.0$/, "")
                                    : "—"}
                                </td>
                                <td className="px-3 py-2 text-right align-middle">
                                  {hasPref && f.diff != null
                                    ? f.diff > 0
                                      ? `+${f.diff}`
                                      : `${f.diff}`
                                    : "—"}
                                </td>
                                <td className="px-3 py-2 text-center align-middle">
                                  <span
                                    className={cls(
                                      "inline-flex items-center justify-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                                      statusTone
                                    )}
                                  >
                                    {statusLabel}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Tab 2: Rule / condition flags */}
                  {summaryTab === "second" && (
                    <div className="border-t px-4 pb-6 text-sm">
                      {ruleAlerts.length === 0 ? (
                        <p className="py-4 text-xs text-gray-500">
                          No rule violations detected for the current
                          assignments. 🎉
                        </p>
                      ) : (
                        <div className="mt-2 overflow-x-auto">
                          <table className="w-full text-xs table-fixed">
                            <thead className="bg-gray-50 border-y text-gray-700">
                              <tr>
                                <th className="px-3 py-2 text-left font-semibold">
                                  Rule
                                </th>
                                <th className="px-3 py-2 text-left font-semibold">
                                  Faculty
                                </th>
                                <th className="px-3 py-2 text-left font-semibold">
                                  Row
                                </th>
                                <th className="px-3 py-2 text-left font-semibold">
                                  Message
                                </th>
                                <th className="px-3 py-2 text-center font-semibold">
                                  Severity
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {ruleAlerts.map((a) => (
                                <tr key={a.id}>
                                  <td className="px-3 py-2 align-top">
                                    <span className="font-mono text-[11px]">
                                      {a.rule}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 align-top">
                                    <div className="font-medium text-gray-900">
                                      {a.facultyName || "—"}
                                    </div>
                                    {a.facultyId && (
                                      <div className="text-[10px] text-gray-400">
                                        {a.facultyId}
                                      </div>
                                    )}
                                  </td>
                                  <td className="px-4 py-2 text-sm text-gray-600 text-center">
                                    {a.rowNumber ?? "—"}
                                  </td>
                                  <td className="px-3 py-2 align-top">
                                    {a.message}
                                  </td>
                                  <td className="px-3 py-2 text-center align-top">
                                    <span
                                      className={cls(
                                        "inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold border",
                                        a.severity === "error"
                                          ? "bg-red-50 text-red-700 border-red-200"
                                          : "bg-amber-50 text-amber-700 border-amber-200"
                                      )}
                                    >
                                      {a.severity.toUpperCase()}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {summaryTab === "blocked" && (
                    <div className="px-4 pb-4 border-t">
                      <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 bg-white">
                        <table className="min-w-full divide-y divide-gray-200 text-xs">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-3 py-2 text-left font-semibold text-gray-700">
                                Course
                              </th>
                              <th className="px-3 py-2 text-left font-semibold text-gray-700">
                                Campus
                              </th>
                              <th className="px-3 py-2 text-left font-semibold text-gray-700">
                                Section
                              </th>
                              <th className="px-3 py-2 text-left font-semibold text-gray-700">
                                Slot 1 (Day / Time)
                              </th>
                              <th className="px-3 py-2 text-left font-semibold text-gray-700">
                                Slot 2 (Day / Time)
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {blockedSections.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={5}
                                  className="px-3 py-4 text-center text-gray-500"
                                >
                                  No blocked GE sections for CMPS0002.
                                </td>
                              </tr>
                            ) : (
                              blockedSections.map((b) => {
                                const slot1 =
                                  b.day1 && b.begin1 && b.end1
                                    ? `${b.day1} ${toPrettyTime(
                                        b.begin1
                                      )}–${toPrettyTime(b.end1)}`
                                    : "—";

                                const slot2 =
                                  b.day2 && b.begin2 && b.end2
                                    ? `${b.day2} ${toPrettyTime(
                                        b.begin2
                                      )}–${toPrettyTime(b.end2)}`
                                    : "—";

                                return (
                                  <tr key={b.rowId}>
                                    <td className="px-3 py-2 text-gray-900 font-medium">
                                      {b.course || "—"}
                                    </td>
                                    <td className="px-3 py-2 text-gray-700">
                                      {b.campusName || b.campusId || "—"}
                                    </td>
                                    <td className="px-3 py-2 text-gray-700">
                                      {b.section || "—"}
                                    </td>
                                    <td className="px-3 py-2 text-gray-700">
                                      {slot1}
                                    </td>
                                    <td className="px-3 py-2 text-gray-700">
                                      {slot2}
                                    </td>
                                  </tr>
                                );
                              })
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </main>
          )}
        </>
      )}

      <ApproveModal
        open={showApprove}
        onClose={() => setShowApprove(false)}
        onApprove={() => {
          (async () => {
            try {
              if (userId) {
                await submitOmLoadAssignment(userId, { rows }, "approve"); // <-- key change
              }
              // pull fresh data so you see persisted faculty + any created schedules
              await loadFromServer();
              setApproved(true);
            } finally {
              setShowApprove(false);
            }
          })();
        }}
      />

      <SendModal
        open={showSend}
        onClose={() => setShowSend(false)}
        rows={selectedRows}
      />

      <RequestChangeModal
        open={reqChange.open}
        from={reqChange.from}
        onClose={() => setReqChange({ open: false })}
      />

<NewSectionModal
        open={showNewSectionModal}
        onClose={() => setShowNewSectionModal(false)}
        courseOptions={courseOptions}
        onSave={({ course, section, units, campus_id }) => {
          // create a new manual row that behaves like other rows,
          // but with the extra campus_id attached
          const title =
            courseOptions.find((c) => c.code === course)?.title || "";

          setRows((prev) => [
            ...prev,
            {
              id: `manual-${Date.now()}`,
              course,
              title,
              units: units ? (Number(units) || "") : "",
              section,
              faculty: "",
              faculty_id: undefined,
              day1: "",
              begin1: "",
              end1: "",
              room1: "",
              day2: "",
              begin2: "",
              end2: "",
              room2: "",
              capacity: "",
              mode: "",
              status: "",
              editable: true,
              campus_id, 
            },
          ]);

          setMode("manual");
          setApproved(false);
          setHasLocalEdits(true);
          setShowNewSectionModal(false);
        }}
      />

    </AppShell>
  );
}
