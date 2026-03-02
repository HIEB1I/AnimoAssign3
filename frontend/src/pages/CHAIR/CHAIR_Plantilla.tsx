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
  FileSpreadsheet,
  ClipboardList,
  Star,
  Search as SearchIcon,
  X,
} from "lucide-react";

import SelectBox from "../../component/SelectBox";


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
  { label: "Load Assignment", to: "/chair/load-assignment", Icon: FileSpreadsheet },
  { label: "Faculty Directory", to: "/chair/faculty-management", Icon: Users },
  { label: "Course Management", to: "/chair/course-management", Icon: BookOpen },
  { label: "Faculty Service", to: "/chair/faculty-service", Icon: FileText },
  { label: "Student Petition", to: "/chair/student-petitions", Icon: FilePlus },
  { label: "Special Class", to: "/chair/special-class", Icon: ClipboardStarIcon },
  { label: "Class Retention", to: "/chair/class-retention", Icon: BookMarked },

];

/* ---------------- Utilities ---------------- */
const cls = (...s: (string | false | null | undefined)[]) => s.filter(Boolean).join(" ");

const normalizeDayLines = (s: string) => {
  const toks = (s || "")
    .toUpperCase()
    // Keep common separators but split into day tokens.
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

  const lines = toks.map((t) => map[t] ?? t.charAt(0));
  // Remove consecutive duplicates just in case the raw string is weird.
  return lines.filter((v, idx) => v && (idx === 0 || v !== lines[idx - 1]));
};

const MultiLineCell: React.FC<{ lines: string[]; raw?: string }> = ({ lines, raw }) => {
  const safe = (lines || []).map((l) => String(l || "").trim()).filter(Boolean);
  if (safe.length === 0) return <span data-raw={raw}>—</span>;

  return (
    <span data-raw={raw} className="inline-block leading-tight">
      {safe.map((l, idx) => (
        <div key={idx}>{l}</div>
      ))}
    </span>
  );
};

const DayCell: React.FC<{ raw: string }> = ({ raw }) => (
  <MultiLineCell raw={raw} lines={normalizeDayLines(raw)} />
);

const TimeCell: React.FC<{ raw: string }> = ({ raw }) => {
  const parts = String(raw || "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  return <MultiLineCell raw={raw} lines={parts} />;
};

const RoomCell: React.FC<{ raw: string }> = ({ raw }) => {
  const parts = String(raw || "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  return <MultiLineCell raw={raw} lines={parts} />;
};

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
  // Distinguish rows mirrored from OM_SpecialClass.
  source?: string | null; // e.g., "SPECIALCLASS"
  source_id?: string | null;
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
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  type FilterMode = "ALL" | "REGULAR" | "SPECIAL";
  const [filterMode, setFilterMode] = useState<FilterMode>("ALL");

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const filterOptions = useMemo(
    () => ["All Classes", "Regular Classes", "Special Classes"],
    []
  );

  const filterValueLabel =
    filterMode === "ALL"
      ? "All Classes"
      : filterMode === "REGULAR"
        ? "Regular Classes"
        : "Special Classes";

  const filteredRows = useMemo(() => {
    const q = (search || "").toLowerCase();
    const base = (rows || []).filter((r) => {
      if (filterMode === "SPECIAL") return r.source === "SPECIALCLASS";
      if (filterMode === "REGULAR") return r.source !== "SPECIALCLASS";
      return true;
    });

    if (!q) return base;
    return base.filter((r) => {
      const name = String(r.faculty_name || "").toLowerCase();
      const course = String(r.course_code || "").toLowerCase();
      const section = String(r.section_code || "").toLowerCase();
      return name.includes(q) || course.includes(q) || section.includes(q);
    });
  }, [rows, search, filterMode]);

  const safeExcelFilename =
    (plantillaFile && plantillaFile.replace(/\.pdf$/i, ".xls")) || "Faculty_Plantilla.xls";

  const handleExportExcel = () => {
    if (!filteredRows || filteredRows.length === 0) {
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

    // IMPORTANT: Export exactly what is currently visible in the table.
    // This guarantees the Excel export respects the active filter (e.g., Special Classes)
    // and the active search input.
    const dataRows = (() => {
      const table = tableRef.current;
      const bodyRows = table?.querySelectorAll("tbody tr") ?? [];

      const visible: string[][] = [];
      bodyRows.forEach((tr) => {
        const tds = Array.from(tr.querySelectorAll("td"));
        // Skip the empty-state row (it uses a single cell with colSpan).
        if (tds.length < headers.length) return;
        visible.push(
          tds.slice(0, headers.length).map((td, idx) => {
            const el = td as HTMLElement;
            // Preserve visible line breaks for Day / Time / Room.
            const raw =
              idx === 4 || idx === 5 || idx === 6
                ? (el.innerText || el.textContent || "")
                : (td.textContent || "");
            return String(raw || "").trim();
          })
        );
      });

      if (visible.length > 0) return visible;

      // Fallback: if DOM isn't available for some reason, export from filteredRows.
      return filteredRows.map((r) => [
        String(r.rank ?? ""),
        String(r.faculty_name || ""),
        String(r.course_code || ""),
        String(r.section_code || ""),
        normalizeDayLines(String(r.day_text || "")).join("\n"),
        String(r.time_text || "")
          .split("/")
          .map((p) => p.trim())
          .filter(Boolean)
          .join("\n"),
        String(r.room_text || "")
          .split("/")
          .map((p) => p.trim())
          .filter(Boolean)
          .join("\n"),
        String(r.student_count ?? ""),
        String(r.lec_hours ?? ""),
        String(r.lab_hours ?? ""),
        String(r.student_units ?? ""),
        String(r.on_leave || ""),
        String(r.course_type || ""),
        String(r.nature_teaching ?? ""),
        String(r.nature_admin ?? ""),
        String(r.nature_research ?? ""),
        String(r.nature_faculty_units ?? ""),
        String(r.premium_grad ?? ""),
        String(r.premium_4th_prep ?? ""),
        String(r.premium_overload ?? ""),
        String(r.remarks || ""),
      ]);
    })();

    const normalizeForExcel = (value: string, preserveNewlines: boolean) => {
      let v = value ?? "";
      if (v === "—") v = "";

      // Normalize common typography to ASCII so Excel doesn't choke.
      v = v
        .replace(/[\u2012\u2013\u2014\u2015]/g, "-")
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u00A0/g, " ");

      if (preserveNewlines) {
        // Keep line breaks (Day/Time/Room) exactly as displayed.
        v = v.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, " ");
        v = v
          .split("\n")
          .map((line) => line.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join("\n");
        return v;
      }

      // For other cells, collapse whitespace and remove line breaks.
      v = v.replace(/[\r\n\t]/g, " ");
      v = v.replace(/\s+/g, " ").trim();
      return v;
    };

    const esc = (v: string) =>
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // NOTE: Excel HTML export needs explicit styles.
    // Target look: 1 boxed "group" per faculty (like the plantilla screenshot)
    // - Rank + Faculty are vertically merged (rowspan) per faculty
    // - Vertical column dividers stay visible
    // - No per-row horizontal borders inside a faculty group (only top + bottom)
    const excelCss = `
      table{border-collapse:collapse;}
      th{border:2px solid #000;padding:4px;font-weight:700;text-align:center;vertical-align:top;}
      td{padding:4px;vertical-align:top;border-left:1px solid #000;border-right:1px solid #000;}
    `;

    // Determine per-faculty groups based on the visible table rows.
    // The Faculty column may be blank on continuation rows (to mimic merged cells),
    // so we carry-forward the last non-empty faculty value.
    const facultyKeyByRow: string[] = [];
    let lastFaculty = "";
    dataRows.forEach((r) => {
      const rawFaculty = String((r?.[1] ?? "") as string).trim();
      if (rawFaculty) lastFaculty = rawFaculty;
      facultyKeyByRow.push(lastFaculty);
    });

    const isGroupStart = (rowIdx: number) => rowIdx === 0 || facultyKeyByRow[rowIdx] !== facultyKeyByRow[rowIdx - 1];

    const isGroupEnd = (rowIdx: number) =>
      rowIdx === facultyKeyByRow.length - 1 || facultyKeyByRow[rowIdx] !== facultyKeyByRow[rowIdx + 1];

    const groupRowSpan = (startIdx: number) => {
      const key = facultyKeyByRow[startIdx];
      let span = 1;
      for (let i = startIdx + 1; i < facultyKeyByRow.length; i++) {
        if (facultyKeyByRow[i] !== key) break;
        span++;
      }
      return span;
    };

    const cellBorderStyle = (rowIdx: number, colIdx: number, colCount: number) => {
      const start = isGroupStart(rowIdx);
      const end = isGroupEnd(rowIdx);
      const firstCol = colIdx === 0;
      const lastCol = colIdx === colCount - 1;

      const parts: string[] = [];
      if (start) parts.push("border-top:2px solid #000");
      if (end) parts.push("border-bottom:2px solid #000");
      if (firstCol) parts.push("border-left:2px solid #000");
      if (lastCol) parts.push("border-right:2px solid #000");

      return parts.join(";");
    };

    let html =
      '<html><head><meta charset="utf-8" />' +
      `<style>${excelCss}</style>` +
      '</head><body><table><thead><tr>';
    headers.forEach((h) => {
      html += `<th>${esc(String(h))}</th>`;
    });
    html += "</tr></thead><tbody>";

    for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
      const row = dataRows[rowIdx];
      const start = isGroupStart(rowIdx);

      html += "<tr>";

      // Merge Rank + Faculty per faculty group (rowspan) to match the plantilla screenshot.
      if (start) {
        const span = groupRowSpan(rowIdx);

        // Rank (col 0)
        {
          const idx = 0;
          const raw = row?.[idx] == null ? "" : String(row[idx]);
          const normalized = normalizeForExcel(raw, false);
          const safe = esc(normalized);
          // For merged cells, force both top+bottom borders so the group box closes.
          const parts: string[] = ["border-top:2px solid #000", "border-bottom:2px solid #000", "border-left:2px solid #000"];
          const borderStyle = parts.join(";");
          const extraStyle = `${borderStyle};`;
          html += `<td rowspan="${span}" style="${extraStyle}">${safe}</td>`;
        }

        // Faculty (col 1)
        {
          const idx = 1;
          const raw = row?.[idx] == null ? "" : String(row[idx]);
          const normalized = normalizeForExcel(raw, false);
          const safe = esc(normalized);
          // For merged cells, force both top+bottom borders so the group box closes.
          const parts: string[] = ["border-top:2px solid #000", "border-bottom:2px solid #000"];
          const borderStyle = parts.join(";");
          const extraStyle = `${borderStyle};`;
          html += `<td rowspan="${span}" style="${extraStyle}">${safe}</td>`;
        }
      }

      // Remaining columns always render per-row.
      for (let idx = 2; idx < headers.length; idx++) {
        const cell = row?.[idx];
        const raw = cell == null ? "" : String(cell);
        const preserveNewlines = idx === 4 || idx === 5 || idx === 6; // Day / Time / Room
        const normalized = normalizeForExcel(raw, preserveNewlines);
        const safe = preserveNewlines ? esc(normalized).replace(/\n/g, "<br/>") : esc(normalized);

        const borderStyle = cellBorderStyle(rowIdx, idx, headers.length);
        const extraStyle = borderStyle ? `${borderStyle};` : "";

        html += preserveNewlines
          ? `<td style="white-space:pre-wrap;${extraStyle}">${safe}</td>`
          : `<td style="${extraStyle}">${safe}</td>`;
      }

      html += "</tr>";
    }

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

      {/* Search / Export bar (match Course Management search styling) */}
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="relative flex-1 min-w-[240px]">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            ref={searchInputRef}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search faculty, course, or section…"
            className="w-full rounded-lg border border-gray-300 pl-9 pr-10 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
          />

          {/* Clear (x) button */}
          {searchInput.trim().length > 0 && (
            <button
              type="button"
              onClick={() => {
                setSearchInput("");
                setSearch("");
                searchInputRef.current?.focus();
              }}
              className={cls(
                "absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1",
                "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
              )}
              aria-label="Clear search"
              title="Clear"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Filter: Special vs Regular (match CHAIR_FacultyManagement filters) */}
        <div className="min-w-[200px]">
          <SelectBox
            value={filterValueLabel}
            onChange={(v) => {
              const next = (v || "All Classes").toLowerCase();
              if (next.includes("special")) setFilterMode("SPECIAL");
              else if (next.includes("regular")) setFilterMode("REGULAR");
              else setFilterMode("ALL");
            }}
            options={filterOptions}
          />
        </div>

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

          {/* Keep sticky header below global overlays (e.g., topbar notifications) */}
          <thead className="bg-gray-50 text-emerald-800 sticky top-0 z-[1] text-xs">
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
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={21} className="px-4 py-10 text-center text-sm text-gray-500">
                  {rows.length === 0 ? "No plantilla to display." : "No matching results."}
                </td>
              </tr>
            ) : (
              filteredRows.map((r, i) => (
                <tr
                  key={i}
                  className={cls(
                    "hover:bg-gray-50 [&>td]:border [&>td]:border-gray-200",
                    r.source === "SPECIALCLASS" && "bg-purple-50"
                  )}
                >
                  <td className="px-3 py-2 text-center">{r.rank ?? ""}</td>
                  <td className="px-3 py-2 text-left font-semibold text-emerald-700">
                    {(() => {
                      // Display the faculty name only once for a contiguous block of the same faculty,
                      // to avoid redundant repeated names in the table.
                      const prev = filteredRows[i - 1];
                      const prevName = String(prev?.faculty_name || "").trim().toLowerCase();
                      const curName = String(r.faculty_name || "").trim().toLowerCase();
                      const show = i === 0 || prevName !== curName;
                      if (!curName) return "—";
                      return show ? r.faculty_name : "";
                    })()}
                  </td>
                  <td className="px-3 py-2 text-center">{r.course_code || "—"}</td>
                  <td className="px-3 py-2 text-center">{r.section_code || "—"}</td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">
                    <DayCell raw={r.day_text || "—"} />
                  </td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">
                    <TimeCell raw={r.time_text || "—"} />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <RoomCell raw={r.room_text || ""} />
                  </td>
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

            const dept = String(
              (hdr as any).dept_label ??
                (hdr as any).dept_name ??
                (hdr as any).department ??
                ""
            ).trim();

            // Mirror OM TopBar behavior: ensure subtitle includes "Role | Dept" exactly once
            const baseSub = String((hdr as any).profileSubtitle ?? prev.profileSubtitle ?? "").trim();
            let nextSub = baseSub;
            if (dept) {
              const subLower = nextSub.toLowerCase();
              const deptLower = dept.toLowerCase();
              if (!subLower.includes(deptLower)) {
                nextSub = nextSub ? `${nextSub} | ${dept}` : dept;
              }
            }

            return {
              ...prev,
              ...hdr,
              profileName: bestName,
              profileSubtitle: nextSub || prev.profileSubtitle,
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
