import React, { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, MapPin, Monitor, BookOpen, Settings } from "lucide-react";

/* ---------- tiny utils (same style as FAC_History) ---------- */
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

/* ---------- multi-select Dropdown (same styling) ---------- */
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
  options: readonly string[];   // ← change this line
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
    values.length === 0
      ? <span className="text-gray-400">{placeholder}</span>
      : values.length <= maxPreview
      ? values.join(", ")
      : `${values.slice(0, maxPreview).join(", ")} +${values.length - maxPreview} more`;

  const onKey = (e: React.KeyboardEvent) => {
    if (!open && ["ArrowDown", "Enter", " "].includes(e.key)) {
      e.preventDefault(); setOpen(true); return;
    }
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); btnRef.current?.focus(); }
    if (e.key === "ArrowDown") { e.preventDefault(); setHover((i) => (i + 1) % options.length); }
    if (e.key === "ArrowUp") { e.preventDefault(); setHover((i) => (i - 1 + options.length) % options.length); }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(options[hover]); }
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


/* ---------- local Dropdown (copied from History/Overview for consistency) ---------- */
function Dropdown({
  value,
  onChange,
  options,
  className = "w-full",
  placeholder = "— Select an option —",
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];   // ← change this line
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
              className={cls("block w-full px-4 py-3 text-left text-sm", i === hover && "bg-emerald-50")}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- KAC → courses map (display text follows your rules) ---------- */
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
  "Data Structures, Algorithms, Complexity, Automata Theory": ["CCDSALG", "GDDASGO", "CSALGCM", "STALGCM"],
  "Information And Network Security": ["CSSECUR", "CSSECDV", "ISSECUR", "ITSECUR", "ITSECWB", "NSSECU1/2/3"],
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
  "Web And Mobile Development": ["CCAPDEV", "MOBDEVE", "MOBICOM", "ITISDEV", "ITISSES", "IT-PROG", "Web/Mobile Electives"],
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
  // ⬇︎ 24-hour format
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
    "I have no deloading",
  ],
} as const;


/* ---------- types & initial saved state (placeholders) ---------- */
type SavedPrefs = {
  prefUnits: string;
  maxUnits: string;
  deloading: string[];           // CHANGED: array (multi-select)
  deloadUnits: number | null;    // CHANGED: number input (nullable)
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
  deloading: ["Administrative"],
  deloadUnits: 3,
  days: ["Tuesday", "Friday", "Saturday"],
  // ⬇︎ 24-hour slots
  timeSlots: ["07:30 - 09:00", "12:45 - 14:15"],
  campus: "Manila Campus",
  delivery: "Face-to-Face Only",
  kac: ["Object Oriented Programming And Software Design"],
  courses: ["CCPROG1"],
  remarks: "I prefer all classes to be in Gokongwei",
};


/* ---------- small helpers ---------- */
const ChipRow = ({ items }: { items: React.ReactNode[] }) => (
  <div className="flex flex-wrap gap-2">{items.map((c, i) => <Tag key={i} tone="gray">{c}</Tag>)}</div>
);

/* ---------- AE Line 1 Schedule (table, not an image) ---------- */
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
      {/* green banner header – smaller text */}
      <div className="bg-emerald-700 px-3 py-2 text-center font-semibold text-white">
        <div className="text-xs font-bold leading-tight">DLSU – Laguna Campus</div>
        <div className="mt-1 inline-block rounded px-2 py-0.5 text-[10px] font-extrabold tracking-wide bg-amber-300 text-emerald-900">
          ARROWS EXPRESS
        </div>
        <div className="mt-1 text-[11px]">LINE 1 SCHEDULE</div>
        <div className="text-[11px]">Monday – Saturday</div>
      </div>

      {/* section titles */}
      <div className="grid grid-cols-2 border-b border-neutral-300 bg-neutral-50 text-center text-[11px] font-semibold text-neutral-800">
        <div className="border-r border-neutral-300 px-2 py-2">MANILA &gt; LAGUNA</div>
        <div className="px-2 py-2">LAGUNA &gt; MANILA</div>
      </div>

      {/* main table */}
      <table className="w-full text-[11px]">
        <thead>
          {/* centered header titles */}
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

      {/* footer pick-up points */}
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


/* ---------- Edit form (full-screen content area, NOT a modal) ---------- */
function EditForm({ open, onClose, initial, onSave }: {
  open: boolean;
  initial: SavedPrefs;
  onClose: () => void;
  onSave: (v: SavedPrefs) => void;
}) {
  if (!open) return null;

  const [form, setForm] = useState<SavedPrefs>(initial);
  const showAE = ["Laguna Campus", "Either Campus"].includes(form.campus);


  const availableCourses = useMemo(
    () => (form.kac.length ? form.kac.flatMap((k) => KAC_COURSES[k as KACKey]) : []),
    [form.kac]
  );

  useEffect(() => {
    setForm((f) => ({ ...f, courses: f.courses.filter((c) => availableCourses.includes(c)) }));
  }, [availableCourses]);

  const toggleMulti = (key: "days" | "timeSlots" | "courses", value: string) =>
    setForm((f) => {
      const has = (f as any)[key].includes(value);
      const next = has ? (f as any)[key].filter((v: string) => v !== value) : [...(f as any)[key], value];
      return { ...f, [key]: next };
    });

  // --- CHANGED: disabled when "I have no deloading" is selected or none selected
  const disabledDeloadUnits =
    form.deloading.includes("I have no deloading") || form.deloading.length === 0;

  return (
    <div className="w-full">
      {/* Header row inside content area */}
      <div className="mb-4">
    <h3 className="text-lg font-bold text-neutral-900">Edit Faculty Preferences</h3>
    <p className="text-sm text-neutral-500">
        Update your teaching preferences for the upcoming term
    </p>
    </div>

     <div className={cls("grid grid-cols-1 gap-6", showAE && "lg:grid-cols-[1fr_minmax(200px,400px)]")}>
        {/* Left column: form */}
        <div className="space-y-5 rounded-xl border border-neutral-200 bg-white p-5">
          {/* units */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Preferred Teaching Units</label>
              <Dropdown value={form.prefUnits} onChange={(v) => setForm({ ...form, prefUnits: v })} options={OPT.prefUnits} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Maximum Teaching Units</label>
              <Dropdown value={form.maxUnits} onChange={(v) => setForm({ ...form, maxUnits: v })} options={OPT.maxUnits} />
            </div>
          </div>

          {/* days */}
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
              <Dropdown value={form.delivery} onChange={(v) => setForm({ ...form, delivery: v })} options={OPT.delivery} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Campus Preference</label>
              <Dropdown value={form.campus} onChange={(v) => setForm({ ...form, campus: v })} options={OPT.campus} />
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_160px]">
            <div>
              <label className="mb-1 block text-sm font-medium">Deloading</label>
              <MultiSelectDropdown
                values={form.deloading}
                onChange={(v) => {
                  // if "I have no deloading" is chosen, force it as the only selection
                  const none = v.includes("I have no deloading") ? ["I have no deloading"] : v.filter(x => x !== "I have no deloading");
                  setForm((f) => ({
                    ...f,
                    deloading: none,
                    deloadUnits: none.length === 0 || none.includes("I have no deloading") ? null : (f.deloadUnits ?? 0),
                  }));
                }}
                options={OPT.deloading as unknown as string[]}
                placeholder="— Select one or more —"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Units</label>
              <input
                type="number"
                min={0}
                step={1}
                disabled={disabledDeloadUnits}
                className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none disabled:bg-neutral-100"
                placeholder={disabledDeloadUnits ? "— N/A —" : "Enter units"}
                value={disabledDeloadUnits ? "" : (form.deloadUnits ?? "")}
                onChange={(e) =>
                  setForm({ ...form, deloadUnits: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
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

          {/* bottom actions (duplicate for convenience on mobile) */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="inline-flex h-9 items-center justify-center rounded-[12px] border border-neutral-200 bg-neutral-100 px-4 text-sm text-slate-900 shadow-sm hover:bg-neutral-200/70 active:translate-y-[0.5px]"
            >
              Cancel
            </button>
            <button
              onClick={() => onSave(form)}
              className="inline-flex h-9 items-center justify-center rounded-[12px] bg-[#1F7A49] px-4 text-sm font-medium text-white shadow hover:brightness-[1.06] active:translate-y-[0.5px]"
            >
              Save Preferences
            </button>
          </div>
        </div>

        {/* Right column: AE schedule (only when Laguna/Either) */}
        {showAE && (
          <div className="block">
            <AELine1Schedule />
          </div>
        )}
      </div>
    </div>
  );
}


/* ---------- Saved view card ---------- */
function SavedCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="p-4"> {/* removed bg, border, shadow */}
      <div className="mb-2 flex items-center gap-2 text-emerald-700">
        <Icon className="h-4 w-4" />
        <div className="font-semibold">{title}</div>
      </div>
      {children}
    </div>
  );
}


/* ---------- main ---------- */
export function PreferencesContent() {
  const [saved, setSaved] = useState<SavedPrefs>(initialSaved);
  const [openEdit, setOpenEdit] = useState(false);

  if (openEdit) {
  const coherentInitial: SavedPrefs = {
    ...saved,
    courses: saved.courses.length
      ? saved.courses
      : saved.kac.length
      ? [KAC_COURSES[saved.kac[0]][0]] // use first selected KAC
      : [],
  };

  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
      <EditForm
        open={true}
        initial={coherentInitial}
        onClose={() => setOpenEdit(false)}
        onSave={(v) => {
          setSaved(v);
          setOpenEdit(false);
        }}
      />
    </section>
  );
}

  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
      <div className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-neutral-900">Faculty Preferences</h3>
            <p className="text-sm text-neutral-500">Configure your teaching preferences for the upcoming term</p>
          </div>
          <button
            onClick={() => setOpenEdit(true)}
            className="inline-flex h-9 items-center gap-2 rounded-[12px] bg-emerald-700 px-4 text-sm font-medium text-white shadow hover:brightness-110 active:translate-y-[0.5px]"
          >
            <Settings className="h-4 w-4" />
            Edit Preferences
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SavedCard title="Teaching Load" icon={BookOpen}>
            <div className="space-y-2 text-sm text-neutral-700">
              <div>Preferred Teaching Units</div>
              <div className="text-neutral-900">{saved.prefUnits}.0 units</div>
              <div className="mt-3">Maximum Teaching Units</div>
              <div className="text-neutral-900">{saved.maxUnits}.0 units</div>
              <div className="mt-3">
              <div className="text-neutral-700">Deloading</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {saved.deloading.length
                  ? saved.deloading.map((d) => <Tag key={d} tone="gray">{d}</Tag>)
                  : <Tag tone="gray">—</Tag>}
                <span className="text-neutral-900">
                  {saved.deloadUnits != null ? `${saved.deloadUnits}.0 units` : "—"}
                </span>
              </div>
            </div>
            </div>
            <div className="my-4 h-px w-full bg-neutral-200" />
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-emerald-700">
                <CalendarDays className="h-4 w-4" />
                <div className="font-semibold">Schedule Preferences</div>
              </div>
              <div className="text-sm">
                <div className="mb-1 text-neutral-700">Preferred Days</div>
                <ChipRow items={saved.days} />
              </div>
              <div className="text-sm">
                <div className="mb-1 mt-3 text-neutral-700">Preferred Time Slots</div>
                <ChipRow items={saved.timeSlots} />
              </div>
            </div>
          </SavedCard>

          <SavedCard title="Location & Mode" icon={MapPin}>
            <div className="space-y-3 text-sm">
              <div>
                <div className="mb-1 text-neutral-700">Campus Preference</div>
                <Tag tone="gray">{saved.campus.replace(" Campus", "")}</Tag>
              </div>
              <div>
                <div className="mb-1 text-neutral-700">Delivery Mode</div>
                <Tag tone="gray">{saved.delivery}</Tag>
              </div>
            </div>

            <div className="my-4 h-px w-full bg-neutral-200" />

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-emerald-700">
                <Monitor className="h-4 w-4" />
                <div className="font-semibold">Academic Specialization</div>
              </div>
              <div className="text-sm">
              <div className="mb-1 text-neutral-700">Knowledge Areas</div>
              <div className="flex flex-wrap gap-2">
                {saved.kac.length ? saved.kac.map((k) => <Tag key={k} tone="gray">{k}</Tag>) : <span>—</span>}
              </div>
            </div>

            <div className="text-sm">
              <div className="mb-1 mt-3 text-neutral-700">Preferred Courses</div>
              <ChipRow items={saved.courses.length ? saved.courses : ["—"]} />
            </div>

            </div>
          </SavedCard>

          <SavedCard title="Remarks" icon={BookOpen}>
            <div className="text-sm text-neutral-700">
                {saved.remarks || "—"}
            </div>
            </SavedCard>

        </div>
      </div>
    </section>
  );
}

export default PreferencesContent;
