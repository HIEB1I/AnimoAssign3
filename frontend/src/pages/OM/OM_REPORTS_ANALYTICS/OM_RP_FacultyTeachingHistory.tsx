// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_FacultyTeachingHistory.tsx
import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search as SearchIcon, ChevronDown, ChevronLeft } from "lucide-react";

/** ---------------- Tiny utils ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

/** ---------------- Minimal Select ---------------- */
function SelectBox({
  value,
  onChange,
  options,
  placeholder = "— Select —",
  className = "min-w-[180px]",
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 pr-8 text-left text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
      >
        {value || <span className="text-gray-400">{placeholder}</span>}
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2" />
      </button>

      {open && (
        <div className="absolute z-20 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-gray-300 bg-white shadow-xl">
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              className={`block w-full px-4 py-2 text-left text-sm hover:bg-emerald-50 ${
                value === opt ? "bg-emerald-100 text-emerald-800 font-medium" : ""
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** ---------------- Types & Sample Data (mirrors OM-REPO-ANA) ---------------- */
type Row = {
  faculty: string;
  ay: string;                           // e.g., "AY 2024–2025"
  term: "Term 1" | "Term 2" | "Term 3";
  code: string;
  title: string;
  section: string;
  mode: "Hybrid" | "Online" | "Onsite";
  day1: string;
  room1: string;
  day2: string;
  room2: string;
  time: string;                         // e.g., "7:30–9:00"
};

// Hardcoded sample rows to preview UI (same schema & vibe as repo-ANA)
const DATA: Row[] = [
  { faculty: "CABREDO, RAFAEL ANGISCO", ay: "AY 2024–2025", term: "Term 1", code: "CSMODEL", title: "Modelling and Simulation", section: "S12", mode: "Hybrid", day1: "M", room1: "Online", day2: "H", room2: "GK201", time: "7:30–9:00" },
  { faculty: "CABREDO, RAFAEL ANGISCO", ay: "AY 2024–2025", term: "Term 2", code: "CCPROG3", title: "Programming 3", section: "S16", mode: "Online", day1: "T", room1: "Online", day2: "F", room2: "Online", time: "9:15–10:45" },
  { faculty: "CABREDO, RAFAEL ANGISCO", ay: "AY 2024–2025", term: "Term 3", code: "STCLOUD", title: "Cloud Systems", section: "S10", mode: "Onsite", day1: "W", room1: "GK210", day2: "F", room2: "GK210", time: "1:00–2:30" },

  { faculty: "NICDAO, DIOSDADO R. III", ay: "AY 2023–2024", term: "Term 1", code: "ADSFUND", title: "Advanced Fund.", section: "S03", mode: "Hybrid", day1: "M", room1: "Online", day2: "H", room2: "GK211", time: "10:00–11:30" },
  { faculty: "NICDAO, DIOSDADO R. III", ay: "AY 2023–2024", term: "Term 2", code: "CSMODEL", title: "Modelling and Simulation", section: "S08", mode: "Onsite", day1: "T", room1: "GK305", day2: "F", room2: "GK305", time: "7:30–9:00" },

  { faculty: "GONDA, RAPHAEL WILWAYCO", ay: "AY 2022–2023", term: "Term 1", code: "WEBTECH", title: "Web Technologies", section: "S05", mode: "Online", day1: "M", room1: "Online", day2: "W", room2: "Online", time: "3:00–4:30" },
  { faculty: "GONDA, RAPHAEL WILWAYCO", ay: "AY 2022–2023", term: "Term 3", code: "MOBDEV", title: "Mobile Dev", section: "S02", mode: "Onsite", day1: "T", room1: "GK110", day2: "H", room2: "GK110", time: "9:15–10:45" },
];

/** ---------------- Reusable fixed-width table bits ---------------- */
const HistoryTableHeader: React.FC = () => (
  <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
    <tr>
      {[
        "Course Code",
        "Course Title",
        "Section",
        "Mode",
        "Day 1",
        "Room 1",
        "Day 2",
        "Room 2",
        "Time",
        "Academic Year",
      ].map((h) => (
        <th key={h} className="px-3 py-2 text-center font-medium whitespace-nowrap">
          {h}
        </th>
      ))}
    </tr>
  </thead>
);

const HistoryColGroup: React.FC = () => (
  <colgroup>
    <col style={{ width: 110 }} /> {/* Code */}
    <col style={{ width: 240 }} /> {/* Title */}
    <col style={{ width: 90 }} />  {/* Section */}
    <col style={{ width: 100 }} /> {/* Mode */}
    <col style={{ width: 70 }} />  {/* Day1 */}
    <col style={{ width: 110 }} /> {/* Room1 */}
    <col style={{ width: 70 }} />  {/* Day2 */}
    <col style={{ width: 110 }} /> {/* Room2 */}
    <col style={{ width: 110 }} /> {/* Time */}
    <col style={{ width: 130 }} /> {/* AY */}
  </colgroup>
);

/** ---------------- Main ---------------- */
export default function OM_RP_FacultyTeachingHistory() {
  // local filters & state
  const [search, setSearch] = useState("");
  const [academicYear, setAcademicYear] = useState("All Years");
  const [openFaculties, setOpenFaculties] = useState<Set<string>>(new Set());

  // AY options from mock data (newest first)
  const academicYearOptions = useMemo(() => {
    const uniq = Array.from(new Set(DATA.map((d) => d.ay))).sort().reverse();
    return ["All Years", ...uniq];
  }, []);

  // filter rows (search + AY)
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return DATA.filter((r) => {
      const okYear = academicYear === "All Years" || r.ay === academicYear;
      const okSearch =
        !q ||
        [r.faculty, r.code, r.title, r.section, r.mode, r.day1, r.room1, r.day2, r.room2, r.time, r.term, r.ay]
          .join(" ")
          .toLowerCase()
          .includes(q);
      return okYear && okSearch;
    });
  }, [search, academicYear]);

  // unique faculty list (alphabetical)
  const facultyNames = useMemo(() => {
    const set = new Set(filteredRows.map((r) => r.faculty));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [filteredRows]);

  // group rows by faculty then term (Term1→2→3, AY desc)
  const rowsByFaculty = useMemo(() => {
    const map = new Map<string, Row[]>();
    filteredRows.forEach((r) => {
      if (!map.has(r.faculty)) map.set(r.faculty, []);
      map.get(r.faculty)!.push(r);
    });
    const termOrder = { "Term 1": 1, "Term 2": 2, "Term 3": 3 } as const;
    map.forEach((rows) => {
      rows.sort((a, b) => {
        if (a.ay !== b.ay) return a.ay < b.ay ? 1 : -1; // AY desc
        return termOrder[a.term] - termOrder[b.term];
      });
    });
    return map;
  }, [filteredRows]);

  const toggleFaculty = (name: string) => {
    setOpenFaculties((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="w-full px-8 py-8">
      <h1 className="text-2xl font-bold mb-2">Teaching History of Faculty</h1>
      <p className="text-sm text-gray-600 mb-6">Historical teaching loads and assignments by faculty member.</p>

      {/* Filter Bar with Back (left) + Search + AY filter (right) */}
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <Link
          to="/om/home/reports-analytics"
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 active:bg-gray-100"
          aria-label="Back"
          title="Back"
        >
          <ChevronLeft className="h-4 w-4" />
          <span>Back</span>
        </Link>

        <div className="relative flex-1 min-w-[240px]">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by faculty, course code/title..."
            className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
        </div>

        <SelectBox
          value={academicYear}
          onChange={setAcademicYear}
          options={academicYearOptions}
          placeholder="Select Academic Year"
        />
      </div>

      {/* Faculty list (alphabetical). Each item is expandable. */}
      <div className="rounded-xl border border-gray-200 bg-white divide-y">
        {facultyNames.length === 0 && (
          <div className="p-6 text-center text-sm text-gray-500">No records match your filters.</div>
        )}

        {facultyNames.map((name) => {
          const isOpen = openFaculties.has(name);
          const rows = rowsByFaculty.get(name) ?? [];
          const groups: Record<"Term 1" | "Term 2" | "Term 3", Row[]> = { "Term 1": [], "Term 2": [], "Term 3": [] };
          rows.forEach((r) => groups[r.term].push(r));

          return (
            <div key={name}>
              {/* Row header (button) */}
              <button
                onClick={() => toggleFaculty(name)}
                className="w-full flex items-center justify-between gap-4 px-4 py-3 hover:bg-gray-50"
              >
                <div className="flex items-center gap-3">
                  <ChevronDown
                    className={cls(
                      "h-4 w-4 transition-transform duration-200",
                      isOpen ? "rotate-180 text-emerald-700" : "rotate-0 text-gray-500"
                    )}
                  />
                  <span className="text-sm font-semibold text-gray-900">{name}</span>
                </div>
              </button>

              {/* Collapsible content */}
              {isOpen && (
                <div className="px-4 pb-5 pt-1 space-y-6 bg-white">
                  {(["Term 1", "Term 2", "Term 3"] as const).map((t) => (
                    <div key={`${name}-${t}`} className="rounded-xl border border-gray-200 overflow-hidden">
                      <div className="px-4 py-2 text-sm font-semibold text-emerald-700 bg-gray-50 border-b">{t}</div>

                      <div className="overflow-x-auto">
                        <table className="min-w-full table-fixed text-sm border-t border-gray-200">
                          <HistoryColGroup />
                          <HistoryTableHeader />
                          <tbody>
                            {(groups[t] ?? []).length === 0 ? (
                              <tr>
                                <td colSpan={12} className="px-4 py-6 text-center text-sm text-gray-500">
                                  No records.
                                </td>
                              </tr>
                            ) : (
                              groups[t].map((r, i) => (
                                <tr
                                  key={`${name}-${t}-${i}`}
                                  className={cls("text-gray-800", i % 2 === 0 ? "bg-white" : "bg-gray-50")}
                                >
                                  <td className="px-3 py-2 text-center">{r.code}</td>
                                  <td className="px-3 py-2 text-center">{r.title}</td>
                                  <td className="px-3 py-2 text-center">{r.section}</td>
                                  <td className="px-3 py-2 text-center">{r.mode}</td>
                                  <td className="px-3 py-2 text-center">{r.day1}</td>
                                  <td className="px-3 py-2 text-center">{r.room1}</td>
                                  <td className="px-3 py-2 text-center">{r.day2}</td>
                                  <td className="px-3 py-2 text-center">{r.room2}</td>
                                  <td className="px-3 py-2 text-center">{r.time}</td>
                                  <td className="px-3 py-2 text-center">{r.ay}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
