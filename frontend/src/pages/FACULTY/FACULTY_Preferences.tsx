// FACULTY_Preferences.tsx

import React, { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, MapPin, Monitor, BookOpen, Settings, Info, AlertTriangle, X, ChevronDown, CheckCircle2 } from "lucide-react";
import {
  getFacultyPreferencesProfile,
  getFacultyPreferencesOptions,
  getFacultyPreferencesList,
  submitFacultyPreferences,
} from "../../api";

/* ---------- tiny utils ---------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

/* ---------- tags ---------- */
const TAG_STYLES = {
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  gray: "bg-gray-50 text-gray-600 border-gray-200",
} as const;
function Tag({ children, tone = "emerald" }: { children: React.ReactNode; tone?: keyof typeof TAG_STYLES }) {
  return (
    <span
      className={cls(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
        TAG_STYLES[tone]
      )}
    >
      {children}
    </span>
  );
}


/* ---------- removable chip ---------- */
function Chip({
  label,
  onRemove,
}: {
  label: string;
  onRemove?: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[12px] text-emerald-800">
      <span className="max-w-[340px] truncate" title={label}>
        {label}
      </span>
      {onRemove ? (
        <button
          type="button"
          onClick={(e) => {
            // Chips are rendered inside the dropdown trigger button.
            // Prevent this click from toggling the dropdown.
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          className="rounded-full p-0.5 text-emerald-800/70 hover:bg-emerald-100 hover:text-emerald-900"
          aria-label={`Remove ${label}`}
          title="Remove"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </span>
  );
}

/* ---------- shared label/dropdown styles ---------- */
function FieldLabel({ children, required = false }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="mb-2 block text-[15px] font-semibold text-emerald-700">
      {children} {required && <span className="text-red-600">*</span>}
    </label>
  );
}
const DD_BASE =
  "w-full rounded-2xl border border-gray-300 bg-white py-3 pl-4 pr-10 text-left text-[15px] shadow-sm outline-none hover:bg-gray-50 focus:ring-2 focus:ring-emerald-500/30";
const DD_MENU =
  "absolute z-20 mt-2 max-h-80 w-full overflow-auto rounded-2xl border border-gray-300 bg-white shadow-lg";



/* ---------- modal ---------- */
function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  if (!open) return null;
  return (
    // Use a very high z-index + top padding so the modal never gets hidden by
    // the app's fixed top bar/header.
    <div className="fixed inset-0 z-[9999] flex items-start justify-center p-4 pt-20 sm:pt-24">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl max-h-[calc(100vh-6rem)]">
        <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-neutral-900">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={cls("rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800")}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="shrink-0 border-t border-neutral-200 px-5 py-4">{footer}</div> : null}
      </div>
    </div>
  );
}


/* ---------- shared button styles ---------- */
const BTN_BASE = "inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-medium shadow active:translate-y-[0.5px]";
const BTN_PRIMARY = cls(BTN_BASE, "bg-emerald-700 text-white hover:brightness-110");
const BTN_NEUTRAL =
  "inline-flex h-9 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-100 px-4 text-sm text-slate-900 shadow-sm hover:bg-neutral-200/70 active:translate-y-[0.5px]";
const BTN_REMOVE =
  "inline-flex h-9 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 px-4 text-sm text-neutral-800 hover:bg-neutral-100 active:translate-y-[0.5px]";

/* ---------- multi-select dropdown ---------- */
function MultiSelectDropdown({
  values,
  onChange,
  options,
  className = "w/full",
  placeholder = "— Select options —",
  maxPreview = 2,
  previewMode = "list",
  countLabel,
  error = false,
  searchable = false,
  renderOptionMeta,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  options: readonly (
    | string
    | {
        value: string;
        label: string;
        // Optional course list (used by KAC selector). Can be:
        // - full course objects coming from backend (course_code/course_title)
        // - list of course IDs/codes (e.g., ["CRS0023", ...])
        courses?: any[];
        course_list?: string[];
      }
  )[];
  className?: string;
  placeholder?: string;
  maxPreview?: number;
  previewMode?: "list" | "count" | "chips";
  countLabel?: string;
  error?: boolean;
  searchable?: boolean;
  // Optional meta renderer (e.g., show "courses under this KAC")
  renderOptionMeta?: (opt: { value: string; label: string } & Record<string, any>) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(0);
  const [query, setQuery] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const normalized = useMemo(() => {
    return options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  }, [options]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!searchable || !q) return normalized;
    const courseTokens = (o: any): string[] => {
      const out: string[] = [];

      const pushMany = (arr: any[]) =>
        arr.forEach((x) => {
          if (!x) return;
          if (typeof x === "string") {
            out.push(x);
            return;
          }
          if (typeof x === "object") {
            // tolerate different backend shapes
            const code = x.course_code ?? x.courseCode ?? x.code ?? x.course_id ?? x.courseId ?? x.id;
            const title = x.course_title ?? x.courseTitle ?? x.title;
            if (typeof code === "string") out.push(code);
            if (typeof title === "string") out.push(title);
          }
        });

      if (Array.isArray(o?.courses_display)) pushMany(o.courses_display);
      if (Array.isArray(o?.course_list)) pushMany(o.course_list);
      if (Array.isArray(o?.courses)) pushMany(o.courses);
      return out;
    };

    return normalized.filter((o: any) => {
      const hay = [o.label || "", o.value || "", ...courseTokens(o)].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [normalized, query, searchable]);

  useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !btnRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // focus search input when opened
    if (searchable) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, searchable]);

  useEffect(() => {
    // keep hover within bounds after filtering
    setHover((h) => {
      if (filtered.length === 0) return 0;
      return Math.min(Math.max(0, h), filtered.length - 1);
    });
  }, [filtered.length]);

  const toggle = (optValue: string) =>
    onChange(values.includes(optValue) ? values.filter((v) => v !== optValue) : [...values, optValue]);

  const displayLabel = useMemo(() => {
    if (values.length === 0) return <span className="text-gray-400">{placeholder}</span>;

    if (previewMode === "count") {
      const lbl = countLabel ?? "selected";
      return `${values.length} ${lbl}`;
    }

    if (previewMode === "chips") {
      return (
        <div className="flex flex-wrap items-center gap-2 pr-1">
          {values.map((v) => (
            <Chip key={v} label={v} onRemove={() => onChange(values.filter((x) => x !== v))} />
          ))}
        </div>
      );
    }

    if (maxPreview <= 0 || values.length <= maxPreview) return values.join(", ");
    return `${values.slice(0, maxPreview).join(", ")} +${values.length - maxPreview} more`;
  }, [values, maxPreview, placeholder, previewMode, countLabel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!open && ["ArrowDown", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;

    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHover((i) => (filtered.length ? (i + 1) % filtered.length : 0));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHover((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
      return;
    }

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const pick = filtered[hover];
      if (pick) toggle(pick.value);
      return;
    }
  };

  return (
    <div className={cls("relative", className)} onKeyDown={onKey}>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cls(DD_BASE, error ? "border-red-500 focus:ring-red-500/20" : "")}
      >
        {displayLabel}
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2">▾</span>
      </button>

      {open && (
        <div ref={listRef} role="listbox" className={DD_MENU}>
          {searchable && (
            <div className="sticky top-0 z-10 border-b border-gray-200 bg-white px-3 py-2">
              <div className="relative">
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by KAC or course code…"
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 pr-9 text-[14px] outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                />
                {query.trim() ? (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      inputRef.current?.focus();
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-gray-500 hover:bg-gray-100"
                    aria-label="Clear search"
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="px-4 py-3 text-sm text-gray-500">No results.</div>
          ) : (
            filtered.map((opt, i) => {
              const checked = values.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  role="option"
                  aria-selected={checked}
                  onMouseEnter={() => setHover(i)}
                  onClick={() => toggle(opt.value)}
                  className={cls(
                    "w-full px-4 py-3 text-left text-[15px]",
                    i === hover && "bg-emerald-50"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <input type="checkbox" readOnly checked={checked} className="accent-emerald-700" />
                    <span className="font-medium text-neutral-900">{opt.label}</span>
                  </div>
                  {renderOptionMeta ? <div className="mt-2">{renderOptionMeta(opt as any)}</div> : null}
                </button>
              );
            })
          )}

          {values.length > 0 && (
            <div className="flex items-center justify-between border-t border-gray-200 px-4 py-2">
              <button
                type="button"
                className="text-xs text-emerald-700 hover:underline"
                onClick={() => onChange([])}
              >
                Clear all
              </button>
              <span className="text-xs text-gray-500">{values.length} selected</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- single-select dropdown ---------- */
function Dropdown({
  value,
  onChange,
  options,
  className = "w-full",
  placeholder = "— Select —",
  error = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  className?: string;
  placeholder?: string;
  error?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(() => Math.max(0, options.findIndex((o) => o === value)));
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setHover(Math.max(0, options.findIndex((o) => o === value))), [value, options]);
  useEffect(() => {
    const close = (e: MouseEvent) =>
      open &&
      !btnRef.current?.contains(e.target as Node) &&
      !listRef.current?.contains(e.target as Node) &&
      setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    if (!open && ["ArrowDown", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHover((i) => (i + 1) % options.length);
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHover((i) => (i - 1 + options.length) % options.length);
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onChange(options[hover] ?? options[0]);
      setOpen(false);
      btnRef.current?.focus();
    }
  };
  return (
    <div className={cls("relative", className)} onKeyDown={onKey}>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cls(DD_BASE, error ? "border-red-500 focus:ring-red-500/20" : "")}
      >
        {value || <span className="text-gray-400">{placeholder}</span>}
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2">▾</span>
      </button>
      {open && (
        <div ref={listRef} role="listbox" className={DD_MENU}>
          {options.map((opt, i) => (
            <button
              key={opt}
              role="option"
              aria-selected={value === opt}
              onMouseEnter={() => setHover(i)}
              onClick={() => {
                onChange(opt);
                setOpen(false);
                btnRef.current?.focus();
              }}
              className={cls("block w-full px-4 py-3 text-left text-[15px]", i === hover && "bg-emerald-50")}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- constants ---------- */
const TEACHING_BREAK = "Prefers to take a teaching break next term";
const OPT = {
  delivery: [
    "Fully Online",
    "Hybrid - Manila Campus Only",
    "Hybrid - Laguna Campus Only",
    "Hybrid - Any Campus",
  ] as const,
} as const;

const DELOADING_TYPES = [
  "Administrative",
  "Grad Studies",
  "Research",
  "Commissioned Work",
  "Curriculum & Instruction",
] as const;

/* ---------- unit helpers ---------- */
const toLabel = (n: number) => {
  const s = Number(n).toFixed(1);
  const base = `${s} units`;
  if (s === "0.0") return "0.0 units - no teaching load (for full-time only)";
  if (s === "15.0") return "15.0 units - only for full-time";
  if (s === "18.0") return "18.0 units - only for full-time";
  return base;
};
const parseUnits = (label: string): number | null => {
  if (!label || label === TEACHING_BREAK) return null;
  const m = label.match(/(\d+(?:\.\d+)?)\s*units/);
  return m ? Number(m[1]) : null;
};

/* ---------- DB↔UI time-slot normalization ---------- */
function normalizeDbTimeToUi(s: string): string {
  if (s.includes(":")) return s;
  const m = s.match(/^(\d{3,4})-(\d{3,4})$/);
  if (!m) return s;
  const toHHMM = (t: string) => {
    const num = t.padStart(4, "0");
    const hh = num.slice(0, 2);
    const mm = num.slice(2);
    return `${hh}:${mm}`;
  };
  return `${toHHMM(m[1])} - ${toHHMM(m[2])}`;
}
function normalizeUiTimeToDb(s: string): string {
  const m = s.match(/^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/);
  if (!m) return s;
  return `${m[1]}${m[2]}-${m[3]}${m[4]}`;
}

/* ---------- day helpers (Thursday is 'H') ---------- */
const DAY_TO_LETTER: Record<string, "M" | "T" | "W" | "H" | "F" | "S"> = {
  Monday: "M",
  Tuesday: "T",
  Wednesday: "W",
  Thursday: "H",
  Friday: "F",
  Saturday: "S",
};
const LETTER_TO_DAY: Record<string, string> = {
  M: "Monday",
  T: "Tuesday",
  W: "Wednesday",
  H: "Thursday",
  F: "Friday",
  S: "Saturday",
};

// UPDATED FUNCTION: Stores days individually (e.g., ["M", "T"]) instead of grouped (e.g., ["MT"])
function compressDays(days: string[]): string[] {
  const order = ["M", "T", "W", "H", "F", "S"];
  
  // Map full name to letter, filter out invalid ones, and sort strictly by day order
  return days
    .map((d) => DAY_TO_LETTER[d])
    .filter(Boolean) // Ensure no undefined values
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

function expandDays(groups: string[]): string[] {
  const out: string[] = [];
  groups.forEach((g) => g.split("").forEach((ch) => out.push(LETTER_TO_DAY[ch])));
  const order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return Array.from(new Set(out)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/* ---------- countdown ---------- */
function useCountdown(targetISO: string) {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const target = new Date(targetISO || 0).getTime();
  const diff = Math.max(0, target - now);
  const past = targetISO ? now > target : false;
  const d = Math.floor(diff / (1000 * 60 * 60 * 24));
  const h = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const m = Math.floor((diff / (1000 * 60)) % 60);
  const s = Math.floor(diff / 1000) % 60;
  const label = past ? "Deadline passed" : `${d}d ${h}h ${m}m ${s}s`;
  return { past, label };
}

/* ---------- MODE/CAMPUS mapper ---------- */
type ModePayload = { mode?: "FOL" | "HYB" | "F2F"; campus_id?: string[] };
const CMPS_MANILA = "CMPS0001";
const CMPS_LAGUNA = "CMPS0002";
function toModePayload(v: { delivery?: string; campus?: string }): ModePayload {
  const delivery = (v.delivery || "").toLowerCase();
  const pack = (mode: "FOL" | "HYB", ids: string[]): ModePayload => ({ mode, campus_id: ids });
  if (delivery.includes("fully online")) return pack("FOL", [CMPS_MANILA, CMPS_LAGUNA]);
  if (delivery.includes("manila")) return pack("HYB", [CMPS_MANILA]);
  if (delivery.includes("laguna")) return pack("HYB", [CMPS_LAGUNA]);
  return pack("HYB", [CMPS_MANILA, CMPS_LAGUNA]);
}

/* ---------- small UI bits ---------- */
function SectionTitle({ icon: Icon, children }: { icon: any; children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-emerald-800">
      <Icon className="h-4 w-4" />
      {children}
    </div>
  );
}
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="text-[12px] text-neutral-500">{label}</div>
      <div className="mt-1 text-sm text-neutral-900">{value}</div>
    </div>
  );
}
function Pills({ items }: { items: string[] }) {
  return !items?.length ? (
    <span className="text-neutral-400">—</span>
  ) : (
    <div className="flex flex-wrap gap-1.5">
      {items.map((v) => (
        <Tag key={v} tone="gray">
          {v}
        </Tag>
      ))}
    </div>
  );
}
function DeadlineBanner({ openISO, deadlineISO, className }: { openISO: string; deadlineISO: string; className?: string }) {
  const { past: openPassed, label: openLabel } = useCountdown(openISO);
  const { past: deadlinePassed, label: deadlineLabel } = useCountdown(deadlineISO);

  if (!openPassed) {
    return (
      <div
        className={cls(
          "mb-4 flex items-start gap-3 rounded-xl border p-4 border-amber-300 bg-amber-50 text-amber-900",
          className
        )}
      >
        <div className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" />
        <div className="text-sm">
          <div className="font-semibold">Submissions Open In</div>
          <div className="mt-0.5">
            Opens: <span className="font-medium">{openISO ? new Date(openISO).toLocaleString() : "—"}</span>{" "}
            • <span className="font-bold text-amber-700">{openLabel}</span>
          </div>
          <div className="mt-1 text-[12px] opacity-80">Editing is locked until the window opens.</div>
        </div>
      </div>
    );
  }

  if (deadlinePassed) {
    return (
      <div
        className={cls(
          "mb-4 flex items-start gap-3 rounded-xl border p-4 border-red-300 bg-red-50 text-red-800",
          className
        )}
      >
        <div className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" />
        <div className="text-sm">
          <div className="font-semibold">Editing Locked</div>
          <div className="mt-0.5">
            Deadline:{" "}
            <span className="font-medium">{deadlineISO ? new Date(deadlineISO).toLocaleString() : "—"}</span>{" "}
            • <span className="font-bold text-red-700">Deadline passed</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cls(
        "mb-4 flex items-start gap-3 rounded-xl border p-4 border-amber-300 bg-amber-50 text-amber-900",
        className
      )}
    >
      <div className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" />
      <div className="text-sm">
        <div className="font-semibold">Submission Deadline Approaching</div>
        <div className="mt-0.5">
          Deadline:{" "}
          <span className="font-medium">{deadlineISO ? new Date(deadlineISO).toLocaleString() : "—"}</span>{" "}
          • <span className="font-bold text-amber-700">{deadlineLabel}</span>
        </div>
        <div className="mt-1 text-[12px] opacity-80">Please finalize your preferences before the deadline.</div>
      </div>
    </div>
  );
}

/* ---------- AE Line 1 Schedule (unchanged) ---------- */
function AELine1Schedule() {
  const ML = [
    { trip: "AE 101", etd: "6:00 AM" },
    { trip: "AE 102", etd: "7:30 AM" },
    { trip: "AE 103", etd: "9:30 AM" },
    { trip: "AE 104", etd: "11:00 AM" },
    { trip: "AE 105", etd: "1:00 PM" },
    { trip: "AE 106", etd: "2:30 PM" },
    { trip: "AE 107", etd: "3:30 PM" },
    { trip: "AE 108", etd: "5:10 PM" },
    { trip: "AE 109", etd: "6:15 PM" },
    { trip: "AE 110", etd: "7:45 PM" },
  ];
  const LM = [
    { trip: "AE 151", etd: "5:45 AM" },
    { trip: "AE 152", etd: "6:15 AM" },
    { trip: "AE 153", etd: "7:00 AM" },
    { trip: "AE 154", etd: "8:00 AM" },
    { trip: "AE 155", etd: "9:00 AM" },
    { trip: "AE 156", etd: "11:00 AM" },
    { trip: "AE 157", etd: "1:00 PM" },
    { trip: "AE 158", etd: "2:30 PM" },
    { trip: "AE 159", etd: "3:30 PM" },
    { trip: "AE 160", etd: "5:10 PM" },
    { trip: "AE 161", etd: "6:15 PM" },
    { trip: "AE 162", etd: "7:45 PM" },
  ];
  const rows = Math.max(ML.length, LM.length);
  const get = (arr: { trip: string; etd: string }[], i: number) => arr[i] ?? { trip: "", etd: "" };
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white text-[11px]">
      <div className="bg-emerald-700 px-3 py-2 text-center font-semibold text-white">
        <div className="text-xs font-bold leading-tight">DLSU – Laguna Campus</div>
        <div className="mt-1 inline-block rounded px-2 py-0.5 text-[10px] font-extrabold tracking-wide bg-amber-300 text-emerald-900">
          ARROWS EXPRESS
        </div>
        <div className="mt-1 text-[11px]">LINE 1 SCHEDULE</div>
        <div className="text-[11px]">Monday – Saturday</div>
      </div>
      <div className="grid grid-cols-2 border-b border-neutral-300 bg-neutral-50 text-center text-[11px] font-semibold text-neutral-800">
        <div className="border-r border-neutral-300 px-2 py-2">MANILA &gt; LAGUNA</div>
        <div className="px-2 py-2">LAGUNA &gt; MANILA</div>
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="bg-neutral-100 text-center text-[11px] text-neutral-800">
            <th className="border-r border-neutral-300 px-2 py-1.5 font-semibold">Trip Number</th>
            <th className="border-r border-neutral-300 px-2 py-1.5 font-semibold">ETD</th>
            <th className="border-r border-neutral-300 px-2 py-1.5 font-semibold">Trip Number</th>
            <th className="px-2 py-1.5 font-semibold">ETD</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => {
            const L = get(ML, i),
              R = get(LM, i);
            return (
              <tr key={i} className="odd:bg:white even:bg-neutral-50">
                <td className="border-t border-r border-neutral-300 px-2 py-1.5 align-top text-center">
                  {L.trip || "\u00A0"}
                </td>
                <td className="border-t border-r border-neutral-300 px-2 py-1.5 align-top text-center">
                  {L.etd || "\u00A0"}
                </td>
                <td className="border-t border-r border-neutral-300 px-2 py-1.5 align-top text-center">
                  {R.trip || "\u00A0"}
                </td>
                <td className="border-t border-neutral-300 px-2 py-1.5 align-top text-center">{R.etd || "\u00A0"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="grid grid-cols-2 border-t border-neutral-300 bg-neutral-50 text-[10px]">
        <div className="border-r border-neutral-300 px-2 py-2">
          <span className="font-semibold">Pick-Up Point :</span> Southgate (LS Bldg.)
        </div>
        <div className="px-2 py-2">
          <span className="font-semibold">Pick-Up Point :</span> East Canopy (MRR Bldg.)
        </div>
      </div>
    </div>
  );
}

/* ===========================
   TYPES & STATE
   =========================== */
type DeloadRow = { type: string; detail?: string; additionalNotes?: string; units: number | null };
type FutureTerm = { term_id: string; label: string; start_date?: string };

type TermMeta = { acad_year_start?: number | string; acad_year_end?: number | string; term_number?: number | string };
type PreferenceRecord = {
  term_id?: string;
  submitted_at?: string;
  term_label?: string;
  term_meta?: TermMeta;
  // plus all other backend fields (unknown)
  [k: string]: any;
};


type SavedPrefs = {
  prefUnits: string;
  deloadings: DeloadRow[];
  noDeloading: boolean;
  days: string[];
  timeSlots: string[];
  campus: string;
  delivery: string;
  kac: string[];
  remarks: string;
  onBreak: boolean;
  breakReason: string;
  // Legacy: kept for backward compatibility with older stored prefs/backends
  breakReturnTermId: string;
  // Expected date of return (YYYY-MM-DD)
  breakReturnDate: string;
};

const initialSaved: SavedPrefs = {
  prefUnits: "",
  deloadings: [],
  noDeloading: true,
  days: [],
  timeSlots: [],
  campus: "",
  delivery: "",
  kac: [],
  remarks: "",
  onBreak: false,
  breakReason: "",
  breakReturnTermId: "",
  breakReturnDate: "",
};

/* ===========================
   EDIT FORM
   =========================== */
function EditForm({
  initial,
  onClose,
  onSave,
  openISO,
  deadlineISO,
  employmentType,
  daysMaster,
  timeSlotsMaster,
  kacDisplayOptions,
  futureTerms: _futureTerms, // kept for API compatibility; leave return is now a date input
}: {
  initial: SavedPrefs;
  onClose: () => void;
  onSave: (v: SavedPrefs) => void;
  openISO: string;
  deadlineISO: string;
  employmentType: "FT" | "PT";
  daysMaster: string[];
  timeSlotsMaster: string[];
  kacDisplayOptions: Array<{ value: string; label: string; courses_display?: string[] }>;
  futureTerms: FutureTerm[]; 
}) {
  // local form & wizard step
  const [form, setForm] = useState<SavedPrefs>(initial);
  const [step, setStep] = useState<number>(form.prefUnits && form.prefUnits.trim() ? 2 : 1);

  // Field-level validation (only for Preferred Time Slots minimum selection rule)
  const [timeSlotsError, setTimeSlotsError] = useState<string>("");


  // Field-level validation for required inputs (show warnings instead of silently blocking save)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const clearFieldError = (key: string) =>
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const ZERO_LOAD_LABEL = "0.0 units - no teaching load (for full-time only)";
  const isZeroTeachingLoad = form.prefUnits === ZERO_LOAD_LABEL;

  const isTeachingBreak = form.prefUnits === TEACHING_BREAK;

  // Teaching break OR 0.0-unit (no teaching load) + No Deloading is considered a leave
  // (requires reason + expected return date)
  const isLeave = (isTeachingBreak || isZeroTeachingLoad) && form.noDeloading;

  const { past: deadlinePassed } = useCountdown(deadlineISO);

  // futureTerms kept for other parts of the page/backend, but leave return is now a date input

  // FT/PT: unit options
  const prefUnitOptions = useMemo(() => {
    const base: string[] = [
      "0.0 units - no teaching load (for full-time only)",
      "3.0 units",
      "6.0 units",
      "9.0 units",
      "12.0 units",
      "15.0 units - only for full-time",
      "18.0 units - only for full-time",
    ];
    const isPT = employmentType === "PT";
    const filtered = base.filter((label) => (isPT ? !/^0\.0\s|^15\.0|^18\.0/.test(label) : true));
    const rest = filtered.filter((l) => l !== TEACHING_BREAK);
    return [TEACHING_BREAK, ...rest];
  }, [employmentType]);

  // default FT to 12
  useEffect(() => {
    const isValid = form.prefUnits && prefUnitOptions.includes(form.prefUnits as any);
    if (employmentType === "FT" && (!isValid || form.prefUnits === "")) {
      setForm((f) => ({ ...f, prefUnits: "12.0 units" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employmentType, prefUnitOptions]);

  useEffect(() => {
    // Keep schema intact: onBreak should reflect a real break/leave.
    // - Teaching Break => always onBreak
    // - 0.0 units + No Deloading => assumed leave => onBreak
    const shouldMarkOnBreak = isTeachingBreak || (isZeroTeachingLoad && form.noDeloading);
    setForm((f) => ({
      ...f,
      onBreak: shouldMarkOnBreak,
      ...((isTeachingBreak || isZeroTeachingLoad)
        ? {}
        : { breakReason: "", breakReturnTermId: "", breakReturnDate: "" }),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.prefUnits, form.noDeloading]);

  // If user selected Teaching Break / 0.0-unit but is NOT considered a leave,
  // hide/clear leave fields.
  useEffect(() => {
    if (!(isTeachingBreak || isZeroTeachingLoad)) return;
    if (!isLeave) {
      setForm((f) => ({ ...f, breakReason: "", breakReturnTermId: "", breakReturnDate: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeachingBreak, isZeroTeachingLoad, isLeave]);

  // Clear Preferred Time Slots field error as soon as the user satisfies the rule
  useEffect(() => {
    const ZERO_LOAD_LABEL_LOCAL = "0.0 units - no teaching load (for full-time only)";
    const hasZeroLoad = form.prefUnits === ZERO_LOAD_LABEL_LOCAL;
    if (isTeachingBreak || hasZeroLoad) {
      if (timeSlotsError) setTimeSlotsError("");
      return;
    }
    if (timeSlotsError && (form.timeSlots?.length ?? 0) >= 3) {
      setTimeSlotsError("");
    }
  }, [form.prefUnits, form.timeSlots, isTeachingBreak, timeSlotsError]);

  // Leave return-date field error (Expected date of Return)
  const [breakReturnDateError, setBreakReturnDateError] = useState<string>("");
  useEffect(() => {
    // If not a leave, hide/clear any date error
    if (!isLeave && breakReturnDateError) setBreakReturnDateError("");
  }, [isLeave, breakReturnDateError]);

  function isBeforeToday(isoYYYYMMDD: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoYYYYMMDD)) return false;
    const d = new Date(`${isoYYYYMMDD}T00:00:00`);
    if (Number.isNaN(d.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return d.getTime() < today.getTime();
  }

  // deloading rows
  const [deloadRows, setDeloadRows] = useState<DeloadRow[]>(() =>
    form.noDeloading ? [] : form.deloadings || []
  );
  // prevent negative deloading units (warning shown if user attempts)
  const [deloadUnitsWarn, setDeloadUnitsWarn] = useState<Record<number, string>>({});
  useEffect(() => {
    if (form.noDeloading) setDeloadRows([]);
  }, [form.noDeloading]);

  // keep warning map indices in-bounds if rows are added/removed
  useEffect(() => {
    setDeloadUnitsWarn((prev) => {
      const next: Record<number, string> = {};
      for (const k of Object.keys(prev)) {
        const idx = Number(k);
        if (!Number.isNaN(idx) && idx >= 0 && idx < deloadRows.length) next[idx] = prev[idx];
      }
      return next;
    });
  }, [deloadRows.length]);

  // campus auto-mapping + lock
  function autoCampusFor(delivery: string): string {
    if (/fully online/i.test(delivery)) return "Either Campus";
    if (/manila/i.test(delivery)) return "Manila Campus";
    if (/laguna/i.test(delivery)) return "Laguna Campus";
    if (/any campus/i.test(delivery)) return "Either Campus";
    return "Either Campus";
  }

  // validation
  function validate(): { ok: true } | { ok: false; msg: string } {
    // Teaching break with deloading is still a "break" (no teaching-load fields required)
    if (isTeachingBreak && !isLeave) return { ok: true };

    if (isLeave) {
      if (!form.breakReason.trim()) return { ok: false, msg: "Reason for taking a break/leave is required." };
      if (!form.breakReturnDate) return { ok: false, msg: "Expected date of Return is required." };
      // basic date validity check (YYYY-MM-DD)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(form.breakReturnDate) || Number.isNaN(Date.parse(form.breakReturnDate))) {
        return { ok: false, msg: "Expected date of Return must be a valid date." };
      }
    if (isBeforeToday(form.breakReturnDate)) {
      return { ok: false, msg: "Expected date of Return cannot be before the current date." };
    }
      return { ok: true };
    }

    if (!form.prefUnits || !prefUnitOptions.includes(form.prefUnits as any)) {
      return { ok: false, msg: "Please select Preferred Teaching Units." };
    }

    // when there is a teaching load (not 0.0 units, not break),
    // these fields are required:
    const ZERO_LOAD_LABEL_LOCAL = "0.0 units - no teaching load (for full-time only)";
    const hasZeroLoad = form.prefUnits === ZERO_LOAD_LABEL_LOCAL;

    if (!hasZeroLoad) {
      if (!form.delivery.trim()) {
        return {
          ok: false,
          msg: "Preferred Delivery Mode is required when you have a teaching load.",
        };
      }
      if (!form.days || form.days.length === 0) {
        return {
          ok: false,
          msg: "Preferred Teaching Days are required when you have a teaching load.",
        };
      }
        // Preferred Time Slots: require at least 3 selections (field-specific rule)
        if (!form.timeSlots || form.timeSlots.length < 3) {
          return {
            ok: false,
            msg: "Please select at least 3 Preferred Time Slots.",
          };
        }
      if (!form.kac || form.kac.length === 0) {
        return {
          ok: false,
          msg: "Knowledge Area Cluster (KAC) is required when you have a teaching load.",
        };
      }
    }

    for (const r of deloadRows) {
      const needsSpecify = r.type === "Administrative" || r.type === "Research";
      if (!form.noDeloading && needsSpecify && !(r.detail || "").trim()) {
        return { ok: false, msg: `Please provide details for "${r.type}".` };
      }
      if (r.units != null && r.units < 0) {
        return { ok: false, msg: "Deloading units cannot be negative." };
      }
      if (r.type === "Research" && r.units != null && (r.units < 1 || r.units > 9)) {
        return { ok: false, msg: "Research deloading units must be between 1 and 9." };
      }
    }

    return { ok: true };
  }

  function validateAndSetWarnings(): boolean {
    const errs: Record<string, string> = {};
    const ZERO_LOAD_LABEL_LOCAL = "0.0 units - no teaching load (for full-time only)";
    const hasZeroLoad = form.prefUnits === ZERO_LOAD_LABEL_LOCAL;

    // Required: Preferred Teaching Units (always required)
    if (!form.prefUnits || !prefUnitOptions.includes(form.prefUnits as any)) {
      errs.prefUnits = "Preferred Teaching Units is required.";
    }

    // Leave requirements
    if (isLeave) {
      if (!form.breakReason.trim()) errs.breakReason = "Reason for taking a break/leave is required.";
      if (!form.breakReturnDate) {
        errs.breakReturnDate = "Expected date of Return is required.";
      } else {
        // validate date
        if (!/^\d{4}-\d{2}-\d{2}$/.test(form.breakReturnDate) || Number.isNaN(Date.parse(form.breakReturnDate))) {
          errs.breakReturnDate = "Expected date of Return must be a valid date.";
        } else if (isBeforeToday(form.breakReturnDate)) {
          errs.breakReturnDate = "Expected date of Return cannot be before the current date.";
        }
      }
    }

    // Teaching-load requirements (only when not break and not zero-load)
    if (!isTeachingBreak && !hasZeroLoad) {
      if (!form.delivery.trim()) errs.delivery = "Preferred Delivery Mode is required.";
      if (!form.days || form.days.length === 0) errs.days = "Preferred Teaching Days are required.";
      if (!form.timeSlots || form.timeSlots.length < 3) {
        errs.timeSlots = "Please select at least 3 Preferred Time Slots.";
      }
      if (!form.kac || form.kac.length === 0) errs.kac = "Knowledge Area Cluster (KAC) is required.";
    }

    setFieldErrors(errs);
    setTimeSlotsError(errs.timeSlots || "");
    setBreakReturnDateError(errs.breakReturnDate || "");

    if (Object.keys(errs).length > 0) return false;
    const v = validate();
    if (!v.ok) {
      // Non-required validation issues (e.g., deloading details/range)
      alert(v.msg);
      return false;
    }
    return true;
  }
  // Day-pairs (select by pair, but still saved individually in DB)
  const DAY_PAIRS = [
    { key: "MTh", label: "Monday and Thursday", days: ["Monday", "Thursday"] },
    { key: "TF", label: "Tuesday and Friday", days: ["Tuesday", "Friday"] },
    { key: "WS", label: "Wednesday and Saturday", days: ["Wednesday", "Saturday"] },
  ] as const;

  // Normalize any partially-saved day into full pairs (safety)
  useEffect(() => {
    setForm((f) => {
      const arr = Array.isArray(f.days) ? [...(f.days as string[])] : [];
      const ensurePair = (a: string, b: string) => {
        const hasA = arr.includes(a);
        const hasB = arr.includes(b);
        if (hasA && !hasB) arr.push(b);
        if (hasB && !hasA) arr.push(a);
      };
      ensurePair("Monday", "Thursday");
      ensurePair("Tuesday", "Friday");
      ensurePair("Wednesday", "Saturday");

      const uniq = Array.from(new Set(arr));
      const order = (d: string) => {
        const i = daysMaster.indexOf(d);
        return i < 0 ? 999 : i;
      };
      uniq.sort((a, b) => order(a) - order(b));

      const prev = Array.isArray(f.days) ? (f.days as string[]) : [];
      const same = prev.length === uniq.length && prev.every((d, i) => d === uniq[i]);

      return same ? f : { ...f, days: uniq };
    });
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleDayPair = (pairDays: readonly string[]) =>
    setForm((f) => {
      const current = (f.days as string[]) ?? [];
      const anySelected = pairDays.some((d) => current.includes(d));

      let next = current.filter((d) => !pairDays.includes(d));
      if (!anySelected) next = [...next, ...pairDays];

      const order = (d: string) => {
        const i = daysMaster.indexOf(d);
        return i < 0 ? 999 : i;
      };
      next = Array.from(new Set(next)).sort((a, b) => order(a) - order(b));

      if (next.length > 0) clearFieldError("days");
      return { ...f, days: next };
    });

  const toggleTimeSlot = (value: string) =>
    setForm((f) => {
      const arr = (f.timeSlots as string[]) ?? [];
      const has = arr.includes(value);
      const next = has ? arr.filter((v) => v !== value) : [...arr, value];

      if (next.length >= 3) {
        clearFieldError("timeSlots");
        if (timeSlotsError) setTimeSlotsError("");
      }
      return { ...f, timeSlots: next };
    });

  // Corrected showAE logic: Hide if on teaching break
  const showAE =
    !isTeachingBreak &&
    ["Laguna Campus", "Either Campus"].includes(form.campus) &&
    !/fully online/i.test(form.delivery || "");
    
  const prepNote =
    form.prefUnits && !isTeachingBreak
      ? (() => {
          const n = parseUnits(form.prefUnits) ?? 0;
          if (n >= 12) return "A 12.0-unit assignment guarantees at most three course preparations.";
          if (n >= 6 && n <= 9)
            return "A 6.0–9.0-unit assignment guarantees at most two course preparations.";
          return "";
        })()
      : "";

  return (
    <div className="w-full">
      <div className="mb-4">
        <h3 className="text-lg font-bold text-neutral-900">Edit Faculty Preferences</h3>
        <p className="text-sm text-neutral-500">
          Update your teaching preferences for the upcoming term
        </p>
      </div>

      <DeadlineBanner openISO={openISO} deadlineISO={deadlineISO} />

      <div
        className={cls(
          "grid grid-cols-1 gap-6",
          step === 2 && showAE && "lg:grid-cols-[1fr_minmax(200px,400px)]"
        )}
      >
        <div className="space-y-6 rounded-xl border border-neutral-200 bg-white p-5">
          {/* STEP 1 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel required>Preferred Teaching Units</FieldLabel>
              <Dropdown
                value={form.prefUnits}
                onChange={(v) => {
                  setForm({ ...form, prefUnits: v });
                  clearFieldError("prefUnits");
                  if (step === 1 && v && v.trim().length > 0) setStep(2);
                }}
                options={prefUnitOptions}
              />
        {fieldErrors.prefUnits && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[13px] text-red-800">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            <span>{fieldErrors.prefUnits}</span>
          </div>
        )}
              {/* Preferred units guidance */}
              {form.prefUnits !== TEACHING_BREAK && form.prefUnits !== ZERO_LOAD_LABEL && (
                <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />
                  <span className="whitespace-normal break-words">
                    If you have deloading, subtract it from <span className="font-semibold">Preferred Teaching Units</span> before submitting.
                  </span>
                </div>
              )}

              {!!prepNote && form.prefUnits !== TEACHING_BREAK && (
                <div className="mt-2 flex items-start gap-2 text-[12px] text-neutral-600">
                  <Info className="mt-0.5 h-3.5 w-3.5 text-amber-600" />
                  <span>{prepNote}</span>
                </div>
              )}

              {step === 1 && (
                <div className="mt-3 flex items-center justify-end">
                  <button
                    type="button"
                    onClick={onClose}
                    className={BTN_NEUTRAL}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* STEP 2 */}
          {step === 2 && (
            <>
              {/* Teaching Break subform */}
              {isTeachingBreak ? (
                <>
                  <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                    <div>
                      <FieldLabel>Deloading</FieldLabel>
                      <label className="flex items-center gap-2 text-[15px]">
                        <input
                          type="checkbox"
                          className="accent-emerald-700"
                          checked={form.noDeloading}
                          onChange={(e) => setForm((f) => ({ ...f, noDeloading: e.target.checked }))}
                        />
                        I have no deloading
                      </label>
                      {!form.noDeloading && (
                        <div className="mt-3 space-y-3">
                          {deloadRows.map((r, i) => {
                            const needsSpecify =
                              r.type === "Administrative" || r.type === "Research";
                            const researchOutOfRange =
                              r.type === "Research" &&
                              r.units != null &&
                              (r.units < 1 || r.units > 9);
                            const negativeUnitsWarn = !!deloadUnitsWarn[i];
                            return (
                              <div
                                key={i}
                                className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-3"
                              >
                                <div className="flex flex-col gap-2 sm:flex-row">
                                  <div className="sm:w-1/2">
                                    <Dropdown
                                      value={r.type}
                                      onChange={(v) =>
                                        setDeloadRows((rows) =>
                                          rows.map((x, idx) =>
                                            idx === i ? { ...x, type: v } : x
                                          )
                                        )
                                      }
                                      options={DELOADING_TYPES}
                                      placeholder="— Select Deloading Type —"
                                    />
                                  </div>
                                  <input
                                    type="number"
                                    className={cls(
                                      "w-full sm:w-40 rounded-2xl border px-4 py-3 text-[15px] shadow-sm outline-none",
                                      researchOutOfRange
                                        ? "border-red-300"
                                        : negativeUnitsWarn
                                          ? "border-red-300"
                                          : "border-neutral-300"
                                    )}
                                    placeholder="Units"
                                    value={r.units ?? ""}
                                    onChange={(e) => {
                                      const raw = e.target.value;
                                      let v = raw === "" ? null : Number(raw);
                                      if (v != null && v < 0) {
                                        setDeloadUnitsWarn((m) => ({ ...m, [i]: "Units cannot be negative." }));
                                        v = 0;
                                      } else {
                                        setDeloadUnitsWarn((m) => {
                                          if (!m[i]) return m;
                                          const { [i]: _, ...rest } = m;
                                          return rest;
                                        });
                                      }
                                      setDeloadRows((rows) =>
                                        rows.map((x, idx) =>
                                          idx === i ? { ...x, units: v } : x
                                        )
                                      );
                                    }}
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setDeloadRows((rows) =>
                                        rows.filter((_, idx) => idx !== i)
                                      )
                                    }
                                    className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-2 text-[14px] hover:bg-neutral-100"
                                  >
                                    Remove
                                  </button>
                                </div>

                                {needsSpecify && (
                                  <>
                                    <div className="mt-1 text-[13px] font-semibold text-emerald-700">
                                      {r.type} Deloading Details{" "}
                                      <span className="text-red-600">*</span>
                                    </div>
                                    <input
                                      type="text"
                                      className="w-full rounded-2xl border border-neutral-300 px-4 py-3 text-[15px] shadow-sm outline-none"
                                      placeholder={
                                        r.type === "Administrative"
                                          ? "Specify Office/Unit (e.g., Office of the Dean…)"
                                          : "Specify Project/Study (e.g., Funded Research…)"
                                      }
                                      value={r.detail || ""}
                                      onChange={(e) =>
                                        setDeloadRows((rows) =>
                                          rows.map((x, idx) =>
                                            idx === i
                                              ? { ...x, detail: e.target.value }
                                              : x
                                          )
                                        )
                                      }
                                    />
                                    {r.type === "Administrative" && (
                                      <div className="mt-3">
                                        <div className="text-[13px] font-semibold text-emerald-700">
                                          Additional Details{" "}
                                          <span className="text-neutral-500 font-normal">(optional)</span>
                                        </div>
                                        <input
                                          type="text"
                                          className="mt-1 w-full rounded-2xl border border-neutral-300 px-4 py-3 text-[15px] shadow-sm outline-none"
                                          placeholder="Add any extra context"
                                          value={r.additionalNotes || ""}
                                          onChange={(e) =>
                                            setDeloadRows((rows) =>
                                              rows.map((x, idx) =>
                                                idx === i
                                                  ? { ...x, additionalNotes: e.target.value }
                                                  : x
                                              )
                                            )
                                          }
                                        />
                                      </div>
                                    )}
                                  </>
                                )}

                                {r.type === "Research" && (
                                  <div className="mt-1 flex items-start gap-2 text-[12px] text-neutral-600">
                                    <Info className="mt-0.5 h-3 w-3 text-emerald-600" />
                                    <span>
                                      Research deloading units entered here are for{" "}
                                      <span className="font-semibold">
                                        the next term only
                                      </span>
                                      . The{" "}
                                      <span className="font-semibold">
                                        9-unit cap
                                      </span>{" "}
                                      applies to the whole academic year (3 terms).
                                    </span>
                                  </div>
                                )}

                                {researchOutOfRange && (
                                  <div className="mt-1 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[13px] text-amber-800">
                                    <AlertTriangle className="mt-0.5 h-4 w-4" />
                                    Research deloading units per term should be between 1 and
                                    9. Note: the 9-unit cap is for the entire academic year (3
                                    terms).
                                  </div>
                                )}

                                {negativeUnitsWarn && (
                                  <div className="mt-1 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[13px] text-red-800">
                                    <AlertTriangle className="mt-0.5 h-4 w-4" />
                                    {deloadUnitsWarn[i]}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          <button
                            type="button"
                            onClick={() =>
                              setDeloadRows((rows) => [
                                ...rows,
                                { type: "Administrative", units: null, detail: "", additionalNotes: "" },
                              ])
                            }
                            className={BTN_PRIMARY}
                          >
                            Add Deloading
                          </button>
                        </div>
                      )}
                    </div>

                    {isLeave && (
                      <div className="space-y-4">
                        <div>
                          <FieldLabel required>Reason for taking a break/leave</FieldLabel>
                          <input
                            type="text"
                            className={cls(
              "w-full rounded-2xl border px-4 py-3 text-[15px] shadow-sm outline-none",
              fieldErrors.breakReason ? "border-red-500 focus:ring-2 focus:ring-red-500/20" : "border-neutral-300"
            )}
                            placeholder="Reason..."
                            value={form.breakReason}
                            onChange={(e) => {
                setForm({ ...form, breakReason: e.target.value });
                if (e.target.value.trim()) clearFieldError("breakReason");
              }}
                          />
            {fieldErrors.breakReason && (
              <div className="mt-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[13px] text-red-800">
                <AlertTriangle className="mt-0.5 h-4 w-4" />
                <span>{fieldErrors.breakReason}</span>
              </div>
            )}
                        </div>

                        <div>
                          <FieldLabel required>Expected date of Return</FieldLabel>
                          <div className="relative">
                            <input
                              type="date"
                              value={form.breakReturnDate}
                      onChange={(e) => {
                        const v = e.target.value;
                        setForm({ ...form, breakReturnDate: v });
                if (v) clearFieldError("breakReturnDate");
                        if (!v) {
                          setBreakReturnDateError("");
                          return;
                        }
                  if (isBeforeToday(v)) {
                    setBreakReturnDateError("Expected date of Return cannot be before the current date.");
                        } else {
                          setBreakReturnDateError("");
                        }
                      }}
                      className={cls(
                        DD_BASE,
                        "pr-12",
                        breakReturnDateError ? "border-red-500 focus:ring-red-500/20" : ""
                      )}
                            />
                            <CalendarDays className="pointer-events-none absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 text-neutral-500" />
                          </div>
                          {breakReturnDateError && (
                            <div className="mt-1 text-[12px] text-red-600">{breakReturnDateError}</div>
                          )}
                          <div className="mt-1 text-[12px] text-neutral-500">
                            Select the date you expect to return to teaching.
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* actions */}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      onClick={onClose}
                      className={BTN_NEUTRAL}
                    >
                      Cancel
                    </button>
                    <button
                      disabled={deadlinePassed}
                        onClick={() => {
              if (!validateAndSetWarnings()) return;
              setTimeSlotsError("");
              setBreakReturnDateError("");
              onSave({
                ...form,
                deloadings: form.noDeloading ? [] : deloadRows,
              });
                        }}
                      className={cls(
                        BTN_BASE,
                        deadlinePassed
                          ? "cursor-not-allowed bg-emerald-300 text-white"
                          : "bg-emerald-700 text-white hover:brightness-110"
                      )}
                      title={
                        deadlinePassed
                          ? "Deadline passed — editing locked"
                          : "Save and finalize"
                      }
                    >
                      Save Preferences
                    </button>
                  </div>
                </>
              ) : isZeroTeachingLoad ? (
                <>
                  {/* 0.0 units - only ask for Deloading */}
                  <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                    {/* LEFT: Deloading */}
                    <div className="space-y-3">
                    <div>
                      <FieldLabel>Deloading</FieldLabel>
                      <p className="mb-2 text-[12px] text-neutral-600">
                        You selected{" "}
                        <span className="font-semibold">
                          0.0 units – no teaching load
                        </span>
                        . Please indicate any deloading for the next term (e.g.,
                        Administrative, Research).
                      </p>
                      <label className="flex items-center gap-2 text-[15px]">
                        <input
                          type="checkbox"
                          className="accent-emerald-700"
                          checked={form.noDeloading}
                          onChange={(e) => {
                            setForm((f) => ({ ...f, noDeloading: e.target.checked }));
                            if (e.target.checked) setDeloadRows([]);
                          }}
                        />
                        I have no deloading
                      </label>
                    </div>

                    {!form.noDeloading && (
                      <div className="space-y-3">
                        {deloadRows.length === 0 && (
                          <div className="text-[15px] text-neutral-500">
                            No deloading entries yet.
                          </div>
                        )}

                        {deloadRows.map((r, i) => {
                          const needsSpecify =
                            r.type === "Administrative" || r.type === "Research";
                          const researchOutOfRange =
                            r.type === "Research" &&
                            r.units != null &&
                            (r.units < 1 || r.units > 9);
                          const negativeUnitsWarn = !!deloadUnitsWarn[i];

                          return (
                            <div
                              key={i}
                              className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_160px_auto] rounded-xl border border-neutral-200 p-3"
                            >
                              <div>
                                <Dropdown
                                  value={r.type}
                                  onChange={(v) =>
                                    setDeloadRows((rows) =>
                                      rows.map((x, idx) =>
                                        idx === i ? { ...x, type: v } : x
                                      )
                                    )
                                  }
                                  options={DELOADING_TYPES}
                                  placeholder="— Select Deloading Type —"
                                />
                              </div>
                              <input
                                type="number"
                                className={cls(
                                  "rounded-2xl border px-4 py-3 text-[15px] shadow-sm outline-none",
                                  researchOutOfRange
                                    ? "border-red-300"
                                    : negativeUnitsWarn
                                      ? "border-red-300"
                                      : "border-neutral-300"
                                )}
                                placeholder="Units"
                                value={r.units ?? ""}
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  let v = raw === "" ? null : Number(raw);
                                  if (v != null && v < 0) {
                                    setDeloadUnitsWarn((m) => ({ ...m, [i]: "Units cannot be negative." }));
                                    v = 0;
                                  } else {
                                    setDeloadUnitsWarn((m) => {
                                      if (!m[i]) return m;
                                      const { [i]: _, ...rest } = m;
                                      return rest;
                                    });
                                  }
                                  setDeloadRows((rows) =>
                                    rows.map((x, idx) =>
                                      idx === i ? { ...x, units: v } : x
                                    )
                                  );
                                }}
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  setDeloadRows((rows) =>
                                    rows.filter((_, idx) => idx !== i)
                                  )
                                }
                                className={BTN_REMOVE}
                              >
                                Remove
                              </button>

                              {needsSpecify && (
                                <div className="sm:col-span-3">
                                  <div className="mb-1 text-[13px] font-semibold text-emerald-700">
                                    {r.type} Deloading Details{" "}
                                    <span className="text-red-600">*</span>
                                  </div>
                                  <input
                                    type="text"
                                    className="w-full rounded-2xl border border-neutral-300 px-4 py-3 text-[15px] shadow-sm outline-none"
                                    placeholder={
                                      r.type === "Administrative"
                                        ? "Specify Office/Unit (e.g., Office of the Dean…)"
                                        : "Specify Project/Study (e.g., Funded Research…)"
                                    }
                                    value={r.detail || ""}
                                    onChange={(e) =>
                                      setDeloadRows((rows) =>
                                        rows.map((x, idx) =>
                                          idx === i
                                            ? { ...x, detail: e.target.value }
                                            : x
                                        )
                                      )
                                    }
                                  />
                                  {r.type === "Administrative" && (
                                    <div className="mt-3">
                                      <div className="text-[13px] font-semibold text-emerald-700">
                                        Additional Details{" "}
                                        <span className="text-neutral-500 font-normal">(optional)</span>
                                      </div>
                                      <input
                                        type="text"
                                        className="mt-1 w-full rounded-2xl border border-neutral-300 px-4 py-3 text-[15px] shadow-sm outline-none"
                                        placeholder="Add any extra context (optional)"
                                        value={r.additionalNotes || ""}
                                        onChange={(e) =>
                                          setDeloadRows((rows) =>
                                            rows.map((x, idx) =>
                                              idx === i
                                                ? {
                                                    ...x,
                                                    additionalNotes: e.target.value,
                                                  }
                                                : x
                                            )
                                          )
                                        }
                                      />
                                    </div>
                                  )}
                                </div>
                              )}

                              {r.type === "Research" && (
                                <div className="sm:col-span-3 mt-1 flex items-start gap-2 text-[12px] text-neutral-600">
                                  <Info className="mt-0.5 h-3 w-3 text-emerald-600" />
                                  <span>
                                    Research deloading units entered here are for{" "}
                                    <span className="font-semibold">
                                      the next term only
                                    </span>
                                    . The{" "}
                                    <span className="font-semibold">
                                      9-unit cap
                                    </span>{" "}
                                    applies to the whole academic year (3 terms).
                                  </span>
                                </div>
                              )}

                              {researchOutOfRange && (
                                <div className="sm:col-span-3 mt-1 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[13px] text-amber-800">
                                  <AlertTriangle className="mt-0.5 h-4 w-4" />
                                  Research deloading units per term should be
                                  between 1 and 9. Note: the 9-unit cap is for the
                                  entire academic year (3 terms).
                                </div>
                              )}

                              {negativeUnitsWarn && (
                                <div className="sm:col-span-3 mt-1 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[13px] text-red-800">
                                  <AlertTriangle className="mt-0.5 h-4 w-4" />
                                  {deloadUnitsWarn[i]}
                                </div>
                              )}
                            </div>
                          );
                        })}

                        <button
                          type="button"
                          onClick={() =>
                            setDeloadRows((rows) => [
                              ...rows,
                              { type: "Administrative", units: null, detail: "", additionalNotes: "" },
                            ])
                          }
                          className={BTN_PRIMARY}
                        >
                          Add Deloading
                        </button>
                      </div>
                    )}

                    </div>

                    {/* RIGHT: Leave (assumed) — shown on the right side just like Teaching Break */}
                    <div>
                      {/* If 0.0 units + No Deloading, assume leave and require reason + expected return date */}
                      {isLeave && (
                        <div className="space-y-4">
                          <div>
                            <FieldLabel required>Reason for taking a break/leave</FieldLabel>
                            <input
                              type="text"
                              className={cls(
                                "w-full rounded-2xl border px-4 py-3 text-[15px] shadow-sm outline-none",
                                fieldErrors.breakReason
                                  ? "border-red-500 focus:ring-2 focus:ring-red-500/20"
                                  : "border-neutral-300"
                              )}
                              placeholder="Reason..."
                              value={form.breakReason}
                              onChange={(e) => {
                                setForm({ ...form, breakReason: e.target.value });
                                if (e.target.value.trim()) clearFieldError("breakReason");
                              }}
                            />
                            {fieldErrors.breakReason && (
                              <div className="mt-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[13px] text-red-800">
                                <AlertTriangle className="mt-0.5 h-4 w-4" />
                                <span>{fieldErrors.breakReason}</span>
                              </div>
                            )}
                          </div>

                          <div>
                            <FieldLabel required>Expected date of Return</FieldLabel>
                            <div className="relative">
                              <input
                                type="date"
                                value={form.breakReturnDate}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setForm({ ...form, breakReturnDate: v });
                                  if (v) clearFieldError("breakReturnDate");
                                  if (!v) {
                                    setBreakReturnDateError("");
                                    return;
                                  }
                                  if (isBeforeToday(v)) {
                                    setBreakReturnDateError(
                                      "Expected date of Return cannot be before the current date."
                                    );
                                  } else {
                                    setBreakReturnDateError("");
                                  }
                                }}
                                className={cls(
                                  DD_BASE,
                                  "pr-12",
                                  breakReturnDateError
                                    ? "border-red-500 focus:ring-red-500/20"
                                    : ""
                                )}
                              />
                              <CalendarDays className="pointer-events-none absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 text-neutral-500" />
                            </div>
                            {breakReturnDateError && (
                              <div className="mt-1 text-[12px] text-red-600">{breakReturnDateError}</div>
                            )}
                            <div className="mt-1 text-[12px] text-neutral-500">
                              Select the date you expect to return to teaching.
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* actions for 0.0 units */}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      onClick={onClose}
                      className={BTN_NEUTRAL}
                    >
                      Cancel
                    </button>
                    <button
                      disabled={deadlinePassed}
                          onClick={() => {
              if (!validateAndSetWarnings()) return;
              setTimeSlotsError("");
              onSave({
                ...form,
                deloadings: form.noDeloading ? [] : deloadRows,
              });
                          }}
                      className={cls(
                        BTN_BASE,
                        deadlinePassed
                          ? "cursor-not-allowed bg-emerald-300 text-white"
                          : "bg-emerald-700 text-white hover:brightness-110"
                      )}
                      title={
                        deadlinePassed
                          ? "Deadline passed — editing locked"
                          : "Save and finalize"
                      }
                    >
                      Save Preferences
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* Delivery/Campus */}
                  <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                    <div>
                      <FieldLabel required>Preferred Delivery Mode</FieldLabel>
                      <Dropdown
                        value={form.delivery}
                        onChange={(v) => {
                          const nextCampus = autoCampusFor(v);
                          setForm({ ...form, delivery: v, campus: nextCampus });
              clearFieldError("delivery");
                        }}
                        options={OPT.delivery}
                        placeholder="— Select Delivery Mode —"
            error={!!fieldErrors.delivery}
                      />
            {fieldErrors.delivery && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[13px] text-red-800">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <span>{fieldErrors.delivery}</span>
            </div>
            )}
                    </div>
                    {form.delivery && (
                      <div>
                        <FieldLabel>Campus Preference</FieldLabel>
                        <input
                          type="text"
                          disabled
                          className="w-full rounded-2xl border border-neutral-200 bg-neutral-100 px-4 py-3 text-[15px] text-neutral-700"
                          value={form.campus || "Either Campus"}
                          readOnly
                        />
                      </div>
                    )}
                  </div>

                  {/* Days / Time Slots */}
<div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
  {/* LEFT: Preferred Teaching Days */}
  <div>
    <FieldLabel required>Preferred Teaching Days</FieldLabel>

    
    <div className="space-y-2">
      {DAY_PAIRS.map((p) => (
        <label key={p.key} className="flex items-center gap-2 text-[15px]">
          <input
            type="checkbox"
            className="accent-emerald-700"
            checked={p.days.some((d) => form.days.includes(d))}
            onChange={() => toggleDayPair(p.days)}
          />
          {p.label}
        </label>
      ))}
    </div>

  {fieldErrors.days && (
    <div className="mt-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[13px] text-red-800">
      <AlertTriangle className="mt-0.5 h-4 w-4" />
      <span>{fieldErrors.days}</span>
    </div>
  )}
  </div>

  {/* RIGHT: Preferred Time Slots */}
  <div>
    <FieldLabel required>Preferred Time Slots</FieldLabel>

    <p className="mb-2 text-[12px] text-neutral-600">
      Select at least <span className="font-semibold">3</span> time slots.
      <span className="ml-1 font-medium">({(form.timeSlots?.length ?? 0)} selected)</span>
    </p>
    <div className="grid grid-cols-1 gap-1.5">
      {timeSlotsMaster.map((t) => (
        <label key={t} className="flex items-center gap-2 text-[15px]">
          <input
            type="checkbox"
            className="accent-emerald-700"
            checked={form.timeSlots.includes(t)}
            onChange={() => toggleTimeSlot(t)}
          />
          {t}
        </label>
      ))}
    </div>
      {!!timeSlotsError && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[13px] text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <span>{timeSlotsError}</span>
        </div>
      )}
  </div>
</div>


                  {/* KAC */}
                  <div>
                    {/* KAC format notice + links */}
                    <div className="mb-3 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4">
                      <div className="flex items-start gap-2">
                        <Info className="mt-0.5 h-4 w-4 text-emerald-700" />
                        <div className="space-y-2">
                          <p className="text-[14px] text-emerald-900">
                            We will now be observing the Knowledge Area Clusters (KAC) format moving forward. Thus, we
                            can assign you to any of the courses that belong to a certain KAC. For the latest mapping,
                            please check the following:
                          </p>
                          <ul className="list-disc space-y-1 pl-5 text-[14px]">
                            <li>
                              <a
                                href="https://docs.google.com/spreadsheets/d/1Wok-oGiVfWbihnz56hcI8WtrA9hil-7nHM6H0SYo7U4/edit?usp=sharing"
                                target="_blank"
                                rel="noreferrer"
                                className="font-medium text-emerald-800 underline decoration-emerald-400 underline-offset-2 hover:decoration-emerald-700"
                              >
                                Computer Science and Data Science KACs
                              </a>
                            </li>
                            <li>
                              <a
                                href="https://docs.google.com/spreadsheets/d/19vzZOglLGz6Gn68uRYv8kTPC2cbzQrclrJExrTcSxUM/edit?usp=sharing"
                                target="_blank"
                                rel="noreferrer"
                                className="font-medium text-emerald-800 underline decoration-emerald-400 underline-offset-2 hover:decoration-emerald-700"
                              >
                                Interactive Entertainment KACs
                              </a>
                            </li>
                          </ul>
                        </div>
                      </div>
                    </div>

                    <FieldLabel required>Knowledge Area Cluster (KAC)</FieldLabel>
                    <MultiSelectDropdown
                      values={form.kac as string[]}
                      onChange={(v) => {
                        setForm({ ...form, kac: v });
                        if (v && v.length > 0) clearFieldError("kac");
                      }}
                      options={kacDisplayOptions}
                      placeholder="— Select KAC —"
                      previewMode="chips"
                      searchable
                      renderOptionMeta={(opt: any) => {
                        const courses: string[] = Array.isArray(opt?.courses_display) ? opt.courses_display : [];
                        if (!courses.length) return <div className="text-xs text-neutral-500">No course list.</div>;
                        const shown = courses.slice(0, 6);
                        const more = Math.max(0, courses.length - shown.length);
                        return (
                          <div>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {shown.map((c) => (
                                <span
                                  key={c}
                                  className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-800"
                                  title={c}
                                >
                                  {c}
                                </span>
                              ))}
                              {more > 0 ? (
                                <span className="text-[11px] text-slate-500">+{more} more</span>
                              ) : null}
                            </div>
                          </div>
                        );
                      }}
                      error={!!fieldErrors.kac}
                    />
          {fieldErrors.kac && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[13px] text-red-800">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <span>{fieldErrors.kac}</span>
            </div>
          )}


                  </div>

                  {/* Deloading */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <FieldLabel>Deloading</FieldLabel>
                      <label className="flex items-center gap-2 text-[15px]">
                        <input
                          type="checkbox"
                          className="accent-emerald-700"
                          checked={form.noDeloading}
                          onChange={(e) => {
                            setForm((f) => ({ ...f, noDeloading: e.target.checked }));
                            if (e.target.checked) setDeloadRows([]);
                          }}
                        />
                        I have no deloading
                      </label>
                    </div>

                    {!form.noDeloading && (
                      <div className="space-y-3">
                        {deloadRows.length === 0 && (
                          <div className="text-[15px] text-neutral-500">
                            No deloading entries yet.
                          </div>
                        )}
                        {deloadRows.map((r, i) => {
                          const needsSpecify =
                            r.type === "Administrative" || r.type === "Research";
                          const researchOutOfRange =
                            r.type === "Research" &&
                            r.units != null &&
                            (r.units < 1 || r.units > 9);
                          const negativeUnitsWarn = !!deloadUnitsWarn[i];
                          return (
                            <div
                              key={i}
                              className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_160px_auto] rounded-xl border border-neutral-200 p-3"
                            >
                              <div>
                                <Dropdown
                                  value={r.type}
                                  onChange={(v) =>
                                    setDeloadRows((rows) =>
                                      rows.map((x, idx) =>
                                        idx === i ? { ...x, type: v } : x
                                      )
                                    )
                                  }
                                  options={DELOADING_TYPES}
                                  placeholder="— Select Deloading Type —"
                                />
                              </div>
                              <input
                                type="number"
                                className={cls(
                                  "rounded-2xl border px-4 py-3 text-[15px] shadow-sm outline-none",
                                  researchOutOfRange
                                    ? "border-red-300"
                                    : negativeUnitsWarn
                                      ? "border-red-300"
                                      : "border-neutral-300"
                                )}
                                placeholder="Units"
                                value={r.units ?? ""}
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  let v = raw === "" ? null : Number(raw);
                                  if (v != null && v < 0) {
                                    setDeloadUnitsWarn((m) => ({ ...m, [i]: "Units cannot be negative." }));
                                    v = 0;
                                  } else {
                                    setDeloadUnitsWarn((m) => {
                                      if (!m[i]) return m;
                                      const { [i]: _, ...rest } = m;
                                      return rest;
                                    });
                                  }
                                  setDeloadRows((rows) =>
                                    rows.map((x, idx) =>
                                      idx === i ? { ...x, units: v } : x
                                    )
                                  );
                                }}
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  setDeloadRows((rows) =>
                                    rows.filter((_, idx) => idx !== i)
                                  )
                                }
                                className={BTN_REMOVE}
                              >
                                Remove
                              </button>

                              {needsSpecify && (
                                <div className="sm:col-span-3">
                                  <div className="mb-1 text-[13px] font-semibold text-emerald-700">
                                    {r.type} Deloading Details{" "}
                                    <span className="text-red-600">*</span>
                                  </div>
                                  <input
                                    type="text"
                                    className="w-full rounded-2xl border border-neutral-300 px-4 py-3 text-[15px] shadow-sm outline-none"
                                    placeholder={
                                      r.type === "Administrative"
                                        ? "Specify Office/Unit (e.g., Office of the Dean…)"
                                        : "Specify Project/Study (e.g., Funded Research…)"
                                    }
                                    value={r.detail || ""}
                                    onChange={(e) =>
                                      setDeloadRows((rows) =>
                                        rows.map((x, idx) =>
                                          idx === i
                                            ? { ...x, detail: e.target.value }
                                            : x
                                        )
                                      )
                                    }
                                  />
                                  {r.type === "Administrative" && (
                                    <div className="mt-3">
                                      <div className="text-[13px] font-semibold text-emerald-700">
                                        Additional Details{" "}
                                        <span className="text-neutral-500 font-normal">(optional)</span>
                                      </div>
                                      <input
                                        type="text"
                                        className="mt-1 w-full rounded-2xl border border-neutral-300 px-4 py-3 text-[15px] shadow-sm outline-none"
                                        placeholder="Add any extra context (optional)"
                                        value={r.additionalNotes || ""}
                                        onChange={(e) =>
                                          setDeloadRows((rows) =>
                                            rows.map((x, idx) =>
                                              idx === i
                                                ? {
                                                    ...x,
                                                    additionalNotes: e.target.value,
                                                  }
                                                : x
                                            )
                                          )
                                        }
                                      />
                                    </div>
                                  )}
                                </div>
                              )}

                              {r.type === "Research" && (
                                <div className="sm:col-span-3 mt-1 flex items-start gap-2 text-[12px] text-neutral-600">
                                  <Info className="mt-0.5 h-3 w-3 text-emerald-600" />
                                  <span>
                                    Research deloading units entered here are for{" "}
                                    <span className="font-semibold">
                                      the next term only
                                    </span>
                                    . The{" "}
                                    <span className="font-semibold">
                                      9-unit cap
                                    </span>{" "}
                                    applies to the whole academic year (3 terms).
                                  </span>
                                </div>
                              )}

                              {researchOutOfRange && (
                                <div className="sm:col-span-3 mt-1 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[13px] text-amber-800">
                                  <AlertTriangle className="mt-0.5 h-4 w-4" />
                                  Research deloading units per term should be
                                  between 1 and 9. Note: the 9-unit cap is for the
                                  entire academic year (3 terms).
                                </div>
                              )}

                              {negativeUnitsWarn && (
                                <div className="sm:col-span-3 mt-1 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-[13px] text-red-800">
                                  <AlertTriangle className="mt-0.5 h-4 w-4" />
                                  {deloadUnitsWarn[i]}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() =>
                            setDeloadRows((rows) => [
                              ...rows,
                              { type: "Administrative", units: null, detail: "", additionalNotes: "" },
                            ])
                          }
                          className={BTN_PRIMARY}
                        >
                          Add Deloading
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Remarks */}
                  <div>
                    <FieldLabel>Special Remarks</FieldLabel>
                    <textarea
                      rows={4}
                      className="w-full resize-y rounded-2xl border border-neutral-300 p-3 text-[15px]"
                      placeholder="Any special circumstances, research project name, or any additional information…"
                      value={form.remarks}
                      onChange={(e) => setForm({ ...form, remarks: e.target.value })}
                    />
                  </div>

                  {/* actions */}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      onClick={onClose}
                      className={BTN_NEUTRAL}
                    >
                      Cancel
                    </button>
                    <button
                      disabled={deadlinePassed}
                        onClick={() => {
              if (!validateAndSetWarnings()) return;
              setTimeSlotsError("");
              onSave({
                ...form,
                deloadings: form.noDeloading ? [] : deloadRows,
              });
                        }}
                      className={cls(
                        BTN_BASE,
                        deadlinePassed
                          ? "cursor-not-allowed bg-emerald-300 text-white"
                          : "bg-emerald-700 text-white hover:brightness-110"
                      )}
                      title={
                        deadlinePassed
                          ? "Deadline passed — editing locked"
                          : "Save and finalize"
                      }
                    >
                      Save Preferences
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Right column: AE schedule (only when Laguna/Either and NOT on break) */}
        {step === 2 && showAE && (
          <div className="block">
            <AELine1Schedule />
          </div>
        )}
      </div>
    </div>
  );
}

/* ===========================
   MAIN COMPONENT
   =========================== */
export default function FACULTY_Preferences() {
  const [saved, setSaved] = useState<SavedPrefs>(initialSaved);
  const [openEdit, setOpenEdit] = useState(false); /* set to true to open */
  const [reuseBusy, setReuseBusy] = useState(false);
  const [reuseNotice, setReuseNotice] = useState<string>("");
  const [infoOpen, setInfoOpen] = useState(false);

  const [preferences, setPreferences] = useState<PreferenceRecord[]>([]);
  const [activeTermId, setActiveTermId] = useState<string>("");
  const [selectedHistoryTermId, setSelectedHistoryTermId] = useState<string>("");
  const [reuseMenuOpen, setReuseMenuOpen] = useState(false);
  const [reuseMenuHover, setReuseMenuHover] = useState(0);
  const reuseMenuBtnRef = useRef<HTMLButtonElement>(null);
  const reuseMenuListRef = useRef<HTMLDivElement>(null);
  const [reuseModalOpen, setReuseModalOpen] = useState(false);
  const [reuseModalStep, setReuseModalStep] = useState<"preview" | "confirm">("preview");
  const [reuseConfirmChecked, setReuseConfirmChecked] = useState(false);

  const [submissionRecordOpen, setSubmissionRecordOpen] = useState(false);
  const [submissionRecord, setSubmissionRecord] = useState<{
    termLabel: string;
    submittedAt: string;
    prefs: SavedPrefs;
    source: "edit" | "reuse";
    reusedFromLabel?: string;
  } | null>(null);


  // prefs window state (from backend options)
  const [prefsWindow, setPrefsWindow] = useState<{ openISO: string; deadlineISO: string }>({
    openISO: "",
    deadlineISO: "",
  });

  const { past: openPassedPage } = useCountdown(prefsWindow.openISO || "");
  const { past: deadlinePassedPage } = useCountdown(prefsWindow.deadlineISO || "");
  // Editing is allowed only while the submission window is active.
  // - Locked before submissions open
  // - Locked after the deadline passes
  // - Locked when the OM has not configured a window yet (missing timestamps)
  // If the OM resets/extends the deadline (backend returns a new deadlineISO), this will automatically re-enable.
  const editingLocked =
    !prefsWindow.openISO ||
    !prefsWindow.deadlineISO ||
    !openPassedPage ||
    deadlinePassedPage;

  const [kacOptions, setKacOptions] = useState<Array<{ kac_id: string; kac_code: string; kac_name: string }>>([]);
  const [daysMaster, setDaysMaster] = useState<string[]>([]);
  const [timeSlotsMaster, setTimeSlotsMaster] = useState<string[]>([]);
  const [futureTerms, setFutureTerms] = useState<FutureTerm[]>([]); // UPDATED: state for future terms
  const [loading, setLoading] = useState(true);
  const [employmentType, setEmploymentType] = useState<"FT" | "PT">("FT"); // default FT; corrected after fetch
  const [courseCodeById, setCourseCodeById] = useState<Record<string, string>>({});

  const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
  const userId = raw.userId || raw.user_id || raw.id;



  const formatPreferenceLabel = (rec?: PreferenceRecord | null) => {
    if (!rec) return "—";
    // Prefer backend-provided term_label
    const tl = String(rec.term_label || "").trim();
    if (tl) return `${tl} Preference`;

    const meta = (rec.term_meta || {}) as TermMeta;
    const tnRaw = meta.term_number;
    const aySRaw = meta.acad_year_start;
    const ayERaw = meta.acad_year_end;

    const tn = tnRaw != null && String(tnRaw).trim() ? Number(tnRaw) : NaN;
    const ayS = aySRaw != null && String(aySRaw).trim() ? Number(aySRaw) : NaN;
    const ayE =
      ayERaw != null && String(ayERaw).trim()
        ? Number(ayERaw)
        : Number.isFinite(ayS)
        ? ayS + 1
        : NaN;

    if (Number.isFinite(tn) && Number.isFinite(ayS) && Number.isFinite(ayE)) {
      return `Term ${tn} AY ${ayS}–${ayE} Preference`;
    }
    const tid = String(rec.term_id || "").trim();
    return tid ? `${tid} Preference` : "Preference";
  };

  const preferenceHistory = useMemo(() => {
    const list = Array.isArray(preferences) ? preferences : [];
    // keep distinct term_ids, newest first
    const seen = new Set<string>();
    const out: PreferenceRecord[] = [];
    for (const r of list) {
      const tid = String(r?.term_id || "").trim();
      if (!tid || seen.has(tid)) continue;
      seen.add(tid);
      out.push(r);
      if (out.length >= 3) break;
    }
    return out;
  }, [preferences]);

  const selectedHistoryRecord = useMemo(() => {
    if (!selectedHistoryTermId) return preferenceHistory[0] || null;
    return preferenceHistory.find((r) => String(r.term_id || "") === selectedHistoryTermId) || null;
  }, [preferenceHistory, selectedHistoryTermId]);
  useEffect(() => {
    // keep hover in sync with the selected record whenever the menu opens
    if (!reuseMenuOpen) return;
    const idx = preferenceHistory.findIndex(
      (r) => String(r.term_id || "") === String(selectedHistoryTermId || "")
    );
    setReuseMenuHover(Math.max(0, idx));
  }, [reuseMenuOpen, preferenceHistory, selectedHistoryTermId]);

  useEffect(() => {
    // close the "Reuse Previous Submission" history menu when clicking outside
    const close = (e: MouseEvent) => {
      if (!reuseMenuOpen) return;
      const t = e.target as Node;
      if (reuseMenuBtnRef.current?.contains(t)) return;
      if (reuseMenuListRef.current?.contains(t)) return;
      setReuseMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [reuseMenuOpen]);

  useEffect(() => {
    if (editingLocked || reuseBusy) setReuseMenuOpen(false);
  }, [editingLocked, reuseBusy]);


  const activeTermRecord = useMemo(() => {
    const tid = String(activeTermId || "").trim();
    if (!tid) return null;
    return (preferences || []).find((r) => String(r.term_id || "") === tid) || null;
  }, [preferences, activeTermId]);

  // server -> SavedPrefs
  function fromServerToSaved(latest: any): SavedPrefs {
    const deloadArr = Array.isArray(latest?.deloading_data) ? latest.deloading_data : [];
    const prefUnitsNumber = Number(latest?.preferred_units);
    const prefUnitsLabel = Number.isFinite(prefUnitsNumber) ? toLabel(prefUnitsNumber) : "";

    const kacList = Array.isArray(latest?.preferred_kacs) ? latest.preferred_kacs : [];
    const kacDisplay = kacList
      .map((k: any) => k?.kac_name || k?.kac_code || k?.kac_id || String(k))
      .filter(Boolean);

    // normalize return date into YYYY-MM-DD if backend used MM/DD/YYYY
    const retRaw: string = latest?.break_return_date || "";
    const retISO = /^\d{2}\/\d{2}\/\d{4}$/.test(retRaw)
      ? (() => {
          const [mm, dd, yy] = retRaw.split("/");
          return `${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
        })()
      : retRaw || "";

    return {
      prefUnits: prefUnitsLabel || "",
      deloadings: deloadArr
        .map((d: any) => ({
          type: d?.deloading_type ?? "Administrative",
          units: d?.units != null ? Number(d.units) : null,
          detail: d?.detail ?? d?.notes ?? "",
          additionalNotes: d?.additional_notes ?? "",
        }))
        .filter((x: any) => x.type || x.units != null),
      noDeloading: deloadArr.length === 0,
      days: expandDays(latest?.availability_days ?? []),
      timeSlots: Array.isArray(latest?.preferred_times)
        ? latest.preferred_times.map((t: string) => normalizeDbTimeToUi(String(t)))
        : [],
      campus: (() => {
        const ids: string[] = Array.isArray(latest?.mode?.campus_id) ? latest.mode.campus_id : [];
        const names: string[] = Array.isArray(latest?.mode?.campus_names)
          ? latest.mode.campus_names
          : [];
        const haveManila =
          ids.includes("CMPS0001") || names.some((n) => /manila/i.test(n));
        const haveLaguna =
          ids.includes("CMPS0002") || names.some((n) => /laguna/i.test(n));
        if (haveManila && haveLaguna) return "Either Campus";
        if (haveManila) return "Manila Campus";
        if (haveLaguna) return "Laguna Campus";
        return "";
      })(),
      delivery: (() => {
        const code = String(latest?.mode?.mode || "").toUpperCase();
        if (code === "FOL") return "Fully Online";
        if (code === "HYB") {
          const ids: string[] = Array.isArray(latest?.mode?.campus_id)
            ? latest.mode.campus_id
            : [];
          const names: string[] = Array.isArray(latest?.mode?.campus_names)
            ? latest.mode.campus_names
            : [];
          const haveManila =
            ids.includes("CMPS0001") || names.some((n) => /manila/i.test(n));
          const haveLaguna =
            ids.includes("CMPS0002") || names.some((n) => /laguna/i.test(n));
          if (haveManila && haveLaguna) return "Hybrid - Any Campus";
          if (haveManila) return "Hybrid - Manila Campus Only";
          if (haveLaguna) return "Hybrid - Laguna Campus Only";
          return "";
        }
        return "";
      })(),
      kac: kacDisplay,
      remarks: latest?.notes ?? "",
      onBreak: !!latest?.on_break,
      breakReason: latest?.break_reason ?? "",
      breakReturnTermId: latest?.break_return_term_id ?? "", // UPDATED
      breakReturnDate: retISO,
    };
  }

useEffect(() => {
  (async () => {
    try {
      if (!userId) {
        setLoading(false);
        return;
      }

      // NEW: trigger deadline reminder generation (safe to call repeatedly; backend dedupes)
      fetch("/api/notifications/run-prefs-deadline-reminders", { method: "POST" }).catch(() => {});

      const [profile, opts] = await Promise.all([
        getFacultyPreferencesProfile(userId),
        getFacultyPreferencesOptions(userId),
      ]);

        setPrefsWindow({
          openISO: opts?.prefs_window?.openISO || "",
          deadlineISO: opts?.prefs_window?.deadlineISO || "",
        });
        setActiveTermId(String(opts?.activeTerm?.term_id || opts?.prefs_window?.term_id || "").trim());

        setKacOptions((opts?.kacs || []) as any);
        setDaysMaster(
          Array.isArray(opts?.days_display)
            ? opts.days_display
            : ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        );
        setTimeSlotsMaster(
          Array.isArray(opts?.time_slots_display) ? opts.time_slots_display : []
        );
        setFutureTerms(opts?.future_terms || []); // UPDATED: Set future terms from API

        setCourseCodeById((opts?.courses_index || opts?.coursesIndex || {}) as any);

        const et =
          (
            profile?.faculty?.employment_type ||
            profile?.employment_type ||
            profile?.faculty_type ||
            profile?.type ||
            ""
          )
            .toString()
            .toUpperCase();
        setEmploymentType(et === "PT" ? "PT" : "FT");

        const list = await getFacultyPreferencesList(userId);
        const prefs = (list?.preferences || []) as PreferenceRecord[];
        setPreferences(prefs);

        // Prefer showing the latest saved prefs (existing behavior),
        // but keep track of which term it's from so the UI can label it clearly.
        const latest = prefs[0];
        if (latest) setSaved(fromServerToSaved(latest));

        // Establish history dropdown default (last 3 distinct terms)
        const seen = new Set<string>();
        const hist: PreferenceRecord[] = [];
        for (const r of prefs) {
          const tid = String(r?.term_id || "").trim();
          if (!tid || seen.has(tid)) continue;
          seen.add(tid);
          hist.push(r);
          if (hist.length >= 3) break;
        }
        // Default: most recent non-active term if available; otherwise most recent term
        const activeTid = String((opts?.activeTerm?.term_id || opts?.prefs_window?.term_id || "") as any).trim();
        const defaultRec =
          hist.find((r) => String(r.term_id || "") !== activeTid) || hist[0] || null;
        setSelectedHistoryTermId(defaultRec ? String(defaultRec.term_id || "") : "");
      } catch (e: any) {
        alert(`Failed to load preferences: ${e?.message || e}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]);

  const coherentInitial: SavedPrefs = useMemo(() => ({ ...saved }), [saved]);

  // map kac display -> id (always store id)
  const nameToId = (name: string) => {
    const hit = kacOptions.find(
      (k) => (k.kac_name || "").toLowerCase() === (name || "").toLowerCase()
    );
    return hit?.kac_id || name;
  };

  const toServerPayload = (v: SavedPrefs, finished: boolean) => {
    const ZERO_LOAD_LABEL = "0.0 units - no teaching load (for full-time only)";
    const onBreak = v.prefUnits === TEACHING_BREAK;
    const isZeroTeachingLoad = v.prefUnits === ZERO_LOAD_LABEL;

    const isLeaveLocal = onBreak && v.noDeloading;

    const preferredUnits =
      onBreak || isZeroTeachingLoad ? 0 : parseUnits(v.prefUnits) ?? 0;

    const mapDeload = (r: DeloadRow) => {
      const needsSpecify = r.type === "Administrative" || r.type === "Research";
      const detail = (r.detail || "").trim();
      return {
        deloading_type: r.type,
        units: r.units ?? 0,
        detail: needsSpecify ? detail : "",
        additional_notes: (r.additionalNotes || "").trim(),
      };
    };

    return {
      preferred_units: preferredUnits,
      availability_days:
        onBreak || isZeroTeachingLoad ? [] : compressDays(v.days),
      preferred_times:
        onBreak || isZeroTeachingLoad
          ? []
          : v.timeSlots.map((t) => normalizeUiTimeToDb(String(t))),
      preferred_kacs:
        onBreak || isZeroTeachingLoad ? [] : (v.kac || []).map(nameToId),
      deloading_data: v.noDeloading
        ? []
        : (v.deloadings || [])
            .filter((r) => r && r.type)
            .map(mapDeload),
      mode:
        onBreak || isZeroTeachingLoad
          ? { mode: "HYB", campus_id: [] }
          : toModePayload(v),
      notes: onBreak ? "" : v.remarks,
      has_new_prep: false,
      is_finished: finished,

      on_break: onBreak,
      break_reason: isLeaveLocal ? v.breakReason : "",
      // return date is now an expected date selected by the faculty (YYYY-MM-DD)
      break_return_date: isLeaveLocal ? v.breakReturnDate : "",
      employment_type: employmentType,
    } as const;
  };

  async function afterSubmitRefresh(
    res: any,
    source: "edit" | "reuse",
    reusedFromLabel?: string
  ) {
    if (res?.ok && res?.preference) {
      const normalized = fromServerToSaved(res.preference);
      setSaved(normalized);
      setOpenEdit(false);

      const termLabel = formatPreferenceLabel(res.preference as any);
      const submittedAtRaw =
        (res.preference?.submitted_at || res.preference?.updated_at || res.preference?.created_at || "") as any;
      const submittedAt = typeof submittedAtRaw === "string" ? submittedAtRaw : String(submittedAtRaw || "");
      setSubmissionRecord({
        termLabel,
        submittedAt,
        prefs: normalized,
        source,
        reusedFromLabel,
      });
      setSubmissionRecordOpen(true);
      return;
    }
    throw new Error(res?.detail || "Save failed.");
  }

  const handleSave = async (v: SavedPrefs) => {
    try {
      const payload = toServerPayload(v, true);
      const res = await submitFacultyPreferences(userId, payload);
      await afterSubmitRefresh(res, "edit");
    } catch (e: any) {
      alert(e?.response?.data?.detail || e?.message || "Failed to save preferences.");
    }
  };

  const handleReusePrevious = () => {
    setReuseNotice("");
    setReuseModalStep("preview");
    setReuseConfirmChecked(false);
    setReuseModalOpen(true);
  };

  const handleReuseSubmitConfirmed = async () => {
    const src = selectedHistoryRecord;
    if (!src) {
      setReuseNotice("No previous preference record found to reuse.");
      setReuseModalOpen(false);
      return;
    }

    try {
      setReuseBusy(true);
      const srcSaved = fromServerToSaved(src);
      const payload = toServerPayload(srcSaved, true);
      const res = await submitFacultyPreferences(userId, payload);
      await afterSubmitRefresh(res, "reuse", formatPreferenceLabel(src));
      setReuseNotice("Previous preferences submitted successfully.");
      setReuseModalOpen(false);
    } catch (e: any) {
      alert(e?.response?.data?.detail || e?.message || "Failed to submit previous preferences.");
    } finally {
      setReuseBusy(false);
    }
  };

  if (loading) {
    return (
      <section className="mx-auto w-full max-w-screen-2xl px-4">
        <div className="rounded-xl border border-neutral-200 bg-white p-5 text-sm text-neutral-600">
          Loading preferences…
        </div>
      </section>
    );
  }

  if (openEdit) {
    return (
      <section className="mx-auto w-full max-w-screen-2xl px-4">
        <EditForm
          initial={coherentInitial}
          onClose={() => setOpenEdit(false)}
          onSave={handleSave}
          openISO={prefsWindow.openISO}
          deadlineISO={prefsWindow.deadlineISO}
          employmentType={employmentType}
          daysMaster={daysMaster}
          timeSlotsMaster={timeSlotsMaster}
          kacDisplayOptions={([...kacOptions] as any)
            .map((k: any) => ({
              value: String(k.kac_name || k.kac_code || k.kac_id || "").trim(),
              label: String(k.kac_name || k.kac_code || k.kac_id || "").trim(),
              courses_display: (() => {
                const codeOf = (c: any): string => {
                  const raw =
                    (Array.isArray(c?.course_code) ? c.course_code[0] : c?.course_code) ||
                    (c?.course_id ? courseCodeById[String(c.course_id).trim()] : "") ||
                    c?.course_id ||
                    "";
                  return String(raw || "").trim();
                };

                const courses = Array.isArray(k?.courses) ? k.courses : [];
                if (courses.length) {
                  return courses
                    .map((c: any) => {
                      const code = codeOf(c);
                      const title = String(c?.course_title || "").trim();
                      if (code && title) return `${code} • ${title}`;
                      return code || title;
                    })
                    .filter(Boolean);
                }

                const ids = Array.isArray(k?.course_list) ? k.course_list : [];
                return ids
                  .map((id: any) => {
                    const key = String(id || "").trim();
                    return (courseCodeById && courseCodeById[key]) ? courseCodeById[key] : key;
                  })
                  .filter(Boolean);
              })(),
            }))
            .filter((o: any) => o.value)
            .sort((a: any, b: any) => String(a.label).localeCompare(String(b.label)))}
          futureTerms={futureTerms} // UPDATED: Pass terms
        />
      </section>
    );
  }

  /* -------------------- SAVED VIEW -------------------- */
  

  const savedReturnDateLabel = saved.breakReturnDate || "";

  const latestRecord = (preferences || [])[0] || null;
  const latestLabel = formatPreferenceLabel(latestRecord);
  const activeLabel = activeTermId
    ? formatPreferenceLabel(activeTermRecord || ({ term_id: activeTermId } as any))
    : "—";
  const latestIsActive = !!activeTermId && String(latestRecord?.term_id || "") === String(activeTermId);

  const latestSubmittedAt = (() => {
    const raw = (latestRecord as any)?.submitted_at || (latestRecord as any)?.updated_at || (latestRecord as any)?.created_at;
    if (!raw) return "";
    const d = new Date(String(raw));
    return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleString();
  })();

  const stripPreference = (s: string) => String(s || "").replace(/\s*Preference\s*$/i, "").trim();
  const activeTermTitle = stripPreference(activeLabel);
  const latestTermTitle = stripPreference(latestLabel);
  const showLatestTermName = !!latestTermTitle && latestTermTitle !== "—" && !latestIsActive && latestTermTitle !== activeTermTitle;



  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
      <DeadlineBanner openISO={prefsWindow.openISO} deadlineISO={prefsWindow.deadlineISO} />

      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        {!!reuseNotice && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {reuseNotice}
          </div>
        )}

        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-1">
              <h2 className="text-[15px] font-semibold text-neutral-900">
                Faculty Preferences for <span className="text-emerald-700">{activeTermTitle || activeLabel}</span>
              </h2>
              <button
                type="button"
                onClick={() => setInfoOpen(true)}
                className="inline-flex items-center justify-center rounded-full p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
                aria-label="About Faculty Preferences"
                title="About Faculty Preferences"
              >
                <Info className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-0.5 text-sm text-neutral-500">
              Share your teaching preferences to help guide planning for this term.
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              {showLatestTermName ? (
                <Tag tone="gray">
                  <BookOpen className="h-3.5 w-3.5" />
                  Last submitted for {latestTermTitle}
                </Tag>
              ) : null}

              {!!latestSubmittedAt && (
                <Tag tone={latestIsActive ? "emerald" : "gray"}>
                  <CalendarDays className="h-3.5 w-3.5" />
                  Last submitted: {latestSubmittedAt}
                </Tag>
              )}
            </div>

            
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <button
                ref={reuseMenuBtnRef}
                type="button"
                disabled={editingLocked || reuseBusy || preferenceHistory.length === 0}
                onClick={() => setReuseMenuOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={reuseMenuOpen}
                className={cls(
                  BTN_BASE,
                  "gap-2",
                  editingLocked || reuseBusy || preferenceHistory.length === 0
                    ? "cursor-not-allowed bg-gray-200 text-gray-600"
                    : "bg-neutral-100 text-slate-900 hover:bg-neutral-200/70"
                )}
                title={
                  preferenceHistory.length === 0
                    ? "No previous preferences found"
                    : !openPassedPage
                    ? "Submissions not open yet"
                    : deadlinePassedPage
                    ? "Deadline passed — submissions locked"
                    : "Reuse and submit a previous preference for the planning term"
                }
              >
                <BookOpen className="h-4 w-4" />
                {reuseBusy ? "Submitting…" : "Reuse Previous Submission"}
                <ChevronDown className="ml-1 h-4 w-4 opacity-70" />
              </button>

              {reuseMenuOpen && preferenceHistory.length > 0 && (
                <div
                  ref={reuseMenuListRef}
                  role="listbox"
                  className={cls(DD_MENU, "w-full min-w-[280px] max-w-[420px]")}
                >
                  {preferenceHistory.map((r, i) => {
                    const tid = String(r.term_id || "");
                    const label = formatPreferenceLabel(r);
                    const raw = (r as any)?.submitted_at || (r as any)?.updated_at || (r as any)?.created_at;
                    const submitted = raw
                      ? (() => {
                          const d = new Date(String(raw));
                          return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleDateString();
                        })()
                      : "";
                    const selected = tid === String(selectedHistoryTermId || "");
                    return (
                      <button
                        key={tid}
                        role="option"
                        aria-selected={selected}
                        onMouseEnter={() => setReuseMenuHover(i)}
                        onClick={() => {
                          setSelectedHistoryTermId(tid);
                          setReuseMenuOpen(false);
                          handleReusePrevious();
                        }}
                        className={cls(
                          "block w-full px-4 py-3 text-left text-[15px]",
                          i === reuseMenuHover && "bg-emerald-50"
                        )}
                      >
                        <span className="flex items-start justify-between gap-3">
                          <span className="min-w-0">
                            <span className="block truncate">{label}</span>
                            {submitted ? (
                              <span className="mt-0.5 block text-[12px] text-neutral-500">Submitted: {submitted}</span>
                            ) : null}
                          </span>
                          {selected && <CheckCircle2 className="h-4 w-4 text-emerald-700" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              disabled={editingLocked}
              onClick={() => {
                setReuseNotice("");
                setOpenEdit(true);
              }}
              className={cls(
                BTN_BASE,
                "gap-2",
                editingLocked
                  ? "cursor-not-allowed bg-gray-300 text-gray-600"
                  : "bg-emerald-700 text-white hover:brightness-110"
              )}
              title={
                !openPassedPage
                  ? "Submissions not open yet"
                  : deadlinePassedPage
                  ? "Deadline passed — editing locked"
                  : "Edit preferences"
              }
            >
              <Settings className="h-4 w-4" />
              Edit Preferences
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-2">
          <div>
            <SectionTitle icon={BookOpen}>Teaching Load</SectionTitle>
            <Row
              label="Preferred Teaching Units"
              value={<Tag tone="gray">{saved.prefUnits || "—"}</Tag>}
            />
            
            {/* Display leave details only when teaching break is treated as leave (no deloading) */}
            {saved.onBreak && saved.noDeloading && (
              <>
                <Row
                  label="Break Reason"
                  value={<span className="text-neutral-900">{saved.breakReason}</span>}
                />
                <Row
                  label="Expected date of Return"
                  value={<span className="text-neutral-900">{savedReturnDateLabel || "—"}</span>}
                />
              </>
            )}

            <Row
              label="Deloading"
              value={
                saved.noDeloading || saved.deloadings.length === 0 ? (
                  <span className="text-neutral-400">None</span>
                ) : (
                  <div className="flex flex-col gap-1">
                    {saved.deloadings.map((r, i) => (
                      <div key={i} className="text-sm">
                        <Tag tone="gray">{r.type}</Tag>{" "}
                        <Tag tone="gray">{(r.units ?? 0) + " units"}</Tag>
                      </div>
                    ))}
                  </div>
                )
              }
            />
            <div className="mt-3 border-b border-neutral-200" />
          </div>

          <div>
            <SectionTitle icon={MapPin}>Location &amp; Mode</SectionTitle>
            <Row label="Campus Preference" value={<Tag tone="gray">{saved.campus || "—"}</Tag>} />
            <Row
              label="Delivery Mode"
              value={
                saved.delivery ? (
                  <Tag tone="gray">{saved.delivery}</Tag>
                ) : (
                  <span className="text-neutral-400">—</span>
                )
              }
            />
            <div className="mt-3 border-b border-transparent lg:border-b-0" />
          </div>

          <div>
            <SectionTitle icon={CalendarDays}>Schedule Preferences</SectionTitle>
            <Row label="Preferred Days" value={<Pills items={saved.days} />} />
            <Row label="Preferred Time Slots" value={<Pills items={saved.timeSlots} />} />
          </div>

          <div>
            <SectionTitle icon={Monitor}>Academic Specialization</SectionTitle>
            <Row
              label="Knowledge Areas"
              value={
                (saved.kac || []).length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {saved.kac.map((k: any) => (
                      <Tag key={String(k)} tone="emerald">
                        {String(k)}
                      </Tag>
                    ))}
                  </div>
                ) : (
                  <span className="text-neutral-400">—</span>
                )
              }
            />
          </div>

          <div className="lg:col-span-2">
            <SectionTitle icon={BookOpen}>Remarks</SectionTitle>
            <div className="text-sm text-neutral-800">
              {saved.remarks?.trim() || <span className="text-neutral-400">No remarks</span>}
            </div>
          </div>
        </div>
      </div>

      
      {/* Info modal */} 
      <Modal
        open={infoOpen}
        title="How Faculty Preferences work"
        onClose={() => setInfoOpen(false)}
        footer={
          <div className="flex items-center justify-end">
            <button
              type="button"
              className={cls(BTN_BASE, "bg-neutral-100 text-slate-900 hover:bg-neutral-200/70")}
              onClick={() => setInfoOpen(false)}
            >
              Close
            </button>
          </div>
        }
      >
        <div className="space-y-4 text-sm text-neutral-700">
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
            <p className="text-[13px] leading-6">
              These preferences help guide scheduling decisions for{' '}
              <span className="font-semibold text-neutral-900">{activeTermTitle || activeLabel}</span>. Final assignments may
              also consider availability, department needs, and scheduling conflicts.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
              <div className="flex items-start gap-2">
                <div className="mt-0.5 rounded-lg bg-emerald-50 p-2 text-emerald-700">
                  <BookOpen className="h-4 w-4" />
                </div>
                <div>
                  <p className="font-medium text-neutral-900">Reuse Previous Submission</p>
                  <p className="mt-1 text-[13px] leading-5 text-neutral-600">
                    Submits a saved preference set from a prior term for the current term. You’ll preview it first and
                    confirm before submitting.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-neutral-200 bg-white p-3 shadow-sm">
              <div className="flex items-start gap-2">
                <div className="mt-0.5 rounded-lg bg-emerald-50 p-2 text-emerald-700">
                  <Settings className="h-4 w-4" />
                </div>
                <div>
                  <p className="font-medium text-neutral-900">Edit Preferences</p>
                  <p className="mt-1 text-[13px] leading-5 text-neutral-600">
                    Opens the editable form so you can update days, time slots, KACs, and other preferences, then submit
                    a new set.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Modal>

{/* Preview + confirmation modal for "Reuse Previous Submission" */}
      <Modal
        open={reuseModalOpen}
        title={reuseModalStep === "preview" ? "Preview previous preferences" : "Confirm submission"}
        onClose={() => {
          if (!reuseBusy) {
            setReuseModalOpen(false);
            setReuseModalStep("preview");
            setReuseConfirmChecked(false);
          }
        }}
        footer={
          reuseModalStep === "preview" ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className={cls(BTN_BASE, "bg-neutral-100 text-slate-900 hover:bg-neutral-200/70")}
                onClick={() => setReuseModalOpen(false)}
                disabled={reuseBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className={cls(BTN_BASE, "bg-emerald-700 text-white hover:brightness-110")}
                onClick={() => {
                  setReuseModalStep("confirm");
                  setReuseConfirmChecked(false);
                }}
                disabled={reuseBusy || !selectedHistoryRecord}
              >
                Continue
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                className={cls(BTN_BASE, "bg-neutral-100 text-slate-900 hover:bg-neutral-200/70")}
                onClick={() => setReuseModalStep("preview")}
                disabled={reuseBusy}
              >
                Back
              </button>
              <button
                type="button"
                className={cls(
                  BTN_BASE,
                  reuseBusy || !reuseConfirmChecked
                    ? "cursor-not-allowed bg-gray-200 text-gray-600"
                    : "bg-emerald-700 text-white hover:brightness-110"
                )}
                onClick={handleReuseSubmitConfirmed}
                disabled={reuseBusy || !reuseConfirmChecked}
              >
                {reuseBusy ? "Submitting…" : "Confirm & Submit"}
              </button>
            </div>
          )
        }
      >
        {!selectedHistoryRecord ? (
          <div className="text-sm text-neutral-600">No previous preference record available.</div>
        ) : reuseModalStep === "preview" ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-700">
              You are about to submit <span className="font-semibold">{formatPreferenceLabel(selectedHistoryRecord)}</span>{" "}
              for the planning term <span className="font-semibold">{activeLabel}</span>.
            </div>

            <div className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-2">
              {(() => {
                const p = fromServerToSaved(selectedHistoryRecord);
                const returnLabel = p.breakReturnDate || "";
                return (
                  <>
                    <div>
                      <SectionTitle icon={BookOpen}>Teaching Load</SectionTitle>
                      <Row label="Preferred Teaching Units" value={<Tag tone="gray">{p.prefUnits || "—"}</Tag>} />
                      {p.onBreak && p.noDeloading && (
                        <>
                          <Row label="Break Reason" value={<span className="text-neutral-900">{p.breakReason}</span>} />
                          <Row
                            label="Expected date of Return"
                            value={<span className="text-neutral-900">{returnLabel || "—"}</span>}
                          />
                        </>
                      )}
                      <Row
                        label="Deloading"
                        value={
                          p.noDeloading || p.deloadings.length === 0 ? (
                            <span className="text-neutral-400">None</span>
                          ) : (
                            <div className="flex flex-col gap-1">
                              {p.deloadings.map((r, i) => (
                                <div key={i} className="text-sm">
                                  <Tag tone="gray">{r.type}</Tag>{" "}
                                  <Tag tone="gray">{(r.units ?? 0) + " units"}</Tag>
                                </div>
                              ))}
                            </div>
                          )
                        }
                      />
                      <div className="mt-3 border-b border-neutral-200" />
                    </div>

                    <div>
                      <SectionTitle icon={MapPin}>Location &amp; Mode</SectionTitle>
                      <Row label="Campus Preference" value={<Tag tone="gray">{p.campus || "—"}</Tag>} />
                      <Row
                        label="Delivery Mode"
                        value={p.delivery ? <Tag tone="gray">{p.delivery}</Tag> : <span className="text-neutral-400">—</span>}
                      />
                      <div className="mt-3 border-b border-transparent lg:border-b-0" />
                    </div>

                    <div>
                      <SectionTitle icon={CalendarDays}>Schedule Preferences</SectionTitle>
                      <Row label="Preferred Days" value={<Pills items={p.days} />} />
                      <Row label="Preferred Time Slots" value={<Pills items={p.timeSlots} />} />
                    </div>

                    <div>
                      <SectionTitle icon={Monitor}>Academic Specialization</SectionTitle>
                      <Row
                        label="Knowledge Areas"
                        value={
                          (p.kac || []).length ? (
                            <div className="flex flex-wrap gap-1.5">
                              {p.kac.map((k: any) => (
                                <Tag key={String(k)} tone="emerald">
                                  {String(k)}
                                </Tag>
                              ))}
                            </div>
                          ) : (
                            <span className="text-neutral-400">—</span>
                          )
                        }
                      />
                    </div>

                    <div className="lg:col-span-2">
                      <SectionTitle icon={BookOpen}>Remarks</SectionTitle>
                      <div className="text-sm text-neutral-800">
                        {p.remarks?.trim() || <span className="text-neutral-400">No remarks</span>}
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-5 w-5" />
              <div>
                <div className="font-semibold">Please confirm</div>
                <div className="mt-0.5 text-amber-900/90">
                  This will submit the selected previous preferences for the planning term. This action may overwrite an existing saved preference for the planning term.
                </div>
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-neutral-300 text-emerald-700"
                checked={reuseConfirmChecked}
                onChange={(e) => setReuseConfirmChecked(e.target.checked)}
                disabled={reuseBusy}
              />
              <span>
                I understand and want to submit <span className="font-semibold">{formatPreferenceLabel(selectedHistoryRecord)}</span> for{" "}
                <span className="font-semibold">{activeLabel}</span>.
              </span>
            </label>
          </div>
        )}
      </Modal>

      {/* After submission, show an exact record of what was saved */}
      <Modal
        open={submissionRecordOpen}
        title="Submission record"
        onClose={() => setSubmissionRecordOpen(false)}
        footer={
          <div className="flex items-center justify-end">
            <button
              type="button"
              className={cls(BTN_BASE, "bg-emerald-700 text-white hover:brightness-110")}
              onClick={() => setSubmissionRecordOpen(false)}
            >
              Close
            </button>
          </div>
        }
      >
        {!submissionRecord ? (
          <div className="text-sm text-neutral-600">No submission record.</div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              <CheckCircle2 className="mt-0.5 h-5 w-5" />
              <div>
                <div className="font-semibold">{submissionRecord.termLabel}</div>
                {!!submissionRecord.submittedAt && (
                  <div className="mt-0.5 text-emerald-900/90">Submitted at: {submissionRecord.submittedAt}</div>
                )}
                {submissionRecord.source === "reuse" && submissionRecord.reusedFromLabel ? (
                  <div className="mt-0.5 text-emerald-900/90">Reused from: {submissionRecord.reusedFromLabel}</div>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-2">
              {(() => {
                const p = submissionRecord.prefs;
                const returnLabel = p.breakReturnDate || "";
                return (
                  <>
                    <div>
                      <SectionTitle icon={BookOpen}>Teaching Load</SectionTitle>
                      <Row label="Preferred Teaching Units" value={<Tag tone="gray">{p.prefUnits || "—"}</Tag>} />
                      {p.onBreak && p.noDeloading && (
                        <>
                          <Row label="Break Reason" value={<span className="text-neutral-900">{p.breakReason}</span>} />
                          <Row
                            label="Expected date of Return"
                            value={<span className="text-neutral-900">{returnLabel || "—"}</span>}
                          />
                        </>
                      )}
                      <Row
                        label="Deloading"
                        value={
                          p.noDeloading || p.deloadings.length === 0 ? (
                            <span className="text-neutral-400">None</span>
                          ) : (
                            <div className="flex flex-col gap-1">
                              {p.deloadings.map((r, i) => (
                                <div key={i} className="text-sm">
                                  <Tag tone="gray">{r.type}</Tag>{" "}
                                  <Tag tone="gray">{(r.units ?? 0) + " units"}</Tag>
                                </div>
                              ))}
                            </div>
                          )
                        }
                      />
                      <div className="mt-3 border-b border-neutral-200" />
                    </div>

                    <div>
                      <SectionTitle icon={MapPin}>Location &amp; Mode</SectionTitle>
                      <Row label="Campus Preference" value={<Tag tone="gray">{p.campus || "—"}</Tag>} />
                      <Row
                        label="Delivery Mode"
                        value={p.delivery ? <Tag tone="gray">{p.delivery}</Tag> : <span className="text-neutral-400">—</span>}
                      />
                      <div className="mt-3 border-b border-transparent lg:border-b-0" />
                    </div>

                    <div>
                      <SectionTitle icon={CalendarDays}>Schedule Preferences</SectionTitle>
                      <Row label="Preferred Days" value={<Pills items={p.days} />} />
                      <Row label="Preferred Time Slots" value={<Pills items={p.timeSlots} />} />
                    </div>

                    <div>
                      <SectionTitle icon={Monitor}>Academic Specialization</SectionTitle>
                      <Row
                        label="Knowledge Areas"
                        value={
                          (p.kac || []).length ? (
                            <div className="flex flex-wrap gap-1.5">
                              {p.kac.map((k: any) => (
                                <Tag key={String(k)} tone="emerald">
                                  {String(k)}
                                </Tag>
                              ))}
                            </div>
                          ) : (
                            <span className="text-neutral-400">—</span>
                          )
                        }
                      />
                    </div>

                    <div className="lg:col-span-2">
                      <SectionTitle icon={BookOpen}>Remarks</SectionTitle>
                      <div className="text-sm text-neutral-800">
                        {p.remarks?.trim() || <span className="text-neutral-400">No remarks</span>}
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        )}
      </Modal>

    </section>
  );
}

export const PreferencesContent = FACULTY_Preferences;