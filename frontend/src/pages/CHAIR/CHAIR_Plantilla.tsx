import React, { useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import AppShell from "@/base/AppShell";
import type { SidebarItem } from "@/base/Sidebar";
import { Users, BookOpen, FileText, FilePlus, BookMarked, ListChecks, FileSpreadsheet, ClipboardList, Star } from "lucide-react";

function ClipboardStarIcon({
  size = 18,
  className = "",
}: {
  size?: string | number;
  className?: string;
}) {
  const nSize = typeof size === "number" ? size : Number(size) || 18;
  const starSize = Math.max(10, Math.round(nSize * 0.55));

  return (
    <span className={cls("relative inline-flex items-center justify-center", className)}>
      <ClipboardList size={size} className="opacity-95" />
      <Star size={starSize} className="absolute -right-1 -bottom-1" fill="currentColor" />
    </span>
  );
}

/* ---------------- Sidebar ---------------- */
const ITEMS: SidebarItem[] = [
  { label: "Plantilla", to: "/chair/plantilla", Icon: ListChecks },
  { label: "Faculty Directory", to: "/chair/faculty-management", Icon: Users },
  { label: "Course Management", to: "/chair/course-management", Icon: BookOpen },
  { label: "Faculty Service", to: "/chair/faculty-service", Icon: FileText },
  { label: "Student Petition", to: "/chair/student-petitions", Icon: FilePlus },
  { label: "Special Class", to: "/chair/special-class", Icon: ClipboardStarIcon },
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
    .replace(/^\s*([^,]+),\s*(.+)\s*$/, "$2 $1")
    .replace(/\s+/g, " ")
    .trim();

const hasTwoWords = (n: string) => /\S+\s+\S+/.test(n);

const normalizeDept = (s: string) =>
  (s || "")
    .toLowerCase()
    .replace(/department\s+of\s+/g, "") // remove "department of"
    .replace(/[^a-z]/g, ""); // letters only (kills spaces/punct/typos like extra spaces)

/* ---------------- Types ---------------- */
type PlantillaRow = {
  rank?: string;
  faculty_name: string;
  course_code: string;
  section_code: string;
  day_text: string;
  time_text: string;
  room_text: string;
  student_count: number | null;
  lec_hours: number | null;
  lab_hours: number | null;
  student_units: number | null;
  on_leave: string;
  course_type: string;
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

/* ---------------- Table ---------------- */
const DepartmentPlantilla: React.FC<{
  deptLabel: string;
  plantillaFile: string;
  rows: PlantillaRow[];
  termLabel?: string;
}> = ({ deptLabel, plantillaFile, rows, termLabel }) => {
  const tableRef = useRef<HTMLTableElement | null>(null);

  const safeExcelFilename =
    (plantillaFile && plantillaFile.replace(/\.pdf$/i, ".xls")) || "Faculty_Plantilla.xls";

  const handleExportExcel = () => {
    if (!rows || rows.length === 0) {
      alert("No plantilla rows to export.");
      return;
    }

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

    const normalizeForExcel = (value: string) => {
      let v = value ?? "";
      if (v === "—") v = "";
      v = v
        .replace(/[\u2012\u2013\u2014\u2015]/g, "-")
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u00A0/g, " ")
        .replace(/[\r\n\t]/g, " ");
      v = v.replace(/\s+/g, " ").trim();
      return v;
    };

    const esc = (v: string) =>
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    let html = '<html><head><meta charset="utf-8" /></head><body><table><thead><tr>';
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

  return (
    <section className="mt-6 flex flex-col">
      <header className="mb-2">
        <h2 className="text-xl font-semibold">
          Department Faculty Plantilla of {deptLabel} {termLabel ? ` · ${termLabel}` : ""}
        </h2>
      </header>

      <div className="mt-4 flex items-center justify-end gap-3">
        <button
          onClick={handleExportExcel}
          className={cls(
            "inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium text-white",
            "bg-blue-600 hover:brightness-110"
          )}
          title="Export plantilla as Excel (.xls)"
        >
          <FileSpreadsheet className="h-4 w-4" />
          Export Excel
        </button>
      </div>

      <div className="mt-3 flex-1 min-h-[320px] h-[calc(100vh-280px)] max-h-[calc(100vh-280px)] overflow-x-auto overflow-y-auto rounded-xl border border-gray-300 bg-white shadow-sm">
        <table
          ref={tableRef}
          className="min-w-full w-full text-sm table-fixed border-collapse leading-snug [&_td]:align-top [&_td]:whitespace-normal [&_td]:break-words"
        >
          <colgroup>
            <col className="w-[5rem]" />
            <col className="w-[14rem]" />
            <col className="w-[7.5rem]" />
            <col className="w-[6rem]" />
            <col className="w-[6.5rem]" />
            <col className="w-[8rem]" />
            <col className="w-[7rem]" />
            <col className="w-[8rem]" />
            <col className="w-[7rem]" />
            <col className="w-[6.5rem]" />
            <col className="w-[8rem]" />
            <col className="w-[6.5rem]" />
            <col className="w-[8rem]" />
            <col className="w-[6.5rem]" />
            <col className="w-[6.5rem]" />
            <col className="w-[7rem]" />
            <col className="w-[8rem]" />
            <col className="w-[7rem]" />
            <col className="w-[9rem]" />
            <col className="w-[9rem]" />
            <col className="w-[28rem]" />
          </colgroup>

          <thead className="bg-gray-50 text-emerald-800 sticky top-0 z-10 text-xs">
            <tr className="whitespace-nowrap text-[13px] font-semibold">
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                Rank
              </th>
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                Faculty
              </th>
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                Course
              </th>
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                Section
              </th>
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                Day
              </th>
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                Time
              </th>
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                Room
              </th>
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                No. of Students
              </th>
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                Lecture Hours
              </th>
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                Lab Hours
              </th>
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                Student Unit(s)
              </th>
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                On Leave
              </th>
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                Type of Course
              </th>
              <th colSpan={4} className="px-3 py-2 text-center border border-gray-300">
                NATURE OF LOAD
              </th>
              <th colSpan={3} className="px-3 py-2 text-center border border-gray-300">
                PREMIUMS
              </th>
              <th rowSpan={2} className="px-3 py-2 text-center border border-gray-300">
                Remarks
              </th>
            </tr>
            <tr className="whitespace-nowrap text-[13px] font-semibold">
              <th className="px-3 py-2 text-center border border-gray-300">Teaching</th>
              <th className="px-3 py-2 text-center border border-gray-300">Admin</th>
              <th className="px-3 py-2 text-center border border-gray-300">Research</th>
              <th className="px-3 py-2 text-center border border-gray-300">Faculty Unit(s)</th>
              <th className="px-3 py-2 text-center border border-gray-300">Grad Load</th>
              <th className="px-3 py-2 text-center border border-gray-300">Premium 4th Prep</th>
              <th className="px-3 py-2 text-center border border-gray-300">Overload (NCA)</th>
            </tr>
          </thead>

          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={21} className="px-4 py-10 text-center text-sm text-gray-500">
                  No plantilla to display.
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={i} className="hover:bg-gray-50 [&>td]:border [&>td]:border-gray-200">
                  <td className="px-3 py-2 text-center">{r.rank ?? ""}</td>
                  <td className="px-3 py-2 text-left font-semibold text-emerald-700">
                    {r.faculty_name || "—"}
                  </td>
                  <td className="px-3 py-2 text-center">{r.course_code || "—"}</td>
                  <td className="px-3 py-2 text-center">{r.section_code || "—"}</td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">
                    <DayCell raw={r.day_text || "—"} />
                  </td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">{r.time_text || "—"}</td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">{r.room_text || "—"}</td>
                  <td className="px-3 py-2 text-center">{r.student_count ?? "—"}</td>
                  <td className="px-3 py-2 text-center">{r.lec_hours ?? "—"}</td>
                  <td className="px-3 py-2 text-center">{r.lab_hours ?? "—"}</td>
                  <td className="px-3 py-2 text-center">{r.student_units ?? "—"}</td>
                  <td className="px-3 py-2 text-center">{r.on_leave || "N/A"}</td>
                  <td className="px-3 py-2 text-center">{r.course_type || "N/A"}</td>
                  <td className="px-3 py-2 text-center">{r.nature_teaching ?? "—"}</td>
                  <td className="px-3 py-2 text-center">{r.nature_admin ?? "—"}</td>
                  <td className="px-3 py-2 text-center">{r.nature_research ?? "—"}</td>
                  <td className="px-3 py-2 text-center">{r.nature_faculty_units ?? "—"}</td>
                  <td className="px-3 py-2 text-center">{r.premium_grad ?? "—"}</td>
                  <td className="px-3 py-2 text-center">{r.premium_4th_prep ?? "—"}</td>
                  <td className="px-3 py-2 text-center">{r.premium_overload ?? "—"}</td>
                  <td className="px-3 py-2 text-left align-top whitespace-normal break-words">
                    {r.remarks || "—"}
                  </td>
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
  const session = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("animo.user") || "null");
    } catch {
      return null;
    }
  }, []);

  const displayName = useMemo(() => {
    const s = session || {};
    const first = (s.firstName ?? s.first_name ?? "").toString().trim();
    const middle = (s.middleName ?? s.middle_name ?? "").toString().trim();
    const last = (s.lastName ?? s.last_name ?? "").toString().trim();
    const rawFull = normalizeCommaName((s.fullName ?? s.full_name ?? "").toString().trim());
    if (hasTwoWords(rawFull)) return rawFull;
    const composed = [first, middle, last].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return composed || rawFull || " ";
  }, [session]);

  const userId = session?.userId || "";

  const loc = useLocation();
  const isRootChair = /^\/chair(\/home)?$/.test(loc.pathname);
  const isPlantilla = /^\/chair\/plantilla$/.test(loc.pathname);
  const navigate = useNavigate();

  const [header, setHeader] = useState<HeaderResp>({
    ok: true,
    profileName: displayName || " ",
    profileSubtitle: "Department Chair",
  });

  const [rows, setRows] = useState<PlantillaRow[]>([]);

  // allow only Department of Software Technology
  const isSoftwareTechnology = useMemo(() => {
    const d = normalizeDept(header.dept_label || "");
    return d.includes("softwaretechnology");
  }, [header.dept_label]);

  useEffect(() => {
    const toInbox = () => navigate("/chair/inbox");
    window.addEventListener("om:openInbox" as any, toInbox);
    return () => window.removeEventListener("om:openInbox" as any, toInbox);
  }, [navigate]);

  useEffect(() => {
    if (isRootChair) navigate("/chair/plantilla", { replace: true });
  }, [isRootChair, navigate]);

  // fetch header (department label comes from here)
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
            const serverFull = normalizeCommaName(
              String((hdr as any).profileName ?? (hdr as any).full_name ?? "")
            );
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
    })();
  }, [userId, displayName]);

  // fetch rows ONLY if Software Technology
  useEffect(() => {
    (async () => {
      if (!userId) {
        setRows([]);
        return;
      }

      if (!isSoftwareTechnology) {
        setRows([]);
        return;
      }

      try {
        const params = new URLSearchParams();
        params.set("userId", userId);
        params.set("action", "fetch");

        const rr = await fetch(`/api/chair/plantilla?${params.toString()}`);
        const data = await rr.json();
        if (data?.ok && Array.isArray(data.rows)) setRows(data.rows as PlantillaRow[]);
        else setRows([]);
      } catch {
        setRows([]);
      }
    })();
  }, [userId, isSoftwareTechnology]);

  return (
    <AppShell
      topbarProfileName={header.profileName || " "}
      topbarProfileSubtitle={header.profileSubtitle || " "}
      sidebarItems={ITEMS}
    >
      <Outlet />

      {isPlantilla && (
        <main className="w-full h-[calc(100vh-64px)] px-4 md:px-8 py-6 md:py-8 flex flex-col">
          <header className="mb-6 flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold">Plantilla</h1>
              <p className="text-sm text-gray-600">Manage and review faculty plantilla submissions</p>
            </div>
          </header>

          <div className="flex-1 min-h-0">
            {isSoftwareTechnology ? (
              <DepartmentPlantilla
                deptLabel={header.dept_label || "Department"}
                plantillaFile={header.plantilla_file || "Faculty_Plantilla.xls"}
                rows={rows}
                termLabel={header.term_label}
              />
            ) : (
              <div className="h-full w-full rounded-xl border border-gray-300 bg-white shadow-sm flex items-center justify-center p-8">
                <div className="max-w-xl text-center">
                  <h2 className="text-xl font-semibold text-gray-400">Plantilla not available</h2>
                </div>
              </div>
            )}
          </div>
        </main>
      )}
    </AppShell>
  );
}
