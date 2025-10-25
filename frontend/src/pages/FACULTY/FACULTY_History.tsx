// src/FAC_History.tsx
import React, { useMemo, useState } from "react";
import { Search } from "lucide-react";

/* ---------- tiny utils ---------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

/* ---------- types ---------- */
type Row = {
  ay: string;        // e.g., "AY 2024-2025"
  term: "Term 1" | "Term 2" | "Term 3";
  code: string;      // e.g., "CSMODEL"
  title: string;     // e.g., "Modelling and Simulation"
  section: string;   // e.g., "S12"
  units: number;     // e.g., 3
  campus: string;    // e.g., "Manila"
  mode: "Hybrid" | "Online" | "Onsite";
  day1: string;      // e.g., "M"
  room1: string;     // e.g., "Online" | "GK201"
  day2: string;      // e.g., "H"
  room2: string;     // e.g., "GK201"
  time: string;      // e.g., "7:30–9:00"
};

/* ---------- sample data (matches columns in the screenshot) ---------- */
const DATA: Row[] = [
  // Term 1
  {
    ay: "AY 2024-2025",
    term: "Term 1",
    code: "CSMODEL",
    title: "Modelling and Simulation",
    section: "S12",
    units: 3,
    campus: "Manila",
    mode: "Hybrid",
    day1: "M",
    room1: "Online",
    day2: "H",
    room2: "GK201",
    time: "7:30–9:00",
  },
  {
    ay: "AY 2024-2025",
    term: "Term 1",
    code: "CSMODEL",
    title: "Modelling and Simulation",
    section: "S12",
    units: 3,
    campus: "Manila",
    mode: "Hybrid",
    day1: "M",
    room1: "Online",
    day2: "H",
    room2: "GK201",
    time: "7:30–9:00",
  },
  {
    ay: "AY 2024-2025",
    term: "Term 1",
    code: "CSMODEL",
    title: "Modelling and Simulation",
    section: "S12",
    units: 3,
    campus: "Manila",
    mode: "Hybrid",
    day1: "M",
    room1: "Online",
    day2: "H",
    room2: "GK201",
    time: "7:30–9:00",
  },
  {
    ay: "AY 2024-2025",
    term: "Term 1",
    code: "CSMODEL",
    title: "Modelling and Simulation",
    section: "S12",
    units: 3,
    campus: "Manila",
    mode: "Hybrid",
    day1: "M",
    room1: "Online",
    day2: "H",
    room2: "GK201",
    time: "7:30–9:00",
  },

  // Term 2
  {
    ay: "AY 2024-2025",
    term: "Term 2",
    code: "CSMODEL",
    title: "Modelling and Simulation",
    section: "S12",
    units: 3,
    campus: "Manila",
    mode: "Hybrid",
    day1: "M",
    room1: "Online",
    day2: "H",
    room2: "GK201",
    time: "7:30–9:00",
  },
  {
    ay: "AY 2024-2025",
    term: "Term 2",
    code: "CSMODEL",
    title: "Modelling and Simulation",
    section: "S12",
    units: 3,
    campus: "Manila",
    mode: "Hybrid",
    day1: "M",
    room1: "Online",
    day2: "H",
    room2: "GK201",
    time: "7:30–9:00",
  },
  {
    ay: "AY 2024-2025",
    term: "Term 2",
    code: "CSMODEL",
    title: "Modelling and Simulation",
    section: "S12",
    units: 3,
    campus: "Manila",
    mode: "Hybrid",
    day1: "M",
    room1: "Online",
    day2: "H",
    room2: "GK201",
    time: "7:30–9:00",
  },
  {
    ay: "AY 2024-2025",
    term: "Term 2",
    code: "CSMODEL",
    title: "Modelling and Simulation",
    section: "S12",
    units: 3,
    campus: "Manila",
    mode: "Hybrid",
    day1: "M",
    room1: "Online",
    day2: "H",
    room2: "GK201",
    time: "7:30–9:00",
  },

  // Term 3
  {
    ay: "AY 2024-2025",
    term: "Term 3",
    code: "CSMODEL",
    title: "Modelling and Simulation",
    section: "S12",
    units: 3,
    campus: "Manila",
    mode: "Hybrid",
    day1: "M",
    room1: "Online",
    day2: "H",
    room2: "GK201",
    time: "7:30–9:00",
  },
  {
    ay: "AY 2024-2025",
    term: "Term 3",
    code: "CSMODEL",
    title: "Modelling and Simulation",
    section: "S12",
    units: 3,
    campus: "Manila",
    mode: "Hybrid",
    day1: "M",
    room1: "Online",
    day2: "H",
    room2: "GK201",
    time: "7:30–9:00",
  },
  {
    ay: "AY 2024-2025",
    term: "Term 3",
    code: "CSMODEL",
    title: "Modelling and Simulation",
    section: "S12",
    units: 3,
    campus: "Manila",
    mode: "Hybrid",
    day1: "M",
    room1: "Online",
    day2: "H",
    room2: "GK201",
    time: "7:30–9:00",
  },
  {
    ay: "AY 2024-2025",
    term: "Term 3",
    code: "CSMODEL",
    title: "Modelling and Simulation",
    section: "S12",
    units: 3,
    campus: "Manila",
    mode: "Hybrid",
    day1: "M",
    room1: "Online",
    day2: "H",
    room2: "GK201",
    time: "7:30–9:00",
  },
];
/* ---------- shared Dropdown (same as FAC_Overview) ---------- */
function Dropdown({
  value,
  onChange,
  options,
  className = "w-full",
  placeholder = "— Select an option —",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [hover, setHover] = React.useState(() =>
    Math.max(0, options.findIndex((o) => o === value))
  );
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(
    () => setHover(Math.max(0, options.findIndex((o) => o === value))),
    [value, options]
  );

  React.useEffect(() => {
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


/* ---------- component ---------- */
function HistoryMain() {
  const [query, setQuery] = useState("");
  const [ay, setAy] = useState<string>("All Academic Year");

  const AY_OPTIONS = useMemo(() => {
    const uniq = Array.from(new Set(DATA.map((d) => d.ay))).sort().reverse();
    return ["All Academic Year", ...uniq];
  }, []);

  const filtered = useMemo(() => {
    let rows = DATA;
    if (ay !== "All Academic Year") rows = rows.filter((r) => r.ay === ay);

    const q = query.trim().toLowerCase();
    if (!q) return rows;

    return rows.filter((r) =>
      [
        r.code,
        r.title,
        r.section,
        r.campus,
        r.mode,
        r.day1,
        r.room1,
        r.day2,
        r.room2,
        r.time,
        r.term,
        r.ay,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [ay, query]);

  const groups = useMemo(() => {
    const byTerm: Record<string, Row[]> = { "Term 1": [], "Term 2": [], "Term 3": [] };
    filtered.forEach((r) => byTerm[r.term].push(r));
    return byTerm;
  }, [filtered]);

  return (
    <section className="mx-auto w-full max-w-screen-2xl px-4">
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        {/* Header */}
        <div className="mb-4">
          <h3 className="text-lg font-bold text-gray-900">Teaching History</h3>
          <p className="text-sm text-gray-500">Complete record of your teaching assignments</p>
        </div>

        {/* Filters */}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="col-span-2">
            <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm shadow-sm">
              <Search className="h-4 w-4 text-gray-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by course name…"
                className="w-full bg-transparent outline-none placeholder:text-gray-400"
              />
            </div>
          </div>
          <Dropdown
          value={ay}
          onChange={setAy}
          options={AY_OPTIONS}
          placeholder="All Academic Year"
        />
        </div>

        {/* AY label (first row's AY or default) */}
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-700">
          <span className="inline-flex items-center gap-2">
            <span className="i-lucide-circle-minus" />
            {ay === "All Academic Year" ? (filtered[0]?.ay ?? "AY 2024-2025") : ay}
          </span>
        </div>

        {/* Term sections */}
        <div className="space-y-8">
          {(["Term 1", "Term 2", "Term 3"] as const).map((t) => (
            <div key={t} className="rounded-xl border border-gray-200">
              {/* Term title */}
              <div className="px-4 py-3 text-sm font-semibold text-emerald-700">{t}</div>

              {/* Table */}
              <div className="overflow-x-auto">
              <table className="min-w-full border-t border-gray-200">
                <thead>
                  <tr className="text-xs text-gray-500">
                    {[
                      "Course Code",
                      "Course Title",
                      "Section",
                      "Units",
                      "Campus",
                      "Mode",
                      "Day 1",
                      "Room 1",
                      "Day 2",
                      "Room 2",
                      "Time",
                    ].map((h) => (
                      <th key={h} className="px-4 py-2 font-medium text-center">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(groups[t] ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={11} className="px-4 py-6 text-center text-sm text-gray-500">
                        No records.
                      </td>
                    </tr>
                  ) : (
                    groups[t].map((r, i) => (
                      <tr
                        key={`${t}-${i}`}
                        className={cls("text-sm text-gray-700", i % 2 === 0 ? "bg-white" : "bg-gray-50")}
                      >
                        <td className="px-4 py-2 text-center">{r.code}</td>
                        <td className="px-4 py-2 text-center">{r.title}</td>
                        <td className="px-4 py-2 text-center">{r.section}</td>
                        <td className="px-4 py-2 text-center">{r.units}</td>
                        <td className="px-4 py-2 text-center">{r.campus}</td>
                        <td className="px-4 py-2 text-center">{r.mode}</td>
                        <td className="px-4 py-2 text-center">{r.day1}</td>
                        <td className="px-4 py-2 text-center">{r.room1}</td>
                        <td className="px-4 py-2 text-center">{r.day2}</td>
                        <td className="px-4 py-2 text-center">{r.room2}</td>
                        <td className="px-4 py-2 text-center">{r.time}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- export content-only for Overview tab ---------- */
export function HistoryContent() {
  return <HistoryMain />;
}

export default HistoryMain;
