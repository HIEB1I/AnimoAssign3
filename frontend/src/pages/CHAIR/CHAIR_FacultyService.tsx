import React, { useState, useRef, useEffect } from "react";
import { Search, SquarePen, ChevronDown } from "lucide-react";

// tiny util (same as CHAIR_ClassRetention)
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

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
  const [hover, setHover] = useState<number>(() => Math.max(0, options.findIndex((o) => o === value)));
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
    <div className={cls("relative min-w-[180px]", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 pr-8 text-left text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
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

export default function CHAIR_FacultyService() {
  const [department, setDepartment] = useState("All Departments");
  const [search, setSearch] = useState("");

  const data = [
    {
      faculty: "CABREDO, RAFAEL ANGISCO",
      email: "rafael.cabredo@dlsu.edu.ph",
      department: "Computer Technology",
      course: "CCINFOM",
      units: 3.0,
      day: ["M", "H"],
      time: "9:15–10:45",
      room: ["ONLINE", "GK306A"],
      capacity: 22,
      remarks: "Lack of faculty",
    },
  ];

  const filtered = data.filter(
    (r) =>
      (department === "All Departments" || r.department === department) &&
      (r.course.toLowerCase().includes(search.toLowerCase()) ||
        r.faculty.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="w-full px-8 py-8">
      {/* Header (inherits topbar from parent shell) */}
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Faculty Service</h1>
        <p className="text-sm text-gray-600">Review and manage faculty resource requests</p>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by course or faculty..."
            className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
        </div>

        <SelectBox
          value={department}
          onChange={setDepartment}
          options={["All Departments", "Software Technology", "Computer Technology", "Information Technology"]}
        />
      </div>

      {/* Table */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 shadow-sm overflow-visible">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b text-gray-700">
            <tr>
              <th className="text-left px-4 py-2">Faculty</th>
              <th className="text-left px-4 py-2">Department</th>
              <th className="text-left px-4 py-2">Course</th>
              <th className="text-center px-4 py-2">Units</th>
              <th className="text-center px-4 py-2">Day</th>
              <th className="text-center px-4 py-2">Time</th>
              <th className="text-center px-4 py-2">Room</th>
              <th className="text-center px-4 py-2">Capacity</th>
              <th className="text-left px-4 py-2">Remarks</th>
              <th className="text-center w-10 px-4 py-2"></th>
            </tr>
          </thead>

          <tbody className="divide-y">
            {filtered.map((r, i) => {
              const meetings = r.day.map((d, idx) => ({
                day: d,
                time: r.time,
                room: Array.isArray(r.room) ? r.room[idx] : r.room,
              }));
              const span = meetings.length;

              return (
                <React.Fragment key={i}>
                  <tr className="hover:bg-gray-50">
                    <td className="px-4 py-3 align-middle" rowSpan={span}>
                      <div className="font-semibold text-emerald-700">{r.faculty}</div>
                      <div className="text-xs text-gray-500">{r.email}</div>
                    </td>
                    <td className="px-4 py-3 align-middle" rowSpan={span}>{r.department}</td>
                    <td className="px-4 py-3 align-middle" rowSpan={span}>{r.course}</td>
                    <td className="px-4 py-3 text-center align-middle" rowSpan={span}>{r.units}</td>

                    {/* first meeting row */}
                    <td className="px-4 py-3 text-center align-middle">{meetings[0].day}</td>
                    <td className="px-4 py-3 text-center align-middle">{meetings[0].time}</td>
                    <td className="px-4 py-3 text-center align-middle">{meetings[0].room}</td>

                    <td className="px-4 py-3 text-center align-middle" rowSpan={span}>{r.capacity}</td>
                    <td className="px-4 py-3 align-middle" rowSpan={span}>{r.remarks}</td>
                    <td className="px-4 py-3 text-center align-middle" rowSpan={span}>
                      <button className="rounded-md p-2 hover:bg-gray-100 transition" title="Edit">
                        <SquarePen size={18} />
                      </button>
                    </td>
                  </tr>

                  {/* remaining meeting rows */}
                  {meetings.slice(1).map((m, idx2) => (
                    <tr key={`${i}-m${idx2 + 1}`} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-center align-middle">{m.day}</td>
                      <td className="px-4 py-3 text-center align-middle">{m.time}</td>
                      <td className="px-4 py-3 text-center align-middle">{m.room}</td>
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
