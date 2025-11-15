// FACULTY_Preferences.tsx

import React, { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, MapPin, Monitor, BookOpen, Settings, Info, AlertTriangle } from "lucide-react";
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

/* ---------- multi-select dropdown ---------- */
function MultiSelectDropdown({
  values,
  onChange,
  options,
  className = "w/full",
  placeholder = "— Select options —",
  maxPreview = 2,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  options: readonly string[];
  className?: string;
  placeholder?: string;
  maxPreview?: number;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(0);
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
  const toggle = (opt: string) => onChange(values.includes(opt) ? values.filter((v) => v !== opt) : [...values, opt]);
  const label =
    values.length === 0 ? (
      <span className="text-gray-400">{placeholder}</span>
    ) : values.length <= maxPreview ? (
      values.join(", ")
    ) : (
      `${values.slice(0, maxPreview).join(", ")} +${values.length - maxPreview} more`
    );
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
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle(options[hover]);
    }
  };
  return (
    <div className={cls("relative", className)} onKeyDown={onKey}>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={DD_BASE}
      >
        {label}
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2">▾</span>
      </button>
      {open && (
        <div ref={listRef} role="listbox" className={DD_MENU}>
          {options.map((opt, i) => {
            const checked = values.includes(opt);
            return (
              <button
                key={opt}
                role="option"
                aria-selected={checked}
                onMouseEnter={() => setHover(i)}
                onClick={() => toggle(opt)}
                className={cls(
                  "flex w-full items-center gap-3 px-4 py-3 text-left text-[15px]",
                  i === hover && "bg-emerald-50"
                )}
              >
                <input type="checkbox" readOnly checked={checked} className="accent-emerald-700" />
                <span>{opt}</span>
              </button>
            );
          })}
          {values.length > 0 && (
            <div className="flex items-center justify-between border-t border-gray-200 px-4 py-2">
              <button className="text-xs text-emerald-700 hover:underline" onClick={() => onChange([])}>
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
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  className?: string;
  placeholder?: string;
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
        className={DD_BASE}
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
function compressDays(days: string[]): string[] {
  const order = ["M", "T", "W", "H", "F", "S"];
  const letters = days
    .map((d) => DAY_TO_LETTER[d])
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const out: string[] = [];
  let buf: string[] = [];
  const isAdj = (a: string, b: string) => order.indexOf(b) - order.indexOf(a) === 1;
  for (let i = 0; i < letters.length; i++) {
    if (!buf.length) buf.push(letters[i]);
    else if (isAdj(buf[buf.length - 1], letters[i])) buf.push(letters[i]);
    else {
      out.push(buf.join(""));
      buf = [letters[i]];
    }
  }
  if (buf.length) out.push(buf.join(""));
  return out;
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
            • <span className="font-bold text-amber-700">{openISO ? openLabel : "TBA"}</span>
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
          • <span className="font-bold text-amber-700">{deadlineISO ? deadlineLabel : "TBA"}</span>
        </div>
        <div className="mt-1 text-[12px] opacity-80">Please finalize before the deadline. Drafts are allowed until lock.</div>
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
              <tr key={i} className="odd:bg-white even:bg-neutral-50">
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
type DeloadRow = { type: string; detail?: string; units: number | null };
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
  breakReturnDate: string; // YYYY-MM-DD
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
  breakReturnDate: "",
};

/* ===========================
   EDIT FORM
   =========================== */
function EditForm({
  initial,
  onClose,
  onSave,
  onDraft,
  openISO,
  deadlineISO,
  employmentType,
  daysMaster,
  timeSlotsMaster,
  kacDisplayOptions,
}: {
  initial: SavedPrefs;
  onClose: () => void;
  onSave: (v: SavedPrefs) => void;
  onDraft: (v: SavedPrefs) => void;
  openISO: string;
  deadlineISO: string;
  employmentType: "FT" | "PT";
  daysMaster: string[];
  timeSlotsMaster: string[];
  kacDisplayOptions: string[];
}) {
  // local form & wizard step
  const [form, setForm] = useState<SavedPrefs>(initial);
  const [step, setStep] = useState<number>(form.prefUnits && form.prefUnits.trim() ? 2 : 1);

  const ZERO_LOAD_LABEL = "0.0 units - no teaching load (for full-time only)";
  const isZeroTeachingLoad = form.prefUnits === ZERO_LOAD_LABEL;

  const { past: deadlinePassed } = useCountdown(deadlineISO);

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

  const isTeachingBreak = form.prefUnits === TEACHING_BREAK;
  useEffect(() => {
    setForm((f) => ({
      ...f,
      onBreak: isTeachingBreak,
      ...(isTeachingBreak ? {} : { breakReason: "", breakReturnDate: "" }),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.prefUnits]);

  // deloading rows
  const [deloadRows, setDeloadRows] = useState<DeloadRow[]>(() =>
    form.noDeloading ? [] : form.deloadings || []
  );
  useEffect(() => {
    if (form.noDeloading) setDeloadRows([]);
  }, [form.noDeloading]);

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
    if (isTeachingBreak) {
      if (!form.breakReason.trim())
        return { ok: false, msg: "Reason for taking a break/leave is required." };
      if (!form.breakReturnDate.trim())
        return { ok: false, msg: "Date of return is required." };
      return { ok: true };
    }
    if (!form.prefUnits || !prefUnitOptions.includes(form.prefUnits as any)) {
      return { ok: false, msg: "Please select Preferred Teaching Units." };
    }
    for (const r of deloadRows) {
      const needsSpecify = r.type === "Administrative" || r.type === "Research";
      if (!form.noDeloading && needsSpecify && !(r.detail || "").trim()) {
        return { ok: false, msg: `Please provide details for "${r.type}".` };
      }
      if (r.type === "Research" && r.units != null && (r.units < 1 || r.units > 9)) {
        return { ok: false, msg: "Research deloading units must be between 1 and 9." };
      }
    }
    return { ok: true };
  }

  // toggles
  const toggleMulti = (key: "days" | "timeSlots", value: string) =>
    setForm((f) => {
      const arr = f[key] as string[];
      const has = arr.includes(value);
      return { ...f, [key]: has ? arr.filter((v) => v !== value) : [...arr, value] };
    });

  const showAE =
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

  // deadline date (used as max for return date)
  const termEndDate = deadlineISO ? new Date(deadlineISO).toISOString().slice(0, 10) : "";

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
                  if (step === 1 && v && v.trim().length > 0) setStep(2);
                }}
                options={prefUnitOptions}
              />
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
                    className="inline-flex h-9 items-center justify-center rounded-2xl border border-neutral-200 bg-neutral-100 px-4 text-sm text-slate-900 shadow-sm hover:bg-neutral-200/70 active:translate-y-[0.5px]"
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
                                        : "border-neutral-300"
                                    )}
                                    placeholder="Units"
                                    value={r.units ?? ""}
                                    onChange={(e) => {
                                      const v =
                                        e.target.value === ""
                                          ? null
                                          : Number(e.target.value);
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
                              </div>
                            );
                          })}
                          <button
                            type="button"
                            onClick={() =>
                              setDeloadRows((rows) => [
                                ...rows,
                                { type: "Administrative", units: null, detail: "" },
                              ])
                            }
                            className="inline-flex h-9 items-center justify-center rounded-2xl bg-emerald-700 px-4 text-sm text-white shadow hover:brightness-110"
                          >
                            Add Deloading
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="space-y-4">
                      <div>
                        <FieldLabel required>Reason for taking a break/leave</FieldLabel>
                        <input
                          type="text"
                          className="w-full rounded-2xl border border-neutral-300 px-4 py-3 text-[15px] shadow-sm outline-none"
                          placeholder="Reason..."
                          value={form.breakReason}
                          onChange={(e) =>
                            setForm({ ...form, breakReason: e.target.value })
                          }
                        />
                      </div>

                      <div>
                        <FieldLabel required>Date of return (MM/DD/YYYY)</FieldLabel>
                        <input
                          type="date"
                          className="w-full rounded-2xl border border-neutral-300 px-4 py-3 text-[15px] shadow-sm outline-none"
                          value={form.breakReturnDate || ""}
                          onChange={(e) =>
                            setForm({ ...form, breakReturnDate: e.target.value })
                          }
                          max={termEndDate || undefined}
                        />
                        <div className="mt-1 text-[12px] text-neutral-500">
                          Must not be later than the current term.
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* actions */}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      onClick={onClose}
                      className="inline-flex h-9 items-center justify-center rounded-2xl border border-neutral-200 bg-neutral-100 px-4 text-sm text-slate-900 shadow-sm hover:bg-neutral-200/70 active:translate-y-[0.5px]"
                    >
                      Cancel
                    </button>
                    <button
                      disabled={deadlinePassed}
                      onClick={() => {
                        const v = validate();
                        if (v.ok)
                          onDraft({
                            ...form,
                            deloadings: form.noDeloading ? [] : deloadRows,
                          });
                      }}
                      className={cls(
                        "inline-flex h-9 items-center justify-center rounded-2xl px-4 text-sm font-medium shadow active:translate-y-[0.5px]",
                        deadlinePassed
                          ? "cursor-not-allowed bg-orange-200 text-white"
                          : "bg-orange-500 text-white hover:brightness-110"
                      )}
                      title={
                        deadlinePassed
                          ? "Deadline passed — editing locked"
                          : "Save a draft (not final)"
                      }
                    >
                      Save Draft
                    </button>
                    <button
                      disabled={deadlinePassed}
                      onClick={() => {
                        const v = validate();
                        if (v.ok)
                          onSave({
                            ...form,
                            deloadings: form.noDeloading ? [] : deloadRows,
                          });
                      }}
                      className={cls(
                        "inline-flex h-9 items-center justify-center rounded-2xl px-4 text-sm font-medium text-white shadow active:translate-y-[0.5px]",
                        deadlinePassed
                          ? "cursor-not-allowed bg-emerald-300"
                          : "bg-[#1F7A49] hover:brightness-[1.06]"
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
                                    : "border-neutral-300"
                                )}
                                placeholder="Units"
                                value={r.units ?? ""}
                                onChange={(e) => {
                                  const v =
                                    e.target.value === ""
                                      ? null
                                      : Number(e.target.value);
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
                                className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 text-[14px] hover:bg-neutral-100"
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
                            </div>
                          );
                        })}

                        <button
                          type="button"
                          onClick={() =>
                            setDeloadRows((rows) => [
                              ...rows,
                              { type: "Administrative", units: null, detail: "" },
                            ])
                          }
                          className="inline-flex h-9 items-center justify-center rounded-2xl bg-emerald-700 px-4 text-sm text-white shadow hover:brightness-110"
                        >
                          Add Deloading
                        </button>
                      </div>
                    )}
                  </div>

                  {/* actions for 0.0 units */}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      onClick={onClose}
                      className="inline-flex h-9 items-center justify-center rounded-2xl border border-neutral-200 bg-neutral-100 px-4 text-sm text-slate-900 shadow-sm hover:bg-neutral-200/70 active:translate-y-[0.5px]"
                    >
                      Cancel
                    </button>
                    <button
                      disabled={deadlinePassed}
                      onClick={() => {
                        const v = validate();
                        if (v.ok)
                          onDraft({
                            ...form,
                            deloadings: form.noDeloading ? [] : deloadRows,
                          });
                      }}
                      className={cls(
                        "inline-flex h-9 items-center justify-center rounded-2xl px-4 text-sm font-medium shadow active:translate-y-[0.5px]",
                        deadlinePassed
                          ? "cursor-not-allowed bg-orange-200 text-white"
                          : "bg-orange-500 text-white hover:brightness-110"
                      )}
                      title={
                        deadlinePassed
                          ? "Deadline passed — editing locked"
                          : "Save a draft (not final)"
                      }
                    >
                      Save Draft
                    </button>
                    <button
                      disabled={deadlinePassed}
                      onClick={() => {
                        const v = validate();
                        if (v.ok)
                          onSave({
                            ...form,
                            deloadings: form.noDeloading ? [] : deloadRows,
                          });
                      }}
                      className={cls(
                        "inline-flex h-9 items-center justify-center rounded-2xl px-4 text-sm font-medium text-white shadow active:translate-y-[0.5px]",
                        deadlinePassed
                          ? "cursor-not-allowed bg-emerald-300"
                          : "bg-[#1F7A49] hover:brightness-[1.06]"
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
                      <FieldLabel>Preferred Delivery Mode</FieldLabel>
                      <Dropdown
                        value={form.delivery}
                        onChange={(v) => {
                          const nextCampus = autoCampusFor(v);
                          setForm({ ...form, delivery: v, campus: nextCampus });
                        }}
                        options={OPT.delivery}
                        placeholder="— Select Delivery Mode —"
                      />
                    </div>
                    {form.delivery && (
                      <div>
                        <FieldLabel>Campus Preference (auto-set)</FieldLabel>
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
                    <div>
                      <FieldLabel>Preferred Teaching Days</FieldLabel>
                      <div className="grid grid-cols-2 gap-2">
                        {daysMaster.map((d) => (
                          <label key={d} className="flex items-center gap-2 text-[15px]">
                            <input
                              type="checkbox"
                              className="accent-emerald-700"
                              checked={form.days.includes(d)}
                              onChange={() => toggleMulti("days", d)}
                            />
                            {d}
                          </label>
                        ))}
                      </div>
                    </div>

                    <div>
                      <FieldLabel>Preferred Time Slots</FieldLabel>
                      <div className="grid grid-cols-1 gap-1.5">
                        {timeSlotsMaster.map((t) => (
                          <label key={t} className="flex items-center gap-2 text-[15px]">
                            <input
                              type="checkbox"
                              className="accent-emerald-700"
                              checked={form.timeSlots.includes(t)}
                              onChange={() => toggleMulti("timeSlots", t)}
                            />
                            {t}
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* KAC */}
                  <div>
                    <FieldLabel>Knowledge Area Cluster (KAC)</FieldLabel>
                    <MultiSelectDropdown
                      values={form.kac as string[]}
                      onChange={(v) => setForm({ ...form, kac: v })}
                      options={kacDisplayOptions}
                      placeholder="— Select KAC —"
                    />
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
                                    : "border-neutral-300"
                                )}
                                placeholder="Units"
                                value={r.units ?? ""}
                                onChange={(e) => {
                                  const v =
                                    e.target.value === ""
                                      ? null
                                      : Number(e.target.value);
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
                                className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 text-[14px] hover:bg-neutral-100"
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
                            </div>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() =>
                            setDeloadRows((rows) => [
                              ...rows,
                              { type: "Administrative", units: null, detail: "" },
                            ])
                          }
                          className="inline-flex h-9 items-center justify-center rounded-2xl bg-emerald-700 px-4 text-sm text-white shadow hover:brightness-110"
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
                      className="inline-flex h-9 items-center justify-center rounded-2xl border border-neutral-200 bg-neutral-100 px-4 text-sm text-slate-900 shadow-sm hover:bg-neutral-200/70 active:translate-y-[0.5px]"
                    >
                      Cancel
                    </button>
                    <button
                      disabled={deadlinePassed}
                      onClick={() => {
                        const v = validate();
                        if (v.ok)
                          onDraft({
                            ...form,
                            deloadings: form.noDeloading ? [] : deloadRows,
                          });
                      }}
                      className={cls(
                        "inline-flex h-9 items-center justify-center rounded-2xl px-4 text-sm font-medium shadow active:translate-y-[0.5px]",
                        deadlinePassed
                          ? "cursor-not-allowed bg-orange-200 text-white"
                          : "bg-orange-500 text-white hover:brightness-110"
                      )}
                      title={
                        deadlinePassed
                          ? "Deadline passed — editing locked"
                          : "Save a draft (not final)"
                      }
                    >
                      Save Draft
                    </button>
                    <button
                      disabled={deadlinePassed}
                      onClick={() => {
                        const v = validate();
                        if (v.ok)
                          onSave({
                            ...form,
                            deloadings: form.noDeloading ? [] : deloadRows,
                          });
                      }}
                      className={cls(
                        "inline-flex h-9 items-center justify-center rounded-2xl px-4 text-sm font-medium text-white shadow active:translate-y-[0.5px]",
                        deadlinePassed
                          ? "cursor-not-allowed bg-emerald-300"
                          : "bg-[#1F7A49] hover:brightness-[1.06]"
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

        {/* Right column: AE schedule (only when Laguna/Either) */}
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

  // prefs window state (from backend options)
  const [prefsWindow, setPrefsWindow] = useState<{ openISO: string; deadlineISO: string }>({
    openISO: "",
    deadlineISO: "",
  });

  const { past: openPassedPage } = useCountdown(prefsWindow.openISO || "");
  const { past: deadlinePassedPage } = useCountdown(prefsWindow.deadlineISO || "");
  // const editingLocked = !openPassedPage || deadlinePassedPage;

  // 🚫 TEMP: always allow editing so we can test DB updates
  const editingLocked = false;

  const [kacOptions, setKacOptions] = useState<Array<{ kac_id: string; kac_code: string; kac_name: string }>>([]);
  const [daysMaster, setDaysMaster] = useState<string[]>([]);
  const [timeSlotsMaster, setTimeSlotsMaster] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [employmentType, setEmploymentType] = useState<"FT" | "PT">("FT"); // default FT; corrected after fetch

  const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
  const userId = raw.userId || raw.user_id || raw.id;

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
        const [profile, opts] = await Promise.all([
          getFacultyPreferencesProfile(userId),
          getFacultyPreferencesOptions(userId),
        ]);

        setPrefsWindow({
          openISO: opts?.prefs_window?.openISO || "",
          deadlineISO: opts?.prefs_window?.deadlineISO || "",
        });

        setKacOptions((opts?.kacs || []) as any);
        setDaysMaster(
          Array.isArray(opts?.days_display)
            ? opts.days_display
            : ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        );
        setTimeSlotsMaster(
          Array.isArray(opts?.time_slots_display) ? opts.time_slots_display : []
        );

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
        const latest = (list?.preferences || [])[0];
        if (latest) setSaved(fromServerToSaved(latest));
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

  // convert YYYY-MM-DD -> MM/DD/YYYY for backend storage
  const dateISOToMDY = (iso: string) => {
    if (!iso) return "";
    const [yy, mm, dd] = iso.split("-");
    return `${mm}/${dd}/${yy}`;
  };

  const toServerPayload = (v: SavedPrefs, finished: boolean) => {
    const ZERO_LOAD_LABEL = "0.0 units - no teaching load (for full-time only)";
    const onBreak = v.prefUnits === TEACHING_BREAK;
    const isZeroTeachingLoad = v.prefUnits === ZERO_LOAD_LABEL;

    const preferredUnits =
      onBreak || isZeroTeachingLoad ? 0 : parseUnits(v.prefUnits) ?? 0;

    const mapDeload = (r: DeloadRow) => {
      const needsSpecify = r.type === "Administrative" || r.type === "Research";
      const detail = (r.detail || "").trim();
      return {
        deloading_type: r.type,
        units: r.units ?? 0,
        detail: needsSpecify ? detail : "",
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
      notes: v.remarks,
      has_new_prep: false,
      is_finished: finished,

      on_break: onBreak,
      break_reason: onBreak ? v.breakReason : "",
      break_return_date: onBreak ? dateISOToMDY(v.breakReturnDate) : "",
      employment_type: employmentType,
    } as const;
  };

  async function afterSubmitRefresh(res: any) {
    if (res?.ok && res?.preference) {
      const normalized = fromServerToSaved(res.preference);
      setSaved(normalized);
      setOpenEdit(false);
      return;
    }
    throw new Error(res?.detail || "Save failed.");
  }

  const handleSave = async (v: SavedPrefs) => {
    try {
      const payload = toServerPayload(v, true);
      const res = await submitFacultyPreferences(userId, payload);
      await afterSubmitRefresh(res);
    } catch (e: any) {
      alert(e?.response?.data?.detail || e?.message || "Failed to save preferences.");
    }
  };
  const handleDraft = async (v: SavedPrefs) => {
    try {
      const payload = toServerPayload(v, false);
      const res = await submitFacultyPreferences(userId, payload);
      await afterSubmitRefresh(res);
      alert("Draft saved.");
    } catch (e: any) {
      alert(e?.response?.data?.detail || e?.message || "Failed to save draft.");
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
          onDraft={handleDraft}
          openISO={prefsWindow.openISO}
          deadlineISO={prefsWindow.deadlineISO}
          employmentType={employmentType}
          daysMaster={daysMaster}
          timeSlotsMaster={timeSlotsMaster}
          kacDisplayOptions={[...kacOptions].map((k) => k.kac_name).sort((a, b) => a.localeCompare(b))}
        />
      </section>
    );
  }

  /* -------------------- SAVED VIEW -------------------- */
  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
      <DeadlineBanner openISO={prefsWindow.openISO} deadlineISO={prefsWindow.deadlineISO} />

      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-neutral-900">Faculty Preferences</h2>
            <p className="mt-0.5 text-sm text-neutral-500">
              Configure your teaching preferences for the upcoming term
            </p>
          </div>

          <button
            disabled={editingLocked}
            onClick={() => setOpenEdit(true)}
            className={cls(
              "inline-flex h-8 items-center gap-2 rounded-2xl px-3 text-[13px] font-medium text-white shadow",
              editingLocked ? "cursor-not-allowed bg-gray-300 text-gray-600" : "bg-emerald-700 hover:brightness-110"
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

        <div className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-2">
          <div>
            <SectionTitle icon={BookOpen}>Teaching Load</SectionTitle>
            <Row
              label="Preferred Teaching Units"
              value={<Tag tone="gray">{saved.prefUnits || "—"}</Tag>}
            />
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
                      <Tag key={String(k)} tone="blue">
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
    </section>
  );
}

export const PreferencesContent = FACULTY_Preferences;
