// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM_RP_AvailabilityForecasting.tsx
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Info, Search } from "lucide-react";
import { Link } from "react-router-dom";
import SelectBox from "../../../component/SelectBox";
import { fetchFacultyAvailabilityHeatmap } from "../../../api";

/* ---------------- Small helpers ---------------- */
const cls = (...s: (string | false | undefined)[]) => s.filter(Boolean).join(" ");

function normalizeText(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9\s@._-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildNameVariants(name: string) {
  const base = normalizeText(name);
  const variants = new Set<string>();
  if (base) variants.add(base);

  // Support common display formats like "Last, First Middle".
  if (name && name.includes(",")) {
    const [aRaw, bRaw] = name.split(",", 2);
    const a = normalizeText(aRaw);
    const b = normalizeText(bRaw);
    if (a && b) {
      variants.add(`${a} ${b}`.trim());
      variants.add(`${b} ${a}`.trim());
    }
  }

  return Array.from(variants);
}

function matchesQuery({ name, email, q }: { name: string; email?: string; q: string }) {
  const qq = normalizeText(q);
  if (!qq) return true;

  const tokens = qq.split(" ").filter(Boolean);
  const emailN = normalizeText(email || "");
  const nameVariants = buildNameVariants(name);

  // Match if any variant contains the whole query OR all tokens are present.
  for (const h of nameVariants) {
    if (!h) continue;
    if (h.includes(qq)) return true;
    if (tokens.every((t) => h.includes(t))) return true;
  }

  if (emailN) {
    if (emailN.includes(qq)) return true;
    if (tokens.every((t) => emailN.includes(t))) return true;
  }

  return false;
}

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

  counting_mode?: "top1" | "top4";
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
  M: "Monday",
  T: "Tuesday",
  W: "Wednesday",
  H: "Thursday",
  F: "Friday",
  S: "Saturday",
};

const DAY_ABBR: Record<DayCode, string> = {
  M: "Mon",
  T: "Tue",
  W: "Wed",
  H: "Thu",
  F: "Fri",
  S: "Sat",
};

const DAY_PAIRS_LABELED: { d1: DayCode; d2: DayCode; label: string; title: string }[] = [
  { d1: "M", d2: "H", label: "Mon-Thu", title: "Monday-Thursday" },
  { d1: "T", d2: "F", label: "Tue-Fri", title: "Tuesday-Friday" },
  { d1: "W", d2: "S", label: "Wed-Sat", title: "Wednesday-Saturday" },
];

function dayPairLabel(d1: DayCode, d2: DayCode) {
  return `${DAY_ABBR[d1]}-${DAY_ABBR[d2]}`;
}

function dayPairTitle(d1: DayCode, d2: DayCode) {
  return `${DAY_FULL[d1]}-${DAY_FULL[d2]}`;
}

function parsePairKey(pairKey: string): [DayCode, DayCode] {
  const t = (pairKey || "").trim();

  // Accept code form (M-H)
  if (/^[MTWHFS]-[MTWHFS]$/.test(t)) {
    const parts = t.split("-") as [DayCode, DayCode];
    return [parts[0], parts[1]];
  }

  // Accept short form (Mon-Thu)
  const lower = t.toLowerCase();
  const invShort: Record<string, DayCode> = Object.fromEntries(
    Object.entries(DAY_ABBR).map(([k, v]) => [String(v).toLowerCase(), k as DayCode])
  );
  const invFull: Record<string, DayCode> = Object.fromEntries(
    Object.entries(DAY_FULL).map(([k, v]) => [String(v).toLowerCase(), k as DayCode])
  );

  const parts = lower.split("-");
  if (parts.length === 2) {
    const a = invShort[parts[0]] || invFull[parts[0]];
    const b = invShort[parts[1]] || invFull[parts[1]];
    if (a && b) return [a, b];
  }

  return ["M", "H"];
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

const DEFAULT_COUNTING_MODE: "top1" | "top4" = "top1";

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
    // Red → Yellow → Green (middle must be yellow)
    "#fee2e2",
    "#fecaca",
    "#fca5a5",
    "#f87171",
    "#fef9c3",
    "#fde047",
    "#facc15",
    "#d1fae5",
    "#a7f3d0",
    "#6ee7b7",
    "#34d399",
    "#059669",
  ];
  const idx = Math.min(steps.length - 1, Math.max(0, Math.round(ratio * (steps.length - 1))));
  return steps[idx];
}

// Faculty-mode heatmap colors (selected faculty only)
const FACULTY_SELECTED_BG = "#bbf7d0"; // green-200
const FACULTY_OTHER_BG = "#fecaca"; // red-200

function shouldUseDarkText(hex: string) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140;
}

/* ================= Main component ================= */


export default function OM_RP_AvailabilityForecasting() {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [data, setData] = useState<AvailabilityHeatmap | null>(null);

  const [termId, setTermId] = useState<string | null>(null);
  const [countingMode, setCountingMode] = useState<"top1" | "top4">(DEFAULT_COUNTING_MODE);

  // Users pick a primary workflow so the screen doesn't feel like "two tools".
  const [startMode, setStartMode] = useState<"slot" | "faculty">("slot");

  // Slot-first controls
  const [pairKey, setPairKey] = useState<string>('Mon-Thu');
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

    const prefPct = (sb.pref_boost ?? 0) > 0 ? 100 : 0;
    const historyPct = Math.round(Math.max(0, Math.min(1, sb.history_signal ?? 0)) * 100);

    const items: { k: string; v: number; tip: string; chipCls: string; dotCls: string }[] = [];

    if (prefPct > 0) {
      items.push({
        k: "Preference",
        v: prefPct,
        tip: "Matched this faculty's submitted preference.",
        chipCls: "border-green-200 bg-green-50 text-green-800",
        dotCls: "bg-green-500",
      });
    }

    if (historyPct > 0) {
      items.push({
        k: "History",
        v: historyPct,
        tip: "Strength of teaching pattern from the last 3 terms.",
        chipCls: "border-teal-200 bg-teal-50 text-teal-900",
        dotCls: "bg-teal-600",
      });
    }

    if (!items.length) return null;

    return (
      <div className="mt-1">
        <div className="mt-1 flex flex-wrap gap-1">
          {items.map((it) => (
            <span
              key={it.k}
              title={it.tip}
              className={cls("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", it.chipCls)}
            >
              <span className={cls("inline-block h-1.5 w-1.5 rounded-full", it.dotCls)} />
              {it.k}: {it.v}%
            </span>
          ))}
        </div>
      </div>
    );
  }
  const totalScope = data?.faculty_total_in_scope ?? 0;

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
    const q = facultyQuery.trim();
    if (!q) return facultyDirectory;
    return facultyDirectory.filter((f) => matchesQuery({ name: f.name, email: f.email, q }));
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

  // Heatmap highlight should reflect the current aggregation setting:
  // - top1 => highlight only the single best-fit block
  // - top4 => highlight up to the top 4 best-fit blocks
  const highlightSet = useMemo(() => {
    const set = new Set<string>();
    const limit = countingMode === "top4" ? 4 : 1;
    for (const r of selectedFacultyBestPairs.slice(0, limit)) set.add(`${r.d1}-${r.d2}-${r.slot}`);
    return set;
  }, [selectedFacultyBestPairs, countingMode]);

  const selectedSlotKeyForHeatmap = useMemo(() => {
    const [d1, d2] = parsePairKey(pairKey);
    return `${d1}-${d2}-${slotKey}`;
  }, [pairKey, slotKey]);

  // When a faculty is chosen, switch to the faculty workflow (the user intent is clear).
  useEffect(() => {
    if (selectedFacultyId) setStartMode("faculty");
  }, [selectedFacultyId]);

  const slotCandidates = useMemo(() => {
    if (!data) return [] as HeatPerson[];
    const [d1, d2] = parsePairKey(pairKey);
    const merged = mergePairCells(getSingleCell(data, d1, slotKey), getSingleCell(data, d2, slotKey));
    const q = candidateQuery.trim();
    if (!q) return merged.list;
    return merged.list.filter((p) => matchesQuery({ name: p.name, email: p.email, q }));
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
      setPairKey(dayPairLabel(best.d1, best.d2));
      setSlotKey(best.slot);
    }
  }, [data?.slots, userTouchedSlot]);

  const hasAnyPredictions = useMemo(() => {
    if (!data?.slots) return false;
    return Object.values(data.slots).some((v) => (v?.count ?? 0) > 0);
  }, [data?.slots]);

  /* ================= Render ================= */

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Top bar: Back • Term • Slots per faculty */}

      {/* Title + subtitle */}
      <div className="px-1">
        <h1 className="text-2xl font-bold text-gray-900">Time/Day Slot Availability Indicators</h1>
        <p className="mt-1 text-sm text-gray-600">
          Predicts best-fit teaching blocks using submitted preferences and recent teaching patterns to help assign faculty to time slots faster.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/om/reports-analytics"
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </Link>

        {currentTermLabel ? (
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-1.5 text-sm font-semibold text-emerald-800">
            {currentTermLabel}
            {isActiveTerm ? (
              <span className="rounded-full bg-emerald-200 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                Active
              </span>
            ) : null}
          </div>
        ) : (
          <div />
        )}

        <div />
      </div>
      <WarningPanel warnings={data?.warnings || []} />

      {/* Controls */}
      <Card className="p-3">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[420px_minmax(0,1fr)] lg:items-end">
          <div className="flex items-end gap-2 min-w-0">
            <div className="min-w-[180px]">
              <div className="text-[11px] text-gray-500 mb-1">Mode</div>
              <div className="inline-flex w-full rounded-lg border border-gray-300 bg-white shadow-sm overflow-hidden">
                <button
                  type="button"
                  onClick={() => setStartMode("slot")}
                  className={cls(
                    "flex-1 px-3 py-2 text-sm font-semibold",
                    startMode === "slot" ? "bg-emerald-600 text-white" : "text-gray-700 hover:bg-gray-50"
                  )}
                >
                  Slot
                </button>
                <button
                  type="button"
                  onClick={() => setStartMode("faculty")}
                  className={cls(
                    "flex-1 px-3 py-2 text-sm font-semibold",
                    startMode === "faculty" ? "bg-emerald-600 text-white" : "text-gray-700 hover:bg-gray-50"
                  )}
                >
                  Faculty
                </button>
              </div>
            </div>

            <button
              type="button"
              className="mb-0.5 inline-flex h-[42px] w-[42px] shrink-0 items-center justify-center text-gray-500 hover:text-gray-700"
              title="Predicted support based on submitted preferences and the last 3 terms of teaching patterns."
              aria-label="Forecast info"
            >
              <Info className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 min-w-0">
            <div className="min-w-0">
              <div className="text-[11px] text-gray-500 mb-1">Day</div>
              <SelectBox
                className="min-w-0 w-full"
                value={pairKey}
                options={DAY_PAIRS_LABELED.map((p) => p.label)}
                onChange={(v) => {
                  setUserTouchedSlot(true);
                  setPairKey(v);
                  setStartMode("slot");
                }}
              />
            </div>

            <div className="min-w-0">
              <div className="text-[11px] text-gray-500 mb-1">Period</div>
              <SelectBox
                className="min-w-0 w-full"
                value={slotKey}
                options={[...TIME_ROWS] as unknown as string[]}
                onChange={(v) => {
                  setUserTouchedSlot(true);
                  setSlotKey(v);
                  setStartMode("slot");
                }}
              />
            </div>

            <div className="min-w-0">
              <div className="text-[11px] text-gray-500 mb-1">Schedule</div>
              <SelectBox
                className="min-w-0 w-full"
                value={countingMode === "top1" ? "1" : "4"}
                options={["1", "4"]}
                onChange={(v) => setCountingMode(v === "4" ? "top4" : "top1")}
              />
            </div>
          </div>
        </div>
      </Card>

      {/* Main layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-4">
        <div className="space-y-4">
          {startMode === "slot" ? (
            /* Ranked candidates */
            <Card className="p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-800">Top faculty for {pairKey} {slotKey}</div>
                  {totalScope ? (
                    <div className="mt-1">
                      <Chip>Faculty considered: {denomIncluded}/{totalScope}</Chip>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="mt-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    value={candidateQuery}
                    onChange={(e) => setCandidateQuery(e.target.value)}
                    placeholder="Filter candidates by name…"
                    className="w-full rounded-lg border border-gray-200 bg-white pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-200"
                  />
                </div>

                <div className="mt-3 max-h-[420px] overflow-auto rounded-lg border border-gray-200">
                  {slotCandidates.length ? (
                    <div className="divide-y divide-gray-200">
                      {slotCandidates.map((p, idx) => (
                        <button
                          key={`${p.faculty_id}-${idx}`}
                          type="button"
                          onClick={() => {
                            setSelectedFacultyId(p.faculty_id);
                            setFacultyQuery(p.name);
                          }}
                          className="w-full text-left p-3 hover:bg-gray-50"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium text-gray-900 truncate">{p.name}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                {/* signal chips removed */}
                              </div>
                              <ScoreBreakdownChips person={p} />
                            </div>

                            <div className="text-right shrink-0">
                              <div className="text-lg font-extrabold text-emerald-700">{Math.round(p.confidence_pct || 0)}%</div>
                              <div className="text-[10px] text-gray-500">fit score</div>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="p-3 text-sm text-gray-500">No candidates found for this slot.</div>
                  )}
                </div>
              </div>

              <div className="mt-2 text-[11px] text-red-500">
                This report is predicted support (preferences + last 3 terms patterns), not confirmed availability.
              </div>
            </Card>
          ) : null}

          {startMode === "faculty" ? (
            /* Faculty best-fit slots */
            <Card className="p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-800">Best-fit slots for a faculty</div>
                </div>
              </div>

              <div className="mt-3 space-y-3">
                <div>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                      value={facultyQuery}
                      onChange={(e) => {
                        const v = e.target.value;
                        setFacultyQuery(v);
                        if (!v.trim()) setSelectedFacultyId(null);
                        else if (selectedFacultyId) setSelectedFacultyId(null);
                        setStartMode("faculty");
                      }}
                      placeholder="Search by faculty name…"
                      className="w-full rounded-lg border border-gray-200 bg-white pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-200"
                    />
                  </div>

                  {facultyQuery.trim() && !selectedFacultyId ? (
                    <div className="mt-2 max-h-[180px] overflow-auto rounded-lg border border-gray-200 bg-white">
                      {facultySuggestions.length ? (
                        facultySuggestions.slice(0, 50).map((f) => (
                          <button
                            key={f.faculty_id}
                            type="button"
                            onClick={() => {
                              setSelectedFacultyId(f.faculty_id);
                              setFacultyQuery(f.name);
                              setStartMode("faculty");
                            }}
                            className="w-full px-3 py-2 text-left hover:bg-gray-50"
                          >
                            <div className="text-sm text-gray-900 truncate">{f.name}</div>
                          </button>
                        ))
                      ) : (
                        <div className="px-3 py-2 text-sm text-gray-500">No matches.</div>
                      )}
                    </div>
                  ) : null}
                </div>

                {selectedFaculty ? (
                  <Card className="p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium text-gray-900 min-w-0 truncate">{selectedFaculty.name}</div>
                    </div>

                    <div className="mt-2">
                      <div className="text-xs font-semibold text-gray-700 mb-1">
                        Top {Math.min(selectedFacultyBestPairs.length, countingMode === "top4" ? 4 : 1)} slots
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {(selectedFacultyBestPairs.slice(0, countingMode === "top4" ? 4 : 1)).map((r) => {
                          const label = dayPairLabel(r.d1, r.d2);
                          return (
                            <button
                              key={`${r.d1}-${r.d2}-${r.slot}`}
                              type="button"
                              onClick={() => {
                                setUserTouchedSlot(true);
                                setPairKey(label);
                                setSlotKey(r.slot);
                              }}
                              className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
                              title={`${dayPairTitle(r.d1, r.d2)} • ${r.slot}`}
                            >
                              <span className="font-medium">{label}</span>
                              <span className="text-gray-400">•</span>
                              <span>{r.slot}</span>
                              <span className="text-gray-400">•</span>
                              <span className="font-semibold text-emerald-700">{Math.round(r.confidence)}%</span>
                            </button>
                          );
                        })}
                      </div>

                      <ScoreBreakdownChips person={selectedFaculty} />
                    </div>
                  </Card>
                ) : (
                  <div className="text-sm text-gray-500">
                    Search and select a faculty to view predictions.
                  </div>
                )}
              </div>

              <div className="mt-2 text-[11px] text-red-500">
                Highlights show predicted best-fit slots, not guaranteed free time.
              </div>
            </Card>
          ) : null}
        </div>

        <div>
          <Card className="overflow-x-auto">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-gray-200">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-gray-800">Heatmap: predicted faculty support</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {startMode === "faculty" && selectedFacultyId
                    ? "Green = selected faculty best-fit. Red = other slots."
                    : countingMode === "top1"
                      ? "Counts show how many included faculty have this as their #1 best-fit slot."
                      : "Counts show how many faculty include this slot in their top 4 best-fit slots."}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {startMode === "faculty" && selectedFacultyId ? (
                  <>
                    <span className="text-xs text-gray-500">Other</span>
                    <div className="h-3 w-6 rounded" style={{ background: FACULTY_OTHER_BG }} />
                    <span className="text-xs text-gray-500">Selected</span>
                    <div className="h-3 w-6 rounded" style={{ background: FACULTY_SELECTED_BG }} />
                  </>
                ) : (
                  <>
                    <span className="text-xs text-gray-500">Low ({pairMin})</span>
                    <div className="h-3 w-28 rounded bg-gradient-to-r from-[#f87171] via-[#facc15] to-[#059669]" />
                    <span className="text-xs text-gray-500">Peak ({pairMax})</span>
                  </>
                )}
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
                      <th className="text-center px-3 py-2 border-b border-gray-200 sticky left-0 bg-white align-middle whitespace-nowrap">
                        Time
                      </th>
                      {DAY_PAIRS_LABELED.map((x) => (
                        <th
                          key={`${x.d1}${x.d2}`}
                          className="text-center py-2 border-b border-gray-200 text-gray-700 whitespace-nowrap"
                          title={x.title}
                        >
                          {x.label}
                        </th>
                      ))}
                    </tr>
                  </thead>

                  <tbody>
                    {TIME_ROWS.map((slot) => (
                      <tr key={slot}>
                        <th className="text-center px-3 py-2 whitespace-nowrap sticky left-0 bg-white align-middle">{slot}</th>

                        {DAY_PAIRS_LABELED.map(({ d1, d2, label, title }) => {
                          const merged = mergePairCells(getSingleCell(data, d1, slot), getSingleCell(data, d2, slot));
                          const isFacultyModeColor = startMode === "faculty" && !!selectedFacultyId;
                          const denom = denomIncluded || 0;
                          const cellTitle = `${title} • ${slot} • ${merged.count}/${denom}`;

                          // Only show ONE highlight style depending on the active mode.
                          // - Slot mode: highlight the selected slot (green)
                          // - Faculty mode: highlight the best-fit slots for the selected faculty (red)
                          const isFacultyHighlight = startMode === "faculty" && highlightSet.has(`${d1}-${d2}-${slot}`);
                          const isSelectedSlot = startMode === "slot" && selectedSlotKeyForHeatmap === `${d1}-${d2}-${slot}`;

                          const bg = isFacultyModeColor
                            ? (isFacultyHighlight ? FACULTY_SELECTED_BG : FACULTY_OTHER_BG)
                            : colorForCount(merged.count, pairMin, pairMax);
                          const textColor = shouldUseDarkText(bg) ? "#111827" : "white";

                          return (
                            <td
                              key={`${d1}${d2}-${slot}`}
                              title={cellTitle}
                              className={cls(
                                "text-center align-middle select-none cursor-pointer",
                                isSelectedSlot && "ring-2 ring-emerald-500 ring-offset-2",
                                // In faculty mode, highlight the selected faculty's best-fit blocks.
                                isFacultyHighlight && "ring-2 ring-emerald-700 ring-offset-2"
                              )}
                              style={{
                                background: bg,
                                color: textColor,
                                fontWeight: 700,
                                borderRadius: 0,
                                padding: "10px 0",
                              }}
                              onClick={() => {
                                setUserTouchedSlot(true);
                                setStartMode("slot");
                                setPairKey(label);
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
                {startMode === "slot" ? "Click a slot to update the ranked list on the left." : "Click a slot to select it."}
              </div>
            </div>
          </Card>
        </div>
      </div>


      {loading ? <div className="text-sm text-gray-500">Loading…</div> : null}
      {err ? <div className="text-sm text-red-600">{err}</div> : null}
    </div>
  );
}
