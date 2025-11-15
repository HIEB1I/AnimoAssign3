import React, { useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import AppShell from "@/base/AppShell";
import type { SidebarItem } from "@/base/Sidebar";
import {
  Users,
  BookOpen,
  FileText,
  FilePlus,
  BookMarked,
  ListChecks,
  CheckCheck,
  Check,
  FileSpreadsheet,
} from "lucide-react";
// Removed jsPDF + autoTable imports since we now export to Excel
import { setActiveRole, userHasRole } from "@/api";

/* ---------------- Sidebar ---------------- */
const ITEMS: SidebarItem[] = [
  { label: "Plantilla", to: "/chair/plantilla", Icon: ListChecks },
  { label: "Faculty Directory", to: "/chair/faculty-management", Icon: Users },
  { label: "Course Management", to: "/chair/course-management", Icon: BookOpen },
  { label: "Faculty Service", to: "/chair/faculty-service", Icon: FileText },
  { label: "Student Petition", to: "/chair/student-petitions", Icon: FilePlus },
  { label: "Class Retention", to: "/chair/class-retention", Icon: BookMarked },
];

/* ---------------- Utilities ---------------- */
const cls = (...s: (string | false | null | undefined)[]) => s.filter(Boolean).join(" ");

const normalizeDay = (s: string) => {
  const toks = (s || "")
    .toUpperCase()
    .split(/[^A-Z]/g)
    .filter(Boolean);
  const map: Record<string, string> = {
    M: "M",
    T: "T",
    W: "W",
    H: "H", // DLSU Thu
    TH: "H",
    F: "F",
    S: "S",
    SU: "Su",
    SUN: "Su",
    SAT: "S",
  };
  return toks.map((t) => map[t] ?? t.charAt(0)).join(" / ");
};

const DayCell: React.FC<{ raw: string }> = ({ raw }) => (
  <span data-raw-day={raw}>{normalizeDay(raw).replace(/ \/ /g, " / ")}</span>
);

/* ----------- Name helpers (mirror OM behavior) ----------- */
const normalizeCommaName = (n: string) =>
  String(n || "")
    .replace(/^\s*([^,]+),\s*(.+)\s*$/, "$2 $1") // "Last, First [M]" → "First [M] Last"
    .replace(/\s+/g, " ")
    .trim();

const hasTwoWords = (n: string) => /\S+\s+\S+/.test(n);

/* ---------------- Types ---------------- */
type PlantillaRow = {
  // NEW: Rank column (currently empty because not fetched from DB)
  rank?: string;

  faculty_name: string;
  course_code: string;
  section_code: string;
  day_text: string;
  time_text: string; // e.g. "9:15–10:45"
  room_text: string; // e.g. "ONLINE" or "AG1901"
  student_count: number | null;
  lec_hours: number | null;
  lab_hours: number | null;
  student_units: number | null;
  on_leave: string; // "Yes"/"N/A"
  course_type: string; // "Core" | "Elective" | "Grad" | "N/A"
  nature_teaching: number | null;
  nature_admin: number | null;
  nature_research: number | null;
  nature_faculty_units: number | null;
  premium_grad: number | null;
  premium_4th_prep: number | null;
  premium_overload: number | null;
  remarks: string;
};

type HeaderResp = {
  ok: boolean;
  profileName?: string;
  profileSubtitle?: string;
  term_label?: string;
  dept_label?: string;
  plantilla_file?: string;
};

/* ---------------- Old table (refactored to accept rows) ---------------- */
const DepartmentPlantilla: React.FC<{
  deptLabel: string;
  plantillaFile: string;
  rows: PlantillaRow[];
  termLabel?: string;
}> = ({ deptLabel, plantillaFile, rows, termLabel }) => {
  const [showApprovePrompt, setShowApprovePrompt] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const tableRef = useRef<HTMLTableElement | null>(null);

  const safeExcelFilename =
    (plantillaFile && plantillaFile.replace(/\.pdf$/i, ".xls")) || "Faculty_Plantilla.xls";

  const handleExportExcel = () => {
    if (!rows || rows.length === 0) {
      alert("No plantilla rows to export.");
      return;
    }

    // 21 columns including Rank
    const headers = [
      "Rank",
      "Faculty",
      "Course",
      "Section",
      "Day",
      "Time",
      "Room",
      "No. of Students",
      "Lecture Hours",
      "Lab Hours",
      "Student Unit(s)",
      "On Leave",
      "Type of Course",
      "Teaching",
      "Admin",
      "Research",
      "Faculty Unit(s)",
      "Grad Load",
      "Premium 4th Prep",
      "Overload (NCA)",
      "Remarks",
    ];

    const dataRows = rows.map((r) => [
      r.rank ?? "",
      r.faculty_name || "",
      r.course_code || "",
      r.section_code || "",
      r.day_text || "",
      r.time_text || "",
      r.room_text || "",
      r.student_count ?? "",
      r.lec_hours ?? "",
      r.lab_hours ?? "",
      r.student_units ?? "",
      r.on_leave || "",
      r.course_type || "",
      r.nature_teaching ?? "",
      r.nature_admin ?? "",
      r.nature_research ?? "",
      r.nature_faculty_units ?? "",
      r.premium_grad ?? "",
      r.premium_4th_prep ?? "",
      r.premium_overload ?? "",
      r.remarks || "",
    ]);

    // Normalize text for Excel to avoid mojibake like â€“ / â—
    const normalizeForExcel = (value: string) => {
      let v = value ?? "";

      // Treat our UI placeholder em dash as empty in export
      if (v === "—") v = "";

      // Replace typographic dashes/quotes with ASCII
      v = v
        .replace(/[\u2012\u2013\u2014\u2015]/g, "-") // en/em dashes → hyphen
        .replace(/[\u2018\u2019]/g, "'") // curly single quotes → '
        .replace(/[\u201C\u201D]/g, '"') // curly double quotes → "
        .replace(/\u00A0/g, " ") // non-breaking space → normal space
        .replace(/[\r\n\t]/g, " "); // strip control chars

      // Trim excessive spaces
      v = v.replace(/\s+/g, " ").trim();

      return v;
    };

    const esc = (v: string) =>
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Wrap in full HTML with UTF-8 meta so modern Excel can detect encoding
    let html = "<html><head><meta charset=\"utf-8\" /></head><body><table><thead><tr>";
    headers.forEach((h) => {
      html += `<th>${esc(String(h))}</th>`;
    });
    html += "</tr></thead><tbody>";

    dataRows.forEach((row) => {
      html += "<tr>";
      row.forEach((cell) => {
        const raw = cell == null ? "" : String(cell);
        const normalized = normalizeForExcel(raw);
        html += `<td>${esc(normalized)}</td>`;
      });
      html += "</tr>";
    });

    html += "</tbody></table></body></html>";

    const blob = new Blob([html], {
      type: "application/vnd.ms-excel;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = safeExcelFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleApprove = async () => {
    setShowApprovePrompt(false);
    setIsApproving(true);
    try {
      await fetch(`/api/chair/plantilla?action=approve`, { method: "POST" });
      setApproved(true);
      // NOTE: export is now manual; button becomes enabled after approval
    } catch {
      // Non-blocking for UI
    } finally {
      setIsApproving(false);
    }
  };

  return (
    <section className="mt-6">
      <header className="mb-2">
        <h2 className="text-xl font-semibold">
          Department Faculty Plantilla of CCS – {deptLabel}
          {termLabel ? ` · ${termLabel}` : ""}
        </h2>
      </header>

      <div className="flex items-center justify-end gap-3 mt-4">
        <button
          onClick={() => setShowApprovePrompt(true)}
          disabled={approved || isApproving}
          aria-disabled={approved || isApproving}
          className={cls(
            "inline-flex items-center gap-2 rounded-md px-5 py-2 text-sm font-medium text-white",
            approved || isApproving
              ? "bg-emerald-400 cursor-not-allowed opacity-70"
              : "bg-emerald-700 hover:brightness-110"
          )}
          title={approved ? "Already approved" : "Approve plantilla"}
        >
          <CheckCheck className="h-4 w-4" />
          {approved ? "Approved" : isApproving ? "Approving…" : "Approve"}
        </button>

        <button
          onClick={handleExportExcel}
          disabled={!approved}
          aria-disabled={!approved}
          className={cls(
            "inline-flex items-center gap-2 rounded-md px-5 py-2 text-sm font-medium text-white",
            !approved
              ? "bg-blue-300 cursor-not-allowed opacity-60"
              : "bg-blue-600 hover:brightness-110"
          )}
          title={
            !approved
              ? "Approve the plantilla first to enable export"
              : "Export plantilla as Excel (.xls)"
          }
        >
          <FileSpreadsheet className="h-4 w-4" />
          Export Excel
        </button>

        {showApprovePrompt && (
          <div className="fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4">
            <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
              <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full border-2 border-emerald-600 text-emerald-700">
                <Check className="h-8 w-8" strokeWidth={2.5} />
              </div>
              <h3 className="mb-2 text-center text-2xl font-semibold">Are you sure?</h3>
              <p className="mx-auto mb-6 max-w-md text-center text-sm text-neutral-600">
                Confirm this as the final{" "}
                <span className="font-semibold">Faculty Plantilla</span> for{" "}
                <span className="font-semibold">{deptLabel}</span>. After confirming, the{" "}
                <span className="font-semibold">Export Excel</span> button will be enabled.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowApprovePrompt(false)}
                  className="rounded-lg border border-neutral-300 bg-neutral-100 px-4 py-2 text-sm hover:bg-neutral-200"
                >
                  Cancel
                </button>
                <button
                  onClick={handleApprove}
                  className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:brightness-110"
                >
                  Yes, Approve
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 w-full max-w-[100vw] overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-md p-2 md:p-3">
        <table
          ref={tableRef}
          className="w-full table-auto text-[0.88rem] border-collapse border border-gray-200 leading-snug
                  [&_th]:px-3 [&_th]:py-2 [&_th]:align-middle
                  [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle
                  [&_thead_tr]:border-b [&_thead_tr]:border-gray-200
                  [&_tbody_tr:nth-child(even)]:bg-gray-50
                  [&_tbody_tr:hover]:bg-gray-100/60
                  [&_td:nth-child(2)]:text-left [&_td:nth-child(2)]:font-medium [&_td:nth-child(2)]:text-emerald-700
                  [&_th:nth-child(2)]:text-left [&_th:nth-child(2)]:font-semibold
                  [&_td]:break-words [&_td]:tabular-nums [&_th]:tabular-nums
                  [&_td:nth-child(5)]:whitespace-nowrap [&_td:nth-child(6)]:whitespace-nowrap [&_td:nth-child(7)]:whitespace-nowrap [&_td:nth-child(8)]:whitespace-nowrap
                  [&_td:nth-child(n+9)]:text-center
                  [&_th:last-child]:w-[28rem] [&_td:last-child]:w-[28rem]
                  [&_td:last-child]:text-left [&_td:last-child]:align-top"
        >
          {/* Explicit 21 columns so rowSpan/colSpan align perfectly */}
          <colgroup>
            <col className="w-[5rem]" />   {/* 1 Rank */}
            <col className="w-[14rem]" />  {/* 2 Faculty */}
            <col className="w-[7.5rem]" />{/* 3 Course */}
            <col className="w-[6rem]" />  {/* 4 Section */}
            <col className="w-[6.5rem]" />{/* 5 Day */}
            <col className="w-[8rem]" />  {/* 6 Time */}
            <col className="w-[7rem]" />  {/* 7 Room */}
            <col className="w-[8rem]" />  {/* 8 # Students */}
            <col className="w-[7rem]" />  {/* 9 Lec Hrs */}
            <col className="w-[6.5rem]" />{/* 10 Lab Hrs */}
            <col className="w-[8rem]" />  {/* 11 Student Units */}
            <col className="w-[6.5rem]" />{/* 12 On Leave */}
            <col className="w-[8rem]" />  {/* 13 Type of Course */}
            <col className="w-[6.5rem]" />{/* 14 Nature: Teach */}
            <col className="w-[6.5rem]" />{/* 15 Nature: Admin */}
            <col className="w-[7rem]" />  {/* 16 Nature: Research */}
            <col className="w-[8rem]" />  {/* 17 Nature: Faculty Units */}
            <col className="w-[7rem]" />  {/* 18 Premium: Grad */}
            <col className="w-[9rem]" />  {/* 19 Premium: 4th Prep */}
            <col className="w-[9rem]" />  {/* 20 Premium: Overload */}
            <col className="w-[28rem]" /> {/* 21 Remarks */}
          </colgroup>

          <thead className="text-xs">
            <tr className="bg-gray-50 text-gray-700 text-center border-b">
              <th rowSpan={2} className="px-3 py-2 font-semibold whitespace-nowrap">
                Rank
              </th>
              <th rowSpan={2} className="px-3 py-2 font-semibold text-left whitespace-nowrap">
                Faculty
              </th>
              <th rowSpan={2} className="px-3 py-2 font-semibold whitespace-nowrap">
                Course
              </th>
              <th rowSpan={2} className="px-3 py-2 font-semibold whitespace-nowrap">
                Section
              </th>
              <th rowSpan={2} className="px-3 py-2 font-semibold whitespace-nowrap">
                Day
              </th>
              <th rowSpan={2} className="px-3 py-2 font-semibold whitespace-nowrap">
                Time
              </th>
              <th rowSpan={2} className="px-3 py-2 font-semibold whitespace-nowrap">
                Room
              </th>
              <th rowSpan={2} className="px-2 py-2 font-semibold whitespace-nowrap">
                No. of Students
              </th>
              <th rowSpan={2} className="px-2 py-2 font-semibold whitespace-nowrap">
                Lecture Hours
              </th>
              <th rowSpan={2} className="px-2 py-2 font-semibold whitespace-nowrap">
                Lab Hours
              </th>
              <th rowSpan={2} className="px-2 py-2 font-semibold whitespace-nowrap">
                Student Unit(s)
              </th>
              <th rowSpan={2} className="px-2 py-2 font-semibold whitespace-nowrap">
                On Leave
              </th>
              <th rowSpan={2} className="px-2 py-2 font-semibold whitespace-nowrap">
                Type of Course
              </th>
              <th colSpan={4} className="px-3 py-2 font-semibold border-l border-gray-300">
                NATURE OF LOAD
              </th>
              <th colSpan={3} className="px-3 py-2 font-semibold border-l border-gray-300">
                PREMIUMS
              </th>
              <th rowSpan={2} className="px-3 py-2 font-semibold">
                Remarks
              </th>
            </tr>
            <tr className="bg-gray-50 text-gray-700 text-center border-b">
              <th className="px-2 py-2 font-semibold whitespace-nowrap">Teaching</th>
              <th className="px-2 py-2 font-semibold whitespace-nowrap">Admin</th>
              <th className="px-2 py-2 font-semibold whitespace-nowrap">Research</th>
              <th className="px-2 py-2 font-semibold whitespace-nowrap">Faculty Unit(s)</th>
              <th className="px-2 py-2 font-semibold whitespace-nowrap">Grad Load</th>
              <th className="px-2 py-2 font-semibold whitespace-nowrap">Premium 4th Prep</th>
              <th className="px-2 py-2 font-semibold whitespace-nowrap">Overload (NCA)</th>
            </tr>
          </thead>

          <tbody className="divide-y text-center">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={21} className="py-8 text-sm text-gray-500">
                  No plantilla rows to display.
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.rank ?? ""}</td>
                  <td className="text-left font-medium text-emerald-700">
                    {r.faculty_name || "—"}
                  </td>
                  <td>{r.course_code || "—"}</td>
                  <td>{r.section_code || "—"}</td>
                  <td>
                    <DayCell raw={r.day_text || "—"} />
                  </td>
                  <td>{r.time_text || "—"}</td>
                  <td>{r.room_text || "—"}</td>
                  <td>{r.student_count ?? "—"}</td>
                  <td>{r.lec_hours ?? "—"}</td>
                  <td>{r.lab_hours ?? "—"}</td>
                  <td>{r.student_units ?? "—"}</td>
                  <td>{r.on_leave || "N/A"}</td>
                  <td>{r.course_type || "N/A"}</td>
                  <td>{r.nature_teaching ?? "—"}</td>
                  <td>{r.nature_admin ?? "—"}</td>
                  <td>{r.nature_research ?? "—"}</td>
                  <td>{r.nature_faculty_units ?? "—"}</td>
                  <td>{r.premium_grad ?? "—"}</td>
                  <td>{r.premium_4th_prep ?? "—"}</td>
                  <td>{r.premium_overload ?? "—"}</td>
                  <td className="text-left">{r.remarks || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

/* ---------------- Page shell (new nav + data fetch) ---------------- */
export default function CHAIR_Plantilla() {
  // pull name/role just like OM does (localStorage)
  const session = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("animo.user") || "null");
    } catch {
      return null;
    }
  }, []);

  // Make a robust display name from the session data (mirror OM)
  const displayName = useMemo(() => {
    const s = session || {};
    // accept either camelCase or snake_case from localStorage
    const first = (s.firstName ?? s.first_name ?? "").toString().trim();
    const middle = (s.middleName ?? s.middle_name ?? "").toString().trim();
    const last = (s.lastName ?? s.last_name ?? "").toString().trim();
    const rawFull = normalizeCommaName((s.fullName ?? s.full_name ?? "").toString().trim());

    // Prefer a true full name (≥2 words) from storage
    if (hasTwoWords(rawFull)) return rawFull;

    // Else compose from parts; ensures last name appears
    const composed = [first, middle, last].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return composed || rawFull || " ";
  }, [session]);

  const userId = session?.userId || "";
  const canSwitchToFaculty = userHasRole("faculty");

  const loc = useLocation();
  const isRootChair = /^\/chair(\/home)?$/.test(loc.pathname);
  const isPlantilla = /^\/chair\/plantilla$/.test(loc.pathname);
  const navigate = useNavigate();

  // header/profile from backend
  const [header, setHeader] = useState<HeaderResp>({
    ok: true,
    profileName: displayName || " ",
    profileSubtitle: "Department Chair",
  });

  // plantilla rows (DB-backed)
  const [rows, setRows] = useState<PlantillaRow[]>([]);

  // topbar inbox behavior (same event OM uses)
  useEffect(() => {
    const toInbox = () => navigate("/chair/inbox");
    window.addEventListener("om:openInbox" as any, toInbox);
    return () => window.removeEventListener("om:openInbox" as any, toInbox);
  }, [navigate]);

  // default landing
  useEffect(() => {
    if (isRootChair) navigate("/chair/plantilla", { replace: true });
  }, [isRootChair, navigate]);

  // fetch header + plantilla rows
  useEffect(() => {
    (async () => {
      try {
        const params = new URLSearchParams();
        if (userId) params.set("userId", userId);
        params.set("action", "header");

        const rh = await fetch(`/api/chair/plantilla?${params.toString()}`);
        const hdr: HeaderResp = await rh.json();

        if (hdr?.ok) {
          setHeader((prev) => {
            // accept server-provided full name variants; normalize "Last, First"
            const serverFull = normalizeCommaName(
              String((hdr as any).profileName ?? (hdr as any).full_name ?? "")
            );

            // Pick the best available:
            // 1) Server full name if it looks complete (≥2 words)
            // 2) LocalStorage-computed displayName (already normalized)
            // 3) Previous header name / a single space
            const bestName = hasTwoWords(serverFull)
              ? serverFull
              : hasTwoWords(displayName)
              ? displayName
              : serverFull || displayName || prev.profileName || " ";

            return {
              ...prev,
              ...hdr,
              profileName: bestName,
            };
          });
        }
      } catch {
        /* non-blocking */
      }

      try {
        const params = new URLSearchParams();
        if (userId) params.set("userId", userId);
        params.set("action", "fetch");
        const rr = await fetch(`/api/chair/plantilla?${params.toString()}`);
        const data = await rr.json();
        if (data?.ok && Array.isArray(data.rows)) setRows(data.rows as PlantillaRow[]);
      } catch {
        setRows([]);
      }
    })();
  }, [userId, displayName]);

  const switchToFaculty = () => {
    setActiveRole("faculty");
    navigate("/faculty/overview");
  };

  return (
    <AppShell
      topbarProfileName={header.profileName || " "}
      topbarProfileSubtitle={header.profileSubtitle || " "}
      sidebarItems={ITEMS}
    >
      {/* Floating switch button */}
      {canSwitchToFaculty && (
        <button
          onClick={switchToFaculty}
          title="Switch to faculty view"
          className="fixed right-4 top-[72px] z-40 rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-emerald-400"
        >
          Switch to Faculty View
        </button>
      )}

      {/* Children */}
      <Outlet />

      {/* Plantilla tab content (OM-like header + data table) */}
      {isPlantilla && (
        <main className="w-full px-8 py-8">
          <header className="mb-6 flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold">Plantilla</h1>
              <p className="text-sm text-gray-600">
                Manage and review faculty plantilla submissions
              </p>
            </div>
          </header>

          <DepartmentPlantilla
            deptLabel={header.dept_label || "Department"}
            plantillaFile={header.plantilla_file || "Faculty_Plantilla.xls"}
            rows={rows}
            termLabel={header.term_label}
          />
        </main>
      )}
    </AppShell>
  );
}
