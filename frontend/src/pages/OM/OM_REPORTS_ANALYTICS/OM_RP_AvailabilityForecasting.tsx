// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_AvailabilityForecasting.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, CalendarCheck, Users, Clock, TrendingUp, AlertTriangle } from "lucide-react";
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

/* ---------------- Lightweight SelectBox ---------------- */
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
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !listRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  return (
    <div className={cls("relative", className)}>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm flex items-center justify-between bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
      >
        {value || <span className="text-gray-400">{placeholder}</span>}
        <ChevronDown className="w-4 h-4 text-gray-500" />
      </button>
      {open && (
        <div
          ref={listRef}
          className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden"
        >
          {options.map((opt) => (
            <div
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              className={cls(
                "px-3.5 py-2 text-sm cursor-pointer hover:bg-gray-50",
                opt === value && "bg-gray-50 font-medium"
              )}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================= Heatmap logic ================= */
type DayCode = "M" | "T" | "W" | "H" | "F" | "S";
type SlotKey = `${DayCode}|${string}`;

// FIX: Define TOP_N_PER_FACULTY constant as it is used in the legend text
const TOP_N_PER_FACULTY = 5;

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
  const prefLabel = data.previous_term_for_prefs_label || data.previous_term_for_prefs || "—";
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
  const [term, setTerm] = useState("2025 Term 1");
  const [course, setCourse] = useState("");

  const [data, setData] = useState<AvailabilityHeatmap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [active, setActive] = useState<{ d1: DayCode; d2: DayCode; slot: string } | null>(null);
  const right = <div className="hidden sm:block text-xs text-zinc-400"></div>;

  async function loadHeatmap() {
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchFacultyAvailabilityHeatmap<AvailabilityHeatmap>(
        course ? { course_id: course } : undefined
      );
      setData(payload);
    } catch (e: any) {
      setError(e?.message || "Failed to load.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadHeatmap();
  }, [course, term]); // eslint-disable-line react-hooks/exhaustive-deps

  const { pairMin, pairMax } = usePairMinMax(data);

  const modalData = useMemo(() => {
    if (!active || !data) return null;
    const merged = mergePairCells(getSingleCell(data, active.d1, active.slot), getSingleCell(data, active.d2, active.slot));
    const notes = Array.from(new Set(merged.list.flatMap((p) => p.notes || [])));
    return { dayLabel: `${active.d1}–${active.d2}`, slot: active.slot, cell: merged, notes };
  }, [active, data]);

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
            <th className="text-right px-3 py-2 border-b border-gray-200 sticky left-0 bg-white align-middle">
              <span className="inline-flex w-full items-center justify-between">
                <span>Time ↓</span>
                <span className="text-gray-400">/</span>
                <span>Day →</span>
              </span>
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
                <th className="text-right px-3 py-2 whitespace-nowrap sticky left-0 bg-white align-middle">
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

      {/* Filter Bar */}
      <Card className="p-4 mb-4 w-full">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/om/home/reports-analytics"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 active:bg-gray-100"
            aria-label="Back"
            title="Back"
          >
            <ChevronLeft className="h-4 w-4" />
            <span>Back</span>
          </Link>
          <div className="min-w-[220px]">
            <SelectBox value={term} onChange={setTerm} options={["2025 Term 1", "2024 Term 3", "2024 Term 2"]} />
          </div>

          {/* <div className="relative w-full sm:w-[28rem]">
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
          </div> */}

          <div className="ml-auto text-sm text-gray-600">
            Term scope: <span className="font-semibold text-emerald-700">Pre-survey</span>
          </div>
        </div>
      </Card>

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
          {heatmapEl}
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