import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search as SearchIcon, ChevronDown, ChevronLeft } from "lucide-react";
import { fetchOmRpFacultyTeachingHistory } from "../../../api";

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

/** ---------------- Types (replicate FM Teaching History) ---------------- */
type HistRow = {
  code: string;
  title: string;
  section: string;
  mode?: string | null;
  day1?: string | null;
  room1?: string | null;
  day2?: string | null;
  room2?: string | null;
  time?: string | null;
  term?: string | null; // "Term 1" | "Term 2" | "Term 3"
};

// Group rows by Term 1/2/3 exactly like in FM
function groupHistoryByTerm(rows: HistRow[]) {
  const groups: Record<string, HistRow[]> = { "Term 1": [], "Term 2": [], "Term 3": [] };
  rows.forEach((r) => {
    const t = (r.term as string) || "Term 1";
    if (!groups[t]) groups[t] = [];
    groups[t].push(r);
  });
  return groups;
}

/** ---------------- Main ---------------- */
export default function OM_RP_FacultyTeachingHistory() {
  // local filters & state
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [academicYear, setAcademicYear] = useState<string>(""); // default empty → set to latest AY after first fetch
  const [openFaculties, setOpenFaculties] = useState<Set<string>>(new Set());

  // data
  const [rows, setRows] = useState<
    Array<{
      faculty_id: string;
      faculty_name: string;
      term: string;
      code: string;
      title: string;
      section: string;
      mode?: string | null;
      day1?: string | null;
      room1?: string | null;
      day2?: string | null;
      room2?: string | null;
      time?: string | null;
      ay_label?: string;
    }>
  >([]);
  const [ayList, setAyList] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  // Build AY dropdown (newest first) — NO "All Years"
  const academicYearOptions = useMemo(() => {
    const list = [...ayList].sort((a, b) => b - a);
    return list.map((y) => `AY ${y}–${y + 1}`);
  }, [ayList]);

  // Debounce search input to `search` (faculty name only)
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Fetch from analytics (server can also filter by AY & search)
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setErr("");

        // parse selected AY → acad_year_start number or undefined (let backend default to latest if undefined)
        let ayStartNum: number | undefined = undefined;
        const m = /^AY\s+(\d{4})/.exec(academicYear);
        if (m) {
          ayStartNum = parseInt(m[1], 10);
        }

        const res = await fetchOmRpFacultyTeachingHistory({
          search: search || undefined, // server will search ONLY by faculty name (see backend change)
          acad_year_start: ayStartNum,
        });

        setRows(res?.rows || []);
        setAyList(res?.meta?.academicYears || []);

        // If we don't have a selected AY yet, pick the latest from the response
        if (!academicYear && res?.ay_label) {
          setAcademicYear(res.ay_label);
        }
      } catch (e: any) {
        setErr(e?.message || "Failed to load teaching history.");
        setRows([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [search, academicYear]);

  // Client-side filter: enforce selected AY AND search by faculty name only
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const aySel = academicYear;
    return (rows || []).filter((r) => {
      if (aySel && r.ay_label !== aySel) return false; // must match selected AY
      if (!q) return true;
      const name = (r.faculty_name || "").toLowerCase();
      return name.includes(q); // faculty-name-only search
    });
  }, [rows, search, academicYear]);

  // unique faculty list (alphabetical)
  const facultyNames = useMemo(() => {
    const set = new Set((filteredRows || []).map((r) => r.faculty_name || ""));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [filteredRows]);

  // map -> { faculty_name -> HistRow[] } then render by term using FM helper
  const rowsByFaculty = useMemo(() => {
    const map = new Map<string, HistRow[]>();
    (filteredRows || []).forEach((r) => {
      const key = r.faculty_name || "";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({
        code: r.code,
        title: r.title,
        section: r.section,
        mode: r.mode,
        day1: r.day1,
        room1: r.room1,
        day2: r.day2,
        room2: r.room2,
        time: r.time,
        term: r.term as string,
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
      {/* Keep your existing header titles exactly */}
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
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by faculty name..."
            className="w-full rounded-lg border border-gray-300 px-9 pr-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
          {!!searchInput && (
            <button
              aria-label="Clear search"
              title="Clear"
              onClick={() => setSearchInput("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
            >
              ×
            </button>
          )}
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
        {err && <div className="p-4 text-sm text-red-700 bg-red-50 border-b border-red-200">{err}</div>}
        {loading && <div className="p-6 text-center text-sm text-gray-500">Loading…</div>}
        {!loading && facultyNames.length === 0 && (
          <div className="p-6 text-center text-sm text-gray-500">No records match your filters.</div>
        )}

        {!loading &&
          facultyNames.map((name) => {
            const isOpen = openFaculties.has(name);
            const flatRows = rowsByFaculty.get(name) ?? [];
            const groups = groupHistoryByTerm(flatRows); // ← same as FM
            // Render per Term in FM’s exact columns (no AY column)
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
                            <colgroup>
                              <col style={{ width: 110 }} />
                              <col style={{ width: 240 }} />
                              <col style={{ width: 90 }} />
                              <col style={{ width: 100 }} />
                              <col style={{ width: 70 }} />
                              <col style={{ width: 110 }} />
                              <col style={{ width: 70 }} />
                              <col style={{ width: 110 }} />
                              <col style={{ width: 130 }} />
                            </colgroup>
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
                                ].map((h) => (
                                  <th key={h} className="px-3 py-2 text-center font-medium whitespace-nowrap">
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {(groups[t] ?? []).length === 0 ? (
                                <tr>
                                  <td colSpan={9} className="px-4 py-6 text-center text-sm text-gray-500">
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
                                    <td className="px-3 py-2 text-center">{r.mode ?? ""}</td>
                                    <td className="px-3 py-2 text-center">{r.day1 ?? ""}</td>
                                    <td className="px-3 py-2 text-center">{r.room1 ?? ""}</td>
                                    <td className="px-3 py-2 text-center">{r.day2 ?? ""}</td>
                                    <td className="px-3 py-2 text-center">{r.room2 ?? ""}</td>
                                    <td className="px-3 py-2 text-center">{r.time ?? ""}</td>
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
