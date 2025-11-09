// frontend/src/pages/CHAIR/CHAIR_ClassRetention.tsx
import { useEffect, useMemo, useState } from "react";
import { Send, Check, ChevronDown, Search, Edit, X } from "lucide-react";
import { cls } from "../../utilities/cls";

/* ---------------- SelectBox (lightweight) ---------------- */
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
  return (
    <div className={cls("relative min-w-[180px]", className)}>
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
          {options.map((opt, i) => (
            <button
              key={opt}
              onMouseEnter={() => setHover(i)}
              onClick={() => {
                onChange(opt);
                setOpen(false);
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

/* ---------------- small UI helper ---------------- */
function TextBox({
  value,
  onChange,
  placeholder = "Add remarks…",
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={3}
      className={cls(
        "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm resize-none",
        "focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 outline-none transition",
        className
      )}
    />
  );
}

/* ---------------- Types ---------------- */
type CRRow = {
  section_id: string;
  course_id: string;
  course_code: string;
  course_title: string;
  section_code: string;
  stuUnits?: number | null;
  facUnits?: number | null;
  enrolled: number;
  faculty: string;
  status: string;
  remarks?: string;
};

/* ---------------- Hardcoded demo data ---------------- */
const DEMO_STATUSES = ["All Status", "Approved", "Under Review", "Dissolved", "Special Class", "Forwarded"];
const DEMO_TERM_LABEL = "AY 2024–2025 · Term 1";

const DEMO_ROWS: CRRow[] = [
  {
    section_id: "SEC-0001",
    course_id: "C-CCS-DSA",
    course_code: "CCDSALG",
    course_title: "Data Structures & Algorithms",
    section_code: "S11",
    stuUnits: 3,
    facUnits: 3,
    enrolled: 18,
    faculty: "Dela Cruz, Juan",
    status: "Under Review",
    remarks: "Borderline enrollment; waiting for 2 more students.",
  },
  {
    section_id: "SEC-0002",
    course_id: "C-CCS-DBS",
    course_code: "CCDBSYS",
    course_title: "Database Systems",
    section_code: "S12",
    stuUnits: 3,
    facUnits: 3,
    enrolled: 11,
    faculty: "Santos, Maria",
    status: "Approved",
    remarks: "Approved by Chair on 2025-10-04.",
  },
  {
    section_id: "SEC-0003",
    course_id: "C-CCS-NET",
    course_code: "CCNETWK",
    course_title: "Computer Networks",
    section_code: "S13",
    stuUnits: 4,
    facUnits: 4,
    enrolled: 8,
    faculty: "Reyes, Carlo",
    status: "Dissolved",
    remarks: "Merged to CCDSALG S14.",
  },
  {
    section_id: "SEC-0004",
    course_id: "C-CCS-AI",
    course_code: "CCAIINT",
    course_title: "Intro to AI",
    section_code: "S14",
    stuUnits: 3,
    facUnits: 3,
    enrolled: 9,
    faculty: "Garcia, Lea",
    status: "Special Class",
    remarks: "Thesis-bound cohort; grant-approved.",
  },
];

/* ---------------- Status pill styling ---------------- */
const STATUS_PILL: Record<string, string> = {
  Approved: "bg-green-100 text-green-700",
  "Under Review": "bg-yellow-100 text-yellow-700",
  Dissolved: "bg-red-100 text-red-700",
  "Special Class": "bg-blue-100 text-blue-700",
  Forwarded: "bg-blue-100 text-blue-700",
};
function pillClass(status?: string) {
  if (!status) return "bg-gray-100 text-gray-600";
  return STATUS_PILL[status] || "bg-gray-100 text-gray-600";
}

/* ---------------- Component ---------------- */
export default function CHAIR_ClassRetention() {
  // filters
  const [status, setStatus] = useState("All Status");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // table state (in-memory)
  const [rows, setRows] = useState<CRRow[]>(DEMO_ROWS);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // edit
  const [editSectionId, setEditSectionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ status?: string; remarks?: string }>({});

  // pretend options/term load
  const [statuses] = useState<string[]>(DEMO_STATUSES);
  const [activeTermLabel] = useState<string>(DEMO_TERM_LABEL);

  // debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // filtered rows
  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    return rows.filter((r) => {
      const passSearch =
        !s ||
        r.course_code.toLowerCase().includes(s) ||
        r.course_title.toLowerCase().includes(s) ||
        r.section_code.toLowerCase().includes(s) ||
        (r.remarks || "").toLowerCase().includes(s) ||
        r.faculty.toLowerCase().includes(s);
      const passStatus = status === "All Status" || r.status === status;
      return passSearch && passStatus;
    });
  }, [rows, search, status]);

  const toggleAll = (checked: boolean) =>
    setSelected(checked ? filtered.map((r) => r.section_id) : []);

  const beginEdit = (row: CRRow) => {
    setEditSectionId(row.section_id);
    setDraft({ status: row.status, remarks: row.remarks || "" });
  };

  const saveEdit = async () => {
    if (!editSectionId) return;
    setLoading(true);
    // in-memory update
    setRows((prev) =>
      prev.map((r) =>
        r.section_id === editSectionId ? { ...r, status: draft.status || "", remarks: draft.remarks || "" } : r
      )
    );
    setEditSectionId(null);
    setDraft({});
    setLoading(false);
  };

  const forwardSelected = async () => {
    if (!selected.length) return;
    setLoading(true);
    const target =
      statuses.find((s) => s.toLowerCase().startsWith("forward")) || "Forwarded";
    setRows((prev) =>
      prev.map((r) => (selected.includes(r.section_id) ? { ...r, status: target } : r))
    );
    setSelected([]);
    setLoading(false);
  };

  return (
    <main className="w-full px-8 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Class Retention</h1>
        <p className="text-sm text-gray-600">
          Review and manage low-enrollment class retention requests {activeTermLabel && `for ${activeTermLabel}`}
        </p>
      </header>

      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="relative min-w-[260px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by course / title / section / faculty / remarks…"
            className="w-full rounded-lg border border-gray-300 px-9 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-500 hover:bg-gray-100"
              title="Clear"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <SelectBox value={status} onChange={setStatus} options={statuses} />

        <button
          onClick={forwardSelected}
          disabled={!selected.length || loading}
          className={cls(
            "ml-auto inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white shadow-sm",
            selected.length ? "bg-emerald-700 hover:brightness-110" : "bg-gray-300 cursor-not-allowed"
          )}
        >
          <Send className="h-4 w-4" />
          Forward
        </button>
      </div>

      {/* Table */}
      <div className="overflow-visible border border-gray-200 bg-gray-50 shadow-sm rounded-xl">
        <table className="w-full text-sm">
          <thead className="border-b bg-gray-50 text-gray-700">
            <tr>
              <th className="w-10 px-4 py-2 text-center">
                <input
                  type="checkbox"
                  checked={filtered.length > 0 && selected.length === filtered.length}
                  onChange={(e) => toggleAll(e.target.checked)}
                  className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                />
              </th>
              <th className="px-4 py-2 text-left">Course Code & Title</th>
              <th className="px-4 py-2 text-center">Section</th>
              <th className="px-4 py-2 text-center">Student Units</th>
              <th className="px-4 py-2 text-center">Faculty Units</th>
              <th className="px-4 py-2 text-center">Enrolled Students</th>
              <th className="px-4 py-2 text-left">Faculty</th>
              <th className="px-4 py-2 text-center">Status</th>
              <th className="px-4 py-2 text-left w-[32%]">Remarks</th>
              <th className="w-10 px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td className="px-4 py-6 text-center text-gray-500" colSpan={10}>
                  Loading…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-gray-500" colSpan={10}>
                  No results
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const editing = editSectionId === r.section_id;
                return (
                  <tr key={r.section_id} className="hover:bg-gray-50 align-top">
                    <td className="px-4 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={selected.includes(r.section_id)}
                        onChange={() =>
                          setSelected((prev) =>
                            prev.includes(r.section_id)
                              ? prev.filter((id) => id !== r.section_id)
                              : [...prev, r.section_id]
                          )
                        }
                        className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                      />
                    </td>

                    <td className="px-4 py-3 text-left font-semibold text-emerald-700">
                      {r.course_code}
                      <div className="text-xs text-gray-500">{r.course_title}</div>
                    </td>

                    <td className="text-center pt-3">{r.section_code || "—"}</td>
                    <td className="text-center pt-3">{r.stuUnits ?? "—"}</td>
                    <td className="text-center pt-3">{r.facUnits ?? "—"}</td>
                    <td className="text-center pt-3">{r.enrolled ?? 0}</td>
                    <td className="text-left pt-3">{r.faculty || "—"}</td>

                    <td className="text-center pt-3">
                      {editing ? (
                        <SelectBox
                          value={draft.status || ""}
                          onChange={(v) => setDraft((d) => ({ ...d, status: v }))}
                          options={DEMO_STATUSES.filter((s) => s !== "All Status")}
                        />
                      ) : (
                        <span
                          className={cls(
                            "inline-block rounded-full px-3 py-1 text-xs font-semibold",
                            pillClass(r.status)
                          )}
                        >
                          {r.status || "—"}
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-2 text-left">
                      {editing ? (
                        <TextBox
                          value={draft.remarks || ""}
                          onChange={(v) => setDraft((d) => ({ ...d, remarks: v }))}
                          className="w-full"
                        />
                      ) : (
                        <span className="text-gray-700 block whitespace-pre-wrap">
                          {r.remarks || <span className="text-gray-400">—</span>}
                        </span>
                      )}
                    </td>

                    <td className="text-center pt-3">
                      {editing ? (
                        <button
                          onClick={saveEdit}
                          className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-green-600 text-green-600 hover:bg-green-50"
                          title="Save"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            beginEdit(r);
                          }}
                          className="text-emerald-700 hover:brightness-110"
                          title="Edit"
                        >
                          <Edit className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
