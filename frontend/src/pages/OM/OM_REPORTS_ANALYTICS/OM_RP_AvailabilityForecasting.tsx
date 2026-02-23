// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM_RP_AvailabilityForecasting.tsx
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, Info, Search, TrendingUp } from "lucide-react";
import { Link } from "react-router-dom";
import SelectBox from "../../../component/SelectBox";
import { fetchFacultyAvailabilityHeatmap } from "../../../api";

/* ---------------- Small helpers ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

function Card({ className = "", children }: { className?: string; children: any }) {
  return <div className={cls("bg-white rounded-xl border border-gray-200 shadow-sm", className)}>{children}</div>;
}

function Chip({ children, className = "" }: { children: any; className?: string }) {
  return (
    <span
      className={cls(
        "inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-700",
        className
      )}
    >
      {children}
    </span>
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


function DataUsedCard({
  denomIncluded,
  totalScope,
  exclusionLines,
}: {
  denomIncluded: number;
  totalScope: number;
  excludedCount: number;
  exclusionLines: { k: string; v: number }[];
}) {
  return (
    <Card className="p-3 border-emerald-200 bg-emerald-50">
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-500">Data used</div>
        <div className="relative group">
          <button
            type="button"
            className="inline-flex items-center gap-1 bg-white px-2 py-1 text-gray-600"
          >
            <Info className="h-3.5 w-3.5" />
            
          </button>
          <div className="pointer-events-none absolute right-0 top-8 z-20 hidden w-[260px] rounded-lg border border-gray-200 bg-white p-2 text-[11px] text-gray-700 shadow-md group-hover:block">
            <div className="font-medium mb-1">Exclusions (why some are not counted)</div>
            {exclusionLines.length ? (
              <div className="space-y-1">
                {exclusionLines.map((x) => (
                  <div key={x.k} className="flex items-center justify-between">
                    <span>{x.k}</span>
                    <span className="font-medium">{x.v}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-gray-500">No exclusions reported.</div>
            )}
          </div>
        </div>
      </div>
      <div className="mt-2 text-3xl font-extrabold text-emerald-900">
        {denomIncluded || 0}/{totalScope || 0}
      </div>
    </Card>
  );
}

/* ================= Types ================= */

type DayCode = "M" | "T" | "W" | "H" | "F" | "S";

type SlotKey = `${DayCode}|${string}`;

type TermLite = {
  term_id: string;
  acad_year_start: number;
  term_number: number;
  is_current?: boolean;
};

type HeatPerson = {
  faculty_id: string;
  name: string;
  email?: string;
  confidence_pct: number;
  reason: string;
  notes?: string[];
  score_breakdown?: {
    base: number;
    pref_boost: number;
    history_signal: number;
    history_boost: number;
    total: number;
  };
};

type HeatSlot = { count: number; list: HeatPerson[] };

type AvailabilityHeatmap = {
  term_id: string;
  term_label?: string;

  warnings: string[];
  slots: Record<SlotKey, HeatSlot>;

  total_faculty_considered: number;
  most_supported_slot_count: number;

  counting_mode?: "top1" | "top5";
  eligible_faculty_included?: number;
  faculty_total_in_scope?: number;
  excluded_breakdown?: {
    no_submitted_preferences?: number;
    no_recent_history?: number;
    on_leave?: number;
    preferred_units_zero?: number;
    not_qualified?: number;
    no_signal?: number;
  };
  coverage_pct?: number;
  recommended_blocks?: { day: DayCode; slot: string; key: string; count: number; ratio: number }[];
  risk_blocks?: { day: DayCode; slot: string; key: string; count: number; ratio: number }[];

  // Term navigation helpers
  terms?: TermLite[];
  current_index?: number;
  has_prev?: boolean;
  has_next?: boolean;
  term?: TermLite | null;
};

/* ================= Constants ================= */

const DAY_PAIRS: [DayCode, DayCode][] = [
  ["M", "H"],
  ["T", "F"],
  ["W", "S"],
];

const DAY_FULL: Record<DayCode, string> = {
  M: 'Monday',
  T: 'Tuesday',
  W: 'Wednesday',
  H: 'Thursday',
  F: 'Friday',
  S: 'Saturday',
};

function dayPairFullName(d1: DayCode, d2: DayCode) {
  return DAY_FULL[d1] + '-' + DAY_FULL[d2];
}

function parsePairKey(pairKey: string): [DayCode, DayCode] {
  const t = (pairKey || '').trim();
  // Accept either code form (M-H) or full-name form (Monday-Thursday)
  if (/^[MTWHFS]-[MTWHFS]$/.test(t)) {
    const parts = t.split('-') as [DayCode, DayCode];
    return [parts[0], parts[1]];
  }
  const lower = t.toLowerCase();
  const inv: Record<string, DayCode> = Object.fromEntries(Object.entries(DAY_FULL).map(([k,v]) => [String(v).toLowerCase(), k as DayCode]));
  const parts = lower.split('-');
  if (parts.length === 2) {
    const a = inv[parts[0]];
    const b = inv[parts[1]];
    if (a && b) return [a, b];
  }
  return ['M','H'];
}

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

const DEFAULT_COUNTING_MODE: "top1" | "top5" = "top1";

function pillLabelOf(t: TermLite) {
  const ayEnd = t.acad_year_start + 1;
  return `AY ${t.acad_year_start}–${ayEnd} • Term ${t.term_number}`;
}

function getSingleCell(data: AvailabilityHeatmap | null, day: DayCode, slot: string): HeatSlot {
  if (!data) return { count: 0, list: [] };
  const key = `${day}|${slot}` as SlotKey;
  return data.slots?.[key] || { count: 0, list: [] };
}

function mergePairCells(a: HeatSlot, b: HeatSlot): HeatSlot {
  const byId = new Map<string, HeatPerson>();
  for (const p of [...(a?.list || []), ...(b?.list || [])]) {
    const prev = byId.get(p.faculty_id);
    if (!prev || (p.confidence_pct ?? 0) > (prev.confidence_pct ?? 0)) byId.set(p.faculty_id, p);
  }
  return {
    count: byId.size,
    list: Array.from(byId.values()).sort((x, y) => (y.confidence_pct ?? 0) - (x.confidence_pct ?? 0)),
  };
}

/** Soft red → neutral → emerald ramp for counts */
function colorForCount(count: number, min: number, max: number) {
  if (max <= 0) return "#F2F4F7";
  const span = Math.max(1, max - min);
  const ratio = (count - min) / span;
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
  const idx = Math.min(steps.length - 1, Math.max(0, Math.round(ratio * (steps.length - 1))));
  return steps[idx];
}

function shouldUseDarkText(hex: string) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140;
}


function nonZero(n?: number) {
  return typeof n === "number" && n > 0;
}

/* ================= Main component ================= */

type Mode = "slot" | "faculty";

export default function OM_RP_AvailabilityForecasting() {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<AvailabilityHeatmap | null>(null);

  const [termId, setTermId] = useState<string | null>(null);
  const [countingMode, setCountingMode] = useState<"top1" | "top5">(DEFAULT_COUNTING_MODE);

  const [mode, setMode] = useState<Mode>("slot");

  // Slot-first controls
  const [pairKey, setPairKey] = useState<string>('Monday-Thursday');
  const [slotKey, setSlotKey] = useState<string>(TIME_ROWS[0]);
  const [candidateQuery, setCandidateQuery] = useState<string>("");
  const [userTouchedSlot, setUserTouchedSlot] = useState(false);

  // Faculty-first controls
  const [facultyQuery, setFacultyQuery] = useState<string>("");
  const [selectedFacultyId, setSelectedFacultyId] = useState<string | null>(null);

  const currentTermLabel = useMemo(() => {
    if (data?.term) return pillLabelOf(data.term);
    if (data?.term_label) return data.term_label;
    return "";
  }, [data?.term, data?.term_label]);

  const isActiveTerm = useMemo(() => {
    // TermLite exposes is_current; default to true when not provided so the pill matches the legacy "Active" styling.
    if (typeof data?.term?.is_current === "boolean") return data.term.is_current;
    return true;
  }, [data?.term?.is_current]);

  // Pair range values (for legend + cell color)
  const { pairMax, pairMin } = useMemo(() => {
    if (!data?.slots) return { pairMin: 0, pairMax: 0 };
    const counts: number[] = [];
    for (const slot of TIME_ROWS) {
      for (const [d1, d2] of DAY_PAIRS) {
        const merged = mergePairCells(getSingleCell(data, d1, slot), getSingleCell(data, d2, slot));
        counts.push(merged.count);
      }
    }
    const max = counts.length ? Math.max(...counts) : 0;
    const min = counts.length ? Math.min(...counts) : 0;
    return { pairMin: min, pairMax: max };
  }, [data]);

  const denomIncluded = data?.eligible_faculty_included ?? data?.total_faculty_considered ?? 0;

  function ScoreBreakdownChips({ person }: { person: HeatPerson }) {
    const sb = person.score_breakdown;
    if (!sb) return null;

    const base = Math.max(0, sb.base ?? 0);
    const pref = Math.max(0, sb.pref_boost ?? 0);
    const hist = Math.max(0, sb.history_boost ?? 0);
    const total = Math.max(0.000001, base + pref + hist);
    const pct = (x: number) => Math.round((x / total) * 100);

    // All green shades (lighter → darker) to match the requested UI.
    const items: { k: "Base" | "Preference" | "History"; v: number; tip: string; chipCls: string; dotCls: string }[] = [
      {
        k: "Base",
        v: pct(base),
        tip: "Baseline score (always included).",
        chipCls: "border-emerald-200 bg-emerald-50 text-emerald-800",
        dotCls: "bg-emerald-500",
      },
      {
        k: "Preference",
        v: pct(pref),
        tip: "From submitted preferences for this term.",
        chipCls: "border-green-200 bg-green-50 text-green-800",
        dotCls: "bg-green-500",
      },
      {
        k: "History",
        v: pct(hist),
        tip: "From last 3 terms teaching patterns (recent terms weigh more).",
        chipCls: "border-teal-200 bg-teal-50 text-teal-900",
        dotCls: "bg-teal-600",
      },
    ];

    return (
      <div className="mt-1">
        <div className="mt-1 flex flex-wrap gap-1">
          {items.map((it) => (
            <span key={it.k} className="relative group">
              <span className={cls("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", it.chipCls)}>
                <span className={cls("inline-block h-1.5 w-1.5 rounded-full", it.dotCls)} />
                {it.k}: {it.v}%
              </span>
              <span className="pointer-events-none absolute left-0 top-6 z-30 hidden whitespace-nowrap rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-700 shadow-md group-hover:block">
                {it.tip}
              </span>
            </span>
          ))}
        </div>
      </div>
    );
  }

  function PersonSignalChips({ person }: { person: HeatPerson }) {
    const sb = person.score_breakdown;
    if (!sb) return null;

    const tags: string[] = [];
    if ((sb.pref_boost ?? 0) > 0) tags.push("Preferred last term");
    if ((sb.history_boost ?? 0) > 0 || (sb.history_signal ?? 0) > 0) tags.push("Taught recently");

    if (!tags.length) return null;
    // Render inline so it can sit beside the name (less vertical space).
    return (
      <div className="flex flex-wrap gap-1">
        {tags.map((label) => (
          <Chip key={label} className="bg-white">
            {label}
          </Chip>
        ))}
      </div>
    );
  }

  const totalScope = data?.faculty_total_in_scope ?? 0;
  const excludedCount = Math.max(0, totalScope - denomIncluded);

  const exclusionLines = useMemo(() => {
    const ex = data?.excluded_breakdown || {};
    const lines: { k: string; v: number }[] = [];
    if (nonZero(ex.no_submitted_preferences)) lines.push({ k: "No submitted preferences", v: ex.no_submitted_preferences! });
    if (nonZero(ex.no_recent_history)) lines.push({ k: "No recent history", v: ex.no_recent_history! });
    if (nonZero(ex.on_leave)) lines.push({ k: "On leave", v: ex.on_leave! });
    if (nonZero(ex.preferred_units_zero)) lines.push({ k: "Preferred units = 0", v: ex.preferred_units_zero! });
    if (nonZero(ex.not_qualified)) lines.push({ k: "Not qualified", v: ex.not_qualified! });
    if (nonZero(ex.no_signal)) lines.push({ k: "No signal", v: ex.no_signal! });
    return lines;
  }, [data?.excluded_breakdown]);

  // Build a faculty directory from slot lists (no extra backend changes)
  const facultyDirectory = useMemo(() => {
    const map = new Map<string, HeatPerson>();
    if (!data?.slots) return [] as HeatPerson[];
    for (const slot of Object.values(data.slots)) {
      for (const p of slot?.list || []) {
        const prev = map.get(p.faculty_id);
        if (!prev || (p.confidence_pct ?? 0) > (prev.confidence_pct ?? 0)) map.set(p.faculty_id, p);
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [data?.slots]);

  const facultySuggestions = useMemo(() => {
    // Show ALL matches (scrollable list) — not only top 12.
    const q = facultyQuery.trim().toLowerCase();
    if (!q) return facultyDirectory;
    return facultyDirectory.filter((f) => f.name.toLowerCase().includes(q) || (f.email || "").toLowerCase().includes(q));
  }, [facultyDirectory, facultyQuery]);

  const selectedFaculty = useMemo(() => {
    if (!selectedFacultyId) return null;
    return facultyDirectory.find((f) => f.faculty_id === selectedFacultyId) || null;
  }, [facultyDirectory, selectedFacultyId]);

  // Compute selected faculty's best pair slots (for chips + heatmap highlight)
  const selectedFacultyBestPairs = useMemo(() => {
    if (!data?.slots || !selectedFacultyId) return [] as { d1: DayCode; d2: DayCode; slot: string; confidence: number }[];

    const rows: { d1: DayCode; d2: DayCode; slot: string; confidence: number }[] = [];

    for (const slot of TIME_ROWS) {
      for (const [d1, d2] of DAY_PAIRS) {
        const a = getSingleCell(data, d1, slot);
        const b = getSingleCell(data, d2, slot);
        const pA = (a.list || []).find((p) => p.faculty_id === selectedFacultyId);
        const pB = (b.list || []).find((p) => p.faculty_id === selectedFacultyId);
        const conf = Math.max(pA?.confidence_pct ?? 0, pB?.confidence_pct ?? 0);
        if (conf > 0) rows.push({ d1, d2, slot, confidence: conf });
      }
    }

    rows.sort((x, y) => y.confidence - x.confidence);
    return rows.slice(0, 10);
  }, [data, selectedFacultyId]);

  const highlightSet = useMemo(() => {
    const set = new Set<string>();
    for (const r of selectedFacultyBestPairs.slice(0, 5)) set.add(`${r.d1}-${r.d2}-${r.slot}`);
    return set;
  }, [selectedFacultyBestPairs]);

  const slotCandidates = useMemo(() => {
    if (!data) return [] as HeatPerson[];
    const [d1, d2] = parsePairKey(pairKey);
    const merged = mergePairCells(getSingleCell(data, d1, slotKey), getSingleCell(data, d2, slotKey));
    const q = candidateQuery.trim().toLowerCase();
    if (!q) return merged.list;
    return merged.list.filter((p) => p.name.toLowerCase().includes(q) || (p.email || "").toLowerCase().includes(q));
  }, [data, pairKey, slotKey, candidateQuery]);

  // Fetch
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res: AvailabilityHeatmap = await fetchFacultyAvailabilityHeatmap({
          term_id: termId || undefined,
          counting_mode: countingMode,
        });
        if (!alive) return;
        setData(res);
        if (!termId && res?.term_id) setTermId(res.term_id);
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || "Failed to load availability forecast.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [termId, countingMode]);

  // Auto-pick a meaningful default slot so OM sees details immediately (no first click needed).
  useEffect(() => {
    if (!data?.slots) return;
    if (userTouchedSlot) return;

    let best: { d1: DayCode; d2: DayCode; slot: string; count: number } | null = null;
    for (const slot of TIME_ROWS) {
      for (const [d1, d2] of DAY_PAIRS) {
        const merged = mergePairCells(getSingleCell(data, d1, slot), getSingleCell(data, d2, slot));
        if (!best || merged.count > best.count) best = { d1, d2, slot, count: merged.count };
      }
    }

    if (best) {
      setMode("slot");
      setPairKey(dayPairFullName(best.d1, best.d2));
      setSlotKey(best.slot);
    }
  }, [data?.slots, userTouchedSlot]);

  // When switching to faculty mode, clear slot candidate query; vice versa
  useEffect(() => {
    if (mode === "faculty") setCandidateQuery("");
    if (mode === "slot") {
      setFacultyQuery("");
      setSelectedFacultyId(null);
    }
  }, [mode]);

  const hasAnyPredictions = useMemo(() => {
    if (!data?.slots) return false;
    return Object.values(data.slots).some((v) => (v?.count ?? 0) > 0);
  }, [data?.slots]);

  /* ================= Render ================= */

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Title + subtitle */}
      <div className="px-1">
        <h1 className="text-2xl font-bold text-gray-900">Availability Forecasting</h1>
        <p className="mt-1 text-sm text-gray-600">
          Predicts best-fit teaching blocks using submitted preferences and recent teaching patterns to help assign faculty
          to time slots faster.
        </p>
      </div>
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link
            to="/om/reports-analytics"
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            <ChevronLeft className="h-4 w-4" />
            Back
          </Link>
        </div>

        {currentTermLabel ? (
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-1.5 text-sm font-semibold text-emerald-800">
            {currentTermLabel}
            {isActiveTerm ? (
              <span className="rounded-full bg-emerald-200 px-2 py-0.5 text-xs font-semibold text-emerald-900">Active</span>
            ) : null}
          </div>
        ) : null}

        <div className="w-[160px]" />
      </div>
      <WarningPanel warnings={data?.warnings || []} />

      {/* Primary decision tabs */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode("slot")}
              className={cls(
                "rounded-lg px-3 py-1.5 text-sm border",
                mode === "slot" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
              )}
            >
              Assign a Slot
            </button>
            <button
              type="button"
              onClick={() => setMode("faculty")}
              className={cls(
                "rounded-lg px-3 py-1.5 text-sm border",
                mode === "faculty" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
              )}
            >
              Check a Faculty
            </button>
          </div>

          {/* Slots per faculty (aggregation) */}
          <div className="flex items-center gap-2">
            <div className="relative flex items-center gap-1 group">
              <span className="text-xs text-gray-500">Slots per faculty</span>
              <Info className="w-3.5 h-3.5 text-gray-400" />
              <div className="pointer-events-none absolute right-0 top-6 z-20 hidden w-[260px] rounded-lg border border-gray-200 bg-white p-2 text-[11px] text-gray-700 shadow-md group-hover:block">
                <div className="space-y-1">
                  <div>
                    <span className="font-medium">1:</span> each faculty is counted only in their single best-fit slot.
                  </div>
                  <div>
                    <span className="font-medium">5:</span> each faculty is counted in their top 5 best-fit slots (counts will be higher).
                  </div>
                </div>
              </div>
            </div>

            <div className="w-[200px]">
              {/* IMPORTANT: SelectBox expects string[] options */}
              <SelectBox
                value={countingMode === "top1" ? "1" : "5"}
                options={["1", "5"]}
                onChange={(v) => setCountingMode(v === "5" ? "top5" : "top1")}
              />
            </div>
          </div>
        </div>
        {/* Mode panels */}
        <div className="mt-3">
          {mode === "slot" ? (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <div className="lg:col-span-1">
                <DataUsedCard denomIncluded={denomIncluded} totalScope={totalScope} excludedCount={excludedCount} exclusionLines={exclusionLines} />

                <div className="mt-3 text-sm font-semibold text-gray-800 flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-emerald-600" />
                  Assign a Slot
                </div>
                <div className="mt-1 text-xs text-gray-500">Pick a time block to get ranked candidates instantly.</div>

                <div className="mt-3 space-y-2">
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Day pair</div>
                    <SelectBox
                      value={pairKey}
                      options={DAY_PAIRS.map(([a, b]) => dayPairFullName(a, b))}
                      onChange={(v) => {
                        setUserTouchedSlot(true);
                        setPairKey(v);
                      }}
                    />
                  </div>

                  <div>
                    <div className="text-xs text-gray-500 mb-1">Time</div>
                    <SelectBox
                      value={slotKey}
                      options={[...TIME_ROWS]}
                      onChange={(v) => {
                        setUserTouchedSlot(true);
                        setSlotKey(v);
                      }}
                    />
                  </div>

                  <div>
                    <div className="text-xs text-gray-500 mb-1">Filter candidates</div>
                    <div className="relative">
                      <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
                      <input
                        value={candidateQuery}
                        onChange={(e) => setCandidateQuery(e.target.value)}
                        placeholder="Search by name…"
                        className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-emerald-200"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-gray-800">Top candidates</div>
                </div>

                <div className="mt-2 border border-gray-200 rounded-xl overflow-hidden">
                  {slotCandidates.length ? (
                    <div className="divide-y divide-gray-200">
                      {slotCandidates.slice(0, 10).map((p) => (
                        <div key={p.faculty_id} className="p-3 flex items-start justify-between gap-3 hover:bg-gray-50">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="font-medium text-gray-900 truncate">{p.name}</div>
                              <PersonSignalChips person={p} />
                            </div>
                            <div className="text-xs text-gray-500 truncate">{p.email || ""}</div>
                            <ScoreBreakdownChips person={p} />
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="text-2xl font-extrabold text-emerald-800 leading-none">{Math.round(p.confidence_pct)}%</div>
                            <div className="text-[11px] text-emerald-700 font-medium">fit score</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-4 text-sm text-gray-500">No candidates found for this slot.</div>
                  )}
                </div>

                <div className="mt-2 text-[11px] text-gray-500 flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  This is predicted support (preferences + last 3 terms patterns), not confirmed calendar availability.
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <div className="lg:col-span-1">
                <DataUsedCard denomIncluded={denomIncluded} totalScope={totalScope} excludedCount={excludedCount} exclusionLines={exclusionLines} />

                <div className="mt-3 text-sm font-semibold text-gray-800 flex items-center gap-2">
                  <Search className="h-4 w-4 text-emerald-600" />
                  Check a Faculty
                </div>
                <div className="mt-1 text-xs text-gray-500">Search a faculty to see their predicted best-fit blocks.</div>

                <div className="mt-3">
                  <div className="text-xs text-gray-500 mb-1">Faculty</div>
                  <div className="relative">
                    <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
                    <input
                      value={facultyQuery}
                      onChange={(e) => {
                        setFacultyQuery(e.target.value);
                        setSelectedFacultyId(null);
                      }}
                      placeholder="Search by name or email…"
                      className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-emerald-200"
                    />
                  </div>

                  {/* suggestions */}
                  {facultySuggestions.length ? (
                    <div className="mt-2 max-h-72 overflow-auto rounded-xl border border-gray-200 bg-white">
                      {facultySuggestions.map((f) => (
                        <button
                          key={f.faculty_id}
                          type="button"
                          onClick={() => {
                            setSelectedFacultyId(f.faculty_id);
                            setFacultyQuery(f.name);
                          }}
                          className={cls(
                            "w-full text-left px-3 py-2 hover:bg-gray-50",
                            selectedFacultyId === f.faculty_id && "bg-emerald-50"
                          )}
                        >
                          <div className="text-sm text-gray-900">{f.name}</div>
                          <div className="text-xs text-gray-500 truncate">{f.email || f.faculty_id}</div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2 text-sm text-gray-500">No matches.</div>
                  )}
                </div>
              </div>

              <div className="lg:col-span-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-gray-800">Predicted best-fit blocks</div>
                  {/* faculty_id hidden to reduce clutter */}
                </div>

                <div className="mt-2">
                  {selectedFaculty ? (
                    <Card className="p-3">
                      <div className="flex items-center gap-2">
                        <div className="font-medium text-gray-900">{selectedFaculty.name}</div>
                        <PersonSignalChips person={selectedFaculty} />
                      </div>
                      <div className="text-xs text-gray-500">Highlighted on the heatmap below.</div>
                      <ScoreBreakdownChips person={selectedFaculty} />
                    </Card>
                  ) : (
                    <div className="text-sm text-gray-500">Search and select a faculty to view predictions.</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Heatmap (context) */}
      <Card className="overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-gray-200">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-800">Predicted Faculty Support</div>
            <div className="text-xs text-gray-500 mt-0.5">
              {countingMode === "top1"
                ? "Counts show how many included faculty have this as their #1 best-fit slot."
                : "Counts show how many included faculty include this slot in their top 5 best-fit slots (each faculty may appear in up to 5 slots)."}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Low ({pairMin})</span>
            <div className="h-3 w-28 rounded bg-gradient-to-r from-[#fca5a5] via-[#f2f2f2] to-[#059669]" />
            <span className="text-xs text-gray-500">Peak ({pairMax})</span>
          </div>
        </div>

        <div className="w-fit mx-auto px-4 pb-3">
          {!loading && !hasAnyPredictions ? (
            <div className="py-10 text-sm text-gray-500">No predictions available for this term.</div>
          ) : (
            <table className="w-fit table-auto border-separate border-spacing-[6px] text-sm">
              <colgroup>
                <col style={{ width: 170 }} />
                <col style={{ width: 72 }} />
                <col style={{ width: 72 }} />
                <col style={{ width: 72 }} />
              </colgroup>

              <thead className="sticky top-0 z-[1] bg-white">
                <tr>
                  <th className="text-center px-3 py-2 border-b border-gray-200 sticky left-0 bg-white align-middle whitespace-nowrap">Time</th>
                  {DAY_PAIRS.map(([d1, d2]) => (
                    <th key={`${d1}${d2}`} className="text-center py-2 border-b border-gray-200 text-gray-700">
                      {dayPairFullName(d1, d2)}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {TIME_ROWS.map((slot) => (
                  <tr key={slot}>
                    <th className="text-center px-3 py-2 whitespace-nowrap sticky left-0 bg-white align-middle">{slot}</th>

                    {DAY_PAIRS.map(([d1, d2]) => {
                      const merged = mergePairCells(getSingleCell(data, d1, slot), getSingleCell(data, d2, slot));
                      const bg = colorForCount(merged.count, pairMin, pairMax);
                      const darkText = shouldUseDarkText(bg);
                      const denom = denomIncluded || 0;
                      const title = `${dayPairFullName(d1, d2)} • ${slot} • ${merged.count}/${denom}`;

                      const isHighlighted = highlightSet.has(`${d1}-${d2}-${slot}`);

                      return (
                        <td
                          key={`${d1}${d2}-${slot}`}
                          title={title}
                          className={cls(
                            "text-center align-middle select-none",
                            "cursor-pointer",
                            isHighlighted && "ring-2 ring-red-500 ring-offset-2"
                          )}
                          style={{
                            background: bg,
                            color: darkText ? "#0b3d2e" : "white",
                            fontWeight: 700,
                            borderRadius: 0,
                            padding: "10px 0",
                          }}
                          onClick={() => {
                            // Click-to-set slot in Assign mode for quick drill
                            setMode("slot");
                            setUserTouchedSlot(true);
                            setPairKey(dayPairFullName(d1, d2));
                            setSlotKey(slot);
                          }}
                        >
                          {merged.count}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="mt-2 text-[11px] text-gray-500 text-center">
            Click a slot to open it in <span className="font-medium">Assign a Slot</span> and see ranked candidates.
          </div>
        </div>
      </Card>

      {loading ? <div className="text-sm text-gray-500">Loading…</div> : null}
      {err ? <div className="text-sm text-red-600">{err}</div> : null}
    </div>
  );
}