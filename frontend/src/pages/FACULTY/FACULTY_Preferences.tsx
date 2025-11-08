// frontend/src/pages/FACULTY/FAC_Preferences.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, MapPin, Monitor, BookOpen, Settings } from "lucide-react";
import {
  getFacultyPreferencesProfile,
  getFacultyPreferencesOptions,
  getFacultyPreferencesList,
  submitFacultyPreferences,
} from "../../api";

/* ---------- tiny utils ---------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

/* ---------- tag pill ---------- */
const TAG_STYLES = {
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  gray: "bg-gray-50 text-gray-600 border-gray-200",
} as const;

function Tag({
  children,
  tone = "emerald",
}: {
  children: React.ReactNode;
  tone?: keyof typeof TAG_STYLES;
}) {
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

/* ---------- multi-select Dropdown ---------- */
function MultiSelectDropdown({
  values,
  onChange,
  options,
  className = "w-full",
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

  const toggle = (opt: string) =>
    onChange(values.includes(opt) ? values.filter((v) => v !== opt) : [...values, opt]);

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
        className={cls(
          "w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-3 pr-10 text-left text-sm shadow-sm outline-none",
          "hover:bg-gray-50 focus:ring-2 focus:ring-emerald-500/30"
        )}
      >
        {label}
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">▾</span>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-20 mt-2 max-h-80 w-full overflow-auto rounded-2xl border border-gray-300 bg-white shadow-lg"
        >
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
                  "flex w-full items-center gap-3 px-4 py-3 text-left text-sm",
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
              <button
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

/* ---------- single Dropdown ---------- */
function Dropdown({
  value,
  onChange,
  options,
  className = "w-full",
  placeholder = "— Select an option —",
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

  useEffect(
    () => setHover(Math.max(0, options.findIndex((o) => o === value))),
    [value, options]
  );
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
        className={cls(
          "w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-3 pr-10 text-left text-sm shadow-sm outline-none",
          "hover:bg-gray-50 focus:ring-2 focus:ring-emerald-500/30"
        )}
      >
        {value || <span className="text-gray-400">{placeholder}</span>}
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">▾</span>
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-20 mt-2 max-h-80 w-full overflow-auto rounded-2xl border border-gray-300 bg-white shadow-lg"
        >
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
              className={cls(
                "block w-full px-4 py-3 text-left text-sm",
                i === hover && "bg-emerald-50"
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

/* ---------- KAC → courses map ---------- */
type KACKey =
  | "Computer Architecture & Organization"
  | "Computational Thinking"
  | "Computing Ethics"
  | "CS Math"
  | "Data Structures, Algorithms, Complexity, Automata Theory"
  | "Information And Network Security"
  | "Information Management And Databases"
  | "Intelligent Systems (AI/ML)"
  | "Network Communications And Cloud Computing"
  | "Object Oriented Programming And Software Design"
  | "OS & Parallel/Distributed Computing"
  | "Procedural Programming"
  | "Research Methods, Technopreneurship & Innovation"
  | "Software Engineering & UI/UX"
  | "Theory Of Programming Languages And Compilers"
  | "Web And Mobile Development";

const KAC_COURSES: Record<KACKey, string[]> = {
  "Computer Architecture & Organization": [
    "CCICOMP",
    "CSARCH1/2",
    "LBYARCH",
    "CEPARCO",
    "ITCMSY1/2",
    "LBYCMSY",
    "Electives",
  ],
  "Computational Thinking": ["EMTC1CT", "IECMPTK"],
  "Computing Ethics": [
    "CS RESEARCH ETHICS",
    "Data Privacy And Security",
    "Informed Consent And Data Usage",
    "Algorithmic Bias And Fairness",
    "Ethical Data Sharing And Collaboration",
  ],
  "CS Math": ["CCDSTRU", "CSMODEL", "GD-MATH", "CE-MATH"],
  "Data Structures, Algorithms, Complexity, Automata Theory": [
    "CCDSALG",
    "GDDASGO",
    "CSALGCM",
    "STALGCM",
  ],
  "Information And Network Security": [
    "CSSECUR",
    "CSSECDV",
    "ISSECUR",
    "ITSECUR",
    "ITSECWB",
    "NSSECU1/2/3",
  ],
  "Information Management And Databases": ["CCINFOM", "GDINFMG", "STADVDB", "ISINFOM", "ISPRENL"],
  "Intelligent Systems (AI/ML)": ["CSINTSY", "STINTSY", "GDINTAI", "MACHLRN"],
  "Network Communications And Cloud Computing": [
    "NSCOM01/2/3",
    "ITNET01/2/3/4",
    "LBYNET1/2/3/4",
    "CSNETWK",
    "GDNETWK",
    "ITSYSAD",
    "CLOUDCO",
    "STCLOUD",
  ],
  "Object Oriented Programming And Software Design": ["CCPROG3", "GDPROG3", "DSGNPAT"],
  "OS & Parallel/Distributed Computing": ["CSOPESY", "STDISCM", "NSDSYST", "NSAPDEV"],
  "Procedural Programming": ["CCPROG1", "CCPROG2", "GDPROG1", "GDPROG2", "MTPROG1", "MTPROG2"],
  "Research Methods, Technopreneurship & Innovation": [
    "STMETRE",
    "CCINOV8",
    "CAP-IE1",
    "CAP-IE2",
    "CAP-IE3",
    "CERESME",
    "NERESME",
  ],
  "Software Engineering & UI/UX": ["CSSWENG", "STSWENG", "STHCIUX", "ITISHCI", "IEUI-UX"],
  "Theory Of Programming Languages And Compilers": ["CSADPRG", "COMPILE", "CMPILER"],
  "Web And Mobile Development": [
    "CCAPDEV",
    "MOBDEVE",
    "MOBICOM",
    "ITISDEV",
    "ITISSES",
    "IT-PROG",
    "Web/Mobile Electives",
  ],
};

const KAC_OPTIONS = Object.keys(KAC_COURSES) as KACKey[];

/* ---------- option lists ---------- */
const OPT = {
  prefUnits: ["3", "6", "9", "12", "15"],
  maxUnits: ["12", "15", "18"],
  delivery: [
    "Face-to-Face Only",
    "Fully Online",
    "Hybrid - Manila Campus Only",
    "Hybrid - Laguna Campus Only",
    "Hybrid - Any Campus",
  ],
  campus: ["Manila Campus", "Laguna Campus", "Either Campus"],
  days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  timeSlots: [
    "07:30 - 09:00",
    "09:15 - 10:45",
    "11:00 - 12:30",
    "12:45 - 14:15",
    "14:30 - 16:00",
    "16:15 - 17:45",
    "18:00 - 19:30",
    "19:45 - 21:00",
  ],
  deloading: [
    "Administrative",
    "Commisioned-work",
    "Curriculum & Instruction",
    "Graduate Studies",
    "Research",
  ],
} as const;

/* ---------- types & local state ---------- */
type DeloadRow = { type: string; units: number | null };

/* NEW: define the missing types used by the editor */
type DeloadingType = "Administrative" | "Research" | "Others";

type DeloadingEntry = {
  id: string;
  type: DeloadingType | "";
  units: number | null;
  adminSubtype?: string;
  otherText?: string;
  researchRemarks?: string;
};

type SavedPrefs = {
  prefUnits: string;
  maxUnits: string;
  deloadings: DeloadRow[];
  noDeloading: boolean;
  days: string[];
  timeSlots: string[];
  campus: string;
  delivery: string;
  kac: KACKey[] | string[];
  courses: string[]; // ← now persisted via preferred_courses
  remarks: string;
};

const initialSaved: SavedPrefs = {
  prefUnits: "3",
  maxUnits: "15",
  deloadings: [],
  noDeloading: true,
  days: [],
  timeSlots: [],
  campus: "Either Campus",
  delivery: "Face-to-Face Only",
  kac: [],
  courses: [],
  remarks: "",
};

/* ---------- helpers to map UI <-> DB ---------- */
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
  const letters = days.map((d) => DAY_TO_LETTER[d]).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const out: string[] = [];
  let buf: string[] = [];
  const isAdj = (a: string, b: string) => order.indexOf(b) - order.indexOf(a) === 1;
  for (let i = 0; i < letters.length; i++) {
    if (buf.length === 0) buf.push(letters[i]);
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

/* ---------- countdown hook ---------- */
function useCountdown(targetISO: string) {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const target = new Date(targetISO).getTime();
  const diff = Math.max(0, target - now);
  const past = now > target;
  const d = Math.floor(diff / (1000 * 60 * 60 * 24));
  const h = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const m = Math.floor((diff / (1000 * 60)) % 60);
  const s = Math.floor((diff / 1000) % 60);
  const label = past ? "Deadline passed" : `${d}d ${h}h ${m}m ${s}s`;
  return { past, label };
}

/* ---------- top-level components that must NOT remount ---------- */
function DeadlineBanner({ deadlineISO, className }: { deadlineISO: string; className?: string }) {
  const { past, label } = useCountdown(deadlineISO);
  return (
    <div
      className={cls(
        "mb-4 flex items-start gap-3 rounded-xl border p-4",
        past ? "border-red-300 bg-red-50 text-red-800" : "border-amber-300 bg-amber-50 text-amber-900",
        className
      )}
    >
      <div className={cls("mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full", past ? "bg-red-500" : "bg-amber-500")} />
      <div className="text-sm">
        <div className="font-semibold">{past ? "Editing Locked" : "Submission Deadline Approaching"}</div>
        <div className="mt-0.5">
          Deadline: <span className="font-medium">{new Date(deadlineISO).toLocaleString()}</span>
          {" • "}
          <span className={cls("font-bold", past ? "text-red-700" : "text-amber-700")}>{label}</span>
        </div>
        {!past && <div className="mt-1 text-[12px] opacity-80">Please finalize before the deadline. Drafts are allowed until lock.</div>}
      </div>
    </div>
  );
}

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

/* ---------- AE Line 1 Schedule (same as old file) ---------- */
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
            const L = get(ML, i);
            const R = get(LM, i);
            return (
              <tr key={i} className="odd:bg-white even:bg-neutral-50">
                <td className="border-t border-r border-neutral-300 px-2 py-1.5 align-top text-center">{L.trip || "\u00A0"}</td>
                <td className="border-t border-r border-neutral-300 px-2 py-1.5 align-top text-center">{L.etd || "\u00A0"}</td>
                <td className="border-t border-r border-neutral-300 px-2 py-1.5 align-top text-center">{R.trip || "\u00A0"}</td>
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
   EDIT FORM (top-level)
   =========================== */
function EditForm({
  initial,
  onClose,
  onSave,
  onDraft,
  deadlineISO,
}: {
  initial: SavedPrefs;
  onClose: () => void;
  onSave: (v: SavedPrefs) => void;
  onDraft: (v: SavedPrefs) => void;
  deadlineISO: string;
}) {
  const [form, setForm] = useState<SavedPrefs>(initial);
  const { past: deadlinePassed } = useCountdown(deadlineISO);

  // ---------- Deloading (rich UI) local state ----------
  const [deloadingEntries, setDeloadingEntries] = useState<DeloadingEntry[]>(
    () =>
      form.noDeloading
        ? []
        : (form.deloadings || []).map((d, i) => ({
            id: `d${i + 1}`,
            type: (d.type as DeloadingType) || "",
            units: d.units ?? null,
          }))
  );

  const [deloadErrors, setDeloadErrors] = useState<Record<string, string>>({});
  const setRowError = (id: string, msg: string) =>
    setDeloadErrors((prev) => (msg ? { ...prev, [id]: msg } : (({ [id]: _, ...rest }) => rest)(prev)));

  const isOtherish = (t: DeloadingType | "") => t === "Others";

  const addDeloading = () =>
    setDeloadingEntries((rows) => [
      ...rows,
      { id: crypto.randomUUID(), type: "", units: null, adminSubtype: "", otherText: "" },
    ]);

  const updateDeloading = (id: string, patch: Partial<DeloadingEntry>) =>
    setDeloadingEntries((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const removeDeloading = (id: string) => {
    setDeloadingEntries((rows) => rows.filter((r) => r.id !== id));
    setRowError(id, "");
  };

  const validateDeloading = () => {
    const next: Record<string, string> = {};
    for (const d of deloadingEntries) {
      if (!d.type) next[d.id] = "Please select a deloading type.";
      if (isOtherish(d.type) && !d.otherText?.trim())
        next[d.id] = (next[d.id] ? next[d.id] + " " : "") + "Please specify the ‘Other’ deloading type.";
      if (d.type === "Administrative" && !d.adminSubtype?.trim())
        next[d.id] = (next[d.id] ? next[d.id] + " " : "") + "Please specify the Admin Deloading Type.";
      if (d.units == null || Number.isNaN(d.units))
        next[d.id] = (next[d.id] ? next[d.id] + " " : "") + "Units are required.";
      else if (d.type === "Research" && (d.units < 0 || d.units > 9))
        next[d.id] = (next[d.id] ? next[d.id] + " " : "") + "Research units must be between 0 and 9.";
      else if (d.units < 0)
        next[d.id] = (next[d.id] ? next[d.id] + " " : "") + "Units cannot be negative.";
    }
    setDeloadErrors(next);
    return Object.keys(next).length === 0;
  };

  // convert richer UI entries -> simple {type, units} array for payload
  const materializeDeloadings = () =>
    form.noDeloading
      ? []
      : deloadingEntries
          .filter((d) => d.type && d.units != null)
          .map((d) => ({ type: d.type, units: d.units ?? 0 }));

  const availableCourses = useMemo(
    () => (form.kac.length ? form.kac.flatMap((k) => KAC_COURSES[k as KACKey] ?? []) : []),
    [form.kac]
  );

  useEffect(() => {
    setForm((f) => ({ ...f, courses: f.courses.filter((c) => availableCourses.includes(c)) }));
  }, [availableCourses]);

  function toggleInArray(arr: string[], value: string): string[] {
    return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
  }
  const toggleMulti = (key: "days" | "timeSlots" | "courses", value: string) =>
    setForm((f) => ({ ...f, [key]: toggleInArray(f[key] as string[], value) }));

  // NOTE: previously this added a blank right column. Removed — no space unless we actually render AE content.
  const showAE = ["Laguna Campus", "Either Campus"].includes(form.campus);

  return (
    <div className="w-full">
      <div className="mb-4">
        <h3 className="text-lg font-bold text-neutral-900">Edit Faculty Preferences</h3>
        <p className="text-sm text-neutral-500">Update your teaching preferences for the upcoming term</p>
      </div>

      <DeadlineBanner deadlineISO={deadlineISO} />

      <div className={cls("grid grid-cols-1 gap-6", showAE && "lg:grid-cols-[1fr_minmax(200px,400px)]")}>
        {/* Left column */}
        <div className="space-y-5 rounded-xl border border-neutral-200 bg-white p-5">
          {/* units */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Preferred Teaching Units</label>
              <Dropdown
                value={form.prefUnits}
                onChange={(v) => setForm({ ...form, prefUnits: v })}
                options={OPT.prefUnits}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Maximum Teaching Units</label>
              <Dropdown
                value={form.maxUnits}
                onChange={(v) => setForm({ ...form, maxUnits: v })}
                options={OPT.maxUnits}
              />
            </div>
          </div>

          {/* days + time */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Preferred Teaching Days</label>
              <div className="grid grid-cols-2 gap-2">
                {OPT.days.map((d) => (
                  <label key={d} className="flex items-center gap-2 text-sm">
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
              <label className="mb-1 block text-sm font-medium">Preferred Time Slots</label>
              <div className="grid grid-cols-1 gap-1.5">
                {OPT.timeSlots.map((t) => (
                  <label key={t} className="flex items-center gap-2 text-sm">
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

          {/* mode & campus */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Preferred Delivery Mode</label>
              <Dropdown
                value={form.delivery}
                onChange={(v) => setForm({ ...form, delivery: v })}
                options={OPT.delivery}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Campus Preference</label>
              <Dropdown
                value={form.campus}
                onChange={(v) => setForm({ ...form, campus: v })}
                options={OPT.campus}
              />
            </div>
          </div>

          {/* KAC & courses */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Knowledge Area Cluster (KAC)</label>
              <MultiSelectDropdown
                values={form.kac as string[]}
                onChange={(v) => setForm({ ...form, kac: v as KACKey[] })}
                options={KAC_OPTIONS}
                placeholder="— Select one or more KACs —"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Preferred Courses</label>
              <div className="grid grid-cols-1 gap-1.5">
                {(availableCourses.length ? availableCourses : ["— Choose a KAC first —"]).map((c) => (
                  <label key={c} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="accent-emerald-700"
                      disabled={!availableCourses.includes(c)}
                      checked={form.courses.includes(c)}
                      onChange={() => toggleMulti("courses", c)}
                    />
                    {c}
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Deloading (rich UI -> saved as {type, units}) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium">Deloading</label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-emerald-700"
                  checked={form.noDeloading}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, noDeloading: e.target.checked }));
                    if (e.target.checked) {
                      setDeloadingEntries([]);
                      setDeloadErrors({});
                    }
                  }}
                />
                I have no deloading
              </label>
            </div>

            <div className="rounded-xl border border-neutral-200">
              <div className="flex items-center justify-between border-b border-neutral-200 p-3">
                <div className="text-sm text-neutral-600">
                  Add entries for each deloading type you have (Administrative, Research, Others).
                </div>
                <button
                  type="button"
                  disabled={form.noDeloading}
                  onClick={addDeloading}
                  className={cls(
                    "inline-flex h-8 items-center justify-center rounded-[10px] px-3 text-sm shadow",
                    form.noDeloading ? "bg-neutral-200 text-neutral-500 cursor-not-allowed" : "bg-emerald-700 text-white hover:brightness-110"
                  )}
                >
                  Add Deloading
                </button>
              </div>

              <div className="divide-y divide-neutral-200">
                {deloadingEntries.length === 0 && !form.noDeloading && (
                  <div className="p-4 text-sm text-neutral-500">No deloading entries yet.</div>
                )}

                {deloadingEntries.map((d) => {
                  const err = deloadErrors[d.id];
                  const isResearch = d.type === "Research";
                  const showAdminSubtype = d.type === "Administrative";
                  const showOtherText = d.type === "Others";
                  return (
                    <div key={d.id} className="p-4">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                        {/* Type */}
                        <div className="sm:col-span-4">
                          <label className="mb-1 block text-sm font-medium">
                            Type <span className="text-red-600">*</span>
                          </label>
                          <Dropdown
                            value={d.type}
                            onChange={(v) => {
                              const t = v as DeloadingType;
                              updateDeloading(d.id, {
                                type: t,
                                adminSubtype: t === "Administrative" ? (d.adminSubtype ?? "") : "",
                                otherText: isOtherish(t) ? (d.otherText ?? "") : "",
                                researchRemarks: t === "Research" ? (d.researchRemarks ?? "") : "",
                              });
                              setRowError(d.id, "");
                            }}
                            options={["Administrative", "Research", "Others"]}
                          />
                        </div>

                        {/* Detail column */}
                        <div className="sm:col-span-4">
                          {showAdminSubtype && (
                            <>
                              <label className="mb-1 block text-sm font-medium">
                                Admin Deloading Type <span className="text-red-600">*</span>
                              </label>
                              <input
                                type="text"
                                className={cls(
                                  "w-full rounded-xl border bg-white px-3 py-2.5 text-sm shadow-sm outline-none",
                                  err ? "border-red-300" : "border-neutral-300"
                                )}
                                placeholder="e.g., Program Chair, Coordinator"
                                value={d.adminSubtype ?? ""}
                                onChange={(e) => {
                                  updateDeloading(d.id, { adminSubtype: e.target.value });
                                  setRowError(d.id, "");
                                }}
                              />
                            </>
                          )}

                          {showOtherText && (
                            <>
                              <label className="mb-1 block text-sm font-medium">
                                Specify <span className="text-red-600">*</span>
                              </label>
                              <input
                                type="text"
                                className={cls(
                                  "w-full rounded-xl border bg-white px-3 py-2.5 text-sm shadow-sm outline-none",
                                  err ? "border-red-300" : "border-neutral-300"
                                )}
                                placeholder="Describe the deloading type"
                                value={d.otherText ?? ""}
                                onChange={(e) => {
                                  updateDeloading(d.id, { otherText: e.target.value });
                                  setRowError(d.id, "");
                                }}
                              />
                            </>
                          )}

                          {isResearch && (
                            <>
                              <label className="mb-1 block text-sm font-medium">Research Remarks</label>
                              <input
                                type="text"
                                className={cls(
                                  "w-full rounded-xl border bg-white px-3 py-2.5 text-sm shadow-sm outline-none",
                                  err ? "border-red-300" : "border-neutral-300"
                                )}
                                placeholder="e.g., Project name or focus"
                                value={d.researchRemarks ?? ""}
                                onChange={(e) => {
                                  updateDeloading(d.id, { researchRemarks: e.target.value });
                                  setRowError(d.id, "");
                                }}
                              />
                            </>
                          )}

                          {!showAdminSubtype && !showOtherText && !isResearch && (
                            <div className="h-[40px] sm:h-[42px]" aria-hidden />
                          )}
                        </div>

                        {/* Units */}
                        <div className="sm:col-span-3">
                          <label className="mb-1 block text-sm font-medium">
                            Units <span className="text-red-600">*</span>
                          </label>
                          <input
                            type="number"
                            min={0}
                            max={isResearch ? 9 : undefined}
                            step={1}
                            className={cls(
                              "w-full rounded-xl border bg-white px-3 py-2.5 text-sm shadow-sm outline-none",
                              err ? "border-red-300" : "border-neutral-300"
                            )}
                            placeholder="Enter units"
                            value={d.units ?? ""}
                            onChange={(e) => {
                              const val = e.target.value === "" ? null : Number(e.target.value);
                              updateDeloading(d.id, { units: val });
                              if (val == null) setRowError(d.id, "");
                              else if (isResearch && (val < 0 || val > 9)) setRowError(d.id, "Research units must be between 0 and 9.");
                              else if (val < 0) setRowError(d.id, "Units cannot be negative.");
                              else setRowError(d.id, "");
                            }}
                          />
                        </div>

                        {/* Remove */}
                        <div className="sm:col-span-1">
                          <label className="mb-1 block text-sm font-medium invisible">Remove</label>
                          <div className="flex items-center justify-end">
                            <button
                              type="button"
                              onClick={() => removeDeloading(d.id)}
                              className="inline-flex h-9 items-center justify-center rounded-[10px] border border-neutral-200 bg-neutral-50 px-3 text-sm hover:bg-neutral-100"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      </div>

                      {err && <div className="mt-2 text-sm text-red-600">{err}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* remarks */}
          <div>
            <label className="mb-1 block text-sm font-medium">Special Remarks</label>
            <textarea
              rows={4}
              className="w-full resize-y rounded-xl border border-neutral-300 p-2 text-sm"
              placeholder="Any special circumstances, research project name, or any additional information…"
              value={form.remarks}
              onChange={(e) => setForm({ ...form, remarks: e.target.value })}
            />
          </div>

          {/* actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="inline-flex h-9 items-center justify-center rounded-xl border border-neutral-200 bg-neutral-100 px-4 text-sm text-slate-900 shadow-sm hover:bg-neutral-200/70 active:translate-y-[0.5px]"
            >
              Cancel
            </button>
            <button
              disabled={deadlinePassed}
              onClick={() => {
                if (!form.noDeloading && !validateDeloading()) return;
                onDraft({ ...form, deloadings: materializeDeloadings() });
              }}
              className={cls(
                "inline-flex h-9 items-center justify-center rounded-xl px-4 text-sm font-medium shadow active:translate-y-[0.5px]",
                deadlinePassed ? "cursor-not-allowed bg-orange-200 text-white" : "bg-orange-500 text-white hover:brightness-110"
              )}
              title={deadlinePassed ? "Deadline passed — editing locked" : "Save a draft (not final)"}
            >
              Save Draft
            </button>
            <button
              disabled={deadlinePassed}
              onClick={() => {
                if (!form.noDeloading && !validateDeloading()) return;
                onSave({ ...form, deloadings: materializeDeloadings() });
              }}
              className={cls(
                "inline-flex h-9 items-center justify-center rounded-xl px-4 text-sm font-medium text-white shadow active:translate-y-[0.5px]",
                deadlinePassed ? "cursor-not-allowed bg-emerald-300" : "bg-[#1F7A49] hover:brightness-[1.06]"
              )}
              title={deadlinePassed ? "Deadline passed — editing locked" : "Save and finalize"}
            >
              Save Preferences
            </button>
          </div>
        </div>

        {showAE && (
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
export default function FAC_Preferences() {
  const [saved, setSaved] = useState<SavedPrefs>(initialSaved);
  const [openEdit, setOpenEdit] = useState(false);
  const [kacOptions, setKacOptions] = useState<Array<{kac_id:string; kac_code:string; kac_name:string}>>([]);
  const [loading, setLoading] = useState(true);

  const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
  const userId = raw.userId || raw.user_id || raw.id;

  // const [facultyId, setFacultyId] = useState<string | null>(null); // not used in UI
  const DEADLINE_ISO = "2025-11-15T17:00:00+08:00";
  const { past: deadlinePassedPage } = useCountdown(DEADLINE_ISO);

  // convert server response -> SavedPrefs
  function fromServerToSaved(latest: any): SavedPrefs {
    const deloadArr = Array.isArray(latest?.deloading_data)
      ? latest.deloading_data
      : latest?.deloading_data
      ? [latest.deloading_data]
      : [];
    return {
      prefUnits: String(latest?.preferred_units ?? 3),
      maxUnits: "15",
      deloadings: deloadArr
        .map((d: any) => ({
          type: d?.deloading_type ?? "Administrative",
          units: d?.units != null ? Number(d.units) : null,
        }))
        .filter((x: any) => x.type || x.units != null),
      noDeloading: deloadArr.length === 0,
      days: expandDays(latest?.availability_days ?? []),
      timeSlots: Array.isArray(latest?.preferred_times) ? latest.preferred_times : [],
      campus: (() => {
        const cname = latest?.mode?.campus_name;
        if (!cname) return "Either Campus";
        if (/manila/i.test(cname)) return "Manila Campus";
        if (/laguna/i.test(cname)) return "Laguna Campus";
        return "Either Campus";
      })(),
      delivery: (() => {
        const code = String(latest?.mode?.mode || "").toUpperCase();
        if (code === "ONL") return "Fully Online";
        if (code === "F2F") return "Face-to-Face Only";
        if (code === "HYB") return "Hybrid - Any Campus";
        return "Face-to-Face Only";
      })(),
      kac: (latest?.preferred_kacs || [])
        .map((k: any) => k?.kac_name || k?.kac_code || k?.kac_id)
        .filter(Boolean),
      // NEW: preferred_courses from server -> saved.courses
      courses: Array.isArray(latest?.preferred_courses) ? latest.preferred_courses : [],
      remarks: latest?.notes ?? "",
    };
  }

  useEffect(() => {
    (async () => {
      try {
        if (!userId) { setLoading(false); return; }
        const [profile, opts] = await Promise.all([
          getFacultyPreferencesProfile(userId),
          getFacultyPreferencesOptions(userId),
        ]);
        // setFacultyId(profile?.faculty_id || null);
        setKacOptions((opts?.kacs || []) as any);

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

  const coherentInitial: SavedPrefs = useMemo(
    () => ({
      ...saved,
      courses:
        saved.courses.length && saved.kac.length
          ? saved.courses
          : saved.kac.length
          ? [KAC_COURSES[(saved.kac[0] as KACKey) as keyof typeof KAC_COURSES]?.[0] ?? ""].filter(Boolean)
          : [],
    }),
    [saved]
  );

  const nameToId = (name: string) => {
    const hit = kacOptions.find(k => (k.kac_name || "").toLowerCase() === name.toLowerCase());
    return hit?.kac_id || name; // fallback
  };

  const deliveryToCode = (delivery: string | undefined) => {
    if (!delivery) return null;
    const s = delivery.toLowerCase();
    if (s.includes("online")) return "ONL";
    if (s.includes("face-to-face") || s.includes("face to face") || s.includes("f2f")) return "F2F";
    if (s.includes("hybrid")) return "HYB";
    return null;
  };

  const toModeObject = (v: SavedPrefs) => {
    const code = (deliveryToCode(v.delivery) || "F2F").toUpperCase();
    if (code === "ONL") return { mode: "ONL", campus_id: "" };
    if (/laguna/i.test(v.campus)) return { mode: code, campus_id: "CMPS0002" };
    if (/manila/i.test(v.campus)) return { mode: code, campus_id: "CMPS0001" };
    return { mode: code, campus_id: "" };
  };

  const toServerPayload = (v: SavedPrefs, finished: boolean) => ({
    preferred_units: Number(v.prefUnits),
    availability_days: compressDays(v.days),
    preferred_times: v.timeSlots,
    preferred_kacs: (v.kac || []).map(nameToId),     // send IDs
    preferred_courses: v.courses,                    // NEW: persist courses
    deloading_data: v.noDeloading
      ? []
      : (v.deloadings || [])
          .filter((r) => r && r.type)
          .map((r) => ({ deloading_type: r.type, units: r.units ?? 0 })), // NEW: persist deloading
    mode: toModeObject(v),                           // single object
    notes: v.remarks,
    has_new_prep: false,
    is_finished: finished,
  });

  // CHANGE: Always refresh the Saved panel — even on drafts.
  async function afterSubmitRefresh(res: any, _isFinal: boolean) {
    if (res?.ok && res?.preference) {
      const normalized = fromServerToSaved(res.preference);
      setSaved(normalized);          // ← update Saved panel for both Draft and Submit
      setOpenEdit(false);            // close editor
      return;
    }
    throw new Error(res?.detail || "Save failed.");
  }

  const handleSave = async (v: SavedPrefs) => {
    try {
      const payload = toServerPayload(v, true);
      const res = await submitFacultyPreferences(userId, payload);
      await afterSubmitRefresh(res, true); // SUBMIT
    } catch (e: any) {
      alert(e?.response?.data?.detail || e?.message || "Failed to save preferences.");
    }
  };

  const handleDraft = async (v: SavedPrefs) => {
    try {
      const payload = toServerPayload(v, false);
      const res = await submitFacultyPreferences(userId, payload);
      await afterSubmitRefresh(res, false); // DRAFT now also refreshes Saved panel
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
          deadlineISO={DEADLINE_ISO}
        />
      </section>
    );
  }

  /* -------------------- SAVED VIEW -------------------- */
  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
      <DeadlineBanner deadlineISO={DEADLINE_ISO} />

      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        {/* header row */}
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-neutral-900">Faculty Preferences</h2>
            <p className="mt-0.5 text-sm text-neutral-500">
              Configure your teaching preferences for the upcoming term
            </p>
          </div>

          <button
            disabled={deadlinePassedPage}
            onClick={() => setOpenEdit(true)}
            className={cls(
              "inline-flex h-8 items-center gap-2 rounded-xl px-3 text-[13px] font-medium text-white shadow",
              deadlinePassedPage ? "cursor-not-allowed bg-emerald-300" : "bg-emerald-700 hover:brightness-110"
            )}
            title={deadlinePassedPage ? "Deadline passed — editing locked" : "Edit preferences"}
          >
            <Settings className="h-4 w-4" />
            Edit Preferences
          </button>
        </div>

        {/* two-column sections */}
        <div className="grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-2">
          {/* Teaching Load (left) */}
          <div>
            <SectionTitle icon={BookOpen}>Teaching Load</SectionTitle>
            <Row label="Preferred Teaching Units" value={<Tag tone="gray">{saved.prefUnits} units</Tag>} />
            <Row label="Maximum Teaching Units" value={<Tag tone="gray">{saved.maxUnits} units</Tag>} />
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

          {/* Location & Mode (right) */}
          <div>
            <SectionTitle icon={MapPin}>Location &amp; Mode</SectionTitle>
            <Row label="Campus Preference" value={<Tag tone="gray">{saved.campus || "—"}</Tag>} />
            <Row
              label="Delivery Mode"
              value={
                saved.delivery ? <Tag tone="gray">{saved.delivery}</Tag> : <span className="text-neutral-400">—</span>
              }
            />
            <div className="mt-3 border-b border-transparent lg:border-b-0" />
          </div>

          {/* Schedule Preferences */}
          <div>
            <SectionTitle icon={CalendarDays}>Schedule Preferences</SectionTitle>
            <Row label="Preferred Days" value={<Pills items={saved.days} />} />
            <Row label="Preferred Time Slots" value={<Pills items={saved.timeSlots} />} />
          </div>

          {/* Academic Specialization */}
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
            {/* NEW: saved.courses now shown */}
            <Row label="Preferred Courses" value={<Pills items={saved.courses} />} />
          </div>

          {/* Remarks */}
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

export const PreferencesContent = FAC_Preferences;
