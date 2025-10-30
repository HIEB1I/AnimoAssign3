// frontend/src/pages/OM/OM_pred1.tsx
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchFacultyAvailabilityHeatmap } from "@/api"; // returns Promise<T>

// --- Local domain types kept here (no exports needed) ---
type DayCode = "M" | "T" | "W" | "H" | "F" | "S";
type SlotKey = `${DayCode}|${string}`;

type HeatPerson = {
  faculty_id: string;
  name: string;
  email?: string;
  confidence_pct: number;
  reason: string;
  notes?: string[];
};

type HeatSlot = { count: number; list: HeatPerson[] };

type AvailabilityHeatmap = {
  term_id: string;
  previous_term_for_prefs?: string | null;
  history_terms: string[];
  warnings: string[];
  slots: Record<SlotKey, HeatSlot>;
};

// --- Missing constants & helpers added ---
const DAY_PAIRS: [DayCode, DayCode][] = [
  ["M", "H"],
  ["T", "F"],
  ["W", "S"],
];

const TIME_ROWS = [
  "07:30-09:00",
  "09:15-10:45",
  "11:00-12:30",
  "12:45-14:15",
  "14:30-16:00",
  "16:15-17:45",
  "18:00-19:30",
  "19:45-21:15",
] as const;

function getSingleCell(
  data: AvailabilityHeatmap | null,
  day: DayCode,
  slot: string
): HeatSlot {
  if (!data) return { count: 0, list: [] };
  const key = `${day}|${slot}` as SlotKey;
  return data.slots?.[key] || { count: 0, list: [] };
}

function mergePairCells(a: HeatSlot, b: HeatSlot): HeatSlot {
  const byId = new Map<string, HeatPerson>();
  for (const p of [...a.list, ...b.list]) {
    const prev = byId.get(p.faculty_id);
    if (!prev || (p.confidence_pct ?? 0) > (prev.confidence_pct ?? 0)) {
      byId.set(p.faculty_id, p);
    }
  }
  return {
    count: byId.size,           // unique
    list: Array.from(byId.values()).sort((x, y) => y.confidence_pct - x.confidence_pct),
  };
}

function colorForCount(count: number, min: number, max: number) {
  // Nothing at all → light gray
  if (count <= 0) return "#E0E0E0";

  // If the spread is tiny, switch to relative-to-max bands so everything isn't one color
  const span = Math.max(1, max - min);
  const ratio = (count - min) / span; // 0..1 normalized within the paired grid

  if (span <= 3) {
    // very tight range → rank by closeness to max
    const r2 = count / Math.max(1, max);
    if (r2 >= 0.85) return "#2e7d32";  // deep green
    if (r2 >= 0.65) return "#66bb6a";  // green
    if (r2 >= 0.45) return "#ffeb3b";  // yellow
    if (r2 >= 0.25) return "#ff9800";  // orange
    return "#f44336";                  // red
  }

  // normal case
  if (ratio >= 0.80) return "#2e7d32";  // deep green
  if (ratio >= 0.60) return "#66bb6a";  // green
  if (ratio >= 0.40) return "#ffeb3b";  // yellow
  if (ratio >= 0.20) return "#ff9800";  // orange
  return "#f44336";                     // red
}



export default function OM_Pred1() {
  const [data, setData] = useState<AvailabilityHeatmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [course, setCourse] = useState<string>(""); // optional filter
  const [activeCell, setActiveCell] = useState<{ day: DayCode; slot: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const payload = await fetchFacultyAvailabilityHeatmap<AvailabilityHeatmap>(
          course ? { course_id: course } : undefined
        );
        if (!cancelled) setData(payload);
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || "Failed to load");
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [course]);

  const { pairMin, pairMax } = useMemo(() => {
    if (!data) return { pairMin: 0, pairMax: 1 };
    const counts: number[] = [];
    for (const slot of TIME_ROWS) {
      for (const [d1, d2] of DAY_PAIRS) {
        const merged = mergePairCells(
          getSingleCell(data, d1, slot),
          getSingleCell(data, d2, slot)
        );
        counts.push(merged.count);
      }
    }
    return {
      pairMin: Math.min(...counts),
      pairMax: Math.max(...counts),
    };
  }, [data]);


  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Faculty Propensity-to-Assign — Top 5 per Faculty (Pre-Survey)</h1>
        <Link to="/om/home">← Back</Link>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <input
          placeholder="Filter by course ID (qualified only)"
          value={course}
          onChange={(e) => setCourse(e.target.value.trim())}
          style={{ padding: 8, minWidth: 260 }}
          aria-label="Filter by course ID"
        />
      </div>

      {loading && <div>Loading…</div>}
      {error && <div style={{ color: "crimson" }}>{error}</div>}

      {/* Warnings */}
      {!!data?.warnings?.length && (
        <div
          role="alert"
          style={{
            background: "#fff8e1",
            border: "1px solid #ffe082",
            padding: 10,
            borderRadius: 8,
            marginBottom: 10,
          }}
        >
          {data.warnings.map((w, i) => (
            <div key={i}>⚠️ {w}</div>
          ))}
        </div>
      )}

      {data && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #ddd" }}>
                  Time ↓ / Day →
                </th>
                {DAY_PAIRS.map(([d1, d2]) => (
                  <th key={`${d1}${d2}`} style={{ textAlign: "center", padding: 8, borderBottom: "1px solid #ddd" }}>
                    {d1}–{d2}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TIME_ROWS.map((slot) => (
                <tr key={slot}>
                  <th style={{ textAlign: "right", padding: 8, borderRight: "1px solid #eee", whiteSpace: "nowrap" }}>
                    {slot}
                  </th>
                  {DAY_PAIRS.map(([d1, d2]) => {
                    const merged = mergePairCells(
                      getSingleCell(data, d1, slot),
                      getSingleCell(data, d2, slot)
                    );
                    return (
                      <td
                        key={`${d1}${d2}-${slot}`}
                        onClick={() => setActiveCell({ day: `${d1}${d2}` as any, slot })}
                        style={{
                          cursor: "pointer",
                          width: 140,
                          height: 52,
                          textAlign: "center",
                          border: "1px solid #f3f3f3",
                          background: colorForCount(merged.count, pairMin, pairMax), // <<— use pairMin/pairMax here
                          color: merged.count >= Math.max(1, Math.round(pairMax * 0.5)) ? "white" : "#1a1a1a",
                          fontWeight: 700,
                          borderRadius: 12,
                        }}
                      >
                        {merged.count}
                        <div style={{ fontSize: 11, opacity: 0.9 }}>pred. faculty</div>
                      </td>

                    );
                  })}
                </tr>
              ))}
            </tbody>

          </table>
          <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
            Numbers show how many faculty have this paired slot in their <b>Top 5 strongest slots</b>
            (based on recent teaching frequency + last-term preferences). Click a cell to see names and confidence.
          </div>
        </div>
      )}

      {/* Modal */}
      {data && activeCell && (() => {
        const { day, slot } = activeCell;

        // If day is a pair like "MH", split; else treat as single
        const d1 = (day.length === 2 ? day[0] : day) as DayCode;
        const d2 = (day.length === 2 ? day[1] : day) as DayCode;

        const cell = mergePairCells(
          getSingleCell(data, d1, slot),
          getSingleCell(data, d2, slot)
        );

        const avail = cell.list; // already sorted by confidence

        // Dedup notes (show each unique note once)
        const uniqueNotes = Array.from(
          new Set(avail.flatMap((p) => p.notes || []))
        );

        return (
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,.4)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1000,
            }}
            onClick={() => setActiveCell(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 760,
                background: "white",
                borderRadius: 12,
                overflow: "hidden",
                boxShadow: "0 8px 40px rgba(0,0,0,.2)",
              }}
            >
              <div style={{ padding: 16, borderBottom: "1px solid #eee", fontWeight: 700 }}>
                {d1}{d1 !== d2 ? `–${d2}` : ""} · {slot} · Pred: {cell.count}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, maxHeight: 520, overflow: "auto" }}>
                <div style={{ padding: 16, borderRight: "1px solid #f2f2f2" }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>Predicted Available</div>
                  {avail.length === 0 && <div style={{ color: "#888" }}>None</div>}
                  {avail.slice(0, 50).map((p) => (
                    <div key={p.faculty_id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
                      <span title={p.email ? `${p.name} · ${p.email}` : p.name}>{p.name}</span>
                      <span style={{ color: "#666" }}>{p.confidence_pct}%</span>
                    </div>
                  ))}
                  {avail.length > 50 && (
                    <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
                      Showing first 50 of {avail.length}. Refine filters to narrow results.
                    </div>
                  )}
                </div>

                <div style={{ padding: 16 }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>Notes</div>
                  {uniqueNotes.length === 0 && <div style={{ color: "#888" }}>—</div>}
                  {uniqueNotes.map((n, i) => (
                    <div key={i} style={{ color: "#666", padding: "4px 0" }}>
                      • {n}
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ padding: 12, display: "flex", justifyContent: "flex-end", borderTop: "1px solid #eee" }}>
                <button
                  onClick={() => setActiveCell(null)}
                  style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", background: "white" }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

    </div>
  );
}
