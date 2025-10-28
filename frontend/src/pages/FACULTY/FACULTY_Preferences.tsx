// frontend/src/pages/FACULTY/FAC_Preferences.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, MapPin, Monitor, BookOpen, Settings, Plus, X } from "lucide-react";
// ADD
import {
  getFacultyPreferencesProfile,
  getFacultyPreferencesOptions,
  getFacultyPreferencesList,
  submitFacultyPreferences,
} from "../../api";

/* ---------- tiny utils ---------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

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

type SavedPrefs = {
  prefUnits: string;
  maxUnits: string;
  deloadings: DeloadRow[];
  noDeloading: boolean;
  days: string[];
  timeSlots: string[];
  campus: string;
  delivery: string;
  kac: KACKey[];
  courses: string[];
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

// Delivery/Campus -> mode array
function campusNameToId(campus: string | undefined) {
  if (!campus) return null;
  const s = campus.toLowerCase();
  if (s.includes("manila")) return "CMPS0001";
  if (s.includes("laguna")) return "CMPS0002";
  return null;
}
function deliveryToCode(delivery: string | undefined) {
  if (!delivery) return null;
  const s = delivery.toLowerCase();
  if (s.includes("online")) return "ONL";
  if (s.includes("face-to-face") || s.includes("face to face") || s.includes("f2f")) return "F2F";
  if (s.includes("hybrid")) return "HYB";
  return null;
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

/* ===========================
   MAIN COMPONENT
   =========================== */
export default function FAC_Preferences() {
  const [saved, setSaved] = useState<SavedPrefs>(initialSaved);
  const [openEdit, setOpenEdit] = useState(false);
  // ADD inside the component with the rest of useState hooks
  const [kacOptions, setKacOptions] = useState<Array<{kac_id:string; kac_code:string; kac_name:string}>>([]);
  const [loading, setLoading] = useState(true);

  const raw = JSON.parse(localStorage.getItem("animo.user") || "{}");
  const userId = raw.userId || raw.user_id || raw.id;

  const [facultyId, setFacultyId] = useState<string | null>(null);
  // removed unused termId to clear TS6133 warning

  // Manila time deadline placeholder (banner)
  const DEADLINE_ISO = "2025-11-15T17:00:00+08:00";
  const { past: deadlinePassedPage } = useCountdown(DEADLINE_ISO);

  useEffect(() => {
    (async () => {
      if (!userId) { setLoading(false); return; }

      // 1) Load profile (gives faculty_id) and options (KACs, campuses, etc.)
      const [profile, opts] = await Promise.all([
        getFacultyPreferencesProfile(userId),
        getFacultyPreferencesOptions(userId),
      ]);
      setFacultyId(profile?.faculty_id || null);
      setKacOptions((opts?.kacs || []) as any);

      // 2) Load list and take the latest row (server already sorts by submitted_at desc)
      const list = await getFacultyPreferencesList(userId);
      const latest = (list?.preferences || [])[0];

      if (latest) {
        const asArray = Array.isArray(latest.deloading_data) ? latest.deloading_data : (latest.deloading_data ? [latest.deloading_data] : []);
        setSaved({
          prefUnits: String(latest.preferred_units ?? 3),
          maxUnits: "15",
          deloadings: asArray
            .map((d: any) => ({ type: d?.deloading_type ?? "Administrative", units: d?.units != null ? Number(d.units) : null }))
            .filter((x: any) => x.type || x.units != null),
          noDeloading: asArray.length === 0,
          days: expandDays(latest.availability_days ?? []),
          timeSlots: latest.preferred_times ?? [],
          campus: (() => {
            // backend stores single object; we read campus_name when present
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
            if (code === "HYB") return "Hybrid - Any Campus"; // server stores one campus; we’ll map below
            return "Face-to-Face Only";
          })(),
          // IMPORTANT: use kac_name for display
          kac: (latest?.preferred_kacs || []).map((k: any) => k?.kac_name || k?.kac_code || k?.kac_id).filter(Boolean),
          courses: [],
          remarks: latest?.notes ?? "",
        });
      }

      setLoading(false);
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

  const toModeObject = (v: SavedPrefs) => {
    const code = (deliveryToCode(v.delivery) || "F2F").toUpperCase();
    // Online = no campus; others = specific campus_id
    if (code === "ONL") return { mode: "ONL", campus_id: "" };
    if (/laguna/i.test(v.campus)) return { mode: code, campus_id: "CMPS0002" };
    if (/manila/i.test(v.campus)) return { mode: code, campus_id: "CMPS0001" };
    // “Either campus”: pick none for now; server stores a single object
    return { mode: code, campus_id: "" };
  };

  const toServerPayload = (v: SavedPrefs, finished: boolean) => ({
    preferred_units: Number(v.prefUnits),
    availability_days: compressDays(v.days),
    preferred_times: v.timeSlots,
    preferred_kacs: (v.kac || []).map(nameToId),   // send IDs
    mode: toModeObject(v),                         // single object, not array
    notes: v.remarks,
    has_new_prep: false,
    is_finished: finished,
    // term_id optional: backend uses active term if omitted
  });

  const handleSave = async (v: SavedPrefs) => {
    const payload = toServerPayload(v, true);
    const res = await submitFacultyPreferences(userId, payload);
    if (res?.ok) { setSaved(v); setOpenEdit(false); } else { alert("Failed to save preferences. Please try again."); }
  };

  const handleDraft = async (v: SavedPrefs) => {
    const payload = toServerPayload(v, false);
    const res = await submitFacultyPreferences(userId, payload);
    if (res?.ok) { setOpenEdit(false); } else { alert("Failed to save draft. Please try again."); }
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

  /* ---------------------- UI helpers for saved view ---------------------- */
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

  const SectionTitle = ({ icon: Icon, children }: { icon: any; children: React.ReactNode }) => (
    <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-emerald-800">
      <Icon className="h-4 w-4" />
      {children}
    </div>
  );

  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="mb-2">
      <div className="text-[12px] text-neutral-500">{label}</div>
      <div className="mt-1 text-sm text-neutral-900">{value}</div>
    </div>
  );

  const Pills = ({ items }: { items: string[] }) =>
    !items?.length ? (
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

  const DeloadList = ({ rows, none }: { rows: DeloadRow[]; none: boolean }) =>
    none || rows.length === 0 ? (
      <span className="text-neutral-400">None</span>
    ) : (
      <div className="flex flex-col gap-1">
        {rows.map((r, i) => (
          <div key={i} className="text-sm">
            <Tag tone="gray">{r.type}</Tag> <span className="ml-2 text-neutral-600"> </span>
            <Tag tone="gray">{(r.units ?? 0) + " units"}</Tag>
          </div>
        ))}
      </div>
    );

  /* -------------------- EDIT FORM (unchanged wiring) -------------------- */
  function EditForm({
    open,
    onClose,
    initial,
    onSave,
    onDraft,
    deadlineISO,
  }: {
    open: boolean;
    initial: SavedPrefs;
    onClose: () => void;
    onSave: (v: SavedPrefs) => void;
    onDraft: (v: SavedPrefs) => void;
    deadlineISO: string;
  }) {
    if (!open) return null;

    const [form, setForm] = useState<SavedPrefs>(initial);
    const showAE = ["Laguna Campus", "Either Campus"].includes(form.campus);

    const availableCourses = useMemo(
      () => (form.kac.length ? form.kac.flatMap((k) => KAC_COURSES[k as KACKey] ?? []) : []),
      [form.kac]
    );

    useEffect(() => {
      setForm((f) => ({ ...f, courses: f.courses.filter((c) => availableCourses.includes(c)) }));
    }, [availableCourses]);

    function toggleInArray(arr: string[], value: string): string[] {
      return arr.includes(value) ? arr.filter((v: string) => v !== value) : [...arr, value];
    }
    const toggleMulti = (key: "days" | "timeSlots" | "courses", value: string) =>
      setForm((f) => ({ ...f, [key]: toggleInArray(f[key] as string[], value) }));

    const addDeload = () =>
      setForm((f) => ({
        ...f,
        noDeloading: false,
        deloadings: [...f.deloadings, { type: OPT.deloading[0], units: 0 }],
      }));

    const removeDeload = (idx: number) =>
      setForm((f) => ({ ...f, deloadings: f.deloadings.filter((_, i) => i !== idx) }));

    const { past: deadlinePassed } = useCountdown(deadlineISO);

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
                  values={form.kac}
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

            {/* deloading */}
            <div className="grid grid-cols-1 gap-4">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="block text-sm font-medium">Deloading</label>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="accent-emerald-700"
                      checked={form.noDeloading}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          noDeloading: e.target.checked,
                          deloadings: e.target.checked
                            ? []
                            : f.deloadings.length
                            ? f.deloadings
                            : [{ type: OPT.deloading[0], units: 0 }],
                        }))
                      }
                    />
                    I have no deloading
                  </label>
                </div>

                <div className={cls("space-y-2", form.noDeloading && "opacity-60 pointer-events-none")}>
                  {form.deloadings.map((row, i) => (
                    <div key={`${i}-${row.type}`} className="grid grid-cols-[1fr_140px_36px] items-center gap-2">
                      <Dropdown
                        value={row.type}
                        onChange={(v) =>
                          setForm((f) => {
                            const copy = [...f.deloadings];
                            copy[i] = { ...copy[i], type: v };
                            return { ...f, deloadings: copy };
                          })
                        }
                        options={OPT.deloading as unknown as string[]}
                      />
                      <input
                        type="number"
                        min={0}
                        step={1}
                        className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none"
                        placeholder="Units"
                        value={row.units ?? ""}
                        onChange={(e) =>
                          setForm((f) => {
                            const copy = [...f.deloadings];
                            copy[i] = {
                              ...copy[i],
                              units: e.target.value === "" ? null : Number(e.target.value),
                            };
                            return { ...f, deloadings: copy };
                          })
                        }
                      />
                      <button
                        aria-label="Remove"
                        onClick={() => removeDeload(i)}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-neutral-200 bg-neutral-50 text-neutral-700 hover:bg-neutral-100 active:translate-y-[0.5px]"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}

                  <button
                    onClick={addDeload}
                    className="mt-1 inline-flex h-8 items-center gap-2 rounded-[10px] border border-orange-300 bg-orange-50 px-3 text-xs font-medium text-orange-700 hover:bg-orange-100 active:translate-y-[0.5px]"
                  >
                    <Plus className="h-4 w-4" /> Add deloading
                  </button>
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
                onClick={() => onDraft(form)}
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
                onClick={() => onSave(form)}
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

          {/* Right column (reserved) */}
          {showAE && <div className="hidden lg:block" />}
        </div>
      </div>
    );
  }

  if (openEdit) {
    return (
      <section className="mx-auto w-full max-w-screen-2xl px-4">
        <EditForm
          open={true}
          initial={coherentInitial}
          onClose={() => setOpenEdit(false)}
          onSave={handleSave}
          onDraft={handleDraft}
          deadlineISO={DEADLINE_ISO}
        />
      </section>
    );
  }

  /* -------------------- SAVED VIEW — EXACT PLACEMENT LIKE IMAGE -------------------- */
  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
      <DeadlineBanner deadlineISO={DEADLINE_ISO} />

      {/* Single white panel containing everything, with header + top-right button */}
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
            <Row label="Deloading" value={<DeloadList rows={saved.deloadings} none={saved.noDeloading} />} />
            {/* thin divider under teaching load exactly like screenshot */}
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

          {/* Schedule Preferences (left, below divider) */}
          <div>
            <SectionTitle icon={CalendarDays}>Schedule Preferences</SectionTitle>
            <Row label="Preferred Days" value={<Pills items={saved.days} />} />
            <Row label="Preferred Time Slots" value={<Pills items={saved.timeSlots} />} />
          </div>

          {/* Academic Specialization (right, same row as Schedule) */}
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
            <Row label="Preferred Courses" value={<Pills items={saved.courses} />} />
          </div>

          {/* Remarks — full width last row */}
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

// keep alias if other files import it
export const PreferencesContent = FAC_Preferences;
