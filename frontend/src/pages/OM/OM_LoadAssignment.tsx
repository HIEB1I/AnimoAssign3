import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Outlet, useLocation } from "react-router-dom";
import AppShell from "../../base/AppShell";
import { runOmAutoAssign } from "../../api.ts";
import { getSocket } from "../../realtime/socket";
import { emitAck } from "../../realtime/ack";
import {
  submitOmLoadAssignment,
  saveOmSectionRemarks,
  importOmShsCsv,
  notifyChairLoadRecommendation,
  sendOmLoadAssignmentsToFaculty,
  getOmLoadAssignmentRfc,
  respondOmLoadAssignmentRfc,
  getOmSubmittedCourses,
  saveOmNewLine,
  applyOmPendingOverrides,
} from "../../api";

import {
  getOmLoadAssignmentList,
  getOmLoadAssignmentTerms,
  getOmLoadAssignmentProfile,
  getAllFaculty,
  getOmFacultyWithDeloadings,
  getOmFacultyDeloadings,
  type DeloadingRow,
} from "../../api";

// Some deployments may not yet expose a typed api.ts helper for this.
// We call the endpoint directly to keep OM reminders working and avoid TS export mismatch.
async function runOmSubmitDeadlineReminders(): Promise<any> {
  const resp = await fetch("/api/notifications/run-om-submit-deadline-reminders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!resp.ok) {
    throw new Error(`Failed to run OM submit deadline reminders (${resp.status})`);
  }
  try {
    return await resp.json();
  } catch {
    return { ok: true };
  }
}


// Fetch the planning term (term after the current anchor) without hardcoding.
// current_term_id = terms.is_current === true
// planning_term_id = term immediately after current_term_id
async function getOmPlanningTermIds(): Promise<{ current_term_id?: string; planning_term_id?: string }> {
  const resp = await fetch("/api/om/load-assignment/planning-term");
  if (!resp.ok) {
    throw new Error(`Failed to fetch planning term ids (${resp.status})`);
  }
  return await resp.json();
}

import { cls } from "../../utilities/cls";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search as SearchIcon,
  Play,
  RefreshCcw,
  Send,
  CalendarClock,
  Info,
  Plus,
  MessageSquareText,
  Copy,
  Archive,
  Undo2,
  Redo2,
  X,
  Upload,
  Download,
  Save,
  Trash2,
  Inbox,
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


// NOTE: Deadline UI uses the same banner style as APO (amber / red / slate) and
// computes the countdown inline at render time.

/* ---------------- Small inputs ---------------- */

// 1. Define the Option type to support both formats
type SelectOption = string | { value: string; label: string };

function SelectBox({
  value,
  onChange,
  options,
  placeholder = "— Select —",
  className = "",
  buttonClassName = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[]; // Updated to support objects
  placeholder?: string;
  className?: string;
  /** Optional: override/extend the button styling (useful to match other dropdowns) */
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);

  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  // Helper to extract the label from an option (string or object)
  const getLabel = (opt: SelectOption) =>
    typeof opt === "string" ? opt : opt.label;
  // Helper to extract the value from an option
  const getValue = (opt: SelectOption) =>
    typeof opt === "string" ? opt : opt.value;

  // 2. Updated hover logic to find index based on value
  const [hover, setHover] = useState<number>(() =>
    Math.max(
      0,
      options.findIndex((o) => getValue(o) === value)
    )
  );

  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const recalcMenu = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 6;
    const availBelow = Math.max(120, window.innerHeight - rect.bottom - margin);
    setMenuPos({
      top: Math.round(rect.bottom + margin),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      maxHeight: Math.round(Math.min(320, availBelow)),
    });
  }, []);

  useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !btnRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    recalcMenu();
    const onScrollOrResize = () => recalcMenu();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, recalcMenu]);

  // Find the label of the currently selected value for the button display
  const selectedOption = options.find((o) => getValue(o) === value);
  const displayLabel = selectedOption ? getLabel(selectedOption) : null;

  return (
    <div className={cls("relative min-w-[120px]", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cls(
          "w-full rounded-md border border-gray-300 bg-white",
          // Keep consistent typography with the toolbar buttons/inputs
          "px-1.5 py-1 text-center text-sm",
          "shadow-sm focus:ring-2 focus:ring-emerald-500/30",
          buttonClassName
        )}
      >
        {displayLabel || <span className="text-gray-400">{placeholder}</span>}
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2" />
      </button>

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={listRef}
            className="fixed z-[5000] overflow-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg"
            style={{
              top: menuPos.top,
              left: menuPos.left,
              width: menuPos.width,
              maxHeight: menuPos.maxHeight,
            }}
          >
            {options.map((opt, i) => {
              const optValue = getValue(opt);
              const optLabel = getLabel(opt);
              const isSelected = optValue === value;

              return (
                <div
                  key={optValue}
                  onMouseEnter={() => setHover(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(optValue);
                    setOpen(false);
                  }}
                  className={cls(
                    "cursor-pointer px-3 py-1.5 text-sm",
                    isSelected
                      ? "bg-emerald-50 text-emerald-700 font-medium"
                      : hover === i
                      ? "bg-emerald-50"
                      : ""
                  )}
                >
                  {optLabel}
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

function normalizeTimeToHHMM(input: string): string {
  const digits = (input || "").replace(/\D/g, "");
  if (!digits) return "";
  const d = digits.length === 3 ? "0" + digits : digits;
  if (d.length !== 4) return "";
  const hh = parseInt(d.slice(0, 2), 10);
  const mm = parseInt(d.slice(2, 4), 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return "";
  if (hh < 0 || hh > 23) return "";
  if (mm < 0 || mm > 59) return "";
  return d;
}

function normalizeDayToCode(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "";

  // Allow already-stored single-letter codes.
  const code = raw.length === 1 ? raw.toUpperCase() : "";
  if (["M", "T", "W", "H", "F", "S"].includes(code)) return code;

  const u = raw.toUpperCase().replace(/\./g, "").trim();
  const compact = u.replace(/\s+/g, "");

  // Common day name/abbrev normalization -> OM codes (H = Thursday).
  if (compact === "MON" || compact === "MONDAY") return "M";
  if (compact === "TUE" || compact === "TUES" || compact === "TUESDAY")
    return "T";
  if (compact === "WED" || compact === "WEDNESDAY") return "W";
  if (
    compact === "TH" ||
    compact === "THU" ||
    compact === "THUR" ||
    compact === "THURS" ||
    compact === "THURSDAY"
  )
    return "H";
  if (compact === "FRI" || compact === "FRIDAY") return "F";
  if (compact === "SAT" || compact === "SATURDAY") return "S";

  // Anything else is invalid for this grid.
  return "";
}

/**
 * The backend can return times as "HH:MM" (or compact "HMM") while the OM UI stores
 * dropdown values as 4-digit "HHMM". Normalize inbound server values so SelectBox values
 * still match TIME_*_OPTIONS after refresh/save/send.
 */
function normalizeServerTimeToHHMM(input: any): string {
  if (input === null || input === undefined) return "";
  return normalizeTimeToHHMM(String(input));
}

function TimeBeginInput({
  value,
  onChange,
  options,
  placeholder = "e.g. 0730",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [text, setText] = useState(value || "");

  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const recalcMenu = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 6;
    const availBelow = Math.max(120, window.innerHeight - rect.bottom - margin);
    setMenuPos({
      top: Math.round(rect.bottom + margin),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      maxHeight: Math.round(Math.min(320, availBelow)),
    });
  }, []);

  const getValue = (o: SelectOption) => (typeof o === "string" ? o : o.value);
  const getLabel = (o: SelectOption) =>
    typeof o === "string" ? o : o.label ?? o.value;

  useEffect(() => {
    // Keep input in sync when not actively typing
    if (!open) setText(value || "");
  }, [value, open]);

  useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !inputRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    recalcMenu();
    const onScrollOrResize = () => recalcMenu();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, recalcMenu]);

  const filtered = options.filter((o) => {
    if (!text) return true;
    const q = text.toLowerCase();
    const v = getValue(o).toLowerCase();
    const l = getLabel(o).toLowerCase();
    return v.includes(q) || l.includes(q);
  });

  const pick = (optValue: string) => {
    setText(optValue);
    onChange(optValue);
    setOpen(false);
  };

  const handleBlur = () => {
    // allow click on dropdown items
    setTimeout(() => setOpen(false), 120);

    const normalized = normalizeTimeToHHMM(text);
    if (normalized) {
      setText(normalized);
      onChange(normalized);
    } else {
      // revert to last valid value
      setText(value || "");
    }
  };

  return (
    <div className={cls("relative", className)}>
      <input
        ref={inputRef}
        className={cls(
          "w-full rounded-md border border-gray-300 bg-white",
          "px-1.5 py-1 text-center text-[13px] leading-tight",
          "focus:outline-none focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300"
        )}
        value={text}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onBlur={handleBlur}
      />

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={listRef}
            className="fixed z-[5000] overflow-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg"
            style={{
              top: menuPos.top,
              left: menuPos.left,
              width: menuPos.width,
              maxHeight: menuPos.maxHeight,
            }}
          >
            {filtered.length ? (
              filtered.map((opt, i) => {
                const optValue = getValue(opt);
                const optLabel = getLabel(opt);
                const isSelected = optValue === value;

                return (
                  <div
                    key={optValue}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHover(i)}
                    onClick={() => pick(optValue)}
                    className={cls(
                      "cursor-pointer px-3 py-1.5 text-[13px]",
                      isSelected
                        ? "bg-emerald-50 text-emerald-700 font-medium"
                        : hover === i
                        ? "bg-emerald-50"
                        : ""
                    )}
                  >
                    {optLabel}
                  </div>
                );
              })
            ) : (
              <div className="px-3 py-2 text-[13px] text-gray-400">
                No matches
              </div>
            )}
          </div>,
          document.body
        )
      }
    </div>
  );
}

function DayInput({
  value,
  onChange,
  options,
  placeholder = "e.g. M or Monday",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [text, setText] = useState(value || "");

  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const recalcMenu = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 6;
    const availBelow = Math.max(120, window.innerHeight - rect.bottom - margin);
    setMenuPos({
      top: Math.round(rect.bottom + margin),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      maxHeight: Math.round(Math.min(320, availBelow)),
    });
  }, []);

  const getValue = (o: SelectOption) => (typeof o === "string" ? o : o.value);
  const getLabel = (o: SelectOption) =>
    typeof o === "string" ? o : o.label ?? o.value;

  useEffect(() => {
    if (!open) setText(value || "");
  }, [value, open]);

  useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !inputRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    recalcMenu();
    const onScrollOrResize = () => recalcMenu();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, recalcMenu]);

  const filtered = options.filter((o) => {
    if (!text) return true;
    const q = text.toLowerCase();
    const v = getValue(o).toLowerCase();
    const l = getLabel(o).toLowerCase();
    return v.includes(q) || l.includes(q);
  });

  const pick = (optValue: string) => {
    setText(optValue);
    onChange(optValue);
    setOpen(false);
  };

  const handleBlur = () => {
    // allow click on dropdown items
    setTimeout(() => setOpen(false), 120);

    const normalized = normalizeDayToCode(text);
    if (normalized) {
      setText(normalized);
      onChange(normalized);
    } else {
      // revert to last valid value
      setText(value || "");
    }
  };

  return (
    <div className={cls("relative", className)}>
      <input
        ref={inputRef}
        className={cls(
          "w-full rounded-md border border-gray-300 bg-white",
          "px-1.5 py-1 text-center text-[13px] leading-tight",
          "focus:outline-none focus:ring-2 focus:ring-emerald-200 focus:border-emerald-300"
        )}
        value={text}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onBlur={handleBlur}
      />

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={listRef}
            className="fixed z-[5000] overflow-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg"
            style={{
              top: menuPos.top,
              left: menuPos.left,
              width: menuPos.width,
              maxHeight: menuPos.maxHeight,
            }}
          >
            {filtered.length ? (
              filtered.map((opt, i) => {
                const optValue = getValue(opt);
                const optLabel = getLabel(opt);
                const isSelected = optValue === value;

                return (
                  <div
                    key={optValue}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHover(i)}
                    onClick={() => pick(optValue)}
                    className={cls(
                      "cursor-pointer px-3 py-1.5 text-sm",
                      isSelected
                        ? "bg-emerald-50 text-emerald-700 font-medium"
                        : hover === i
                        ? "bg-emerald-50"
                        : ""
                    )}
                  >
                    {optLabel}
                  </div>
                );
              })
            ) : (
              <div className="px-3 py-2 text-sm text-gray-400">No matches</div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
function TextBox({
  value,
  onChange,
  onBlur,
  placeholder = "",
  className = "",
  disabled = false,
  align = "left",
}: {

  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
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
  onBlur={onBlur}
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
  clearable = true,
  commitOnSelectOnly = false,
}: {
  value?: string | null;
  onChange: (v: string) => void;
  options?: (string | null | undefined)[];
  placeholder?: string;
  className?: string;
  /** Show an "x" button to clear the current selection/text. */
  clearable?: boolean;
  /** If true, typing only filters; value is committed only when selecting an option (or clearing). */
  commitOnSelectOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value ?? "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const recalcMenu = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 6;
    const availBelow = Math.max(140, window.innerHeight - rect.bottom - margin);
    setMenuPos({
      top: Math.round(rect.bottom + margin),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      maxHeight: Math.round(Math.min(360, availBelow)),
    });
  }, []);

  useEffect(() => setQuery(value ?? ""), [value]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (
        !wrapRef.current.contains(e.target as Node) &&
        !listRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
        // If we're in "select-only" mode, revert any uncommitted typing
        // back to the last committed value when closing.
        if (commitOnSelectOnly) setQuery(value ?? "");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [commitOnSelectOnly, value]);

  useLayoutEffect(() => {
    if (!open) return;
    recalcMenu();
    const onScrollOrResize = () => recalcMenu();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, recalcMenu]);

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
        ref={inputRef}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 pr-14 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
        value={query ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          setQuery(v);
          setOpen(true);
          if (!commitOnSelectOnly) onChange(v);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // When commitOnSelectOnly is true, typing should only filter options.
          // If the user tabs/clicks away without selecting, snap back to the
          // last committed value so the input can't show a non-existent course.
          if (commitOnSelectOnly) setQuery(value ?? "");
        }}
        placeholder={placeholder}
      />

      {clearable && (query ?? "").trim().length > 0 && (
        <button
          type="button"
          aria-label="Clear faculty"
          title="Clear"
          className="absolute right-7 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
          onMouseDown={(e) => {
            // Prevent input blur when clicking the clear button.
            e.preventDefault();
          }}
          onClick={() => {
            setQuery("");
            onChange("");
            setOpen(true);
            // Keep focus so the OM can immediately choose another faculty.
            inputRef.current?.focus();
          }}
        >
          <X className="h-4 w-4" />
        </button>
      )}
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={listRef}
            className="fixed z-[5000] overflow-auto rounded-xl border border-gray-300 bg-white shadow-xl"
            style={{
              top: menuPos.top,
              left: menuPos.left,
              width: menuPos.width,
              maxHeight: menuPos.maxHeight,
            }}
          >
            {filtered.length === 0 ? (
              <div className="px-4 py-2 text-sm text-gray-500">
                No matches{" "}
                {(options?.length ?? 0) === 0 && " (no faculty loaded)"}
              </div>
            ) : (
              filtered.map((opt) => (
                <button
                  key={opt}
                  onMouseDown={(e) => {
                    // Prevent the input from blurring before we handle the click.
                    e.preventDefault();
                  }}
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
          </div>,
          document.body
        )
      }
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
  /** True when this row has already been sent/forwarded to the faculty (proposal created). */
  forwarded_to_faculty?: boolean;
  /** True when a forwarded row was edited after it was last sent to faculty. */
  reforward_needed?: boolean;
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
  status?:
    | ""
    | "Confirmed"
    | "Approved"
    | "Pending"
    | "Unassigned"
    | "Conflict";
  pending_rfc?: boolean;
  conflictNote?: string;
  editable?: boolean;
  campus_id?: string;
  /** When OM has already finalized this course for the faculty */
  finalized?: boolean;

  /** True if this row's campus deadline has passed (edits saved as draft only). */
  is_past_deadline?: boolean;
  /** True if OM has a pending post-deadline draft for this row. */
  has_pending_override?: boolean;
  /** Timestamp of last draft update (best-effort). */
  pending_override_updated_at?: any;
};

type ChangeItem = { key: string; label: string };
type EditedDetail = { field: string; from: string; to: string };
type EditedItem = { key: string; label: string; details: EditedDetail[] };
type DetectedChanges = {
  added: ChangeItem[];
  edited: EditedItem[];
  deleted: ChangeItem[];
};

const _rowLabel = (r: Row) => {
  const course = (r.course || "").trim();
  const sec = (r.section || "").trim();
  const title = (r.title || "").trim();
  const fac = (r.faculty || "").trim();
  const base = [course, sec].filter(Boolean).join(" ") || r.id;
  const t = title ? ` — ${title}` : "";
  const f = fac ? ` (${fac})` : "";
  return `${base}${t}${f}`;
};

const detectRowChanges = (baseline: Row[], current: Row[]): DetectedChanges => {
  const bMap = new Map(baseline.map((r) => [r.id, r] as const));
  const cMap = new Map(current.map((r) => [r.id, r] as const));

  const added: ChangeItem[] = [];
  const deleted: ChangeItem[] = [];
  const edited: EditedItem[] = [];

  // Added
  for (const [id, r] of cMap) {
    if (!bMap.has(id)) added.push({ key: id, label: _rowLabel(r) });
  }

  // Deleted
  for (const [id, r] of bMap) {
    if (!cMap.has(id)) deleted.push({ key: id, label: _rowLabel(r) });
  }

  // Edited
  const fields: Array<[keyof Row, string]> = [
    ["course", "Course"],
    ["title", "Title"],
    ["units", "Units"],
    ["section", "Section"],
    ["faculty", "Faculty"],
    ["day1", "Day 1"],
    ["begin1", "Begin 1"],
    ["end1", "End 1"],
    ["room1", "Room 1"],
    ["day2", "Day 2"],
    ["begin2", "Begin 2"],
    ["end2", "End 2"],
    ["room2", "Room 2"],
    ["capacity", "Capacity"],
    ["mode", "Mode"],
  ];

  const fmt = (v: any) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return String(v);
    return String(v);
  };

  for (const [id, b] of bMap) {
    const c = cMap.get(id);
    if (!c) continue;
    const details: EditedDetail[] = [];
    for (const [k, label] of fields) {
      const bv = fmt((b as any)[k]);
      const cv = fmt((c as any)[k]);
      if (bv !== cv)
        details.push({ field: label, from: bv || "—", to: cv || "—" });
    }
    if (details.length) edited.push({ key: id, label: _rowLabel(c), details });
  }

  const byLabel = (a: { label: string }, b: { label: string }) =>
    a.label.localeCompare(b.label);

  return {
    added: added.sort(byLabel),
    edited: edited.sort(byLabel),
    deleted: deleted.sort(byLabel),
  };
};

// NOTE: This helper is kept for parity with the existing forward review UI.
// Some deployments may not wire it yet; reference it to avoid TS noUnusedLocals warnings.
void detectRowChanges;

const ForwardReviewModal: React.FC<{
  open: boolean;
  changes: DetectedChanges | null;
  title: string;
  subtitle: React.ReactNode;
  confirmText: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}> = ({ open, changes, title, subtitle, confirmText, onClose, onConfirm }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  if (!open) return null;

  const hasAny =
    !!changes &&
    (changes.added.length > 0 ||
      changes.edited.length > 0 ||
      changes.deleted.length > 0);

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
      {/* Wider + taller so "Detected changes" is easier to read */}
      <div className="w-full max-w-4xl rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full border-2 border-emerald-600 text-emerald-700">
          <Send className="h-8 w-8" strokeWidth={2.5} />
        </div>

        <h3 className="mb-2 text-center text-2xl font-semibold">{title}</h3>

        <p className="mx-auto mb-4 max-w-md text-center text-sm text-neutral-600">
          {subtitle}
        </p>

        <div className="mb-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-gray-700">
              Detected changes
            </div>
            {!hasAny ? (
              <div className="text-xs text-slate-500">
                No differences found.
              </div>
            ) : null}
          </div>

          <div className="mt-2 max-h-[65vh] overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-4">
            {changes ? (
              <div className="space-y-4">
                {/* Added */}
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Added ({changes.added.length})
                  </div>
                  {changes.added.length ? (
                    <ul className="list-disc space-y-1 pl-5 text-sm text-slate-800">
                      {changes.added.map((a) => (
                        <li key={a.key}>{a.label}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-sm text-slate-500">None</div>
                  )}
                </div>

                {/* Edited */}
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Edited ({changes.edited.length})
                  </div>
                  {changes.edited.length ? (
                    <ul className="space-y-2">
                      {changes.edited.map((e) => (
                        <li
                          key={e.key}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2"
                        >
                          <div className="text-sm font-medium text-slate-900">
                            {e.label}
                          </div>
                          {e.details.length ? (
                            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
                              {e.details.map((d, idx) => (
                                <li key={idx}>
                                  <span className="font-medium text-slate-800">
                                    {d.field}:
                                  </span>{" "}
                                  <span className="text-slate-600">
                                    {d.from}
                                  </span>{" "}
                                  <span className="text-slate-400">→</span>{" "}
                                  <span className="text-slate-900">{d.to}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <div className="mt-1 text-xs text-slate-500">
                              Edited
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-sm text-slate-500">None</div>
                  )}
                </div>

                {/* Deleted */}
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Deleted ({changes.deleted.length})
                  </div>
                  {changes.deleted.length ? (
                    <ul className="list-disc space-y-1 pl-5 text-sm text-slate-800">
                      {changes.deleted.map((d) => (
                        <li key={d.key}>{d.label}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-sm text-slate-500">None</div>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-500">
                No change summary available.
              </div>
            )}
          </div>
        </div>

        {error ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            disabled={busy}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onConfirm();
              } catch (e: any) {
                setError(e?.message || "Action failed.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

function ArchivedLoadsSummary({
  rows,
  termLabel,
}: {
  rows: Row[];
  termLabel: string;
}) {
  const summary = useMemo(() => {
    const groups = new Map<
      string,
      { faculty: string; sections: number; units: number; courses: Set<string> }
    >();

    let totalSections = 0;
    let totalUnits = 0;
    let assignedSections = 0;
    let unassignedSections = 0;

    for (const r of rows) {
      totalSections += 1;

      const units = typeof r.units === "number" ? r.units : 0;
      totalUnits += units;

      const facultyName = (r.faculty || "").trim() || "Unassigned";
      const isUnassigned = facultyName === "Unassigned";
      if (isUnassigned) unassignedSections += 1;
      else assignedSections += 1;

      const key = r.faculty_id || facultyName;

      const g = groups.get(key) || {
        faculty: facultyName,
        sections: 0,
        units: 0,
        courses: new Set<string>(),
      };

      g.sections += 1;
      g.units += units;
      if (r.course) g.courses.add(r.course);

      groups.set(key, g);
    }

    const items = Array.from(groups.values()).sort((a, b) => {
      if (a.faculty === "Unassigned" && b.faculty !== "Unassigned") return 1;
      if (b.faculty === "Unassigned" && a.faculty !== "Unassigned") return -1;
      return a.faculty.localeCompare(b.faculty);
    });

    return {
      items,
      totalSections,
      totalUnits,
      assignedSections,
      unassignedSections,
    };
  }, [rows]);

  return (
    <div className="mt-3 rounded-xl border border-gray-300 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-gray-200 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-gray-900">
            Archived Load Summary
          </div>
          <div className="text-xs text-gray-600">
            {termLabel || "Archived term"}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-gray-100 px-2 py-1 text-gray-700">
            Sections: {summary.totalSections}
          </span>
          <span className="rounded-full bg-gray-100 px-2 py-1 text-gray-700">
            Units: {summary.totalUnits}
          </span>
          <span className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-800">
            Assigned: {summary.assignedSections}
          </span>
          <span className="rounded-full bg-amber-50 px-2 py-1 text-amber-900">
            Unassigned: {summary.unassignedSections}
          </span>
        </div>
      </div>

      <div className="max-h-[58vh] overflow-x-auto overflow-y-auto">
        <table className="min-w-full text-sm table-fixed border-collapse">
          {/* Evenly distribute columns in archived load summary table */}
          <colgroup>
            <col className="w-1/4" />
            <col className="w-1/4" />
            <col className="w-1/4" />
            <col className="w-1/4" />
          </colgroup>

          <thead className="bg-gray-50 text-gray-900 sticky top-0 z-10">
            <tr>
              <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">
                Faculty
              </th>
              <th className="border-b border-gray-200 px-3 py-2 text-right font-semibold">
                Sections
              </th>
              <th className="border-b border-gray-200 px-3 py-2 text-right font-semibold">
                Units
              </th>
              <th className="border-b border-gray-200 px-3 py-2 text-left font-semibold">
                Courses
              </th>
            </tr>
          </thead>

          <tbody>
            {summary.items.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="border-b border-gray-100 px-3 py-6 text-center text-gray-500"
                >
                  No archived loads found for this term.
                </td>
              </tr>
            ) : (
              summary.items.map((g, i) => {
                const courseList = Array.from(g.courses);
                const preview = courseList.slice(0, 4).join(", ");
                const more =
                  courseList.length > 4
                    ? ` +${courseList.length - 4} more`
                    : "";

                return (
                  <tr key={`${g.faculty}-${i}`} className="hover:bg-gray-50">
                    <td className="border-b border-gray-100 px-3 py-2 text-gray-900">
                      {g.faculty}
                    </td>
                    <td className="border-b border-gray-100 px-3 py-2 text-right text-gray-900">
                      {g.sections}
                    </td>
                    <td className="border-b border-gray-100 px-3 py-2 text-right text-gray-900">
                      {g.units}
                    </td>
                    <td className="border-b border-gray-100 px-3 py-2 text-gray-700">
                      <div className="text-xs">
                        <span className="font-medium">{courseList.length}</span>{" "}
                        <span className="text-gray-500">course(s)</span>
                      </div>
                      {courseList.length > 0 && (
                        <div
                          className="mt-0.5 truncate text-[11px] text-gray-500"
                          title={courseList.join(", ")}
                        >
                          {preview}
                          {more}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Used for hard validation before sending proposals to faculty
export type MissingFieldRow = {
  course: string;
  section: string;
  faculty: string;
  fields: string[];
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

const DAY_OPTIONS = [
  { value: "M", label: "Monday" },
  { value: "T", label: "Tuesday" },
  { value: "W", label: "Wednesday" },
  { value: "H", label: "Thursday" },
  { value: "F", label: "Friday" },
  { value: "S", label: "Saturday" },
];
const MODE_OPTIONS = ["FOL", "HYB", "F2F"];
const ROOM_OPTIONS = ["Online", "Classroom", "Comlab"];
const TIME_BEGIN_OPTIONS = [
  // Match APO time-band menu content: show full band label in menu,
  // but keep stored/selected value as HHMM (shown in-cell via SelectBox displayLabel).
  { value: "0730", label: "0730 - 0900" },
  { value: "0915", label: "0915 - 1045" },
  { value: "1100", label: "1100 - 1230" },
  { value: "1245", label: "1245 - 1415" },
  { value: "1430", label: "1430 - 1600" },
  { value: "1615", label: "1615 - 1745" },
  { value: "1800", label: "1800 - 1930" },
  { value: "1945", label: "1945 - 2100" },
];

const TIME_END_OPTIONS = [
  // End-time dropdown should show only the end time (not the full band).
  // Stored/selected value remains HHMM.
  { value: "0900", label: "0900" },
  { value: "1045", label: "1045" },
  { value: "1230", label: "1230" },
  { value: "1415", label: "1415" },
  { value: "1600", label: "1600" },
  { value: "1745", label: "1745" },
  { value: "1930", label: "1930" },
  { value: "2100", label: "2100" },
];

/**
 * Display helper:
 * - If the value exists in the provided option list (string or {value,label}), show its label.
 * - Otherwise, fall back to a normalized HH:MM display for raw values like "1130" or "11:30".
 */
function displayTimeFromOptions(
  value: string | null | undefined,
  options: SelectOption[]
): string {
  if (!value) return "";

  const raw = String(value).trim();
  const match = options.find((o) =>
    typeof o === "string" ? o === raw : o.value === raw
  );
  if (match) return typeof match === "string" ? match : match.label;

  // Normalize common raw formats to HH:MM for display.
  // Accept "HMM", "HHMM", "H:MM", "HH:MM".
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length === 3) {
    const hh = "0" + digits.slice(0, 1);
    const mm = digits.slice(1);
    return `${hh}:${mm}`;
  }
  if (digits.length === 4) {
    const hh = digits.slice(0, 2);
    const mm = digits.slice(2);
    return `${hh}:${mm}`;
  }

  return raw;
}

/**
 * "Begin" options may be labeled as a time band (e.g., "07:30 - 09:00").
 * In confirmation/previews we want to show only the start time.
 */
function displayBeginTimeOnly(value: string | null | undefined): string {
  const label = displayTimeFromOptions(value, TIME_BEGIN_OPTIONS);
  if (!label) return "";
  const [start] = label.split("-");
  return (start || label).trim();
}

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

  // Display rule:
  // - If the row was already sent to faculty, show status as "Sent" (instead of "Pending"),
  //   but only when it does not require a re-forward.
  // - Pending is reserved for rows not yet sent to faculty.
  const displayStatus =
    r.forwarded_to_faculty &&
    !r.reforward_needed &&
    (!r.status || r.status === "Pending")
      ? "Sent"
      : r.status;

  if (!displayStatus) return <span className="inline-block w-24 h-6" />;

  const tone =
    displayStatus === "Sent"
      ? "bg-sky-100 text-sky-800"
      : displayStatus === "Confirmed" || displayStatus === "Approved"
      ? "bg-green-100 text-green-700"
      : displayStatus === "Pending"
      ? "bg-yellow-100 text-yellow-700"
      : displayStatus === "Unassigned"
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
      {displayStatus === "Conflict" ? "Conflict" : displayStatus}
      {(r as any).has_pending_override ? (
        <span className="ml-2 inline-flex items-center rounded-full bg-amber-200/60 px-2 py-0.5 text-[10px] font-bold text-amber-900">Draft</span>
      ) : null}
      {displayStatus === "Conflict" && r.conflictNote && show && (
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

const SendModal = ({
  open,
  onClose,
  rows,
  termLabel,
  onSend,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  rows: Row[];
  termLabel?: string;
  onSend: (rows: Row[]) => Promise<void>;
  onToast?: (message: string, kind?: "success" | "error") => void;
}) => {
  const [sending, setSending] = useState(false);
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
            Teaching Load Assignments for {termLabel || "Current Term"}
          </h3>
          <div className="font-bold mt-0.5 text-[18px]">
            To:{" "}
            {Array.from(
              new Set(rows.map((r) => r.faculty || "Unassigned"))
            ).join(", ")}
          </div>
        </div>

        <p className="mt-5 text-[16px] text-gray-700">
          Please let me know if the following teaching load below is acceptable
          to you:
        </p>

        <div className="mt-4 max-h-[60vh] overflow-auto pr-1">
          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full table-fixed text-[13px]">
              <colgroup>
                <col className="w-[240px]" />
                <col className="w-[92px]" />
                <col className="w-[82px]" />
                <col className="w-[92px]" />
                <col className="w-[92px]" />
                <col className="w-[110px]" />
                <col className="w-[82px]" />
                <col className="w-[92px]" />
                <col className="w-[92px]" />
                <col className="w-[110px]" />
                <col className="w-[96px]" />
              </colgroup>
              <thead className="bg-gray-50 text-gray-700">
                <tr className="[&>th]:border-b [&>th]:border-gray-200">
                  <th className="px-4 py-3 text-left font-semibold">
                    Course Code &amp; Title
                  </th>
                  <th className="px-4 py-3 text-left font-semibold">Section</th>
                  <th className="px-4 py-3 text-left font-semibold">Day 1</th>
                  <th className="px-4 py-3 text-left font-semibold">Begin 1</th>
                  <th className="px-4 py-3 text-left font-semibold">End 1</th>
                  <th className="px-4 py-3 text-left font-semibold">Room 1</th>
                  <th className="px-4 py-3 text-left font-semibold">Day 2</th>
                  <th className="px-4 py-3 text-left font-semibold">Begin 2</th>
                  <th className="px-4 py-3 text-left font-semibold">End 2</th>
                  <th className="px-4 py-3 text-left font-semibold">Room 2</th>
                  <th className="px-4 py-3 text-left font-semibold">Mode</th>
                </tr>
              </thead>
              <tbody className="text-gray-900">
                {byFaculty.map(([faculty, items]) => (
                  <React.Fragment key={faculty}>
                    {manyGroups && (
                      <tr className="bg-white">
                        <td
                          colSpan={11}
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
                          <div className="leading-tight">
                            <div className="font-semibold text-gray-900">
                              {r.course || "—"}
                            </div>
                            <div className="mt-0.5 text-[12px] text-gray-600">
                              {r.title || "—"}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {r.section || "—"}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {r.day1 || "—"}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {displayBeginTimeOnly(r.begin1) || "—"}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {displayTimeFromOptions(r.end1, TIME_END_OPTIONS) ||
                            "—"}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {r.room1 || "—"}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {r.day2 || "—"}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {displayBeginTimeOnly(r.begin2) || "—"}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {displayTimeFromOptions(r.end2, TIME_END_OPTIONS) ||
                            "—"}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {r.room2 || "—"}
                        </td>
                        <td className="px-4 py-3 align-middle text-gray-800">
                          {r.mode || (r as any).room_type || "—"}
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={11}
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
            disabled={sending || rows.length === 0}
            onClick={async () => {
              setSending(true);
              try {
                await onSend(rows);
                onClose();
              } catch (e: any) {
                onToast?.(e?.message || "Failed to send to faculty.", "error");
              } finally {
                setSending(false);
              }
            }}
            className={cls(
              "inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:brightness-110",
              (sending || rows.length === 0) && "opacity-60 cursor-not-allowed"
            )}
          >
            <Send className={cls("h-4 w-4", sending && "animate-spin")} />
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
};

const SendBlockedModal = ({
  open,
  onClose,
  missing,
}: {
  open: boolean;
  onClose: () => void;
  missing: MissingFieldRow[];
}) => {
  if (!open) return null;

  const total = missing.length;
  const show = missing.slice(0, 12);

  return (
    <div className="fixed inset-0 z-[140] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-2 flex items-start gap-3">
          <div className="mt-0.5 grid h-10 w-10 place-items-center rounded-full bg-amber-50 text-amber-700 border border-amber-200">
            <Inbox className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-gray-900">
              Cannot send to Faculty yet
            </h3>
            <p className="mt-0.5 text-sm text-gray-600">
              Please complete all{" "}
              <span className="font-semibold">required</span> fields for the
              selected faculty’s load recommendation rows before clicking{" "}
              <span className="font-semibold">To Faculty</span>.
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-semibold">What’s missing:</div>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {show.map((m, i) => (
              <li key={`${m.course}-${m.section}-${i}`}>
                <span className="font-medium">{m.course}</span> – {m.section}{" "}
                <span className="text-amber-900/80">({m.faculty})</span>:{" "}
                <span className="font-medium">{m.fields.join(", ")}</span>
              </li>
            ))}
          </ul>
          {total > show.length && (
            <div className="mt-2 text-xs text-amber-900/80">
              …plus {total - show.length} more row(s).
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-3">
          <div className="text-xs text-gray-500">
            Required columns are marked with a{" "}
            <span className="text-red-600 font-bold">*</span> in the table
            header.
          </div>

          <button
            onClick={onClose}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};

const RequestChangeModal = ({
  open,
  facultyName,
  facultyId,
  sectionId,
  onClose,
  userId,
  termId,
  onAfterUpdate,
  onToast,
}: {
  open: boolean;
  facultyName?: string;
  facultyId?: string;
  sectionId?: string;
  onClose: () => void;
  userId: string;
  termId: string;
  onAfterUpdate: () => Promise<void> | void;
  onToast?: (message: string, kind?: "success" | "error") => void;
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<any>>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [locked, setLocked] = useState<boolean>(false);
  const [reply, setReply] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const displayFaculty = facultyName || "Faculty";

  // Terminal statuses are informational; only the explicit `locked` flag should prevent interaction.
  const isTerminal = Boolean(locked);

  useEffect(() => {
    if (!open) {
      setLoading(false);
      setError(null);
      setMessages([]);
      setStatus(null);
      setLocked(false);
      setReply("");
      return;
    }

    (async () => {
      try {
        setLoading(true);
        setError(null);
        setMessages([]);
        setStatus(null);

        if (!facultyId) {
          setError("No faculty id found for this RFC.");
          return;
        }

        const res = await getOmLoadAssignmentRfc(userId, {
          term_id: termId,
          faculty_id: facultyId,
          section_id: sectionId,
        });

        if (!res?.ok || !res?.rfc) {
          setStatus(null);
          setMessages([]);
          return;
        }

        const rfc = res.rfc;
        setStatus(rfc.status || null);
        setLocked(Boolean(rfc.locked));
        setMessages(rfc.messages || rfc.thread || []);
      } catch (e: any) {
        setError(e?.message || "Failed to load RFC.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  if (!open) return null;

  const respond = async (decision: "reply" | "approve" | "reject") => {
    if (!userId || !termId || !facultyId) {
      onToast?.("Missing context.", "error");
      return;
    }
    if (isTerminal) {
      onToast?.("RFC is already locked.", "error");
      return;
    }
    if (decision === "reply" && !reply.trim()) {
      onToast?.("Please type a reply message.", "error");
      return;
    }

    setLoading(true);
    try {
      await respondOmLoadAssignmentRfc(userId, {
        term_id: termId,
        faculty_id: facultyId,
        section_id: sectionId,
        action: decision,
        message: reply.trim() || undefined,
      });

      await onAfterUpdate();
      const msg =
        decision === "reply"
          ? "Reply sent to faculty."
          : decision === "approve"
          ? "RFC approved."
          : "RFC rejected.";
      onToast?.(msg, "success");
      onClose();
    } catch (e: any) {
      onToast?.(e?.message || "Failed to send response.", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-5xl rounded-2xl bg-white shadow-2xl relative max-h-[92vh] flex flex-col overflow-hidden">
        <button
          aria-label="Close"
          className="absolute right-3 top-3 rounded-md p-1.5 hover:bg-gray-100"
          onClick={onClose}
        >
          <X className="h-5 w-5 text-gray-500" />
        </button>

        <div className="p-6 pb-4">
          <h3 className="text-lg font-semibold text-emerald-700 mb-2">
            Request for Change
          </h3>
          <div className="text-sm text-gray-600 mb-1">
            From: <span className="font-semibold">{displayFaculty}</span>
          </div>
          {/* Status hidden per request (avoid showing code-like thread statuses in OM modal) */}

          {loading && (
            <div className="mb-4 text-sm text-gray-600">Loading…</div>
          )}
          {error && <div className="mb-4 text-sm text-red-600">{error}</div>}

          {!loading && !error && !status && (
            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
              No RFC thread found for this course.
            </div>
          )}
        </div>

        <div
          ref={scrollRef}
          className="mx-6 mb-4 flex-1 min-h-0 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-3"
        >
          {messages.length ? (
            <div className="space-y-2">
              {messages.map((m: any, idx: number) => {
                const whoRaw = (m.sender_role || m.from || "").toString();
                const who = whoRaw.toUpperCase();
                const ts = m.created_at
                  ? new Date(m.created_at).toLocaleString()
                  : "";
                const isFaculty = /FACULTY/i.test(whoRaw) || who === "F";
                const bubble = m.message || m.text || "";

                return (
                  <div
                    key={idx}
                    className={cls(
                      "flex",
                      isFaculty ? "justify-start" : "justify-end"
                    )}
                  >
                    <div
                      className={cls(
                        "max-w-[85%]",
                        isFaculty ? "text-left" : "text-right"
                      )}
                    >
                      <div
                        className={cls(
                          "mb-1 text-[11px] text-gray-500",
                          isFaculty ? "pl-1" : "pr-1"
                        )}
                      >
                        {who ||
                          (isFaculty ? displayFaculty.toUpperCase() : "OM")}
                        {ts ? ` • ${ts}` : ""}
                      </div>
                      <div
                        className={cls(
                          "inline-block rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
                          isFaculty
                            ? "bg-white text-gray-800 border border-gray-200"
                            : "bg-emerald-600 text-white"
                        )}
                      >
                        {bubble}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-sm text-gray-600">No messages yet.</div>
          )}
        </div>

        <div className="mx-6">
          <label className="block text-sm font-medium mb-1">Reply</label>
          <textarea
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30 mb-6"
            rows={4}
            placeholder={
              isTerminal ? "This RFC is locked." : "Type your reply…"
            }
            value={reply}
            disabled={loading || !status || isTerminal}
            onChange={(e) => setReply(e.target.value)}
          />
        </div>

        <div className="mx-6 pb-6 flex justify-end gap-2">
          <button
            disabled={loading || !status || isTerminal}
            className={cls(
              "px-4 py-2 rounded-lg bg-red-600 text-white text-sm",
              (loading || !status || isTerminal) &&
                "opacity-60 cursor-not-allowed"
            )}
            onClick={() => respond("reject")}
          >
            Reject
          </button>
          <button
            disabled={loading || !status || isTerminal}
            className={cls(
              "px-4 py-2 rounded-lg bg-emerald-700 text-white text-sm",
              (loading || !status || isTerminal) &&
                "opacity-60 cursor-not-allowed"
            )}
            onClick={() => respond("approve")}
          >
            Approve
          </button>
          <button
            disabled={loading || !status || isTerminal}
            className={cls(
              "px-4 py-2 rounded-lg bg-blue-600 text-white text-sm",
              (loading || !status || isTerminal) &&
                "opacity-60 cursor-not-allowed"
            )}
            onClick={() => respond("reply")}
          >
            Reply
          </button>
        </div>
      </div>
    </div>
  );
};

const NewSectionModal = ({
  open,
  onClose,
  onSave,
  courseOptions,
  onToast,
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
  onToast?: (message: string, kind?: "success" | "error") => void;
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
      onToast?.("Please fill at least Course Code and Section Code.", "error");
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

type ToastKind = "success" | "error" | "warning" | "info";

function Toast({
  open,
  kind = "info",
  message,
  onClose,
}: {
  open: boolean;
  kind?: ToastKind;
  message: string;
  onClose: () => void;
}) {
  if (!open) return null;

  const tone =
    kind === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : kind === "error"
      ? "border-red-200 bg-red-50 text-red-900"
      : kind === "warning"
      ? "border-yellow-200 bg-yellow-50 text-yellow-900"
      : "border-neutral-200 bg-white text-neutral-900";

  const label =
    kind === "success"
      ? "Success"
      : kind === "error"
      ? "Error"
      : kind === "warning"
      ? "Warning"
      : "Info";

  return (
    <div className="fixed top-16 right-6 z-[1200] w-[92vw] max-w-md sm:w-[360px]">
      <div className={`rounded-xl border px-4 py-3 text-sm shadow-lg ${tone}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="leading-snug">
            <span className="font-semibold">{label}:</span> {message}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs hover:bg-black/5"
            aria-label="Close message"
            title="Close"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

function useToast() {
  const [toast, setToast] = useState<{
    kind: ToastKind;
    message: string;
  } | null>(null);
  const timerRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setToast(null);
  }, []);

  const show = useCallback(
    (message: string, kind: ToastKind = "info", ms = 2500) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      setToast({ kind, message });
      timerRef.current = window.setTimeout(() => {
        setToast(null);
        timerRef.current = null;
      }, ms);
    },
    []
  );

  useEffect(() => () => clear(), [clear]);

  return { toast, show, clear };
}
/* ---------------- Main ---------------- */
export type OMLoadAssignmentProps = {
  /** Render without AppShell wrapper (for embedding inside another shell, e.g., CHAIR). */
  embedded?: boolean;
  /** Hide the "Forward to Chair" workflow (used by CHAIR mirror). */
  hideForwardToChair?: boolean;
  /** CHAIR-only: show "Export Excel" (Plantilla preview) action. */
  chairExportExcel?: boolean;
};

/* ---------------- CHAIR: Plantilla preview/export (modal) ---------------- */
type ChairPlantillaRow = {
  rank?: string;
  faculty_name: string;
  course_code: string;
  section_code: string;
  day_text: string;
  time_text: string;
  room_text: string;
  student_count: number | null;
  lec_hours: number | null;
  lab_hours: number | null;
  student_units: number | null;
  on_leave: string;
  course_type: string;
  nature_teaching: number | null;
  nature_admin: number | null;
  nature_research: number | null;
  nature_faculty_units: number | null;
  premium_grad: number | null;
  premium_4th_prep: number | null;
  premium_overload: number | null;
  remarks: string;
  source?: string | null; // e.g., "SPECIALCLASS"
  source_id?: string | null;
};

type ChairPlantillaHeaderResp = {
  ok: boolean;
  term_label?: string;
  dept_label?: string;
  plantilla_file?: string;
};

const chairNormalizeDayLines = (s: string) => {
  const toks = (s || "")
    .toUpperCase()
    .split(/[^A-Z]/g)
    .filter(Boolean);

  const map: Record<string, string> = {
    M: "M",
    T: "T",
    W: "W",
    H: "H",
    TH: "H",
    F: "F",
    S: "S",
    SU: "Su",
    SUN: "Su",
    SAT: "S",
  };

  const lines = toks.map((t) => map[t] ?? t.charAt(0));
  return lines.filter((v, idx) => v && (idx === 0 || v !== lines[idx - 1]));
};

const ChairMultiLineCell: React.FC<{ lines: string[]; raw?: string }> = ({ lines, raw }) => {
  const safe = (lines || []).map((l) => String(l || "").trim()).filter(Boolean);
  if (safe.length === 0) return <span data-raw={raw}>—</span>;

  return (
    <span data-raw={raw} className="inline-block leading-tight">
      {safe.map((l, idx) => (
        <div key={idx}>{l}</div>
      ))}
    </span>
  );
};

const ChairDayCell: React.FC<{ raw: string }> = ({ raw }) => (
  <ChairMultiLineCell raw={raw} lines={chairNormalizeDayLines(raw)} />
);

const ChairTimeCell: React.FC<{ raw: string }> = ({ raw }) => {
  const parts = String(raw || "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  return <ChairMultiLineCell raw={raw} lines={parts} />;
};

const ChairRoomCell: React.FC<{ raw: string }> = ({ raw }) => {
  const parts = String(raw || "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  return <ChairMultiLineCell raw={raw} lines={parts} />;
};

export default function OM_LoadAssignment(props: OMLoadAssignmentProps = {}) {
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const { embedded = false, hideForwardToChair = false, chairExportExcel = false } = props;


// Hover edge scroll indicators for the wide load assignment table (different from the scrollbars)
const loadTableScrollRef = useRef<HTMLDivElement>(null);
const loadTableInnerRef = useRef<HTMLTableElement>(null);
const [loadTableHoverSide, setLoadTableHoverSide] = useState<"left" | "right" | null>(null);
const [loadTableCanScrollLeft, setLoadTableCanScrollLeft] = useState(false);
const [loadTableCanScrollRight, setLoadTableCanScrollRight] = useState(false);

const updateLoadTableScrollHints = useCallback(() => {
  const el = loadTableScrollRef.current;
  if (!el) return;
  const max = el.scrollWidth - el.clientWidth;
  const left = el.scrollLeft;
  setLoadTableCanScrollLeft(left > 1);
  setLoadTableCanScrollRight(left < max - 1);
}, []);

const handleLoadTableMouseMove = useCallback(
  (e: React.MouseEvent<HTMLDivElement>) => {
    const el = loadTableScrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const edge = 36; // px hover zone on left/right edges
    if (x < edge) setLoadTableHoverSide("left");
    else if (x > rect.width - edge) setLoadTableHoverSide("right");
    else setLoadTableHoverSide(null);
  },
  []
);

useEffect(() => {
  updateLoadTableScrollHints();

  const el = loadTableScrollRef.current;
  if (!el) return;

  const ro = new ResizeObserver(() => updateLoadTableScrollHints());
  ro.observe(el);

  const tbl = loadTableInnerRef.current;
  if (tbl) ro.observe(tbl);

  const onWinResize = () => updateLoadTableScrollHints();
  window.addEventListener("resize", onWinResize);

  const raf = requestAnimationFrame(updateLoadTableScrollHints);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", onWinResize);
    ro.disconnect();
  };
}, [updateLoadTableScrollHints]);

  const [onLeaveFacultyIds, setOnLeaveFacultyIds] = useState<string[]>([]);
  const onLeaveSet = useMemo(() => new Set(onLeaveFacultyIds), [onLeaveFacultyIds]);

  const classForTeaching = (t: number) => {
    if (t === 0) return "";
    if (t < 12) return "bg-emerald-100";     // light green
    if (t === 12) return "bg-emerald-600 text-white"; // dark green
    return "bg-red-400 text-white";          // over 12
  };
  
  const classForAdmin = (a: number) => {
    if (a === 0) return "";
    if (a < 12) return "bg-emerald-100";     // light green
    if (a === 12) return "bg-emerald-600 text-white"; // dark green
    return "bg-red-400 text-white";          // over 12
  };
  
  const classForTotal = (u: number) => {
    if (u === 0) return "bg-red-600 text-white";        // matches screenshot
    if (u < 12) return "bg-orange-300";                 // orange under 12
    if (u === 12) return "bg-emerald-600 text-white";   // dark green
    return "bg-red-400 text-white";                     // over 12
  };

  const formatRowForClipboard = (row: Row) =>
    [
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
      "Status",
    ].join("\t") +
    "\n" +
    [
      row.course ?? "",
      row.section ?? "",
      row.faculty ?? "",
      row.day1 ?? "",
      row.begin1 ?? "",
      row.end1 ?? "",
      row.room1 ?? "",
      row.day2 ?? "",
      row.begin2 ?? "",
      row.end2 ?? "",
      row.room2 ?? "",
      (row.status as any) ?? "",
    ].join("\t");

  const handleCopyRow = async (row: Row) => {
    const textToCopy = formatRowForClipboard(row);
    try {
      await navigator.clipboard.writeText(textToCopy);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = textToCopy;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopiedRowId(row.id);
    window.setTimeout(() => setCopiedRowId(null), 1200);
  };

  // In-app toast (styled to match Faculty pages)
  const { toast, show: showToast, clear: clearToast } = useToast();

  // Session (same pattern as APO: localStorage["animo.user"])
  const session = useMemo(() => {
    try {
      const raw = localStorage.getItem("animo.user");
      return raw ? (JSON.parse(raw) as any) : null;
    } catch {
      return null;
    }
  }, []);

  const userId =
    (session as any)?.userId ||
    (session as any)?.user_id ||
    (session as any)?.id ||
    "";


/* ---------------- CHAIR: Plantilla preview/export ---------------- */
const [chairPlantillaOpen, setChairPlantillaOpen] = useState(false);
const [chairPlantillaLoading, setChairPlantillaLoading] = useState(false);
const [chairPlantillaHeader, setChairPlantillaHeader] = useState<ChairPlantillaHeaderResp | null>(null);
const [chairPlantillaRows, setChairPlantillaRows] = useState<ChairPlantillaRow[]>([]);
const chairPlantillaTableRef = useRef<HTMLTableElement | null>(null);

const [chairPlantillaSearchInput, setChairPlantillaSearchInput] = useState("");
const [chairPlantillaSearch, setChairPlantillaSearch] = useState("");

useEffect(() => {
  const t = setTimeout(() => setChairPlantillaSearch(chairPlantillaSearchInput.trim()), 250);
  return () => clearTimeout(t);
}, [chairPlantillaSearchInput]);

const chairPlantillaFilteredRows = useMemo(() => {
  const q = (chairPlantillaSearch || "").toLowerCase();
  // "without the special class" => exclude SPECIALCLASS rows.
  const base = (chairPlantillaRows || []).filter((r) => r?.source !== "SPECIALCLASS");
  if (!q) return base;
  return base.filter((r) => {
    const name = String(r.faculty_name || "").toLowerCase();
    const course = String(r.course_code || "").toLowerCase();
    const section = String(r.section_code || "").toLowerCase();
    return name.includes(q) || course.includes(q) || section.includes(q);
  });
}, [chairPlantillaRows, chairPlantillaSearch]);

const chairPlantillaFilename =
  (chairPlantillaHeader?.plantilla_file && String(chairPlantillaHeader.plantilla_file).replace(/\.pdf$/i, ".xls")) ||
  "Faculty_Plantilla.xls";

const openChairPlantillaPreview = useCallback(() => {
  if (!userId) {
    alert("Missing user session.");
    return;
  }
  setChairPlantillaOpen(true);
}, [userId]);

const closeChairPlantillaPreview = useCallback(() => {
  if (chairPlantillaLoading) return;
  setChairPlantillaOpen(false);
}, [chairPlantillaLoading]);

// Fetch plantilla data when modal opens (copied from CHAIR_Plantilla; no dependency on that page).
useEffect(() => {
  if (!chairPlantillaOpen) return;

  (async () => {
    try {
      setChairPlantillaLoading(true);

      const hdrParams = new URLSearchParams();
      hdrParams.set("userId", userId);
      hdrParams.set("action", "header");
      const rh = await fetch(`/api/chair/plantilla?${hdrParams.toString()}`);
      const hdr = (await rh.json()) as ChairPlantillaHeaderResp;
      if (hdr?.ok) setChairPlantillaHeader(hdr);
      else setChairPlantillaHeader(null);

      const rowsParams = new URLSearchParams();
      rowsParams.set("userId", userId);
      rowsParams.set("action", "fetch");
      const rr = await fetch(`/api/chair/plantilla?${rowsParams.toString()}`);
      const data = await rr.json();
      if (data?.ok && Array.isArray(data.rows)) setChairPlantillaRows(data.rows as ChairPlantillaRow[]);
      else setChairPlantillaRows([]);
    } catch {
      setChairPlantillaHeader(null);
      setChairPlantillaRows([]);
    } finally {
      setChairPlantillaLoading(false);
    }
  })();
}, [chairPlantillaOpen, userId]);

const chairHandleExportExcel = useCallback(() => {
  if (!chairPlantillaFilteredRows || chairPlantillaFilteredRows.length === 0) {
    alert("No plantilla rows to export.");
    return;
  }

  const headers = [
    "Rank",
    "Faculty",
    "Course",
    "Section",
    "Day",
    "Time",
    "Room",
    "No. of Students",
    "Lecture Hours",
    "Lab Hours",
    "Student Unit(s)",
    "On Leave",
    "Type of Course",
    "Teaching",
    "Admin",
    "Research",
    "Faculty Unit(s)",
    "Grad Load",
    "Premium 4th Prep",
    "Overload (NCA)",
    "Remarks",
  ];

  const dataRows = (() => {
    const table = chairPlantillaTableRef.current;
    const bodyRows = table?.querySelectorAll("tbody tr") ?? [];

    const visible: string[][] = [];
    bodyRows.forEach((tr) => {
      const tds = Array.from(tr.querySelectorAll("td"));
      if (tds.length < headers.length) return;
      visible.push(
        tds.slice(0, headers.length).map((td, idx) => {
          const el = td as HTMLElement;
          const raw =
            idx === 4 || idx === 5 || idx === 6
              ? (el.innerText || el.textContent || "")
              : (td.textContent || "");
          return String(raw || "").trim();
        })
      );
    });

    if (visible.length > 0) return visible;

    return chairPlantillaFilteredRows.map((r) => [
      String(r.rank ?? ""),
      String(r.faculty_name || ""),
      String(r.course_code || ""),
      String(r.section_code || ""),
      chairNormalizeDayLines(String(r.day_text || "")).join("\n"),
      String(r.time_text || "")
        .split("/")
        .map((p) => p.trim())
        .filter(Boolean)
        .join("\n"),
      String(r.room_text || "")
        .split("/")
        .map((p) => p.trim())
        .filter(Boolean)
        .join("\n"),
      String(r.student_count ?? ""),
      String(r.lec_hours ?? ""),
      String(r.lab_hours ?? ""),
      String(r.student_units ?? ""),
      String(r.on_leave || ""),
      String(r.course_type || ""),
      String(r.nature_teaching ?? ""),
      String(r.nature_admin ?? ""),
      String(r.nature_research ?? ""),
      String(r.nature_faculty_units ?? ""),
      String(r.premium_grad ?? ""),
      String(r.premium_4th_prep ?? ""),
      String(r.premium_overload ?? ""),
      String(r.remarks || ""),
    ]);
  })();

  const normalizeForExcel = (value: string, preserveNewlines: boolean) => {
    let v = value ?? "";
    if (v === "—") v = "";
    v = v
      .replace(/[\u2012\u2013\u2014\u2015]/g, "-")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u00A0/g, " ");

    if (preserveNewlines) {
      v = v.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, " ");
      v = v
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
      return v;
    }

    v = v.replace(/[\r\n\t]/g, " ");
    v = v.replace(/\s+/g, " ").trim();
    return v;
  };

  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const excelCss = `
    table{border-collapse:collapse;}
    th{border:2px solid #000;padding:4px;font-weight:700;text-align:center;vertical-align:top;}
    td{padding:4px;vertical-align:top;border-left:1px solid #000;border-right:1px solid #000;}
  `;

  const facultyKeyByRow: string[] = [];
  let lastFaculty = "";
  dataRows.forEach((r) => {
    const rawFaculty = String((r?.[1] ?? "") as string).trim();
    if (rawFaculty) lastFaculty = rawFaculty;
    facultyKeyByRow.push(lastFaculty);
  });

  const isGroupStart = (rowIdx: number) => rowIdx === 0 || facultyKeyByRow[rowIdx] !== facultyKeyByRow[rowIdx - 1];
  const isGroupEnd = (rowIdx: number) =>
    rowIdx === facultyKeyByRow.length - 1 || facultyKeyByRow[rowIdx] !== facultyKeyByRow[rowIdx + 1];

  const groupRowSpan = (startIdx: number) => {
    const key = facultyKeyByRow[startIdx];
    let span = 1;
    for (let i = startIdx + 1; i < facultyKeyByRow.length; i++) {
      if (facultyKeyByRow[i] !== key) break;
      span++;
    }
    return span;
  };

  const cellBorderStyle = (rowIdx: number, colIdx: number, colCount: number) => {
    const start = isGroupStart(rowIdx);
    const end = isGroupEnd(rowIdx);
    const firstCol = colIdx === 0;
    const lastCol = colIdx === colCount - 1;

    const parts: string[] = [];
    if (start) parts.push("border-top:2px solid #000");
    if (end) parts.push("border-bottom:2px solid #000");
    if (firstCol) parts.push("border-left:2px solid #000");
    if (lastCol) parts.push("border-right:2px solid #000");

    return parts.join(";");
  };

  let html =
    '<html><head><meta charset="utf-8" />' + `<style>${excelCss}</style>` + '</head><body><table><thead><tr>';
  headers.forEach((h) => {
    html += `<th>${esc(String(h))}</th>`;
  });
  html += "</tr></thead><tbody>";

  for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
    const row = dataRows[rowIdx];
    const start = isGroupStart(rowIdx);

    html += "<tr>";

    if (start) {
      const span = groupRowSpan(rowIdx);

      // Rank
      {
        const idx = 0;
        const raw = row?.[idx] == null ? "" : String(row[idx]);
        const normalized = normalizeForExcel(raw, false);
        const safe = esc(normalized);
        const parts: string[] = ["border-top:2px solid #000", "border-bottom:2px solid #000", "border-left:2px solid #000"];
        html += `<td rowspan="${span}" style="${parts.join(";")};">${safe}</td>`;
      }

      // Faculty
      {
        const idx = 1;
        const raw = row?.[idx] == null ? "" : String(row[idx]);
        const normalized = normalizeForExcel(raw, false);
        const safe = esc(normalized);
        const parts: string[] = ["border-top:2px solid #000", "border-bottom:2px solid #000"];
        html += `<td rowspan="${span}" style="${parts.join(";")};">${safe}</td>`;
      }
    }

    for (let idx = 2; idx < headers.length; idx++) {
      const cell = row?.[idx];
      const raw = cell == null ? "" : String(cell);
      const preserveNewlines = idx === 4 || idx === 5 || idx === 6;
      const normalized = normalizeForExcel(raw, preserveNewlines);
      const safe = preserveNewlines ? esc(normalized).replace(/\n/g, "<br/>") : esc(normalized);

      const borderStyle = cellBorderStyle(rowIdx, idx, headers.length);
      const extraStyle = borderStyle ? `${borderStyle};` : "";

      html += preserveNewlines
        ? `<td style="white-space:pre-wrap;${extraStyle}">${safe}</td>`
        : `<td style="${extraStyle}">${safe}</td>`;
    }

    html += "</tr>";
  }

  html += "</tbody></table></body></html>";

  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = chairPlantillaFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}, [chairPlantillaFilteredRows, chairPlantillaFilename]);


// Local tick for countdown display.
const [deadlineNow, setDeadlineNow] = useState<Date>(() => new Date());
useEffect(() => {
  const tick = window.setInterval(() => setDeadlineNow(new Date()), 1000);
  return () => window.clearInterval(tick);
}, []);


  // Import SHS (match APO import UX)
  const shsFileInputRef = useRef<HTMLInputElement>(null);
  const [showShsImportModal, setShowShsImportModal] = useState(false);
  const [shsImportBusy, setShsImportBusy] = useState(false);
  const [shsImportError, setShsImportError] = useState<string>("");
  const [shsFile, setShsFile] = useState<File | null>(null);

  const openShsImport = () => {
    setShsImportError("");
    setShowShsImportModal(true);
  };

  const closeShsImport = () => {
    if (shsImportBusy) return;
    setShowShsImportModal(false);
    setShsImportError("");
  };

  const downloadShsTemplate = () => {
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const headers = [
      "Course Code & Title",
      "Units",
      "Section",
      "Day 1",
      "Begin 1",
      "End 1",
      "Room 1",
      "Day 2",
      "Begin 2",
      "End 2",
      "Room 2",
      "Capacity",
      "Mode",
      "Campus",
    ];

  const csv = headers.map(esc).join(",") + "\n";

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "om_shs_import_TEMPLATE.csv";
  a.click();
  URL.revokeObjectURL(url);
};

  const splitCsvLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        // Escaped quote
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (ch === "," && !inQuotes) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const validateShsCsvHeaders = (csvText: string) => {
    const firstLine =
      (csvText || "").split(/\r?\n/).find((l) => !!l.trim()) || "";
    if (!firstLine) throw new Error("CSV has no headers.");
    const headers = splitCsvLine(firstLine).map((h) =>
      h.replace(/^"|"$/g, "").trim()
    );
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const headerSet = new Set(headers.map(norm));
    const required = [
      "Course Code & Title",
      "Units",
      "Section",
      "Day 1",
      "Begin 1",
      "End 1",
      "Room 1",
      "Day 2",
      "Begin 2",
      "End 2",
      "Room 2",
      "Capacity",
      "Mode",
    ];
    const missing = required.filter((h) => !headerSet.has(norm(h)));
    if (missing.length) {
      throw new Error(
        `Missing required column(s): ${missing.join(
          ", "
        )}\n\nExpected columns: ${required.join(", ")}`
      );
    }
  };

  const handlePickShsFile = () => {
    shsFileInputRef.current?.click();
  };

  const importShsFile = async (file: File) => {
    if (!file) return;
    if (!userId) throw new Error("Missing user session.");

    // Basic guard: backend expects CSV text
    const isCsv =
      file.name.toLowerCase().endsWith(".csv") || file.type.includes("csv");
    if (!isCsv) {
      throw new Error(
        "Please upload a .csv file. Download the template to match the required format."
      );
    }

    const text = await file.text();
    validateShsCsvHeaders(text);

    const res = await importOmShsCsv(userId, text);
    await loadFromServer();
    showToast(`Imported ${res.imported ?? 0} row(s) from SHS CSV.`, "success");
  };

  const handleShsFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    if (!file) return;
    setShsFile(file);
    setShsImportError("");

    (async () => {
      try {
        setShsImportBusy(true);
        await importShsFile(file);
        setShowShsImportModal(false);
      } catch (err: any) {
        const msg =
          typeof err?.message === "string"
            ? err.message
            : "Failed to import SHS CSV.";
        setShsImportError(msg);
        showToast(msg, "error");
      } finally {
        setShsImportBusy(false);
      }
    })();

    // allow selecting the same file again
    e.target.value = "";
  };

  const [isAssigning, setIsAssigning] = useState(false);

  const [showNewSectionModal, setShowNewSectionModal] = useState(false);

  const [preferredByFaculty, setPreferredByFaculty] = useState<
    Record<string, number>
  >({});

  async function runAutoAssign() {
    if (!userId) return;

    // FRONTEND GUARD: block auto-assign while there are unsaved edits
    if (hasLocalEdits) {
      showToast(
        "Auto-assign is disabled while you have manual edits. Save/discard your changes or refresh first.",
        "error"
      );
      return;
    }

    try {
      setIsAssigning(true);
      // Send the currently viewed term id so the backend can fail fast
      // if the user is accidentally in archive view.
      const res = await runOmAutoAssign({
        user_id: userId,
        term_id: termId || activeTermId,
      });

      // NEW: capture preferred units coming from backend debug
      const debug = (res as any)?.debug || {};
      const prefMap = debug.preferred_units_by_faculty || {};
      setPreferredByFaculty(prefMap);

      console.log("DEBUG from run:", debug);
      console.log("Preferred map:", prefMap);

      // Preserve already-finalized rows: auto-assign should not "move" them or clear their RFC indicators
      const existingFinalized = new Map<string, Row>(
        rows.filter((rr) => !!rr.finalized).map((rr) => [rr.id, rr])
      );

      let nextRows: Row[] = Array.isArray(res?.rows) ? (res.rows as Row[]) : [];
      if (existingFinalized.size) {
        const seen = new Set<string>();
        nextRows = nextRows.map((nr) => {
          const id = String((nr as any)?.id || "");
          const fr = existingFinalized.get(id);
          if (fr) {
            seen.add(id);
            // Prefer the existing finalized row to avoid overwriting faculty/times/status
            return { ...(nr as any), ...(fr as any), finalized: true } as Row;
          }
          return nr;
        });
        // If backend did not return a finalized row, keep it in the table
        for (const [id, fr] of existingFinalized.entries()) {
          if (!seen.has(id)) nextRows.unshift(fr);
        }
      }

      const normalizedNextRows: Row[] = nextRows.map((r: any) => ({
        ...r,
        mode: (r as any)?.mode ?? (r as any)?.Mode ?? "",
        begin1: normalizeServerTimeToHHMM(r?.begin1),
        end1: normalizeServerTimeToHHMM(r?.end1),
        begin2: normalizeServerTimeToHHMM(r?.begin2),
        end2: normalizeServerTimeToHHMM(r?.end2),
      }));

      setRows(normalizedNextRows);
      // Realtime: broadcast the full auto-assign result to other editors (best-effort).
      try {
        broadcastLaBulk(normalizedNextRows as any);
      } catch {}
      setTerm(typeof res?.term === "string" ? res.term : "");
      // Keep term_id in sync so archive-view detection stays correct.
      setTermId(
        typeof (res as any)?.term_id === "string"
          ? (res as any).term_id
          : termId
      );
      setMode("run");
      // Preserve the "Forward to Chair" final-state across auto-assign.
      setApproved((prev) => prev);
      setHasLocalEdits(false); // result from algorithm is the new clean baseline
      resetHistory();
      showToast("Auto-assign completed.", "success");
    } catch (e) {
      console.error(e);
      showToast(`Auto-assign failed: ${String(e)}`, "error");
    } finally {
      setIsAssigning(false);
    }
  }

  const prettifyRole = (raw: string) => {
    const s = String(raw || "").trim();
    if (!s) return "";
    // normalize underscores/spaces then Title Case
    return s
      .replace(/[_\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
      .join(" ");
  };

  const computedRoleTitleFromRoles = (roles?: string[]) => {
    const norm = (roles || [])
      .map((r) =>
        String(r || "")
          .trim()
          .toLowerCase()
      )
      .filter(Boolean);

    if (norm.includes("office manager")) return "Office Manager";
    if (norm.includes("gs coordinator")) return "GS Coordinator";

    const first = norm[0];
    return first ? prettifyRole(first) : "User";
  };

  // TopBar profile (session first, optionally enriched by OM profile API)
  const [profileName, setProfileName] = useState<string>(
    session?.fullName || ""
  );
  const [profileSubtitle, setProfileSubtitle] = useState<string>(
    computedRoleTitleFromRoles(session?.roles)
  );

  // Term label from backend (no hardcoding)
  const [term, setTerm] = useState<string>("");
  const [termId, setTermId] = useState<string>("");
  const [planningTermId, setPlanningTermId] = useState<string>("");

  /** Track the default (active) term id so we can detect archive viewing */
  const [activeTermId, setActiveTermId] = useState<string>("");

  // Realtime collaboration (Load Assignment)
  const laRoomsRef = useRef<string[]>([]);
  const [laPresence, setLaPresence] = useState<
    { userId: string; fullName: string; cursor?: { rowId?: string | null; field?: string | null } | null }[]
  >([]);

  // Collaboration row highlighting colors (Google-Docs-style).
  // IMPORTANT: This is UI-only presence; the backend state-of-truth remains Save/Approve.
  const editorColorForName = useCallback((fullName: string): string | null => {
    const n = String(fullName || "").trim().toLowerCase();
    if (!n) return null;
    // Requested specific colors
    if (n.includes("jamie")) return "hotpink"; // OM
    if (n.includes("nathan")) return "darkgreen"; // CHAIR
    if (n.includes("byrnn")) return "#ff7a00"; // bright orange

    // Fallback: assign a deterministic color for any other collaborator (e.g., GS Coordinator)
    // so row highlight indicators always appear for everyone.
    const palette = [
      "#2563eb", // blue-600
      "#7c3aed", // violet-600
      "#db2777", // pink-600
      "#ea580c", // orange-600
      "#16a34a", // green-600
      "#0f766e", // teal-700
      "#b45309", // amber-700
      "#4f46e5", // indigo-600
    ];

    // Simple stable hash
    let h = 0;
    for (let i = 0; i < n.length; i++) {
      h = (h * 31 + n.charCodeAt(i)) >>> 0;
    }
    return palette[h % palette.length];
  }, []);

  const presenceShadowsByRowId = useMemo(() => {
    const map: Record<string, string> = {};
    const others = (laPresence || []).filter(
      (u) => String(u.userId) && String(u.userId) !== String(userId)
    );

    const byRow = new Map<string, string[]>();
    for (const u of others) {
      const rowId = String((u as any)?.cursor?.rowId || "").trim();
      if (!rowId) continue;
      const color = editorColorForName(u.fullName || "");
      if (!color) continue;
      const arr = byRow.get(rowId) || [];
      if (!arr.includes(color)) arr.push(color);
      byRow.set(rowId, arr);
    }

    // Build layered inset rings per row.
    for (const [rowId, colors] of byRow.entries()) {
      // 2px, 4px, 6px ... inset outlines
      const shadows = colors.map((c, i) => `inset 0 0 0 ${2 + i * 2}px ${c}`);
      map[rowId] = shadows.join(", ");
    }
    return map;
  }, [laPresence, userId, editorColorForName]);

  /** Archived view UI */
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveTerms, setArchiveTerms] = useState<
    {
      term_id: string;
      label: string;
      is_active?: boolean;
      is_current?: boolean;
    }[]
  >([]);
  const [archiveTermId, setArchiveTermId] = useState<string>("");
  const isArchiveView = !!activeTermId && !!termId && termId !== activeTermId;

  // Join realtime collaboration room for the currently viewed term.
  useEffect(() => {
    const socket = getSocket();
    const t = (termId || activeTermId || "").trim();
    if (!socket || !t) return;

    let disposed = false;

    const join = async () => {
      try {
        const resp = await emitAck<any>(socket, "loadassignment_join", { termId: t });
        if (disposed) return;
        if (!resp?.ok) {
          laRoomsRef.current = [];
          setLaPresence([]);
          return;
        }
        const rooms = Array.isArray(resp?.rooms) ? resp.rooms.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
        laRoomsRef.current = rooms;
      } catch {
        // best-effort only
      }
    };

    void join();

    const onPresence = (payload: any) => {
      const rid = String(payload?.roomId || "");
      if (!rid) return;
      // show presence for the primary room only
      if (rid !== (laRoomsRef.current[0] || rid)) return;
      const users = Array.isArray(payload?.users) ? payload.users : [];
      setLaPresence(
        users
          .map((u: any) => ({
            userId: String(u?.userId || ""),
            fullName: String(u?.fullName || ""),
            cursor: u?.cursor ?? null,
          }))
          .filter((u: any) => u.userId)
      );
    };

    const onRowUpdate = (payload: any) => {
      const rid = String(payload?.roomId || "");
      if (!rid || rid !== (laRoomsRef.current[0] || rid)) return;
      const row = payload?.row;
      if (!row || typeof row !== "object") return;
      const id = String((row as any)?.id || (row as any)?.section_id || "");
      if (!id) return;
      setRows((prev) => prev.map((r: any) => (String(r.id) === id ? ({ ...r, ...row } as any) : r)));
    };

    const onBulkUpdate = (payload: any) => {
      const rid = String(payload?.roomId || "");
      if (!rid || rid !== (laRoomsRef.current[0] || rid)) return;
      const incoming = Array.isArray(payload?.rows) ? payload.rows : [];
      if (!incoming.length) return;
      const byId = new Map<string, any>();
      for (const rr of incoming) {
        const id = String(rr?.id || rr?.section_id || "");
        if (id) byId.set(id, rr);
      }
      setRows((prev) => prev.map((r: any) => {
        const rr = byId.get(String(r.id));
        return rr ? ({ ...r, ...rr } as any) : r;
      }));
    };

    socket.on("loadassignment_presence", onPresence);
    socket.on("loadassignment_row_update", onRowUpdate);
    socket.on("loadassignment_bulk_update", onBulkUpdate);

    return () => {
      disposed = true;
      try {
        socket.off("loadassignment_presence", onPresence);
        socket.off("loadassignment_row_update", onRowUpdate);
        socket.off("loadassignment_bulk_update", onBulkUpdate);
      } catch {}
      try {
        const rooms = laRoomsRef.current.slice();
        laRoomsRef.current = [];
        setLaPresence([]);
        if (rooms.length) {
          void emitAck<any>(socket, "loadassignment_leave", { rooms });
        }
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId, activeTermId]);


  // Determine the planning term id (term after the current anchor) for widgets that must
  // explicitly target the planning term (e.g., Faculty Deloading table).
  useEffect(() => {
    if (!userId) return;

    let cancelled = false;
    (async () => {
      try {
        const res: any = await getOmPlanningTermIds();
        if (cancelled) return;
        const pid = typeof res?.planning_term_id === "string" ? res.planning_term_id : "";
        setPlanningTermId(pid);
      } catch (e) {
        // Best-effort only: if this fails, we fall back to termId.
        console.warn("Failed to fetch planning term ids", e);
        if (!cancelled) setPlanningTermId("");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (!archiveOpen || !userId) return;
    if (archiveTerms.length > 0) return;

    (async () => {
      try {
        const res = await getOmLoadAssignmentTerms();
        const terms = Array.isArray((res as any)?.terms)
          ? (res as any).terms
          : [];
        setArchiveTerms(terms);

        const apiActive =
          typeof (res as any)?.active_term_id === "string"
            ? (res as any).active_term_id
            : "";
        // Keep activeTermId in sync if the page hasn't yet loaded its default list.
        if (apiActive && !activeTermId) setActiveTermId(apiActive);

        const defaultPick =
          terms.find((t: any) => (t?.term_id || "") !== (termId || ""))
            ?.term_id ||
          terms[0]?.term_id ||
          "";
        setArchiveTermId(defaultPick);
      } catch (e: any) {
        showToast(e?.message || "Failed to load terms.", "error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archiveOpen, userId]);

  useEffect(() => {
    (async () => {
      if (!userId) return;

      const baseName = session?.fullName || "";
      const baseRole = computedRoleTitleFromRoles(session?.roles);

      try {
        const p = await getOmLoadAssignmentProfile(userId);

        const displayName = (p?.full_name || baseName || "").trim();
        const roleTitle = (p?.position_title || baseRole || "").trim();
        const dept = String(
          p?.dept_name ??
            (session as any)?.dept_name ??
            (session as any)?.dept_label ??
            (session as any)?.deptName ??
            (session as any)?.department?.dept_name ??
            ""
        ).trim();

        let subtitle = roleTitle;
        if (dept) {
          const subLower = subtitle.toLowerCase();
          const deptLower = dept.toLowerCase();
          // append dept exactly once
          if (!subtitle) subtitle = dept;
          else if (!subLower.includes(deptLower))
            subtitle = `${subtitle} | ${dept}`;
        }

        setProfileName(displayName);
        setProfileSubtitle(subtitle);
      } catch {
        // If OM profile API fails, still show session-based values
        setProfileName(baseName);
        setProfileSubtitle(baseRole);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const [search, setSearch] = useState("");
  // Filter rows by academic level (derived from backend courseProgramLevel map).
  // Values: ALL | UG | GS | SHS
  const [levelFilter, setLevelFilter] = useState<string>("ALL");
  // Filter rows by assignment state.
  // Values: ALL | ASSIGNED | UNASSIGNED
  const [assignedFilter, setAssignedFilter] = useState<string>("ALL");
  const [rows, setRows] = useState<Row[]>([]);

  // APO-set deadline windows (schedule + faculty encoding) for OM/GS.
// Deadlines are campus-specific (e.g., Manila and Laguna can differ).
const [omSubmitWindows, setOmSubmitWindows] = useState<
  { campus_id: string; campus_name: string; openISO: string; deadlineISO: string; deadline_passed?: boolean; has_apo_submission?: boolean }[]
>([]);
const [omDeadlinePassed, setOmDeadlinePassed] = useState<boolean>(false);

  // When ALL configured campuses are past deadline, disable OM actions that modify data.
  // Toolbar-level because there is nothing left to encode for any campus.
  // Selection remains available so OM can still send/forward already-locked rows.
  const allCampusesDeadlinePassed = useMemo(() => {
    const ws = omSubmitWindows || [];
    if (!ws.length) return false;
    const unique = new Map<string, boolean>();
    for (const w of ws) {
      const cid = String((w as any)?.campus_id || "").trim();
      if (!cid) continue;
      unique.set(cid, Boolean((w as any)?.deadline_passed));
    }
    if (!unique.size) return false;
    for (const passed of unique.values()) {
      if (!passed) return false;
    }
    return true;
  }, [omSubmitWindows]);


  const deadlinePassedByCampus = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const w of omSubmitWindows || []) {
      const cid = String((w as any)?.campus_id || "").trim();
      if (!cid) continue;
      m[cid] = Boolean((w as any)?.deadline_passed);
    }
    return m;
  }, [omSubmitWindows]);

  const pendingDraftCountByCampus = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows || []) {
      const cid = String((r as any)?.campus_id || "").trim();
      if (!cid) continue;
      if ((r as any)?.has_pending_override) m[cid] = (m[cid] || 0) + 1;
    }
    return m;
  }, [rows]);

  const isCampusDeadlinePassed = useCallback(
    (campusId: string) => {
      const cid = String(campusId || "").trim();
      if (!cid) return false;
      return Boolean(deadlinePassedByCampus[cid]);
    },
    [deadlinePassedByCampus]
  );


// Infer OM campus_id for UI behaviors (e.g., disabling Add Section after deadline).
// Priority: session.campus_id → session.campusId → session.campus.* → most common campus_id in loaded rows.
const inferOmCampusId = useCallback((): string => {
  const norm = (v: any) => String(v ?? "").trim();
  const s: any = session as any;
  const candidate =
    norm(s?.campus_id) ||
    norm(s?.campusId) ||
    norm(s?.campus?.campus_id) ||
    norm(s?.campus?.id) ||
    "";
  if (candidate) return candidate;

  const counts: Record<string, number> = {};
  for (const rr of rows || []) {
    const cid = norm((rr as any).campus_id);
    if (!cid) continue;
    counts[cid] = (counts[cid] || 0) + 1;
  }
  let best = "";
  let bestN = 0;
  for (const [cid, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = cid;
      bestN = n;
    }
  }
  return best;
}, [session, rows]);



  const [newLineSectionDraft, setNewLineSectionDraft] =
  useState<Record<string, string>>({});

  // Submitted Course Offerings options for the Course dropdown (CODE, Title, Units, Capacity).
  const [submittedCourses, setSubmittedCourses] = useState<
    { code: string; title: string; units: number; capacity: number }[]
  >([]);

  // Row-level save spinner for the inline Add New Line row.
  const [savingNewLineId, setSavingNewLineId] = useState<string | null>(null);

  // Snapshot of the rows at the last successful Forward/Re-forward to Chair.
  // Used to generate an APO-style "Detected changes" preview on re-forward.
  const forwardBaselineRef = useRef<Row[] | null>(null);

  const [showForwardReview, setShowForwardReview] = useState(false);
  const [forwardReviewChanges, setForwardReviewChanges] =
    useState<DetectedChanges | null>(null);

  // Reference setter to avoid TS noUnusedLocals warnings in builds where this
  // state is only read (preview) but not explicitly set.
  void setForwardReviewChanges;

  // Day pairing (auto-fill Day 2 based on Day 1), but keep Day 2 editable for manual override.
  const [day2ManualById, setDay2ManualById] = useState<Record<string, boolean>>(
    {}
  );

  // Remarks are saved explicitly per-row (do NOT mix with load draft/undo stacks).
  const [remarksDraftBySection, setRemarksDraftBySection] = useState<
    Record<string, string>
  >({});
  const [remarksSavedBySection, setRemarksSavedBySection] = useState<
    Record<string, string>
  >({});
  const [savingRemarkBySection, setSavingRemarkBySection] = useState<
    Record<string, boolean>
  >({});
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
  const [approved, setApproved] = useState(false);
  // Reference state to avoid TS noUnusedLocals warnings in builds where UI gating
  // is handled elsewhere but handlers still update this flag.
  void approved;
  const [showSend, setShowSend] = useState(false);
  const [sendRowsPreview, setSendRowsPreview] = useState<Row[]>([]);
  const [sendBlocked, setSendBlocked] = useState<{
    open: boolean;
    missing: MissingFieldRow[];
  }>({ open: false, missing: [] });

  const [reqChange, setReqChange] = useState<{
    open: boolean;
    facultyName?: string;
    facultyId?: string;
    sectionId?: string;
  }>({ open: false });

  /** Track if there are unsaved/manual edits in the grid */
  const [hasLocalEdits, setHasLocalEdits] = useState(false);

  /**
   * Scoped Undo/Redo for Load Recommendations only.
   * Stores snapshots of `rows` + `hasLocalEdits` so auto-assign/save state stays consistent.
   */
  const undoStackRef = useRef<{ rows: Row[]; hasLocalEdits: boolean }[]>([]);
  const redoStackRef = useRef<{ rows: Row[]; hasLocalEdits: boolean }[]>([]);
  const HISTORY_LIMIT = 50;
  const [historyVersion, setHistoryVersion] = useState(0); // forces rerender when stacks change
  const bumpHistory = () => setHistoryVersion((v) => v + 1);

  const resetHistory = () => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    bumpHistory();
  };

  const broadcastLaRow = useCallback((row: any) => {
    const socket = getSocket();
    const roomId = laRoomsRef.current[0] || "";
    if (!socket || !roomId || !row) return;
    void emitAck(socket, "loadassignment_row_update", { roomId, row });
  }, []);

  const broadcastLaBulk = useCallback((rowsPayload: any[]) => {
    const socket = getSocket();
    const roomId = laRoomsRef.current[0] || "";
    if (!socket || !roomId || !Array.isArray(rowsPayload) || !rowsPayload.length) return;
    void emitAck(socket, "loadassignment_bulk_update", { roomId, rows: rowsPayload });
  }, []);

  const broadcastLaCursor = useCallback((rowId?: string, field?: string) => {
    const socket = getSocket();
    const roomId = laRoomsRef.current[0] || "";
    if (!socket || !roomId) return;
    void emitAck(socket, "loadassignment_cursor", { roomId, rowId: rowId || null, field: field || null });
  }, []);

  const commitRows = (
    nextRows: Row[], 
    options?: { markDirty?: boolean; broadcastRowId?: string | null }
  ) => {
    // If OM edits a schedule row that is currently "Approved",
    // the approval becomes stale immediately and must be re-sent to faculty.
    // This must happen even before OM clicks "Send to Faculty".
    const demoteApprovedRowsOnAnyEdit = (incoming: Row[]): Row[] => {
      const oldById = new Map(rows.map((r) => [r.id, r] as const));

      const deepEq = (a: any, b: any) => {
        if (a === b) return true;
        // Handle simple cases
        const ta = typeof a;
        const tb = typeof b;
        if (ta !== tb) return false;
        if (a == null || b == null) return a === b;
        // Fallback for objects/arrays
        try {
          return JSON.stringify(a) === JSON.stringify(b);
        } catch {
          return false;
        }
      };

      const isMeaningfulEdit = (prev: any, next: any) => {
        const keys = new Set<string>([
          ...Object.keys(prev || {}),
          ...Object.keys(next || {}),
        ]);
        // Ignore non-content/UI/meta fields when detecting an "edit".
        // Status itself is what we mutate; ignore it when detecting edits.
        const ignore = new Set([
          "id",
          "status",
          "selected",
          "forwarded_to_faculty",
          "reforward_needed",
          "pending_rfc",
          "conflictNote",
          "editable",
          "finalized",
        ]);
        for (const k of ignore) keys.delete(k);
        for (const k of keys) {
          if (!deepEq((prev as any)?.[k], (next as any)?.[k])) return true;
        }
        return false;
      };

      return incoming.map((n): Row => {
        const p = oldById.get(n.id);
        if (!p) return n;
        if (
          String(p.status || "")
            .trim()
            .toLowerCase() !== "approved"
        )
          return n;
        if (!isMeaningfulEdit(p, n)) return n;
        return { ...n, status: "Pending" as Row["status"] };
      });
    };

    const nextRowsWithApprovedDemotions = demoteApprovedRowsOnAnyEdit(nextRows);
    // If a row was already forwarded to faculty, any meaningful edit should make it eligible for re-forwarding.
    // (Selection toggles should NOT trigger this.)
    const prevById = new Map(rows.map((r) => [r.id, r] as const));

    const meaningfulKeys: (keyof Row)[] = [
      "course",
      "title",
      "units",
      "section",
      "faculty",
      "faculty_id",
      "day1",
      "begin1",
      "end1",
      "room1",
      "day2",
      "begin2",
      "end2",
      "room2",
      "capacity",
      "mode",
    ];

    const isMeaningfullyChanged = (a: Row, b: Row) => {
      for (const k of meaningfulKeys) {
        const av = (a as any)[k];
        const bv = (b as any)[k];
        if (String(av ?? "") !== String(bv ?? "")) return true;
      }
      return false;
    };

    const nextRowsWithReforward: Row[] = nextRowsWithApprovedDemotions.map(
      (nr) => {
        const pr = prevById.get(nr.id);
        if (!pr) return nr;
        if (!pr.forwarded_to_faculty) return nr;
        if (pr.reforward_needed) return nr;

        // Only flag if something meaningful (not selection) changed.
        if (isMeaningfullyChanged(pr, nr)) {
          return { ...nr, reforward_needed: true };
        }
        return nr;
      }
    );

    /**
     * Auto-status rule:
     * Once OM fills a row with the required details (even before sending to faculty),
     * the row should already be marked as Pending.
     *
     * We only auto-promote when the row is "complete" and not in a terminal/locked state.
     */
    const applyAutoPendingStatus = (rowsIn: Row[]): Row[] => {
      const isBlank = (v: any) =>
        v === null || v === undefined || String(v).trim() === "";

      const hasAnySecondMeeting = (r: Row) =>
        !isBlank(r.day2) || !isBlank(r.begin2) || !isBlank(r.end2);

      const isComplete = (r: Row) => {
        // Mirror the same "complete enough" definition used before sending a proposal.
        if (isBlank(r.course)) return false;
        if (isBlank(r.section)) return false;
        if (isBlank(r.faculty_id) && isBlank(r.faculty)) return false;
        if (isBlank(r.day1)) return false;
        if (isBlank(r.begin1)) return false;
        if (isBlank(r.end1)) return false;
        if (isBlank(r.mode)) return false;

        if (hasAnySecondMeeting(r)) {
          if (isBlank(r.day2)) return false;
          if (isBlank(r.begin2)) return false;
          if (isBlank(r.end2)) return false;
        }
        return true;
      };

      return rowsIn.map((r): Row => {
        // If OM has completed the row, ensure it's Pending (unless it is already a more specific status).
        if (isComplete(r)) {
          const current = String(r.status || "").trim();
          if (!current || current === "Unassigned") {
            return { ...r, status: "Pending" as Row["status"] };
          }
        }

        return r;
      });
    };

    const nextRowsWithStatus = applyAutoPendingStatus(nextRowsWithReforward);

    // Push current snapshot to undo before applying the change
    undoStackRef.current.push({ rows, hasLocalEdits });
    if (undoStackRef.current.length > HISTORY_LIMIT) {
      undoStackRef.current.shift();
    }
    // Any new action clears redo history
    redoStackRef.current = [];

    setRows(nextRowsWithStatus);

    // Realtime: broadcast the finalized row snapshot (best-effort).
    try {
      const rid = String(options?.broadcastRowId || "").trim();
      if (rid) {
        const rr = nextRowsWithStatus.find((x) => String((x as any)?.id || "") === rid);
        if (rr) broadcastLaRow(rr);
      }
    } catch {}

    if (options?.markDirty !== false) {
      setHasLocalEdits(true);
    }
    bumpHistory();
  };

  const updateRow = (
    id: string,
    patch: Partial<Row>,
    options?: { markDirty?: boolean }
  ) => {
    const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    commitRows(next, { markDirty: options?.markDirty !== false, broadcastRowId: id });

    // Best-effort cursor signal: treat updates as the user editing that row.
    try {
      const keys = Object.keys(patch || {});
      broadcastLaCursor(id, keys[0] || undefined);
    } catch {}
  };

  const handleUndo = () => {
    if (!undoStackRef.current.length) return;
    const prev = undoStackRef.current.pop()!;
    redoStackRef.current.push({ rows, hasLocalEdits });
    setRows(prev.rows);
    setHasLocalEdits(prev.hasLocalEdits);
    bumpHistory();
  };

  const handleRedo = () => {
    if (!redoStackRef.current.length) return;
    const next = redoStackRef.current.pop()!;
    undoStackRef.current.push({ rows, hasLocalEdits });
    setRows(next.rows);
    setHasLocalEdits(next.hasLocalEdits);
    bumpHistory();
  };

  /* ---------------------- Keyboard shortcuts (Ctrl/Cmd) ---------------------- */
  // NOTE: We intentionally do NOT override native undo/redo inside text inputs.
  const shortcutFnsRef = useRef<{ undo: () => void; redo: () => void }>({
    undo: () => {},
    redo: () => {},
  });
  const isRunningRef = useRef(false);
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    shortcutFnsRef.current = {
      undo: handleUndo,
      redo: handleRedo,
    };
  }, [handleUndo, handleRedo]);

  useEffect(() => {
    const isEditableTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;

      const tag = (el as any).tagName
        ? String((el as any).tagName).toLowerCase()
        : "";
      if (tag === "input" || tag === "textarea" || tag === "select")
        return true;

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

      if (!isRunningRef.current) return;

      // Don’t intercept while the user is typing in an editable control
      if (isEditableTarget(e.target)) return;

      e.preventDefault();
      e.stopPropagation();

      const fns = shortcutFnsRef.current;

      // Ctrl/Cmd+Z => Undo
      if (key === "z" && !e.shiftKey) {
        fns.undo();
        return;
      }

      // Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z => Redo
      if (key === "y" || (key === "z" && e.shiftKey)) {
        fns.redo();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const [facultyList, setFacultyList] = useState<Faculty[]>([]);
  // Faculty Deloading (term-wide; UI-only summary)
  type DeloadingDisplayRow = DeloadingRow & {
    faculty_id: string;
    faculty_name_display: string;
  };
  const [deloadAllRows, setDeloadAllRows] = useState<DeloadingDisplayRow[]>([]);
  const [deloadAllLoading, setDeloadAllLoading] = useState(false);
  const [deloadAllError, setDeloadAllError] = useState<string>("");
  // We still track this internally (setter is used), but we no longer display the summary line.
  // Avoid TS6133 (unused state value) by omitting the read value.
  const [, setFacultyWithDeloadings] = useState<Faculty[]>([]);

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

  // Show the main Load Assignment content on OM routes, and also when embedded
  // (e.g., CHAIR mirror at /chair/load-assignment).
  const loc = useLocation();
  const isIndex =
    embedded ||
    /^\/om(\/(load-assignment|home)(\/load-assignment)?)?$/.test(loc.pathname) ||
    /^\/chair\/load-assignment$/.test(loc.pathname);

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

  // Returns the *stored value* for Day 2 (same format as DAY_OPTIONS.value).
  // Supports either stored codes (M/T/W/H/F/S) or day names/labels.
  const pairedDay2For = (day1: string): string => {
    const raw = String(day1 || "").trim();
    if (!raw) return "";

    // If already in code form, map directly.
    const code = raw.length === 1 ? raw.toUpperCase() : "";
    if (code === "M") return "H"; // Monday -> Thursday
    if (code === "T") return "F"; // Tuesday -> Friday
    if (code === "W") return "S"; // Wednesday -> Saturday

    // Otherwise try to map from label/name to code.
    const d = raw.toLowerCase();
    if (d === "monday") return "H";
    if (d === "tuesday") return "F";
    if (d === "wednesday") return "S";
    // Also handle common label forms (e.g., "Mon", "Tue", "Wed").
    if (d === "mon") return "H";
    if (d === "tue") return "F";
    if (d === "wed") return "S";
    return "";
  };

  const setCell = <K extends keyof Row>(id: string, key: K, val: Row[K]) => {
    const markDirty = key !== ("selected" as K);
    const next = rows.map((r) => (r.id === id ? { ...r, [key]: val } : r));
    commitRows(next, { markDirty });
  };

  // Remove UI-only fields before persisting rows to the database.
  // (e.g., `selected` comes from checkbox selection and must never be stored.)
  const stripUiFieldsForPersist = (r: Row): Row => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { selected, is_new_line, __local_only, ...rest } = (r as any) || {};
    return rest as Row;
  };

  // Selection in the load recommendation table is by faculty (not per subject):
  // if the OM selects any row for a faculty, we select *all* rows for that faculty.
  const facultyKeyOf = (r: Row) =>
    String(r.faculty_id || r.faculty || "").trim();
  const setFacultySelected = (refRow: Row, checked: boolean) => {
    const k = facultyKeyOf(refRow);
    if (!k) {
      setCell(refRow.id, "selected", checked as any);
      return;
    }
    // IMPORTANT:
    // - Selection is UI-only and must never be treated as persisted state.
    // - Selecting any row for a faculty should select ALL rows for that same faculty.
    // - To prevent accidental cross-faculty sends (e.g., stale `selected` flags coming from DB restores),
    //   when turning ON a faculty selection we clear selections for other faculties.
    const next = rows.map((r) => {
      const rk = facultyKeyOf(r);
      if (rk === k) return { ...r, selected: checked };
      if (checked) return { ...r, selected: false };
      return r;
    });
    commitRows(next, { markDirty: false });
  };

  const levelOptions: SelectOption[] = [
    { value: "ALL", label: "All Levels" },
    { value: "UG", label: "Undergraduate" },
    { value: "GS", label: "Graduate" },
    { value: "SHS", label: "SHS" },
  ];

  const assignedOptions: SelectOption[] = [
    // Be explicit: this shows both assigned and unassigned rows.
    { value: "ALL", label: "All loads" },
    { value: "ASSIGNED", label: "Assigned" },
    { value: "UNASSIGNED", label: "Unassigned" },
  ];

  const isRowAssigned = (r: Row): boolean => {
    const status = String((r as any)?.status || "")
      .trim()
      .toLowerCase();
    if (status === "unassigned") return false;

    const fid = String((r as any)?.faculty_id || "").trim();
    if (fid) return true;

    const fac = String((r as any)?.faculty || "")
      .trim()
      .toLowerCase();
    if (!fac) return false;
    if (fac === "tba" || fac === "unassigned" || fac === "-" || fac === "—")
      return false;
    return true;
  };
  const getRowProgramLevel = (r: Row): "UG" | "GS" | "SHS" | "" => {
    // Prefer explicit course_id from backend row; fall back to sectionCourse map.
    const sid = String((r as any)?.id || (r as any)?.section_id || "").trim();
    const cid = String(
      (r as any)?.course_id || validationContext.sectionCourse?.[sid] || ""
    ).trim();

    // Backend map is course_id -> program_level (from courses.program_level), but UG data is sometimes blank.
    const raw0 = String(validationContext.courseProgramLevel?.[cid] || "")
      .trim()
      .toUpperCase();

    // If program_level is missing, treat it as UG by default (unless it clearly looks like SHS).
    // This fixes the common case where GS is populated but UG courses are left blank in the catalog.
    if (!raw0) {
      const code = String((r as any)?.course || "")
        .trim()
        .toUpperCase();
      if (code.startsWith("SHS") || code.includes("SHS")) return "SHS";
      return "UG";
    }

    // Normalize to make matching robust (handles values like "UG - Undergraduate", "Under graduate", etc.)
    const raw = raw0.replace(/[^A-Z]/g, "");

    if (
      raw === "UG" ||
      raw.startsWith("UG") ||
      raw.includes("UNDERGRAD") ||
      raw.includes("UNDERGRADUATE") ||
      raw.includes("COLLEGE") ||
      raw === "COL"
    )
      return "UG";

    if (
      raw === "GS" ||
      raw.startsWith("GS") ||
      raw === "GR" ||
      raw.startsWith("GR") ||
      raw.includes("GRAD") ||
      raw.includes("GRADUATE") ||
      raw.includes("POSTGRAD")
    )
      return "GS";

    if (
      raw === "SHS" ||
      raw.includes("SENIORHIGHSCHOOL") ||
      raw.includes("SHS")
    )
      return "SHS";

    return "";
  };
  const filtered = rows.filter((r) => {
    // Apply assignment filter first (so it works even when search is blank).
    if (assignedFilter !== "ALL") {
      const assigned = isRowAssigned(r);
      if (assignedFilter === "ASSIGNED" && !assigned) return false;
      if (assignedFilter === "UNASSIGNED" && assigned) return false;
    }

    // Apply the level filter first so it works even when search is blank.
    if (levelFilter !== "ALL") {
      const lvl = getRowProgramLevel(r);
      if (lvl !== levelFilter) return false;
    }

    const q = search.trim().toLowerCase();
    if (!q) return true;

    const remarks = String(
      remarksDraftBySection[r.id] ??
        remarksSavedBySection[r.id] ??
        (r as any)?.remarks ??
        ""
    );

    const hay = [
      r.course,
      r.title,
      r.section,
      r.faculty,
      r.faculty_id || "",
      String(r.units ?? ""),
      r.day1,
      r.begin1,
      r.end1,
      r.room1,
      r.day2,
      r.begin2,
      r.end2,
      r.room2,
      String(r.capacity ?? ""),
      r.mode || "",
      r.status || "",
      (r as any)?.conflictNote || "",
      remarks,
    ]
      .join(" ")
      .toLowerCase();

    return hay.includes(q);
  });

  const allSelected =
    isRunning && filtered.length > 0 && filtered.every((r) => r.selected);
  const toggleSelectAll = (checked: boolean) => {
    const next = rows.map((r) =>
      filtered.some((fr) => fr.id === r.id) ? { ...r, selected: checked } : r
    );
    commitRows(next, { markDirty: false });
  };
  const selectedRows = rows.filter((r) => r.selected);
  const anySelected = selectedRows.length > 0;

  const buildSendRowsForPreview = (): Row[] => {
    if (!rows.length) return [];
    if (!selectedRows.length) return [];

    const all = rows.every((r) => r.selected);

    const key = (r: Row) => String(r.faculty_id || r.faculty || "").trim();
    const selectedKeys = new Set(selectedRows.map(key).filter(Boolean));

    const isEligible = (r: Row) => {
      // Never include rows without a faculty
      if (!key(r)) return false;

      // Do NOT re-send rows that were already forwarded unless they've been edited since.
      if (r.forwarded_to_faculty && !r.reforward_needed) return false;
      return true;
    };

    if (all) {
      // Send all eligible rows that are assigned to a faculty
      return rows.filter(isEligible);
    }

    // If any row is selected for a faculty, send ALL rows for that faculty (not per subject)
    return rows.filter((r) => selectedKeys.has(key(r)) && isEligible(r));
  };
  /**
   * Before forwarding to faculty, require that the rows being sent are complete.
   * This prevents faculty from receiving half-filled / unusable schedules.
   */
  const validateRowsCompleteForSend = (rowsToSend: Row[]) => {
    const missing: MissingFieldRow[] = [];

    const isBlank = (v: any) =>
      v === null || v === undefined || String(v).trim() === "";

    const hasAnySecondMeeting = (r: Row) =>
      !isBlank(r.day2) || !isBlank(r.begin2) || !isBlank(r.end2);

    for (const r of rowsToSend) {
      const fields: string[] = [];

      // Required for sending a usable proposal
      if (isBlank(r.course)) fields.push("Course");
      if (isBlank(r.section)) fields.push("Section");
      if (isBlank(r.faculty_id) && isBlank(r.faculty)) fields.push("Faculty");
      if (isBlank(r.day1)) fields.push("Day 1");
      if (isBlank(r.begin1)) fields.push("Begin 1");
      if (isBlank(r.end1)) fields.push("End 1");
      if (isBlank(r.mode)) fields.push("Mode");

      // Second meeting is optional, but if any part exists, require the time/day parts only
      if (hasAnySecondMeeting(r)) {
        if (isBlank(r.day2)) fields.push("Day 2");
        if (isBlank(r.begin2)) fields.push("Begin 2");
        if (isBlank(r.end2)) fields.push("End 2");
        // Room 2 is NOT required
      }
      if (fields.length) {
        missing.push({
          course: r.course || "—",
          section: r.section || "—",
          faculty: r.faculty || r.faculty_id || "—",
          fields,
        });
      }
    }

    return missing;
  };

  const handleSendToFaculty = async (rowsToSend: Row[]) => {
    if (!userId) throw new Error("Missing userId");
    if (!rowsToSend?.length) throw new Error("No rows to send");

    // Defensive: ensure faculty_id exists (backend groups strictly by faculty_id).
    // This also prevents schedule fields from being wiped on refresh for rows whose faculty was
    // selected by display name only.
    const normalizedRowsToSend: Row[] = rowsToSend
      .map((r) => {
        const fid =
          (r.faculty_id || "").trim() || facultyNameToId[r.faculty] || "";
        return fid ? ({ ...r, faculty_id: fid } as Row) : r;
      })
      .filter((r) => !!(r.faculty_id || "").trim())
      .map(stripUiFieldsForPersist);

    if (!normalizedRowsToSend.length) {
      throw new Error("No rows with faculty_id");
    }

    const term_id = termId || undefined;

    // 1️⃣ Send selected rows to faculty (proposal + notification)
    await sendOmLoadAssignmentsToFaculty(userId, {
      term_id,
      rows: normalizedRowsToSend,
    });

    // 2️⃣ Persist the FULL OM table so refresh doesn't revert changes
    // IMPORTANT: normalize faculty_id for *all* rows before saving.
    // The backend groups/updates rows by faculty_id; if OM selected a faculty by name only,
    // saving without faculty_id can cause fields (including Mode) to be treated as blank on reload.
    const normalizedAllRows: Row[] = rows.map((r) => {
      const fid =
        (r.faculty_id || "").trim() || facultyNameToId[r.faculty] || "";
      return fid ? ({ ...r, faculty_id: fid } as Row) : r;
    }).map(stripUiFieldsForPersist);
    await submitOmLoadAssignment(userId, { rows: normalizedAllRows }, "save");

    // 3️⃣ Reset UI + reload from DB
    setShowSend(false);
    setSendRowsPreview([]);
    await loadFromServer();
    setHasLocalEdits(false);
    const uniqueFaculty = new Set(
      normalizedRowsToSend
        .map((r) => (r.faculty || r.faculty_id || "").toString().trim())
        .filter(Boolean)
    );
    showToast(
      uniqueFaculty.size <= 1
        ? "Sent proposal to faculty."
        : `Sent proposal to ${uniqueFaculty.size} faculty member(s).`,
      "success"
    );
  };

  // Derived: scoped history availability (re-rendered via historyVersion)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const canUndo =
    isRunning && historyVersion >= 0 && undoStackRef.current.length > 0;
  const canRedo =
    isRunning && historyVersion >= 0 && redoStackRef.current.length > 0;

  const loadFromServer = async (overrideTermId?: string) => {
    if (!userId) return;

    // Preserve client-only unsaved "Add new line" drafts.
    // Saving one new-line row triggers a refresh; without this, other edited
    // drafts disappear from the grid.
    const localNewLineDrafts: Row[] = (rows || []).filter(
      (rr) => !!(rr as any)?.__local_only
    );

    // Preserve current remarks drafts for client-only rows.
    const remarksDraftSnapshot = { ...(remarksDraftBySection || {}) } as Record<
      string,
      string
    >;

    const res = await getOmLoadAssignmentList(userId, overrideTermId);
    setOnLeaveFacultyIds(Array.isArray((res as any)?.on_leave_faculty_ids) ? (res as any).on_leave_faculty_ids : []);

    // Deadline window info for OM/GS (set by APO per campus + planning term)
    try {
      setOmDeadlinePassed(Boolean((res as any)?.om_submit_deadline_passed));
      const ws = (res as any)?.om_submit_windows;
      setOmSubmitWindows(Array.isArray(ws) ? (ws as any[]) : []);
    } catch {
      setOmSubmitWindows([]);
      setOmDeadlinePassed(false);
    }

    // Best-effort: run reminder generation on page load (fallback if no scheduler/cron)
    try {
      runOmSubmitDeadlineReminders();
    } catch {
      // ignore
    }

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

    setBlockedGeCmps2(
      Array.isArray((res as any)?.blockedGeCmps2)
        ? (res as any).blockedGeCmps2
        : []
    );

    // Normalize time values coming from the server (often "HH:MM" or "HMM")
    // to 4-digit "HHMM" so SelectBox values still match TIME_*_OPTIONS.
    const serverRows: Row[] = Array.isArray(res?.rows) ? (res.rows as any) : [];

    // Special Classes are managed in OM_SpecialClass and may create real section bundles.
    // They must NOT appear in the OM Load Assignment table.
    // Backend also filters these out, but we keep a frontend safeguard so legacy data
    // (or future schema changes) won't accidentally surface them here.
    const isSpecialClassRow = (r: any) => {
      const remarks = String(r?.remarks ?? "").trim();
      return /^SPECIAL\s*CLASS$/i.test(remarks);
    };

    const filteredServerRows: Row[] = serverRows.filter(
      (r: any) => !isSpecialClassRow(r)
    );

    const normalizedRows: Row[] = filteredServerRows.map((r: any) => ({
      // NOTE: some backends/serializers can attach non-enumerable properties.
      // Spreading would drop them; explicitly copy `mode` so the Mode column
      // remains populated after refresh/send.
      ...r,
      // `selected` is a UI-only flag. Never hydrate it from the DB (clean-restore can bring back
      // stale selections which can cause cross-faculty rows to be sent unintentionally).
      selected: false,
      mode: (r as any)?.mode ?? (r as any)?.Mode ?? "",
      begin1: normalizeServerTimeToHHMM(r?.begin1),
      end1: normalizeServerTimeToHHMM(r?.end1),
      begin2: normalizeServerTimeToHHMM(r?.begin2),
      end2: normalizeServerTimeToHHMM(r?.end2),
    }));
    // Merge server rows with any client-only "Add new line" drafts that are still unsaved.
    const serverIds = new Set(normalizedRows.map((x) => String((x as any)?.id)));
    const mergedRows: Row[] = [
      ...normalizedRows,
      ...localNewLineDrafts.filter((x) => !serverIds.has(String((x as any)?.id))),
    ];
    setRows(mergedRows);

    // Initialize remarks state from DB values (sections.remarks) without affecting other save/undo behaviors.
    const initRemarks: Record<string, string> = {};
    for (const rr of mergedRows) {
      // For client-only rows, preserve the current draft text (if any).
      if (!!(rr as any)?.__local_only) {
        initRemarks[rr.id] = String(remarksDraftSnapshot?.[rr.id] ?? (rr as any)?.remarks ?? "");
        continue;
      }
      initRemarks[rr.id] = String((rr as any)?.remarks ?? "");
    }
    setRemarksDraftBySection(initRemarks);
    setRemarksSavedBySection(initRemarks);

    const nextTermId =
      typeof (res as any)?.term_id === "string" ? (res as any).term_id : "";
    setTerm(typeof res?.term === "string" ? res.term : "");
    setTermId(nextTermId);

    // Fetch submitted course offerings (for Course dropdown).
    try {
      const sc = await getOmSubmittedCourses(userId, overrideTermId || nextTermId);
      setSubmittedCourses(Array.isArray((sc as any)?.courses) ? (sc as any).courses : []);
    } catch (e) {
      // Best-effort only; keep existing UX if this list fails.
      setSubmittedCourses([]);
    }
    // Capture the default active term id on normal loads so we can detect archive view.
    if (!overrideTermId && nextTermId) {
      setActiveTermId(nextTermId);
    }
    setMode("run");
    // Once forwarded to Chair, it is a final act and must remain disabled across refresh/auto-assign.
    const forwardedToChair = Boolean((res as any)?.forwarded_to_chair);
    setApproved(forwardedToChair);
    // Keep a baseline snapshot for "Re-forward" change preview.
    // Only update baseline when the server says it is forwarded; otherwise clear.
    if (forwardedToChair) {
      forwardBaselineRef.current = normalizedRows.map((r) => ({ ...r }));
    } else {
      forwardBaselineRef.current = null;
    }
    setHasLocalEdits(false);
    resetHistory();
  };


const handleApplyPendingDrafts = useCallback(
  async (campusId: string) => {
    if (!userId) return;
    const cid = String(campusId || "").trim();
    if (!cid) {
      showToast("Cannot apply drafts: missing campus.", "error");
      return;
    }
    if (isCampusDeadlinePassed(cid)) {
      showToast(
        "Cannot apply drafts: the deadline has passed for this campus. Ask APO to reopen the deadline window.",
        "error"
      );
      return;
    }
    try {
      const resp = await applyOmPendingOverrides(userId, { campus_id: cid } as any);
      const applied = (resp as any)?.applied_count ?? (resp as any)?.count ?? null;
      showToast(
        applied === null
          ? "Applied pending drafts to APO."
          : `Applied ${applied} pending draft(s) to APO.`,
        "success"
      );
      await loadFromServer();
    } catch (e) {
      console.error(e);
      showToast(`Apply to APO failed: ${String(e)}`, "error");
    }
  },
  [userId, isCampusDeadlinePassed, applyOmPendingOverrides, loadFromServer]
);

  const getPrimaryScheduleId = (r: Row): string => {
    const ids = (r as any)?.schedule_ids;
    if (Array.isArray(ids)) {
      const found = ids.find((x: any) => typeof x === "string" && x.trim());
      if (found) return String(found);
    }
    const single = (r as any)?.schedule_id;
    return typeof single === "string" ? single : "";
  };

  // --- Remarks autosave (per section) ---
  // Debounce timers keyed by section row id.
  const remarkAutosaveTimersRef = useRef<Record<string, number>>({});

  const clearRemarkAutosaveTimer = (sectionId: string) => {
    const t = remarkAutosaveTimersRef.current[sectionId];
    if (t) {
      window.clearTimeout(t);
      delete remarkAutosaveTimersRef.current[sectionId];
    }
  };

  useEffect(() => {
    return () => {
      // cleanup timers on unmount
      for (const k of Object.keys(remarkAutosaveTimersRef.current)) {
        window.clearTimeout(remarkAutosaveTimersRef.current[k]);
      }
      remarkAutosaveTimersRef.current = {};
    };
  }, []);

  const handleSaveRemark = async (
    r: Row,
    options?: { silentSuccess?: boolean }
  ) => {
    if (!userId || isArchiveView) return;
    const sectionId = r.id;
    const scheduleId = getPrimaryScheduleId(r);
    if (!scheduleId) {
      showToast(
        "Cannot save remarks for this row because a schedule identifier is missing.",
        "error"
      );
      return;
    }

    const remarks = String(remarksDraftBySection[sectionId] ?? "");
    const saved = String(remarksSavedBySection[sectionId] ?? "");
    if (remarks === saved) return;
    if (savingRemarkBySection[sectionId]) return;

    setSavingRemarkBySection((p) => ({ ...p, [sectionId]: true }));
    try {
      await saveOmSectionRemarks(userId, { schedule_id: scheduleId, remarks });
      setRemarksSavedBySection((p) => ({ ...p, [sectionId]: remarks }));
      // Do not clobber a newer in-progress edit that happened while the save was in-flight.
      setRemarksDraftBySection((p) =>
        String(p[sectionId] ?? "") === remarks
          ? { ...p, [sectionId]: remarks }
          : p
      );
      if (!options?.silentSuccess) {
        showToast("Remarks saved.", "success");
      }
    } catch (e: any) {
      showToast(e?.message || "Failed to save remarks.", "error");
    } finally {
      setSavingRemarkBySection((p) => ({ ...p, [sectionId]: false }));
    }
  };

  const queueAutosaveRemark = (r: Row, nextValue: string) => {
    if (!userId || isArchiveView) return;
    const sectionId = r.id;
    // Update draft immediately.
    setRemarksDraftBySection((p) => ({ ...p, [sectionId]: nextValue }));

    // Debounced save.
    clearRemarkAutosaveTimer(sectionId);
    remarkAutosaveTimersRef.current[sectionId] = window.setTimeout(() => {
      // Use the latest draft at save time.
      void handleSaveRemark(r, { silentSuccess: true });
    }, 700);
  };

  const handleForwardToChair = async () => {
    if (!userId) return;
    try {
      const res = await submitOmLoadAssignment(
        userId,
        { rows: rows.map(stripUiFieldsForPersist) },
        "approve"
      );
      await notifyChairLoadRecommendation(userId, {
        kind: (res as any)?.kind,
        reco_id: (res as any)?.reco_id,
      });
      showToast("Forwarded to Chair.", "success");
      await loadFromServer();
      setApproved(true);
    } catch (e: any) {
      showToast(e?.message || "Failed to forward to Chair.", "error");
    }
  };

  useEffect(() => {
    if (initialLoaded) return; // prevent double loading
    setInitialLoaded(true);
    loadFromServer(); // auto-load on page open
  }, [initialLoaded]);

  const addRow = () => {
  // Inline add: insert an editable row directly into the table.
  // This row is treated as an OM-created pending request for APO room assignment.
  const newId = `manual-${Date.now()}`;
  commitRows([
    ...rows,
    {
      id: newId,
      // Client-only draft marker. This prevents other unsaved new-line rows from
      // disappearing when we refresh after saving a single row.
      __local_only: true as any,
      is_new_line: true as any,
      course: "",
      title: "",
      units: "", // auto-filled after course selection
      section: "",
      faculty: "",
      faculty_id: undefined,
      day1: "",
      begin1: "",
      end1: "",
      room1: "TBA",
      day2: "",
      begin2: "",
      end2: "",
      room2: "TBA",
      capacity: "", // auto-filled after course selection
      mode: "",
      status: "",
      editable: true,
    } as any,
  ]);
  setMode("manual");
  setApproved(false);
};

  const handleDeleteNewLineRow = (rowId: string) => {
    // New-line rows are client-only until saved, so delete is purely local.
    commitRows(rows.filter((x) => x.id !== rowId));
    // Best-effort cleanup of per-row remark drafts/saves.
    setRemarksDraftBySection((p) => {
      const next = { ...(p || {}) } as any;
      delete next[rowId];
      return next;
    });
    setRemarksSavedBySection((p) => {
      const next = { ...(p || {}) } as any;
      delete next[rowId];
      return next;
    });
  };


  const getEditFlags = (r: Row) => {
    // Rows synced from Faculty Service Request are view-only for OM.
    if (!!(r as any).synced_from_faculty_service) {
      return {
        course: false,
        title: false,
        units: false,
        section: false,
        faculty: false,
        day1: false,
        begin1: false,
        end1: false,
        room1: false,
        day2: false,
        begin2: false,
        end2: false,
        room2: false,
        capacity: false,
        mode: false,
      } as const;
    }

    // Archived terms are view-only.
    // NOTE: Faculty acceptance/"Approved" schedules must remain editable by OM.
    if (isArchiveView) {
      return {
        course: false,
        title: false,
        units: false,
        section: false,
        faculty: false,
        day1: false,
        begin1: false,
        end1: false,
        room1: false,
        day2: false,
        begin2: false,
        end2: false,
        room2: false,
        capacity: false,
        mode: false,
      } as const;
    }

    // Campus-specific APO deadlines:
    // Only lock rows whose campus deadline has passed (e.g., Manila locked but Laguna still editable).
    if (isCampusDeadlinePassed(String((r as any)?.campus_id || ""))) {
      return {
        course: false,
        title: false,
        units: false,
        section: false,
        faculty: false,
        day1: false,
        begin1: false,
        end1: false,
        room1: false,
        day2: false,
        begin2: false,
        end2: false,
        room2: false,
        capacity: false,
        mode: false,
      } as const;
    }


// Newly added "Add new line" rows have special edit rules:
// - Editable: all fields EXCEPT Room 1/2, Units, Capacity (auto-filled / APO-assigned).
if (!!(r as any).is_new_line) {
  const editSchedule = true; // allow editing day/time/mode/faculty for the pending request
  return {
    course: true,
    title: false,
    units: false,
    section: true,
    faculty: editSchedule,
    day1: editSchedule,
    begin1: editSchedule,
    end1: editSchedule,
    room1: false,
    day2: editSchedule,
    begin2: editSchedule,
    end2: editSchedule,
    room2: false,
    capacity: false,
    mode: editSchedule,
  } as const;
}
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
      await submitOmLoadAssignment(
        userId,
        { rows: rows.map(stripUiFieldsForPersist) },
        "save"
      );
      await loadFromServer(); // pull fresh rows from DB
      setHasLocalEdits(false); // grid now matches DB
      showToast("Draft saved.", "success");
    } catch (e) {
      console.error(e);
      showToast(`Save draft failed: ${String(e)}`, "error");
    }
  }
async function handleSaveNewLineRow(r: Row) {
  if (!userId) return;

  const norm = (v: any) => String(v ?? "").trim();
  const courseCode = norm(r.course);

  // Duplicate/Existing section warning (prevent saving).
  const sec = norm(r.section);
  if (!sec) {
    showToast("Section is required.", "error");
    return;
  }

  // Must have course selected before validating duplicates/APO rules.
  if (!courseCode) {
    showToast("Please select a Course Code first.", "error");
    return;
  }

  // 1) Prevent duplicate sections PER COURSE (case-insensitive)
  const existsLocal = rows.some((x) => {
    if (x.id === r.id) return false;
    const xCourse = norm((x as any).course);
    const xSec = norm((x as any).section);
    return (
      xCourse.toLowerCase() === courseCode.toLowerCase() &&
      xSec.toLowerCase() === sec.toLowerCase()
    );
  });
  if (existsLocal) {
    showToast("Duplicate section: this section already exists for that course.", "error");
    return;
  }

  // 2) Enforce APO rules based on section prefix + OM campus context
  const inferSectionApo = (s: string): "APO Manila" | "APO Laguna" | "" => {
    const up = norm(s).toUpperCase();
    if (!up) return "";
    if (up.startsWith("XX") || up.startsWith("XC")) return "APO Laguna";
    if (up.startsWith("S") || up.startsWith("G")) return "APO Manila";
    return "";
  };

  const campusId = inferOmCampusId();

  if (campusId && isCampusDeadlinePassed(campusId)) {
    showToast('Cannot add section: the APO-set deadline has passed for this campus.', 'error');
    return;
  }
  const inferOmApo = (cid: string): "APO Manila" | "APO Laguna" | "" => {
    const up = norm(cid).toUpperCase();
    if (!up) return "";
    // Project convention: CMPS0001 = Manila, CMPS0002 = Laguna
    if (up === "CMPS0001") return "APO Manila";
    if (up === "CMPS0002") return "APO Laguna";
    return "";
  };

  const sectionApo = inferSectionApo(sec);
  if (!sectionApo) {
    showToast(
      "Invalid section: use S/G (APO Manila) or XX/XC (APO Laguna).",
      "error"
    );
    return;
  }

  const omApo = inferOmApo(campusId);
  if (omApo && sectionApo !== omApo) {
    showToast(
      `Invalid section: This section belongs to ${sectionApo}, but you’re assigning for ${omApo}.`,
      "error"
    );
    return;
  }

  // Required fields for saving a pending request
  // NOTE: Remarks are optional; everything else in the new-line row must be present.
  const missing: string[] = [];
  if (!courseCode) missing.push("Course");
  if (!sec) missing.push("Section");
  if (!norm((r as any).faculty_id)) missing.push("Faculty");
  if (!norm((r as any).mode)) missing.push("Mode");
  if (!norm((r as any).day1)) missing.push("Day 1");
  if (!norm((r as any).begin1)) missing.push("Begin 1");
  if (!norm((r as any).end1)) missing.push("End 1");

  // Units + Capacity are auto-filled from the selected course, but still required before saving.
  const unitsNum = Number((r as any).units);
  const capNum = Number((r as any).capacity);
  if (!Number.isFinite(unitsNum) || unitsNum <= 0) missing.push("Units");
  if (!Number.isFinite(capNum) || capNum <= 0) missing.push("Capacity");

  // Meeting 2 is optional, but if any field is provided then all are required.
  const d2 = norm((r as any).day2);
  const b2 = norm((r as any).begin2);
  const e2 = norm((r as any).end2);
  const hasAnyMeet2 = !!d2 || !!b2 || !!e2;
  const hasAllMeet2 = !!d2 && !!b2 && !!e2;
  if (hasAnyMeet2 && !hasAllMeet2) {
    if (!d2) missing.push("Day 2");
    if (!b2) missing.push("Begin 2");
    if (!e2) missing.push("End 2");
  }

  if (missing.length) {
    showToast(
      `Please fill in: ${missing.join(", ")} (Remarks is optional).`,
      "error"
    );
    return;
  }

  setSavingNewLineId(r.id);
  try {
    await saveOmNewLine(userId, {
      // course is stored as course_code in the row
      course_code: courseCode,
      section_code: sec,
      faculty_id: norm((r as any).faculty_id),
      campus_id: campusId || undefined,
      day1: norm((r as any).day1),
      begin1: norm((r as any).begin1),
      end1: norm((r as any).end1),
      day2: norm((r as any).day2),
      begin2: norm((r as any).begin2),
      end2: norm((r as any).end2),
      mode: norm((r as any).mode),
      // units & capacity are auto-filled after course selection
      units: Number((r as any).units || 0),
      capacity: Number((r as any).capacity || 0),
      remarks: String((r as any).remarks || "").trim(),
    });
    showToast("Saved. Status set to Pending and APO notified.", "success");
    // Remove the just-saved client-only draft row before refreshing from server.
    // This prevents the saved row from briefly duplicating (client draft + server row)
    // and ensures other unsaved drafts remain visible after refresh.
    commitRows(rows.filter((x) => x.id !== r.id), { markDirty: false });
    setRemarksDraftBySection((p) => {
      const next = { ...(p || {}) } as any;
      delete next[r.id];
      return next;
    });
    setRemarksSavedBySection((p) => {
      const next = { ...(p || {}) } as any;
      delete next[r.id];
      return next;
    });
    await loadFromServer();
  } catch (e: any) {
    const msg = String(e?.message || e || "");
    showToast(msg || "Failed to save new line.", "error");
  } finally {
    setSavingNewLineId(null);
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
      !r.section || !r.faculty || !r.mode || !r.day1 || !r.begin1 || !r.end1;

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
      Object.values(rowFlags as RowFlagsById).some((flags: RowFlag[]) =>
        flags.some((f: RowFlag) => f.severity === "error")
      ),
    [rowFlags]
  );

  // Reference memoized value to avoid TS noUnusedLocals warnings in builds where
  // error gating is enforced server-side instead of client-side.
  void hasAnyErrors;

  const deloadFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return deloadAllRows;
    return deloadAllRows.filter((r) => {
      const hay = [
        r.faculty_name_display,
        r.faculty_id,
        r.deloading_type || "",
        String(r.units_deloaded ?? ""),
        r.notes || "",
        r.updated_at ? new Date(r.updated_at as any).toISOString() : "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [deloadAllRows, search]);

  // Uses the most recently-updated deloading row per faculty.
  const deloadUnitsByFacultyId = useMemo(() => {
    const map: Record<string, number> = {};

    // deloadAllRows is already sorted by updated_at DESC earlier,
    // so the first occurrence per faculty is the "latest".
    for (const r of deloadAllRows) {
      const fid = String((r as any)?.faculty_id || "").trim();
      if (!fid) continue;

      if (map[fid] != null) continue; // keep first (latest) only

      const raw = (r as any)?.units_deloaded;
      const units =
        typeof raw === "number" ? raw : parseFloat(String(raw ?? "0")) || 0;

      map[fid] = units;
    }

    return map;
  }, [deloadAllRows]);

  useEffect(() => {
    const deloadTermId = planningTermId || termId;
    if (!deloadTermId) return;

    let cancelled = false;
    (async () => {
      setDeloadAllLoading(true);
      setDeloadAllError("");
      try {
        // 1) Get the list of faculty who have deloadings for the term.
        const r = await getOmFacultyWithDeloadings(deloadTermId);
        const fac = Array.isArray(r?.faculty) ? r.faculty : [];
        if (cancelled) return;
        setFacultyWithDeloadings(fac);

        // 2) Fetch deloading rows per faculty and flatten into a single table.
        const results = await Promise.all(
          fac.map(async (f) => {
            try {
              const res = await getOmFacultyDeloadings({
                faculty_id: f.faculty_id,
                term_id: deloadTermId || undefined,
              });
              const rows = Array.isArray(res?.rows) ? res.rows : [];
              return rows.map((row) => ({
                ...row,
                faculty_id: f.faculty_id,
                faculty_name_display: f.faculty_name_display,
              })) as DeloadingDisplayRow[];
            } catch {
              // UI-only: if one faculty fails, keep the rest.
              return [] as DeloadingDisplayRow[];
            }
          })
        );

        if (cancelled) return;
        const flat = results.flat();

        // Show most recently updated first (still UI-only; no backend behavior changes).
        flat.sort((a, b) => {
          const da = a.updated_at ? +new Date(a.updated_at as any) : 0;
          const db = b.updated_at ? +new Date(b.updated_at as any) : 0;
          return db - da;
        });

        setDeloadAllRows(flat);
      } catch (e: any) {
        if (cancelled) return;
        console.error("Failed to load deloadings", e);
        setFacultyWithDeloadings([]);
        setDeloadAllRows([]);
        setDeloadAllError(e?.message || "Failed to load deloadings.");
      } finally {
        if (!cancelled) setDeloadAllLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [planningTermId, termId]);

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
    // NOTE: diff is based on TOTAL units (Teaching + Deloading) vs Preferred,
    // to match the "Load Status (vs Preferred)" column.
    Object.values(acc).forEach((row) => {
      if (row.preferredUnits != null) {
        const deload = row.facultyId
          ? Number(deloadUnitsByFacultyId[row.facultyId] || 0)
          : 0;
        row.diff = (row.assignedUnits + deload) - row.preferredUnits;
      }
    });

    return Object.values(acc).sort((a, b) =>
      a.facultyName.localeCompare(b.facultyName)
    );
  }, [rows, facultyById, preferredByFaculty, deloadUnitsByFacultyId]);

  type UnitsFilterMode = "all" | "issues" | "match";
  type UnitsSortKey = "faculty" | "assigned" | "preferred" | "deload" | "leave" | "gap";
  // Filters are always visible in this view (no toggle)
  const [unitsFilterMode, setUnitsFilterMode] =
    useState<UnitsFilterMode>("all");
  const [hideNoPrefs, setHideNoPrefs] = useState(false);

  // default sort
  const [unitsSortKey, setUnitsSortKey] = useState<UnitsSortKey>("gap");
  const [unitsSortDir, setUnitsSortDir] = useState<"asc" | "desc">("asc");

  const toggleUnitsSort = (key: UnitsSortKey) => {
    if (unitsSortKey === key) {
      setUnitsSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setUnitsSortKey(key);
      setUnitsSortDir("asc");
    }
  };

  const facultySummaryFiltered: FacultySummaryRow[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return facultySummary;

    return facultySummary.filter((f) => {
      const deloadUnits =
        (f.facultyId && deloadUnitsByFacultyId[f.facultyId]) || 0;

      const hay = [
        f.facultyName,
        f.facultyId,
        String(f.assignedUnits ?? ""),
        String(f.preferredUnits ?? ""),
        String(f.diff ?? ""),
        String(deloadUnits ?? ""),
      ]
        .join(" ")
        .toLowerCase();

      return hay.includes(q);
    });
  }, [facultySummary, deloadUnitsByFacultyId, search]);

  const facultySummaryView: FacultySummaryRow[] = useMemo(() => {
    const base = [...facultySummaryFiltered];

    const filtered = base.filter((f) => {
      const assigned = Number(f.assignedUnits ?? 0);
      const deload = Number(
        (f.facultyId && deloadUnitsByFacultyId[f.facultyId]) || 0
      );
      const totalUnits = assigned + deload;
      const hasPref = f.preferredUnits != null;
      if (hideNoPrefs && !hasPref) return false;

      if (unitsFilterMode === "issues" || unitsFilterMode === "match") {
        // Compare TOTAL units (Teaching + Deloading) against preferred.
        // This must match the Load Status column (vs Preferred).
        if (f.preferredUnits == null) return false;

        const preferred = Number(f.preferredUnits);
        const isMatch = Math.abs(totalUnits - preferred) <= 1e-6;

        // "issues" = underloaded or overloaded vs preferred (i.e., not matching)
        return unitsFilterMode === "match" ? isMatch : !isMatch;
      }
      return true;
    });

    const dir = unitsSortDir === "asc" ? 1 : -1;

    filtered.sort((a, b) => {
      const aName = a.facultyName ?? "";
      const bName = b.facultyName ?? "";

      const aAssigned = Number(a.assignedUnits ?? 0);
      const bAssigned = Number(b.assignedUnits ?? 0);

      const aPref =
        a.preferredUnits == null
          ? Number.POSITIVE_INFINITY
          : Number(a.preferredUnits);
      const bPref =
        b.preferredUnits == null
          ? Number.POSITIVE_INFINITY
          : Number(b.preferredUnits);

      const aDeload = (a.facultyId && deloadUnitsByFacultyId[a.facultyId]) || 0;
      const bDeload = (b.facultyId && deloadUnitsByFacultyId[b.facultyId]) || 0;

      // Gap is based on TOTAL units vs preferred (same as Load Status).
      const aGap =
        a.preferredUnits == null
          ? Number.POSITIVE_INFINITY
          : (aAssigned + aDeload) - Number(a.preferredUnits);
      const bGap =
        b.preferredUnits == null
          ? Number.POSITIVE_INFINITY
          : (bAssigned + bDeload) - Number(b.preferredUnits);

      const aLeave = a.facultyId && onLeaveSet.has(a.facultyId) ? 12 : 0;
      const bLeave = b.facultyId && onLeaveSet.has(b.facultyId) ? 12 : 0;

      if (unitsSortKey === "faculty") return dir * aName.localeCompare(bName);
      if (unitsSortKey === "assigned") return dir * (aAssigned - bAssigned);
      if (unitsSortKey === "preferred") return dir * (aPref - bPref);
      if (unitsSortKey === "deload") return dir * (aDeload - bDeload);
      if (unitsSortKey === "leave") return dir * (aLeave - bLeave);

      if (aGap !== bGap) return dir * (aGap - bGap);
      return aName.localeCompare(bName);
    });

    return filtered;
  }, [
    facultySummaryFiltered,
    unitsFilterMode,
    unitsSortKey,
    unitsSortDir,
    hideNoPrefs,
    deloadUnitsByFacultyId,
  ]);

  // ---- Rule alerts for Tab 2 (violations / warnings) ----
  type RuleAlert = {
    id: string;
    rule: string;
    severity: "error" | "warning";
    facultyName?: string;
    facultyId?: string;
    course?: string;
    section?: string;
    courseSection?: string;
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

    const courseLabel = (r?: Row) => (r?.course || "").trim() || "?";
    const sectionLabel = (r?: Row) => (r?.section || "").trim();
    const courseSectionLabel = (r?: Row) =>
      `${courseLabel(r)} ${sectionLabel(r)}`.trim();

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

          alerts.push({
            id: `${key}-streak`,
            rule: "MAX_CONSEC_4_5H",
            severity: "warning",
            facultyName,
            facultyId,
            course: courseLabel(sample.row),
            section: sectionLabel(sample.row),
            courseSection: courseSectionLabel(sample.row),
            message: `${courseSectionLabel(
              sample.row
            )}: ${facultyName} has more than 4.5 consecutive hours of teaching on ${day} (sections: ${sections}).`,
          });

          break; // one alert per faculty+day is enough
        }
      }
    });

    // 3) Incomplete rows (same logic as hasIncompleteRows)
    rows.forEach((r, idx) => {
      if (isRowIncompleteForApproval(r)) {
        alerts.push({
          id: `incomplete-${idx}-${r.id}`,
          rule: "INCOMPLETE_ROW",
          severity: "error",
          facultyName: r.faculty || undefined,
          facultyId: r.faculty_id,
          course: courseLabel(r),
          section: sectionLabel(r),
          courseSection: courseSectionLabel(r),
          message: `${courseSectionLabel(
            r
          )} has missing required fields but contains partial schedule/faculty data.`,
        });
      }
    });

    // 3b) KAC mismatch (same pattern as INCOMPLETE_ROW)
    rows.forEach((r) => {
      const flags = rowFlags[r.id];
      if (!flags) return;

      const kac = flags.find((f) => f.type === "KAC_MISMATCH");
      if (!kac) return;

      alerts.push({
        id: `kac-${r.id}`,
        rule: "KAC_MISMATCH",
        severity: "error",
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        course: courseLabel(r),
        section: sectionLabel(r),
        courseSection: courseSectionLabel(r),
        message: `${courseSectionLabel(r)}: KAC mismatch — ${
          r.faculty || "This faculty"
        } is not aligned with the KAC cluster.`,
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
      alerts.push({
        id: `mode-${r.id}`,
        rule: "MODE_MISMATCH",
        severity: "error",
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        course: courseLabel(r),
        section: sectionLabel(r),
        courseSection: courseSectionLabel(r),
        message: `${courseSectionLabel(r)}: Mode mismatch — ${
          r.faculty || "This faculty"
        } prefers ${prefLabel} but this section is ${rowModeLabel}.`,
      });
    });

    // 3d) Same day/time double-booking (from rowFlags)
    rows.forEach((r) => {
      const flags = rowFlags[r.id];
      if (!flags) return;

      const dbl = flags.find((f) => f.type === "DOUBLE_BOOKED");
      if (!dbl) return;

      alerts.push({
        id: `double-${r.id}`,
        rule: "DOUBLE_BOOKED",
        severity: "error",
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        course: courseLabel(r),
        section: sectionLabel(r),
        courseSection: courseSectionLabel(r),
        message: `${courseSectionLabel(r)}: ${
          dbl.message ||
          "Schedule conflict: faculty is assigned to multiple sections at the same day and time."
        }`,
      });
    });

    // 3e) day to faculty_preferences mismatch (from rowFlags)
    rows.forEach((r) => {
      const flags = rowFlags[r.id];
      if (!flags) return;

      const flag = flags.find((f) => f.type === "DAY_MISMATCH");
      if (!flag) return;

      alerts.push({
        id: `day-${r.id}`,
        rule: "DAY_MISMATCH",
        severity: flag.severity,
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        course: courseLabel(r),
        section: sectionLabel(r),
        courseSection: courseSectionLabel(r),
        message: `${courseSectionLabel(r)}: ${flag.message}`,
      });
    });

    // 3f) time to faculty_preferences mismatch (from rowFlags)
    rows.forEach((r) => {
      const flags = rowFlags[r.id];
      if (!flags) return;

      const flag = flags.find((f) => f.type === "TIME_MISMATCH");
      if (!flag) return;

      alerts.push({
        id: `time-${r.id}`,
        rule: "TIME_MISMATCH",
        severity: flag.severity,
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        course: courseLabel(r),
        section: sectionLabel(r),
        courseSection: courseSectionLabel(r),
        message: `${courseSectionLabel(r)}: ${flag.message}`,
      });
    });

    // 3g) GS sections assigned to non-PhD faculty
    rows.forEach((r) => {
      const flags = rowFlags[r.id];
      if (!flags) return;

      const flag = flags.find((f) => f.type === "GS_NO_PHD");
      if (!flag) return;

      alerts.push({
        id: `gs-${r.id}`,
        rule: "GS_NO_PHD",
        severity: flag.severity,
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        course: courseLabel(r),
        section: sectionLabel(r),
        courseSection: courseSectionLabel(r),
        message: flag.message
          ? `${courseSectionLabel(r)}: ${flag.message}`
          : `${courseSectionLabel(
              r
            )}: GS course is assigned to a non-PhD faculty member.`,
      });
    });

    // 3h) GE @ CMPS0002 blocked slot violations
    rows.forEach((r) => {
      const flags = rowFlags[r.id];
      if (!flags) return;

      const geFlag = flags.find((f) => f.type === "GE_BLOCKED_SLOT");
      if (!geFlag) return;

      alerts.push({
        id: `ge-block-${r.id}`,
        rule: "GE_BLOCKED_SLOT",
        severity: geFlag.severity,
        facultyName: r.faculty || undefined,
        facultyId: r.faculty_id,
        course: courseLabel(r),
        section: sectionLabel(r),
        courseSection: courseSectionLabel(r),
        message: geFlag.message
          ? `${courseSectionLabel(r)}: ${geFlag.message}`
          : `${courseSectionLabel(
              r
            )}: GE slot conflict — this section is using a GE-reserved schedule at CMPS0002.`,
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
          course: courseLabel(r),
          section: sectionLabel(r),
          message:
            `Section ${r.course || "?"} ${r.section || ""} ` +
            `was left unassigned: ${r.conflictNote}`,
        });
      }
    });

    return alerts;
  }, [rows, rowFlags, validationContext, isRowIncompleteForApproval]);

  const ruleAlertsFiltered: RuleAlert[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ruleAlerts;

    return ruleAlerts.filter((a) => {
      const hay = [
        a.rule,
        a.severity,
        a.facultyName || "",
        a.facultyId || "",
        a.course || "",
        a.section || "",
        a.courseSection || "",
        a.message,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [ruleAlerts, search]);

  type BlockedGeCmps2Item = {
    campus_id: string;
    campus_name?: string;
    course_id: string;
    course_code?: string;
    section_id: string;
    section_code?: string;
    day: string;
    begin: string;
    end: string;

    program?: string; // or program_code/program_name depending on backend
    batch?: string; // string for safety (ex: "2023", "Batch 12")
  };

  const [blockedGeCmps2, setBlockedGeCmps2] = useState<BlockedGeCmps2Item[]>(
    []
  );

  type BlockedSectionRow = {
    rowId: string; // section_id
    course: string;
    section: string;
    campusId: string;
    campusName?: string;

    program?: string;
    batch?: string;
  };

  const blockedSections: BlockedSectionRow[] = useMemo(() => {
    const bySection: Record<string, BlockedSectionRow> = {};

    (blockedGeCmps2 || []).forEach((b) => {
      const sid = String(b.section_id || "").trim();
      if (!sid) return;

      if (!bySection[sid]) {
        bySection[sid] = {
          rowId: sid,
          course: b.course_code || b.course_id || "—",
          section: b.section_code || "—",
          campusId: b.campus_id || "",
          campusName: b.campus_name || "",
          program: b.program || "",
          batch: b.batch || "",
        };
      }
    });

    // keep only CMPS0002 in this tab
    return Object.values(bySection).filter(
      (x) => String(x.campusId || "").toUpperCase() === "CMPS0002"
    );
  }, [blockedGeCmps2]);

  const blockedSectionsFiltered: BlockedSectionRow[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return blockedSections;

    return blockedSections.filter((b) => {
      const hay = [b.course, b.section, b.campusId, b.campusName || ""]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [blockedSections, search]);

  const [summaryTab, setSummaryTab] = useState<"units" | "second" | "blocked">(
    "units"
  );

const courseOptions = useMemo(() => {
  return (submittedCourses || [])
    .filter((c) => (c?.code || "").trim().length > 0)
    .map((c) => ({
      code: String(c.code || "").trim(),
      title: String(c.title || "").trim(),
      units: Number(c.units || 0),
      capacity: Number(c.capacity || 0),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}, [submittedCourses]);

const courseChoiceOptions = useMemo(() => {
  // UI change: Course dropdown should show ONLY the course code.
  // The title is displayed underneath after selection, so it is redundant in the options list.
  return courseOptions.map((c) => c.code);
}, [courseOptions]);

const courseCodeToInfo = useMemo(() => {
  const m: Record<string, { code: string; title: string; units: number; capacity: number }> = {};
  for (const c of courseOptions) {
    m[c.code] = c;
  }
  return m;
}, [courseOptions]);


// (deadlineWindow + deadlineNow are used by the render-time countdown banner)


    const content = (
    <>

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
              <header className="mb-3">
                <h1 className="text-2xl font-bold">
                  Load Assignment <span className="text-gray-400">|</span>{" "}
                  <span className="font-black">{term}</span>
                </h1>
                <p className="text-sm text-gray-600">
                  Manage course assignments and faculty workload distribution
                </p>

                {/* Realtime collaboration presence */}
                {(() => {
                  const others = (laPresence || []).filter((u) => String(u.userId) && String(u.userId) !== String(userId));
                  if (!others.length) return null;
                  return (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-700">
                      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800">
                        Live
                      </span>
                      <span>Editing now:</span>
                      {others.slice(0, 5).map((u) => {
                        const c = editorColorForName(u.fullName || "");
                        return (
                          <span
                            key={u.userId}
                            className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5"
                          >
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: c || "#94a3b8" }}
                              aria-hidden="true"
                            />
                            {u.fullName || u.userId}
                          </span>
                        );
                      })}
                      {others.length > 5 ? (
                        <span className="text-slate-500">+{others.length - 5} more</span>
                      ) : null}
                    </div>
                  );
                })()}

                {/* Deadline banner is rendered below using om_submit_windows from /om/load-assignment/list. */}
              </header>

	              {/* APO-set deadline banner (shows BOTH Manila + Laguna deadlines if available) */}
	              <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
	                <div className="flex items-start justify-between gap-3">
	                  <div>
	                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
	                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
	                        <CalendarClock className="h-4 w-4" />
	                      </span>
	                      <span>Scheduling &amp; Faculty Encoding Deadlines</span>
	                    </div>
	                    <div className="mt-1 flex items-start gap-2 text-xs text-slate-600">
	                      <Info className="mt-0.5 h-3.5 w-3.5 flex-none" />
	                      <span>
	                        Deadlines are campus-specific. Reminders are sent automatically to OM and the GS Coordinator 7, 3, 2, and 1 day(s) before each campus deadline.
	                      </span>
	                    </div>
	                  </div>
	                  {omDeadlinePassed ? (
	                    <span className="inline-flex items-center rounded-full bg-red-600 px-2.5 py-1 text-xs font-semibold text-white">Locked</span>
	                  ) : null}
	                </div>

	                <div className="mt-3 space-y-3">
	                  {(omSubmitWindows || []).length === 0 ? (
	                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
	                      No OM submission deadline set yet for Manila or Laguna.
	                    </div>
	                  ) : (
	                    (omSubmitWindows || []).map((w) => {
	                      const iso = String(w?.deadlineISO || "").trim();
	                      const d = iso ? new Date(iso) : null;
	                      const valid = !!d && !Number.isNaN(d.getTime());
	                      const msLeft = valid ? (d!.getTime() - deadlineNow.getTime()) : null;
	                      const daysLeft = msLeft === null ? null : Math.ceil(msLeft / (1000 * 60 * 60 * 24));
	                      const when = valid
	                        ? d!.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
	                        : iso;
	
	                      const passed = Boolean(w?.deadline_passed) || (msLeft !== null && msLeft <= 0);
	                      const hasApo = Boolean(w?.has_apo_submission);
	
	                      return (
	                        <div
	                          key={`${w.campus_id}::${w.deadlineISO}`}
	                          className={cls(
	                            "rounded-lg border border-l-4 px-4 py-3",
	                            passed
	                              ? "border-red-200 border-l-red-500 bg-red-50"
	                              : !hasApo
	                                ? "border-slate-200 border-l-slate-400 bg-slate-50"
	                                : (daysLeft ?? 999) <= 7
	                                  ? "border-amber-200 border-l-amber-500 bg-amber-50"
	                                  : "border-emerald-200 border-l-emerald-500 bg-emerald-50"
	                          )}
	                        >
	                          <div className="flex items-start justify-between gap-3">
	                            <div>
	                              <div className={cls("text-sm font-semibold", passed ? "text-red-800" : "text-slate-800")}>
	                                {w.campus_name || w.campus_id}
	                              </div>
	                              <div className="mt-0.5 text-sm text-slate-700">
	                                Deadline: <span className="font-semibold">{when}</span>
	                              </div>
	                              <div className="mt-0.5 text-xs text-slate-600">
	                                {passed
	                                  ? "Submitting/approving is locked for this campus because the deadline has passed."
	                                  : hasApo
	                                    ? "Please complete schedule and faculty encoding for the APO-submitted course offerings."
	                                    : "Awaiting APO’s submission of the course offerings. Once submitted, please complete schedule and faculty encoding by the deadline."}
	                              </div>
	                            </div>
	
	                            <div className="flex items-center gap-2">
	                              {!passed && (pendingDraftCountByCampus[String(w.campus_id || '').trim()] || 0) > 0 ? (
	                                <button
	                                  type="button"
	                                  className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:brightness-110"
	                                  title="Apply OM pending drafts so APO can see them"
	                                  onClick={() => void handleApplyPendingDrafts(String(w.campus_id || ''))}
	                                >
	                                  Apply to APO
	                                </button>
	                              ) : null}
	                              {passed ? (
	                                <span className="inline-flex items-center rounded-full bg-red-600 px-2.5 py-1 text-xs font-semibold text-white">Locked</span>
	                              ) : daysLeft !== null ? (
	                                <span className="inline-flex items-center rounded-full bg-white/70 px-2.5 py-1 text-xs font-semibold text-slate-700">
	                                  {daysLeft <= 0 ? "Due today" : `${daysLeft} day(s) left`}
	                                </span>
	                              ) : null}
	                            </div>
	                          </div>
	                        </div>
	                      );
	                    })
	                  )}
	                </div>
	              </div>

              <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <button
                  type="button"
                  onClick={() => setArchiveOpen(true)}
                  className={cls(
                    "inline-flex h-10 min-w-[160px] items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm",
                    "hover:bg-gray-50"
                  )}
                  title="Display faculty loads from past terms"
                >
                  <Archive className="h-4 w-4" />
                  Archived Loads
                </button>

                <SelectBox
                  value={levelFilter}
                  onChange={setLevelFilter}
                  options={levelOptions}
                  className="min-w-[135px] w-[135px]"
                  buttonClassName="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 pr-9 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                />

                <SelectBox
                  value={assignedFilter}
                  onChange={setAssignedFilter}
                  options={assignedOptions}
                  // Keep this compact: match the longest option text ("Unassigned") without being overly wide.
                  className="min-w-[140px] w-[140px]"
                  buttonClassName="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 pr-9 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                />

                <div className="relative flex-1 min-w-[260px]">
                  <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search across loads, deloadings, remarks, mode, etc..."
                    className="w-full rounded-lg border border-gray-300 px-9 pr-10 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
                  />

                  {/* Clear (X) button */}
                  {search.trim().length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-700"
                      title="Clear search"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>

                <div className="ml-auto flex items-center gap-2">
                  {/* Forward to Chair removed; Save Draft shown here instead */}
                  <button
                    disabled={!hasReco || isArchiveView || omDeadlinePassed || isAssigning}
                    onClick={handleSaveDraft}
                    className={cls(
                      "inline-flex h-10 min-w-[160px] items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium shadow-sm",
                      !(!hasReco || isArchiveView || omDeadlinePassed || isAssigning)
                        ? "bg-gray-800 text-white hover:brightness-110"
                        : "bg-gray-200 text-gray-400 cursor-not-allowed"
                    )}
                    title={
                      isArchiveView
                        ? "Archived view: saving is disabled"
                        : omDeadlinePassed
                        ? "Locked: deadline has passed"
                        : !hasReco
                        ? "No recommendations to save yet"
                        : "Save current assignments to the database"
                    }
                  >
                    <Save className="h-4 w-4" />
                    Save Draft
                  </button>


{chairExportExcel && (
  <button
    type="button"
    onClick={openChairPlantillaPreview}
    className={cls(
      "inline-flex h-10 min-w-[160px] items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium shadow-sm",
      "bg-blue-600 text-white hover:brightness-110"
    )}
    title="Preview the plantilla (regular classes only) then export as Excel (.xls)"
  >
    <Download className="h-4 w-4" />
    Export Excel
  </button>
)}

                </div>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                <div className="flex items-center justify-between px-4 pt-4">
                  <div className="flex items-center gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={handleUndo}
                        disabled={!canUndo || isAssigning || allCampusesDeadlinePassed}
                        className={cls(
                          "inline-flex items-center justify-center rounded-md border border-gray-300 bg-white p-1.5 text-gray-600 shadow-sm",
                          "hover:bg-gray-50",
                          (!canUndo || isAssigning) &&
                            "opacity-50 cursor-not-allowed hover:bg-white"
                        )}
                        title={
                          !canUndo
                            ? "Nothing to undo"
                            : "Undo last change in Load Recommendations"
                        }
                      >
                        <Undo2 className="h-5 w-5" />
                      </button>

                      <button
                        onClick={handleRedo}
                        disabled={!canRedo || isAssigning || allCampusesDeadlinePassed}
                        className={cls(
                          "inline-flex items-center justify-center rounded-md border border-gray-300 bg-white p-1.5 text-gray-600 shadow-sm",
                          "hover:bg-gray-50",
                          (!canRedo || isAssigning) &&
                            "opacity-50 cursor-not-allowed hover:bg-white"
                        )}
                        title={
                          !canRedo
                            ? "Nothing to redo"
                            : "Redo last undone change in Load Recommendations"
                        }
                      >
                        <Redo2 className="h-5 w-5" />
                      </button>

                      {/* Import SHS file */}
                      <button
                        type="button"
                        onClick={openShsImport}
                        disabled={!isRunning || isAssigning || isArchiveView || allCampusesDeadlinePassed}
                        className={cls(
                          "inline-flex h-10 min-w-[140px] items-center justify-center gap-2 rounded-md bg-[#008e4e] px-4 py-2 text-sm font-medium text-white shadow-sm",
                          "hover:brightness-110",
                          (!isRunning || isAssigning || isArchiveView) &&
                            "opacity-50 cursor-not-allowed hover:brightness-100"
                        )}
                        title={
                          isArchiveView
                            ? "Archived view: importing is disabled"
                            : !isRunning
                            ? "Run Auto-assign or load data first"
                            : shsFile
                            ? `Selected: ${shsFile.name}`
                            : "Import SHS file"
                        }
                      >
                        <Upload className="h-4 w-4" />
                        Import SHS
                      </button>
                    </div>
                  </div>

                  {/* --- MODIFIED SECTION START --- */}
                  <div className="flex flex-wrap items-center gap-2">
                    {/* New/Moved Auto-assign button */}
                    <button
                      onClick={runAutoAssign}
                      disabled={isAssigning || hasLocalEdits || isArchiveView || allCampusesDeadlinePassed}
                      className="inline-flex h-10 min-w-[140px] items-center justify-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110 disabled:opacity-60"
                      title={
                        isArchiveView
                          ? "Archived view: auto-assign is disabled"
                          : hasLocalEdits
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
                        onClick={() => loadFromServer()}
                        disabled={isAssigning || allCampusesDeadlinePassed}
                        title={allCampusesDeadlinePassed ? "Locked: all campus deadlines have passed" : "Refresh data from server"}
                        className={cls("inline-flex h-10 min-w-[140px] items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-50", (isAssigning || allCampusesDeadlinePassed) && "opacity-60 cursor-not-allowed hover:bg-white")}
                      >
                        <RefreshCcw className="h-4 w-4" />
                        Refresh
                      </button>
                    )}

                    <button
                      disabled={!anySelected || !isRunning || isArchiveView}
                      onClick={() => {
                        if (isArchiveView) return;
                        const preview = buildSendRowsForPreview();
                        if (!preview.length) {
                          showToast(
                            "No new or edited rows to send for the selected faculty. (Previously sent rows are excluded unless edited.)",
                            "error"
                          );
                          return;
                        }

                        const missing = validateRowsCompleteForSend(preview);
                        if (missing.length) {
                          // Hard validation: block sending until required fields are filled
                          setSendBlocked({ open: true, missing });
                          showToast(
                            "Cannot send to faculty: please complete all required fields in the selected faculty’s rows.",
                            "error"
                          );
                          return;
                        }

                        setSendRowsPreview(preview.map((r) => ({ ...r })));
                        setShowSend(true);
                      }}
                      className={cls(
                        "inline-flex h-10 min-w-[140px] items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium shadow-sm",
                        anySelected && isRunning && !isArchiveView
                          ? "bg-blue-600 text-white hover:brightness-110"
                          : "bg-gray-200 text-gray-500 cursor-not-allowed"
                      )}
                      title={
                        isArchiveView
                          ? "Archived view: sending is disabled"
                          : anySelected
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

                {/* Match APO_CourseOfferings table styling (sticky header, bordered cells, emerald header text) */}
                {isArchiveView ? (
                  <ArchivedLoadsSummary rows={filtered} termLabel={term} />
                ) : (
                  <div className="relative mt-3 rounded-xl border border-gray-300 bg-white shadow-sm">
                    <div
                      ref={loadTableScrollRef}
                      className="max-h-[58vh] overflow-x-auto overflow-y-auto"
                      onScroll={updateLoadTableScrollHints}
                      onMouseMove={handleLoadTableMouseMove}
                      onMouseLeave={() => setLoadTableHoverSide(null)}
                    >
                    {/*
                      NOTE: Use w-max/min-w-max so the table can exceed the container width.
                      This makes horizontal scrolling ("move") always work when columns are wide.
                    */}
                    <table ref={loadTableInnerRef} className="w-max min-w-max text-sm table-fixed border-collapse">
                      <colgroup>
                        {/* 1) Select */}
                        <col className="w-[46px]" />
                        {/* 2) Course Code & Title */}
                        <col className="w-[230px]" />
                        {/* 3) Units */}
                        <col className="w-[70px]" />
                        {/* 4) Section (WIDENED) */}
                        <col className="w-[100px]" />
                        {/* 5) Faculty */}
                        <col className="w-[280px]" />
                        {/* 6) Day 1 */}
                        <col className="w-[72px]" />
                        {/* 7) Begin 1 */}
                        <col className="w-[96px]" />
                        {/* 8) End 1 */}
                        <col className="w-[96px]" />
                        {/* 9) Room 1 */}
                        <col className="w-[140px]" />
                        {/* 10) Day 2 */}
                        <col className="w-[72px]" />
                        {/* 11) Begin 2 */}
                        <col className="w-[96px]" />
                        {/* 12) End 2 */}
                        <col className="w-[96px]" />
                        {/* 13) Room 2 */}
                        <col className="w-[140px]" />
                        {/* 14) Capacity */}
                        <col className="w-[90px]" />
                        {/* 15) Mode */}
                        <col className="w-[90px]" />
                        {/* 16) Remarks */}
                        <col className="w-[320px]" />
                        {/* 17) Status */}
                        <col className="w-[110px]" />
                        {/* 18) Actions */}
                        <col className="w-[120px]" />
                      </colgroup>

                      <thead className="bg-gray-50 text-gray-900 sticky top-0 z-10">
                        <tr className="whitespace-nowrap text-[13px] font-semibold">
                          <th className="px-3 py-2 text-center border border-gray-300">
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
                          <th className="px-3 py-2 text-left border border-gray-300">
                            Course Code & Title
                            <span className="text-red-600" aria-hidden="true">
                              *
                            </span>
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            Units
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            Section
                          </th>
                          <th className="px-3 py-2 text-left border border-gray-300">
                            Faculty{" "}
                            <span className="text-red-600" aria-hidden="true">
                              *
                            </span>
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            Day 1{" "}
                            <span className="text-red-600" aria-hidden="true">
                              *
                            </span>
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            Begin 1{" "}
                            <span className="text-red-600" aria-hidden="true">
                              *
                            </span>
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            End 1{" "}
                            <span className="text-red-600" aria-hidden="true">
                              *
                            </span>
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            Room 1
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            Day 2{" "}
                            <span className="text-red-600" aria-hidden="true">
                              *
                            </span>
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            Begin 2{" "}
                            <span className="text-red-600" aria-hidden="true">
                              *
                            </span>
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            End 2{" "}
                            <span className="text-red-600" aria-hidden="true">
                              *
                            </span>
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            Room 2
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            Capacity
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            Mode{" "}
                            <span className="text-red-600" aria-hidden="true">
                              *
                            </span>
                          </th>
                          <th className="px-3 py-2 text-left border border-gray-300">
                            Remarks
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            Status
                          </th>
                          <th className="px-3 py-2 text-center border border-gray-300">
                            Actions
                          </th>
                        </tr>
                      </thead>

                      <tbody>
                        {filtered.map((r, idx) => {
                          const e = getEditFlags(r);
                          const fromFacultyService = !!(r as any)
                            .synced_from_faculty_service;
                          const isLockedByApoDeadline = isCampusDeadlinePassed(String((r as any)?.campus_id || ""));
                          const isLocked = isArchiveView || fromFacultyService || isLockedByApoDeadline;
                          const isForwardedToFaculty = !!r.forwarded_to_faculty;
                          const isPastDeadlineRow = Boolean((r as any).is_past_deadline);
                          const hasDraft = Boolean((r as any).has_pending_override);
                          const presenceShadow = presenceShadowsByRowId[String(r.id)] || "";
                          // Previously used Tailwind ring classes; we replicate as boxShadow so it can stack with presence outlines.
                          const deadlineShadow =
                            !isLocked && isPastDeadlineRow && hasDraft
                              ? "0 0 0 1px #FDE68A"
                              : "";
                          const combinedShadow = [deadlineShadow, presenceShadow]
                            .filter(Boolean)
                            .join(", ");
                          // Show the red dot only when there is a pending RFC AND the row is still actionable.
                          // Once the schedule is approved/finalized, the message icon is disabled; the dot should disappear.
                          const unread = !!(r as any).pending_rfc;
                          return (
                            <tr
                              key={r.id}
                              className={cls(
                                "whitespace-nowrap [&>td]:border [&>td]:border-gray-200",
                                isLocked
                                  ? fromFacultyService
                                    ? "bg-orange-50 hover:bg-orange-50"
                                    : "bg-gray-100 text-gray-500 hover:bg-gray-100"
                                  : isPastDeadlineRow
                                  ? hasDraft
                                    ? "bg-slate-50 hover:bg-slate-100/40"
                                    : "bg-slate-50 hover:bg-slate-100/40"
                                  : isForwardedToFaculty
                                  ? "bg-sky-50 hover:bg-sky-100/40"
                                  : "hover:bg-gray-50"
                              )}
                              style={combinedShadow ? { boxShadow: combinedShadow } : undefined}
                            >
                              <td className="px-3 py-2 text-center">
                                {isRunning && (
                                  <input
                                    type="checkbox"
                                    checked={!!r.selected}
                                    onChange={(ev) => setFacultySelected(r, ev.target.checked)}
                                    className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                                    title={`Select row ${idx + 1}`}
                                  />
                                )}
                              </td>

                              <td className="px-4 py-2 align-top">
                                {getEditFlags(r).course ? (
                                  <div className="flex flex-col gap-1">
                                    {/* Course code & title (submitted offerings only; searchable) */}
<ComboBox
  // UI change: dropdown shows only Course Code
  value={String(r.course || "")}
  onChange={(code) => {
    const picked = String(code || "").trim();
    // IMPORTANT: allow clearing the selection. If we don't, the input can look
    // cleared, but the row value stays the old course and the ComboBox will
    // snap back to it ("revert") on blur.
    if (!picked) {
      updateRow(
        r.id,
        {
          course: "" as any,
          course_id: "" as any,
          title: "" as any,
          units: "" as any,
          capacity: "" as any,
        },
        { markDirty: true }
      );
      return;
    }

    const info = courseCodeToInfo[picked];
    if (!info) return;
    updateRow(
      r.id,
      {
        course: info.code,
        title: info.title as any,
        units: String(info.units ?? "") as any,
        capacity: String(info.capacity ?? "") as any,
      },
      { markDirty: true }
    );
  }}
  options={courseChoiceOptions}
  placeholder="— Select course —"
  className="w-[240px]"
  commitOnSelectOnly
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
                              {(r as any).is_new_line ? (
                                <TextBox
                                  value={newLineSectionDraft[r.id] ?? (r.section ?? "")}
                                  onChange={(v) =>
                                    setNewLineSectionDraft((p) => ({ ...p, [r.id]: v }))
                                  }
                                  onBlur={() => {
                                    const v = (newLineSectionDraft[r.id] ?? r.section ?? "");
                                    setCell(r.id, "section", v as any);
                                  }}
                                  className="w-[260px]"
                                  align="center"
                                />
                              ) : (
                                <Cell
                                  editable={e.section}
                                  value={r.section}
                                  onChange={(v) => setCell(r.id, "section", v)}
                                  className="w-[260px]"
                                  align="center"
                                />
                              )}

                              </td>

                              <td className="px-4 py-2">
                                {e.faculty ? (
                                  <ComboBox
                                    value={r.faculty ?? ""}
                                    onChange={(v) => {
                                      const fid = facultyNameToId[v] || "";
                                      updateRow(
                                        r.id,
                                        { faculty: v, faculty_id: fid as any },
                                        { markDirty: true }
                                      );
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
                                  <DayInput
                                    value={r.day1}
                                    onChange={(v) => {
                                      const autoDay2 = pairedDay2For(String(v || ""));
                                      const shouldAuto = !day2ManualById[r.id];
                                      if (shouldAuto && autoDay2) {
                                        updateRow(
                                          r.id,
                                          { day1: v as any, day2: autoDay2 as any },
                                          { markDirty: true }
                                        );
                                      } else {
                                        setCell(r.id, "day1", v as any);
                                      }
                                    }}
                                    options={DAY_OPTIONS}
                                    className="w-[150px]"
                                  />
                                ) : (
                                  <span>{r.day1 || "—"}</span>
                                )}
                              </td>

                              <td className="px-2 py-2 text-center">
                                {e.begin1 ? (
                                  <TimeBeginInput
                                    value={r.begin1}
                                    onChange={(v) => {
                                      const patch: Partial<Row> = { begin1: v };
                                      if (v) patch.end1 = calculateEndTime(v);
                                      updateRow(r.id, patch, {
                                        markDirty: true,
                                      });
                                    }}
                                    options={TIME_BEGIN_OPTIONS}
                                    className="w-[120px] text-center"
                                  />
                                ) : (
                                  <span>
                                    {displayTimeFromOptions(
                                      r.begin1,
                                      TIME_BEGIN_OPTIONS
                                    ) || "—"}
                                  </span>
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
                                  <span>
                                    {displayTimeFromOptions(
                                      r.end1,
                                      TIME_END_OPTIONS
                                    ) || "—"}
                                  </span>
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
                                  <DayInput
                                    value={r.day2}
                                    onChange={(v) => {
                                      setDay2ManualById((prev) => ({
                                        ...prev,
                                        [r.id]: true,
                                      }));
                                      setCell(r.id, "day2", v as any);
                                    }}
                                    options={DAY_OPTIONS}
                                    className="w-[150px]"
                                  />
                                ) : (
                                  <span>{r.day2 || "—"}</span>
                                )}
                              </td>

                              <td className="px-2 py-2 text-center">
                                {e.begin2 ? (
                                  <TimeBeginInput
                                    value={r.begin2}
                                    onChange={(v) => {
                                      const patch: Partial<Row> = { begin2: v };
                                      if (v) {
                                        patch.end2 = calculateEndTime(v);
                                      }
                                      updateRow(r.id, patch, {
                                        markDirty: true,
                                      });
                                    }}
                                    options={TIME_BEGIN_OPTIONS}
                                    className="w-[120px] text-center"
                                  />
                                ) : (
                                  <span>
                                    {displayTimeFromOptions(
                                      r.begin2,
                                      TIME_BEGIN_OPTIONS
                                    ) || "—"}
                                  </span>
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
                                  <span>
                                    {displayTimeFromOptions(
                                      r.end2,
                                      TIME_END_OPTIONS
                                    ) || "—"}
                                  </span>
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

                              <td className="px-2 py-2 align-top w-[280px] min-w-[280px]">
                                <div className="flex w-full min-w-0 items-start gap-2">
                                  <textarea
                                    value={
                                      remarksDraftBySection[r.id] ??
                                      String((r as any)?.remarks ?? "")
                                    }
                                    onChange={(ev) =>
                                      queueAutosaveRemark(r, ev.target.value)
                                    }
                                    onBlur={() => {
                                      // Ensure the latest value is persisted when the user leaves the field.
                                      clearRemarkAutosaveTimer(r.id);
                                      void handleSaveRemark(r, {
                                        silentSuccess: true,
                                      });
                                    }}
                                    disabled={isLocked}
                                    placeholder="—"
                                    className={cls(
                                      "flex-1 min-w-0 min-h-[36px] resize-y rounded-md border border-gray-300 px-2 py-1 text-sm leading-snug shadow-sm focus:ring-2 focus:ring-emerald-500/30",
                                      isLocked && "bg-gray-100 text-gray-500"
                                    )}
                                  />
                                </div>
                              </td>

                              <td className="px-2 py-2 text-center">
                                <StatusChip r={r} />
                              </td>

                              <td className="px-2 py-2 text-center">
                                {isRunning && (
                                  <div className="relative flex items-center justify-center gap-3 text-emerald-700">
                                    {/* New-line rows: show Save + Delete only until saved. */}
                                    {!fromFacultyService && !!(r as any).is_new_line ? (
                                      <>
                                        <button
                                          type="button"
                                          className="relative text-blue-600 hover:brightness-110 disabled:opacity-60"
                                          title="Save"
                                          disabled={
                                            !!savingNewLineId && savingNewLineId === r.id
                                          }
                                          onClick={() => void handleSaveNewLineRow(r)}
                                        >
                                          <Save className="h-5 w-5" />
                                        </button>

                                        <button
                                          type="button"
                                          className="relative text-red-600 hover:brightness-110"
                                          title="Delete row"
                                          onClick={() => handleDeleteNewLineRow(r.id)}
                                        >
                                          <Trash2 className="h-5 w-5" />
                                        </button>
                                      </>
                                    ) : (
                                      <>
                                        {!fromFacultyService && (
                                          <button
                                            className={cls(
                                              "relative hover:brightness-110",
                                              isArchiveView &&
                                                "opacity-40 cursor-not-allowed hover:brightness-100"
                                            )}
                                            title="RFC"
                                            onClick={() => {
                                              if (isArchiveView) return;
                                              setReqChange({
                                                open: true,
                                                facultyName:
                                                  r.faculty || "Faculty",
                                                facultyId: (r as any).faculty_id,
                                                sectionId:
                                                  (r as any).section_id || r.id,
                                              });
                                            }}
                                          >
                                            <Inbox className="h-5 w-5" />
                                            {unread && (
                                              <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-red-600" />
                                            )}
                                          </button>
                                        )}

                                        <button
                                          className="relative hover:brightness-110"
                                          title={
                                            copiedRowId === r.id
                                              ? "Copied!"
                                              : "Copy"
                                          }
                                          onClick={() => handleCopyRow(r)}
                                        >
                                          {copiedRowId === r.id ? (
                                            <span className="text-xs font-semibold text-emerald-700">
                                              ✓
                                            </span>
                                          ) : (
                                            <Copy className="h-4 w-4" />
                                          )}
                                        </button>
                                      </>
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
                              colSpan={18}
                              className="px-4 py-10 text-center text-sm text-gray-500"
                            >
                              {rows.length === 0 ? (
                                <>
                                  No data yet. Click{" "}
                                  <span className="font-medium">
                                    Auto-assign
                                  </span>{" "}
                                  or{" "}
                                  <span className="font-medium">
                                    Add new line
                                  </span>{" "}
                                  to begin.
                                </>
                              ) : (
                                <>No rows match your search.</>
                              )}
                            </td>
                          </tr>
                        )}
      </tbody>
    </table>
    </div>

    {loadTableHoverSide === "left" && loadTableCanScrollLeft && (
      <>
        <div className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-white/80 to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 left-2 flex items-center">
          <div className="rounded-full border border-gray-200 bg-emerald-700/80 p-1 shadow-sm backdrop-blur-sm">
            <ChevronLeft className="h-5 w-5 text-white" />
          </div>
        </div>
      </>
    )}

    {loadTableHoverSide === "right" && loadTableCanScrollRight && (
      <>
        <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-white/80 to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
          <div className="rounded-full border border-gray-200 bg-emerald-700/80 p-1 shadow-sm backdrop-blur-sm">
            <ChevronRight className="h-5 w-5 text-white" />
          </div>
        </div>
      </>
    )}
  </div>
)}

                <div className="border-t px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <button
                      onClick={() => {
                        const cid = inferOmCampusId();
                        if (cid && isCampusDeadlinePassed(cid)) {
                          showToast('Cannot add section: the APO-set deadline has passed for this campus.', 'error');
                          return;
                        }
                        addRow();
                      }}
                      disabled={(() => {
                        const cid = inferOmCampusId();
                        return !!cid && isCampusDeadlinePassed(cid);
                      })()}
                      className={cls(
                        "inline-flex h-10 min-w-[140px] items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium",
                        (() => {
                          const cid = inferOmCampusId();
                          return cid && isCampusDeadlinePassed(cid)
                            ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'border-gray-300 bg-white hover:bg-gray-50';
                        })()
                      )}
                      title="Add new line"
                    >
                      <Plus className="h-4 w-4" />
                      Add section
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
              {/* ---- Faculty Deloading (term-wide; show immediately) ---- */}
              <div className="mt-6 rounded-xl border border-gray-300 bg-white shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-4 px-4 pt-4 pb-2">
                  <div>
                    <h2 className="text-lg font-semibold">Faculty Deloading</h2>
                  </div>
                </div>

                {deloadAllError && (
                  <div className="mx-4 mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {deloadAllError}
                  </div>
                )}

                <div className="px-4 pb-4 border-t">
                  <div className="mt-3 max-h-[255px] overflow-x-auto overflow-y-auto rounded-xl border border-gray-300 bg-white">
                    {deloadAllLoading ? (
                      <div className="py-6 text-center text-sm text-gray-500">
                        Loading…
                      </div>
                    ) : deloadFiltered.length === 0 ? (
                      <div className="py-6 text-center text-sm text-gray-500">
                        {deloadAllRows.length === 0
                          ? "No deloadings recorded for this term."
                          : "No deloadings match your search."}
                      </div>
                    ) : (
                      <table className="w-full text-sm table-fixed border-collapse">
                          <colgroup>
                            <col style={{ width: "22%" }} />
                            <col style={{ width: "20%" }} />
                            <col style={{ width: "10%" }} />
                            <col style={{ width: "33%" }} />
                            <col style={{ width: "15%" }} />
                          </colgroup>
                          <thead className="bg-gray-50 text-gray-900 sticky top-0 z-10">
                            <tr className="whitespace-nowrap text-[13px] font-semibold">
                              <th className="px-3 py-2 text-left border border-gray-300">
                                Faculty
                              </th>
                              <th className="px-3 py-2 text-left border border-gray-300">
                                Deloading Type
                              </th>
                              <th className="px-3 py-2 text-right border border-gray-300">
                                Units
                              </th>
                              <th className="px-3 py-2 text-left border border-gray-300">
                                Notes
                              </th>
                              <th className="px-3 py-2 text-center border border-gray-300">
                                Last Updated
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {deloadFiltered.map((r, i) => (
                              <tr
                                key={`${r.faculty_id}-${
                                  r.deloading_type || "row"
                                }-${i}`}
                                className="hover:bg-gray-50"
                              >
                                <td className="px-3 py-2 align-middle border border-gray-300">
                                  <div className="font-medium text-gray-900">
                                    {r.faculty_name_display || r.faculty_id}
                                  </div>
                                </td>
                                <td className="px-3 py-2 align-middle border border-gray-300">
                                  {r.deloading_type || "—"}
                                </td>
                                <td className="px-3 py-2 text-right align-middle border border-gray-300">
                                  {r.units_deloaded ?? "—"}
                                </td>
                                <td className="px-3 py-2 align-middle border border-gray-300">
                                  {r.notes || "—"}
                                </td>
                                <td className="px-3 py-2 text-center align-middle border border-gray-300">
                                  {r.updated_at
                                    ? new Date(
                                        r.updated_at as any
                                      ).toLocaleDateString()
                                    : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                    )}
                  </div>

                  {!deloadAllLoading && deloadFiltered.length > 0 && (
                    <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                      {deloadAllRows.length > 5}
                    </div>
                  )}
                </div>
              </div>

              {/* ---- Summary section under Load Recommendations ---- */}
              {rows.length > 0 && (
                <div className="mt-6 rounded-xl border border-gray-300 bg-white shadow-sm">
                  <div className="flex items-center justify-between px-4 pt-4 pb-2">
                    <div>
                      <h2 className="text-lg font-semibold">
                        Faculty Load Summary
                      </h2>
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
                        Units vs Preferences
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
                    <div className="border-t px-4 pb-4 w-full">
                      <div className="py-3">
                        <div className="flex items-center justify-between">
                          <div className="text-xs font-semibold text-gray-700">Filters</div>

                          <div className="text-xs text-gray-500">
                            Showing{" "}
                            <span className="font-semibold">{facultySummaryView.length}</span> of{" "}
                            <span className="font-semibold">{facultySummaryFiltered.length}</span>
                          </div>
                        </div>

                        <div className="mt-2 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2">
                          <div className="flex flex-wrap items-center gap-4 text-xs">
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="radio"
                                name="unitsFilterMode"
                                checked={unitsFilterMode === "all"}
                                onChange={() => setUnitsFilterMode("all")}
                              />
                              Show all
                            </label>

                            <label className="inline-flex items-center gap-2">
                              <input
                                type="radio"
                                name="unitsFilterMode"
                                checked={unitsFilterMode === "issues"}
                                onChange={() => setUnitsFilterMode("issues")}
                              />
                              Under/Overloaded vs preferred
                            </label>

                            <label className="inline-flex items-center gap-2">
                              <input
                                type="radio"
                                name="unitsFilterMode"
                                checked={unitsFilterMode === "match"}
                                onChange={() => setUnitsFilterMode("match")}
                              />
                              Matches preferred units
                            </label>

                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={hideNoPrefs}
                                onChange={(e) => setHideNoPrefs(e.target.checked)}
                              />
                              Hide no preferences
                            </label>
                          </div>
                        </div>
                      </div>


{/* Scroll wrapper */}
                      <div className="max-h-[360px] overflow-x-auto overflow-y-auto rounded-xl border border-gray-300 bg-white">
                        <table className="w-full text-sm table-fixed border-collapse">
                          {/* Unequal widths: left half (Faculty/Status) wider, right half (numbers) narrower */}
                          <colgroup>
                            <col className="w-[40%]" /> {/* Faculty */}
                            <col className="w-[18%]" /> {/* Status */}
                            {/* <col className="w-[8%]" />  Leaves */}
                            <col className="w-[10%]" /> {/* Teaching */}
                            <col className="w-[10%]" /> {/* Preferred */}
                            <col className="w-[10%]" /> {/* Deloading */}
                            <col className="w-[12%]" /> {/* Total */}
                          </colgroup>

                          <thead className="bg-gray-50 text-gray-900 sticky top-0 z-10">
                            <tr className="whitespace-nowrap text-[13px] font-semibold">
                              <th className="px-3 py-2 text-left font-semibold border border-gray-300">
                                <button
                                  type="button"
                                  onClick={() => toggleUnitsSort("faculty")}
                                  className="inline-flex items-center gap-1 hover:underline"
                                >
                                  Faculty{" "}
                                  {unitsSortKey === "faculty"
                                    ? unitsSortDir === "asc"
                                      ? "▲"
                                      : "▼"
                                    : ""}
                                </button>
                              </th>

                              <th className="px-3 py-2 text-left font-semibold border border-gray-300">
                                <span className="whitespace-nowrap">
                                  Load Status <span className="text-[11px] font-medium text-gray-500">(vs Preferred)</span>
                                </span>
                              </th>
                              
                              {/* <th className="px-3 py-2 text-center font-semibold border border-gray-300">
                                <button
                                  type="button"
                                  onClick={() => toggleUnitsSort("leave")}
                                  className="inline-flex items-center justify-center gap-1 hover:underline"
                                  title="Leave units (credited or counted units from leaves)"
                                >
                                  Leaves{" "}
                                  {unitsSortKey === "leave"
                                    ? unitsSortDir === "asc"
                                      ? "▲"
                                      : "▼"
                                    : ""}
                                </button>
                              </th> */}

                              <th className="px-3 py-2 text-center font-semibold border border-gray-300">
                                <button
                                  type="button"
                                  onClick={() => toggleUnitsSort("assigned")} // keep existing key
                                  className="inline-flex items-center justify-center gap-1 hover:underline"
                                  title="Teaching units from scheduled assignments (classes only)"
                                >
                                  Teaching Units{" "}
                                  {unitsSortKey === "assigned"
                                    ? unitsSortDir === "asc"
                                      ? "▲"
                                      : "▼"
                                    : ""}
                                </button>
                              </th>

                              <th className="px-3 py-2 text-center font-semibold border border-gray-300">
                                <button
                                  type="button"
                                  onClick={() => toggleUnitsSort("preferred")}
                                  className="inline-flex items-center justify-center gap-1 hover:underline"
                                  title="Preferred/target units submitted by faculty"
                                >
                                  Preferred Units{" "}
                                  {unitsSortKey === "preferred"
                                    ? unitsSortDir === "asc"
                                      ? "▲"
                                      : "▼"
                                    : ""}
                                </button>
                              </th>

                              <th className="px-3 py-2 text-center font-semibold border border-gray-300">
                                <button
                                  type="button"
                                  onClick={() => toggleUnitsSort("deload")}
                                  className="inline-flex items-center justify-center gap-1 hover:underline"
                                  title="Deloading units credited from faculty deloading rows"
                                >
                                  Deloading Units{" "}
                                  {unitsSortKey === "deload"
                                    ? unitsSortDir === "asc"
                                      ? "▲"
                                      : "▼"
                                    : ""}
                                </button>
                              </th>

                              <th className="px-3 py-2 text-center font-semibold border border-gray-300">
                                <div className="leading-tight">
                                  <div>Total Units</div>
                                  <div className="text-[11px] font-medium text-gray-500">
                                    (Teaching + Deloading)
                                  </div>
                                </div>
                              </th>
                            </tr>
                          </thead>

                          <tbody>
                            {facultySummary.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={6}
                                  className="px-3 py-6 text-center text-sm text-gray-500 border border-gray-300"
                                >
                                  No faculty have assignments yet for this term.
                                </td>
                              </tr>
                            ) : facultySummaryView.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={6}
                                  className="px-3 py-6 text-center text-sm text-gray-500 border border-gray-300"
                                >
                                  No matching faculty rows.
                                </td>
                              </tr>
                            ) : null}

                            {facultySummaryView.map((f) => {
                              const hasPref = f.preferredUnits != null;

                              // const isOnLeave = !!(f.facultyId && onLeaveSet.has(f.facultyId));
                              // const leaveUnits = isOnLeave ? 12 : 0;

                              const teachingUnits = Number(f.assignedUnits ?? 0);
                              const deloadUnits = Number(
                                (f.facultyId && deloadUnitsByFacultyId[f.facultyId]) || 0
                              );
                              // const totalUnits = teachingUnits + deloadUnits + leaveUnits;
                              const totalUnits = teachingUnits + deloadUnits
                              
                              const teachTone = classForTeaching(teachingUnits);
                              const adminTone = classForAdmin(deloadUnits);
                              const totalTone = classForTotal(totalUnits);

                              const diff = hasPref ? totalUnits - Number(f.preferredUnits) : null;

                              const fmt = (n: number) => Number(n).toFixed(1).replace(/\.0$/, "");

                              return (
                                <tr key={f.facultyId || f.facultyName} className="hover:bg-gray-50">
                                  <td className="px-3 py-2 align-middle border border-gray-300">
                                    <div className="font-medium text-gray-900">{f.facultyName}</div>
                                  </td>

                                  {/* old pill status */}
                                  {/* <td className="px-3 py-2 align-middle border border-gray-300">
                                  {hasPref && diff != null ? (
                                    <span
                                      className={cls(
                                        "inline-flex items-stretch overflow-hidden rounded-md border text-[11px] font-semibold",
                                        diff > 0
                                          ? "border-red-200"
                                          : diff < 0
                                          ? "border-amber-200"
                                          : "border-emerald-200"
                                      )}
                                    >
                                      <span
                                        className={cls(
                                          "px-2 py-0.5",
                                          diff > 0
                                            ? "bg-red-50 text-red-700"
                                            : diff < 0
                                            ? "bg-amber-50 text-amber-700"
                                            : "bg-emerald-50 text-emerald-700"
                                        )}
                                      >
                                        {diff > 0 ? "OVER" : diff < 0 ? "UNDER" : "MATCH"}
                                      </span>

                                      <span className="px-2 py-0.5 bg-white text-gray-900 tabular-nums">
                                        {diff === 0 ? "0" : Math.abs(diff)}
                                      </span>

                                      <span className="px-2 py-0.5 bg-white text-gray-500 font-medium">
                                        units
                                      </span>
                                    </span>
                                  ) : (
                                    <span className="text-xs text-gray-400">—</span>
                                  )}
                                </td> */}
                                  
                                  <td
                                    className="px-3 py-2 text-left align-middle border border-gray-300 tabular-nums"
                                    title={
                                      hasPref && diff != null
                                        ? diff === 0
                                          ? "Match: Total equals Preferred"
                                          : diff > 0
                                          ? `Over: Total is ${diff} unit(s) above Preferred`
                                          : `Under: Total is ${Math.abs(diff)} unit(s) below Preferred`
                                        : ""
                                    }
                                  >
                                    {hasPref && diff != null ? (
                                      <span
                                        className={cls(
                                          "font-semibold",
                                          diff === 0
                                            ? "text-emerald-700"
                                            : diff > 0
                                            ? "text-red-700"
                                            : "text-amber-700"
                                        )}
                                      >
                                        {diff > 0 ? `+${diff}` : `${diff}`}
                                      </span>
                                    ) : (
                                      <span className="text-xs text-gray-400">—</span>
                                    )}
                                  </td>

                                {/* <td className="px-3 py-2 text-center align-middle border border-gray-300 tabular-nums">
                                  {leaveUnits > 0 ? fmt(leaveUnits) : "0"}
                                </td> */}

                                  <td className={cls("px-3 py-2 text-center align-middle border border-gray-300", teachTone)}>
                                    {fmt(teachingUnits)}
                                  </td>

                                  <td className="px-3 py-2 text-center align-middle border border-gray-300">
                                    {hasPref ? fmt(Number(f.preferredUnits)) : "—"}
                                  </td>

                                  <td className={cls("px-3 py-2 text-center align-middle border border-gray-300", adminTone)}>
                                    {fmt(deloadUnits)}
                                  </td>

                                  <td className={cls("px-3 py-2 text-center align-middle border border-gray-300 tabular-nums font-semibold", totalTone)}>
                                    {fmt(totalUnits)}
                                  </td>

                                  {/* <td className={cls("px-3 py-2 text-center align-middle border border-gray-300 tabular-nums font-semibold", totalTone)}>
                                  <span className="whitespace-nowrap">
                                    {fmt(totalUnits)}
                                    {(deloadUnits > 0 || teachingUnits > 0) && (
                                      <span
                                      className={cls(
                                        "ml-2 font-medium",
                                        totalUnits === 12 || totalUnits > 12 || totalUnits === 0
                                          ? "text-white/90"
                                          : "text-gray-600"
                                      )}
                                    >
                                      ({fmt(teachingUnits)} + {fmt(deloadUnits)})
                                    </span>
                                    )}
                                  </span>
                                </td> */}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Tab 2: Rule / condition flags */}
                  {summaryTab === "second" && (
                    <div className="px-4 pb-4 border-t">
                      <div className="mt-3 max-h-[360px] overflow-x-auto overflow-y-auto rounded-xl border border-gray-300 bg-white">
                        {ruleAlerts.length === 0 ? (
                          <div className="py-6 text-center text-sm text-gray-500">
                            No rule violations detected for the current
                            assignments.
                          </div>
                        ) : ruleAlertsFiltered.length === 0 ? (
                          <div className="py-6 text-center text-sm text-gray-500">
                            No violations match your search.
                          </div>
                        ) : (
                          <table className="w-full text-sm table-fixed border-collapse">
                            <thead className="bg-gray-50 text-gray-900 sticky top-0 z-10">
                              <tr className="whitespace-nowrap text-[13px] font-semibold">
                                <th className="px-3 py-2 text-left border border-gray-300">
                                  Rule
                                </th>
                                <th className="px-3 py-2 text-left border border-gray-300">
                                  Faculty
                                </th>
                                <th className="px-3 py-2 text-center border border-gray-300">
                                  Course
                                </th>
                                <th className="px-3 py-2 text-center border border-gray-300">
                                  Section
                                </th>
                                <th className="px-3 py-2 text-left border border-gray-300">
                                  Message
                                </th>
                                <th className="px-3 py-2 text-center border border-gray-300">
                                  Severity
                                </th>
                              </tr>
                            </thead>
                            <tbody >
                              {ruleAlertsFiltered.map((a) => (
                                <tr key={a.id} className="hover:bg-gray-50">
                                  <td className="px-3 py-2 align-top border border-gray-300">
                                    <span className="font-mono text-[11px]">
                                      {a.rule}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 align-top border border-gray-300">
                                    <div className="font-medium text-gray-900">
                                      {a.facultyName || "—"}
                                    </div>
                                  </td>
                                  <td className="px-3 py-2 text-center align-top text-gray-600 border border-gray-300">
                                    {a.course || "—"}
                                  </td>
                                  <td className="px-3 py-2 text-center align-top text-gray-600 border border-gray-300">
                                    {a.section || "—"}
                                  </td>
                                  <td className="px-3 py-2 align-top border border-gray-300">
                                    {a.message}
                                  </td>
                                  <td className="px-3 py-2 text-center align-top border border-gray-300">
                                    <span
                                      className={cls(
                                        "inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-[11px] font-medium border",
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
                        )}
                      </div>
                    </div>
                  )}

                  {summaryTab === "blocked" && (
                    <div className="px-4 pb-4 border-t">
                      <div className="mt-3 max-h-[360px] overflow-x-auto overflow-y-auto rounded-xl border border-gray-300 bg-white">
                        <table className="w-full text-sm table-fixed border-collapse">
                          <thead className="bg-gray-50 text-gray-900 sticky top-0 z-10">
                            <tr className="whitespace-nowrap text-[13px] font-semibold">
                              <th className="px-3 py-2 text-left border border-gray-300">
                                Course
                              </th>
                              <th className="px-3 py-2 text-left border border-gray-300">
                                Section
                              </th>
                              <th className="px-3 py-2 text-left border border-gray-300">
                                Day 1
                              </th>
                              <th className="px-3 py-2 text-left border border-gray-300">
                                Begin 1
                              </th>
                              <th className="px-3 py-2 text-left border border-gray-300">
                                End 1
                              </th>
                              <th className="px-3 py-2 text-left border border-gray-300">
                                Day 2
                              </th>
                              <th className="px-3 py-2 text-left border border-gray-300">
                                Begin 2
                              </th>
                              <th className="px-3 py-2 text-left border border-gray-300">
                                End 2
                              </th>
                              <th className="px-3 py-2 text-left border border-gray-300">
                                Program
                              </th>
                              <th className="px-3 py-2 text-left border border-gray-300">
                                Batch
                              </th>
                            </tr>
                          </thead>
                          <tbody >
                            {blockedSections.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={10}
                                  className="border border-gray-300 py-6 text-center text-sm text-gray-500"
                                >
                                  No blocked GE sections for Laguna.
                                </td>
                              </tr>
                            ) : blockedSectionsFiltered.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={10}
                                  className="border border-gray-300 py-6 text-center text-sm text-gray-500"
                                >
                                  No blocked sections match your search.
                                </td>
                              </tr>
                            ) : (
                              blockedSectionsFiltered.map((b) => {
                                const dayRank: Record<string, number> = {
                                  M: 1,
                                  T: 2,
                                  W: 3,
                                  H: 4,
                                  F: 5,
                                  S: 6,
                                };

                                const slotItems = (blockedGeCmps2 || [])
                                  .filter((x) => x.section_id === b.rowId)
                                  .slice()
                                  .sort((a, bb) => {
                                    const da =
                                      dayRank[(a.day || "").toUpperCase()] ??
                                      99;
                                    const dbb =
                                      dayRank[(bb.day || "").toUpperCase()] ??
                                      99;
                                    if (da !== dbb) return da - dbb;
                                    const ta =
                                      parseInt(String(a.begin || "0"), 10) || 0;
                                    const tb =
                                      parseInt(String(bb.begin || "0"), 10) ||
                                      0;
                                    return ta - tb;
                                  });

                                const s1 = slotItems[0];
                                const s2 = slotItems[1];

                                const day1 = s1?.day ?? "—";
                                const begin1 = s1?.begin ?? "—";
                                const end1 = s1?.end ?? "—";
                                const day2 = s2?.day ?? "—";
                                const begin2 = s2?.begin ?? "—";
                                const end2 = s2?.end ?? "—";

                                return (
                                  <tr key={b.rowId} className="hover:bg-gray-50">
                                    <td className="px-3 py-2 text-gray-900 font-medium border border-gray-300">
                                      {b.course || "—"}
                                    </td>
                                    <td className="px-3 py-2 text-gray-700 border border-gray-300">
                                      {b.section || "—"}
                                    </td>
                                    <td className="px-3 py-2 text-gray-700 border border-gray-300">
                                      {day1}
                                    </td>
                                    <td className="px-3 py-2 text-gray-700 border border-gray-300">
                                      {begin1}
                                    </td>
                                    <td className="px-3 py-2 text-gray-700 border border-gray-300">
                                      {end1}
                                    </td>
                                    <td className="px-3 py-2 text-gray-700 border border-gray-300">
                                      {day2}
                                    </td>
                                    <td className="px-3 py-2 text-gray-700 border border-gray-300">
                                      {begin2}
                                    </td>
                                    <td className="px-3 py-2 text-gray-700 border border-gray-300">
                                      {end2}
                                    </td>
                                    <td className="px-3 py-2 text-gray-700 border border-gray-300">
                                      {b.program || "—"}
                                    </td>
                                    <td className="px-3 py-2 text-gray-700 border border-gray-300">
                                      {b.batch || "—"}
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

      {archiveOpen && (
        <div className="fixed inset-0 z-[150] grid place-items-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  Archived Loads
                </h3>
                <p className="mt-0.5 text-sm text-gray-600">
                  Display faculty loads from past terms.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setArchiveOpen(false)}
                className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                title="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="px-5 py-4">
              <label className="block text-sm font-medium text-gray-700">
                Term
              </label>
              <div className="mt-1">
                <SelectBox
                  value={archiveTermId}
                  onChange={(v) => setArchiveTermId(v)}
                  options={archiveTerms.map((t) => ({
                    value: t.term_id,
                    label: `${t.label}${t.is_active ? " (Active)" : ""}`,
                  }))}
                  placeholder="— Select term —"
                  className="w-full"
                  buttonClassName={cls(
                    // Match the Faculty column dropdown style
                    "rounded-lg px-3 py-2 pr-8 text-left text-sm",
                    "focus:ring-2 focus:ring-emerald-500/30"
                  )}
                />
              </div>

              {isArchiveView && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  You’re currently viewing an archived term. Actions like
                  Auto-assign, Import, Send, and Save are disabled.
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 px-5 py-4">
              {isArchiveView && (
                <button
                  type="button"
                  onClick={() => {
                    setArchiveOpen(false);
                    void loadFromServer(undefined);
                  }}
                  className="inline-flex h-10 items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                >
                  Back to Active Term
                </button>
              )}

              <button
                type="button"
                onClick={() => setArchiveOpen(false)}
                className="inline-flex h-10 items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={!archiveTermId}
                onClick={() => {
                  const tid = archiveTermId;
                  setArchiveOpen(false);
                  if (tid) void loadFromServer(tid);
                }}
                className={cls(
                  "inline-flex h-10 items-center justify-center rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110",
                  !archiveTermId && "opacity-60 cursor-not-allowed"
                )}
              >
                Load
              </button>
            </div>
          </div>
        </div>
      )}

      <SendModal
        open={showSend}
        onClose={() => setShowSend(false)}
        rows={sendRowsPreview}
        termLabel={term}
        onSend={handleSendToFaculty}
        onToast={showToast}
      />

      <SendBlockedModal
        open={sendBlocked.open}
        missing={sendBlocked.missing}
        onClose={() => setSendBlocked({ open: false, missing: [] })}
      />

      <RequestChangeModal
        open={reqChange.open}
        facultyName={reqChange.facultyName}
        facultyId={reqChange.facultyId}
        sectionId={reqChange.sectionId}
        onClose={() => setReqChange({ open: false })}
        userId={userId || ""}
        termId={termId || ""}
        onAfterUpdate={loadFromServer}
        onToast={showToast}
      />

      <NewSectionModal
        open={showNewSectionModal}
        onClose={() => setShowNewSectionModal(false)}
        courseOptions={courseOptions}
        onToast={showToast}
        onSave={({ course, section, units, campus_id }) => {
          // create a new manual row that behaves like other rows,
          // but with the extra campus_id attached
          const title =
            courseOptions.find((c) => c.code === course)?.title || "";

          commitRows([
            ...rows,
            {
              id: `manual-${Date.now()}`,
              course,
              title,
              units: units ? Number(units) || "" : "",
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
          setShowNewSectionModal(false);
        }}
      />

      {/* Import SHS modal (match APO import UX) */}
      {showShsImportModal && (
        <div
          className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full border-2 border-emerald-600 text-emerald-700">
              <Upload className="h-8 w-8" strokeWidth={2.5} />
            </div>

            <h3 className="mb-2 text-center text-2xl font-semibold">
              Import SHS CSV
            </h3>
            <p className="mx-auto mb-4 max-w-md text-center text-sm text-neutral-600">
              Upload a CSV fsile to import SHS sections into the current
              planning term.
            </p>

            <div className="mb-4 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              <div className="mb-1 font-semibold">CSV format</div>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  Required columns:{" "}
                  <span className="font-mono">Course Code &amp; Title</span>,{" "}
                  <span className="font-mono">Units</span>,{" "}
                  <span className="font-mono">Section</span>,{" "}
                  <span className="font-mono">Day 1</span>,{" "}
                  <span className="font-mono">Begin 1</span>,{" "}
                  <span className="font-mono">End 1</span>,{" "}
                  <span className="font-mono">Room 1</span>,{" "}
                  <span className="font-mono">Day 2</span>,{" "}
                  <span className="font-mono">Begin 2</span>,{" "}
                  <span className="font-mono">End 2</span>,{" "}
                  <span className="font-mono">Room 2</span>,{" "}
                  <span className="font-mono">Capacity</span>,{" "}
                  <span className="font-mono">Mode</span>
                </li>
              </ul>
            </div>

            {!!shsImportError && (
              <div className="mb-4 whitespace-pre-wrap rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                {shsImportError}
              </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={downloadShsTemplate}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-white px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
              >
                <Download className="h-4 w-4" />
                Download template
              </button>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={closeShsImport}
                  disabled={shsImportBusy}
                  className={cls(
                    "rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200",
                    shsImportBusy && "opacity-60 cursor-not-allowed"
                  )}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handlePickShsFile}
                  disabled={shsImportBusy || isArchiveView}
                  className={cls(
                    "inline-flex items-center gap-2 rounded-lg bg-[#008e4e] px-4 py-2 text-sm font-medium text-white shadow-sm hover:brightness-110",
                    (shsImportBusy || isArchiveView) &&
                      "opacity-60 cursor-not-allowed hover:brightness-100"
                  )}
                  title={
                    isArchiveView
                      ? "Archived view: importing is disabled"
                      : "Choose a CSV file"
                  }
                >
                  <Upload className="h-4 w-4" />
                  {shsImportBusy ? "Importing…" : "Choose file"}
                </button>
              </div>
            </div>

            <div className="mt-3 text-center text-xs text-neutral-500">
              {shsFile ? `Selected: ${shsFile.name}` : "No file selected yet."}
            </div>

            <input
              ref={shsFileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={handleShsFileChange}
            />
          </div>
        </div>
      )}
{chairExportExcel && chairPlantillaOpen && (
  <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 px-3 py-6">
    <div className="w-full max-w-screen-2xl h-[85vh] rounded-2xl bg-white shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Confirm Export: Faculty Plantilla</h3>
          <p className="mt-0.5 text-sm text-gray-600">
            {chairPlantillaHeader?.dept_label ? chairPlantillaHeader.dept_label : "Department"}
            {chairPlantillaHeader?.term_label ? ` · ${chairPlantillaHeader.term_label}` : ""}
          </p>
        </div>

        <button
          type="button"
          onClick={closeChairPlantillaPreview}
          className="inline-flex h-9 w-9 items-center justify-center bg-white text-sm font-semibold text-gray-700 hover:bg-gray-50"
          title="Close"
          aria-label="Close"
        >
          X
        </button>
      </div>

      <div className="px-5 py-4 border-b border-gray-200 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={chairPlantillaSearchInput}
            onChange={(e) => setChairPlantillaSearchInput(e.target.value)}
            placeholder="Search faculty, course, or section…"
            className="w-full rounded-lg border border-gray-300 pl-9 pr-10 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
          {chairPlantillaSearchInput.trim().length > 0 && (
            <button
              type="button"
              onClick={() => {
                setChairPlantillaSearchInput("");
                setChairPlantillaSearch("");
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
              aria-label="Clear search"
              title="Clear"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={chairHandleExportExcel}
          disabled={chairPlantillaLoading || chairPlantillaFilteredRows.length === 0}
          className={cls(
            "inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium text-white",
            !(chairPlantillaLoading || chairPlantillaFilteredRows.length === 0)
              ? "bg-blue-600 hover:brightness-110"
              : "bg-gray-300 cursor-not-allowed"
          )}
          title="Export plantilla as Excel (.xls)"
        >
          <Download className="h-4 w-4" />
          Export Excel
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden px-5 py-4">
        <div className="h-full w-full overflow-auto rounded-xl border border-gray-300 bg-white shadow-sm">
          <table
            ref={chairPlantillaTableRef}
            className="min-w-full w-full text-sm table-fixed border-collapse leading-snug [&_td]:align-top [&_td]:whitespace-normal [&_td]:break-words"
          >
            <colgroup>
              <col className="w-[5rem]" />
              <col className="w-[14rem]" />
              <col className="w-[7.5rem]" />
              <col className="w-[6rem]" />
              <col className="w-[6.5rem]" />
              <col className="w-[8rem]" />
              <col className="w-[7rem]" />
              <col className="w-[8rem]" />
              <col className="w-[7rem]" />
              <col className="w-[6.5rem]" />
              <col className="w-[8rem]" />
              <col className="w-[6.5rem]" />
              <col className="w-[8rem]" />
              <col className="w-[6.5rem]" />
              <col className="w-[6.5rem]" />
              <col className="w-[7rem]" />
              <col className="w-[8rem]" />
              <col className="w-[7rem]" />
              <col className="w-[9rem]" />
              <col className="w-[9rem]" />
              <col className="w-[28rem]" />
            </colgroup>

            <thead className="bg-gray-50 text-emerald-800 sticky top-0 z-[1] text-xs">
              <tr className="whitespace-nowrap text-[13px] font-semibold">
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">Rank</th>
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">Faculty</th>
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">Course</th>
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">Section</th>
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">Day</th>
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">Time</th>
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">Room</th>
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">No. of Students</th>
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">Lecture Hours</th>
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">Lab Hours</th>
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">Student Unit(s)</th>
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">On Leave</th>
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">Type of Course</th>
                <th colSpan={4} className="px-3 py-2 text-center border border-gray-300">NATURE OF LOAD</th>
                <th colSpan={3} className="px-3 py-2 text-center border border-gray-300">PREMIUMS</th>
                <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">Remarks</th>
              </tr>
              <tr className="whitespace-nowrap text-[13px] font-semibold">
                <th className="px-3 py-2 text-center border border-gray-300">Teaching</th>
                <th className="px-3 py-2 text-center border border-gray-300">Admin</th>
                <th className="px-3 py-2 text-center border border-gray-300">Research</th>
                <th className="px-3 py-2 text-center border border-gray-300">Faculty Unit(s)</th>
                <th className="px-3 py-2 text-center border border-gray-300">Grad Load</th>
                <th className="px-3 py-2 text-center border border-gray-300">Premium 4th Prep</th>
                <th className="px-3 py-2 text-center border border-gray-300">Overload (NCA)</th>
              </tr>
            </thead>

            <tbody>
              {chairPlantillaLoading ? (
                <tr>
                  <td colSpan={21} className="px-4 py-10 text-center text-sm text-gray-500">Loading plantilla…</td>
                </tr>
              ) : chairPlantillaFilteredRows.length === 0 ? (
                <tr>
                  <td colSpan={21} className="px-4 py-10 text-center text-sm text-gray-500">
                    {chairPlantillaRows.length === 0 ? "No plantilla to display." : "No matching results."}
                  </td>
                </tr>
              ) : (
                chairPlantillaFilteredRows.map((r, i) => (
                  <tr key={i} className="hover:bg-gray-50 [&>td]:border [&>td]:border-gray-200">
                    <td className="px-3 py-2 text-center">{r.rank ?? ""}</td>
                    <td className="px-3 py-2 text-left font-semibold text-emerald-700">
                      {(() => {
                        const prev = chairPlantillaFilteredRows[i - 1];
                        const prevName = String(prev?.faculty_name || "").trim().toLowerCase();
                        const curName = String(r.faculty_name || "").trim().toLowerCase();
                        const show = i === 0 || prevName !== curName;
                        if (!curName) return "—";
                        return show ? r.faculty_name : "";
                      })()}
                    </td>
                    <td className="px-3 py-2 text-center">{r.course_code || "—"}</td>
                    <td className="px-3 py-2 text-center">{r.section_code || "—"}</td>
                    <td className="px-3 py-2 text-center whitespace-nowrap"><ChairDayCell raw={r.day_text || "—"} /></td>
                    <td className="px-3 py-2 text-center whitespace-nowrap"><ChairTimeCell raw={r.time_text || "—"} /></td>
                    <td className="px-3 py-2 text-center"><ChairRoomCell raw={r.room_text || ""} /></td>
                    <td className="px-3 py-2 text-center">{r.student_count ?? "—"}</td>
                    <td className="px-3 py-2 text-center">{r.lec_hours ?? "—"}</td>
                    <td className="px-3 py-2 text-center">{r.lab_hours ?? "—"}</td>
                    <td className="px-3 py-2 text-center">{r.student_units ?? "—"}</td>
                    <td className="px-3 py-2 text-center">{r.on_leave || "N/A"}</td>
                    <td className="px-3 py-2 text-center">{r.course_type || "N/A"}</td>
                    <td className="px-3 py-2 text-center">{r.nature_teaching ?? "—"}</td>
                    <td className="px-3 py-2 text-center">{r.nature_admin ?? "—"}</td>
                    <td className="px-3 py-2 text-center">{r.nature_research ?? "—"}</td>
                    <td className="px-3 py-2 text-center">{r.nature_faculty_units ?? "—"}</td>
                    <td className="px-3 py-2 text-center">{r.premium_grad ?? "—"}</td>
                    <td className="px-3 py-2 text-center">{r.premium_4th_prep ?? "—"}</td>
                    <td className="px-3 py-2 text-center">{r.premium_overload ?? "—"}</td>
                    <td className="px-3 py-2 text-left">{r.remarks || ""}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
)}


      {!hideForwardToChair && (
      <>
      {/* Re-forward review modal (APO-style change list) */}
      <ForwardReviewModal
        open={showForwardReview}
        changes={forwardReviewChanges}
        title="Re-forward to Chair?"
        subtitle={
          <>
            You're about to{" "}
            <span className="font-semibold text-neutral-800">re-notify</span>{" "}
            the Chair. Review the detected changes below before sending.
          </>
        }
        confirmText="Re-forward"
        onClose={() => setShowForwardReview(false)}
        onConfirm={async () => {
          setShowForwardReview(false);
          await handleForwardToChair();
        }}
      />
      </>
      )}
{/* Global toast */}
      <Toast
        open={!!toast}
        kind={toast?.kind}
        message={toast?.message || ""}
        onClose={clearToast}
      />
        </>
  );

  if (embedded) return content;

  return (
    <AppShell
      // make TopBar’s Inbox icon open our OM Inbox-as-tab
      topbarProfileName={profileName || " "}
      topbarProfileSubtitle={profileSubtitle || " "}
      // @ts-ignore
      topbarInboxEvent="om:openInbox"
    >
      {content}
    </AppShell>
  );
}