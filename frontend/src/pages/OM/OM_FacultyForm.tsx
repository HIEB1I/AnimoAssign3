import { useState, useEffect, useRef } from "react";
import { cls } from "../../utilities/cls";
import AppShell from "../../base/AppShell";
import {
  ChevronDown,
  Search,
  MoreVertical,
  Eye,
  GraduationCap,
  MapPin,
  Calendar,
  BookOpen,
} from "lucide-react";

/* ---------------- SelectBox ---------------- */
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
  const [hover, setHover] = useState<number>(() =>
    Math.max(0, options.findIndex((o) => o === value))
  );
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
    <div className={cls("relative min-w-[160px]", className)}>
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

/* ---------------- Dropdown Menu ---------------- */
function ActionMenu({
  onView,
  disabled,
}: {
  onView: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) =>
      open && !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className={cls(
          "rounded-full p-2",
          disabled
            ? "opacity-50 cursor-not-allowed"
            : "hover:bg-gray-100 text-gray-700"
        )}
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-44 rounded-lg border border-gray-200 bg-white shadow-xl py-1 text-left z-50">
          <button
            onClick={() => {
              setOpen(false);
              onView();
            }}
            className="flex w-full items-center justify-start gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            <Eye className="h-4 w-4" /> <span>View Preference</span>
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------- Main ---------------- */
export default function OM_FacForms() {
  interface Faculty {
    name: string;
    email: string;
    department: string;
    type: string;
    date: string;
    status: string;
  }

  const [department, setDepartment] = useState("All Departments");
  const [status, setStatus] = useState("All Status");
  const [facultyType, setFacultyType] = useState("All Faculty Type");
  const [search, setSearch] = useState("");
  const [viewFaculty, setViewFaculty] = useState<Faculty | null>(null);

  const departmentOptions = [
    "All Departments",
    "Software Technology",
    "Computer Technology",
    "Information Technology",
  ];

  const statusOptions = ["All Status", "Submitted", "Not Submitted"];
  const facultyTypeOptions = ["All Faculty Type", "Full-Time", "Part-Time"];

  const [data] = useState<Faculty[]>([
    {
      name: "CABREDO, RAFAEL ANGISCO",
      email: "rafael.cabredo@dlsu.edu.ph",
      department: "Software Technology",
      type: "Full-Time",
      date: "08/13/2025",
      status: "Submitted",
    },
    {
      name: "NICDAO, DIOSDADO R. III",
      email: "diosdado.nicdao@dlsu.edu.ph",
      department: "Computer Technology",
      type: "Full-Time",
      date: "08/12/2025",
      status: "Submitted",
    },
    {
      name: "GONDA, RAPHAEL WILWAYCO",
      email: "raphael.gonda@dlsu.edu.ph",
      department: "Information Technology",
      type: "Part-Time",
      date: "08/12/2025",
      status: "Not Submitted",
    },
  ]);

  const filtered = data.filter(
    (r) =>
      (department === "All Departments" || r.department === department) &&
      (status === "All Status" || r.status === status) &&
      (facultyType === "All Faculty Type" || r.type === facultyType) &&
      r.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <AppShell>
      <main className="w-full px-8 py-8">
        {/* Header */}
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Faculty Preferences</h1>
            <p className="text-sm text-gray-600">
              Faculty load assignment submissions for Term 1 AY 2025–2026
            </p>
          </div>
          <p className="text-sm font-semibold text-red-600">
            Due Date: <span className="text-gray-800">August 25, 2025</span>
          </p>
        </header>

        {/* Filter Row */}
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name..."
              className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>

          <SelectBox
            value={department}
            onChange={setDepartment}
            options={departmentOptions}
          />
          <SelectBox value={status} onChange={setStatus} options={statusOptions} />
          <SelectBox
            value={facultyType}
            onChange={setFacultyType}
            options={facultyTypeOptions}
          />
        </div>

        {/* Table */}
        <div className="border border-gray-200 bg-gray-50 shadow-sm overflow-visible">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-gray-700">
              <tr>
                <th className="text-left px-4 py-2">Faculty</th>
                <th className="text-left px-4 py-2">Department</th>
                <th className="text-center px-4 py-2">Faculty Type</th>
                <th className="text-center px-4 py-2">Submission Date</th>
                <th className="text-center px-4 py-2">Status</th>
                <th className="text-center px-4 py-2">Actions</th>
              </tr>
            </thead>

            <tbody className="divide-y">
              {filtered.map((r) => (
                <tr key={r.name} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-emerald-700 font-semibold">
                    {r.name}
                    <div className="text-xs text-gray-500">{r.email}</div>
                  </td>
                  <td className="px-4 py-3">{r.department}</td>
                  <td className="text-center">{r.type}</td>
                  <td className="text-center">{r.date}</td>
                  <td className="text-center">
                    <span
                      className={cls(
                        "inline-block rounded-full px-3 py-1 text-xs font-semibold",
                        r.status === "Submitted"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-gray-100 text-gray-700"
                      )}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="text-center">
                    <ActionMenu onView={() => setViewFaculty(r)} disabled={false} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* ---------------- View Preference Modal ---------------- */}
          {viewFaculty && (
            <div className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-4">
              <div className="w-full max-w-xl rounded-2xl bg-white p-8 shadow-2xl">
                <h2 className="text-lg font-semibold text-emerald-700 mb-1">
                  Faculty Preference
                </h2>
                <p className="text-sm text-gray-600 mb-6">
                  Instructor:{" "}
                  <span className="font-medium text-gray-800">
                    {viewFaculty.name}
                  </span>
                </p>

                <div className="grid grid-cols-2 gap-x-10 gap-y-6 text-sm">
                  {/* Teaching Load */}
                  <div>
                    <h4 className="font-semibold flex items-center gap-2 mb-2 text-gray-800">
                      <GraduationCap className="h-4 w-4 text-emerald-700" />
                      Teaching Load
                    </h4>
                    <p>Preferred Teaching Units</p>
                    <p className="text-gray-500">3.0 units</p>
                    <p className="mt-1">Maximum Teaching Units</p>
                    <p className="text-gray-500">6.0 units</p>
                    <p className="mt-1">Deloading</p>
                    <p className="text-gray-500">Administrative (3 units)</p>
                  </div>

                  {/* Location and Mode */}
                  <div>
                    <h4 className="font-semibold flex items-center gap-2 mb-2 text-gray-800">
                      <MapPin className="h-4 w-4 text-emerald-700" />
                      Location and Mode
                    </h4>
                    <p>Campus</p>
                    <p className="text-gray-500">Manila</p>
                    <p className="mt-1">Mode of Learning</p>
                    <p className="text-gray-500">Hybrid</p>
                  </div>

                  {/* Schedule */}
                  <div>
                    <h4 className="font-semibold flex items-center gap-2 mb-2 text-gray-800">
                      <Calendar className="h-4 w-4 text-emerald-700" />
                      Schedule
                    </h4>
                    <p>Days</p>
                    <p className="text-gray-500">Tuesday, Friday, Saturday</p>
                    <p className="mt-1">Time Slots</p>
                    <p className="text-gray-500">
                      7:30–9:00, 12:45–14:15, 14:30–16:00
                    </p>
                  </div>

                  {/* Academic Specialization */}
                  <div>
                    <h4 className="font-semibold flex items-center gap-2 mb-2 text-gray-800">
                      <BookOpen className="h-4 w-4 text-emerald-700" />
                      Academic Specialization
                    </h4>
                    <p>Knowledge Area</p>
                    <p className="text-gray-500">Computer Programming</p>
                    <p className="mt-1">Courses</p>
                    <p className="text-gray-500">CCPROG1, CCPROG2, CCPROG3</p>
                  </div>
                </div>

                <div className="flex justify-end mt-8">
                  <button
                    onClick={() => setViewFaculty(null)}
                    className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </AppShell>
  );
}
