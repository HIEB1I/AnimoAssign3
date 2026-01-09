// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_DeloadingUtilization.tsx
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, BarChart2, AlertTriangle, BookOpen } from "lucide-react"; // Added icons
import SelectBox from "../../../component/SelectBox";
import { fetchDeloadingsByTerm } from "../../../api";

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
                {totalUnits > 0
                  ? ((d.units / totalUnits) * 100).toFixed(1)
                  : 0}
                %)
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2.5">
              <div
                className="bg-sky-500 h-2.5 rounded-full"
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
  // NEW: State for collapsible table
  const [isTableOpen, setIsTableOpen] = useState(true);

  function labelOf(t: TermLite) {
    const ayEnd = t.acad_year_start + 1;
    return `AY ${t.acad_year_start}–${ayEnd} • Term ${t.term_number}${
      t.is_current ? " (Current)" : ""
    }`;
  }

  const currentLabel = useMemo(
    () => (data?.term ? labelOf(data.term) : ""),
    [data?.term]
  );

  const termLabels = useMemo(() => terms.map(labelOf), [terms]);

  async function load(
    direction: "current" | "next" | "prev" = "current",
    anchor?: string
  ) {
    try {
      setLoading(true);
      setError("");
      const res = await fetchDeloadingsByTerm(
        anchor ?? data?.term?.term_id,
        direction
      );
      setData(res);
      if (Array.isArray(res.terms)) setTerms(res.terms);
    } catch (err: any) {
      setError(err?.message || "Failed to load.");
    } finally {
      setLoading(false);
    }
  }

  // Handle SelectBox change by mapping label -> term_id
  const onSelectTerm = (label: string) => {
    const idx = termLabels.indexOf(label);
    if (idx >= 0 && terms[idx]) {
      load("current", terms[idx].term_id);
    }
  };

  useEffect(() => {
    load("current");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prepare data for summary/visualization
  const summary = data?.summary_metrics;
  const adminWarnings = data?.next_term_admin_warnings;

  return (
    <div className="w-full px-8 py-8">
      {/* Header */}
      <h1 className="text-2xl font-bold mb-2">Deloading Utilization Dashboard</h1>
      <p className="text-sm text-gray-600 mb-6">
        Aggregate resource allocation and administrative risk assessment.
      </p>

      {/* Card wrapper */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {/* Top bar: Back + pager/selector */}
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-gray-200">
          <Link
            to="/om/home/reports-analytics"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 active:bg-gray-100"
            aria-label="Back"
            title="Back"
          >
            <ChevronLeft className="h-4 w-4" />
            <span>Back</span>
          </Link>

          {/* Pager / Term selector cluster */}
          <div className="flex items-center gap-2 flex-1 min-w-[320px] justify-end">
            <button
              onClick={() => load("prev")}
              disabled={!data?.has_prev || loading}
              className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                !data?.has_prev || loading
                  ? "cursor-default border-gray-200 bg-gray-100 text-gray-500"
                  : "cursor-pointer border-emerald-500 bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
              }`}
              title="Previous term"
            >
              ← Prev
            </button>

            <div className="min-w-[260px]">
              <SelectBox
                value={currentLabel}
                onChange={onSelectTerm}
                options={termLabels}
              />
            </div>

            <button
              onClick={() => load("next")}
              disabled={!data?.has_next || loading}
              className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                !data?.has_next || loading
                  ? "cursor-default border-gray-200 bg-gray-100 text-gray-500"
                  : "cursor-pointer border-emerald-500 bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
              }`}
              title="Next term"
            >
              Next →
            </button>
          </div>
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
            {/* Context Header */}
            <div className="text-md text-gray-700">
              Analysis for{" "}
              <span className="font-semibold text-gray-900">
                {data?.term
                  ? `AY ${data.term.acad_year_start}–${
                      data.term.acad_year_start + 1
                    } • Term ${data.term.term_number}`
                  : "—"}
              </span>
            </div>

            {/* --- 1. GLOBAL SUMMARY CARDS --- */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Total Units Deloaded */}
              <div className="flex flex-col items-center justify-center p-6 bg-red-50 border border-red-300 rounded-lg shadow-md">
                <p className="text-sm font-medium text-red-600 uppercase">
                  Total Units Deloaded
                </p>
                <p className="text-4xl font-extrabold text-red-800 mt-1">
                  {summary.total_units_deloaded}
                </p>
              </div>

              {/* Total Faculty Deloaded */}
              <div className="flex flex-col items-center justify-center p-6 bg-sky-50 border border-sky-300 rounded-lg shadow-md">
                <p className="text-sm font-medium text-sky-600 uppercase">
                  Total Faculty Deloaded
                </p>
                <p className="text-4xl font-extrabold text-sky-800 mt-1">
                  {summary.total_faculty_deloaded}
                </p>
              </div>

              {/* Average Deloading Per Faculty */}
              <div className="flex flex-col items-center justify-center p-6 bg-emerald-50 border border-emerald-300 rounded-lg shadow-md">
                <p className="text-sm font-medium text-emerald-600 uppercase">
                  Avg. Deloading Per Faculty
                </p>
                <p className="text-4xl font-extrabold text-emerald-800 mt-1">
                  {summary.average_deloading_per_faculty}
                </p>
              </div>
            </div>

            {/* --- 2. ADMINISTRATIVE RISK ALERT (Moved to top) --- */}
            {adminWarnings && adminWarnings.length > 0 && (
              <div className="p-4 bg-orange-100 border border-orange-400 rounded-lg shadow-sm">
                <div className="flex items-center mb-3">
                  <AlertTriangle className="h-5 w-5 text-orange-700 mr-2 flex-shrink-0" />
                  <h2 className="text-lg font-semibold text-orange-800">
                    Administrative Continuity Risk Warning
                  </h2>
                </div>
                <p className="text-sm text-orange-700 mb-3">
                  The following faculty received 'Admin'-related deloading in the
                  **previous** term. Review their load for the current/next term
                  to ensure administrative continuity and resource allocation.
                </p>

                <div className="overflow-x-auto">
                  <table className="min-w-full table-fixed text-sm">
                    <thead className="bg-orange-200 text-orange-900 text-xs uppercase tracking-wide">
                      <tr>
                        {["Faculty Name", "Deloading Type", "Units"].map(
                          (h) => (
                            <th
                              key={h}
                              className="px-3 py-2 text-center font-medium whitespace-nowrap"
                            >
                              {h}
                            </th>
                          )
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {adminWarnings.map((r, i) => (
                        <tr
                          key={`${r.faculty_id}-${i}`}
                          className={
                            i % 2 === 0
                              ? "bg-orange-100"
                              : "bg-orange-50 border-t border-orange-200"
                          }
                        >
                          <td className="px-3 py-2 text-center">
                            {r.faculty_name}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {r.deloading_type}
                          </td>
                          <td className="px-3 py-2 text-center">{r.units}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* --- 3. UTILIZATION BREAKDOWN VISUAL --- */}
            <div className="p-6 border border-gray-200 rounded-lg shadow-sm">
              <div className="flex items-center mb-4">
                <BarChart2 className="h-5 w-5 text-indigo-600 mr-2" />
                <h2 className="text-xl font-semibold text-gray-800">
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
            </div>

            {/* --- 4. RAW DATA TABLE (Collapsible) --- */}
            <div className="border border-gray-200 rounded-lg">
              <button
                className="w-full flex justify-between items-center p-4 bg-gray-50 hover:bg-gray-100 text-left rounded-t-lg"
                onClick={() => setIsTableOpen(!isTableOpen)}
                aria-expanded={isTableOpen}
                aria-controls="deloading-records-table"
              >
                <div className="flex items-center">
                  <BookOpen className="h-5 w-5 text-gray-600 mr-2" />
                  <h2 className="text-lg font-semibold text-gray-800">
                    Detailed Deloading Records ({data.rows.length})
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
                  isTableOpen ? "max-h-[1000px] opacity-100" : "max-h-0 opacity-0"
                }`}
              >
                <div className="p-4">
                  <div className="overflow-x-auto">
                    <table className="min-w-full table-fixed text-sm border-t border-gray-200">
                      <colgroup>
                        <col style={{ width: "20%" }} />
                        <col style={{ width: "20%" }} />
                        <col style={{ width: "12%" }} />
                        <col style={{ width: "28%" }} />
                        <col style={{ width: "20%" }} />
                      </colgroup>
                      <thead className="bg-gray-100 text-gray-600 text-xs uppercase tracking-wide">
                        <tr>
                          {[
                            "Faculty Name",
                            "Deloading Type",
                            "Units",
                            "Notes",
                            "Last Updated",
                          ].map((h) => (
                            <th
                              key={h}
                              className="px-3 py-2 text-center font-medium whitespace-nowrap"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((r, i) => (
                          <tr
                            key={`${r.faculty_name}-${r.deloading_type}-${i}`}
                            className={
                              i % 2 === 0
                                ? "bg-white text-gray-800"
                                : "bg-gray-50 text-gray-800"
                            }
                          >
                            <td className="px-3 py-2 text-center">
                              {r.faculty_name || "—"}
                            </td>
                            <td className="px-3 py-2 text-center">
                              {r.deloading_type || "—"}
                            </td>
                            <td className="px-3 py-2 text-center">
                              {r.units_deloaded ?? "—"}
                            </td>
                            <td className="px-3 py-2 text-center">
                              {r.notes || "—"}
                            </td>
                            <td className="px-3 py-2 text-center">
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
          </div>
        )}
      </div>
    </div>
  );
}