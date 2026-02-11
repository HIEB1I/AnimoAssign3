// OM_desc.tsx — Descriptive Reports: Faculty Teaching History (pattern-aligned to OM_Profile)
//
// This page follows the same simple functional pattern as OM_Profile (load functions from ../../api,
// local component state, minimal styling) and focuses solely on a search-based view of a faculty
// member's teaching history.
//
// Endpoints expected (FastAPI):
//   GET /teaching-history?faculty_id=<ID>  -> { faculty_id, count, rows: [...] }
//
// Frontend dependency:
//   - api.ts must export: `export async function fetchTeachingHistory(facultyId: string)`
//     which returns `{ rows: TeachingHistoryRow[] }`.
//
// Usage:
//   - Add a route to this page (e.g., /om/desc) and render <OM_DescPage />.

import React, { useState } from "react";
import { Link } from "react-router-dom";
import { fetchTeachingHistory } from "../../api";

// -----------------------------
// Type definitions
// -----------------------------
type Schedule = {
  day: string;
  start_time: string;
  end_time: string;
  room?: string;
  room_type?: string | null;
};

type TeachingHistoryRow = {
  term_name?: string;
  course_code?: string;
  course_title?: string;
  section_code?: string;
  units?: number;
  modality?: string;
  campus_id?: string;
  schedule: Schedule[];
};

// -----------------------------
// Page Component
// -----------------------------
export default function OM_DescPage() {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Descriptive Reports</h1>
        <Link to="/om/home">← Back to OM Home</Link>
      </div>

      {/* Teaching history search */}
      <TeachingHistorySearch />
    </div>
  );
}

// -----------------------------
// Teaching History Search Widget
// -----------------------------
export function TeachingHistorySearch() {
  const [facultyId, setFacultyId] = useState("");
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<TeachingHistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRows([]);

    const id = facultyId.trim();
    if (!id) {
      setError("Enter a faculty ID.");
      return;
    }

    setLoading(true);
    try {
      const data = await fetchTeachingHistory(id);
      setRows(data?.rows ?? []);
    } catch (err: any) {
      setError(err?.message || "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
        Teaching History — Search by Faculty ID
      </div>

      {/* Search form */}
      <form
        onSubmit={onSearch}
        style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}
      >
        <input
          value={facultyId}
          onChange={(e) => setFacultyId(e.target.value)}
          placeholder="e.g., F000123"
          style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #d1d5db", minWidth: 220 }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid #22c55e",
            background: loading ? "#a7f3d0" : "#34d399",
            color: "#04230f",
            fontWeight: 600,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Searching…" : "Search"}
        </button>

        {error && <div style={{ color: "#b91c1c", alignSelf: "center" }}>{error}</div>}
      </form>

      {/* Results */}
      {rows.length > 0 ? (
        <div style={{ display: "grid", gap: 12 }}>
          {rows.map((r, idx) => (
            <div key={idx} style={{ border: "1px solid #eee", borderRadius: 10, padding: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                {r.term_name || "Term"} — {r.course_code} {r.course_title ? `· ${r.course_title}` : ""}
              </div>
              <div style={{ fontSize: 14, marginBottom: 4 }}>
                Section: <b>{r.section_code}</b> · Units: <b>{r.units ?? "—"}</b> · Modality: <b>{r.modality ?? "—"}</b> · Campus: <b>{r.campus_id ?? "—"}</b>
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                {Array.isArray(r.schedule) && r.schedule.length > 0 ? (
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {r.schedule.map((s: Schedule, j: number) => (
                      <li key={j}>
                        {s.day} {s.start_time}–{s.end_time} @ {s.room || "—"}
                        {s.room_type !== undefined ? ` (${s.room_type || "—"})` : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <i>No scheduled meetings on record.</i>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : !loading ? (
        <div style={{ color: "#6b7280" }}>No results yet. Try searching a faculty ID.</div>
      ) : null}
    </div>
  );
}
