import { useState, useEffect, useRef } from "react";
import { cls } from "../../utilities/cls";
import AppShell from "../../base/AppShell";
import {
  Send,
  Check,
  ChevronDown,
  Search,
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

/* ---------------- Main ---------------- */
export default function OM_ClassRetention() {
  const [status, setStatus] = useState("All Status");
  const [search, setSearch] = useState("");
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [showApprovePrompt, setShowApprovePrompt] = useState(false);

  const data = [
    {
      course: "CCPROG3",
      title: "Object-Oriented Programming",
      section: "S16",
      stuUnits: 3,
      facUnits: 3,
      enrolled: 12,
      faculty: "BEREDO, JACKLYN",
      status: "Approved",
    },
    {
      course: "STCLOUD",
      title: "Cloud Computing",
      section: "S14",
      stuUnits: 3,
      facUnits: 3,
      enrolled: 10,
      faculty: "FLORES, FRITZ KEVIN",
      status: "Under Review",
    },
    {
      course: "CSMODEL",
      title: "Discrete Structures",
      section: "S11",
      stuUnits: 3,
      facUnits: 3,
      enrolled: 6,
      faculty: "CU, GREGORY",
      status: "Dissolved",
    },
    {
      course: "ITDBADM",
      title: "Database Management",
      section: "S14",
      stuUnits: 3,
      facUnits: 3,
      enrolled: 1,
      faculty: "GONDA, RAPHAEL",
      status: "Special Class",
    },
  ];

  const filtered = data.filter(
    (r) =>
      (status === "All Status" || r.status === status) &&
      r.course.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <AppShell>
      <main className="w-full px-8 py-8">
        {/* Header */}
        <header className="mb-6">
          <h1 className="text-2xl font-bold">Class Retention</h1>
          <p className="text-sm text-gray-600">
            Manage class retention requests for low-enrollment courses for Term 1 AY 2025–2026
          </p>
        </header>

        {/* Filter Row */}
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm mb-6">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by course..."
              className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>

          <SelectBox
            value={status}
            onChange={setStatus}
            options={[
              "All Status",
              "Approved",
              "Under Review",
              "Dissolved",
              "Special Class",
            ]}
          />

          <button
            onClick={() => {
              if (selectedRows.length === 0) {
                alert("Please select at least one course to approve.");
                return;
              }
              setShowApprovePrompt(true);
            }}
            disabled={selectedRows.length === 0}
            className={cls(
              "ml-auto inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white shadow-sm",
              selectedRows.length > 0
                ? "bg-emerald-700 hover:brightness-110"
                : "bg-gray-300 cursor-not-allowed"
            )}
          >
            <Send className="h-4 w-4" />
            Forward
          </button>
        </div>

        {/* Table */}
        <div className="border border-gray-200 bg-gray-50 shadow-sm overflow-visible">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-gray-700">
              <tr>
                <th className="w-10 px-4 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={
                      filtered.length > 0 &&
                      selectedRows.length === filtered.length
                    }
                    onChange={(e) =>
                      setSelectedRows(
                        e.target.checked ? filtered.map((r) => r.course) : []
                      )
                    }
                    className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                  />
                </th>
                <th className="text-left px-4 py-2">Course Code & Title</th>
                <th className="px-4 py-2 text-center">Section</th>
                <th className="px-4 py-2 text-center">Student Units</th>
                <th className="px-4 py-2 text-center">Faculty Units</th>
                <th className="px-4 py-2 text-center">Enrolled Students</th>
                <th className="text-left px-4 py-2">Faculty</th>
                <th className="px-4 py-2 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map((r) => (
                <tr key={r.course} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-center">
                    <input
                      type="checkbox"
                      checked={selectedRows.includes(r.course)}
                      onChange={() =>
                        setSelectedRows((prev) =>
                          prev.includes(r.course)
                            ? prev.filter((id) => id !== r.course)
                            : [...prev, r.course]
                        )
                      }
                      className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                    />
                  </td>
                  <td className="px-4 py-3 text-left font-semibold text-emerald-700">
                    {r.course}
                    <div className="text-xs text-gray-500">{r.title}</div>
                  </td>
                  <td className="text-center">{r.section}</td>
                  <td className="text-center">{r.stuUnits}</td>
                  <td className="text-center">{r.facUnits}</td>
                  <td className="text-center">{r.enrolled}</td>
                  <td className="text-left">{r.faculty}</td>
                  <td className="text-center">
                    <span
                      className={cls(
                        "inline-block rounded-full px-3 py-1 text-xs font-semibold",
                        r.status === "Approved"
                          ? "bg-green-100 text-green-700"
                          : r.status === "Under Review"
                          ? "bg-yellow-100 text-yellow-700"
                          : r.status === "Special Class"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-red-100 text-red-700"
                      )}
                    >
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Approval Confirmation Modal */}
        {showApprovePrompt && (
          <div className="fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4">
            <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
              <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full border-2 border-emerald-600 text-emerald-700">
                <Check className="h-8 w-8" strokeWidth={2.5} />
              </div>
              <h3 className="mb-2 text-center text-2xl font-semibold">
                Forward Selected Courses?
              </h3>
              <p className="mx-auto mb-6 max-w-md text-center text-sm text-neutral-600">
                You are about to forward{" "}
                <span className="font-semibold">{selectedRows.length}</span>{" "}
                {selectedRows.length === 1
                  ? "class retention request"
                  : "class retention requests"}
                .<br />
                Once confirmed, these will be sent to the{" "}
                <span className="font-semibold">Department Chair</span>.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowApprovePrompt(false)}
                  className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setShowApprovePrompt(false);
                    alert(`✅ ${selectedRows.length} course(s) approved successfully!`);
                    setSelectedRows([]);
                  }}
                  className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110"
                >
                  Forward
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </AppShell>
  );
}
