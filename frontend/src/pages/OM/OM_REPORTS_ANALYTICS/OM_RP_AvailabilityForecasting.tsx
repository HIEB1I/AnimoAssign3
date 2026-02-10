// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_AvailabilityForecasting.tsx
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Users, Clock, TrendingUp, AlertTriangle } from "lucide-react";
import { fetchFacultyAvailabilityHeatmap } from "../../../api";
import { Link } from "react-router-dom";

/* ---------------- Small helpers ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

/* ---------------- Reusable UI bits (match OM_RP pages) ---------------- */
function Card({ className = "", children }: { className?: string; children: any }) {
  return (
    <div className={cls("bg-white rounded-xl border border-gray-200 shadow-sm", className)}>
      {children}
    </div>
  );
}

function WarningPanel({ warnings }: { warnings: string[] }) {
  if (!warnings?.length) return null;
  return (
    <Card className="p-3 w-full">
      <div className="text-sm space-y-1 text-amber-800">
        {warnings.map((w, i) => (
          <div key={i}>⚠️ {w}</div>
        ))}
      </div>
    </Card>
  );
}

/* ================= Heatmap logic ================= */
type DayCode = "M" | "T" | "W" | "H" | "F" | "S";
type SlotKey = `${DayCode}|${string}`;

// FIX: Define TOP_N_PER_FACULTY constant as it is used in the legend text
const TOP_N_PER_FACULTY = 5;

function pillLabelOf(t: TermLite) {
  const ayEnd = t.acad_year_start + 1;
  return `AY ${t.acad_year_start}–${ayEnd} • Term ${t.term_number}`;
}

type HeatPerson = {
  faculty_id: string;
  name: string;
  email?: string;
  confidence_pct: number;
  reason: string;
  notes?: string[];
};

type HeatSlot = { count: number; list: HeatPerson[] };

type TermLite = {
  term_id: string;
  acad_year_start: number;
  term_number: number;
  is_current?: boolean;
};

type AvailabilityHeatmap = {
  term_id: string;
  term_label?: string;

  previous_term_for_prefs?: string | null;
  previous_term_for_prefs_label?: string | null;

  history_terms: string[];
  history_terms_labels?: string[];

  warnings: string[];
  slots: Record<SlotKey, HeatSlot>;

  total_faculty_considered: number;
  faculty_with_recent_pref: number;
  faculty_with_recent_history: number;
  most_supported_slot_count: number;

  // Term navigation helpers (Prev/Next term)
  terms?: TermLite[];
  current_index?: number;
  has_prev?: boolean;
  has_next?: boolean;
  term?: TermLite | null;
};

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

function getSingleCell(data: AvailabilityHeatmap | null, day: DayCode, slot: string): HeatSlot {
  if (!data) return { count: 0, list: [] };
  const key = `${day}|${slot}` as SlotKey;
  return data.slots?.[key] || { count: 0, list: [] };
}

function mergePairCells(a: HeatSlot, b: HeatSlot): HeatSlot {
  const byId = new Map<string, HeatPerson>();
  for (const p of [...a.list, ...b.list]) {
    const prev = byId.get(p.faculty_id);
    // Take the person object with the higher confidence_pct if the faculty is in both single slots
    if (!prev || (p.confidence_pct ?? 0) > (prev.confidence_pct ?? 0)) {
      byId.set(p.faculty_id, p);
    }
  }
  return {
    count: byId.size,
    list: Array.from(byId.values()).sort((x, y) => y.confidence_pct - x.confidence_pct),
  };
}

/** Soft red → neutral → emerald ramp for counts */
function colorForCount(count: number, min: number, max: number) {
  if (max <= 0) return "#F2F4F7";

  const span = Math.max(1, max - min);
  const ratio = (count - min) / span;

  // Very light red → neutral → green
  const steps = [
    "#fee2e2", 
    "#fecaca", 
    "#fca5a5", 
    "#f2f2f2", 
    "#d1fae5",
    "#a7f3d0",
    "#6ee7b7",
    "#34d399",
    "#059669",
  ];

  const idx = Math.min(
    steps.length - 1,
    Math.max(0, Math.round(ratio * (steps.length - 1)))
  );

  return steps[idx];
}

function shouldUseDarkText(bg: string) {
  // simple luminance check
  const hex = bg.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6;
}

function usePairMinMax(data: AvailabilityHeatmap | null) {
  return useMemo(() => {
    if (!data) return { pairMin: 0, pairMax: 0 };
    // The max count is now provided directly by the backend as most_supported_slot_count.
    // We still calculate the min for the ramp.
    const counts: number[] = [];
    for (const slot of TIME_ROWS) {
      for (const [d1, d2] of DAY_PAIRS) {
        const merged = mergePairCells(getSingleCell(data, d1, slot), getSingleCell(data, d2, slot));
        counts.push(merged.count);
      }
    }
    const pairMin = counts.length ? Math.min(...counts) : 0;
    const pairMax = data.most_supported_slot_count; // Use the backend's max count for the full scale
    return { pairMin, pairMax };
  }, [data]);
}

/** Component for the new Quality Metrics Cards */
function SummaryCards({ data }: { data: AvailabilityHeatmap | null }) {
  if (!data) return null;

  // Low-support slots based on the paired grid you're showing (M–H, T–F, W–S)
  // "Low support" = 0 or 1 faculty (safe + defensible; highlights risk without overclaiming)
  const totalCells = TIME_ROWS.length * DAY_PAIRS.length;
  let lowSupportCells = 0;

  for (const slot of TIME_ROWS) {
    for (const [d1, d2] of DAY_PAIRS) {
      const merged = mergePairCells(getSingleCell(data, d1, slot), getSingleCell(data, d2, slot));
      if (merged.count <= 1) lowSupportCells += 1;
    }
  }
  const histLabels = (data.history_terms_labels?.length ? data.history_terms_labels : data.history_terms);
  const cards = [
    {
      label: "Faculty Considered",
      value: data.total_faculty_considered,
      icon: <Users className="h-5 w-5 text-emerald-600" />,
      tooltip:
        "Number of unique faculty included in the forecast after applying department, qualification, and approved-leave filters.",
      color: "text-emerald-700",
    },
    {
      label: "Faculty with Recent Teaching History",
      value: data.faculty_with_recent_history,
      icon: <Clock className="h-5 w-5 text-amber-600" />,
      tooltip:
      `Faculty who have recorded teaching assignments within the last ${histLabels.length} term(s) ` +
      `(${histLabels.join(", ")}). Used as the basis for history-driven forecasting.`,
      color: "text-amber-700",
    },
    {
      label: "Slots with Low Faculty Support",
      value: `${lowSupportCells} / ${totalCells}`,
      icon: <AlertTriangle className="h-5 w-5 text-rose-600" />,
      tooltip:
        "Number of time slots with little to no historical faculty support (0–1), indicating potential scheduling risk.",
      color: "text-rose-700",
    },
  ];

  // Stacked layout (matches your latest UI)
  return (
    <div className="flex flex-col gap-4">
      {cards.map((card) => (
        <Card key={card.label} className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-gray-500 truncate" title={card.tooltip}>
                {card.label}
              </div>
              <div className={cls("mt-1 text-2xl font-bold", card.color)} title={card.tooltip}>
                {card.value}
              </div>
            </div>
            <div className="shrink-0">{card.icon}</div>
          </div>

          {/* helper text under the value (panel-proof) */}
          <div className="mt-2 text-xs text-gray-500 leading-snug">{card.tooltip}</div>
        </Card>
      ))}
    </div>
  );
}

/* ---------------- Main Page ---------------- */
export default function OM_RP_AvailabilityForecasting() {
  // UI-only controls; inherited header/subtitle remain in the shell
  const [course] = useState("");

  const [data, setData] = useState<AvailabilityHeatmap | null>(null);
  const [terms, setTerms] = useState<TermLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [active, setActive] = useState<{ d1: DayCode; d2: DayCode; slot: string } | null>(null);
  const right = <div className="hidden sm:block text-xs text-zinc-400"></div>;

  async function loadHeatmap(
    direction: "current" | "next" | "prev" = "current",
    anchorTermId?: string
  ) {
    setLoading(true);
    setError(null);
    try {
      const params: any = {};
      // Only send term_id when we have an anchor (keeps backward-compat default behavior)
      const anchor = anchorTermId ?? data?.term_id ?? data?.term?.term_id;
      if (anchor) params.term_id = anchor;
      params.direction = direction;

      const payload = await fetchFacultyAvailabilityHeatmap<AvailabilityHeatmap>(
        Object.keys(params).length ? params : undefined
      );
      setData(payload);
      if (Array.isArray(payload?.terms)) setTerms(payload.terms);
    } catch (e: any) {
      setError(e?.message || "Failed to load.");
      setData(null);
      setTerms([]);
    } finally {
      setLoading(false);
    }
  }

  const currentIndex = useMemo(() => {
    if (typeof data?.current_index === "number") return data.current_index;
    const tid = (data?.term?.term_id || data?.term_id || "").trim();
    if (!tid) return 0;
    const idx = terms.findIndex((t) => t.term_id === tid);
    return idx >= 0 ? idx : 0;
  }, [data?.current_index, data?.term?.term_id, data?.term_id, terms]);

  const planningTermId = useMemo(() => {
    // Planning term = next term after the DB's is_current anchor.
    // Falls back conservatively so the UI still behaves even if the
    // terms list is missing/empty.
    if (!terms || terms.length === 0) return "";

    const curIdx = terms.findIndex((t) => t.is_current);
    if (curIdx >= 0) {
      const next = terms[curIdx + 1];
      return (next?.term_id || terms[curIdx]?.term_id || "").trim();
    }

    // If no term is flagged current, treat the latest as the planning term.
    return (terms[terms.length - 1]?.term_id || "").trim();
  }, [terms]);

  const isActiveTerm = useMemo(() => {
    const viewed = (data?.term?.term_id || data?.term_id || "").trim();
    if (!viewed) return false;
    if (!planningTermId) return false;
    return viewed === planningTermId;
  }, [data?.term?.term_id, data?.term_id, planningTermId]);

  useEffect(() => {
    // Default view should be the *planning* term (next after current),
    // matching the behavior of Deloading Utilization.
    loadHeatmap("next");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Course filter should not break navigation; reset to current-planning scope.
    // If the backend doesn't support a planning anchor, it will fall back.
    loadHeatmap("next");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course]);

  const { pairMin, pairMax } = usePairMinMax(data);

  const modalData = useMemo(() => {
    if (!active || !data) return null;
    const merged = mergePairCells(getSingleCell(data, active.d1, active.slot), getSingleCell(data, active.d2, active.slot));
    const notes = Array.from(new Set(merged.list.flatMap((p) => p.notes || [])));
    return { dayLabel: `${active.d1}–${active.d2}`, slot: active.slot, cell: merged, notes };
  }, [active, data]);

  const currentPillLabel = useMemo(() => {
    if (data?.term) return pillLabelOf(data.term);
    if (data?.term_label) return data.term_label;
    if (data?.term_id) return String(data.term_id);
    return "—";
  }, [data?.term, data?.term_label, data?.term_id]);

  const hasPrev = useMemo(() => {
    if (typeof data?.has_prev === "boolean") return data.has_prev;
    return terms.length > 0 ? currentIndex > 0 : false;
  }, [data?.has_prev, terms.length, currentIndex]);

  const hasNext = useMemo(() => {
    if (typeof data?.has_next === "boolean") return data.has_next;
    return terms.length > 0 ? currentIndex < terms.length - 1 : false;
  }, [data?.has_next, terms.length, currentIndex]);

  const hasAnyPredictions = useMemo(() => {
    if (!data?.slots) return false;
    return Object.values(data.slots).some((v) => (v?.count ?? 0) > 0);
  }, [data?.slots]);

  const heatmapEl = data && !loading ? (
    <Card className="overflow-x-auto">
      {/* Legend / scale */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-gray-200">
        <div className="text-sm text-gray-600">
          Cell count indicates unique faculty with the paired slot in their top {TOP_N_PER_FACULTY} strongest slots.
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Low ({pairMin})</span>
          {/* IMPORTANT: make legend match red→green now */}
          <div className="h-3 w-28 rounded bg-gradient-to-r from-[#fca5a5] via-[#f2f2f2] to-[#059669]" />
          <span className="text-xs text-gray-500">Peak ({pairMax})</span>
        </div>
      </div>
  
      {/* Heatmap */}
      <div className="w-fit mx-auto px-4 pb-3">
        <table className="w-fit table-auto border-separate border-spacing-[6px] text-sm">
          <colgroup>
            <col style={{ width: 170 }} />
            <col style={{ width: 72 }} />
            <col style={{ width: 72 }} />
            <col style={{ width: 72 }} />
          </colgroup>
  
          <thead className="sticky top-0 z-[1] bg-white">
            <tr>
              <th className="text-center px-3 py-2 border-b border-gray-200 sticky left-0 bg-white align-middle whitespace-nowrap">
                Time
              </th>
              {DAY_PAIRS.map(([d1, d2]) => (
                <th key={`${d1}${d2}`} className="text-center py-2 border-b border-gray-200 text-emerald-700">
                  {d1}–{d2}
                </th>
              ))}
            </tr>
          </thead>
  
          <tbody>
            {TIME_ROWS.map((slot) => (
              <tr key={slot}>
                <th className="text-center px-3 py-2 whitespace-nowrap sticky left-0 bg-white align-middle">
                  {slot}
                </th>
  
                {DAY_PAIRS.map(([d1, d2]) => {
                  const merged = mergePairCells(getSingleCell(data, d1, slot), getSingleCell(data, d2, slot));
                  const bg = colorForCount(merged.count, pairMin, pairMax);
                  const darkText = shouldUseDarkText(bg);
                  const isPeak = merged.count === pairMax && pairMax > 0;
  
                  return (
                    <td
                      key={`${d1}${d2}-${slot}`}
                      onClick={() => setActive({ d1, d2, slot })}
                      className={cls(
                        "text-center align-middle cursor-pointer select-none",
                        isPeak && "ring-2 ring-red-500 ring-offset-2"
                      )}
                      style={{
                        background: bg,
                        color: darkText ? "#0b3d2e" : "white",
                        fontWeight: 700,
                        borderRadius: 0,
                        height: 22,
                        width: 64,
                      }}
                      title={`${d1}–${d2} • ${slot} • ${merged.count}${isPeak ? " (Peak)" : ""}`}
                    >
                      {merged.count > 0 ? merged.count : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
  
        <div className="text-[12px] text-gray-600 mt-2 px-3 pb-3">
          Click a slot to view predicted faculty candidates and confidence (history/preference-based).
        </div>
      </div>
    </Card>
  ) : null;

  return (
    // CENTER + MAX WIDTH CONTAINER
    <div className="w-full max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
        <h1 className="text-2xl font-bold mb-2">Faculty Availability Forecasting (Pre-Survey)</h1>
        <p className="text-sm text-gray-600 mb-6">
          Assess forecast reliability via quality metrics and identify peak availability.
        </p>
        </div>
        {right}
      </div>

      <div className="w-full px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      </div>

      {/* Top Bar (match Deloading Utilization term navigation styling) */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm mb-4">
        <div className="relative flex flex-wrap items-center gap-3 p-4 border-b border-gray-200">
          <Link
            to="/om/home/reports-analytics"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 active:bg-gray-100"
            aria-label="Back"
            title="Back"
          >
            <ChevronLeft className="h-4 w-4" />
            <span>Back</span>
          </Link>

          <div className="flex flex-1 items-center justify-between">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
              disabled={!hasPrev || loading}
              onClick={() => loadHeatmap("prev")}
              title="Previous term"
            >
              <ChevronLeft className="h-4 w-4" />
              <span>Previous Term</span>
            </button>

            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
              disabled={!hasNext || loading}
              onClick={() => loadHeatmap("next")}
              title="Next term"
            >
              <span>Next Term</span>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-1">
            <div className="inline-flex items-center rounded-full border border-emerald-100 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800 shadow-sm">
              <span>{currentPillLabel}</span>
              {isActiveTerm && (
                <span className="ml-2 inline-flex items-center rounded-full bg-emerald-200 px-2 py-0.5 text-[11px] font-semibold text-emerald-900">
                  Active
                </span>
              )}
            </div>
            {terms.length > 0 ? (
              <div className="text-xs text-gray-500">
                {currentIndex + 1} of {terms.length}
              </div>
            ) : (
              <div className="text-xs text-gray-500">
                Term scope: <span className="font-semibold text-emerald-700">Pre-survey</span>
              </div>
            )}
          </div>
        </div>

        {/* Optional filter row (kept commented as before, but preserved container for layout parity) */}
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            {/*
            <div className="relative w-full sm:w-[28rem]">
              <input
                className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
                placeholder="Filter by course ID (qualified only)"
                value={course}
                onChange={(e) => setCourse(e.target.value.trim())}
                aria-label="Filter by course ID"
              />
              {!!course && (
                <button
                  type="button"
                  onClick={() => setCourse("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
                  aria-label="Clear filter"
                  title="Clear"
                >
                  ×
                </button>
              )}
            </div>
            */}
          </div>
        </div>
      </div>

      <WarningPanel
        warnings={(data?.warnings || []).map((w) => {
          const curr = data?.term_id;
          const currLabel = data?.term_label;
          if (curr && currLabel) return w.replaceAll(String(curr), String(currLabel));
          return w;
        })}
      />

      {/* MAIN GRID (left cards + right heatmap) */}
      <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-6 mt-4 items-start">
        {/* Left: metrics */}
        <div className="space-y-0">
          <SummaryCards data={data} />
        </div>

        {/* Right: heatmap */}
        <div>
          {loading && (
            <Card className="p-4">
              <div className="text-sm text-gray-500 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 animate-pulse" />
                Loading Availability Forecast…
              </div>
            </Card>
          )}

          {!loading && !error && (!data || !data.slots) && (
            <Card className="p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
                <div>
                  <div className="font-semibold text-gray-800">No forecast data</div>
                  <div className="text-sm text-gray-600 mt-1">
                    There is no availability forecasting data to display for the selected scope.
                  </div>
                </div>
              </div>
            </Card>
          )}

          {!loading && !error && data?.slots && !hasAnyPredictions && (
            <Card className="p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
                <div>
                  <div className="font-semibold text-gray-800">Nothing to show for this term</div>
                  <div className="text-sm text-gray-600 mt-1">
                    No faculty candidates were predicted for any paired time slot in this term.
                  </div>
                </div>
              </div>
            </Card>
          )}

          {!loading && !error && data?.slots && hasAnyPredictions && heatmapEl}
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">{error}</div>
      )}

      {/* Modal */}
      {modalData && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
          onClick={() => setActive(null)}
        >
          <div
            className="w-full max-w-3xl bg-white rounded-2xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-gray-100 font-semibold">
              {modalData.dayLabel} · {modalData.slot} · Pred: {modalData.cell.count}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 max-h-[70vh] overflow-auto">
              <div className="p-4 border-r border-gray-100">
                <div className="font-semibold text-emerald-700 mb-2">Predicted Faculty</div>
                {modalData.cell.list.length === 0 && <div className="text-gray-500">None</div>}
                {modalData.cell.list.slice(0, 100).map((p) => (
                  <div key={p.faculty_id} className="flex flex-col py-1.5 border-b border-gray-50 last:border-b-0">
                    <div className="flex items-center justify-between">
                      <span className="font-medium" title={p.email ? `${p.name} · ${p.email}` : p.name}>{p.name}</span>
                      <span className="text-gray-700 font-semibold">{p.confidence_pct}%</span>
                    </div>
                    {/* NEW: Display Reason */}
                    <div className="text-xs text-gray-500 italic mt-0.5" title="Reason for this prediction">{p.reason}</div>
                  </div>
                ))}
                {modalData.cell.list.length > 100 && (
                  <div className="text-xs text-gray-500 mt-2">
                    Showing first 100 of {modalData.cell.list.length}. Refine filter to narrow results.
                  </div>
                )}
              </div>
              <div className="p-4">
                <div className="font-semibold text-emerald-700 mb-2">Overall Faculty Notes</div>
                {modalData.notes.length === 0 && <div className="text-gray-500">—</div>}
                {modalData.notes.map((n, i) => (
                  <div key={i} className="text-gray-700 py-0.5">
                    • {n}
                  </div>
                ))}
              </div>
            </div>

            <div className="px-4 py-3 border-t border-gray-100 flex justify-end">
              <button
                onClick={() => setActive(null)}
                className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}