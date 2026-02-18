// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_DeloadingUtilization.tsx
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  BarChart2,
  AlertTriangle,
  BookOpen,
} from "lucide-react";
// import { fetchDeloadingsByTerm } from "../../../api";
import {
  fetchDeloadingsByTerm,
  fetchDeloadingHistoryAllTerms,
} from "../../../api";

// --- NEW TYPE DEFINITIONS ---
type SummaryMetrics = {
  total_units_deloaded: number;
  total_faculty_deloaded: number;
  average_deloading_per_faculty: number;
  deloading_type_breakdown: { type: string; units: number }[];
};
// --- END NEW TYPE DEFINITIONS ---

type Row = {
  faculty_name?: string;
  deloading_type?: string;
  units_deloaded?: number;
  notes?: string;
  term_id?: string;
  updated_at?: string | Date;
};

type RowWithTerm = Row & {
  term_label: string;
  acad_year_start: number;
  term_number: number;
};

type TermLite = {
  term_id: string;
  acad_year_start: number;
  term_number: number;
  is_current?: boolean;
};

type NextTermAdminWarning = {
  faculty_id?: string;
  faculty_name?: string;
  deloading_type?: string;
  units?: number;
};

type Payload = {
  term: TermLite | null;
  rows: Row[];
  has_prev: boolean;
  has_next: boolean;
  terms?: TermLite[];
  current_index?: number;
  next_term_admin_warnings?: NextTermAdminWarning[];
  summary_metrics?: SummaryMetrics; // ADDED
};

// --- MOCK CHART COMPONENT (for demonstration of visualization) ---
// In a real application, you would integrate a charting library like Recharts or Chart.js here.
const MockBarChart = ({
  data,
  totalUnits,
}: {
  data: { type: string; units: number }[];
  totalUnits: number;
}) => {
  if (!data || data.length === 0) {
    return (
      <div className="text-center text-sm text-gray-500 py-6">
        No deloading types recorded for this term.
      </div>
    );
  }

  const maxUnits = Math.max(...data.map((d) => d.units));

  return (
    <div className="space-y-3">
      {data
        .sort((a, b) => b.units - a.units)
        .map((d) => (
          <div key={d.type} className="flex flex-col">
            <div className="flex justify-between items-center mb-1 text-xs font-medium text-gray-700">
              <span>{d.type}</span>
              <span>
                {d.units} units (
                {totalUnits > 0 ? ((d.units / totalUnits) * 100).toFixed(1) : 0}
                %)
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2.5">
              <div
                className="bg-emerald-600 h-2.5 rounded-full"
                style={{ width: `${(d.units / maxUnits) * 100}%` }}
              ></div>
            </div>
          </div>
        ))}
    </div>
  );
};
// --- END MOCK CHART COMPONENT ---

export default function OM_RP_DeloadingUtilization() {
  const [data, setData] = useState<Payload | null>(null);
  const [terms, setTerms] = useState<TermLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [search, setSearch] = useState("");
  const [historyRows, setHistoryRows] = useState<RowWithTerm[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

  // NEW: State for collapsible table
  const [isTableOpen, setIsTableOpen] = useState(true);
  const [isRiskOpen, setIsRiskOpen] = useState(true);

  function pillLabelOf(t: TermLite) {
    const ayEnd = t.acad_year_start + 1;
    return `AY ${t.acad_year_start}–${ayEnd} • Term ${t.term_number}`;
  }
  function formatFacultyName(name?: string) {
    if (!name) return "";
    const s = String(name).trim().replace(/\s+/g, " ");
    if (!s) return "";

    // If already "Last, First", just normalize spacing around comma.
    if (s.includes(",")) return s.replace(/\s*,\s*/g, ", ").trim();

    const parts = s.split(" ");
    if (parts.length === 1) return parts[0];

    const suffixes = new Set([
      "Jr.",
      "Jr",
      "Sr.",
      "Sr",
      "II",
      "III",
      "IV",
      "V",
    ]);

    let last = parts[parts.length - 1];
    let firstParts = parts.slice(0, -1);

    // Handle suffix: "Juan Dela Cruz Jr." -> "Cruz Jr., Juan Dela"
    if (suffixes.has(last) && parts.length >= 2) {
      last = parts[parts.length - 2] + " " + parts[parts.length - 1];
      firstParts = parts.slice(0, -2);
    }

    const first = firstParts.join(" ").trim();
    return first ? `${last}, ${first}` : last;
  }

  async function load(
    direction: "current" | "next" | "prev" = "current",
    anchor?: string
  ) {
    // Some terms can exist in the DB but have no deloadings (or no displayable rows)
    // which should not be shown to users. We defensively auto-skip a few empties
    // to keep navigation smooth even if the backend sends an empty term.
    const MAX_SKIPS = 10;
    let attempts = 0;
    let nextAnchor = anchor ?? data?.term?.term_id;
    let nextDirection: "current" | "next" | "prev" = direction;

    try {
      setLoading(true);
      setError("");

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await fetchDeloadingsByTerm(nextAnchor, nextDirection);

        // Update the terms list as early as possible.
        if (Array.isArray(res.terms)) setTerms(res.terms);

        const hasRows = Array.isArray(res.rows) && res.rows.length > 0;
        if (hasRows || nextDirection === "current" || attempts >= MAX_SKIPS) {
          setData(res);
          break;
        }

        // Continue paging in the same direction from the newly returned term.
        attempts += 1;
        nextAnchor = res?.term?.term_id;
      }
    } catch (err: any) {
      setError(err?.message || "Failed to load.");
    } finally {
      setLoading(false);
    }
  }

  const currentIndex = useMemo(() => {
    if (typeof data?.current_index === "number") return data.current_index;
    const tid = data?.term?.term_id;
    if (!tid) return 0;
    const idx = terms.findIndex((t) => t.term_id === tid);
    return idx >= 0 ? idx : 0;
  }, [data?.current_index, data?.term?.term_id, terms]);

  const currentPillLabel = useMemo(
    () => (data?.term ? pillLabelOf(data.term) : "—"),
    [data?.term]
  );

  const planningTermId = useMemo(() => {
    // Planning term = next term after the DB's is_current anchor.
    // Fallbacks are conservative so the UI still behaves even if the
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
    const viewed = (data?.term?.term_id || "").trim();
    if (!viewed) return false;
    if (!planningTermId) return false;
    return viewed === planningTermId;
  }, [data?.term?.term_id, planningTermId]);

  const filteredHistoryRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];

    const tokens = q
      .replace(",", " ")
      .split(/\s+/g)
      .map((t) => t.trim())
      .filter(Boolean);

    if (tokens.length === 0) return [];

    return historyRows.filter((r) => {
      const name = String(r.faculty_name || "").toLowerCase();
      return tokens.every((tok) => name.includes(tok));
    });
  }, [search, historyRows]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const q = search.trim();
      if (!q) {
        setHistoryRows([]);
        setHistoryError("");
        return;
      }

      try {
        setHistoryLoading(true);
        setHistoryError("");

        const res = await fetchDeloadingHistoryAllTerms(q);

        if (!cancelled) {
          setHistoryRows(Array.isArray(res?.rows) ? res.rows : []);
        }
      } catch (e: any) {
        if (!cancelled)
          setHistoryError(e?.message || "Failed to search deloading history.");
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    }

    const t = setTimeout(run, 250); 
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search]);

  useEffect(() => {
    // Default view should be the *planning* term (next after current).
    // The backend paging logic supports direction="next" without an anchor,
    // which advances from the is_current anchor.
    load("next");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prepare data for summary/visualization
  const summary = data?.summary_metrics;
  const adminWarnings = data?.next_term_admin_warnings;

  return (
    <div className="w-full px-8 py-8">
      {/* Header */}
      <h1 className="text-2xl font-bold mb-2">Deloading Utilization</h1>
      <p className="text-sm text-gray-600 mb-6">
      Shows which faculty have deloading, how many units it removes, and how it affects assignable capacity.
      </p>

      {/* Card wrapper */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {/* Top bar: Back + pager/selector */}
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

          {/* Term navigation */}
          <div className="flex flex-1 items-center justify-between">
            <button
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
              disabled={!data?.has_prev || loading}
              onClick={() => load("prev")}
              title="Previous term"
            >
              <ChevronLeft className="h-4 w-4" />
              <span>Previous Term</span>
            </button>

            <button
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white"
              disabled={!data?.has_next || loading}
              onClick={() => load("next")}
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
            {terms.length > 0 && (
              <div className="text-xs text-gray-500">
                {currentIndex + 1} of {terms.length}
              </div>
            )}
          </div>
        </div>

        {/* ✅ Search faculty deloading history across ALL terms */}
        <div className="p-4 border-b border-gray-200 bg-white">
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-gray-600">
              Search faculty deloading history (across all terms)
            </label>

            <div className="flex items-center gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder='Type a name (e.g., "Cruz" or "Cruz, Juan")'
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-200"
              />
              {search.trim() && (
                <button
                  type="button"
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50"
                  onClick={() => setSearch("")}
                >
                  Clear
                </button>
              )}
            </div>

            {historyLoading && (
              <div className="text-xs text-gray-500">
                Searching all-term history…
              </div>
            )}
            {historyError && (
              <div className="text-xs text-red-700">{historyError}</div>
            )}

            {!!search.trim() && (
              <div className="text-xs text-gray-500">
                Showing {filteredHistoryRows.length} matching record(s)
              </div>
            )}
          </div>

          {!!search.trim() && (
            <div className="mt-3 overflow-x-auto rounded-xl border border-gray-200 bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200 text-gray-700">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">
                      Term
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">
                      Faculty
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">
                      Deloading Type
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700">
                      Units
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">
                      Notes
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700">
                      Last Updated
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-gray-200 bg-white">
                  {filteredHistoryRows.map((r, i) => (
                    <tr
                      key={`${r.term_id}-${r.faculty_name}-${r.deloading_type}-${i}`}
                      className="hover:bg-gray-50"
                    >
                      <td className="px-4 py-3 text-left">
                        {(r as any).term_label || "—"}
                      </td>
                      <td className="px-4 py-3 text-left">
                        {formatFacultyName(r.faculty_name) || "—"}
                      </td>
                      <td className="px-4 py-3 text-left">
                        {r.deloading_type || "—"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {r.units_deloaded ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-left">{r.notes || "—"}</td>
                      <td className="px-4 py-3 text-center">
                        {r.updated_at
                          ? new Date(r.updated_at).toLocaleString()
                          : "—"}
                      </td>
                    </tr>
                  ))}

                  {filteredHistoryRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-6 text-center text-sm text-gray-500"
                      >
                        No matches for "{search.trim()}".
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Status / error rows */}
        {error && (
          <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">
            {error}
          </div>
        )}
        {loading && (
          <div className="px-4 py-4 text-sm text-gray-500">
            <BarChart2 className="inline h-4 w-4 mr-2 animate-pulse" />
            Loading Deloading Analytics…
          </div>
        )}

        {/* Empty state */}
        {!loading && (!data || data.rows.length === 0) && !error && (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            No deloadings recorded for this term.
          </div>
        )}

        {/* Dashboard Content (visible when data is loaded) */}
        {!loading && !!data?.rows?.length && summary && (
          <div className="p-4 space-y-8">
            {/* --- 2. ADMINISTRATIVE RISK ALERT (Moved to top) --- */}
            {adminWarnings && adminWarnings.length > 0 && (
              <div className="p-4 bg-red-100 border border-red-400 rounded-lg shadow-sm">
                <button
                  type="button"
                  className="w-full flex items-center justify-between mb-3 text-left"
                  onClick={() => setIsRiskOpen(!isRiskOpen)}
                  aria-expanded={isRiskOpen}
                  aria-controls="admin-risk-warning-body"
                >
                  <div className="flex items-center">
                    <AlertTriangle className="h-5 w-5 text-red-700 mr-2 flex-shrink-0" />
                    <h2 className="text-lg font-semibold text-red-800">
                      Administrative Continuity Risk Warning
                    </h2>
                  </div>

                  <ChevronLeft
                    className={`h-5 w-5 text-red-700 transition-transform ${
                      isRiskOpen ? "-rotate-90" : "rotate-0"
                    }`}
                  />
                </button>

                <div
                  id="admin-risk-warning-body"
                  className={`transition-all duration-300 ease-in-out overflow-hidden ${
                    isRiskOpen
                      ? "max-h-[1000px] opacity-100"
                      : "max-h-0 opacity-0"
                  }`}
                >
                  <p className="text-sm text-red-700 mb-3">
                    The following faculty received 'Admin'-related deloading in
                    the{" "}
                    <span className="font-semibold text-red-800">previous</span>{" "}
                    term. Review their load for the current/next term to ensure
                    administrative continuity and resource allocation.
                  </p>

                  <div className="border border-red-200 bg-red-50/70 shadow-sm overflow-hidden rounded-xl">
                    <div className="overflow-x-auto rounded-xl">
                      <table className="min-w-full text-sm">
                        <thead className="bg-red-100 border-b border-red-200 text-red-900">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-semibold text-red-900">
                              Faculty
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-semibold text-red-900">
                              Deloading Type
                            </th>
                            <th className="px-4 py-3 text-center text-xs font-semibold text-red-900">
                              Units
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-red-200 bg-transparent">
                          {adminWarnings.map((r, i) => (
                            <tr
                              key={`${r.faculty_id}-${i}`}
                              className="hover:bg-red-50"
                            >
                              <td className="px-4 py-3 text-left">
                                {formatFacultyName(r.faculty_name) || "—"}
                              </td>
                              <td className="px-4 py-3 text-left">
                                {r.deloading_type || "—"}
                              </td>
                              <td className="px-4 py-3 text-center">
                                {r.units ?? "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* --- 4. RAW DATA TABLE (Collapsible) --- */}
            <div className="border border-gray-200 bg-white shadow-sm overflow-hidden rounded-xl">
              <button
                className="w-full flex justify-between items-center px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left rounded-t-xl"
                onClick={() => setIsTableOpen(!isTableOpen)}
                aria-expanded={isTableOpen}
                aria-controls="deloading-records-table"
              >
                <div className="flex items-center">
                  <BookOpen className="h-5 w-5 text-gray-600 mr-2" />
                  <h2 className="text-lg font-semibold text-gray-800">
                    Deloading Records ({data.rows.length})
                  </h2>
                </div>
                <ChevronLeft
                  className={`h-5 w-5 text-gray-600 transition-transform ${
                    isTableOpen ? "-rotate-90" : "rotate-0"
                  }`}
                />
              </button>

              <div
                id="deloading-records-table"
                className={`transition-all duration-300 ease-in-out overflow-hidden ${
                  isTableOpen
                    ? "max-h-[1000px] opacity-100"
                    : "max-h-0 opacity-0"
                }`}
              >
                <div className="p-4">
                  <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-50 border-b border-gray-200 text-gray-700">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">
                            Faculty
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">
                            Deloading Type
                          </th>
                          <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700">
                            Units
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">
                            Notes
                          </th>
                          <th className="px-4 py-3 text-center text-xs font-semibold text-gray-700">
                            Last Updated
                          </th>
                        </tr>
                      </thead>

                      <tbody className="divide-y divide-gray-200 bg-white">
                        {data.rows.map((r, i) => (
                          <tr
                            key={`${r.faculty_name}-${r.deloading_type}-${i}`}
                            className="hover:bg-gray-50"
                          >
                            <td className="px-4 py-3 text-left">
                              {formatFacultyName(r.faculty_name) || "—"}
                            </td>
                            <td className="px-4 py-3 text-left">
                              {r.deloading_type || "—"}
                            </td>
                            <td className="px-4 py-3 text-center">
                              {r.units_deloaded ?? "—"}
                            </td>
                            <td className="px-4 py-3 text-left">
                              {r.notes || "—"}
                            </td>
                            <td className="px-4 py-3 text-center">
                              {r.updated_at
                                ? new Date(r.updated_at).toLocaleString()
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>

            {/* --- 3. UTILIZATION BREAKDOWN VISUAL ---
            <div className="p-6 border border-gray-200 rounded-lg shadow-sm">
              <div className="flex items-center mb-4">
                <BarChart2 className="h-5 w-5 text-emerald-700 mr-2" />
                <h2 className="text-lg font-semibold text-gray-800">
                  Utilization Breakdown by Deloading Type
                </h2>
              </div>
              <p className="text-sm text-gray-600 mb-4">
                Units allocated by deloading type, showing where institutional
                resources are primarily used.
              </p>
              <MockBarChart
                data={summary.deloading_type_breakdown}
                totalUnits={summary.total_units_deloaded}
              />
            </div> */}
          </div>
        )}
      </div>
    </div>
  );
}
