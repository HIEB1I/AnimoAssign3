// frontend/src/pages/OM/OM_REPORTS_ANALYTICS/OM-RP_LoadRisk.tsx
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, TrendingUp, AlertTriangle, Users, BarChart, CheckCircle } from "lucide-react"; 
import { fetchPTRisk } from "../../../api";
import SelectBox from "../../../component/SelectBox";

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

type DepartmentItem = {
  department_id: string;
  department_name: string;
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
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [overload, setOverload] = useState(0);
  const [histK, setHistK] = useState(3);
  const [onlyWithPrefs] = useState(false);
  const [allowFallback] = useState(false); 

  type RiskFilter = "HIGH_ONLY" | "HIGH_MED" | "ALL";
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("HIGH_MED");
  const [showLowRisk, setShowLowRisk] = useState(false);

  type RiskTableSortKey = "course" | "demand" | "pt_needed" | "risk";
  const [riskSortKey, setRiskSortKey] = useState<RiskTableSortKey>("risk");
  const [riskSortDir, setRiskSortDir] = useState<"asc" | "desc">("desc");

  const toggleRiskSort = (key: RiskTableSortKey) => {
    if (riskSortKey === key) {
      setRiskSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setRiskSortKey(key);
      setRiskSortDir("asc");
    }
  };

  const sortArrow = (key: RiskTableSortKey) =>
    riskSortKey === key ? (riskSortDir === "asc" ? "▲" : "▼") : "";


  // defaults (for Reset)
  const DEFAULT_DEPT = "DEPT0001";
  const DEFAULT_OVERLOAD = 0;
  const DEFAULT_HISTK = 3;

  const resetInputs = () => {
    setDepartmentId(DEFAULT_DEPT);
    setOverload(DEFAULT_OVERLOAD);
    setHistK(DEFAULT_HISTK);
    setError(null);
  };

  const canRun = Boolean(departmentId?.trim()) && histK >= 1 && histK <= 6;

  // Dropdown options (match Course Management SelectBox style)
  const deptOptions = useMemo(() => {
    if (!departments || departments.length === 0) return [departmentId];
    // Display department names only (no IDs in the dropdown)
    return departments.map((d) => d.department_name);
  }, [departments, departmentId]);

  const deptValue = useMemo(() => {
    if (!departments || departments.length === 0) return departmentId;
    const match = departments.find((d) => d.department_id === departmentId);
    return match?.department_name || deptOptions[0] || departmentId;
  }, [departments, deptOptions, departmentId]);

  const overloadOptions = useMemo(() => ["0", "3"], []);


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

  const loadDepartments = async () => {
    try {
      const res = await fetch("/analytics/departments");
      if (!res.ok) return;
      const json = await res.json();
      setDepartments(json?.departments || []);
    } catch {
      // fail silently; fallback to manual input still works
    }
  };

  useEffect(() => {
    // auto-load on mount
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    loadDepartments();
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

    const riskRank = (v?: string) => {
      const s = (v || "").toLowerCase();
      if (s.includes("high")) return 3;
      if (s.includes("medium")) return 2;
      if (s.includes("low")) return 1;
      return 0;
    };
    
    const dir = riskSortDir === "asc" ? 1 : -1;
    
    const sortedRows = [...data.rows].sort((a, b) => {
      const aCourse = String(a.course_code ?? "");
      const bCourse = String(b.course_code ?? "");
    
      const aDemand = Number(a.demand_sections ?? 0);
      const bDemand = Number(b.demand_sections ?? 0);
    
      const aPT = Number(a.pt_needed_sections ?? 0);
      const bPT = Number(b.pt_needed_sections ?? 0);
    
      const aRisk = riskRank(a.risk);
      const bRisk = riskRank(b.risk);
    
      if (riskSortKey === "course") return dir * aCourse.localeCompare(bCourse);
      if (riskSortKey === "demand") return dir * (aDemand - bDemand);
      if (riskSortKey === "pt_needed") return dir * (aPT - bPT);
    
      // risk
      if (aRisk !== bRisk) return dir * (aRisk - bRisk);
    
      // tie-breaker
      return aCourse.localeCompare(bCourse);
    });    

    return { sortedRows, totals: { demand, ft, pt }, lowRiskCount };
  }, [data, riskSortKey, riskSortDir]);

  const displayedRows = useMemo(() => {
    const highs = sortedRows.filter((r) => r.risk === "High");
    const meds = sortedRows.filter((r) => r.risk === "Medium");
    const lows = sortedRows.filter((r) => r.risk === "Low");

    if (riskFilter === "HIGH_ONLY") return { main: highs, low: lows };
    if (riskFilter === "HIGH_MED") return { main: [...highs, ...meds], low: lows };
    return { main: sortedRows, low: lows };
  }, [sortedRows, riskFilter]);

  const displayTerm = data ? `AY ${data.acad_year_start} - ${data.end_at} | Term ${data.term_number}` : 'N/A';
  const displayDept = data?.dept_name || data?.department_id || 'N/A';

  return (
    <div className="w-full h-full min-h-0 px-4 sm:px-6 lg:px-8 py-8">
      {/* Header and subtitle retained (DO NOT MODIFY) */}
      <h1 className="text-2xl font-bold mb-2">Course Staffing Risk Indicators</h1>
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
              <SelectBox
                value={deptValue}
                onChange={(v) => {
                  const nextName = (v || "").trim();
                  const next = departments.find((d) => d.department_name === nextName);
                  setDepartmentId(next?.department_id || departmentId);
                }}
                options={deptOptions}
              />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Overload allowance (units)</label>
                <SelectBox
                  value={String(overload)}
                  onChange={(v) => setOverload(Number(v))}
                  options={overloadOptions}
                />
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
                  type="button"
                  disabled={loading}
                  onClick={resetInputs}
                  className={cls(
                    "w-full sm:w-auto rounded-lg border px-4 py-2 text-sm font-semibold",
                    loading
                      ? "cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400"
                      : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                  )}
                  title="Reset inputs"
                >
                  Reset
                </button>

                <button
                  disabled={loading || !canRun}
                  onClick={load}
                  className={cls(
                    "w-full sm:w-auto rounded-lg border px-4 py-2 text-sm font-semibold",
                    loading || !canRun
                      ? "cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400"
                      : "cursor-pointer border-emerald-500 bg-emerald-400 text-emerald-950 hover:bg-emerald-300"
                  )}
                  title={!canRun ? "Select a Department and a valid History window first." : "Run forecast"}
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
                        <p className="text-sm font-medium text-gray-600 mb-2" title="Confidence reflects data completeness and coverage (e.g., preferences/history), not certainty.">Model Average Confidence</p>
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
            
            <p className="text-xs text-gray-500 mb-2">
              Note: Values shown are <span className="font-semibold">model estimates</span> for planning purposes only, not final assignments.
            </p>

            {/* Raw Data Table (Secondary Section) */}
            <h2 className="text-xl font-bold text-gray-800 pt-4 border-t border-gray-200">
                Detailed Course-by-Course Analysis (Sorted by Risk)
            </h2>

            <div className="flex flex-wrap items-center gap-2 mt-3 mb-2">
              <span className="text-xs text-gray-600">Show:</span>

              <button
                type="button"
                disabled={loading}
                className={cls(
                  "text-xs px-3 py-1 rounded-full border",
                  riskFilter === "HIGH_ONLY"
                    ? "bg-rose-50 border-rose-200 text-rose-800"
                    : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
                )}
                onClick={() => setRiskFilter("HIGH_ONLY")}
              >
                High only
              </button>

              <button
                type="button"
                disabled={loading}
                className={cls(
                  "text-xs px-3 py-1 rounded-full border",
                  riskFilter === "HIGH_MED"
                    ? "bg-amber-50 border-amber-200 text-amber-800"
                    : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
                )}
                onClick={() => setRiskFilter("HIGH_MED")}
              >
                High + Medium
              </button>

              <button
                type="button"
                disabled={loading}
                className={cls(
                  "text-xs px-3 py-1 rounded-full border",
                  riskFilter === "ALL"
                    ? "bg-gray-100 border-gray-200 text-gray-800"
                    : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
                )}
                onClick={() => setRiskFilter("ALL")}
              >
                All
              </button>

              {riskFilter !== "ALL" && (
                <button
                  type="button"
                  className={cls(
                    "ml-auto text-xs px-3 py-1 rounded-lg border",
                    showLowRisk
                      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                      : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
                  )}
                  onClick={() => setShowLowRisk((v) => !v)}
                >
                  {showLowRisk ? "Hide" : "Show"} Low Risk ({displayedRows.low.length})
                </button>
              )}
            </div>

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
                      <th className="px-4 py-2.5 text-center font-semibold whitespace-nowrap border-b">
                        <button
                          type="button"
                          onClick={() => toggleRiskSort("course")}
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          Course {sortArrow("course")}
                        </button>
                      </th>

                      <th className="px-4 py-2.5 text-center font-semibold whitespace-nowrap border-b">
                        <button
                          type="button"
                          onClick={() => toggleRiskSort("demand")}
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          Demand (sections) {sortArrow("demand")}
                        </button>
                      </th>

                      <th className="px-4 py-2.5 text-center font-semibold whitespace-nowrap border-b">
                        FT Capacity Used (estimated)
                      </th>

                      <th className="px-4 py-2.5 text-center font-semibold whitespace-nowrap border-b">
                        Suggested FT Candidates (model)
                      </th>

                      <th className="px-4 py-2.5 text-center font-semibold whitespace-nowrap border-b">
                        <button
                          type="button"
                          onClick={() => toggleRiskSort("pt_needed")}
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          PT Needed {sortArrow("pt_needed")}
                        </button>
                      </th>

                      <th className="px-4 py-2.5 text-center font-semibold whitespace-nowrap border-b">
                        <button
                          type="button"
                          onClick={() => toggleRiskSort("risk")}
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          Risk {sortArrow("risk")}
                        </button>
                      </th>

                      <th className="px-4 py-2.5 text-center font-semibold whitespace-nowrap border-b">
                        Confidence Level
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {displayedRows.main.map((r, i) => ( // filtered rows
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

              {riskFilter !== "ALL" && showLowRisk && displayedRows.low.length > 0 && (
                <div className="mt-5">
                  <h3 className="text-sm font-semibold text-gray-800 mb-2">
                    Low Risk Courses ({displayedRows.low.length})
                  </h3>
                  <div className="overflow-x-auto rounded-xl border border-gray-200">
                    <table className="min-w-full table-fixed text-sm border-collapse">
                      <colgroup>
                        <col style={{ width: "34%" }} />
                        <col style={{ width: "14%" }} />
                        <col style={{ width: "14%" }} />
                        <col style={{ width: "14%" }} />
                        <col style={{ width: "12%" }} />
                        <col style={{ width: "12%" }} />
                      </colgroup>

                      <thead className="bg-gray-50 text-gray-700 text-xs uppercase tracking-wide">
                        <tr>
                          {["Course", "Demand", "FT Cap Used", "PT Needed", "Risk", "Confidence"].map((h) => (
                            <th
                              key={h}
                              className="px-4 py-2.5 text-center font-semibold whitespace-nowrap border-b"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>

                      <tbody>
                        {displayedRows.low.map((r, idx) => (
                          <tr
                            key={r.course_id}
                            className={cls(
                              idx % 2 === 0 ? "bg-white" : "bg-gray-50",
                              "text-gray-800 hover:bg-gray-100 transition"
                            )}
                          >
                            <td className="px-4 py-2.5 text-left font-medium text-gray-900">
                              {r.course_code}
                            </td>
                            <td className="px-4 py-2.5 text-center tabular-nums">{r.demand_sections}</td>
                            <td className="px-4 py-2.5 text-center tabular-nums">{r.ft_filled_sections}</td>
                            <td className="px-4 py-2.5 text-center font-semibold tabular-nums">
                              {r.pt_needed_sections}
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              <span className={cls("px-2 py-0.5 rounded-full text-xs inline-block", badgeClasses("risk", r.risk))}>
                                {r.risk}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              <span className={cls("px-2 py-0.5 rounded-full text-xs inline-block", badgeClasses("confidence", r.confidence))}>
                                {r.confidence}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

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