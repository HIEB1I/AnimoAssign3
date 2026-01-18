// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_LoadRisk.tsx
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, TrendingUp, AlertTriangle, Users, BarChart, CheckCircle } from "lucide-react"; 
import { fetchPTRisk } from "../../../api";

/** ---------------- Types (from OM_pred2) ---------------- */
type PTRow = {
  course_id: string;
  course_code: string;
  demand_sections: number;
  ft_filled_sections: number;
  pt_needed_sections: number;
  risk: string;
  confidence: string; // e.g., "80%"
  ft_assignees?: string[];
};

// Updated Summary Type for Aggregated Metrics
type PTSummary = {
  total_pt_sections: number;
  estimated_pt_hires: number;
  high_risk_course_count: number; 
  medium_risk_course_count: number; 
  avg_confidence_score: number; // (e.g., 85)
};

type PTResponse = {
  department_id: string;
  dept_name: string; // NEW: Human-readable department name
  term_id: string;
  acad_year_start: number | string; // NEW: Academic year start
  end_at: number | string; // NEW: Academic year end
  term_number: number | string; // NEW: Term number
  rows: PTRow[];
  summary: PTSummary; // Using updated type
  generated_at: string;
  params: any;
};

/** ---------------- Tiny util ---------------- */
const cls = (...s: Array<string | false | undefined>) => s.filter(Boolean).join(" ");

function badgeClasses(kind: "risk" | "confidence", value?: string) {
  const v = (value || "").toLowerCase();
  if (kind === "risk") {
    if (v.includes("high")) return "bg-rose-100 text-rose-800 border border-rose-200";
    if (v.includes("medium")) return "bg-amber-100 text-amber-800 border border-amber-200";
    if (v.includes("low")) return "bg-emerald-100 text-emerald-800 border border-emerald-200";
    return "bg-gray-100 text-gray-700 border border-gray-200";
  }
  // confidence - now handles numerical confidence score (e.g. "80")
  const n = parseInt(v.replace('%', ''), 10);
  if (!isNaN(n)) {
    if (n >= 80) return "bg-emerald-100 text-emerald-800 border border-emerald-200";
    if (n >= 50) return "bg-amber-100 text-amber-800 border border-amber-200";
    return "bg-gray-100 text-gray-700 border border-gray-200";
  }
  return "bg-gray-100 text-gray-700 border border-gray-200";
}

// --- NEW Component: Summary Card ---
interface SummaryCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  color: string;
  iconBgColor: string; // New prop for icon background contrast
}

const SummaryCard = ({ title, value, icon, color, iconBgColor }: SummaryCardProps) => (
  <div className={`p-6 rounded-xl border-t-4 shadow-md ${color} border-t-2`}>
    <div className="flex items-start justify-between">
      <div>
        <p className="text-sm font-medium text-gray-700">{title}</p>
        <p className="mt-1 text-3xl font-bold text-gray-900 tabular-nums">{value}</p>
      </div>
      <div className={`p-3 rounded-full ${iconBgColor} text-white shadow-inner`}>
        {icon}
      </div>
    </div>
  </div>
);

// --- NEW Component: Risk Distribution Visual (Placeholder) ---
const RiskDistributionVisual = ({ data }: { data: PTResponse }) => {
  const riskCounts = data.rows.reduce((acc, row) => {
    acc[row.risk] = (acc[row.risk] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const high = riskCounts["High"] || 0;
  const medium = riskCounts["Medium"] || 0;
  const low = riskCounts["Low"] || 0;
  const total = high + medium + low;

  const getPercentage = (count: number) => (total > 0 ? ((count / total) * 100).toFixed(0) : 0);

  const distribution = [
    { label: 'High Risk', count: high, color: 'bg-rose-500', percentage: getPercentage(high) },
    { label: 'Medium Risk', count: medium, color: 'bg-amber-500', percentage: getPercentage(medium) },
    { label: 'Low Risk', count: low, color: 'bg-emerald-500', percentage: getPercentage(low) },
  ];

  return (
    <div className="p-6">
      <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
        <BarChart className="h-5 w-5 text-gray-600" />
        Course Risk Distribution ({total} Total Courses)
      </h3>
      <div className="flex flex-col gap-3">
        {distribution.map((item) => (
          <div key={item.label}>
            <div className="flex justify-between text-sm font-medium text-gray-700 mb-1">
              <span>{item.label} ({item.count})</span>
              <span>{item.percentage}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2.5">
              <div
                className={`h-2.5 rounded-full ${item.color}`}
                style={{ width: `${item.percentage}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};


/** ---------------- Page ---------------- */
export default function OM_RP_LoadRisk() {
  // knobs (ported from OM_pred2)
  const [departmentId, setDepartmentId] = useState("DEPT0001");
  const [overload, setOverload] = useState(0);
  const [histK, setHistK] = useState(3);
  const [onlyWithPrefs] = useState(false);
  const [allowFallback] = useState(false); 

  // data state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PTResponse | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetchPTRisk({
        department_id: departmentId,
        overload_allowance_units: overload,
        history_terms_for_experience: histK,
        include_only_with_preferences: onlyWithPrefs,
        allow_fallback_without_sections: allowFallback,
      });
      setData(resp);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // auto-load on mount
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New Memoized Value for Sorted Rows and Totals
  const { sortedRows, totals, lowRiskCount } = useMemo(() => {
    if (!data) return { sortedRows: [], totals: { demand: 0, ft: 0, pt: 0 }, lowRiskCount: 0 };
    
    const demand = data.rows.reduce((a, r) => a + r.demand_sections, 0);
    const ft = data.rows.reduce((a, r) => a + r.ft_filled_sections, 0);
    const pt = data.rows.reduce((a, r) => a + r.pt_needed_sections, 0);
    
    const allCourses = data.rows.length;
    const lowRiskCount = allCourses - (data.summary.high_risk_course_count || 0) - (data.summary.medium_risk_course_count || 0);

    // Risk sorting logic: High (1) > Medium (2) > Low (3)
    const riskOrder = { 'High': 1, 'Medium': 2, 'Low': 3 };
    const sortedRows = [...data.rows].sort((a, b) => {
        const orderA = riskOrder[a.risk as keyof typeof riskOrder] || 4;
        const orderB = riskOrder[b.risk as keyof typeof riskOrder] || 4;
        return orderA - orderB;
    });

    return { sortedRows, totals: { demand, ft, pt }, lowRiskCount };
  }, [data]);

  const displayTerm = data ? `AY ${data.acad_year_start} - ${data.end_at} | Term ${data.term_number}` : 'N/A';
  const displayDept = data?.dept_name || data?.department_id || 'N/A';

  return (
    <div className="w-full max-w-[1400px] mx-auto px-8 py-8">
      {/* Header and subtitle retained (DO NOT MODIFY) */}
      <h1 className="text-2xl font-bold mb-2">Faculty Load Risk Forecast</h1>
      <p className="text-sm text-gray-600 mb-6">
        Predictive analytics dashboard for staffing needs and departmental load stability.
      </p>

      {/* -- Main content (in OM_RP aesthetic) -- */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        {/* Top Bar: Back + Filters (aligned & evenly spaced) */}
        <div className="p-4 border-b border-gray-200">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Link
                to="/om/home/reports-analytics"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 active:bg-gray-100"
                aria-label="Back"
                title="Back"
              >
                <ChevronLeft className="h-4 w-4" />
                <span>Back</span>
              </Link>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 items-end">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Department</label>
                <input
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                  placeholder="DEPT0001"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 mb-1">Overload allowance (units)</label>
                <select
                  value={overload}
                  onChange={(e) => setOverload(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm shadow-sm bg-white focus:ring-2 focus:ring-emerald-500/30"
                >
                  <option value={0}>0</option>
                  <option value={3}>3</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-600 mb-1">History window (terms)</label>
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={histK}
                  onChange={(e) => setHistK(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2 text-sm shadow-sm focus:ring-2 focus:ring-emerald-500/30"
                />
              </div>

              <div className="flex gap-2 sm:justify-end">
                <button
                  disabled={loading}
                  onClick={load}
                  className={cls(
                    "w-full sm:w-auto rounded-lg border px-4 py-2 text-sm font-semibold",
                    loading
                      ? "cursor-default border-emerald-200 bg-emerald-200 text-emerald-900"
                      : "cursor-pointer border-emerald-500 bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
                  )}
                >
                  {loading ? "Loading…" : "Run"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Status / error rows */}
        {error && (
          <div className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>
        )}
        {loading && <div className="px-4 py-4 text-sm text-gray-500">Loading…</div>}

        {/* --- Primary Dashboard Content --- */}
        {data && !loading && (
          <div className="p-4 space-y-6">
            <div className="flex flex-wrap gap-4 items-center text-sm">
                <div>
                  <span className="text-gray-600">Forecast Term:</span>{" "}
                  <span className="font-semibold text-gray-900">{displayTerm}</span>
                </div>
                <div>
                  <span className="text-gray-600">Department:</span>{" "}
                  <span className="font-semibold text-gray-900">{displayDept}</span>
                </div>
                <div className="ml-auto">
                  <span className="text-gray-600">Generated:</span>{" "}
                  <span className="font-semibold text-gray-900">
                    {new Date(data.generated_at).toLocaleString()}
                  </span>
                </div>
            </div>

            {/* Prominent Summary Cards - Pastel Colors */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              <SummaryCard
                title="Total PT Sections Needed"
                value={data.summary.total_pt_sections}
                icon={<BarChart className="h-6 w-6" />}
                color="bg-indigo-50 border-indigo-400"
                iconBgColor="bg-indigo-500/80"
              />
              <SummaryCard
                title="Estimated PT Hires"
                value={data.summary.estimated_pt_hires}
                icon={<Users className="h-6 w-6" />}
                color="bg-cyan-50 border-cyan-400"
                iconBgColor="bg-cyan-500/80"
              />
              <SummaryCard
                title="High Risk Courses"
                value={data.summary.high_risk_course_count}
                icon={<TrendingUp className="h-6 w-6" />}
                color="bg-rose-50 border-rose-400"
                iconBgColor="bg-rose-500/80"
              />
              <SummaryCard
                title="Medium Risk Courses"
                value={data.summary.medium_risk_course_count}
                icon={<AlertTriangle className="h-6 w-6" />}
                color="bg-amber-50 border-amber-400"
                iconBgColor="bg-amber-500/80"
              />
              <SummaryCard
                title="Low Risk Courses"
                value={lowRiskCount}
                icon={<CheckCircle className="h-6 w-6" />}
                color="bg-emerald-50 border-emerald-400"
                iconBgColor="bg-emerald-500/80"
              />
            </div>

            {/* Risk Distribution Visual & Confidence Score */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 rounded-xl border border-gray-200 bg-white shadow-sm">
                    <RiskDistributionVisual data={data} />
                </div>
                <div className="lg:col-span-1 p-6 rounded-xl border border-gray-200 bg-white shadow-sm flex flex-col justify-center items-center">
                    <div className="text-center">
                        <p className="text-sm font-medium text-gray-600 mb-2">Model Average Confidence</p>
                        <span className={cls(
                            "inline-block text-5xl font-extrabold tabular-nums",
                            data.summary.avg_confidence_score >= 80 ? "text-emerald-600" :
                            data.summary.avg_confidence_score >= 50 ? "text-amber-600" : "text-gray-600"
                        )}>
                            {data.summary.avg_confidence_score}%
                        </span>
                        <p className="text-xs text-gray-500 mt-2">
                          This score helps gauge the reliability of the forecast for this run.
                        </p>
                    </div>
                </div>
            </div>

            {/* Raw Data Table (Secondary Section) */}
            <h2 className="text-xl font-bold text-gray-800 pt-4 border-t border-gray-200">
                Detailed Course-by-Course Analysis (Sorted by Risk)
            </h2>
            <div className="overflow-x-auto rounded-xl border border-gray-200">
                <table className="min-w-full table-fixed text-sm border-collapse">
                  <colgroup>
                    <col style={{ width: "22%" }} />
                    <col style={{ width: "14%" }} />
                    <col style={{ width: "14%" }} />
                    <col style={{ width: "28%" }} />
                    <col style={{ width: "10%" }} />
                    <col style={{ width: "6%" }} />
                    <col style={{ width: "6%" }} />
                  </colgroup>

                  <thead className="bg-gray-50 text-gray-700 text-xs uppercase tracking-wide sticky top-0 z-[1]">
                    <tr>
                      {[
                        "Course",
                        "Demand (sections)",
                        "FT Filled (sections)",
                        "FT Assignees",
                        "PT Needed",
                        "Risk",
                        "Confidence Level",
                      ].map((h) => (
                        <th key={h} className="px-4 py-2.5 text-center font-semibold whitespace-nowrap border-b">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>

                  <tbody>
                    {sortedRows.map((r, i) => ( // Use sortedRows here
                      <tr
                        key={r.course_id}
                        className={cls(
                          i % 2 === 0 ? "bg-white" : "bg-gray-50",
                          "text-gray-800 hover:bg-gray-100 transition"
                        )}
                      >
                        <td className="px-4 py-2.5 text-left font-medium text-gray-900">{r.course_code}</td>
                        <td className="px-4 py-2.5 text-center tabular-nums">{r.demand_sections}</td>
                        <td className="px-4 py-2.5 text-center tabular-nums">{r.ft_filled_sections}</td>
                        <td className="px-4 py-2.5">
                          {r.ft_assignees && r.ft_assignees.length ? (
                            <div className="flex flex-wrap gap-1 justify-center">
                              {r.ft_assignees.map((n, idx) => (
                                <span
                                  key={idx}
                                  className="inline-flex items-center rounded-full border border-gray-200 px-2.5 py-0.5 text-xs bg-white text-gray-700"
                                  title={n}
                                >
                                  {n}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <div className="text-center text-gray-500">—</div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-center font-semibold tabular-nums">
                          {r.pt_needed_sections}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cls("px-2 py-0.5 rounded-full text-xs inline-block text-center", badgeClasses("risk", r.risk))}>
                            {r.risk || "—"}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cls("px-2 py-0.5 rounded-full text-xs inline-block text-center", badgeClasses("confidence", r.confidence))}>
                            {r.confidence || "—"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>

                  <tfoot>
                    <tr>
                      <td className="px-4 py-2.5 border-t-2 border-gray-300 font-bold text-left">TOTAL</td>
                      <td className="px-4 py-2.5 border-t-2 border-gray-300 font-bold text-center tabular-nums">
                        {totals.demand}
                      </td>
                      <td className="px-4 py-2.5 border-t-2 border-gray-300 font-bold text-center tabular-nums">
                        {totals.ft}
                      </td>
                      <td className="px-4 py-2.5 border-t-2 border-gray-300" />
                      <td className="px-4 py-2.5 border-t-2 border-gray-300 font-bold text-center tabular-nums">
                        {totals.pt}
                      </td>
                      <td className="px-4 py-2.5 border-t-2 border-gray-300" />
                      <td className="px-4 py-2.5 border-t-2 border-gray-300" />
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="text-xs text-gray-500 mt-3">
                Tip: The table is automatically sorted by **Risk (High to Low)** to prioritize critical staffing needs.
              </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && (!data || data.rows.length === 0) && (
          <div className="px-4 py-6 text-center text-sm text-gray-500">No results.</div>
        )}
      </div>
    </div>
  );
}