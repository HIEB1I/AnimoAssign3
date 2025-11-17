// frontend/src/pages/CHAIR/CHAIR_ClassRetention.tsx
import OM_ClassRetention from "../OM/OM_ClassRetention";
import { Download } from "lucide-react";
import * as XLSX from "xlsx";
import type { OMCRRow } from "../../api";

// Utility: convert current rows → XLSX and download
function exportClassRetentionToXlsx(rows: OMCRRow[]) {
  if (!rows.length) return;

  const data = rows.map((r) => ({
    Term: r.term_label ?? "",
    "Course Code": r.course_code ?? "",
    "Course Title": r.course_title ?? "",
    Section: r.section_code ?? "",
    Faculty: r.faculty_name ?? "",
    Enrolled: r.enrolled ?? "",
    "Student Units": r.student_units ?? "",
    "Faculty Units": r.faculty_units ?? "",
    Status: r.status ?? "",
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "Class Retention");

  XLSX.writeFile(wb, "class_retention.xlsx");
}

export default function CHAIR_ClassRetention() {
  return (
    <OM_ClassRetention
      renderExtraActions={({ rows, loading }) => (
        <button
          type="button"
          disabled={loading || !rows.length}
          onClick={() => exportClassRetentionToXlsx(rows)}
          className="inline-flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 shadow-sm hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download className="h-4 w-4" />
          Export XLSX
        </button>
      )}
    />
  );
}
